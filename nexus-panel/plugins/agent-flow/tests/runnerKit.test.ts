import test from 'node:test';
import assert from 'node:assert/strict';
import { withNodeRun, NodeFailError } from '../engine/runnerKit';
import { runGraph } from '../engine/runner';
import type { RunContext } from '../engine/runContext';

/**
 * withNodeRun 的直接测试。
 *
 * 它是 11 个执行器共用的包装器：管状态流转、失败传播、事件发送。
 * 此前只有 nodeFailure.test.ts 的几条用例间接覆盖 —— 改它影响面很大，
 * 值得有一组盯着它自身行为的用例。
 */

/** 造一个最小可用的 RunContext，并记录发生的一切 */
function makeCtx(id = 'n1') {
  const events: Array<Record<string, unknown>> = [];
  const statuses: string[] = [];
  const failed: string[] = [];
  const outputs: Record<string, string> = {};
  const nodeFields: Record<string, Record<string, string>> = {};
  const scope = {
    failedSet: new Set<string>(),
    branchOf: new Map<string, string>(),
    activeBranches: new Set<string>(),
  };

  const ctx = {
    id,
    node: { id, data: { kind: 'task' } },
    graph: { nodes: [{ id, data: { kind: 'task' } }], edges: [] },
    outputs,
    nodeFields,
    scope,
    opts: { concurrency: 1, executor: async () => 'x', onEvent: () => {} },
    emit: (e: Record<string, unknown>) => events.push(e),
    setStatus: (_id: string, s: string) => statuses.push(s),
    markFailed: (i: string) => {
      failed.push(i);
      scope.failedSet.add(i);
    },
    tpl: (s: string) => s,
  } as unknown as RunContext;

  return { ctx, events, statuses, failed, outputs, nodeFields, scope };
}

test('成功：状态 running→success，发 node-done ok:true', async () => {
  const { ctx, events, statuses, outputs } = makeCtx();
  await withNodeRun(ctx, async () => ({ output: '结果文本' }));
  assert.deepEqual(statuses, ['running', 'success']);
  const done = events.find((e) => e.type === 'node-done');
  assert.ok(done, '必须发 node-done');
  assert.equal(done.ok, true);
  assert.equal(done.output, '结果文本');
  assert.equal(outputs.n1, '结果文本');
});

test('失败（NodeFailError）：状态 failed、markFailed、node-done ok:false', async () => {
  const { ctx, events, statuses, failed, scope } = makeCtx();
  await withNodeRun(ctx, async () => {
    throw new NodeFailError('没配好');
  });
  assert.deepEqual(statuses, ['running', 'failed']);
  assert.deepEqual(failed, ['n1'], '必须 markFailed，否则下游不跳过');
  assert.equal(scope.failedSet.has('n1'), true);
  const done = events.find((e) => e.type === 'node-done');
  assert.equal(done.ok, false);
  assert.equal(done.error, '没配好');
});

test('普通异常也走同一条失败路径（不能因为没有 NodeFailError 就漏 markFailed）', async () => {
  const { ctx, statuses, failed } = makeCtx();
  await withNodeRun(ctx, async () => {
    throw new Error('意外崩溃');
  });
  assert.deepEqual(statuses, ['running', 'failed']);
  assert.deepEqual(failed, ['n1']);
});

test('NodeFailError 带 output：失败也要给下游一个值', async () => {
  const { ctx, outputs } = makeCtx();
  await withNodeRun(ctx, async () => {
    // 更新检测类节点失败时输出 'false'，下游条件判断才能走「无更新」分支
    throw new NodeFailError('抓取失败', 'false');
  });
  assert.equal(outputs.n1, 'false');
});

test('NodeFailError 带 fields：字段要写入并发出 node-fields 事件', async () => {
  const { ctx, events, nodeFields } = makeCtx();
  await withNodeRun(ctx, async () => {
    throw new NodeFailError('失败', '', { status: '500' });
  });
  assert.equal(nodeFields.n1.status, '500');
  assert.ok(events.some((e) => e.type === 'node-fields'), '要发 node-fields 通知 UI');
});

test('成功时带 fields：同样要发 node-fields', async () => {
  const { ctx, events, nodeFields } = makeCtx();
  await withNodeRun(ctx, async () => ({ output: 'x', fields: { status: '200' } }));
  assert.equal(nodeFields.n1.status, '200');
  assert.ok(events.some((e) => e.type === 'node-fields'));
});

test('warn 挂在 node-done 上但不算失败', async () => {
  const { ctx, events, statuses, failed } = makeCtx();
  await withNodeRun(ctx, async () => ({ output: 'x', warn: '解析有告警' }));
  const done = events.find((e) => e.type === 'node-done');
  assert.equal(done.ok, true);
  assert.equal(done.error, '解析有告警');
  assert.deepEqual(failed, [], 'warn 不该触发失败');
  assert.equal(statuses[1], 'success');
});

test('缺执行器：由能力声明统一拦截，报错写明缺什么', async () => {
  const { ctx, events, statuses } = makeCtx();
  // kind: 'fs' 需要 fsExecutor，这里没给
  (ctx.node as { data: Record<string, unknown> }).data = { kind: 'fs' };
  await withNodeRun(ctx, async () => ({ output: '不该执行到' }));
  assert.equal(statuses[1], 'failed');
  const done = events.find((e) => e.type === 'node-done');
  assert.equal(done.ok, false);
  assert.match(String(done.error), /未提供.*执行器/);
});

test('缺执行器时的 failOutput 要给下游（更新检测类节点靠它输出 false）', async () => {
  const { ctx, outputs } = makeCtx();
  /*
   * 用 dataKind（'update'）而不是画布类型（'bili' / 'wechat'）：
   * 能力表按 dataKind 登记，两种数据源共用 'update' 这一条。
   * 写 'bili' 会匹配不到任何能力声明，测试就变成"什么都没校验"的假绿。
   */
  (ctx.node as { data: Record<string, unknown> }).data = { kind: 'update', source: 'bilibili' };
  await withNodeRun(ctx, async () => ({ output: '不该执行到' }));
  // update 在 nodeRequires 里声明了 failOutput: 'false'
  assert.equal(outputs.n1, 'false');
});

/* ---- 集成：确认上面的行为在真实调度里也成立 ---- */

test('集成：失败要传播到下游（不能只变红）', async () => {
  const g = {
    nodes: [
      { id: 'a', data: { kind: 'fs', label: 'A', op: 'read', path: '/x' } },
      { id: 'b', data: { kind: 'task', label: 'B', cli: 'codebuddy', prompt: 'x' } },
    ],
    edges: [{ id: 'e1', source: 'a', target: 'b' }],
  };
  // 不给 fsExecutor：a 应因缺能力失败，b 应被跳过
  const s = await runGraph(g, {
    concurrency: 1,
    executor: async () => 'x',
    onEvent: () => {},
  });
  assert.equal(s.failed.includes('a'), true);
  assert.equal(s.skipped.includes('b'), true);
  assert.equal(s.ok, false);
});

test('集成：成功节点的输出能被下游引用', async () => {
  const g = {
    nodes: [
      { id: 'a', data: { kind: 'extract', label: 'A', mode: 'line', spec: 'first' } },
      { id: 'b', data: { kind: 'extract', label: 'B', mode: 'text', spec: '' } },
    ],
    edges: [{ id: 'e1', source: 'a', target: 'b' }],
  };
  const s = await runGraph(g, {
    concurrency: 1,
    executor: async () => 'x',
    onEvent: () => {},
    input: '第一行\n第二行',
  });
  assert.equal(s.ok, true);
  assert.equal(s.outputs.a, '第一行');
  assert.equal(s.outputs.b, '第一行');
});
