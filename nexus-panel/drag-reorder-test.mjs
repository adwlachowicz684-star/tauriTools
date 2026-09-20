/**
 * 拖拽排序内核（js/drag-reorder.js）的测试。
 *
 * 为什么要单独测：这类逻辑写错的表现是**「拖完停在别处」** 或
 * 「抖一下就乱跳」，界面上要连点好几次、项数够多才复现得出，
 * 靠手测几乎发现不了。纯函数才能穷举钉住。
 *
 * 每一节都对着一个**真实踩过或 WPF 原版专门注释过**的坑。
 */

import {
  DRAG_THRESHOLD, DEAD_ZONE_FIXED, DEAD_ZONE_RATIO, EDGE_ZONE, EDGE_MAX_SPEED,
  movedEnough, deadZone, swapIndexWithDeadZone, edgeScrollSpeed,
  resolveMoveIndex, clampIndex, dragMime, parseDragIndex,
} from './js/drag-reorder.js';
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
function t(name, cond, detail = '') {
  if (cond) { pass++; console.log(`✅ ${name}${detail ? ` → ${detail}` : ''}`); }
  else { fails.push(name); console.log(`❌ ${name}${detail ? ` → ${detail}` : ''}`); }
}

console.log('\n=== 1. 起始阈值：别把点击误判成拖拽 ===');
/*
 * 这是「点了没反应」的直接来源：手抖 2~3px 被浏览器判定为拖拽，
 * 而一旦开始拖 click 就不再触发 —— 点一项想选中它，结果既没选中、
 * 项还被拖走一点。阈值内必须取消拖拽。
 */
{
  const press = { x: 100, y: 100 };
  t('位移 0 不算拖拽', movedEnough(press, 100, 100) === false);
  t('手抖 3px 不算拖拽', movedEnough(press, 103, 100) === false);
  t('超过阈值算拖拽', movedEnough(press, 100 + DRAG_THRESHOLD + 1, 100) === true);
  /* 按**距离**而不是单轴：斜着抖 3,3 的直线距离约 4.24，仍在阈值内 */
  t('斜向抖动按距离算（3,3 → 4.24）', movedEnough(press, 103, 103) === false);
  /* 阈值是「>=」：正好压线算拖拽（略高于浏览器自带 4~5px，只拦真实抖动） */
  t('恰好等于阈值算拖拽（>= 语义）',
    movedEnough(press, 100 + DRAG_THRESHOLD, 100) === true);
  /* 没有按下点（键盘发起的拖拽）→ 不拦，交给浏览器 */
  t('无按下点时不拦', movedEnough(null, 100, 100) === true);
}

console.log('\n=== 2. 死区：越中心还不够，还要超死区才换位 ===');
/*
 * 没有死区的话，手抖一两个像素列表就疯狂跳动，看着像界面坏了。
 * 死区取「固定 8px」与「邻项尺寸 20%」的**较小值** ——
 * 取较大值会让矮项的 20% 超过邻项，触发点被推进邻项内部，怎么拖都换不动。
 */
{
  t('矮项：死区取尺寸 20%（2px）而不是固定 8px',
    deadZone(10) === 2, `deadZone(10)=${deadZone(10)}`);
  t('高项：死区取固定值 8px',
    deadZone(100) === DEAD_ZONE_FIXED, `deadZone(100)=${deadZone(100)}`);
  t('死区不超过固定值', deadZone(10000) === DEAD_ZONE_FIXED);
}

console.log('\n=== 3. 换位判定：死区内不动，越过才换，支持一次跨多项 ===');
{
  /* 三项，中心 10 / 30 / 50，每项高 20 → 死区 min(8, 20*0.2=4) = 4 */
  const centers = [10, 30, 50];
  const sizes = [20, 20, 20];
  const dz = 4;

  /*
   * 判定是**严格**越界（pos > 中心+死区），压线不算动 ——
   * 压线就换的话，指针停在临界点会来回抖。
   */
  t('未越过下项中心+死区 → 不换位',
    swapIndexWithDeadZone(25, centers, sizes, 0) === 0);
  t('刚好压线（30+4=34）仍不换',
    swapIndexWithDeadZone(34, centers, sizes, 0) === 0);
  t('越过中心+死区 → 换到 1',
    swapIndexWithDeadZone(35, centers, sizes, 0) === 1);
  /* 一次跨两项：越过 30 与 50 两个中心 */
  t('一次跨多项 → 直接到 2',
    swapIndexWithDeadZone(60, centers, sizes, 0) === 2);

  /* 反向：拖第 2 项往上（同样是严格越界，压线不换） */
  t('向上刚好压线（30-4=26）仍不换',
    swapIndexWithDeadZone(26, centers, sizes, 2) === 2);
  t('向上越过中心+死区 → 换到 1',
    swapIndexWithDeadZone(25, centers, sizes, 2) === 1);
  t('向上一次跨多项 → 到 0',
    swapIndexWithDeadZone(0, centers, sizes, 2) === 0);

  /* 边界：from 越界时返回原值，不要崩 */
  t('from 越界 → 原样返回', swapIndexWithDeadZone(999, centers, sizes, 9) === 9);
}

console.log('\n=== 4. 贴边自动滚动：方向、死区、两边不得重叠 ===');
{
  /* 视口 0~100 */
  t('中间不滚', edgeScrollSpeed(50, 0, 100) === 0);
  /* 贴上边 → 向上滚（负） */
  t('贴上边向上滚（负）', edgeScrollSpeed(2, 0, 100) < 0);
  t('贴下边向下滚（正）', edgeScrollSpeed(98, 0, 100) > 0);
  /* 越贴越快 */
  const near = Math.abs(edgeScrollSpeed(2, 0, 100));
  const far = Math.abs(edgeScrollSpeed(40, 0, 100));
  t('越贴边越快', near > far, `近 ${near} > 远 ${far}`);
  t('速度有上限', Math.abs(edgeScrollSpeed(-999, 0, 100)) <= EDGE_MAX_SPEED);

  /*
   * 矮容器：两边触发区不能重叠。
   * 若各取 48px 而容器只有 60px 高，同一指针会同时落在两个区里 ——
   * 那就会一直来回滚，是最难查的一类表现。
   */
  const tiny = edgeScrollSpeed(30, 0, 60);
  t('矮容器中心不来回抖（触发区不重叠）', tiny === 0, `返回 ${tiny}`);

  t('退化容器（bottom<=top）不滚', edgeScrollSpeed(50, 100, 100) === 0);
}

console.log('\n=== 5. 索引纠偏：往上拖不能落点偏后一格 ===');
/*
 * 「先移除再插入」的语义下，落点 k 是在**还含被拖项**的数组里算出的。
 * 被拖项原本在 k 之前时，它一走后面的都前移一位，k 要减 1。
 * 不减的表现：明明插在 A 前面，结果跑到 A 后面。WPF 原版专门注释过这条。
 */
{
  t('往上拖（from<k）要 -1', resolveMoveIndex(3, 1, 5) === 1);
  t('往下拖（from>k）不减', resolveMoveIndex(1, 3, 5) === 2);
  t('from 不在列表里 → 直接用 k', resolveMoveIndex(-1, 2, 5) === 2);
  t('结果夹在合法范围内', resolveMoveIndex(0, 99, 5) === 4);
  t('空列表返回 -1', clampIndex(0, -1) === -1);
}

console.log('\n=== 6. 载荷校验：dataTransfer 里可以是任意文本 ===');
{
  /* 从别的应用拖进来的文本 / 人为伪造，都不能让页面崩或误动 */
  t('null → -1', parseDragIndex(null) === -1);
  t('空串 → -1', parseDragIndex('') === -1);
  t('非法 JSON 不抛异常', parseDragIndex('{oops') === -1);
  t('负数 → -1', parseDragIndex('{"index":-1}') === -1);
  t('非整数 → -1', parseDragIndex('{"index":1.5}') === -1);
  t('字符串 index → -1', parseDragIndex('{"index":"2"}') === -1);
  t('合法对象载荷', parseDragIndex('{"index":3}') === 3);
  t('合法数字载荷', parseDragIndex('7') === 7);
}

console.log('\n=== 7. 专用 MIME：不能图省事用 text/plain ===');
{
  /*
   * 用 text/plain 的两个坑：
   *   ① 通用类型，从别的应用拖进来的文本也匹配它
   *   ② 行内若有 <input>（重命名框），拖着 text/plain 经过它松手，
   *      浏览器默认行为是把文本插进去 —— 想调顺序却把名字塞进了输入框
   */
  const m = dragMime('plugin-app');
  t('是专用类型', m !== 'text/plain' && m.startsWith('application/x-nexus-'), m);
  t('不同 key 得到不同 MIME', dragMime('a') !== dragMime('b'));
}

console.log('\n=== 8. 分层：纯逻辑零依赖，React 层单独 ===');
{
  /*
   * 分层是被**事故**逼出来的：最初 hook 与纯逻辑写在同一文件，
   * 文件顶部就得 import react，于是连只想用 swapIndexWithDeadZone 的
   * 调用方（原生 JS 插件、纯逻辑测试）也被迫装 React ——
   * 实测 drag-reorder-test 直接 ERR_MODULE_NOT_FOUND: react。
   *
   * 所以拆开：drag-reorder.js（零依赖） / drag-reorder-react.js（接线）。
   */
  const core = readFileSync('js/drag-reorder.js', 'utf8');
  const rjs = readFileSync('js/drag-reorder-react.js', 'utf8');
  t('纯逻辑层不依赖 React', !/from\s+['"]react['"]/.test(core));
  t('React 层 import 纯逻辑', /import\s+[^}]*\}/s.test(rjs) && rjs.includes('./drag-reorder.js'));
}

console.log('\n=== 9. 手感一致：与项目组集群共用同一套数值 ===');
{
  /*
   * 抽内核的全部意义就在这里 —— 各处数值**必须**是同一套。
   * 若这边死区 8px、那边 4px，用户能说出的只是「两个列表拖起来不一样」，
   * 根本定位不到是常量分叉了。所以由测试钉住，而不是靠自觉。
   */
  const src = readFileSync('plugins/project-group/utils/dragSort.ts', 'utf8');
  const num = (re) => { const m = src.match(re); return m ? Number(m[1]) : NaN; };

  const theirThreshold = num(/DRAG_THRESHOLD\s*=\s*(\d+)/);
  const theirZone = num(/zone\s*=\s*(\d+)\s*,\s*maxSpeed\s*=\s*(\d+)/);
  const theirMax = num(/maxSpeed\s*=\s*(\d+)/);
  const theirFixed = num(/fixed\s*=\s*(\d+)\s*,\s*ratio\s*=\s*([\d.]+)/);
  const theirRatio = (src.match(/ratio\s*=\s*([\d.]+)/) || [])[1];

  t('起始阈值与集群一致',
    theirThreshold === DRAG_THRESHOLD, `集群 ${theirThreshold} / 内核 ${DRAG_THRESHOLD}`);
  t('贴边触发区与集群一致',
    theirZone === EDGE_ZONE, `集群 ${theirZone} / 内核 ${EDGE_ZONE}`);
  t('贴边最大速度与集群一致',
    theirMax === EDGE_MAX_SPEED, `集群 ${theirMax} / 内核 ${EDGE_MAX_SPEED}`);
  t('死区固定值与集群一致',
    theirFixed === DEAD_ZONE_FIXED, `集群 ${theirFixed} / 内核 ${DEAD_ZONE_FIXED}`);
  t('死区比例与集群一致',
    Number(theirRatio) === DEAD_ZONE_RATIO, `集群 ${theirRatio} / 内核 ${DEAD_ZONE_RATIO}`);
}

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败项：' + fails.join('、'));
  process.exit(1);
}
