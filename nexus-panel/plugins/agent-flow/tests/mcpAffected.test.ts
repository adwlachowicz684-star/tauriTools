import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffBlueprints, brokenTypes, refreshBreaksNodes, countMcpUsage, describeAffected,
  type BlueprintDiff, type NodeBlueprint,
} from '../engine/mcpTools';

const mk = (tool: string, fields: NodeBlueprint['fields']): NodeBlueprint => ({
  type: `mcp:fs:${tool}`, server: 'fs', tool, label: tool,
  dataKind: 'mcp', fields,
});
const f = (key: string, required = false): NodeBlueprint['fields'][number] =>
  ({ key, kind: 'text', label: key, required });

/* ================= 判定收在一处 ================= */

test('refreshBreaksNodes 与 brokenTypes 同源（新增不算危险）', () => {
  const d: BlueprintDiff[] = [{ kind: 'added', type: 'mcp:fs:new', label: 'new' }];
  assert.deepEqual(brokenTypes(d), []);
  assert.equal(refreshBreaksNodes(d), false);

  const d2: BlueprintDiff[] = [
    { kind: 'removed', type: 'mcp:fs:search', label: 'search' },
    { kind: 'changed', type: 'mcp:fs:fetch', label: 'fetch' },
    { kind: 'added', type: 'mcp:fs:new', label: 'new' },
  ];
  assert.deepEqual(brokenTypes(d2), ['mcp:fs:search', 'mcp:fs:fetch']);
  assert.equal(refreshBreaksNodes(d2), true);
});

/* ================= 用量统计 ================= */

test('只数 mcp: 前缀的节点', () => {
  const usage = countMcpUsage([
    { nodes: [{ type: 'mcp:fs:search' }, { type: 'trigger' }, { type: 'mcp:fs:search' }] },
    { nodes: [{ type: 'mcp:fs:fetch' }] },
  ] as never);
  assert.deepEqual(usage, { 'mcp:fs:search': 2, 'mcp:fs:fetch': 1 });
});

test('坏数据不炸（缺 nodes / 缺 type / null）', () => {
  assert.deepEqual(countMcpUsage([]), {});
  assert.deepEqual(countMcpUsage([{}, null, { nodes: null }] as never), {});
  assert.deepEqual(countMcpUsage([{ nodes: [{}, { type: 123 }] }] as never), {});
});

/* ================= 说全：点名 + 说有几个节点 ================= */

test('被用到的移除/变更要点名，并说清有几个节点', () => {
  const diffs = diffBlueprints(
    [mk('search', [f('q')]), mk('fetch', [f('url')])],
    [mk('fetch', [f('url'), f('mode', true)])],
  );
  const warn = describeAffected(diffs, { 'mcp:fs:search': 2, 'mcp:fs:fetch': 1 });
  assert.ok(warn, '画布上用着就应该说出来');
  assert.match(warn as string, /search/, '要点工具名 —— 只说"移除 1"用户不知道是哪个');
  assert.match(warn as string, /工具已不存在/);
  assert.match(warn as string, /参数结构变了/);
  assert.match(warn as string, /3 个/, '要说总共有几个节点受影响');
});

/*
 * 只盯"会不会说"的话，把**没被用到**的移除也报出来照样通过 ——
 * 于是每次刷新都刷一句警告，警告就不值钱了。
 */
test('没被用到的变化不说（否则每次刷新都报警告）', () => {
  const diffs = diffBlueprints([mk('search', [f('q')])], []);
  assert.equal(describeAffected(diffs, {}), null, '没人用就不该说');
  assert.equal(
    describeAffected(diffs, { 'mcp:fs:other': 5 }),
    null,
    '变化的那个工具没人用，别拿别的工具凑数',
  );
});

test('纯新增不说（新增不影响任何已有节点）', () => {
  const diffs = diffBlueprints([], [mk('new', [])]);
  assert.equal(describeAffected(diffs, { 'mcp:fs:new': 3 }), null);
});

/* ================= 守卫：hook 必须真的接上 ================= */

test('刷新后要点名受影响的工具（不能只报数字）', async () => {
  const { readSrc } = await import('./srcScan');
  const src = readSrc('hooks/useMcpRegistry.ts', 'App.tsx');
  assert.match(src, /countMcpUsage/, '要真的去数画布上的节点');
  /*
   * 不能只查"文件里出现了 describeAffected" ——
   * 把它留在 `if (false && ...)` 里同样匹配得上，而那时一句都不会说。
   * （实测：这么注入 7 条全绿，守卫是假的。）
   *
   * 所以盯**刷新结果处理区**：从 onLog(r.message) 往后这一小段，
   * 既要有调用，也不许出现恒假的短路。
   */
  const i = src.indexOf('onLog(r.message)');
  assert.ok(i > 0, '要先把刷新结果说出去');
  const tail = src.slice(i, i + 500);
  assert.match(tail, /describeAffected/, '算了得说出来 —— 这个函数此前零调用点');
  assert.doesNotMatch(tail, /false\s*&&/, '不许出现恒假的短路（那就等于没接上）');
});
