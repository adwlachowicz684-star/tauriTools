import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readSrc } from './srcScan';
import {
  paneOptionsOf, findPane, isPaneNode, paneMembersOf, panePrevOutputs, supportsRelay,
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

test('CLI 节点执行前必须结算窗格（工作目录/模型/自动批准）', () => {
  /*
   * 执行器直接读 d.workdir / d.model 的话，窗格上填的那份永远轮不上：
   * 节点上没填目录时传下去的是空串，CLI 就跑在默认目录里，
   * 而窗格卡片上明明写着目录 —— 界面一套、跑的是另一套，且不报错。
   */
  const src = readSrc('App.tsx');
  assert.match(src, /resolveTaskPane\(d, findPane\(/);
  assert.match(src, /workdir: eff\.workdir, model: eff\.model, yolo: eff\.yolo/);
});

test('CLI 窗格的「共享上下文」必须在运行时拼进提示词', () => {
  /*
   * resolveTaskPane 只算出 shareContext，不把它用起来就是个摆设开关：
   * 勾了之后流程照旧各跑各的，而开关本身没有任何提示。
   */
  const src = readSrc('engine/runners/task.ts');
  assert.match(src, /withPaneContext\(/);
  assert.match(src, /panePrevOutputs\(/);
  // 拼上下文必须在流程里取到图与已产出的输出
  assert.match(src, /id, node, opts, emit, graph,/);
});

test('panePrevOutputs 的排序要计入参数连线', () => {
  if (!process.env.AF_SRC) return;
  /*
   * 少传第二个参数，排序就只按流程边算。窗格里两个成员之间常常
   * **只有参数连线**（A 的输出填进 B 的某个参数），于是 A 与 B 落在
   * 同一层，先后由 nodes 数组的创建顺序决定 —— 而执行顺序是 runner
   * 那边计入了参数连线排的。两份顺序不一致，上下文就会错乱或缺失，
   * 且不报错。
   */
  const src = readSrc('engine/pane.ts');
  assert.match(
    src,
    /topoLayers\([\s\S]{0,80}?,\s*[\s\S]{0,40}?\)\.layers/,
    'panePrevOutputs 的 topoLayers 要带上参数连线',
  );
  assert.match(src, /paramLinksOf\(/, '要复用 paramLinksOf，不要自己再判一遍什么是参数连线');
});

test('panePrevOutputs：只取同窗格、排在本节点之前、已产出的输出', () => {
  /*
   * 顺序错了上下文就讲不通（"第 1 步"其实是第 4 步才跑到的节点），
   * 而上下文本身不错位也不报错，只是读起来像乱的。
   */
  const g = {
    nodes: [
      { id: 'p1', data: { kind: 'taskPane' } },
      { id: 'a', data: { paneId: 'p1' } },
      { id: 'b', data: { paneId: 'p1' } },
      { id: 'c', data: { paneId: 'p1' } },
      { id: 'x', data: {} },
    ],
    edges: [
      { source: 'a', target: 'b' },
      { source: 'b', target: 'c' },
    ],
  };
  const outputs = { a: 'A 的结果', b: 'B 的结果', c: 'C 的结果', x: '别人的' };
  assert.deepEqual(panePrevOutputs(g, 'c', 'p1', outputs), ['A 的结果', 'B 的结果']);
  // 自己上一轮的输出不能算"上一步"，否则循环第二轮会把第一轮再喂一遍
  assert.deepEqual(panePrevOutputs(g, 'b', 'p1', outputs), ['A 的结果']);
  // 别的窗格 / 没挂窗格 / 还没产出，都是空
  assert.deepEqual(panePrevOutputs(g, 'c', 'p2', outputs), []);
  assert.deepEqual(panePrevOutputs(g, 'c', '', outputs), []);
  assert.deepEqual(panePrevOutputs(g, 'c', 'p1', {}), []);
});

test('withPaneContext：上下文不写回 prompt（只影响本次运行）', () => {
  const merged = withPaneContext('本次任务', ['第一步', '第二步'], true);
  assert.match(merged, /【前面步骤的结果】/);
  assert.match(merged, /本次任务/);
  // 关掉开关就必须原样返回，一个字都不能加
  assert.equal(withPaneContext('本次任务', ['第一步'], false), '本次任务');
});

test('挂了窗格的 CLI 节点不再谎报"会用默认目录"', () => {
  /*
   * 节点上没填目录、但窗格上配了 —— 实际跑的是窗格那个目录。
   * 这时报"会用默认目录"是句假话，用户会照着它去改一个没问题的节点。
   */
  const src = readSrc('engine/nodeValidate.ts');
  /*
   * 盯**定义那一行**而不是三目里的两个分支。
   *
   * 只断言分支文案的话，把 inPane 改成常量 false 照样通过 ——
   * 文案还在、判断没了，守卫却报绿。这正是"守卫比没有守卫更糟"的那类。
   */
  assert.match(src, /const inPane = !blank\(d\.paneId\)/);
  assert.match(src, /inPane \? '没填工作目录，看窗格上配了没有'/);
  assert.match(src, /inPane \? '没指定模型，看窗格上配了没有'/);
});

test('canRelay：窗格开了开关，还要看 CLI 支不支持', () => {
  /*
   * 只看窗格开关的话，traecli 也会被带上 `-c`，
   * 而它把未知选项当错误直接退出 —— 用户看到的是"开了开关节点全挂了"，
   * 想不到根因是 CLI 不支持。
   */
  const on = makeTaskPaneNode('p1', { relaySession: true }).data;
  const off = makeTaskPaneNode('p1', { relaySession: false }).data;

  assert.equal(resolveTaskPane(taskWith({ paneId: 'p1', cli: 'codebuddy' }), { id: 'p1', data: on }).canRelay, true);
  assert.equal(resolveTaskPane(taskWith({ paneId: 'p1', cli: 'traecli' }), { id: 'p1', data: on }).canRelay, false);
  assert.equal(resolveTaskPane(taskWith({ paneId: 'p1', cli: 'codebuddy' }), { id: 'p1', data: off }).canRelay, false);
  // 没挂窗格就谈不上接力
  assert.equal(resolveTaskPane(taskWith({ cli: 'codebuddy' }), null).canRelay, false);

  assert.equal(supportsRelay('codebuddy'), true);
  assert.equal(supportsRelay('traecli'), false);
  assert.equal(supportsRelay(undefined), false);
});

test('会话衔接：第一个成员不带 -c，后面的才带', () => {
  /*
   * 第一个带上 `-c` 接的是 CLI 全局记的那一次 ——
   * 可能是用户在自己终端里刚跑过的，表现为节点读到了一段没见过的历史。
   */
  const src = readSrc('App.tsx');
  assert.match(src, /const cont = eff\.canRelay && eff\.paneId !== '' && paneSessions\.current\.has\(eff\.paneId\)/);
  assert.match(src, /yolo: eff\.yolo, cont \}/);
  // 每次开跑前清空：留着的话第二次跑的第一个节点也会去接上一轮
  assert.match(src, /paneSessions\.current\.clear\(\)/);
});

test('Rust 侧：接力参数只给非 traecli 拼', () => {
  /*
   * 后端拼参数时若不区分 CLI，traecli 会拿到 `-c` 并当未知选项报错退出。
   * 这个分支在前端判完后仍然要在后端挡一道 —— 前端改坏了不该让 CLI 崩。
   */
  // 从插件目录往上两级才是 src-tauri（仓库根在 nexus-panel 的父级）
  const src = readSrc('../../src-tauri/src/af_flow.rs');
  assert.match(src, /if req\.cont && !is_trae \{\s*args\.push\("-c"\.into\(\)\);/);
  assert.match(src, /pub cont: bool/);
});
