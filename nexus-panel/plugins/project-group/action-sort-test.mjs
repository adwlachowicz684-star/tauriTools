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
  t('用 gapIndexAt（纵向半区）', /gapIndexAt\(\{ top: r\.top, height: r\.height \}/.test(panel));
}

console.log('\n=== 2. 落点判定不能用 offsetY ===');
{
  /* 项里有 <span>（"自定义"徽标），指针落在它上面时 offsetY 会跳变 */
  t('用 getBoundingClientRect', /e\.currentTarget\.getBoundingClientRect\(\)/.test(panel));
  t('没用 offsetY', !/offsetY/.test(panel));
  t('半区判定走内核', /gapIndexAt\(/.test(panel));
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
  t('落点相同就返回原数组', /if \(to === from\) return l;/.test(panel));
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
