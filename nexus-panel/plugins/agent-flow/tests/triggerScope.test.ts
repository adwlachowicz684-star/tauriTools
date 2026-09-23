import test from 'node:test';
import assert from 'node:assert/strict';
import type { Graph, GraphEdge, GraphNode } from '../types';
import {
  entryScopeOf, reachableFrom, withParamSources, triggerIdsOf,
  isTriggerKind, ERR_NO_TRIGGER,
} from '../engine/triggerScope';
import { isActiveTrigger } from '../engine/triggerRegistry';
import { makeParamEdge } from '../engine/paramLinks';
import { runGraph } from '../engine/runner';
import { readSrc } from './srcScan';

/**
 * 执行范围 —— 所有流程都从触发器开始。
 *
 * 动机（用户实测）：画布上没有触发器的流程照样执行了。
 * 更普遍的是：从没接过任何东西的孤立节点也跟着跑，
 * 失败时把整条流程标红，日志里混进一堆与本次触发无关的记录。
 *
 * 本文件的重点是**范围的正确性**，尤其是两个容易漏的点：
 *   · 参数连线的来源必须补进范围（否则常量节点不跑，参数拿到空）
 *   · 自动触发只跑那一条链路（否则一次触发带起整张画布）
 */

const N = (id: string, kind: string, data: Record<string, unknown> = {}): GraphNode =>
  ({ id, data: { kind, ...data } }) as unknown as GraphNode;

const E = (a: string, b: string): GraphEdge =>
  ({ id: `${a}->${b}`, source: a, target: b });

/** 手动触发卡片齐全的触发器（至少一个启用的触发条件） */
const TRIG = (id: string, extra: Record<string, unknown> = {}): GraphNode =>
  N(id, 'trigger', { triggers: ['manual'], ...extra });

/* ------------------------------------------------------------------ */
/* 判定                                                                */
/* ------------------------------------------------------------------ */

test('没有触发器 → 拒绝执行（这正是用户实测到的那个 bug）', () => {
  const g: Graph = { nodes: [N('a', 'http'), N('b', 'write')], edges: [E('a', 'b')] };
  const r = entryScopeOf(g);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.message, ERR_NO_TRIGGER);
});

test('有触发器但全被禁用 → 同样拒绝', () => {
  const g: Graph = { nodes: [TRIG('t', { enabled: false })], edges: [] };
  // entryScopeOf 只看 kind；"启用了没有"由 isActiveTrigger 判
  assert.equal(entryScopeOf(g).ok, true);
  assert.equal(isActiveTrigger({ kind: 'trigger', enabled: false, triggers: ['manual'] }), false);
});

test('触发条件卡片全停用 → 不算入口', () => {
  const d = {
    kind: 'trigger',
    triggers: [{ id: 'e1', kind: 'manual', enabled: false }],
  } as Record<string, unknown>;
  assert.equal(isActiveTrigger(d), false);
});

test('节点启用 + 有启用的触发卡片 → 是入口', () => {
  assert.equal(isActiveTrigger({ kind: 'trigger', triggers: ['manual'] }), true);
  assert.equal(isActiveTrigger({ kind: 'http' }), false);
});

/* ------------------------------------------------------------------ */
/* 可达                                                                */
/* ------------------------------------------------------------------ */

test('只跑从入口出发能走到的节点，孤立节点被排除', () => {
  const g: Graph = {
    nodes: [TRIG('t'), N('a', 'http'), N('b', 'write'), N('lonely', 'http')],
    edges: [E('t', 'a'), E('a', 'b')],
  };
  const r = entryScopeOf(g, 't');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.ids.has('t'));
  assert.ok(r.ids.has('a'));
  assert.ok(r.ids.has('b'));
  // 静默排除：不在范围里，也不该被算成 skipped
  assert.equal(r.ids.has('lonely'), false);
});

test('另一条链路的节点不跑 —— 一个周期任务到期不该带起整张画布', () => {
  const g: Graph = {
    nodes: [TRIG('t1'), TRIG('t2'), N('a', 'http'), N('b', 'http')],
    edges: [E('t1', 'a'), E('t2', 'b')],
  };
  const r = entryScopeOf(g, 't1');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.ids.has('a'));
  assert.equal(r.ids.has('t2'), false);
  assert.equal(r.ids.has('b'), false);
});

test('不指定入口 → 全部触发器都算起点', () => {
  const g: Graph = {
    nodes: [TRIG('t1'), TRIG('t2'), N('a', 'http'), N('b', 'http')],
    edges: [E('t1', 'a'), E('t2', 'b')],
  };
  const r = entryScopeOf(g);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual([...r.ids].sort(), ['a', 'b', 't1', 't2']);
});

test('参数连线的来源要补进范围 —— 不补的话常量节点不跑，参数拿到空', () => {
  const g: Graph = {
    nodes: [TRIG('t'), N('c', 'const'), N('m', 'math')],
    edges: [E('t', 'm'), makeParamEdge('c', 'm', 'a') as GraphEdge],
  };
  const r = entryScopeOf(g, 't');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  // c 没接在流程链路上，只通过参数连线给 m 供值
  assert.ok(r.ids.has('c'), '参数连线的来源必须在范围内');
});

test('参数连线的来源链条要一路追到底', () => {
  // c2 -> c1 -> m：只补一层的话 c2 仍会被漏掉
  const g: Graph = {
    nodes: [TRIG('t'), N('c1', 'const'), N('c2', 'const'), N('m', 'math')],
    edges: [
      E('t', 'm'),
      makeParamEdge('c1', 'm', 'a') as GraphEdge,
      makeParamEdge('c2', 'c1', 'value') as GraphEdge,
    ],
  };
  const r = entryScopeOf(g, 't');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.ok(r.ids.has('c1'));
  assert.ok(r.ids.has('c2'));
});

test('入口不在图上 → 明确报错，不退化成全跑', () => {
  const g: Graph = { nodes: [TRIG('t'), N('a', 'http')], edges: [E('t', 'a')] };
  const r = entryScopeOf(g, 'ghost');
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /不在当前画布/);
});

test('reachableFrom 遇到环不会爆栈', () => {
  const ids = reachableFrom(['a'], [E('a', 'b'), E('b', 'c'), E('c', 'a')]);
  assert.deepEqual([...ids].sort(), ['a', 'b', 'c']);
});

test('withParamSources 不会无限循环（来源互相引用）', () => {
  const out = withParamSources(new Set(['m']), [
    { source: 'x', target: 'm' }, { source: 'm', target: 'x' },
  ]);
  assert.ok(out.has('x'));
  assert.ok(out.has('m'));
});

test('triggerIdsOf 只认触发器', () => {
  const g: Graph = { nodes: [TRIG('t'), N('a', 'http')], edges: [] };
  assert.deepEqual(triggerIdsOf(g), ['t']);
  assert.equal(isTriggerKind({ kind: 'trigger' }), true);
  assert.equal(isTriggerKind({ kind: 'http' }), false);
});

/* ------------------------------------------------------------------ */
/* 引擎侧：runGraph 真的只跑范围内节点                                  */
/* ------------------------------------------------------------------ */

test('runGraph 带入口时，孤立节点不执行也不进 skipped', async () => {
  const g: Graph = {
    nodes: [TRIG('t'), N('a', 'http'), N('lonely', 'http')],
    edges: [E('t', 'a')],
  };
  const ran: string[] = [];
  const r = await runGraph(g, {
    entry: 't',
    onEvent: (e) => { if (e.type === 'node-done') ran.push((e as { id: string }).id); },
  });
  assert.equal(r.ok, true);
  assert.ok(ran.includes('a'));
  assert.equal(ran.includes('lonely'), false, '孤立节点不该执行');
  assert.equal(r.skipped.includes('lonely'), false, '孤立节点不该算跳过（静默排除）');
});

test('runGraph 无入口且图上有触发器但连不到 → 那些节点不跑', async () => {
  const g: Graph = {
    nodes: [TRIG('t'), N('a', 'http'), N('orphan', 'http')],
    edges: [E('t', 'a')],
  };
  const ran: string[] = [];
  await runGraph(g, {
    onEvent: (e) => { if (e.type === 'node-done') ran.push((e as { id: string }).id); },
  });
  assert.equal(ran.includes('orphan'), false);
});

/* ------------------------------------------------------------------ */
/* 源码守卫                                                            */
/* ------------------------------------------------------------------ */

test('源码守卫：App 里 runGraph 必须带 entry', () => {
  const app = readSrc('App.tsx');
  assert.ok(/entry:\s*entryId/.test(app), 'runGraph 调用要传 entry');
});

test('源码守卫：没有可用入口时必须拒绝，不能照跑', () => {
  const app = readSrc('App.tsx');
  assert.ok(/entryIds\.length === 0/.test(app), '要有"没有入口就拒绝"的分支');
  assert.ok(/ERR_NO_TRIGGER/.test(app), '拒绝时要给出明确文案');
});

test('源码守卫：工具栏不再有「运行工作流」按钮', () => {
  /*
   * 留着它就是留了一个绕过入口的口子：
   * 点它跑的是"图上所有节点"，与触发器卡片上的「▶ 触发」不是同一条路径。
   */
  const app = readSrc('App.tsx');
  assert.equal(/运行工作流/.test(app), false, '工具栏运行按钮应已移除');
});

test('源码守卫：手动触发与自动触发都要带上入口 id', () => {
  const app = readSrc('App.tsx');
  assert.ok(/runRef\.current\?\.\(undefined,\s*'manual',\s*undefined,\s*nodeId\)/.test(app),
    '卡片上的手动触发要带 nodeId');
  assert.ok(/runRef\.current\(injected,\s*src,\s*gt\?\.canvasId,\s*t\.nodeId\)/.test(app),
    '调度器触发要带 t.nodeId');
});
