import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTask } from '../engine/tasks';
import { layoutTaskFlow, flowStatusOf, flowSummary } from '../engine/taskFlow';

/**
 * 任务流程图。
 *
 * ================= 为什么要有图 ====================
 *
 * 详细列表能回答"这一步输出了什么"，
 * 但"卡在哪儿了"必须看图 —— 一列平铺的文本
 * 看不出谁在等谁，也就分不出「等待」和「阻断」。
 */

const T0 = 1_700_000_000_000;

function task(opts: {
  order?: string[];
  edges?: { source: string; target: string }[];
  labels?: Record<string, string>;
  nodes?: Record<string, { status: string }>;
  status?: string;
} = {}) {
  const t = makeTask({
    canvasId: 'c', canvasName: '流程', now: T0,
    labels: opts.labels, edges: opts.edges,
  }) as ReturnType<typeof makeTask> & {
    order: string[]; status: string;
    nodes: Record<string, { id: string; status: string }>;
  };
  t.order = opts.order ?? [];
  t.status = opts.status ?? 'running';
  t.nodes = {};
  for (const [id, v] of Object.entries(opts.nodes ?? {})) {
    t.nodes[id] = { id, status: v.status, output: '', error: '' };
  }
  return t;
}

test('四种状态各自认得出来', () => {
  const t = task({
    order: ['a', 'b'],
    nodes: { a: { status: 'success' }, b: { status: 'running' } },
  });
  assert.equal(flowStatusOf(t, 'a'), 'done');
  assert.equal(flowStatusOf(t, 'b'), 'running');
  assert.equal(flowStatusOf(t, 'c'), 'waiting', '没轮到的 = 等待');
});

/**
 * 这条最关键：上游失败、下游**还没被调度**时，
 * 下游自己的 status 根本不存在（不是 failed）。
 * 只看自己就会显示成"等待" —— 而实际是被掐断了。
 */
test('上游失败 → 下游判阻断，不是等待', () => {
  const t = task({
    order: ['a', 'b'],
    edges: [{ source: 'a', target: 'b' }],
    nodes: { a: { status: 'failed' } },
  });
  assert.equal(flowStatusOf(t, 'b'), 'blocked');
});

test('用户主动关掉的节点不算阻断', () => {
  const t = task({
    order: ['a', 'b'],
    edges: [{ source: 'a', target: 'b' }],
    nodes: { a: { status: 'success' }, b: { status: 'skipped' } },
  });
  assert.equal(flowStatusOf(t, 'b'), 'done', '上游没断，跳过 = 正常略过');
});

test('分层：同一列表示可以并行', () => {
  const t = task({
    order: ['a', 'b', 'c'],
    edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }],
    labels: { a: '第一步', b: '左', c: '右' },
  });
  const { boxes, cols } = layoutTaskFlow(t);
  assert.equal(cols, 2);
  assert.equal(boxes.find((b) => b.id === 'a')?.col, 0);
  assert.equal(boxes.find((b) => b.id === 'b')?.col, 1);
  assert.equal(boxes.find((b) => b.id === 'c')?.col, 1);
});

test('标题优先于 id —— 图上写乱码等于没写', () => {
  const t = task({
    order: ['mamu7obyv93'],
    labels: { mamu7obyv93: '数学运算' },
  });
  assert.equal(layoutTaskFlow(t).boxes[0].label, '数学运算');
});

test('没有标题就退回 id（老记录没有 labels）', () => {
  const t = task({ order: ['abc'] });
  assert.equal(layoutTaskFlow(t).boxes[0].label, 'abc');
});

test('孤立节点也要画出来 —— 它可能是没配好的那一步', () => {
  const t = task({ order: ['a', 'lonely'], edges: [] });
  assert.equal(layoutTaskFlow(t).boxes.length, 2);
});

test('成环不会丢节点也不会卡死', () => {
  const t = task({
    order: ['a', 'b'],
    edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'a' }],
  });
  const { boxes } = layoutTaskFlow(t);
  assert.equal(boxes.length, 2, '成环时 topoLayers 会丢节点，必须补回来');
});

test('汇总各状态计数', () => {
  const t = task({
    order: ['a', 'b', 'c'],
    nodes: { a: { status: 'success' }, b: { status: 'running' } },
  });
  const sum = flowSummary(layoutTaskFlow(t).boxes);
  assert.equal(sum.done, 1);
  assert.equal(sum.running, 1);
  assert.equal(sum.waiting, 1);
  assert.equal(sum.blocked, 0);
});

/* ------------------------------------------------------------------ */
/* 定位错误                                                            */
/* ------------------------------------------------------------------ */

import { errorNodesOf } from '../engine/taskFlow';

test('定位列表按执行顺序，不是按类型', () => {
  const t = task({
    order: ['a', 'b', 'c'],
    edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'c' }],
    nodes: { a: { status: 'failed' } },
  });
  assert.deepEqual(errorNodesOf(t), ['a', 'b', 'c'], '失败的自己也该能被定位');
});

test('被上游掐断的 skipped 也要能被定位 —— 那才是根因附近', () => {
  const t = task({
    order: ['a', 'b'],
    edges: [{ source: 'a', target: 'b' }],
    nodes: { a: { status: 'failed' }, b: { status: 'skipped' } },
  });
  assert.deepEqual(errorNodesOf(t), ['a', 'b']);
});

test('用户主动关掉的节点不算错误 —— 不该被定位到', () => {
  const t = task({
    order: ['a', 'b'],
    edges: [{ source: 'a', target: 'b' }],
    nodes: { a: { status: 'success' }, b: { status: 'skipped' } },
  });
  assert.deepEqual(errorNodesOf(t), []);
});

test('没有错误时是空列表（按钮据此置灰）', () => {
  const t = task({
    order: ['a'],
    nodes: { a: { status: 'success' } },
  });
  assert.deepEqual(errorNodesOf(t), []);
});

test('没跑到的节点不算错误 —— 那是等待，不是阻断', () => {
  const t = task({ order: ['a', 'b'], edges: [{ source: 'a', target: 'b' }] });
  assert.deepEqual(errorNodesOf(t), []);
});

/* ------------------------------------------------------------------ */
/* 画布布局                                                            */
/* ------------------------------------------------------------------ */

import { linkEndsOf, linkPathOf, layersOf } from '../engine/taskFlow';

function posedTask(opts: {
  order: string[];
  edges?: { source: string; target: string }[];
  positions?: Record<string, { x: number; y: number }>;
}) {
  const t = task({ order: opts.order, edges: opts.edges }) as ReturnType<typeof task> & {
    positions?: Record<string, { x: number; y: number }>;
  };
  t.positions = opts.positions;
  return t;
}

test('有坐标就按画布摆', () => {
  const t = posedTask({
    order: ['a', 'b'],
    edges: [{ source: 'a', target: 'b' }],
    positions: { a: { x: 0, y: 0 }, b: { x: 400, y: 120 } },
  });
  const r = layoutTaskFlow(t);
  assert.equal(r.mode, 'canvas');
  assert.equal(r.boxes.find((b) => b.id === 'b')?.x, 400);
  assert.ok(r.bounds && r.bounds.w > 0, '要有包围盒给 SVG 定视口');
});

/**
 * 只要**有一个**节点缺坐标就整张退回分层。
 * 一半按坐标、一半按格子会画成两块互不相干的图。
 */
test('缺任何一个坐标都退回分层（不画到 0,0 叠成一团）', () => {
  const t = posedTask({
    order: ['a', 'b'],
    positions: { a: { x: 10, y: 10 } },
  });
  assert.equal(layoutTaskFlow(t).mode, 'layered');
});

test('老记录没有坐标 → 分层，不崩', () => {
  const t = task({ order: ['a', 'b'], edges: [{ source: 'a', target: 'b' }] });
  const r = layoutTaskFlow(t);
  assert.equal(r.mode, 'layered');
  assert.equal(r.boxes.length, 2);
});

test('连线端点在卡片边缘，不是中心', () => {
  const e = linkEndsOf({ x: 0, y: 0 }, { x: 400, y: 0 });
  assert.ok(e.x1 > 0, '出口在右边缘而不是中心');
  assert.ok(e.x2 < 400 + 200, '入口在左边缘');
});

test('往左连时端点也要跟着翻', () => {
  const e = linkEndsOf({ x: 400, y: 0 }, { x: 0, y: 0 });
  assert.equal(e.x1, 400, '出口换到左边');
  assert.equal(e.x2, 200, '入口换到右边');
});

test('连线路径是贝塞尔（有控制点）', () => {
  assert.match(linkPathOf(linkEndsOf({ x: 0, y: 0 }, { x: 400, y: 0 })), /^M .* C /);
});

test('列表按层分组，与流程图的列同源', () => {
  const t = task({
    order: ['a', 'b', 'c'],
    edges: [{ source: 'a', target: 'b' }, { source: 'a', target: 'c' }],
  });
  const groups = layersOf(t);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0][1], ['a']);
  assert.equal(groups[1][1].length, 2);
});

/* ================= 变量标注 ================= */
/*
 * 流程图上要标"这一步用的哪个变量"。
 *
 * 存的是**名字 + 摘要**，不是变量 id ——
 * 任务记录是历史，变量后来被删掉不该让这次运行的标注变空白。
 */
test('makeTask 收下变量快照；空的整个不存（不占空间）', () => {
  const withVars = makeTask({
    canvasId: 'c', canvasName: '流程', now: T0,
    vars: { a: [{ name: '主仓库', summary: 'acme/web' }] },
  });
  assert.deepEqual(withVars.vars, { a: [{ name: '主仓库', summary: 'acme/web' }] });

  const none = makeTask({ canvasId: 'c', canvasName: '流程', now: T0, vars: {} });
  assert.equal(none.vars, undefined);
});

test('流程图把变量挂到节点框上；没标的就是空数组而不是 undefined', () => {
  const t = task({ order: ['a', 'b'], labels: { a: '推代码', b: '发通知' } });
  t.vars = { a: [{ name: '主仓库', summary: 'acme/web' }] };
  const { boxes } = layoutTaskFlow(t);
  const a = boxes.find((b) => b.id === 'a');
  const b = boxes.find((b) => b.id === 'b');
  assert.deepEqual(a?.vars, [{ name: '主仓库', summary: 'acme/web' }]);
  assert.deepEqual(b?.vars, [], '没标的节点给空数组 —— 调用方不必到处判空');
});

test('变量被删了，老流程图上的标注还在（存名字不存 id 就是为了这个）', () => {
  const t = task({ order: ['a'] });
  t.vars = { a: [{ name: '主仓库', summary: 'acme/web' }] };
  const { boxes } = layoutTaskFlow(t);
  assert.equal(boxes[0].vars[0].name, '主仓库');
  assert.equal(boxes[0].vars[0].summary, 'acme/web');
});
