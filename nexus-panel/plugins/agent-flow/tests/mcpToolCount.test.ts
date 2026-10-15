import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshAll, pruneByServers } from '../engine/mcpStore';
import {
  toolCountOf, mcpSidebarGroups, visibleBlueprints, groupByServer,
  type NodeBlueprint,
} from '../engine/mcpTools';
import { readSrc } from './srcScan';

const bp = (server: string, tool: string): NodeBlueprint => ({
  type: `mcp:${server}:${tool}`, dataKind: 'mcp', server, tool,
  label: `${server} · ${tool}`, sub: '', fields: [], generatedAt: 0,
});

const fetcher3 = async () => [
  { name: 'read', description: '读', inputSchema: { type: 'object' } },
  { name: 'write', description: '写', inputSchema: { type: 'object' } },
  { name: 'list', description: '列', inputSchema: { type: 'object' } },
];

/* ============ 纯函数 ============ */

test('按服务聚合工具数', () => {
  const gs = mcpSidebarGroups([bp('fs', 'read'), bp('fs', 'write'), bp('db', 'q')]);
  assert.deepEqual(toolCountOf(gs), { fs: 2, db: 1 });
});

test('空分组得到空对象（不是 undefined）', () => {
  assert.deepEqual(toolCountOf([]), {});
});

test('stale 的不算（侧栏也看不到它们）', () => {
  const gs = mcpSidebarGroups([{ ...bp('fs', 'read'), stale: true }, bp('fs', 'write')]);
  assert.deepEqual(toolCountOf(gs), { fs: 1 });
});

/* ============ 刷新后的真实数据流 ============ */

/*
 * 这是本轮真正要盯的那个洞：
 *
 * 启动快照（hydrateMcpNodes 的结果）在刷新成功后**不会变**，
 * 而侧栏分组会变。两个地方显示同一件事却用了两个源 ——
 * 结果是"侧栏有 3 个工具、服务面板一个都不显示"。
 */
test('刷新拉到工具后，计数要跟着变（不能停在启动快照）', async () => {
  const servers = [{ name: 'fs', url: 'http://x' }];
  const boot: NodeBlueprint[] = [];            // 启动快照为空
  const outcome = await refreshAll({ servers, previous: boot, fetcher: fetcher3 });
  assert.equal(outcome.ok, true);
  const pruned = pruneByServers(outcome.list, servers);

  const fromSnapshot: Record<string, number> = {};
  for (const b of boot) { const k = String(b?.server ?? '').trim(); if (k) fromSnapshot[k] = (fromSnapshot[k] ?? 0) + 1; }
  assert.deepEqual(fromSnapshot, {}, '启动快照确实是空的（这正是会分叉的情形）');

  const gs = groupByServer(visibleBlueprints(pruned));
  assert.equal(gs[0].blueprints.length, 3, '刷新后侧栏有 3 个');
  assert.deepEqual(
    toolCountOf(mcpSidebarGroups(pruned)),
    { fs: 3 },
    '计数必须反映刷新后的 —— 否则面板显示 0，与侧栏对不上',
  );
});

test('刷新后服务端少了一个工具，计数要跟着减', async () => {
  const servers = [{ name: 'fs', url: 'http://x' }];
  const boot = [bp('fs', 'read'), bp('fs', 'write'), bp('fs', 'gone')];
  const outcome = await refreshAll({
    servers,
    previous: boot,
    fetcher: async () => [{ name: 'read', inputSchema: { type: 'object' } }, { name: 'write', inputSchema: { type: 'object' } }],
  });
  assert.equal(outcome.ok, true);
  const pruned = pruneByServers(outcome.list, servers);
  const got = toolCountOf(mcpSidebarGroups(pruned));
  assert.equal(got.fs, 2, '不能还写着 3 —— 那与侧栏对不上');
});

/* ============ 源码守卫 ============ */

test('源码守卫：hook 里的计数必须从侧栏分组派生', () => {
  const src = readSrc('hooks/useMcpRegistry.ts');
  const i = src.indexOf('const mcpToolCount');
  assert.ok(i >= 0, '必须有 mcpToolCount');
  const seg = src.slice(i, i + 400);
  assert.ok(/toolCountOf\s*\(\s*mcpGroups\s*\)/.test(seg), '必须从 mcpGroups 派生');
  assert.ok(
    !/mcpBlueprints/.test(seg),
    '从 mcpBlueprints 算会停在启动快照上 —— 它是 useState 且没有 setter，刷新后不变',
  );
});

test('源码守卫：mcpBlueprints 不许变成可变的（它的语义就是启动快照）', () => {
  const src = readSrc('hooks/useMcpRegistry.ts');
  assert.ok(
    !/setMcpBlueprints/.test(src),
    '给它加 setter 等于把"启动快照"和"当前蓝图"混成一件事 —— 要更新就用 groups',
  );
});
