import test from 'node:test';
import assert from 'node:assert/strict';
import { planStackReflow, measureHeights } from '../engine/stack';

/**
 * 改「显示高度」后，下方嵌合的块要自动跟上。
 *
 * ================= 起因 ====================
 *
 * 嵌合位置是**落位那一刻**按当时高度算出来的绝对值。
 * 之后把某块从中号改成高号，它长高了，下面挂着的还停在原来的 y ——
 * 串在显示上裂开（或叠在一起），而 stackParent 关系还在。
 *
 * 用户改的是高度，不会想到还要去挪下面的块 ——
 * 这是"嵌合看着坏了"里最难自查的一种。
 */

type N = {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
  data?: Record<string, unknown>;
};

const H = 76;

function n(id: string, x: number, y: number, h: number, parent?: string): N {
  return {
    id, position: { x, y }, measured: { width: 240, height: h },
    data: parent ? { stackParent: parent } : {},
  };
}

function movesOf(nodes: N[], deltas: Map<string, number>) {
  return new Map(planStackReflow(nodes, deltas).map((m) => [m.id, m.position]));
}

test('中间那块长高 → 下方整串跟着下移', () => {
  /*
   * A → B → C。B 从中号(76) 改成高号(+40)。
   * B 自己不动（顶边钉在 A 底边），C 要下移 40。
   */
  const A = n('A', 0, 0, H);
  const B = n('B', 0, H, H + 40, 'A');
  const C = n('C', 0, H + H, H, 'B');
  const moves = movesOf([A, B, C], new Map([['B', 40]]));

  assert.equal(moves.has('A'), false, '长高的那块自己不动');
  assert.equal(moves.has('B'), false, '它的顶边钉在父节点底边上，不动');
  assert.deepEqual(moves.get('C'), { x: 0, y: H + H + 40 });
});

test('多级串：位移要累加', () => {
  /*
   * A → B → C → D。A 和 B 各自长高，
   * D 要挪的是两者的和（A 变 → 整串下移；B 变 → B 以下再下移）。
   */
  const A = n('A', 0, 0, H);
  const B = n('B', 0, 200, H, 'A');
  const C = n('C', 0, 300, H, 'B');
  const D = n('D', 0, 400, H, 'C');
  const moves = movesOf([A, B, C, D], new Map([['A', 20], ['B', 30]]));

  assert.equal(moves.has('A'), false, '自己长高，不动');
  assert.deepEqual(moves.get('B'), { x: 0, y: 220 }, '只受上级 A 影响');
  assert.deepEqual(moves.get('C'), { x: 0, y: 350 }, 'A + B = 50');
  assert.deepEqual(moves.get('D'), { x: 0, y: 450 }, '同样 50');
});

test('变矮同样要跟上（负位移）', () => {
  const A = n('A', 0, 0, H);
  const B = n('B', 0, H, H, 'A');
  const moves = movesOf([A, B], new Map([['A', -30]]));
  assert.deepEqual(moves.get('B'), { x: 0, y: H - 30 });
});

test('不补偿用户故意留的缝隙 —— 只补高度差', () => {
  /*
   * B 离 A 底边有 10px 的缝（用户自己摆的）。
   * A 长高 40 后，B 应该到 116（还留着那 10px），而不是被压成严丝合缝。
   * 重算贴合位置会把这 10px 抹掉 —— 那是偷偷改用户摆好的东西。
   */
  const A = n('A', 0, 0, H);
  const B = n('B', 0, H + 10, H, 'A');
  const moves = movesOf([A, B], new Map([['A', 40]]));
  assert.deepEqual(moves.get('B'), { x: 0, y: H + 10 + 40 });
});

test('没嵌合的节点不受影响', () => {
  const A = n('A', 0, 0, H);
  const X = n('X', 500, 0, H);   // 独立节点
  const moves = movesOf([A, X], new Map([['A', 40]]));
  assert.equal(moves.size, 0);
});

test('没有变化时不动（否则会死循环）', () => {
  const A = n('A', 0, 0, H);
  const B = n('B', 0, H, H, 'A');
  assert.equal(planStackReflow([A, B], new Map()).length, 0);
});

test('成环不会卡死', () => {
  const A = n('A', 0, 0, H, 'B');
  const B = n('B', 0, H, H, 'A');
  const out = planStackReflow([A, B], new Map([['A', 10]]));
  assert.ok(Array.isArray(out));
});

test('没测量过的高度不进快照 —— 否则会算出巨大位移', () => {
  /*
   * 第一次渲染时 measured 还没有，写进快照等于认为它高度是 0；
   * 下一帧量到真实高度就会算出 +76 的位移，整串跳一下。
   */
  const unmeasured = { id: 'U', position: { x: 0, y: 0 } } as N;
  const snap = measureHeights([unmeasured, n('A', 0, 0, H)]);
  assert.equal(snap.has('U'), false, '没测量过的不进快照');
  assert.equal(snap.get('A'), H);
});
