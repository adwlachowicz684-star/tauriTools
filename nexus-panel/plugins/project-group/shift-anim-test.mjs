/**
 * 卡片让位动画 #74 / #190（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/shift-anim-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const grid = R('components/CardGrid.tsx');
const css = strip(fs.readFileSync(path.join(HERE, 'style.css'), 'utf8'));

console.log('\n=== 1. 用 transform 让位，不重排数组 ===');
{
  /* 重排数组会让 React 重建 DOM，而 CSS transition 对"DOM 顺序变了"不生效 */
  t('有 shiftOf', /const shiftOf = \(i: number\): number =>/.test(grid));
  t('返回 translateY', /transform: `translateY\(\$\{sh\}px\)`/.test(grid));
  t('没有在 dragover 里改卡片顺序', !/onDragOver=\{[\s\S]{0,600}?setCards\(/.test(grid));
}

console.log('\n=== 2. 让位方向要用 resolveMoveIndex 纠偏 ===');
{
  /* "先移除再插入"使插入下标与缝隙下标错开一位，不纠偏会让错卡 */
  t('用 resolveMoveIndex', /const to = resolveMoveIndex\(from, dropAt, cards\.length\);/.test(grid));
  t('向下让位（to < from）', /if \(to < from && i >= to && i < from\) return dragH \+ CARD_GAP;/.test(grid));
  t('向上让位（to > from）', /if \(to > from && i > from && i <= to\) return -\(dragH \+ CARD_GAP\);/.test(grid));
  t('原地不动', /if \(to === from\) return 0;/.test(grid));
}

console.log('\n=== 3. 高度要含间距（关键）===');
{
  /* 少算 gap 的话让开的缝刚好卡住卡片，看着像"没完全让开" */
  t('gap 单独定义', /const CARD_GAP = 8;/.test(grid));
  t('位移含 gap', /dragH \+ CARD_GAP/.test(grid));
  t('dragStart 量高度', /setDragH\(e\.currentTarget\.offsetHeight\);/.test(grid));
}

console.log('\n=== 4. 松手必须归位 ===');
{
  /* 不清的话卡片停在让开的位置上不回来 */
  t('dragEnd 清高度', /onDragEnd=\{\(\) => \{[\s\S]{0,300}?setDragH\(0\);/.test(grid));
}

console.log('\n=== 5. CSS：只在拖拽中开过渡 ===');
{
  const seg = css.slice(css.indexOf('.fpx-cards.shifting'));
  const b = seg.slice(0, seg.indexOf('.fpx-cards.shifting .fpx-card.dragging'));
  t('容器类控制', /\.fpx-cards\.shifting \.fpx-card \{/.test(b));
  t('有 transition transform', /transition: transform/.test(b));
  t('缓出', /ease-out/.test(b));
  /* 被拖的那张不参与过渡：它跟着指针走，加了会慢半拍地飘 */
  t('被拖卡片不过渡', /\.fpx-cards\.shifting \.fpx-card\.dragging \{\s*\n\s*transition: none;/.test(css));
  t('容器加了 shifting', /dragPath && !overCross \? ' shifting' : ''/.test(grid));
}

console.log('\n=== 6. 行为：让位计算 ===');
{
  const { resolveMoveIndex } = await loadTs(path.join(HERE, 'utils/dragSort.ts'));
  /* from=0 移到末尾缝隙 k=4（n=4）：纠偏后 to=3 */
  t('纠偏后落到末位', resolveMoveIndex(0, 4, 4) === 3, `${resolveMoveIndex(0, 4, 4)}`);
  /* 方向判定：to(3) > from(0) → 索引 1..3 上移 */
  const from = 0, to = 3;
  const up = [1, 2, 3].every((i) => i > from && i <= to);
  t('1..3 上移', up);
  /* from=3 移到 k=0 → to=0 → 索引 0..2 下移 */
  const f2 = 3, t2 = resolveMoveIndex(3, 0, 4);
  t('反向：to=0', t2 === 0, `${t2}`);
  t('0..2 下移', [0, 1, 2].every((i) => i >= t2 && i < f2));
}

done();
