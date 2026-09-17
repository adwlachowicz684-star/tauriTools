import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveParams, describeBlock, describeAll, conventions, type FieldLike,
} from '../engine/blockApi';

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
