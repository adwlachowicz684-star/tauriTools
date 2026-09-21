/**
 * #75 死区滞后换位（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/deadzone-swap-test.mjs
 *
 * 为什么值得单测：这是"拖着不动时界面不该乱跳"的那一类问题 ——
 * 手抖一两个像素落点就跳，用户会以为界面坏了，而且不敢再拖。
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
const stack = R('components/StackedGroups.tsx');

console.log('\n=== 1. 内核：死区内保持原位 ===');
{
  const { swapIndexWithDeadZone, deadZone } = await loadTs(path.join(HERE, 'utils/dragSort.ts'));
  /* 三框，各高 100，中心 50 / 150 / 250；死区 = min(8, 100*0.2) = 8 */
  const centers = [50, 150, 250];
  const sizes = [100, 100, 100];

  t('死区取固定值与 20% 的较小值', deadZone(100) === 8);
  /* 矮元素：20% 更小，取它 —— 否则矮框的触发点会被推进邻框内部 */
  t('矮元素取 20%', deadZone(20) === 4);

  /* 从 0 往下拖 */
  t('未越过中心+死区：不动', swapIndexWithDeadZone(155, centers, sizes, 0) === 0);
  t('越过中心+死区：换到 1', swapIndexWithDeadZone(160, centers, sizes, 0) === 1);
  /* 一次跨多框：快速甩动也追得上，不会只换一格 */
  t('一次跨两框', swapIndexWithDeadZone(300, centers, sizes, 0) === 2);

  /* 从 2 往上拖 */
  t('向上死区内：不动', swapIndexWithDeadZone(145, centers, sizes, 2) === 2);
  t('向上越过死区：换到 1', swapIndexWithDeadZone(140, centers, sizes, 2) === 1);
  t('向上一跨两框', swapIndexWithDeadZone(10, centers, sizes, 2) === 0);

  /* 越界下标不崩 */
  t('from 越界返回原值', swapIndexWithDeadZone(10, centers, sizes, 9) === 9);
  t('from 为负返回原值', swapIndexWithDeadZone(10, centers, sizes, -1) === -1);
  /*
   * 高矮不一：矮框（高 20）中心在 10，死区取 20% = 4 → 判定点 y < 6。
   * 这正是"取 20% 而不是固定 8"的意义：若取固定 8，判定点是 y < 2，
   * 指针要几乎跑到框外才换位，矮框根本拖不动。
   * 用 y=5 区分这两种取法（取 8 时 5 不换位，取 4 时换位）。
   */
  const mixed = [10, 200];
  const msizes = [20, 380];
  t('矮框取 20% 死区：y=5 即换', swapIndexWithDeadZone(5, mixed, msizes, 1) === 0);
  t('矮框在死区内仍不动', swapIndexWithDeadZone(8, mixed, msizes, 1) === 1);
}

console.log('\n=== 2. 接入：分类框重排用死区算落点 ===');
{
  t('导入了内核', /import \{ swapIndexWithDeadZone \} from '\.\.\/utils\/dragSort';/.test(stack));
  t('有 boxRefs 收集尺寸', /boxRefs\.current\[i\] = el/.test(stack));
  t('dragover 里调用它', /setOverIdx\(rects\.length === tabs\.length\s*\n\s*\? swapIndexWithDeadZone\(/.test(stack));
  t('传入指针位置', /swapIndexWithDeadZone\(\s*\n?\s*e\.clientY,/.test(stack));
  t('传入中心数组', /rects\.map\(\(r\) => r\.top \+ r\.height \/ 2\)/.test(stack));
  t('传入尺寸数组', /rects\.map\(\(r\) => r\.height\)/.test(stack));
  /* 量不到时退回"悬停即落点"，不能变成拖了没反应 */
  t('量不到时回退', /rects\.length === tabs\.length\s*\n\s*\? swapIndexWithDeadZone\([\s\S]{0,220}?: i\)/.test(stack));
}

console.log('\n=== 3. 落点取死区结果，不是悬停项 ===');
{
  /* 先取 overIdx 再清状态：清早了就拿不到落点了 */
  t('drop 取 overIdx', /const to = overIdx;/.test(stack));
  t('drop 用它做落点', /onMoveTab\(from, to\);/.test(stack));
  /* 原地放下 = 无操作，且要回弹（不 preventDefault） */
  t('原地放下不落', /if \(to < 0 \|\| to === from\) return;/.test(stack));
  t('回弹后才 preventDefault', /if \(to < 0 \|\| to === from\) return;\s*\n\s*e\.preventDefault\(\);/.test(stack));
  t('不再用悬停项 i', !/onMoveTab\(from, i\);/.test(stack));
}

done();
