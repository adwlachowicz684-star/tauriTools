/**
 * 连锁动作页签拖拽重排 + 插入条（#148 / #149，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/action-sort-test.mjs
 *
 * 此前只有 ↑↓ 按钮：跨好几格要点很多次。
 * 与卡片/页签/图标排序共用同一套索引纠偏与半区判定。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const ds = R('utils/dragSort.ts');
const panel = R('components/ChainActionsPanel.tsx');
const css = strip(fs.readFileSync(path.join(HERE, 'style.css'), 'utf8'));

console.log('\n=== 1. 复用内核，不另写一份 ===');
{
  t('MIME 在 dragSort 里', /export const ACTION_DRAG_MIME/.test(ds));
  t('解析函数共用同一文件', /export function parseActionDrag/.test(ds));
  t('面板 import 内核', /from '\.\.\/utils\/dragSort'/.test(panel));
  t('用 resolveMoveIndex（与卡片同一套纠偏）', /resolveMoveIndex\(from, k, l\.length\)/.test(panel));
  /*
   * 现在是**带死区**的版本（原版 AcSwapDeadZone）：
   * `gapIndexAt` 换成 `gapIndexAtDeadZone`，多一个死区基准参数。
   */
  t('用带死区的半区判定', /gapIndexAtDeadZone\(\s*\{ top: r\.top, height: r\.height \}, e\.clientY, i, AC_SWAP_DEAD_ZONE,/.test(panel));
  t('不再用无死区的 gapIndexAt', !/[^D]gapIndexAt\(/.test(panel));
}

console.log('\n=== 2. 落点判定不能用 offsetY ===');
{
  /* 项里有 <span>（"自定义"徽标），指针落在它上面时 offsetY 会跳变 */
  t('用 getBoundingClientRect', /e\.currentTarget\.getBoundingClientRect\(\)/.test(panel));
  t('没用 offsetY', !/offsetY/.test(panel));
  t('半区判定走内核', /gapIndexAtDeadZone\(/.test(panel));
  /* 死区基准 14（原版 AcSwapDeadZone = 14.0），不是分类框那个默认 8 */
  t('死区基准 14', /const AC_SWAP_DEAD_ZONE = 14;/.test(panel));
  /*
   * 死区内**不更新**落点，而不是 setActGap(null)。
   * 后者会把插入条清掉 → 拖着不动时插入条一闪一闪，比不加死区更晃眼。
   */
  t('死区内保持现状', /if \(g === null\) return;/.test(panel));
}

console.log('\n=== 3. 无效放置必须能回弹（#103 同源）===');
{
  /*
   * 若先 preventDefault 再判空，无效放置也走"被接受"路径 ——
   * 浏览器不给回弹动画，拖影直接消失、界面毫无变化，
   * 用户以为放下去了，其实什么也没发生。
   */
  const dropSeg = panel.slice(panel.indexOf('onDrop={(e) => {'));
  const seg = dropSeg.slice(0, dropSeg.indexOf('onClick={() => setActive(a.id)}'));
  t('先解析', seg.indexOf('parseActionDrag') < seg.indexOf('e.preventDefault()'));
  /*
   * 只断言"有 if (!id) return"不够 —— 它被放到 preventDefault 之后
   * 照样满足。真正要测的是**位置**：判空的索引必须早于 preventDefault。
   */
  t('判空在 preventDefault 之前',
    seg.indexOf('if (!id) return;') >= 0
    && seg.indexOf('if (!id) return;') < seg.indexOf('e.preventDefault()'));
  /* 反向确认：把判空挪到后面应当被判红 */
  const moved = seg.replace('if (!id) return;', '').replace('e.preventDefault();', 'e.preventDefault(); if (!id) return;');
  t('（自检）挪到后面会被抓到',
    !(moved.indexOf('if (!id) return;') < moved.indexOf('e.preventDefault()')));
}

console.log('\n=== 4. 原地放下 = 无操作 ===');
{
  /* 拖起来发现放错、又拖回原地：不该把项挪到末尾（#103 同源 bug） */
  /*
   * 现在是夹紧后的 to2 与 from 比较 —— 固定墙可能把 to 夹回 from，
   * 那种情况同样是"什么都没发生"，不该记 dirty。
   */
  t('落点相同就返回原数组', /if \(to2 === from\) return l;/.test(panel));
  t('插入用夹紧后的落点', /n\.splice\(to2, 0, it\);/.test(panel));
}

console.log('\n=== 5. #149 插入条 ===');
{
  t('有插入条元素', /className="fpx-ca-gap"/.test(panel));
  t('只在拖拽中渲染', /\{dragId && actGap === i/.test(panel));
  /* 末尾那条缝隙不能漏：拖到最后一项下半区时落点在 list.length */
  t('末尾也有插入条', /actGap === list\.length/.test(panel));
  t('被拖项自己不画条', /dragId !== a\.id/.test(panel));
  t('CSS 有插入条样式', /\.fpx-ca-gap \{/.test(css));
  t('被拖项压暗（否则界面上有两个"当前项"）', /\.fpx-ca-item\.dragging[\s\S]{0,120}?opacity: \.45/.test(css));
}

console.log('\n=== 6. 拖完要清状态 ===');
{
  t('dragEnd 清状态', /onDragEnd=\{\(\) => \{ setDragId\(null\); setActGap\(-1\); \}\}/.test(panel));
  t('drop 后清状态', /dropActionAt\(id, k\);[\s\S]{0,80}?setDragId\(null\);/.test(panel));
}

console.log('\n=== 7. 行为：resolveMoveIndex 纠偏 ===');
{
  const { resolveMoveIndex } = await loadTs(path.join(HERE, 'utils/dragSort.ts'));
  /* 从第 0 项移到末尾缝隙：纠偏后应是最后一位，不是越界 */
  t('移到末尾', resolveMoveIndex(0, 5, 5) === 4, `${resolveMoveIndex(0, 5, 5)}`);
  t('原地不动', resolveMoveIndex(2, 2, 5) === 2);
  t('向前移', resolveMoveIndex(3, 1, 5) === 1);
}

done();

console.log('\n=== 5. 内置项固定墙（原版 AcIsCustom / 不可借位）===');
{
  t('drop 里夹紧落点', /const to2 = clampAcrossFixedWall\(from, to, fixed\);/.test(panel));
  t('固定项按原始下标判定', /const fixed = l\.map\(\(a\) => !!a\.builtin\);/.test(panel));
  /* 内置不可拖：后端 ensure_actions 按固定顺序重建，拖了也会弹回去 */
  t('内置项不可拖', /draggable=\{!a\.builtin\}/.test(panel));
  t('内置项说明原因', /内置动作位置固定，不可拖动/.test(panel));
  /* ↑↓ 按钮同样受限：两条路规则必须一致，否则按钮能造出"刷新就弹回"的状态 */
  t('上移受固定墙限制', /disabled=\{i === 0 \|\| \(i > 0 && !!list\[i - 1\]\.builtin\)\}/.test(panel));
  t('下移受固定墙限制', /disabled=\{i === list\.length - 1 \|\| \(i < list\.length - 1 && !!list\[i \+ 1\]\.builtin\)\}/.test(panel));
  t('按钮灰掉时说明原因', /上一位是内置动作，位置固定/.test(panel));
  t('move 里也拦', /if \(crossedIsFixed\(list, i, delta\)\) return;/.test(panel));
  /* 下界用"最后一个内置项+1"而不是"内置项个数"：顺序被打乱时按个数算会挤错 */
  t('下界按最后内置项算', /if \(l\[k\]\) last = k;/.test(panel));
}
