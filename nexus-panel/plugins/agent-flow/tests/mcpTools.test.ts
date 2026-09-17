import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBlueprint, buildBlueprints, createMcpData, mcpArgsOf, missingRequired,
  mcpTypeOf, isMcpType, slugify, groupByServer, signatureOf,
  diffBlueprints, refreshBreaksNodes, mcpColorOf,
  exportBlueprints, importBlueprints, mergeBlueprints,
  type McpToolSchema,
} from '../engine/mcpTools';

const tool = (name: string, props: Record<string, unknown>, req: string[] = [], desc = ''): McpToolSchema => ({
  name, description: desc,
  inputSchema: { type: 'object', properties: props as never, required: req },
});

/* ================= 生成 ================= */

test('基本的工具 schema 能生成出节点', () => {
  const bp = buildBlueprint('notion', tool('create_page', { title: { type: 'string' } }, ['title']));
  assert.ok(bp);
  assert.equal(bp.tool, 'create_page');
  assert.equal(bp.dataKind, 'mcp', '所有生成节点共用一个 dataKind');
  assert.equal(bp.fields.length, 1);
  assert.equal(bp.fields[0].required, true);
});

test('工具没名字 → 返回 null，不塞进侧栏', () => {
  assert.equal(buildBlueprint('x', { name: '' }), null);
});

/**
 * 这条守的是"外部输入污染注册表" ——
 * server 名与工具名来自外部，不加前缀可能撞上内置的 task / log，
 * 撞了会**静默覆盖**内置节点：侧栏里原本的节点凭空变了行为。
 */
test('生成的 type 带 mcp: 前缀，撞不上内置节点', () => {
  const t = mcpTypeOf('my server', 'read.file');
  assert.ok(t.startsWith('mcp:'), `实际：${t}`);
  assert.ok(isMcpType(t));
  assert.ok(!isMcpType('task'), '内置 type 不该被认成 MCP');
  assert.ok(!isMcpType('log'));
});

test('slugify 把空格点杠压成安全的下划线', () => {
  assert.equal(slugify('Notion MCP'), 'notion_mcp');
  assert.equal(slugify('fs.read_file'), 'fs_read_file');
  assert.equal(slugify('a/b'), 'a_b');
  assert.equal(slugify(''), 'x', '空名不能生成空片段 —— 那会拼出 "mcp::"');
});

/* ================= 类型映射 ================= */

test('enum → select，boolean → switch，数字 → number', () => {
  const bp = buildBlueprint('x', tool('t', {
    kind: { type: 'string', enum: ['a', 'b'] },
    flag: { type: 'boolean' },
    n: { type: 'integer' },
  }));
  assert.ok(bp);
  const byKey = new Map(bp.fields.map((f) => [f.key, f]));
  assert.equal(byKey.get('kind')?.kind, 'select');
  assert.deepEqual(byKey.get('kind')?.options, ['a', 'b']);
  assert.equal(byKey.get('flag')?.kind, 'switch');
  assert.equal(byKey.get('n')?.kind, 'number');
});

test('嵌套对象 → JSON 文本框，并标注 degraded', () => {
  const bp = buildBlueprint('x', tool('t', { body: { type: 'object' }, tags: { type: 'array' } }));
  assert.ok(bp);
  for (const f of bp.fields) {
    assert.equal(f.kind, 'textarea');
    assert.equal(f.degraded, true, '降级字段要标注');
    assert.ok(f.hint?.includes('JSON'), '降级字段必须说明填 JSON，否则用户不知道写什么');
  }
});

test('type 是数组时取第一个非 null 的（OpenAPI 风格）', () => {
  const bp = buildBlueprint('x', tool('t', { a: { type: ['string', 'null'] } }));
  assert.ok(bp);
  assert.equal(bp.fields[0].kind, 'text', '不该因为 type 是数组就退化');
});

test('名字/说明暗示长文本时用 textarea', () => {
  const bp = buildBlueprint('x', tool('t', { content: { type: 'string' } }));
  assert.ok(bp);
  assert.equal(bp.fields[0].kind, 'textarea');
});

/* ================= 参数与校验 ================= */

test('建节点数据：参数平铺在 data 上，不套一层', () => {
  const bp = buildBlueprint('x', tool('t', { a: { type: 'string' } }));
  assert.ok(bp);
  const d = createMcpData(bp, { id: 'n1' });
  assert.equal(d.kind, 'mcp');
  assert.equal(d.mcpTool, 't');
  assert.ok('a' in d, '参数要平铺 —— 套一层 args 会让通用机制（校验/卡片）失效');
  assert.equal(d.a, '');
});

/**
 * 只发有值的参数 ——
 * 把一堆空串发出去，server 会把"没填"和"填了空"当同一回事，
 * 而这两者语义通常不同。
 */
test('取参数时跳过空值', () => {
  const bp = buildBlueprint('x', tool('t', { a: { type: 'string' }, b: { type: 'string' } }));
  assert.ok(bp);
  const args = mcpArgsOf({ a: 'x', b: '' }, bp);
  assert.deepEqual(args, { a: 'x' });
});

test('降级字段尽力解析成真对象', () => {
  const bp = buildBlueprint('x', tool('t', { o: { type: 'object' } }));
  assert.ok(bp);
  assert.deepEqual(mcpArgsOf({ o: '{"k":1}' }, bp), { o: { k: 1 } });
  // 解析不了就原样发，让 server 去报错，而不是这里静默吞掉
  assert.deepEqual(mcpArgsOf({ o: 'not json' }, bp), { o: 'not json' });
});

test('必填缺失能在执行前发现', () => {
  const bp = buildBlueprint('x', tool('t', { a: { type: 'string' }, b: { type: 'string' } }, ['a']));
  assert.ok(bp);
  assert.deepEqual(missingRequired({ a: '', b: 'x' }, bp), ['a']);
  assert.deepEqual(missingRequired({ a: 'x' }, bp), []);
});

/* ================= 重名 ================= */

test('名字压成同一标识的只留一个，不静默覆盖', () => {
  const r = buildBlueprints('x', [
    tool('read_file', {}),
    tool('read.file', {}),
  ]);
  assert.equal(r.list.length, 1, '两个工具压成了同一个 type，应只留一个');
  assert.equal(r.skipped.length, 1);
  assert.ok(r.skipped[0].reason.includes('同一个标识'));
});

test('坏掉的 schema 被跳过并说明原因', () => {
  const r = buildBlueprints('x', [{ name: '' } as never, tool('ok', {})]);
  assert.equal(r.list.length, 1);
  assert.ok(r.skipped.some((s) => s.reason.includes('名字')));
});

/* ================= 分组 ================= */

test('按 server 分组，组内按工具名排序（顺序要稳定）', () => {
  const list = [
    ...buildBlueprints('zeta', [tool('b', {}), tool('a', {})]).list,
    ...buildBlueprints('alpha', [tool('c', {})]).list,
  ];
  const g = groupByServer(list);
  assert.equal(g.length, 2);
  assert.equal(g[0].server, 'alpha', '组要按 server 名排序 —— 否则刷新时位置会跳');
  assert.deepEqual(g[0].blueprints.map((b) => b.tool), ['c']);
  assert.deepEqual(g[1].blueprints.map((b) => b.tool), ['a', 'b']);
});

test('同一个 server 拿到同一种颜色', () => {
  assert.equal(mcpColorOf('notion'), mcpColorOf('notion'));
  assert.notEqual(mcpColorOf('notion'), mcpColorOf('figma'));
});

/* ================= 差异比对 ================= */

const mk = (name: string, props: Record<string, unknown>, req: string[] = []) =>
  buildBlueprint('fs', tool(name, props, req)) as NonNullable<ReturnType<typeof buildBlueprint>>;

test('新增工具算 added，不影响已有节点', () => {
  const a = [mk('read', { path: { type: 'string' } })];
  const b = [mk('read', { path: { type: 'string' } }), mk('list', {})];
  const d = diffBlueprints(a, b);
  assert.deepEqual(d.map((x) => x.kind), ['added']);
  assert.equal(refreshBreaksNodes(d), false, '新增不该算"会弄坏已有节点"');
});

test('字段变了算 changed，且会弄坏已有节点', () => {
  const a = [mk('read', { path: { type: 'string' } })];
  const b = [mk('read', { path: { type: 'string' }, enc: { type: 'string' } })];
  const d = diffBlueprints(a, b);
  assert.deepEqual(d.map((x) => x.kind), ['changed']);
  assert.equal(refreshBreaksNodes(d), true);
});

test('工具被删算 removed', () => {
  const a = [mk('read', {}), mk('write', {})];
  const b = [mk('read', {})];
  const d = diffBlueprints(a, b);
  assert.deepEqual(d.map((x) => x.kind), ['removed']);
});

/**
 * 只改说明文字不算变化 ——
 * 拿 description 当变化依据会造成大量无意义的"有更新"提示。
 */
test('只改说明不算变化', () => {
  const a = [buildBlueprint('fs', tool('read', { path: { type: 'string' } }, [], '旧说明'))];
  const b = [buildBlueprint('fs', tool('read', { path: { type: 'string' } }, [], '新说明'))];
  assert.equal(diffBlueprints(a as never, b as never).length, 0);
});

test('signatureOf 区分必填性', () => {
  const a = mk('t', { x: { type: 'string' } }, []);
  const b = mk('t', { x: { type: 'string' } }, ['x']);
  assert.notEqual(signatureOf(a), signatureOf(b));
});

/* ================= 导入导出 ================= */

test('导出的文件带格式标记，能再导入回来', () => {
  const list = [mk('read', { path: { type: 'string' } })];
  const text = exportBlueprints(list);
  const r = importBlueprints(text);
  assert.equal(r.list.length, 1);
  assert.equal(r.list[0].tool, 'read');
  assert.equal(r.skipped.length, 0);
});

test('坏 JSON 不抛异常，回报原因', () => {
  const r = importBlueprints('not json');
  assert.equal(r.list.length, 0);
  assert.ok(r.skipped[0].reason.includes('JSON'));
});

test('非本工具导出的文件被拒', () => {
  const r = importBlueprints(JSON.stringify({ format: 'other/v1', blueprints: [] }));
  assert.ok(r.skipped[0].reason.includes('不是本工具'));
});

/**
 * 只接受 mcp: 前缀 ——
 * 放行任意 type 会让一份导入文件有能力**覆盖注册表中的内置节点**。
 * 那不是"导入节点"，是"替换别人的节点"。
 */
test('不带 mcp: 前缀的条目被拒（防覆盖内置节点）', () => {
  const r = importBlueprints(JSON.stringify({
    format: 'agent-flow.mcp-blueprints/v1',
    blueprints: [{ type: 'task', dataKind: 'task', server: 'x', tool: 'y', label: 'z', sub: '', fields: [], generatedAt: 0 }],
  }));
  assert.equal(r.list.length, 0);
  assert.ok(r.skipped[0].reason.includes('mcp:'));
});

test('一份文件里坏了两条，其余照常导入', () => {
  const r = importBlueprints(JSON.stringify({
    format: 'agent-flow.mcp-blueprints/v1',
    blueprints: [
      { type: 'mcp:fs:ok', dataKind: 'mcp', server: 'fs', tool: 'ok', label: 'ok', sub: '', fields: [], generatedAt: 0 },
      { type: 'mcp:fs:bad' },
      null,
    ],
  }));
  assert.equal(r.list.length, 1, '坏的跳过，好的不该被连坐');
  assert.equal(r.skipped.length, 2);
});

test('合并按 type 去重，重复导入不堆副本', () => {
  const a = [mk('read', {})];
  const b = [mk('read', {}), mk('write', {})];
  const merged = mergeBlueprints(a, b);
  assert.equal(merged.length, 2, '同 type 应只留一条');
});
