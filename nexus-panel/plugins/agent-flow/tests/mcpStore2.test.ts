import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleBlueprints } from '../engine/mcpStore';
import { buildBlueprints, groupByServer, type NodeBlueprint } from '../engine/mcpTools';

const bp = (server: string, tool: string): NodeBlueprint => ({
  type: `mcp:${server}:${tool}`, dataKind: 'mcp', server, tool,
  label: `${server} · ${tool}`, sub: '', fields: [], generatedAt: 0,
});

/**
 * 侧栏只显示没过期的 ——
 * 过期的工具在 server 上已经不存在，让它还能新建就是"建出来就跑不了"。
 */
test('stale 的不出现在侧栏', () => {
  const list = [{ ...bp('fs', 'read'), stale: true }, bp('fs', 'write')];
  assert.deepEqual(visibleBlueprints(list).map((b) => b.tool), ['write']);
});

test('全部过期时侧栏为空，但不报错', () => {
  assert.deepEqual(visibleBlueprints([{ ...bp('fs', 'read'), stale: true }]), []);
});

test('分组里不含 stale（visible 后再分组）', () => {
  const list = [{ ...bp('fs', 'read'), stale: true }, bp('fs', 'write')];
  const g = groupByServer(visibleBlueprints(list));
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].blueprints.map((b) => b.tool), ['write']);
});

test('buildBlueprints 产出的默认不带 stale', () => {
  const r = buildBlueprints('fs', [{ name: 'read', inputSchema: { type: 'object', properties: {} } }]);
  assert.equal(r.list[0].stale, undefined, '新生成的工具不该是 stale');
});
