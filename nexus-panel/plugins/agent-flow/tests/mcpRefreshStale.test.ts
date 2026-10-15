import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bootRefresh, loadBlueprints, type ServerRef,
} from '../engine/mcpStore';
import { buildBlueprints, type McpToolSchema, type NodeBlueprint } from '../engine/mcpTools';
import type { KV } from '../engine/kv';
import { readSrc } from './srcScan';

const bp = (server: string, tool: string): NodeBlueprint => ({
  type: `mcp:${server}:${tool}`, dataKind: 'mcp', server, tool,
  label: `${server} · ${tool}`, sub: '', fields: [], generatedAt: 0,
});

const memKV = (): KV & { box: Record<string, string> } => {
  const box: Record<string, string> = {};
  return { box, get: (k) => box[k] ?? null, set: (k, v) => { box[k] = v; } };
};

const schema = (name: string): McpToolSchema =>
  ({ name, description: '', inputSchema: { type: 'object' } });

const ref = (name: string): ServerRef => ({ name, url: `http://${name}` });

/* ============ 行为：过期那次不许落盘 ============ */

/*
 * 本轮要修的那件事。
 *
 * 刷新是异步的，触发时机有三个（启动 / 手动点 / 改配置防抖），
 * 并发时"后发的先返回"很常见。调用方那句
 *   `if (seq !== mcpRefreshSeq.current) return`
 * 挡住的只是**界面**那一半（rebuildMcpGroups）——
 * 而 saveBlueprints / registerBlueprints 发生在 await 内部，
 * 在检查之前就写完了。
 *
 * 于是界面显示新工具（对），存盘却是旧蓝图：
 * 用户当时一切正常，**下次启动**静默回到旧版本，且不报错。
 */
test('过期的那次刷新**不写**蓝图快照', async () => {
  const kv = memKV();
  const registered: NodeBlueprint[][] = [];
  const r = await bootRefresh(
    [ref('fs')],
    [],
    async () => [schema('read')],
    { isStale: () => true, kv, register: (l) => registered.push(l) },
  );
  assert.equal(r.outcome.ok, true, '刷新本身是成功的 —— 只是这次结果已经过期');
  assert.equal(Object.keys(kv.box).length, 0, '过期结果不能写进存储');
  assert.equal(registered.length, 0, '过期结果也不能重新注册');
});

test('没过期的那次照常落盘（不能误伤）', async () => {
  const kv = memKV();
  const registered: NodeBlueprint[][] = [];
  const r = await bootRefresh(
    [ref('fs')],
    [],
    async () => [schema('read')],
    { isStale: () => false, kv, register: (l) => registered.push(l) },
  );
  assert.equal(r.outcome.ok, true);
  assert.equal(registered.length, 1);
  assert.deepEqual(loadBlueprints(kv).map((b) => b.tool), ['read']);
});

/*
 * 并发的真实顺序：新刷新已经发出（seq 变了），旧刷新这时才返回。
 * 用真的一次并发验证，而不是只传个恒真的 isStale。
 */
test('并发：旧刷新返回时新刷新已发出 → 存盘的是新的那份', async () => {
  const kv = memKV();
  let seq = 0;
  const registered: NodeBlueprint[][] = [];

  // 旧刷新：慢，且用的是旧服务列表
  const oldOne = bootRefresh(
    [ref('fs')], [],
    async () => { await new Promise((r) => setTimeout(r, 30)); return [schema('OLD')]; },
    { isStale: () => 1 !== seq, kv, register: (l) => registered.push(l) },
  );
  // 新刷新：快，用的是改过之后的服务列表
  seq = 2;
  const newOne = bootRefresh(
    [ref('fs')], [],
    async () => [schema('NEW')],
    { isStale: () => 2 !== seq, kv, register: (l) => registered.push(l) },
  );

  await Promise.all([oldOne, newOne]);

  assert.deepEqual(loadBlueprints(kv).map((b) => b.tool), ['NEW'],
    '存盘必须是新刷新的结果 —— 旧的那个会在下次启动时把工具变回旧版');
  assert.equal(registered.length, 1);
  assert.equal(registered[0][0].tool, 'NEW');
});

test('刷新失败时不写盘（失败与过期是两回事）', async () => {
  const kv = memKV();
  const r = await bootRefresh(
    [ref('fs')], [],
    async () => { throw new Error('连不上'); },
    { isStale: () => false, kv },
  );
  assert.equal(r.outcome.ok, false);
  assert.equal(Object.keys(kv.box).length, 0);
});

/* ============ 源码守卫 ============ */

/*
 * 只盯"hook 里有没有 seq 判据"是不够的 ——
 * 判据一直都在，但它挡的是 await **之后**的那一步。
 * 必须盯的是"判据传进了刷新内部"。
 */
test('源码守卫：过期判据要传进 bootRefresh（不能在返回后才判）', () => {
  const src = readSrc('hooks/useMcpRegistry.ts');
  const i = src.indexOf('await bootRefresh(');
  assert.ok(i >= 0);
  const call = src.slice(i, src.indexOf(';', i));
  assert.ok(/isStale/.test(call),
    '不传进去的话，存储与注册表两处副作用在判据生效前就写完了');
});

test('源码守卫：写过期的实现必须在写盘之前问一次', () => {
  const src = readSrc('engine/mcpStore.ts');
  const i = src.indexOf('export async function bootRefresh');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('\n}\n', i));
  const iStale = body.indexOf('isStale');
  const iSave = body.indexOf('saveBlueprints');
  assert.ok(iStale >= 0 && iSave >= 0);
  assert.ok(iStale < iSave, '判据必须在写盘之前 —— 写完了再判断等于没判');
});

test('源码守卫：bootRefresh 的实现在 mcpStore（可测），mcpRegistry 只转发', () => {
  const store = readSrc('engine/mcpStore.ts');
  const reg = readSrc('engine/mcpRegistry.ts');
  assert.ok(store.includes('export async function bootRefresh'),
    '实现要在能单测的那一层');
  assert.ok(!reg.includes('export async function bootRefresh'),
    'mcpRegistry 里那份会拉起 React，没法测 —— 只能转发');
  assert.ok(/registerBlueprints/.test(reg), '注册函数由 React 侧注入');
});

test('源码守卫：buildBlueprints 仍在（工具清单 → 蓝图）', () => {
  assert.equal(typeof buildBlueprints, 'function');
});
