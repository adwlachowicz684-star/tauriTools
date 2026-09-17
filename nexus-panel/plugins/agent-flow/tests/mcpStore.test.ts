import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadBlueprints, saveBlueprints, visibleBlueprints,
  refreshAll, describeRefresh, collectServers, pruneByServers,
  serversChanged, serversToDrop, serverKey, MCP_BP_KEY,
  type McpToolFetcher,
} from '../engine/mcpStore';
import { buildBlueprints, type NodeBlueprint } from '../engine/mcpTools';

/** 内存版 KV，避免动真实 localStorage */
function memKV(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = { ...initial };
  return {
    store,
    get(k: string) { return store[k]; },
    set(k: string, v: unknown) { store[k] = v; },
    remove(k: string) { delete store[k]; },
  } as never;
}

const tool = (name: string, props: Record<string, unknown> = {}, req: string[] = []) => ({
  name, inputSchema: { type: 'object', properties: props as never, required: req },
});

const bpOf = (server: string, tools: unknown[]): NodeBlueprint[] =>
  buildBlueprints(server, tools as never).list;

/* ================= 读写 ================= */

test('存进去能原样读出来', () => {
  const kv = memKV();
  const list = bpOf('fs', [tool('read', { path: { type: 'string' } })]);
  saveBlueprints(list, kv);
  const got = loadBlueprints(kv);
  assert.equal(got.length, 1);
  assert.equal(got[0].tool, 'read');
});

test('没存过返回空数组，不抛异常', () => {
  assert.deepEqual(loadBlueprints(memKV()), []);
});

test('存档不是数组时返回空，不崩', () => {
  assert.deepEqual(loadBlueprints(memKV({ [MCP_BP_KEY]: { a: 1 } })), []);
});

/**
 * 坏数据逐条过滤，不是整批丢 ——
 * 一份存档里坏了两条就让其余三十条都读不出来太可惜。
 */
test('坏条目被过滤，好的保留', () => {
  const good = bpOf('fs', [tool('read')])[0];
  const kv = memKV({
    [MCP_BP_KEY]: JSON.stringify({ version: 1, blueprints: [
      good,
      { type: 'task', server: 'x', tool: 'y', label: 'z', sub: '', fields: [], generatedAt: 0 },
      null,
      { type: 'mcp:fs:bad' },
    ] }),
  });
  const got = loadBlueprints(kv);
  assert.equal(got.length, 1, '只该留下合法的那条');
  assert.equal(got[0].tool, 'read');
});

test('stale 的不在侧栏显示', () => {
  const list = bpOf('fs', [tool('read'), tool('write')]);
  const withStale = list.map((b, i) => (i === 0 ? { ...b, stale: true } : b));
  assert.equal(visibleBlueprints(withStale).length, 1);
  assert.equal(visibleBlueprints(withStale)[0].tool, 'write');
});

/* ================= 刷新：没接协议 ================= */

test('没有协议实现 → 退化成用快照，并说明原因', async () => {
  const prev = bpOf('fs', [tool('read')]);
  const r = await refreshAll({ servers: [{ name: 'fs', command: 'x' }], previous: prev });
  assert.equal(r.ok, false);
  assert.equal(r.usedFallback, true);
  assert.equal(r.list, prev, '该原样返回旧快照');
  assert.ok(r.failures[0].reason.includes('协议'), '要说明是协议没接上');
});

test('没配服务 → 说明原因，不静默成功', async () => {
  const r = await refreshAll({ servers: [], previous: [], fetcher: async () => [] });
  assert.equal(r.ok, false);
  assert.ok(r.failures[0].reason.includes('还没配'));
});

/* ================= 刷新：正常 ================= */

const okFetcher = (tools: unknown[]): McpToolFetcher => async () => tools as never;

test('刷新拿到新工具', async () => {
  const r = await refreshAll({
    servers: [{ name: 'fs', command: 'x' }],
    previous: [],
    fetcher: okFetcher([tool('read'), tool('write')]),
  });
  assert.equal(r.ok, true);
  assert.equal(r.list.length, 2);
  assert.equal(r.diffs.filter((d) => d.kind === 'added').length, 2);
});

test('工具没变 → diffs 为空', async () => {
  const prev = bpOf('fs', [tool('read', { path: { type: 'string' } })]);
  const r = await refreshAll({
    servers: [{ name: 'fs', command: 'x' }],
    previous: prev,
    fetcher: okFetcher([tool('read', { path: { type: 'string' } })]),
  });
  assert.equal(r.ok, true);
  assert.equal(r.diffs.length, 0);
});

/* ================= 刷新：一个失败不该连累其它 ================= */

/**
 * 这条是刷新逻辑最关键的一条 ——
 * 整批失败的话，连上一次坏网络就能让用户所有的 MCP 节点凭空不见。
 */
test('一个 server 连不上，其它 server 的节点照常更新', async () => {
  const prevFs = bpOf('fs', [tool('read')]);
  const prevGit = bpOf('git', [tool('commit')]);
  const r = await refreshAll({
    servers: [{ name: 'fs', command: 'a' }, { name: 'git', command: 'b' }],
    previous: [...prevFs, ...prevGit],
    fetcher: async (s) => {
      if (s.name === 'fs') throw new Error('连接超时');
      return [tool('commit'), tool('push')] as never;
    },
  });
  assert.equal(r.ok, true, '有一个成功就算成功');
  assert.ok(r.failures.some((f) => f.server === 'fs'), '失败要记下来');
  // fs 的旧快照必须还在
  assert.ok(r.list.some((b) => b.server === 'fs' && b.tool === 'read'),
    '连不上的 server，旧节点不该消失');
  // git 正常更新
  assert.ok(r.list.some((b) => b.server === 'git' && b.tool === 'push'));
});

test('全部连不上 → 退化成用快照', async () => {
  const prev = bpOf('fs', [tool('read')]);
  const r = await refreshAll({
    servers: [{ name: 'fs', command: 'x' }],
    previous: prev,
    fetcher: async () => { throw new Error('boom'); },
  });
  assert.equal(r.ok, false);
  assert.equal(r.usedFallback, true);
  assert.equal(r.list, prev);
});

/* ================= 工具被删：stale 而非注销 ================= */

test('工具被删 → 标记 stale 而不是移除', async () => {
  const prev = bpOf('fs', [tool('read'), tool('write')]);
  const r = await refreshAll({
    servers: [{ name: 'fs', command: 'x' }],
    previous: prev,
    fetcher: okFetcher([tool('read')]),
  });
  const write = r.list.find((b) => b.tool === 'write');
  assert.ok(write, '被删的工具不该从列表里消失');
  assert.equal(write?.stale, true, '要标成 stale —— 画布上可能还有用它的节点');
  assert.equal(visibleBlueprints(r.list).length, 1, '但侧栏不该再显示它');
});

test('工具回来了 → stale 标记去掉，能重新用于新建', async () => {
  const stale = bpOf('fs', [tool('read'), tool('write')])
    .map((b) => (b.tool === 'write' ? { ...b, stale: true } : b));
  const r = await refreshAll({
    servers: [{ name: 'fs', command: 'x' }],
    previous: stale,
    fetcher: okFetcher([tool('read'), tool('write')]),
  });
  const write = r.list.find((b) => b.tool === 'write');
  assert.equal(write?.stale, undefined, '工具回来了就不该还是 stale');
  assert.equal(visibleBlueprints(r.list).length, 2);
});

test('单个工具 schema 坏了，同 server 的其它工具照常', async () => {
  const r = await refreshAll({
    servers: [{ name: 'fs', command: 'x' }],
    previous: [],
    fetcher: okFetcher([tool('read'), { name: '' }]),
  });
  assert.equal(r.ok, true);
  assert.equal(r.list.length, 1);
  assert.ok(r.failures.some((f) => f.reason.includes('工具')));
});

/* ================= 描述文案 ================= */

test('没变化 / 有变化 / 失败 三种文案要说不同的话', async () => {
  const prev = bpOf('fs', [tool('read', { path: { type: 'string' } })]);

  const same = await refreshAll({
    servers: [{ name: 'fs', command: 'x' }], previous: prev,
    fetcher: okFetcher([tool('read', { path: { type: 'string' } })]),
  });
  assert.ok(describeRefresh(same).includes('没变化'), describeRefresh(same));

  const changed = await refreshAll({
    servers: [{ name: 'fs', command: 'x' }], previous: prev,
    fetcher: okFetcher([tool('read', { path: { type: 'string' } }), tool('write')]),
  });
  assert.ok(describeRefresh(changed).includes('新增'), describeRefresh(changed));

  const failed = await refreshAll({ servers: [{ name: 'fs', command: 'x' }], previous: prev });
  assert.ok(describeRefresh(failed).includes('没有刷新'), describeRefresh(failed));
});

/* ================= 从画布收集服务 ================= */

test('收集所有画布的 MCP 服务，按名字去重', () => {
  const r = collectServers([
    { config: { mcpServers: [{ name: 'fs', command: 'a' }] } },
    { config: { mcpServers: [{ name: 'fs', command: 'b' }, { name: 'git', url: 'u' }] } },
  ]);
  assert.equal(r.length, 2, '同名只该留一个');
  assert.equal(r[0].name, 'fs');
  assert.equal(r[1].name, 'git');
});

test('没有配置时返回空数组', () => {
  assert.deepEqual(collectServers([]), []);
  assert.deepEqual(collectServers([{ config: undefined }]), []);
});

test('空名字的服务被跳过', () => {
  assert.deepEqual(collectServers([{ config: { mcpServers: [{ name: '  ' }] } }]), []);
});

/* ================= 服务列表变化 ================= */

test('serverKey 区分命令：改命令算换了个服务', () => {
  assert.equal(serverKey({ name: 'fs', command: 'a' }), serverKey({ name: 'fs', command: 'a' }));
  assert.notEqual(serverKey({ name: 'fs', command: 'a' }), serverKey({ name: 'fs', command: 'b' }),
    '改了命令不算变化的话，用户会以为刷新失效');
  assert.notEqual(serverKey({ name: 'fs', url: 'u' }), serverKey({ name: 'fs', command: 'a' }));
});

test('顺序不同不算变化（避免无意义的刷新）', () => {
  const a = [{ name: 'fs' }, { name: 'git' }];
  const b = [{ name: 'git' }, { name: 'fs' }];
  assert.equal(serversChanged(a, b), false);
});

test('数量变了 / 内容变了都算变化', () => {
  assert.equal(serversChanged([{ name: 'a' }], [{ name: 'a' }, { name: 'b' }]), true);
  assert.equal(serversChanged([{ name: 'a' }], [{ name: 'b' }]), true);
  assert.equal(serversChanged([], []), false);
});

test('prune：不在服务列表里的标 stale', () => {
  const list = [
    { ...bpOf('fs', [tool('read')])[0] },
    { ...bpOf('git', [tool('commit')])[0] },
  ];
  const out = pruneByServers(list, [{ name: 'fs' }]);
  assert.equal(out.find((b) => b.server === 'fs')?.stale, undefined, '还在的不该标');
  assert.equal(out.find((b) => b.server === 'git')?.stale, true, '删掉的服务该标 stale');
});

test('prune 不删除条目 —— 画布上的老节点还要靠它显示', () => {
  const list = [{ ...bpOf('git', [tool('commit')])[0] }];
  assert.equal(pruneByServers(list, []).length, 1);
});

test('serversToDrop 找出被删掉的服务名', () => {
  const before = [{ name: 'fs' }, { name: 'git' }];
  const after = [{ name: 'fs' }];
  assert.deepEqual(serversToDrop(before, after), ['git']);
  assert.deepEqual(serversToDrop(before, before), []);
});

/* ================= 未填完的服务 ================= */

/**
 * 用户点「＋加一个服务」后，命令与地址都是空的。
 * 这时候去连必然失败并报"连不上" —— 那是噪音，不是问题。
 */
test('命令与地址都空的服务被跳过，不算失败', async () => {
  const r = await refreshAll({
    servers: [{ name: 'newone' }],
    previous: [],
    fetcher: async () => { throw new Error('不该被调用'); },
  });
  assert.equal(r.failures.length, 0, '没填完的服务不该报失败');
  assert.equal(r.list.length, 0);
});

test('填了命令的服务正常连，空的那个不影响它', async () => {
  const r = await refreshAll({
    servers: [{ name: 'empty' }, { name: 'ok', command: 'x' }],
    previous: [],
    fetcher: async (s) => {
      if (s.name === 'empty') throw new Error('不该调用');
      return [tool('read')] as never;
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.failures.length, 0);
  assert.equal(r.list.length, 1);
});

test('未填完的服务保留它已有的快照', async () => {
  const prev = bpOf('fs', [tool('read')]);
  const r = await refreshAll({
    servers: [{ name: 'fs' }],
    previous: prev,
    fetcher: async () => { throw new Error('不该调用'); },
  });
  assert.equal(r.list.length, 1, '旧快照该留着');
});
