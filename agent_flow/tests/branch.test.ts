/**
 * 条件分支与条件求值的单元测试。
 *
 * 运行：npm i -D tsx && npx tsx --test tests/branch.test.ts
 *
 * 这些用例守的是最容易出错的地方：
 * 剪枝会不会漏裁（走两条分支）、会不会误裁（汇合节点被裁掉）、
 * 剪枝会不会被误判为失败、非法正则会不会炸掉整条流水线。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runGraph } from '../src/engine/runner';
import { evaluateCondition } from '../src/engine/condition';
import { descendantsOf } from '../src/engine/topo';
import { isCondition, type NodeData, type ConditionRule } from '../src/types';

type AnyData = Record<string, unknown>;

const E = (s: string, t: string, branch?: string) => ({
  id: `${s}->${t}`, source: s, target: t, ...(branch ? { branch } : {}),
});
const T = (id: string, prompt = ''): { id: string; data: NodeData } => ({
  id,
  data: { label: id, cli: 'codebuddy', prompt, model: '', workdir: '', yolo: true, status: 'idle', output: '', error: '' },
});
const C = (id: string, rules: ConditionRule[], defaultBranch = true) => ({
  id,
  data: { kind: 'condition' as const, label: id, rules, defaultBranch, status: 'idle' as const, output: '', error: '' },
});
const R = (id: string, label: string, op: ConditionRule['op'], value = '', source = ''): ConditionRule =>
  ({ id, label, op, value, source });
const G = (nodes: { id: string; data: NodeData }[], edges: ReturnType<typeof E>[]) => ({ nodes, edges });

function mk(execImpl?: (id: string) => string) {
  const ran: string[] = [];
  const events: unknown[] = [];
  return {
    ran,
    events,
    run: (g: ReturnType<typeof G>) =>
      runGraph(g, {
        concurrency: 1,
        executor: async (n, _rendered, chunk) => {
          ran.push(n.id);
          const o = execImpl ? execImpl(n.id) : `out-${n.id}`;
          chunk(o);
          return o;
        },
        onEvent: (e) => events.push(e),
      }),
  };
}

/* ---------- 条件求值 ---------- */

test('条件: contains 命中第一条规则', () => {
  const c = { kind: 'condition' as const, label: 'x', rules: [R('r1', '有错', 'contains', 'error')], defaultBranch: true };
  assert.equal(evaluateCondition(c, { outputs: { a: 'an error occurred' }, upstream: ['a'] }).branchId, 'r1');
});

test('条件: 从上到下取第一条命中', () => {
  const c = {
    kind: 'condition' as const, label: 'x',
    rules: [R('r1', '无', 'contains', 'zzz'), R('r2', '有', 'contains', 'ok')],
    defaultBranch: true,
  };
  assert.equal(evaluateCondition(c, { outputs: { a: 'status ok' }, upstream: ['a'] }).branchId, 'r2');
});

test('条件: 都不命中走兜底', () => {
  const c = { kind: 'condition' as const, label: 'x', rules: [R('r1', 'x', 'contains', 'zzz')], defaultBranch: true };
  assert.equal(evaluateCondition(c, { outputs: { a: 'hello' }, upstream: ['a'] }).branchId, '__default__');
});

test('条件: 关闭兜底则无分支', () => {
  const c = { kind: 'condition' as const, label: 'x', rules: [R('r1', 'x', 'contains', 'zzz')], defaultBranch: false };
  assert.equal(evaluateCondition(c, { outputs: { a: 'hello' }, upstream: ['a'] }).branchId, null);
});

test('条件: 非法正则不抛异常，跳过该规则并报错', () => {
  const c = { kind: 'condition' as const, label: 'x', rules: [R('r1', '坏', 'regex', '[')], defaultBranch: true };
  const r = evaluateCondition(c, { outputs: { a: 'x' }, upstream: ['a'] });
  assert.equal(r.branchId, '__default__');
  assert.match(r.error ?? '', /正则非法/);
});

test('条件: 非法正则后面的规则仍能命中', () => {
  const c = {
    kind: 'condition' as const, label: 'x',
    rules: [R('r1', '坏', 'regex', '['), R('r2', '好', 'contains', 'ok')],
    defaultBranch: true,
  };
  assert.equal(evaluateCondition(c, { outputs: { a: 'ok' }, upstream: ['a'] }).branchId, 'r2');
});

test('条件: source 可为上游 id / input / 空', () => {
  const mkC = (src: string) => ({
    kind: 'condition' as const, label: 'x',
    rules: [R('r1', 'y', 'equals', 'AAA', src)], defaultBranch: false,
  });
  assert.equal(evaluateCondition(mkC('a'), { outputs: { a: 'AAA', b: 'BBB' }, upstream: ['a', 'b'] }).branchId, 'r1');
  assert.equal(evaluateCondition(mkC('b'), { outputs: { a: 'AAA', b: 'BBB' }, upstream: ['a', 'b'] }).branchId, null);
  assert.equal(evaluateCondition(mkC('input'), { outputs: {}, input: 'AAA', upstream: [] }).branchId, 'r1');
  assert.equal(evaluateCondition(mkC(''), { outputs: {}, input: 'AAA', upstream: [] }).branchId, 'r1');
});

test('条件: source 为空时拼接全部上游输出', () => {
  const c = { kind: 'condition' as const, label: 'x', rules: [R('r1', 'y', 'contains', 'BBB')], defaultBranch: false };
  assert.equal(evaluateCondition(c, { outputs: { a: 'AAA', b: 'BBB' }, upstream: ['a', 'b'] }).branchId, 'r1');
});

test('条件: 各操作符行为', () => {
  const t = (op: ConditionRule['op'], value: string, text: string) => {
    const c = { kind: 'condition' as const, label: 'x', rules: [R('r1', 'y', op, value)], defaultBranch: false };
    return evaluateCondition(c, { outputs: {}, input: text, upstream: [] }).branchId === 'r1';
  };
  assert.equal(t('contains', 'ab', 'xaby'), true);
  assert.equal(t('notContains', 'zz', 'xaby'), true);
  assert.equal(t('equals', 'ab', ' ab '), true);   // 去首尾空白
  assert.equal(t('notEquals', 'ab', 'abc'), true);
  assert.equal(t('startsWith', 'xa', 'xaby'), true);
  assert.equal(t('regex', '^a\\d+$', 'a123'), true);
  assert.equal(t('nonEmpty', '', 'x'), true);
  assert.equal(t('isEmpty', '', '   '), true);
  assert.equal(t('always', '', 'anything'), true);
});

test('拓扑: descendantsOf 递归收集下游', () => {
  const edges = [E('A', 'B'), E('B', 'C'), E('A', 'C')];
  assert.deepEqual(descendantsOf('A', edges), new Set(['B', 'C']));
  assert.deepEqual(descendantsOf('C', edges), new Set());
});

/* ---------- 分支执行 ---------- */

test('分支: 命中分支执行，另一分支被裁掉', async () => {
  const g = G(
    [T('a'), C('cond', [R('r1', '有值', 'contains', 'ok')]), T('b'), T('c')],
    [E('a', 'cond'), E('cond', 'b', 'r1'), E('cond', 'c', '__default__')],
  );
  const { run, ran } = mk(() => 'status ok');
  const s = await run(g);
  assert.deepEqual(ran.sort(), ['a', 'b'], `应只跑 a 和 b，实际 ${ran}`);
  assert.ok(s.skipped.includes('c'));
  assert.equal(s.ok, true, '剪枝不算失败');
});

test('分支: 走兜底分支', async () => {
  const g = G(
    [T('a'), C('cond', [R('r1', '有值', 'contains', 'zzz')]), T('b'), T('c')],
    [E('a', 'cond'), E('cond', 'b', 'r1'), E('cond', 'c', '__default__')],
  );
  const { run, ran } = mk(() => 'hello');
  const s = await run(g);
  assert.deepEqual(ran.sort(), ['a', 'c']);
  assert.ok(s.skipped.includes('b'));
});

test('分支: 关闭兜底且无命中 → 所有分支都跳过', async () => {
  const g = G(
    [T('a'), C('cond', [R('r1', 'x', 'contains', 'zzz')], false), T('b'), T('c')],
    [E('a', 'cond'), E('cond', 'b', 'r1'), E('cond', 'c', '__default__')],
  );
  const { run, ran } = mk(() => 'hello');
  const s = await run(g);
  assert.deepEqual(ran, ['a'], '分支节点不应执行');
  assert.ok(s.skipped.includes('b') && s.skipped.includes('c'));
  assert.equal(s.ok, true, '无分支命中不是错误');
});

test('分支: 剪枝传播到整条下游链路（孙节点也不跑）', async () => {
  const g = G(
    [T('a'), C('cond', [R('r1', 'y', 'contains', 'ok')]), T('b'), T('c'), T('d'), T('e')],
    [E('a', 'cond'), E('cond', 'b', 'r1'), E('cond', 'c', '__default__'), E('b', 'd'), E('c', 'e')],
  );
  const { run, ran } = mk(() => 'status ok');
  const s = await run(g);
  assert.deepEqual(ran.sort(), ['a', 'b', 'd'], `实际 ${ran}`);
  assert.ok(s.skipped.includes('c') && s.skipped.includes('e'), 'e 是 c 的下游，应一并裁掉');
});

test('分支: 汇合节点 —— 任一分支活着就继续（OR 语义）', async () => {
  const g = G(
    [T('a'), C('cond', [R('r1', 'y', 'contains', 'ok')]), T('b'), T('c'), T('join')],
    [E('a', 'cond'), E('cond', 'b', 'r1'), E('cond', 'c', '__default__'), E('b', 'join'), E('c', 'join')],
  );
  const { run, ran } = mk(() => 'status ok');
  await run(g);
  assert.ok(ran.includes('join'), '汇合节点应执行（b 分支活着）');
  assert.ok(!ran.includes('c'));
});

test('分支: 未标注 branch 的出边视为无条件，始终执行', async () => {
  const g = G(
    [T('a'), C('cond', [R('r1', 'y', 'contains', 'zzz')]), T('always')],
    [E('a', 'cond'), E('cond', 'always')],
  );
  const { run, ran } = mk(() => 'hello');
  await run(g);
  assert.ok(ran.includes('always'), '无 branch 标注的边不受剪枝影响');
});

test('分支: 条件节点下游能看到条件节点输出', async () => {
  const g = G(
    [T('a'), C('cond', [R('r1', '有值', 'contains', 'ok')]), T('b', '收到: {{cond.output}}')],
    [E('a', 'cond'), E('cond', 'b', 'r1')],
  );
  const { run, events } = mk(() => 'status ok');
  await run(g);
  const start = (events as { type: string; id: string; rendered: string }[])
    .find((e) => e.type === 'node-start' && e.id === 'b');
  assert.match(start?.rendered ?? '', /收到: \[条件\] 走「有值」/);
});

test('分支: 条件节点不调用 CLI executor', async () => {
  const g = G(
    [T('a'), C('cond', [R('r1', 'y', 'contains', 'ok')]), T('b')],
    [E('a', 'cond'), E('cond', 'b', 'r1')],
  );
  const { run, ran } = mk(() => 'status ok');
  await run(g);
  assert.ok(!ran.includes('cond'), '条件节点不应出现在 executor 调用里');
});

test('分支: 上游失败仍然传播（失败≠剪枝）', async () => {
  const g = G(
    [T('a'), C('cond', [R('r1', 'y', 'contains', 'ok')]), T('b')],
    [E('a', 'cond'), E('cond', 'b', 'r1')],
  );
  const { run, ran } = mk((id) => { if (id === 'a') throw new Error('boom'); return 'ok'; });
  const s = await run(g);
  assert.deepEqual(ran, ['a']);
  assert.deepEqual(s.failed, ['a']);
  assert.equal(s.ok, false);
});

test('分支: branches 记录判定轨迹', async () => {
  const g = G(
    [T('a'), C('cond', [R('r1', '有值', 'contains', 'ok')]), T('b')],
    [E('a', 'cond'), E('cond', 'b', 'r1')],
  );
  const { run } = mk(() => 'status ok');
  const s = await run(g);
  assert.equal(s.branches.length, 1);
  assert.equal(s.branches[0].branchId, 'r1');
  assert.equal(s.branches[0].label, '有值');
});

test('分支: 用上游真实输出判定（而非原始模板）', async () => {
  const g = G(
    [T('a'), T('b'), C('cond', [R('r1', '是', 'contains', 'PROD')], false), T('deploy')],
    [E('a', 'b'), E('b', 'cond'), E('cond', 'deploy', 'r1')],
  );
  const { run, ran } = mk((id) => (id === 'b' ? 'env=PROD' : 'x'));
  const s = await run(g);
  assert.ok(ran.includes('deploy'), 'b 输出含 PROD，应部署');
  assert.equal(s.branches[0].branchId, 'r1');
});

test('分支: 环检测仍然生效', async () => {
  const g = G([T('a'), T('b')], [E('a', 'b'), E('b', 'a')]);
  const { run, ran, events } = mk(() => 'x');
  const s = await run(g);
  assert.equal(ran.length, 0);
  assert.equal(s.ok, false);
  assert.ok((events as { type: string }[]).some((e) => e.type === 'run-error'));
});

test('判别: isCondition 区分两类节点', () => {
  assert.equal(isCondition(T('a').data), false);
  assert.equal(isCondition(C('c', []).data as NodeData), true);
});

export type { AnyData };
