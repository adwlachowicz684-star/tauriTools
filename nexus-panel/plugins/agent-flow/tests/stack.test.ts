import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parentIdOf, stackParentOf, childrenOf, descendantsOf, chainTopOf, chainOf,
  stackEdges, findSnapTarget, movedEnough, chainOutputAbove, inputValueFor,
  heightOf, SNAP_TOLERANCE, stackParentIds, hasStackChild,
} from '../engine/stack';

/**
 * Scratch 式嵌合。
 *
 * 重点是三件事：关系只有一处真相、不能成环、输出传递的语义。
 */

type N = { id: string; position: { x: number; y: number }; measured?: { height: number }; data?: Record<string, unknown> };

/** 造一条 A → B → C 的竖串（B 嵌于 A，C 嵌于 B） */
function chain(): N[] {
  return [
    { id: 'A', position: { x: 0, y: 0 }, measured: { height: 80 }, data: {} },
    { id: 'B', position: { x: 0, y: 80 }, measured: { height: 80 }, data: { stackParent: 'A' } },
    { id: 'C', position: { x: 0, y: 160 }, measured: { height: 80 }, data: { stackParent: 'B' } },
  ];
}

/* ---------------- 关系 ---------------- */

test('parentIdOf：缺省与空串都算没嵌合', () => {
  assert.equal(parentIdOf({ id: 'x' } as N), null);
  assert.equal(parentIdOf({ id: 'x', data: { stackParent: '' } } as N), null);
  assert.equal(parentIdOf({ id: 'x', data: { stackParent: 'A' } } as N), 'A');
});

test('stackParentOf 不需要坐标（卡片组件只有 data）', () => {
  assert.equal(stackParentOf({ data: { stackParent: 'A' } }), 'A');
  assert.equal(stackParentOf({}), null);
});

test('descendantsOf 取到全部下级', () => {
  assert.deepEqual(descendantsOf(chain(), 'A'), ['B', 'C']);
  assert.deepEqual(descendantsOf(chain(), 'B'), ['C']);
  assert.deepEqual(descendantsOf(chain(), 'C'), []);
});

test('descendantsOf 遇到环不会死循环', () => {
  const cyc: N[] = [
    { id: 'A', position: { x: 0, y: 0 }, data: { stackParent: 'B' } },
    { id: 'B', position: { x: 0, y: 0 }, data: { stackParent: 'A' } },
  ];
  assert.doesNotThrow(() => descendantsOf(cyc, 'A'));
});

test('chainTopOf 一直找到顶', () => {
  assert.equal(chainTopOf(chain(), 'C'), 'A');
  assert.equal(chainTopOf(chain(), 'A'), 'A');
});

test('chainOf 返回完整串（顶到底）', () => {
  assert.deepEqual(chainOf(chain(), 'B'), ['A', 'B', 'C']);
});

test('childrenOf 支持一个下面挂多块', () => {
  const ns: N[] = [
    { id: 'A', position: { x: 0, y: 0 }, data: {} },
    { id: 'B', position: { x: 0, y: 0 }, data: { stackParent: 'A' } },
    { id: 'C', position: { x: 0, y: 0 }, data: { stackParent: 'A' } },
  ];
  assert.deepEqual(childrenOf(ns, 'A').sort(), ['B', 'C']);
});

/* ---------------- 虚拟边 ---------------- */

test('stackEdges 生成父→子的边', () => {
  const es = stackEdges(chain());
  assert.equal(es.length, 2);
  assert.deepEqual(es[0], { id: 'stack:A->B', source: 'A', target: 'B' });
});

/**
 * 关键：父节点被删掉后，这条关系要丢弃。
 * 否则引擎会引用一个不存在的 id —— 拓扑排序直接拿不到它，
 * 表现为"这个节点莫名不执行"，很难查。
 */
test('stackEdges 丢弃父节点已不存在的关系', () => {
  const orphan: N[] = [{ id: 'B', position: { x: 0, y: 0 }, data: { stackParent: '已删除的A' } }];
  assert.deepEqual(stackEdges(orphan), []);
});

test('stackEdges 不产生自环', () => {
  const self: N[] = [{ id: 'A', position: { x: 0, y: 0 }, data: { stackParent: 'A' } }];
  assert.deepEqual(stackEdges(self), []);
});

/* ---------------- 吸附 ---------------- */

test('贴到目标下方就吸附', () => {
  const ns: N[] = [
    { id: 'A', position: { x: 0, y: 0 }, measured: { height: 80 }, data: {} },
    { id: 'B', position: { x: 0, y: 300 }, measured: { height: 80 }, data: {} },
  ];
  // 把 B 拖到 A 正下方（A 底边 80）
  const dragged = { id: 'B', position: { x: 0, y: 84 }, measured: { height: 80 }, data: {} };
  const hit = findSnapTarget(ns, dragged, new Set(['B']));
  assert.ok(hit, '应当吸附');
  assert.equal(hit!.parentId, 'A');
  assert.equal(hit!.y, 80, '贴合到底边');
  assert.equal(hit!.x, 0, '左对齐');
});

test('水平不重叠就不吸附', () => {
  const ns: N[] = [{ id: 'A', position: { x: 0, y: 0 }, measured: { height: 80 }, data: {} }];
  const dragged = { id: 'B', position: { x: 500, y: 82 }, measured: { height: 80 }, data: {} };
  assert.equal(findSnapTarget(ns, dragged, new Set(['B'])), null);
});

test('离得太远不吸附', () => {
  const ns: N[] = [{ id: 'A', position: { x: 0, y: 0 }, measured: { height: 80 }, data: {} }];
  const dragged = { id: 'B', position: { x: 0, y: 80 + SNAP_TOLERANCE + 40 }, measured: { height: 80 }, data: {} };
  assert.equal(findSnapTarget(ns, dragged, new Set(['B'])), null);
});

/**
 * 这条守一个会让整张图跑不起来的问题：
 * 把 A 拖到自己的下级下面会成环，引擎的环检测会直接拒绝执行整张图，
 * 而用户完全不知道为什么。所以后代必须排除在候选之外。
 */
test('不会吸附到自己的后代（防成环）', () => {
  const ns = chain();
  // 把 A 拖到 C（它的后代）下方
  const dragged = { id: 'A', position: { x: 0, y: 244 }, measured: { height: 80 }, data: {} };
  const hit = findSnapTarget(ns, dragged, new Set(['A', 'B', 'C']));
  assert.equal(hit, null);
});

test('measured 缺失时用默认高度，不崩', () => {
  const ns: N[] = [{ id: 'A', position: { x: 0, y: 0 }, data: {} }];
  assert.equal(heightOf(ns[0]), 76);
  const dragged = { id: 'B', position: { x: 0, y: 78 }, data: {} };
  assert.ok(findSnapTarget(ns, dragged, new Set(['B'])));
});

test('movedEnough：小幅移动不算拖动', () => {
  assert.equal(movedEnough({ x: 0, y: 0 }, { x: 2, y: 1 }), false);
  assert.equal(movedEnough({ x: 0, y: 0 }, { x: 60, y: 0 }), true);
});

/* ---------------- 输出传递 ---------------- */

test('chainOutputAbove：串上之前的输出按顺序拼接', () => {
  const ns = chain();
  const out = { A: 'aa', B: 'bb', C: 'cc' };
  assert.equal(chainOutputAbove(ns, 'B', out), 'aa');
  assert.equal(chainOutputAbove(ns, 'C', out), 'aa\nbb');
});

test('chainOutputAbove：串顶没有上文', () => {
  assert.equal(chainOutputAbove(chain(), 'A', { A: 'x' }), '');
});

test('chainOutputAbove：跳过空输出', () => {
  assert.equal(chainOutputAbove(chain(), 'C', { A: '', B: 'bb' }), 'bb');
});

/**
 * {{input}} 的语义 —— 用户选的是"直接上方为主"：
 * 嵌合时取直接上方的输出，未嵌合时回落到工作流全局输入。
 * 回落很重要，老画布不会因为这次改动而行为突变。
 */
test('inputValueFor：嵌合时取直接上方', () => {
  assert.equal(inputValueFor(chain(), 'B', { A: 'aa' }, '全局'), 'aa');
});

test('inputValueFor：未嵌合时用全局输入', () => {
  assert.equal(inputValueFor(chain(), 'A', { A: 'aa' }, '全局'), '全局');
});

test('inputValueFor：上方还没产出时回落到全局', () => {
  assert.equal(inputValueFor(chain(), 'B', {}, '全局'), '全局');
});

test('inputValueFor：上方节点已删除时回落，不报错', () => {
  const orphan: N[] = [{ id: 'B', position: { x: 0, y: 0 }, data: { stackParent: '没了' } }];
  assert.equal(inputValueFor(orphan, 'B', {}, '全局'), '全局');
});


/* ---------------- 直筒观感需要的"下面有没有块" ---------------- */

/*
 * .is-stacked（压掉上圆角）光看自己就够 —— stackParent 写在自己身上。
 * .is-stack-top（压掉下圆角）必须知道**下面有没有块**，
 * 而那要扫全图。缺了它，嵌合的两块之间会留一个圆角缺口，不是直筒。
 */

test('stackParentIds 找出所有下面挂着块的节点', () => {
  const ns = chain(); // A → B → C
  const ids = stackParentIds(ns);
  // A 下面挂着 B，B 下面挂着 C；C 下面没有
  assert.deepEqual(ids.slice().sort(), ['A', 'B']);
});

test('父被删掉的脏关系不算', () => {
  const ns: N[] = [
    { id: 'A', position: { x: 0, y: 0 }, data: {} },
    // B 声称嵌在已被删掉的 X 上
    { id: 'B', position: { x: 0, y: 90 }, data: { stackParent: 'X' } },
  ];
  assert.deepEqual(stackParentIds(ns), []);
});

test('自环不算', () => {
  const ns: N[] = [{ id: 'A', position: { x: 0, y: 0 }, data: { stackParent: 'A' } }];
  assert.deepEqual(stackParentIds(ns), []);
});

test('hasStackChild 只看直接下级', () => {
  const ns = chain(); // A → B → C
  assert.equal(hasStackChild(ns, 'A'), true);
  assert.equal(hasStackChild(ns, 'B'), true);
  assert.equal(hasStackChild(ns, 'C'), false);
});

test('同一父下挂多块只算一次', () => {
  const ns: N[] = [
    { id: 'A', position: { x: 0, y: 0 }, data: {} },
    { id: 'B', position: { x: 0, y: 90 }, data: { stackParent: 'A' } },
    { id: 'C', position: { x: 0, y: 180 }, data: { stackParent: 'A' } },
  ];
  assert.deepEqual(stackParentIds(ns), ['A']);
});
