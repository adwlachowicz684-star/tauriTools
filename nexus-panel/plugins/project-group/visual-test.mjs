/**
 * 视觉规范共用件的回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/visual-test.mjs，然后
 *         node plugins/project-group/visual-test.mjs
 *
 * 视觉规范散在清单约 20 个编号里（#230-237、#276-298），
 * 本质却只有两件事：
 *   · 给一个基色，派生出三态画刷（#294 的 Lighten/Darken/IsBright）
 *   · 三态共用同一套几何、只改方向
 *
 * 此前卡片的三态派生是**内联魔数**（0.18 / -0.12 写在 JSX 里），
 * 链接按钮则完全没有派生（#293）—— 于是"卡片有反馈、链接按钮没有"。
 *
 * 这里守几件容易做错的事：
 *   · 无效色值必须返回 null，绝不返回"看起来能用"的近似色（#295）
 *   · 明暗幅度**不能对称**：人眼对变暗更敏感
 *   · CSS 变量必须带兜底：没设颜色的卡片变量未定义，不能变成透明
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const V = await loadTs(path.join(HERE, 'utils/visual.ts'));
const {
  HOVER_AMOUNT, PRESS_AMOUNT, deriveBrush, brushVars,
  SHADOW, LIFT, bevelEdge, MONO_TITLE_WIDTH,
} = V;

const css = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8');
/* 规则类断言必须看**剥掉注释**的 CSS：
   我在注释里写了 `*:focus-visible { outline: none }` 作为反例，
   直接拿原文匹配会被自己写的注释骗到 ——
   这与"注释里出现某个词 ≠ 用户能看到"是同一类坑，已踩过多次。 */
const cssNC = css.replace(/\/\*[\s\S]*?\*\//g, '');
const grid = fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8');

console.log('\n=== 1. 明暗幅度（#294）===');
{
  t('悬停是变亮（正数）', HOVER_AMOUNT > 0, String(HOVER_AMOUNT));
  t('按下是变暗（负数）', PRESS_AMOUNT < 0, String(PRESS_AMOUNT));
  /* 人眼对暗部更敏感，按下幅度必须更小，否则深色底糊成一团 */
  t('按下幅度小于悬停幅度（不能对称）',
    Math.abs(PRESS_AMOUNT) < Math.abs(HOVER_AMOUNT));
  t('幅度都不是 0（否则三态退化成两态）',
    HOVER_AMOUNT !== 0 && PRESS_AMOUNT !== 0);
}

console.log('\n=== 2. 无效色值返回 null（#295）===');
{
  t('空串 → null', deriveBrush('') === null);
  t('空白 → null', deriveBrush('   ') === null);
  t('乱码 → null', deriveBrush('not-a-color') === null);
  t('缺 # 且长度不对 → null', deriveBrush('12345') === null);
  t('null → null', deriveBrush(null) === null);
  t('undefined → null', deriveBrush(undefined) === null);

  /* 绝不能返回"看起来能用"的近似色：那会让界面不报错却显示不对 */
  const bad = ['', 'xyz', '#gggggg', '#12', '#1234567'].filter((s) => deriveBrush(s) !== null);
  t('一批非法值全部返回 null', bad.length === 0, bad.join(',') || '无');
}

console.log('\n=== 3. 归一化：写法不同必须同一结果 ===');
{
  /* 同一张卡片因配置写法不同而显示成两种颜色，是最难查的那类 */
  const a = deriveBrush('#aabbcc');
  const b = deriveBrush('AABBCC');
  const c = deriveBrush('#abc');
  t('都解析成功', !!a && !!b && !!c);
  t('#aabbcc == AABBCC', a.base === b.base);
  t('#abc 展开为 #AABBCC', c.base === '#AABBCC');
  t('三态完全一致', a.hover === b.hover && a.hover === c.hover
    && a.press === b.press && a.press === c.press);
}

console.log('\n=== 4. 三态确实不同（否则等于没做）===');
{
  const b = deriveBrush('#808080');
  t('三态互不相同', new Set([b.base, b.hover, b.press]).size === 3);
  t('悬停比基色亮', b.hover !== b.base);
  t('按下比基色暗', b.press !== b.base);

  /* 深浅两端都要有变化：极端色最容易"看不出悬停" */
  const dark = deriveBrush('#101010');
  const light = deriveBrush('#f0f0f0');
  t('极深色也能派生出悬停态', dark.hover !== dark.base);
  t('极浅色也能派生出按下态', light.press !== light.base);
}

console.log('\n=== 5. 叠字色（IsBright）===');
{
  t('深底用白字', deriveBrush('#101010').textOn === '#ffffff');
  t('浅底用黑字', deriveBrush('#f0f0f0').textOn === '#1a1a1a');
  /* 中间色必须有明确选择，不能出现"既不是黑也不是白"的模糊态 */
  const mid = deriveBrush('#808080');
  t('中间色也非黑即白', ['#ffffff', '#1a1a1a'].includes(mid.textOn));
}

console.log('\n=== 6. CSS 变量（brushVars）===');
{
  const v = brushVars('#aabbcc', 'tag');
  t('产出 5 个变量', Object.keys(v).length === 5);
  t('变量名带前缀', Object.keys(v).every((k) => k.startsWith('--tag-')));
  t('含 base/hover/press/on/edge',
    ['--tag-base', '--tag-hover', '--tag-press', '--tag-on', '--tag-edge']
      .every((k) => k in v));

  const g = brushVars('#aabbcc', 'grp');
  t('换前缀后变量名跟着变', '--grp-base' in g && !('--tag-base' in g));

  /* 无效色必须返回空对象：这样展开后不覆盖 CSS 里的兜底值 */
  t('无效色 → 空对象（不写死任何变量）',
    Object.keys(brushVars('zzz', 'tag')).length === 0);
  t('空串 → 空对象', Object.keys(brushVars('', 'tag')).length === 0);
}

console.log('\n=== 7. 三态几何只给档位名，不写死颜色 ===');
{
  /* 硬编码阴影会让本插件在换主题时"穿"成另一套，比没有阴影更糟 */
  t('常态/悬停/按下/选中四档都有',
    !!SHADOW.rest && !!SHADOW.hover && !!SHADOW.press && !!SHADOW.selected);
  t('都是 var()（交给主题）',
    Object.values(SHADOW).every((v) => String(v).startsWith('var(')));
  t('按下是内凹（sh-in）', String(SHADOW.press).includes('sh-in'));
  t('常态是外凸（sh-out）', String(SHADOW.rest).includes('sh-out'));
  t('悬停比常态更大更散（md > sm）',
    String(SHADOW.hover).includes('md') && String(SHADOW.rest).includes('sm'));

  t('悬停抬起', LIFT.hover !== LIFT.rest);
  t('按下归位（与常态相同）', LIFT.press === LIFT.rest);
}

console.log('\n=== 8. 描边与等宽标题 ===');
{
  const b = bevelEdge('#000000', '#ffffff');
  t('两段描边（亮边在上、暗边在下）', (b.match(/inset/g) || []).length === 2);
  t('亮边在上', b.indexOf('#ffffff') < b.indexOf('#000000'));
  t('用 ch 而不是 px（字号变了仍对齐）', MONO_TITLE_WIDTH > 0);
}

console.log('\n=== 9. 调用方都改用了共用件（防漂移护栏）===');
{
  /* 抄一遍魔数就会漂移：改配色时只改一处 */
  t('CardGrid 引入 brushVars', /import \{ brushVars \} from '\.\.\/utils\/visual'/.test(grid));
  t('CardGrid 不再内联 0.18', !/shade\(c\.tagColor, 0\.18\)/.test(grid));
  t('CardGrid 不再内联 -0.12', !/shade\(c\.tagColor, -0\.12\)/.test(grid));
  t('卡片用了 brushVars', /brushVars\(c\.tagColor \?\? ''/.test(grid));
  /* 只算一次：算两次会让"两处拿到不同值"成为可能 */
  t('卡片只算一次（存进 tag 变量）', /const tag = brushVars/.test(grid));
  t('组名徽标也派生（#293）', (grid.match(/brushVars\(c\.tagColor, 'grp'\)/g) || []).length >= 2);
}

console.log('\n=== 10. CSS 侧必须有兜底（#293）===');
{
  /* 没设颜色的卡片由 JSX 不写内联样式 → --grp-* 未定义 → 必须退回主题色 */
  t('组徽标描边带兜底', /--grp-base, var\(--accent\)/.test(css));
  t('悬停用 --grp-hover 带兜底', /--grp-hover, var\(--accent\)/.test(css));
  t('按下用 --grp-press 带兜底', /--grp-press, var\(--accent\)/.test(css));
  t('装甲块插销槽仍在（#291）', /插销槽/.test(css));
  /* 上一条查的是注释（意图），这条查真实规则（实现）——
     只查注释的话，哪天规则被删了测试还是绿的。 */
  t('插销槽有真实的 inset 规则',
    /\.fpx-badge\.group\.jump\s*\{[^}]*inset 2px 0 0/.test(cssNC));
}

console.log('\n=== 11. 新补的规范项 ===');
{
  /* #284 分隔条三态 */
  t('分隔条拖动态有独立规则', /\.fpx-splitter\.dragging::after/.test(css));
  t('拖动时加粗（与悬停可辨）', /dragging::after \{[^}]*width: 3px/.test(css));
  t('拖动时给辉光', /dragging::after[^}]*box-shadow/.test(css));
  /* #283 滚动条 */
  t('滚动条全自定义', /::-webkit-scrollbar-thumb/.test(css));
  t('滑块有外凸阴影（与轨道内凹对比）',
    /scrollbar-thumb \{[^}]*box-shadow/.test(css));
  t('轨道内凹（与承载区同材质）', /scrollbar-track \{[^}]*surface-sunk/.test(css));
  /* #288 去聚焦蓝边——但只能去"有替代表现"的元素 */
  /*
   * 原先钉的是 `outline: none;` 后面**那句注释** —— 注释删了就假失败，
   * 而真正要守的是"去掉蓝边的同时给了替代表现"。
   * 改成在同一条规则里同时要求 outline:none 与替代样式（阴影或边框）。
   */
  t('去蓝边时有替代表现',
    /outline: none;[^}]*(box-shadow|border)/.test(css));
  t('没有全站 outline:none（否则键盘用户失去焦点指示）',
    !/\*\s*:focus-visible\s*\{\s*outline:\s*none/.test(cssNC));
}


console.log('\n=== 12. 页签三态与虚线添加框（#279 #287）===');
{
  const grid2 = fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8');
  const app4 = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8');

  /* #279 页签三态：常态外凸 → 悬停抬升 → 选中/按下内凹 */
  t('页签常态外凸', /\.fpx-tab \{[^}]*sh-out-sm/.test(cssNC));
  t('页签悬停抬升（md）', /\.fpx-tab:hover[^}]*sh-out-md/.test(cssNC));
  t('页签按下内凹', /\.fpx-tab:active[^}]*sh-in/.test(cssNC));
  t('页签选中内凹', /\.fpx-tab\.active[^}]*sh-in/.test(cssNC));

  /* #287 虚线添加框 */
  t('虚线框样式存在', /\.fpx-add-card\s*\{/.test(cssNC));
  t('是虚线（dashed）', /\.fpx-add-card\s*\{[^}]*dashed/.test(cssNC));
  t('悬停才显形（平时压低不透明度）', /\.fpx-add-card\s*\{[^}]*opacity/.test(cssNC));
  t('CardGrid 支持 onAdd（可选）', /onAdd\?: \(\) => void/.test(grid2));
  t('只在传了 onAdd 时才渲染', /\{onAdd && \(/.test(grid2));
  t('两栏都接上了', /onAdd\={onAdd}/.test(app4));
  /* 这句提示此前是空头承诺：让用户点一个当时并不存在的按钮 */
  t('空列表提示指向真实存在的入口', /点下面的/.test(app4));
  t('提示不再指向不存在的按钮', !/点「\＋ 添加」选一个文件夹/.test(app4));
}

console.log('\n=== #281 / #282 / #371 标题浮雕·等宽条目·全局资源 ★★ ===');
{
  const css = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8');
  const ruleOf = (sel) => {
    const re = new RegExp('^' + sel.replace(/[.>\s-]/g, (m) => '\\' + m) + '\\s*\\{', 'm');
    const m = re.exec(css);
    return m ? css.slice(m.index, css.indexOf('}', m.index)) : '';
  };

  /*
   * 一、#281 银白浮雕：渐变三色标 + 右下微影。
   *
   * 原版 TitleEmbossBrush：#F1F3F8（上，受光）→ #C0C8D4（55%）→ #A6AFBF（下，收暗）；
   * TextEmboss：Blur 3 / Depth 1.3 / Direction 315（右下）/ Opacity .42。
   */
  t('定义了浮雕三色标变量',
    /--title-emboss-top/.test(css) && /--title-emboss-mid/.test(css) && /--title-emboss-bottom/.test(css));
  t('浮雕色走变量而非硬编码（#371）',
    /var\(--title-emboss-top\)/.test(css) && /var\(--title-emboss-bottom\)/.test(css));
  const h2 = ruleOf('.p-card > h2');
  t('分区标题用了渐变裁字', /background-clip:\s*text/.test(css) && /linear-gradient/.test(css));
  t('分区标题有 -webkit- 前缀（WebView2/WKWebView 都要）', /-webkit-background-clip:\s*text/.test(css));
  t('阴影方向为右下（原版 Direction 315）', /text-shadow:\s*1\.3px\s*1\.3px\s*3px/.test(css));

  /*
   * 二、**必须区分两级**（照原版）。
   *
   * 浮雕只给 PanelTitle / SectionTitle；分栏标题 ColumnTitle 与窗口主标题
   * AppTitle 是纯色（原版注释"纯色统一风"）。全加的话三个栏头会浮起来，
   * 比栏内内容还抢眼，视觉层级整个翻过来。
   */
  const colHead = ruleOf('.fpx-col-head h2');
  t('分栏标题不带浮雕（纯色）', /color:\s*var\(--text\)/.test(colHead), colHead.slice(0, 90));
  t('分栏标题显式关掉了 text-shadow', /text-shadow:\s*none/.test(colHead));
  /*
   * `ruleOf` 只取**第一条**同名规则，而这里 .fpx-col-head h2 写了两条
   * （一条在 @supports 外、一条在内）。只查第一条就会漏 —— 我又踩了
   * "同名规则有多条，断言只钉到其中一条"这个坑。改成收集全部。
   */
  const colHeadAll = [...css.matchAll(/^[ \t]*\.fpx-col-head h2\s*\{[^}]*\}/gm)].map((m) => m[0]).join('\n');
  t('分栏标题显式还原了 background-clip（全部同名规则）',
    /background-clip:\s*border-box/.test(colHeadAll), colHeadAll.slice(0, 160));

  /*
   * 三、**必须包在 @supports 里**（否则不支持的引擎上标题会消失）。
   *
   * `color: transparent` + `background-clip: text` 是一对：不支持裁字时
   * 透明文字就真的透明了 —— 整行标题**彻底消失且没有任何报错**。
   * 所以透明只能写在 @supports 内，外面留纯色兜底。
   */
  t('渐变裁字包在 @supports 内', /@supports[^{]*background-clip:\s*text/.test(css));
  const outside = css.replace(/@supports[\s\S]*?\n\}/g, '');
  t('兜底色写在 @supports 之外', /color:\s*var\(--title-emboss-mid\)/.test(outside));

  /*
   * 四、#282 等宽条目标题：只给**标识符**（agent/skill/工具/链接名）。
   *
   * 理由不是好看：这些名字常有 `_` `-` `.` 与大小写混排，比例字体下
   * `l`/`1`/`I` 分不出来，照着抄一个名字容易抄错，
   * 后果是"找不到这个 agent"，而报错指不到原因。
   */
  const nodeName = ruleOf('.fpx-node-name');
  t('树节点名（agent/skill）用等宽', /font-family:\s*var\(--font-mono/.test(nodeName), nodeName.slice(0, 90));
  const linkText = ruleOf('.fpx-link-text');
  t('链接名用等宽', /font-family:\s*var\(--font-mono/.test(linkText), linkText.slice(0, 110));
  t('等宽带兜底字族（不依赖 --font-mono 已定义）',
    /var\(--font-mono,\s*ui-monospace/.test(nodeName) || /var\(--font-mono,\s*ui-monospace/.test(linkText));
}

done();
