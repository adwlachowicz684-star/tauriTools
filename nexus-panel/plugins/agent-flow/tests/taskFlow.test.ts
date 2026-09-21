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
