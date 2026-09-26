import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveParams, describeBlock, describeAll, conventions, pickBrief, producesDescOf,
  catalog, outFieldsOf, type FieldLike,
} from '../engine/blockApi';
import { NODE_OUTPUTS } from '../engine/paramLinks';

/**
 * 积木描述 API —— 运行时查询接口（docs/ 是它的离线快照）。
 *
 * 这个文件的价值在于它是**运行时**的：永远最新，不像文档会因
 * "改了代码没重新生成"而过期。后面的 AI 拼装功能会直接用它。
 */

/* ================= 聚合逻辑 ================= */

test('同一个 key 的多个块要聚合，后面的补前面的缺失说明', () => {
  const fields: FieldLike[] = [
    { type: 'custom', extraKeys: ['sourceLang'] },
    { type: 'text', key: 'sourceLang', label: '源语言', hint: '留空自动识别' },
  ];
  const { rows } = deriveParams(fields);
  assert.equal(rows.length, 1, '同一个 key 不能出两行');
  assert.equal(rows[0].key, 'sourceLang');
  assert.equal(rows[0].label, '源语言');
  assert.ok(rows[0].hint?.includes('自动识别'));
  assert.equal(rows[0].type, 'text', '应优先用非 custom 的块');
});

test('custom 块没有说明时给兜底文案（免得参数表一片空白）', () => {
  const { rows } = deriveParams([{ type: 'custom', key: 'x' }]);
  assert.ok(rows[0].hint, 'custom 块要有兜底说明');
});

test('note 块收进 notes，不占参数行', () => {
  const { rows, notes } = deriveParams([
    { type: 'note', content: '上限 10 分钟' },
    { type: 'number', key: 'ms' },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].includes('10 分钟'));
});

test('options 只取一次，不被后面的空块覆盖', () => {
  const { rows } = deriveParams([
    { type: 'select', key: 'm', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }] },
    { type: 'text', key: 'm' },
  ]);
  assert.equal(rows[0].options.length, 2);
});

/* ================= describeBlock ================= */

test('不传 fields 也能给出契约侧信息（纯 Node 环境可用）', () => {
  const d = describeBlock('translate');
  assert.ok(d);
  assert.equal(d.produces, 'text');
  assert.ok(d.requires.includes('llmCaller'));
  assert.ok(d.hiddenParams.some((h) => h.key === 'llm'));
  assert.equal(d.params.length, 0, '没给 fields 就不该凭空造参数');
});

test('传了 fields 就有完整参数表', () => {
  const d = describeBlock('translate', [{ type: 'text', key: 'text', label: '待翻译' }]);
  assert.ok(d);
  assert.ok(d.params.some((p) => p.key === 'text'));
});

test('能力签名一并给出（AI 知道怎么调，不用再去翻类型）', () => {
  const d = describeBlock('generic-http');
  assert.ok(d);
  assert.ok(d.signatures.httpRequester, '缺 httpRequester 的签名');
});

test('未知 kind 返回 null，不抛异常', () => {
  assert.equal(describeBlock('no-such-kind'), null);
});

test('manualParams 的节点走契约里手写的参数', () => {
  const d = describeBlock('condition');
  assert.ok(d);
  assert.equal(d.paramsFromFields, false);
  assert.ok(d.params.some((p) => p.key === 'rules'));
});

/* ================= 全局约定 ================= */

test('conventions 给出模板变量 / 边结构 / 能力签名', () => {
  const c = conventions();
  assert.ok(c.templateVars.length >= 5);
  assert.ok(c.templateVars.some((v) => v.syntax === '{{input}}'), '必须有 {{input}}');
  assert.ok(c.edgeShape.length >= 2);
  assert.ok(c.branchEdgeExample.includes('branch'));
  assert.ok(Object.keys(c.capabilitySignatures).length >= 5);
});

test('describeAll 覆盖全部积木', () => {
  const all = describeAll();
  assert.ok(all.length >= 20);
  for (const b of all) {
    assert.ok(b.kind && b.produces, `${b.kind} 缺产出`);
  }
});

/**
 * 这条是这套 API 存在的意义 —— 它和 docs/ 共用同一份聚合逻辑，
 * 所以两者的参数表不可能对不上。各写一份的话必然漂移。
 */
test('deriveParams 与文档生成器共用逻辑（改一处两边同时生效）', () => {
  const { rows } = deriveParams([
    { type: 'custom', extraKeys: ['a', 'b'] },
    { type: 'text', key: 'a', label: '甲' },
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.key === 'a')?.label, '甲');
  assert.equal(rows.find((r) => r.key === 'b')?.label, null);
});

/* ================= 一句话说明 ================= */

/*
 * 侧栏那行短说明与展开块顶行**必须取同一句**。
 *
 * 两处各排各的序时，同一个节点点开与不点开会看到两句话 ——
 * 两句都没错，错的是排了两处。
 */
test('pickBrief：预设说明 > 用途 > 产出', () => {
  assert.equal(pickBrief({ hint: '自定义 · 基于任务', sub: '用途', produces: '产出' }), '自定义 · 基于任务');
  assert.equal(pickBrief({ hint: '', sub: '用途', produces: '产出' }), '用途');
  // 产出只作兜底：没写用途时总比整行空白好
  assert.equal(pickBrief({ hint: '', sub: '', produces: '产出' }), '产出');
  assert.equal(pickBrief({}), '');
});

test('pickBrief：空白串不算有值（不会顶掉后面的来源）', () => {
  /*
   * 用 || 而不是 ?? 的理由就在这里：
   * 空串当"有值"的话，一个空 hint 会把整行说明变成空白，
   * 而界面上看不出是没写还是写空了。
   */
  assert.equal(pickBrief({ hint: '   ', sub: '用途' }), '用途');
});

test('产出说明取得到（fallback 用）', () => {
  assert.equal(producesDescOf('canvasIn'), '外部传进来的内容（原样透传）');
  // 未知 kind 给空串，不能抛
  assert.equal(producesDescOf('nope'), '');
  assert.equal(producesDescOf(undefined), '');
});

/* ================= 具名输出字段 ================= */

/*
 * 以下三条盯的是同一件事的**两个方向**：
 *
 *   1. 契约里能取到（不然 AI 只能猜字段名，猜错是静默的空串）
 *   2. 清单来自 NODE_OUTPUTS，不是这里另写一份（写两份必然漂移）
 *
 * 只做方向 1 的话，把 outFieldsOf 改成一个写死的常量数组也能过，
 * 而那正是"同一件事写两遍"的开头。所以方向 2 用**反向对账**：
 * NODE_OUTPUTS 里登记的每个 kind，catalog 里都必须有对应字段。
 */

test('具名输出字段进了契约 —— AI 不再只能猜 {{节点id.字段名}}', () => {
  const byKind = new Map(catalog().map((b) => [b.kind, b]));
  for (const [kind, ports] of Object.entries(NODE_OUTPUTS)) {
    const named = ports.filter((p) => p.key !== 'out');
    if (named.length === 0) continue;
    const info = byKind.get(kind);
    assert.ok(info, `${kind} 不在契约里`);
    assert.equal(
      info.outFields.length,
      named.length,
      `${kind} 的具名输出字段数对不上：契约 ${info.outFields.length} vs 出口表 ${named.length}`,
    );
  }
});

test('CLI 的八个文件字段能从契约取到（不是只有「结论」一个口）', () => {
  const task = catalog().find((b) => b.kind === 'task');
  assert.ok(task);
  const keys = task.outFields.map((f) => f.key);
  assert.ok(keys.includes('fileName'), 'CLI 产出的文件名必须可取');
  assert.ok(keys.includes('file'), 'CLI 产出的文件路径必须可取');
  assert.ok(keys.length >= 8, `CLI 应有 8 个文件字段，实际 ${keys.length}`);
  // 标签是人话名字，不是 key
  for (const f of task.outFields) {
    assert.ok(f.label.length > 0, `${f.key} 没有显示名`);
  }
});

test('窗格字段写在契约里 —— paneField 是函数调用，扫描器看不见', () => {
  for (const kind of ['task', 'llmChat']) {
    const info = catalog().find((b) => b.kind === kind);
    assert.ok(info, `${kind} 不在契约里`);
    const keys = info.hiddenParams.map((p) => p.key);
    assert.ok(keys.includes('paneId'), `${kind} 的 paneId 没写进 hiddenParams`);
  }
});

test('不传清单时 outFields 为空 —— 那是"没提供"，不是"没有字段"', () => {
  assert.deepEqual(outFieldsOf('math'), []);
  assert.ok(outFieldsOf('update').some((f) => f.key === 'title'));
});
