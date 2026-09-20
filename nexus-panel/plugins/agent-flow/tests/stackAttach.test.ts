import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planStackDrop, findStackChild, heightOf, widthOf, descendantsOf,
} from '../engine/stack';

/**
 * **反向**吸附：把节点拖到另一个节点**上方**时，那个节点要挂到自己下面。
 *
 * ================= 起因 ====================
 *
 * 以前只有 findSnapTarget（被拖节点顶边贴近目标底边），
 * 于是只有"把 A 拖到 B 下方"才嵌合；
 * 用户把 A 拖到 B **上方**时不生效 ——
 * 从他的视角看两块是上下贴着的，功能却像坏了。
 *
 * ================= 谁动（后补的一条） ====================
 *
 * 第一版做反了：把**对方**拖到被拖节点下面。
 * 用户拖 A 到 B 上方，看到的却是 B 跳到 A 下面 —— 动的是他没碰的那个。
 *
 * 嵌合的语义是"被拖的节点去靠别人"，所以现在移动的是**被拖节点自己**：
 * 它往上靠，贴到对方上边缘，对方原地不动、只改 stackParent。
 */

type N = {
  id: string;
  position: { x: number; y: number };
  measured?: { width?: number; height?: number };
  data?: Record<string, unknown>;
};

const W = 240;
const H = 76;

function n(id: string, x: number, y: number, parent?: string): N {
  return {
    id, position: { x, y }, measured: { width: W, height: H },
    data: parent ? { stackParent: parent } : {},
  };
}

/** 拖 A 到 B 正上方：A 底边离 B 顶边 GAP 以内 */
test('拖到别人上方 → 自己往上靠，对方不动', () => {
  const A = n('A', 0, 0);            // 被拖动：放在 y=0
  const B = n('B', 0, H + 10);       // 静止：顶边在 A 底边下方 10px
  const plan = planStackDrop([A, B], A, {
    oldParent: null, moved: true, exclude: new Set(['A']),
  });
  assert.ok(plan.attach, '应当反向吸附');
  assert.equal(plan.attach!.childId, 'B');
  assert.equal(plan.attach!.parentId, 'A');

  // 动的是 A：往下挪 10px，底边正好贴上 B 的顶边
  assert.deepEqual(plan.position, { x: 0, y: 10 });
  assert.equal(B.position.y, H + 10, 'B 原地不动');
  assert.equal(plan.attach!.moves?.length ?? 0, 0, '对方不产生位移');
});

test('反向吸附时串尾去贴对方 —— 不是被拖节点自己', () => {
  /*
   * A 下面挂着 C（A→C）。把 A 拖到 B 上方时，
   * 真正要贴到 B 上边缘的是 **C** 的底边。
   * 按 A 的底边算，C 会被压在 B 身上，两块叠在一起。
   */
  const A = n('A', 0, 0);
  const C = n('C', 0, H, 'A');        // 串尾：底边在 152
  const B = n('B', 0, H + H + 10);    // 顶边 162，离串尾底边 10px
  const plan = planStackDrop([A, C, B], A, {
    oldParent: null, moved: true, exclude: new Set(['A', 'C']),
  });
  assert.ok(plan.attach, '按串尾底边判定，应当吸上');
  assert.equal(plan.attach!.childId, 'B');
  assert.equal(plan.attach!.parentId, 'C', '挂到串尾下面，不是挂到 A 下面');

  assert.deepEqual(plan.position, { x: 0, y: 10 }, 'A 下移 10，让串尾贴上 B');
  const follow = new Map((plan.followers ?? []).map((m) => [m.id, m.position]));
  assert.deepEqual(follow.get('C'), { x: 0, y: H + 10 }, 'C 跟着平移');
  assert.equal(H + 10 + H, B.position.y, '串尾底边与 B 顶边相接');
});

test('反向吸附时被拖节点的整串跟着平移 —— 少了会散', () => {
  /*
   * A 下面挂着 C。只挪 A 的话 C 留在原地，中间空一大截，
   * 看着像串散了而关系还在。
   */
  const A = n('A', 0, 0);
  const C = n('C', 0, H, 'A');
  const D = n('D', 0, H * 2, 'C');         // 串尾：底边 228
  const B = n('B', 0, H * 3 + 10);         // 顶边 238，离串尾底边 10px
  const plan = planStackDrop([A, C, D, B], A, {
    oldParent: null, moved: true, exclude: new Set(['A', 'C', 'D']),
  });
  assert.ok(plan.attach);
  assert.equal(plan.attach!.parentId, 'D', '挂在串尾 D 下面');
  const follow = new Map((plan.followers ?? []).map((m) => [m.id, m.position]));
  assert.equal(follow.size, 2, 'C、D 都要跟着动');
  assert.deepEqual(plan.position, { x: 0, y: 10 });
  assert.deepEqual(follow.get('C'), { x: 0, y: H + 10 });
  assert.deepEqual(follow.get('D'), { x: 0, y: H * 2 + 10 });
  assert.equal(H * 3 + 10, B.position.y, '串尾底边贴上 B 顶边');
});

test('已经挂在自己下面的不重挂', () => {
  const A = n('A', 0, 0);
  const B = n('B', 0, H, 'A');   // 已经是 A 的下级
  const plan = planStackDrop([A, B], A, {
    oldParent: null, moved: true, exclude: new Set(['A']),
  });
  assert.ok(!plan.attach, '已经是自己的下级就不必再挂一次');
});

test('没拖动时不触发反向吸附', () => {
  /*
   * 没拖动时节点还在原位，下方本来就紧邻着自己的下级。
   * 此时若触发，会把已挂好的节点重新挂一次，位置和关系莫名被改。
   */
  const A = n('A', 0, 0);
  const B = n('B', 0, H + 5);
  const plan = planStackDrop([A, B], A, {
    oldParent: null, moved: false, exclude: new Set(['A']),
  });
  assert.ok(!plan.attach);
});

test('祖先不能被挂到下面 —— 会成环', () => {
  /*
   * A 挂在 P 下面（P 是 A 的祖先）。
   * 把 A 拖到 P 上方时若把 P 挂到 A 下 → P→A→P 成环，
   * 引擎会拒绝执行**整张图**，而用户看不出是哪一块造成的。
   */
  const P = n('P', 0, 0);
  const A = n('A', 0, H, 'P');
  // A 拖到 P 上方
  const moved = { ...A, position: { x: 0, y: -H - 5 } };
  const hit = findStackChild([P, moved], moved, new Set(['A']));
  assert.equal(hit, null, '祖先不能作为反向吸附的目标');
});

test('串中间的一环不能被挂走 —— 会把原串拆断', () => {
  /*
   * B 有上级 P。把 B 挪到 A 下面，原串就断了：
   * P 没了下级、B 的下级没了上级，而两截都还在画布上。
   */
  const A = n('A', 1000, 0);
  const P = n('P', 1000, 200);
  const B = n('B', 1000, 200 + H + 5, 'P');
  const hit = findStackChild([A, P, B], A, new Set(['A']));
  assert.equal(hit, null, '有上级的节点不该被反向挂走');
});

test('下方命中优先于上方命中', () => {
  /*
   * 上下都有节点时，优先"自己嵌到下面那个" ——
   * 那是原有行为，不该被反向吸附抢掉。
   */
  /*
   * 几何上两者可以同时命中：
   *   B 在 A **上方**（B 底边贴近 A 顶边）→ 正向：A 嵌到 B 下
   *   C 在 A **下方**（C 顶边贴近 A 底边）→ 反向：C 挂到 A 下
   * 同时命中时取正向 —— 那是原有行为，不该被反向抢掉。
   */
  const B = n('B', 0, 0);                 // B 底边 = 76
  const A = n('A', 0, H + 5);             // 顶边 81，离 B 底边 5px
  const C = n('C', 0, H + 5 + H + 5);     // 顶边 162，离 A 底边(157) 5px
  const plan = planStackDrop([C, A, B], A, {
    oldParent: null, moved: true, exclude: new Set(['A']),
  });
  assert.equal(plan.stackParent, 'B', '应当优先嵌到上方节点下面（正向）');
  assert.ok(!plan.attach, '同时命中时不该再反向吸附');
});

test('横向没重叠时不反向吸附', () => {
  const A = n('A', 0, 0);
  const B = n('B', 300, H + 5);   // 完全错开
  const hit = findStackChild([A, B], A, new Set(['A']));
  assert.equal(hit, null);
});

test('超出容差不反向吸附', () => {
  const A = n('A', 0, 0);
  const B = n('B', 0, H + 200);
  const hit = findStackChild([A, B], A, new Set(['A']));
  assert.equal(hit, null);
});

test('descendantsOf 与平移范围一致', () => {
  const A = n('A', 0, 0);
  const B = n('B', 0, 100);
  const C = n('C', 0, 200, 'B');
  const D = n('D', 0, 300, 'C');
  assert.deepEqual(descendantsOf([A, B, C, D], 'B'), ['C', 'D']);
  assert.equal(heightOf(A), H);
  assert.equal(widthOf(A), W);
});
