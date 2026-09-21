/**
 * 拖拽共用内核的回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/drag-sort-test.mjs，然后
 *         node plugins/project-group/drag-sort-test.mjs
 *
 * 本插件有四套拖拽（卡片排序 / 跨栏建链 / 页签重排 / 分框重排），
 * 骨架相同、落点语义不同。此前四份各自实现，兜底逻辑改一处漏三处 ——
 * 而兜底恰恰是漏了最难查的（不报错，只是偶尔"点了没反应"）。
 *
 * 这里守几件容易做错的事：
 *   · MIME 必须专用（图省事用 text/plain 会抢输入框的默认行为）
 *   · 载荷必须做结构校验（dataTransfer 里可以是任意文本）
 *   · **索引纠偏**（先移除再插入）—— 用穷举不变量钉住
 *   · 死区：取固定值与邻项 20% 的**较小**值（取大则矮邻框永远换不动）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const D = await loadTs(path.join(HERE, 'utils/dragSort.ts'));
const {
  DRAG_MIME, TAB_DRAG_MIME, BOX_DRAG_MIME, DRAG_THRESHOLD,
  movedEnough, parseDragPayload, parseTabDrag, parseBoxDrag,
  resolveMoveIndex, clampIndex, gapIndexAt, deadZone, swapIndexWithDeadZone,
} = D;

const cardGrid = fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8');
const stack = fs.readFileSync(path.join(HERE, 'components/StackedGroups.tsx'), 'utf8');

console.log('\n=== 1. MIME 必须专用（不能用 text/plain）===');
{
  t('三种 MIME 互不相同', new Set([DRAG_MIME, TAB_DRAG_MIME, BOX_DRAG_MIME]).size === 3);
  /* 用 text/plain 的后果：拖经过 <input> 时浏览器默认行为是插入文本 */
  t('都不是 text/plain',
    ![DRAG_MIME, TAB_DRAG_MIME, BOX_DRAG_MIME].includes('text/plain'));
  t('都带统一前缀',
    [DRAG_MIME, TAB_DRAG_MIME, BOX_DRAG_MIME].every((m) => m.startsWith('application/x-fpx-')));
  t('StackedGroups 不再用 text/plain', !/setData\('text\/plain'/.test(stack));
}

console.log('\n=== 2. 载荷结构校验（来源可以是任意文本）===');
{
  t('合法卡片载荷', JSON.stringify(parseDragPayload('{"kind":"project","path":"/a"}')) === '{"kind":"project","path":"/a"}');
  t('坏 JSON → null（不抛异常）', parseDragPayload('{oops') === null);
  t('空串 → null', parseDragPayload('') === null);
  t('null → null', parseDragPayload(null) === null);
  t('非对象 → null', parseDragPayload('"str"') === null);
  t('kind 非法 → null', parseDragPayload('{"kind":"xyz","path":"/a"}') === null);
  t('path 缺失 → null', parseDragPayload('{"kind":"project"}') === null);
  t('path 空串 → null', parseDragPayload('{"kind":"project","path":""}') === null);

  t('合法页签载荷', parseTabDrag('{"kind":"group","index":2}')?.index === 2);
  t('页签 index 为负 → null', parseTabDrag('{"kind":"group","index":-1}') === null);
  t('页签 index 非整数 → null', parseTabDrag('{"kind":"group","index":1.5}') === null);
  t('页签 index 是字符串 → null', parseTabDrag('{"kind":"group","index":"2"}') === null);

  t('合法分框载荷', parseBoxDrag('{"index":3}')?.index === 3);
  t('分框 index 为负 → null', parseBoxDrag('{"index":-1}') === null);
  t('分框载荷缺 index → null', parseBoxDrag('{}') === null);
}

console.log('\n=== 3. 阈值判定（#107 / #492）===');
{
  t('阈值 = 5', DRAG_THRESHOLD === 5);
  t('没按下点 → 不拦（键盘发起的拖拽交给浏览器）', movedEnough(null, 0, 0) === true);
  t('位移 0 → 判定为点击', movedEnough({ x: 10, y: 10 }, 10, 10) === false);
  t('位移 3（手抖）→ 判定为点击', movedEnough({ x: 10, y: 10 }, 12, 11) === false);
  t('位移 5 → 判定为拖拽', movedEnough({ x: 10, y: 10 }, 15, 10) === true);
  t('斜向按距离算（3,4 → 5）', movedEnough({ x: 0, y: 0 }, 3, 4) === true);
  t('斜向 2,2（约 2.8）→ 点击', movedEnough({ x: 0, y: 0 }, 2, 2) === false);
}

console.log('\n=== 4. 索引纠偏：穷举不变量（核心）===');
{
  /* 语义：后端是「先移除再插入」。前端在**含被拖项**的数组里算出缝隙 k，
     缝隙 k 表示"插到原数组第 k 项前面"（k=n 即末尾）。

     **期望必须从"原始数组"构造**：把原数组按缝隙 k 切成前后两段，
     各自去掉被拖项，再把被拖项夹在中间。
     直接"把 from 插到移除后数组的第 k 位"是错的 ——
     移除后数组的下标已经和原始缝隙错开了一位，那样构造出来
     恰恰就是"忘记纠偏"的错误结果（我第一版就是这么写的，
     于是 35 组全红，差点去改一个本来正确的实现）。 */
  const expectedList = (n, from, k) => {
    const head = [];
    const tail = [];
    for (let x = 0; x < k; x++) if (x !== from) head.push(x);
    for (let x = k; x < n; x++) if (x !== from) tail.push(x);
    return [...head, from, ...tail];
  };
  const afterMove = (n, from, r) => {
    const rest = [];
    for (let x = 0; x < n; x++) if (x !== from) rest.push(x);
    return [...rest.slice(0, r), from, ...rest.slice(r)];
  };

  let bad = 0, cases = 0, oob = 0;
  for (let n = 1; n <= 6; n++) {
    for (let from = 0; from < n; from++) {
      for (let k = 0; k <= n; k++) {
        const r = resolveMoveIndex(from, k, n);
        cases++;
        if (r < 0 || r > n - 1) { oob++; continue; }
        if (JSON.stringify(afterMove(n, from, r)) !== JSON.stringify(expectedList(n, from, k))) bad++;
      }
    }
  }
  t('全组合无越界', oob === 0, `${cases} 组，越界 ${oob}`);
  t('全组合语义正确', bad === 0, `错误 ${bad} 组`);

  /* 具体几个最容易写错的 */
  t('from=0 k=3 → 落在 2（[A,B,C,D] 拖 A 到 C 后 = [B,C,A,D]）',
    resolveMoveIndex(0, 3, 4) === 2);
  t('from=3 k=1 → 落在 1（拖 D 到 B 前 = [A,D,B,C]）',
    resolveMoveIndex(3, 1, 4) === 1);
  /* 拖到自己前后 = 原地不动 */
  t('from=2 k=2 → 回到 2（原地）', resolveMoveIndex(2, 2, 4) === 2);
  t('from=2 k=3 → 回到 2（原地）', resolveMoveIndex(2, 3, 4) === 2);
  t('from=-1（不在列表）→ 直接用 k', resolveMoveIndex(-1, 2, 4) === 2);
  t('from 越界 → 当作不在列表', resolveMoveIndex(9, 1, 3) === 1);

  t('clampIndex 上限', clampIndex(9, 3) === 3);
  t('clampIndex 下限', clampIndex(-5, 3) === 0);
  t('clampIndex 空列表 → -1', clampIndex(0, -1) === -1);
  t('clampIndex 非有限数 → 0', clampIndex(NaN, 3) === 0);
}

console.log('\n=== 5. 落点半区 / 死区 ===');
{
  t('上半区 → 插到前面（i）', gapIndexAt({ top: 100, height: 40 }, 110, 2) === 2);
  t('下半区 → 插到后面（i+1）', gapIndexAt({ top: 100, height: 40 }, 130, 2) === 3);
  t('正中间算后面（>= 半高）', gapIndexAt({ top: 0, height: 40 }, 20, 0) === 1);

  /* #713：取**较小**值。取大则矮邻框的死区比高分框还大，怎么拖都换不动 */
  t('死区 = min(固定 8, 邻项 20%)', deadZone(100) === 8);
  t('邻项很矮时死区跟它一样小', Math.abs(deadZone(20) - 4) < 1e-9);
  t('邻项为 0 时死区为 0（不该有滞后）', deadZone(0) === 0);

  /* 跨多项（#494）：一次甩动要能连续跨过好几个 */
  const centers = [10, 30, 50, 70, 90];
  const sizes = [20, 20, 20, 20, 20];
  t('原地不动（在自己中心附近）', swapIndexWithDeadZone(50, centers, sizes, 2) === 2);
  t('跨到上一个', swapIndexWithDeadZone(25, centers, sizes, 2) === 1);
  t('一次跨两个', swapIndexWithDeadZone(5, centers, sizes, 2) === 0);
  t('一次跨到最下', swapIndexWithDeadZone(95, centers, sizes, 0) === 4);
  t('死区内不动（越了中心但没超死区）',
    swapIndexWithDeadZone(28, centers, sizes, 2) === 2);
  t('下标非法 → 返回原值', swapIndexWithDeadZone(50, centers, sizes, -1) === -1);
}

console.log('\n=== 6. 三处都改用了共用件（防漂移护栏）===');
{
  /* 抄一份就会漂移：阈值、载荷校验、索引算术改一处漏三处 */
  t('CardGrid 从 utils/dragSort 引入', /from '\.\.\/utils\/dragSort'/.test(cardGrid));
  t('CardGrid 不再自己定义 parseDragPayload', !/^export function parseDragPayload/m.test(cardGrid));
  t('CardGrid 不再自己定义 parseTabDrag', !/^export function parseTabDrag/m.test(cardGrid));
  t('CardGrid 不再自己算阈值', !/Math\.hypot\(e\.clientX - p\.x/.test(cardGrid));
  t('CardGrid 用 movedEnough', /movedEnough\(pressAt\.current/.test(cardGrid));
  t('CardGrid 用 gapIndexAt', /gapIndexAt\(/.test(cardGrid));
  t('CardGrid 用 resolveMoveIndex', /resolveMoveIndex\(/.test(cardGrid));
  t('StackedGroups 从 utils/dragSort 引入', /from '\.\.\/utils\/dragSort'/.test(stack));
  t('StackedGroups 用 BOX_DRAG_MIME', /BOX_DRAG_MIME/.test(stack));
  t('StackedGroups 用 parseBoxDrag', /parseBoxDrag\(/.test(stack));
}

console.log('\n=== 7. 变体互不干扰（收进同一内核才发现）===');
{
  /* 拖着分类框标题经过卡片区时，不该冒出"卡片要插这儿"的竖条 */
  /* 断言**不要绑定源码排版**：此前写死了"onDragOver 后紧跟那段注释"，
     我在中间插了一行调用就误报。改为按容器分段取，看这一段里有没有守卫。 */
  {
    /* 锚点用 `ref={cardsRef}` 而不是 `className="fpx-cards"`：
       后者在我把 className 改成模板字符串（加 empty-over）后就找不到，
       分段取空 → 两条断言一起误报。**锚点要挑不容易随实现变化的那个。** */
    /*
     * 分段范围**不能写死 700 字符**：往中间插入代码（#14 的外部拖入分支）
     * 之后 `onEdgeDragOver` 被推出窗口，indexOf 返回 -1 → 断言假失败。
     * 改成按 `onDragOver` … `onDragLeave` 切出整块。
     */
    /*
     * 锚点必须是卡片区那一处：`onDragOver={(e) => {` 在页签区也有一个，
     * 直接 indexOf 会切到页签那段（那里没有 BOX 守卫）→ 两条一起假失败。
     * 先定位 `ref={cardsRef}`（卡片容器），再从它后面找 onDragOver。
     */
    const iAnchor = cardGrid.indexOf('ref={cardsRef}');
    const i0 = cardGrid.indexOf('onDragOver={(e) => {', iAnchor);
    const i1 = cardGrid.indexOf('onDragLeave', i0);
    const seg = i0 >= 0 && i1 > i0 ? cardGrid.slice(i0, i1) : '';
    t('卡片区排除 BOX_DRAG_MIME', /types\.includes\(BOX_DRAG_MIME\)\) return;/.test(seg));
    /* 记指针必须在守卫之后：调分类框顺序时不该连带滚卡片区 */
    const iGuard = seg.indexOf('BOX_DRAG_MIME');
    const iEdge = seg.indexOf('onEdgeDragOver(e)');
    t('记指针在 BOX 守卫之后', iGuard >= 0 && iEdge > iGuard);
  }
  t('卡片 item 也排除',
    (cardGrid.match(/types\.includes\(BOX_DRAG_MIME\)\)/g) || []).length >= 2);
  /* 页签区本来就只认 DRAG_MIME，天然不参与 */
  t('页签区只认自己的 MIME', /const has = e\.dataTransfer\.types\.includes\(DRAG_MIME\)/.test(cardGrid));
}


console.log('\n=== 图标排序（#72）===');
{
  const grid2Raw = fs.readFileSync(path.join(HERE, 'components/PresetIconGrid.tsx'), 'utf8');
  /* 必须剥掉注释：我在注释里写了 `resolveMoveIndex` 的名字，
     直接拿原文匹配会被自己的注释满足 —— 那样断言形同虚设。 */
  const grid2 = grid2Raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const cssNC = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  /* 必须复用同一套索引纠偏，不能另写一份。
     注意要断言**具体用法**（`resolveMoveIndex(from, k`）而不是名字：
     只查名字的话，光有 import 就能满足，断言形同虚设。 */
  t('用 dragSort 的 resolveMoveIndex（实际调用）',
    /resolveMoveIndex\(from, k/.test(grid2));
  t('用 clampIndex 收边界', /clampIndex/.test(grid2));
  t('落点下标经纠偏后才插入', /const to = clampIndex\(resolveMoveIndex\(/.test(grid2));

  /* 加入模式下不该排序：那时这格是"候选"，拖它会让人误以为已在本组 */
  t('加入模式下不可拖动', /draggable=\{!addMode\}/.test(grid2));
  t('onDragStart 里也挡一道', /if \(addMode\) return;/.test(grid2));

  /* 自己拖到自己身上不该触发 */
  t('拖到自己身上不处理', /src === n\) return;/.test(grid2));

  /* 键盘可达 */
  t('Alt+←/→ 可微调顺序', /ArrowLeft/.test(grid2) && /ArrowRight/.test(grid2));
  t('微调也走边界检查', /to < 0 \|\| to >= current\.icons\.length/.test(grid2));

  /* 落点提示 */
  t('落点用左缘竖条（不是整格高亮）',
    /\.fpx-icongrid-item\.over::before/.test(cssNC));
  t('竖条宽度 2px（密集网格里要细）', /width: 2px/.test(cssNC));
}


console.log('\n=== 分组重排（#73）===');
{
  const gRaw = fs.readFileSync(path.join(HERE, 'components/PresetIconGrid.tsx'), 'utf8');
  /* 剥注释：我在注释里写了这些函数名，只查名字会被注释满足 */
  const g = gRaw.replace(/\/\*[\s\S]*?\*\//g, '');
  const cssNC = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const ds = fs.readFileSync(path.join(HERE, 'utils/dragSort.ts'), 'utf8');

  /* 索引纠偏仍复用同一套 —— 断言到具体用法，不只查名字 */
  t('用 resolveMoveIndex(from, k（实际调用）', /resolveMoveIndex\(from, k/.test(g));
  t('用 clampIndex 收边界', /clampIndex\(resolveMoveIndex\(/.test(g));

  /* 横排落点：必须用 rect 而不是 offsetX（子元素会让 offsetX 跳变） */
  t('用横向落点判定 gapIndexAtX', /gapIndexAtX\(/.test(g));
  t('取的是 getBoundingClientRect 的 left/width', /left: r\.left, width: r\.width/.test(g));
  t('没用 offsetX', !/offsetX/.test(g));

  /* 横排与纵向共用同一个半区规则，不各写一份 */
  t('dragSort 有共用的 halfGap', /export function halfGap/.test(ds));
  t('gapIndexAt 委托给 halfGap', /halfGap\(rect\.top, rect\.height/.test(ds));
  t('gapIndexAtX 也委托给 halfGap', /halfGap\(rect\.left, rect\.width/.test(ds));

  /* 拖完必须保持被拖组为 active —— 否则当前查看的组跳走，
     下面图标全变，用户会以为东西丢了 */
  t('moveGroup 后重新 setActive', /moveGroup[\s\S]{0,400}?setActive\(name\)/.test(g));
  t('键盘微调后也 setActive', /nudgeGroup[\s\S]{0,400}?setActive\(name\)/.test(g));

  /* 只有一个组时不该可拖：拖不出结果却像坏了 */
  t('多于一个组才可拖', /draggable=\{effective\.length > 1\}/.test(g));

  /* 自己拖到自己身上不处理 */
  t('拖到自己身上不处理', /src === g\.name\) return;/.test(g));

  /* 键盘可达 */
  t('Alt+←/→ 可移动分组', /ArrowLeft/.test(g) && /ArrowRight/.test(g));

  /* 落点视觉：竖条而不是整格高亮（会和 active 的内凹混淆） */
  t('落点用竖条（gap-before/gap-after）',
    /\.fpx-grouptab\.gap-before::before/.test(cssNC)
    && /\.fpx-grouptab\.gap-after::after/.test(cssNC));
  t('被拖的组压暗（否则拖拽毫无反馈）', /\.fpx-grouptab\.dragging/.test(cssNC));
}

console.log('\n=== 横向落点判定的行为 ===');
{
  const { gapIndexAtX } = await loadTs(path.join(HERE, 'utils/dragSort.ts'));
  const rect = { left: 100, width: 40 };   // 中心在 120
  t('指针在左半 → 插到它前面', gapIndexAtX(rect, 110, 3) === 3);
  t('指针在右半 → 插到它后面', gapIndexAtX(rect, 130, 3) === 4);
  t('正好在中心 → 算后面（与纵向一致）', gapIndexAtX(rect, 120, 3) === 4);
  /* 与纵向共用规则：同样的相对位置应得同样的相对结果 */
  const { gapIndexAt } = await loadTs(path.join(HERE, 'utils/dragSort.ts'));
  t('横纵规则一致（半区判定同源）',
    gapIndexAtX({ left: 0, width: 40 }, 10, 0)
    === gapIndexAt({ top: 0, height: 40 }, 10, 0));
}


console.log('\n=== #116 删除按钮 hover 才现身 ===');
{
  const cssNC = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  t('默认不显示（opacity 0）', /\.fpx-icon-del\s*\{[^}]*opacity: 0/.test(cssNC));
  t('hover 才显示', /\.fpx-icongrid-item:hover \.fpx-icon-del\s*\{[^}]*opacity: 1/.test(cssNC));

  /* 只压 opacity 是不够的：看不见的按钮仍然可点 */
  t('默认也不可点击（pointer-events: none）',
    /\.fpx-icon-del\s*\{[^}]*pointer-events: none/.test(cssNC));
  t('hover 时恢复可点击',
    /\.fpx-icongrid-item:hover \.fpx-icon-del\s*\{[^}]*pointer-events: auto/.test(cssNC));
  /* 键盘用户也要能看见，否则 tab 到不可见按钮上按回车删了东西却不知道删的是谁 */
  t('focus-visible 时也显示', /\.fpx-icon-del:focus-visible\s*\{[^}]*opacity: 1/.test(cssNC));

  /* 同一条规则不该重复声明两遍（我上一轮就加重复过一次） */
  const cnt = (cssNC.match(/\.fpx-icongrid-item \{ position: relative; \}/g) || []).length;
  t('position: relative 只声明一次', cnt === 1, `${cnt} 处`);
}


console.log('\n=== 贴边自动滚动（#104）===');
{
  const { edgeScrollSpeed } = await loadTs(path.join(HERE, 'utils/dragSort.ts'));
  const hook = fs.readFileSync(path.join(HERE, 'hooks/useEdgeAutoScroll.ts'), 'utf8');
  const grid3 = fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const T = 0, B = 400;   // 可视区 0..400

  /* 中间不动 */
  t('指针在中间 → 不滚', edgeScrollSpeed(200, T, B) === 0);
  /* 贴上边 → 向上滚（负） */
  t('贴上边 → 向上滚', edgeScrollSpeed(5, T, B) < 0);
  t('贴下边 → 向下滚', edgeScrollSpeed(395, T, B) > 0);
  /* 死区外不滚 */
  t('死区外不滚（距上边 100）', edgeScrollSpeed(100, T, B) === 0);
  t('死区外不滚（距下边 100）', edgeScrollSpeed(300, T, B) === 0);

  /* 按深度加速：越贴边越快 */
  {
    const near = Math.abs(edgeScrollSpeed(2, T, B));
    const far = Math.abs(edgeScrollSpeed(40, T, B));
    t('越贴边越快', near > far, `near=${near} far=${far}`);
    /* 速度是"深度/死区"的比例，正好贴到边（pointer=top）才是满速；
       pointer=2 时是 46/48，所以是 13 而不是 14 —— 期望别写死成 14。 */
    t('正好贴边才是满速', Math.abs(edgeScrollSpeed(0, T, B)) === 14);
    t('往里一点就降速', Math.abs(edgeScrollSpeed(2, T, B)) === 13);
    t('死区边界处速度归零', edgeScrollSpeed(48, T, B) === 0);
  }

  /* 上下触发区不能重叠：容器很矮时若两边各取 48 会来回滚 */
  {
    const small = edgeScrollSpeed(30, 0, 60);   // 高 60，中心 30
    t('矮容器中心不来回抖', small === 0, `得到 ${small}`);
    /* 各区厚度被压到半高（30），所以 30 处两边都不触发 */
    t('矮容器仍可向上滚', edgeScrollSpeed(1, 0, 60) < 0);
    t('矮容器仍可向下滚', edgeScrollSpeed(59, 0, 60) > 0);
  }
  t('高度退化（bottom<=top）不滚', edgeScrollSpeed(10, 100, 100) === 0);

  /* **最关键的一条**：dragover 只在指针移动时触发，
     所以必须用 rAF 持续推进，不能只靠 onDragOver 里滚一次 */
  t('用 requestAnimationFrame 持续滚动', /requestAnimationFrame/.test(hook));
  t('dragover 只记指针位置', /pointerY\.current = e\.clientY/.test(hook));
  t('rAF 循环里读的是记下的位置', /const y = pointerY\.current/.test(hook));

  /* 拖拽结束必须停 —— 忘了停容器会一直自己滚 */
  t('有 cancelAnimationFrame', /cancelAnimationFrame/.test(hook));
  t('卸载/失活时停', /return stop;/.test(hook));
  t('卡片网格接入了', /useEdgeAutoScroll\(/.test(grid3));
  t('清理入口一并 stop', /clearDropWithScroll/.test(grid3));
}


console.log('\n=== #103 拖回源页签 = 无操作 ===');
{
  const { skipDropToTab } = await loadTs(path.join(HERE, 'utils/tabs.ts'));
  const app5 = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const tabs = [{ items: ['/a', '/b'] }, { items: ['/c'] }];

  t('卡片已在目标页签 → 跳过', skipDropToTab(tabs, 0, '/a') === true);
  t('卡片不在目标页签 → 不跳过', skipDropToTab(tabs, 1, '/a') === false);
  t('页签下标越界 → 不跳过（交回上层，别静默）',
    skipDropToTab(tabs, 9, '/a') === false);
  t('空页签 → 不跳过', skipDropToTab([{ items: [] }], 0, '/a') === false);

  /* 守卫必须真的接进落点处理里，不能只有个函数 */
  t('落点处调用了守卫', /skipDropToTab\(boot\.projectTabs, tabIndex, path\)/.test(app5));
  t('守卫命中就 return（不往下走 moveCard）',
    /if \(skipDropToTab\([^)]*\)\) return;/.test(app5));
}

console.log('\n=== #105 空列表拖入：整区高亮而非竖条 ===');
{
  const g4 = fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const cssNC = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  t('空列表时容器加 empty-over 类', /empty-over/.test(g4));
  /* 只在空列表且有拖拽时才加：否则平时就一直高亮着 */
  t('条件含 cards.length === 0', /cards\.length === 0 && dropAt === 0/.test(g4));
  t('条件含同栏判定', /draggingKind === kind/.test(g4));

  /* 空列表不该再画竖条（那条线已无处参照） */
  t('不再渲染 fpx-drop-line', !/fpx-drop-line/.test(g4));
  t('样式里也不留 fpx-drop-line（死样式）', !/fpx-drop-line/.test(cssNC));

  t('整区高亮样式存在', /\.fpx-cards\.empty-over/.test(cssNC));
}

done();
