import test from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from './srcScan';
import {
  expandCanvasRefs, canvasInnerId, KIND_CANVAS_REF,
} from '../engine/canvasRef';
import { runGraph } from '../engine/runner';

/**
 * 跨画布展开失败：日志说「被跳过」，节点其实没被跳过。
 *
 * 探针实测（修之前）：
 *   画布 A 调用已被删除的 B
 *   → 日志「⚠ 跨画布调用「cr1」被跳过：找不到画布「B」」
 *   → cr1 原样留在图里、没有执行器 → dispatchNode 兜底直通
 *   → cr1: success / output '' / ok:true，下游 log 照常跑、整轮 ok=true
 *
 * 这与 RunOptions 里 tableReader / askHuman 两处反复写明的那条原则
 * 正好相反：「静默返回空串会让下游拿着空值继续跑，那比报错难查得多」。
 *
 * 修法不是删日志，是让行为配得上日志：展开失败的实例预置成失败，
 * 走 withNodeRun 的失败路径，下游按既有规则跳过。
 */

const N = (id: string, kind: string, extra: Record<string, unknown> = {}) =>
  ({ id, data: { kind, label: id, ...extra } });
const E = (s: string, t: string) => ({ id: `${s}-${t}`, source: s, target: t });

/** 顶层：调用一张不存在的画布，下游挂一个普通节点 */
function broken() {
  const g = {
    nodes: [N('cr1', KIND_CANVAS_REF, { canvasId: 'gone' }), N('down', 'log', { text: '下游' })],
    edges: [E('cr1', 'down')],
  };
  return expandCanvasRefs(g, () => null);
}

test('（前置）展开失败时引用节点原样留在图里 —— 所有问题的起点', () => {
  const ex = broken();
  assert.equal(ex.problems.length, 1, JSON.stringify(ex.problems));
  assert.match(ex.problems[0].reason, /找不到画布/);
  assert.equal(ex.problems[0].instanceId, 'cr1');
  assert.ok(ex.nodes.some((n) => n.id === 'cr1'), '节点没被跳过，是被保留下来了');
});

test('反例：不传 prefailed 时，旧行为仍然是直通（别把兜底改坏）', async () => {
  const ex = broken();
  const r = await runGraph(ex as never, { concurrency: 1, input: '', onEvent: () => {} });
  assert.equal(r.ok, true);
  assert.deepEqual(r.failed, []);
  assert.equal(r.outputs['cr1'], '');
});

test('prefailed：节点明确失败、下游跳过、整轮报失败，且原因看得见', async () => {
  const ex = broken();
  const ev: { type: string; id?: string; status?: string; ok?: boolean; output?: string; error?: string }[] = [];
  const r = await runGraph(ex as never, {
    concurrency: 1,
    input: '',
    prefailed: { cr1: '找不到画布「gone」（可能已被删除）' },
    onEvent: (e) => ev.push(e as never),
  });

  assert.equal(r.ok, false, '整轮必须判失败，不能报成功');
  assert.ok(r.failed.includes('cr1'), `failed 里要有 cr1：${JSON.stringify(r.failed)}`);
  assert.ok(r.skipped.includes('down'), `下游必须被跳过：${JSON.stringify(r.skipped)}`);

  const statuses = ev.filter((e) => e.type === 'node-status' && e.id === 'cr1').map((e) => e.status);
  assert.ok(statuses.includes('failed'), `cr1 要标红：${JSON.stringify(statuses)}`);
  assert.ok(!statuses.includes('success'), '不能又失败又成功');

  const done = ev.find((e) => e.type === 'node-done' && e.id === 'cr1');
  assert.ok(done, '失败节点也要有终态事件');
  assert.equal(done!.ok, false);
  assert.match(String(done!.error ?? ''), /找不到画布/);
  assert.match(r.outputs['cr1'] ?? '', /找不到画布/, '输出里也要留着原因，便于事后回看');

  assert.ok(
    !ev.some((e) => e.type === 'node-status' && e.id === 'down' && e.status === 'running'),
    '下游不该真的跑起来',
  );
});

test('反例：prefailed 只作用于点名的节点，别的一律照常', async () => {
  const ex = broken();
  const r = await runGraph(ex as never, {
    concurrency: 1, input: '', prefailed: { cr1: '原因' }, onEvent: () => {},
  });
  assert.equal(r.ok, false);
  assert.ok(!r.failed.includes('down'), 'down 是「被跳过」，不是「失败」');
});

test('反例：prefailed 里的 id 不在图上时不误伤，也不影响整轮', async () => {
  const g = { nodes: [N('a', 'log', { text: 'x' })], edges: [] };
  const r = await runGraph(g as never, {
    concurrency: 1, input: '', prefailed: { ghost: '不存在' }, onEvent: () => {},
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.failed, []);
});

test('（前置）成功展开的实例不再留在图里；这类 problems 是 warn 不是 fail', () => {
  const B = {
    id: 'B', name: 'B',
    /* 显式输入节点没接下游：展开成功，但要报一条接口 warn */
    nodes: [N('a', 'task'), N('in1', 'canvasIn'), N('b', 'log')], edges: [E('a', 'b')],
  };
  const g = { nodes: [N('cr1', KIND_CANVAS_REF, { canvasId: 'B' })], edges: [] };
  const ex = expandCanvasRefs(g, (id) => (id === 'B' ? B : null));
  assert.ok(!ex.nodes.some((n) => n.id === 'cr1'), '实例已被内部节点替换');
  assert.ok(ex.problems.length > 0, '这条守卫要真读到 warn，否则下面的 every 恒绿');
  for (const p of ex.problems) {
    assert.equal(p.level, 'warn', `「${p.reason}」已经展开了，不该判失败`);
    assert.ok(
      !ex.nodes.some((n) => n.id === p.instanceId),
      `提示「${p.reason}」指向的实例 ${p.instanceId} 已被替换，不该被当成要失败的节点`,
    );
  }
});

test('内层 problems 的 instanceId 带前缀，且与展开后的节点对得上', () => {
  const B = {
    id: 'B', name: 'B',
    nodes: [N('cr2', KIND_CANVAS_REF, { canvasId: 'goneC' }), N('b1', 'log', { text: 'b' })],
    edges: [E('cr2', 'b1')],
  };
  const g = { nodes: [N('cr1', KIND_CANVAS_REF, { canvasId: 'B' })], edges: [] };
  const ex = expandCanvasRefs(g, (id) => (id === 'B' ? B : null));
  const p = ex.problems.find((x) => x.reason.includes('goneC'));
  assert.ok(p, `没找到内层失败：${JSON.stringify(ex.problems)}`);
  assert.equal(p!.instanceId, canvasInnerId('cr1', 'cr2'));
  assert.ok(
    ex.nodes.some((n) => n.id === p!.instanceId),
    '加了前缀的 id 必须真的在图里，否则预置失败会落空',
  );
});

/* ================= 源码守卫 ================= */

test('源码守卫：App 把 prefailed 传给 runGraph，两档日志分开说', () => {
  const s = readSrc('App.tsx');
  assert.match(s, /prefailed,/, 'runGraph 的 opts 里必须带 prefailed');
  assert.match(
    s, /splitCanvasProblems\(canvasExpanded\.problems\)/,
    '必须用显式的 fail/warn 分类，别再靠「id 是否在图里」猜语义',
  );
  assert.match(s, /未能展开/, 'fail 档要说未能展开');
  assert.match(s, /已展开，但接口需检查/, 'warn 档不许再说未能展开');
  assert.ok(!s.includes('expandNodeIds'), '别退回「id 是否真的在图里」那套巧合判据');
  assert.ok(!s.includes('被跳过：'), 'readSrc 剥了注释，若还出现「被跳过：」就是日志又在说假话');
});

test('源码守卫：runner 的 prefailed 分支走 withNodeRun（不能只标红不传播）', () => {
  const s = readSrc('engine/runner.ts');
  /* 可信度：先证明读到的确实是 runner.ts 的代码，不是空串/别的卷 */
  assert.match(s, /async function dispatchNode\(/, 'readSrc 没读到 dispatchNode，下面的断言会全绿却什么也没守');
  assert.match(s, /getRunner\(node\.data\)/, '读到的不是真正的分派段');
  assert.match(s, /opts\.prefailed\?\.\[id\]/, 'prefailed 判据不见了');
  assert.match(s, /withNodeRun\(makeCtx\(id, node, scope, signal\)/, '必须复用统一失败路径');
  assert.match(s, /throw new NodeFailError\(msg, msg\)/, '失败原因要同时进 error 和 output');
});

test('源码守卫：递归展开的 problems 必须加前缀', () => {
  const s = readSrc('engine/canvasRef.ts');
  assert.match(s, /export function expandCanvasRefs\(/, 'readSrc 没读到 canvasRef.ts');
  assert.match(s, /canvasInnerId\(id, p\.instanceId\)/, '内层 problems 又退回原样传递了');
});
