import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readSrc } from './srcScan';
import {
  paneOptionsOf, findPane, isPaneNode, paneMembersOf,
  resolveTaskPane, resolveApiPane, withPaneContext, DEFAULT_TEMPERATURE,
} from '../engine/pane';
import {
  makeNode as makeTaskNodeAlias, makeTaskPaneNode, makeApiPaneNode, makeLlmChatNode,
  type TaskNodeData, type LlmChatNodeData,
} from '../types';

/**
 * 任务窗格的继承规则。
 *
 * 这组测试盯的是"节点优先、节点没填才用窗格"这条方向 ——
 * 方向反了的话，改一次窗格会把精心配好的节点全盖掉，
 * 而且是静默的：用户改的是窗格，坏的却是节点。
 */

function taskWith(partial: Partial<TaskNodeData>) {
  return makeTaskNodeAlias('t1', partial).data as TaskNodeData;
}

function llmWith(partial: Partial<LlmChatNodeData>) {
  return makeLlmChatNode('l1', partial).data as LlmChatNodeData;
}

const cliPane = makeTaskPaneNode('p1', {
  workdir: '/proj', model: 'gpt-4o', credentialId: 'c1', yolo: true,
}).data;

const apiPane = makeApiPaneNode('p2', {
  credentialId: 'c2', model: 'deepseek-chat', system: '你是一名编辑', temperature: 0.9,
}).data;

const nodes = [
  { id: 'p1', data: cliPane },
  { id: 'p2', data: apiPane },
  { id: 't1', data: taskWith({}) },
] as never[];

test('窗格选项只列同类：CLI 节点不看到 API 窗格', () => {
  const cli = paneOptionsOf(nodes as never, 'taskPane');
  assert.deepEqual(cli.map((o) => o.value), ['p1']);

  const api = paneOptionsOf(nodes as never, 'apiPane');
  assert.deepEqual(api.map((o) => o.value), ['p2']);
});

test('isPaneNode 只认两种窗格，普通节点不算', () => {
  assert.equal(isPaneNode({ id: 'p1', data: cliPane } as never), true);
  assert.equal(isPaneNode({ id: 'p2', data: apiPane } as never), true);
  assert.equal(isPaneNode({ id: 't1', data: taskWith({}) } as never), false);
});

test('窗格被删了（paneId 还在）按没有窗格处理，不报错', () => {
  assert.equal(findPane(nodes as never, 'p-gone'), null);
  const r = resolveTaskPane(taskWith({ paneId: 'p-gone' }), null);
  assert.equal(r.paneId, '');
  assert.equal(r.workdir, '');
});

test('CLI 窗格：节点没填的项从窗格继承', () => {
  const r = resolveTaskPane(taskWith({ paneId: 'p1' }), { id: 'p1', data: cliPane });
  assert.equal(r.workdir, '/proj');
  assert.equal(r.model, 'gpt-4o');
  assert.equal(r.credentialId, 'c1');
});

test('CLI 窗格：节点上填了的项仍然以节点为准 —— 窗格不能盖掉它', () => {
  const r = resolveTaskPane(
    taskWith({ paneId: 'p1', workdir: '/own', model: 'm-own' }),
    { id: 'p1', data: cliPane },
  );
  assert.equal(r.workdir, '/own');
  assert.equal(r.model, 'm-own');
});

test('yolo 是例外：取节点与窗格中较宽的那个', () => {
  /*
   * TaskNodeData.yolo 是必填布尔，建出来就是 false。
   * 若也按"节点优先"，窗格上的 yolo 永远轮不上 ——
   * 表现为"窗格这个开关完全没用"。
   */
  const off = resolveTaskPane(taskWith({ yolo: false }), { id: 'p1', data: cliPane });
  assert.equal(off.yolo, true, '窗格开了就该按开处理');
});

test('API 窗格：system 与连接都继承，temperature 三级回落', () => {
  const r = resolveApiPane(llmWith({ paneId: 'p2' }), { id: 'p2', data: apiPane });
  assert.equal(r.system, '你是一名编辑');
  assert.equal(r.credentialId, 'c2');
  assert.equal(r.temperature, 0.9);
});

test('API 窗格：节点填了 temperature 就用节点的，最后才落到默认', () => {
  const own = resolveApiPane(llmWith({ temperature: 0 }), { id: 'p2', data: apiPane });
  assert.equal(own.temperature, 0, '0 是合法值，不能被当成"没填"');

  const fallback = resolveApiPane(llmWith({}), null);
  assert.equal(fallback.temperature, DEFAULT_TEMPERATURE);
});

test('共享上下文：关掉时不拼接', () => {
  const p = '做这件事';
  assert.equal(withPaneContext(p, ['上次的结果'], false), p);
});

test('共享上下文：打开时把前面几步的结果接在前面', () => {
  const out = withPaneContext('做这件事', ['第一步结果', '第二步结果'], true);
  assert.ok(out.indexOf('【前面步骤的结果】') === 0);
  assert.ok(out.indexOf('第一步结果') > 0);
  assert.ok(out.indexOf('【本次任务】') > 0);
  assert.ok(out.endsWith('做这件事'));
});

test('共享上下文：上游没有输出时不加空壳', () => {
  assert.equal(withPaneContext('做这件事', [], true), '做这件事');
  assert.equal(withPaneContext('做这件事', ['   '], true), '做这件事');
});

/* ================= 源码守卫 ================= */
/*
 * 这几处失效的样子都是"安静的"：
 * 不报错、界面看着也正常，只是窗格的作用悄悄没了。
 */

test('执行前把任务窗格滤掉', () => {
  const src = readSrc('App.tsx');
  /*
   * 窗格没有执行器，进图后会是一个"永远直通"的孤立节点，
   * 孤立节点在按触发器定范围时又会被排除 ——
   * 于是"有时报错有时不报"，取决于画布上有没有触发器。
   * 而它还会占一个节点位出现在任务记录里，
   * 用户数节点数时不会把它算进去。
   */
  assert.match(src, /!isPaneNode\(n\)/);
});

test('删窗格时清掉成员的 paneId', () => {
  const src = readSrc('engine/canvasOps.ts');
  assert.match(src, /removedPaneIds/);
});

test('窗格卡片不给端口', () => {
  const src = readSrc('components/PaneNode.tsx');
  /*
   * 给了端口就能连出一条指向"什么都没有"的线：
   * 窗格不执行，下游拿到空值，而线明明画着。
   */
  assert.doesNotMatch(src, /<Handle/);
});

/* ---- 复制窗格要连成员一起复制 ---- */

test('paneMembersOf：按 paneId 现场数成员（不认窗格自己）', () => {
  const src = [
    { id: 'p1', data: { kind: 'taskPane' } },
    { id: 'p2', data: { kind: 'apiPane' } },
    { id: 't1', data: { paneId: 'p1' } },
    { id: 't2', data: { paneId: 'p1' } },
    { id: 'l1', data: { paneId: 'p2' } },
    { id: 't3', data: {} },
  ];
  assert.deepEqual(paneMembersOf(src, 'p1'), ['t1', 't2']);
  assert.deepEqual(paneMembersOf(src, 'p2'), ['l1']);
  // 空 / 没挂窗格 / 没有成员的窗格都是空数组，不能误判成"全员"
  assert.deepEqual(paneMembersOf(src, ''), []);
  assert.deepEqual(paneMembersOf(src, null), []);
  assert.deepEqual(paneMembersOf(src, 'p3'), []);
});

test('paneMembersOf：窗格自己不算成员（窗格不挂窗格）', () => {
  /*
   * 归属关系只有"节点 → 窗格"一层。
   * 把窗格算进来，复制窗格时会连另一个窗格一起复制，
   * 而嵌套窗格在界面上没有对应的操作入口 ——
   * 表现为"复制出来一个多余的框"，且删不掉它挂在哪。
   */
  const src = [
    { id: 'p1', data: { kind: 'taskPane' } },
    { id: 'p2', data: { kind: 'apiPane', paneId: 'p1' } },
    { id: 't1', data: { paneId: 'p1' } },
  ];
  assert.deepEqual(paneMembersOf(src, 'p1'), ['t1']);
});

test('复制窗格时把成员一并纳入复制集合', () => {
  /*
   * 只复制窗格的话，副本是个空窗格 —— 卡片上写着「0 个节点」，
   * 而原件好端端挂着两个。用户复制了窗格，得到的却是个空的。
   */
  const src = readSrc('App.tsx');
  assert.match(src, /paneMembersOf\(nodes, n\.id\)/);
});

test('复制时 paneId 跟着重指向（窗格在集合内改指副本）', () => {
  const src = readSrc('engine/duplicate.ts');
  /*
   * 不重指向的话副本成员挂着原窗格，原窗格成员数凭空 +1，
   * 界面上两个窗格却分不清哪个挂了谁。
   */
  assert.match(src, /if \(map\[p\]\) d\.paneId = map\[p\]/);
});
