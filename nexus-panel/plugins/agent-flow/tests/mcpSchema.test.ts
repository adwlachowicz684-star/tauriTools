import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlueprint, buildBlueprints, dedupeByType, missingRequired,
  mcpSidebarGroups, toolCountOf, type McpToolSchema,
} from '../engine/mcpTools';
import { refreshAll } from '../engine/mcpStore';
import { readSrc } from './srcScan';

const tool = (name: string, inputSchema?: unknown): McpToolSchema =>
  ({ name, inputSchema }) as McpToolSchema;

/* ================================================================== */
/* ① 无参工具必须留着（反向：防"过度修复"把合法工具也跳掉）            */
/* ================================================================== */

/*
 * MCP 里"不要参数"的工具是常态（列目录、列资源），
 * 它们的 inputSchema 就是空的 object。
 *
 * 只盯"坏 schema 要跳过"的话，把 fields 为空一律判成坏 schema 也能通过 ——
 * 那样一个正常的无参工具都会被判掉，整个服务可能一个节点都不剩。
 * 所以这一条必须与下面的跳过用例成对存在。
 */
test('无参工具照常生成（fields 为空不是坏 schema）', () => {
  const r = buildBlueprints('fs', [
    { name: 'list_all', inputSchema: { type: 'object', properties: {} } },
  ]);
  assert.equal(r.list.length, 1, '不能把无参工具当坏 schema 跳掉');
  assert.equal(r.list[0].fields.length, 0);
  assert.deepEqual(r.skipped, []);
});

test('根本没给 inputSchema 也当无参处理（现实中有 server 省略它）', () => {
  const r = buildBlueprints('fs', [{ name: 'ping' }]);
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].fields.length, 0);
});

/* ================================================================== */
/* ② 渲染不出来的 schema 要说出来，不能静默当无参                      */
/* ================================================================== */

test('入参不是具名参数（type 非 object）时跳过并说明', () => {
  const r = buildBlueprints('fs', [
    tool('append', { type: 'string' }),
  ]);
  assert.equal(r.list.length, 0, '静默生成会得出一个"看起来无参"的节点，调用时发错参数');
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].reason, /不是一组具名参数/);
});

test('properties 不是对象时跳过（否则会生成叫 0/1/2 的字段）', () => {
  const r = buildBlueprints('fs', [
    { name: 'bad', inputSchema: { properties: 'abc' } } as unknown as McpToolSchema,
  ]);
  assert.equal(r.list.length, 0);
  assert.match(r.skipped[0].reason, /properties 不是对象/);
});

test('坏 schema 与好工具混在一起时，只掉坏的那个', () => {
  const r = buildBlueprints('fs', [
    { name: 'bad', inputSchema: { type: 'string' } },
    { name: 'good', inputSchema: { properties: { p: { type: 'string' } } } },
  ]);
  assert.deepEqual(r.list.map((b) => b.tool), ['good']);
  assert.equal(r.skipped.length, 1);
});

/* ================================================================== */
/* ③ required 点名、properties 里却没有 —— 必须能填、能查到            */
/* ================================================================== */

/*
 * 这是本轮最实在的那个洞：
 *
 * 不补的话该字段同时消失在两个地方 —— 面板上没有格子（用户填不了），
 * 而 missingRequired 只遍历 fields、也查不到它（于是显示"校验通过"）。
 * 执行时把缺参数的请求发给 server，server 报"缺少必填参数 X"，
 * 用户却根本无处可填 X。是个死局。
 */
test('required 里点名但 properties 里没有 → 补一个可填的格子', () => {
  const bp = buildBlueprint('fs', {
    name: 'cp',
    inputSchema: { properties: { a: { type: 'string' } }, required: ['a', 'path'] },
  } as McpToolSchema);
  assert.ok(bp);
  const keys = bp.fields.map((f) => f.key);
  assert.ok(keys.includes('path'), '不补的话用户无处可填 path');
  const path = bp.fields.find((f) => f.key === 'path');
  assert.ok(path);
  assert.equal(path.required, true);
  assert.match(String(path.hint), /没给出定义/, 'hint 要说清这是补的，否则用户以为是原工具的');
});

test('补出来的字段要能被"必填校验"查到（否则还是死局）', () => {
  const bp = buildBlueprint('fs', {
    name: 'cp',
    inputSchema: { properties: { a: { type: 'string' } }, required: ['path'] },
  } as McpToolSchema);
  assert.ok(bp);
  const miss = missingRequired({ kind: 'mcp', a: 'x' }, bp);
  assert.deepEqual(miss, ['path'], '补了格子却查不到必填，等于没补');
});

test('已经在 properties 里的不会被重复补一份', () => {
  const bp = buildBlueprint('fs', {
    name: 't',
    inputSchema: { properties: { p: { type: 'string' } }, required: ['p'] },
  } as McpToolSchema);
  assert.ok(bp);
  assert.equal(bp.fields.filter((f) => f.key === 'p').length, 1);
});

/* ================================================================== */
/* ④ 跨服务：服务名压成同 slug + 同名工具 → 同 type 静默覆盖          */
/* ================================================================== */

test('两个服务压成同 slug、工具又同名 → 只留一个，另一个说清原因', () => {
  const A = buildBlueprints('Notion MCP', [{ name: 'search' }]);
  const B = buildBlueprints('notion.mcp', [{ name: 'search' }]);
  assert.equal(A.list[0].type, B.list[0].type, '这正是会撞车的情形（type 完全相同）');

  const d = dedupeByType([...A.list, ...B.list]);
  assert.equal(d.list.length, 1);
  assert.equal(d.dropped.length, 1);
  assert.equal(d.dropped[0].server, 'notion.mcp');
});

test('真实刷新路径：撞车的那个不进侧栏，且 failures 里说了为什么', async () => {
  const servers = [
    { name: 'Notion MCP', url: 'http://a' },
    { name: 'notion.mcp', url: 'http://b' },
  ];
  const fetcher = async (s: { name: string }) => [
    { name: 'search', description: s.name === 'Notion MCP' ? 'A 的搜索' : 'B 的搜索' },
  ];
  const o = await refreshAll({ servers, previous: [], fetcher });
  assert.equal(o.ok, true);
  assert.equal(o.list.length, 1, '两个都进注册表的话，后注册的会静默覆盖前一个');

  const gs = mcpSidebarGroups(o.list);
  assert.deepEqual(toolCountOf(gs), { 'Notion MCP': 1 });
  const why = o.failures.map((f) => f.reason).join('\n');
  assert.match(why, /压成了同一个标识/, '撞掉了必须说出来 —— 悄悄丢等于少了个工具还不解释');
});

test('不撞车的跨服务同名工具照常各留一份', async () => {
  const servers = [
    { name: 'github', url: 'http://a' },
    { name: 'notion', url: 'http://b' },
  ];
  const fetcher = async () => [{ name: 'search' }];
  const o = await refreshAll({ servers, previous: [], fetcher });
  assert.equal(o.list.length, 2, '正常同名工具不能误伤');
  assert.deepEqual(toolCountOf(mcpSidebarGroups(o.list)), { github: 1, notion: 1 });
});

/* ================================================================== */
/* 源码守卫                                                            */
/* ================================================================== */

test('源码守卫：刷新汇总后必须跨服务排一次队', () => {
  const src = readSrc('engine/mcpStore.ts');
  assert.ok(
    /dedupeByType\s*\(\s*made\s*\)/.test(src),
    'buildBlueprints 的 seen 只覆盖单个服务，跨服务的撞车必须在汇总后再排一次',
  );
});

test('源码守卫：撞掉的要记进 failures（不能悄悄丢）', () => {
  const src = readSrc('engine/mcpStore.ts');
  const i = src.indexOf('dedupeByType(made)');
  assert.ok(i >= 0);
  const seg = src.slice(i, i + 700);
  assert.ok(/failures\.push/.test(seg), '只去重不记录的话，用户看到的是"少了个工具"且没有原因');
});

test('源码守卫：schema 判据只有一份（propsOf），不许在 buildBlueprints 里另写', () => {
  const src = readSrc('engine/mcpTools.ts');
  const i = src.indexOf('export function buildBlueprints');
  assert.ok(i >= 0);
  const seg = src.slice(i, i + 1200);
  assert.ok(/schemaRejectReason/.test(seg), '要用同一份判据给原因，另写一份必然漂移');
  assert.ok(
    !/typeof\s+t\?\.inputSchema\?\.properties/.test(seg),
    '在 buildBlueprints 里另判一遍 properties 就是第二份判据',
  );
});
