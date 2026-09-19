import test from 'node:test';
import assert from 'node:assert/strict';
import { planStackDrop, snapPosOf, SNAP_TOLERANCE } from '../engine/stack';

/**
 * 松手后的落位。
 *
 * 起因：嵌合后只挪动一点点（不到脱开阈值 26px），
 * 结果**既不解除嵌合、也不回到嵌合位置** —— 节点停在偏移处，
 * 关系还在却看着歪的。
 *
 * 原因是判定写成 `hit && hit.parentId !== oldParent`：
 * 没拖开时命中的还是原来那个父，条件不成立，于是两个分支都不走。
 * 用户挪一点点显然不是想解开，而是想让它归位。
 */

const N = (
  id: string, x: number, y: number, h = 76, w = 200, stackParent?: string,
) => ({
  id, position: { x, y }, measured: { width: w, height: h },
  data: stackParent ? { stackParent } : {},
});

/** 父在 (100,100) 高 76 → 子该在 (100,176) */
const P = N('p', 100, 100);

test('嵌合后只挪一点点 → 归位，不是留在偏移处', () => {
  // 子被拖到 (108, 184)：x 偏 8、y 偏 8，都在 26 以内
  const dragged = N('c', 108, 184, 76, 200, 'p');
  const plan = planStackDrop([P, dragged], dragged, {
    oldParent: 'p', moved: false, exclude: new Set(['c']),
  });
  assert.deepEqual(plan.position, { x: 100, y: 176 }, '要回到贴合位置');
  assert.equal(plan.stackParent, 'p', '关系保持');
});

test('归位与吸附给出同一个位置（两处各算一次会不一致）', () => {
  const at = snapPosOf(P);
  const dragged = N('c', 104, 180, 76, 200, 'p');
  const plan = planStackDrop([P, dragged], dragged, {
    oldParent: 'p', moved: false, exclude: new Set(['c']),
  });
  assert.deepEqual(plan.position, at);
});

test('拖开足够远且没命中 → 解除，位置不动', () => {
  const dragged = N('c', 400, 400, 76, 200, 'p');
  const plan = planStackDrop([P, dragged], dragged, {
    oldParent: 'p', moved: true, exclude: new Set(['c']),
  });
  assert.equal(plan.stackParent, null, '要解除');
  assert.equal(plan.position, undefined, '主动拖走的不该被拽回去');
});

test('拖开后吸到别处 → 换父并贴合', () => {
  const other = N('q', 300, 300);
  const dragged = N('c', 300, 376, 76, 200, 'p');
  const plan = planStackDrop([P, other, dragged], dragged, {
    oldParent: 'p', moved: true, exclude: new Set(['c']),
  });
  assert.equal(plan.stackParent, 'q', '换成新父');
  assert.deepEqual(plan.position, { x: 300, y: 376 });
});

test('未嵌合时吸上别处 → 建立关系', () => {
  const dragged = N('c', 100, 178);
  const plan = planStackDrop([P, dragged], dragged, {
    oldParent: null, moved: true, exclude: new Set(['c']),
  });
  assert.equal(plan.stackParent, 'p');
  assert.deepEqual(plan.position, { x: 100, y: 176 });
});

test('未嵌合且没命中 → 什么都不动', () => {
  const dragged = N('c', 900, 900);
  const plan = planStackDrop([P, dragged], dragged, {
    oldParent: null, moved: true, exclude: new Set(['c']),
  });
  assert.deepEqual(plan, {});
});

test('没拖开但横向挪到重叠不够 → 仍归位（不该留在歪处）', () => {
  /*
   * 挪动 20px 不到脱开阈值，但窄节点可能因此重叠 < 50% 而命中不了。
   * 命中不了不代表要解除 —— 关系还在，就该归位。
   */
  const narrow = N('p2', 100, 100, 76, 60);
  const dragged = { ...N('c', 140, 110, 76, 60, 'p2') };
  const plan = planStackDrop([narrow, dragged], dragged, {
    oldParent: 'p2', moved: false, exclude: new Set(['c']),
  });
  assert.deepEqual(plan.position, { x: 100, y: 176 }, '重叠不够也要归位');
  assert.equal(plan.stackParent, undefined, '关系本来就是对的，不改');
});

test('父节点已被删除 → 不动（关系由别处清理）', () => {
  const dragged = N('c', 108, 184, 76, 200, 'gone');
  const plan = planStackDrop([dragged], dragged, {
    oldParent: 'gone', moved: false, exclude: new Set(['c']),
  });
  assert.equal(plan.position, undefined);
});

test('不能吸到自己的后代下面（会成环）', () => {
  const child = N('k', 100, 176, 76, 200, 'p');
  // p 被拖到 k 下方：k 是 p 的后代，要排除
  const dragged = { ...P, position: { x: 100, y: 252 } };
  const plan = planStackDrop([dragged, child], dragged, {
    oldParent: null, moved: true, exclude: new Set(['p', 'k']),
  });
  assert.notEqual(plan.stackParent, 'k');
});

test('归位用的是父的**当前**高度，不是缓存值', () => {
  const tall = N('p', 100, 100, 200);
  assert.deepEqual(snapPosOf(tall), { x: 100, y: 300 });
});

test('阈值内才算没拖开（26px 边界）', () => {
  const just = N('c', 100, 176 + SNAP_TOLERANCE - 1, 76, 200, 'p');
  const plan = planStackDrop([P, just], just, {
    oldParent: 'p', moved: false, exclude: new Set(['c']),
  });
  assert.deepEqual(plan.position, { x: 100, y: 176 });
});
