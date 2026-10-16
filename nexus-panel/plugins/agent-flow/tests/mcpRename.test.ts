import test from 'node:test';
import assert from 'node:assert/strict';
import {
  serversToDrop, serverEndpoint, serverKey, bootRefresh, loadBlueprints,
  type ServerRef,
} from '../engine/mcpStore';
import { mcpSidebarGroups, type McpToolSchema, type NodeBlueprint } from '../engine/mcpTools';
import type { KV } from '../engine/kv';
import { readSrc } from './srcScan';

const schema = (name: string): McpToolSchema =>
  ({ name, description: '', inputSchema: { type: 'object' } });
const ref = (name: string, url = `http://${name}`): ServerRef => ({ name, url });
const memKV = (): KV & { box: Record<string, string> } => {
  const box: Record<string, string> = {};
  return { box, get: (k) => box[k] ?? null, set: (k, v) => { box[k] = v; } };
};

/* ================================================================== */
/* 行为：改名字 ≠ 删服务                                                */
/* ================================================================== */

test('改名（地址不变）不算删掉', () => {
  assert.deepEqual(serversToDrop([ref('fs', 'http://a')], [ref('fs2', 'http://a')]), []);
});

test('真的删掉才算删掉', () => {
  assert.deepEqual(serversToDrop([ref('fs', 'http://a')], []), ['fs']);
});

test('换个服务（名字留着、地址改了）不算删掉 —— 那是改地址', () => {
  assert.deepEqual(serversToDrop([ref('fs', 'http://a')], [ref('fs', 'http://b')]), []);
});

/*
 * 名字和地址同时改：这时无从判断是"改名"还是"换了服务"，
 * 按删除处理 —— 保守方向是让旧组消失，而不是留着一个连不上的旧名。
 */
test('名字与地址同时改 → 认不出来，按删除处理', () => {
  assert.deepEqual(serversToDrop([ref('fs', 'http://a')], [ref('fs2', 'http://b')]), ['fs']);
});

/*
 * 空配置（地址命令都没填）：无从比对，按删除处理。
 * 不特判的话，两个"都还没填"的服务会被误认成互相改名。
 */
test('没填地址的服务：不认改名（否则两个空服务会互相认成改名）', () => {
  assert.deepEqual(serversToDrop([{ name: 'a' }], [{ name: 'b' }]), ['a']);
});

test('serverEndpoint 只看地址与命令，不含名字', () => {
  assert.equal(serverEndpoint(ref('fs', 'http://a')), serverEndpoint(ref('fs2', 'http://a')));
  assert.notEqual(serverEndpoint(ref('fs', 'http://a')), serverEndpoint(ref('fs', 'http://b')));
});

/* ================================================================== */
/* 端到端：改名后新名连不上，旧工具不能凭空消失                          */
/* ================================================================== */

/*
 * 改之前：改名 + 新名连不上 → 侧栏这个服务的工具**全部消失**
 * （旧组被立刻剔除、新组永远不出现），而存盘里其实还在。
 */
test('改名后新名连不上：旧工具仍在存盘、且没被标 stale', async () => {
  const kv = memKV();
  let current: NodeBlueprint[] = [];
  const r1 = await bootRefresh([ref('fs', 'http://a')], current,
    async () => [schema('A')], { kv });
  current = r1.outcome.list;
  assert.deepEqual(loadBlueprints(kv).map((b) => b.tool), ['A']);

  // 改名为 fs2，但新名连不上
  const r2 = await bootRefresh([ref('fs2', 'http://a')], current,
    async () => { throw new Error('连不上'); }, { kv });
  assert.equal(r2.outcome.ok, false);

  const stored = loadBlueprints(kv);
  assert.ok(stored.some((b) => b.tool === 'A'), 'A 要还在存盘里');
  assert.ok(!stored.some((b) => b.stale), '刷新失败不该标 stale —— 没证据说工具没了');

  // 配合改名不算删除：界面上这一组也不该被剔除
  const dropped = serversToDrop([ref('fs', 'http://a')], [ref('fs2', 'http://a')]);
  assert.deepEqual(dropped, [], '这组要留着 —— 否则用户看到的是工具凭空消失');
  const groups = mcpSidebarGroups(current.filter((b) => !dropped.includes(b.server)));
  assert.deepEqual(groups.map((g) => g.server), ['fs']);
});

test('改名并刷新成功：新名的组出现，旧名被标 stale', async () => {
  const kv = memKV();
  let current: NodeBlueprint[] = [];
  const r1 = await bootRefresh([ref('fs', 'http://a')], current,
    async () => [schema('A')], { kv });
  current = r1.outcome.list;
  const r2 = await bootRefresh([ref('fs2', 'http://a')], current,
    async () => [schema('A')], { kv });
  current = r2.outcome.list;
  const stored = loadBlueprints(kv);
  assert.ok(stored.find((b) => b.server === 'fs')?.stale, '旧名要标 stale');
  assert.deepEqual(mcpSidebarGroups(current).map((g) => g.server), ['fs2']);
});

/* ================================================================== */
/* 源码守卫                                                            */
/* ================================================================== */

test('源码守卫：剔除只发生在 serversToDrop，且它认得改名', () => {
  const src = readSrc('engine/mcpStore.ts');
  const i = src.indexOf('export function serversToDrop');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/serverEndpoint/.test(body), '不认改名的话，"改名"和"删掉"会返回同一个结果');
});

test('源码守卫：serverKey 仍含名字（改名要算变化，触发刷新）', () => {
  const src = readSrc('engine/mcpStore.ts');
  assert.ok(/s\?\.name/.test(src.slice(src.indexOf('export function serverKey'), src.indexOf('export function serverKey') + 300)));
  assert.notEqual(serverKey(ref('fs', 'http://a')), serverKey(ref('fs2', 'http://a')),
    '改名必须算变化 —— 否则不会触发刷新，新名的组永远不会出现');
});
