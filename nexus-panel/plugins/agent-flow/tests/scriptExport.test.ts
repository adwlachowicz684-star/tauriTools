import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFlow, exportAll, EXPORT_FORMATS } from '../engine/scriptExport';

const n = (id: string, kind: string, data = {}) => ({
  id, data: { kind, label: id, status: 'idle', output: '', error: '', ...data },
});
const e = (a: string, b: string) => ({ id: `${a}->${b}`, source: a, target: b });

const g = (nodes: unknown[], edges: unknown[] = []) => ({ nodes, edges }) as never;

/* ================= 四种格式 ================= */

test('四种格式都产出非空内容', () => {
  const graph = g([n('w1', 'wait', { ms: 2000 }), n('l1', 'log', { text: 'hi' })], [e('w1', 'l1')]);
  const all = exportAll(graph);
  for (const f of EXPORT_FORMATS) {
    assert.ok(all[f.id].text.length > 0, `${f.id} 导出为空`);
  }
});

test('shell：等待节点变成 sleep，毫秒换算成秒', () => {
  const r = exportFlow(g([n('w1', 'wait', { ms: 2000 })]), 'shell');
  assert.ok(r.text.includes('sleep 2.000'), `实际：${r.text}`);
});

/*
 * 第一版用单引号包字符串，于是文本里的单引号要转义成 '\''。
 * 现在整句用**双引号**包（内部双引号转义），单引号不再是问题 ——
 * 但双引号必须转义，否则引号一多就断。
 */
test('shell：log 文本里的双引号要转义', () => {
  const r = exportFlow(g([n('l1', 'log', { text: 'say "hi" now' })]), 'shell');
  assert.ok(r.text.includes('\\"hi\\"'), `双引号没转义：${r.text}`);
});

test('shell：log 文本里的单引号不需要转义（双引号包着）', () => {
  const r = exportFlow(g([n('l1', 'log', { text: "it's ok" })]), 'shell');
  assert.ok(r.text.includes("it's ok"), '单引号被弄坏了');
});

test('shell：HTTP 节点变成 curl', () => {
  const r = exportFlow(g([n('h1', 'generic-http', { url: 'https://a.b/c', method: 'POST', body: '{}' })]), 'shell');
  assert.ok(r.text.includes('curl'));
  assert.ok(r.text.includes('-X POST'));
  assert.ok(r.text.includes('--data'));
});

test('python：HTTP 变 requests，等待变 time.sleep', () => {
  const r = exportFlow(g([
    n('h1', 'generic-http', { url: 'https://a.b/c', method: 'GET' }),
    n('w1', 'wait', { ms: 1500 }),
  ]), 'python');
  assert.ok(r.text.includes('requests.get'));
  assert.ok(r.text.includes('time.sleep(1.5)'));
  assert.ok(r.text.includes('import requests'));
});

test('json：带格式标记，可导入重放', () => {
  const r = exportFlow(g([n('w1', 'wait', { ms: 1 })]), 'json');
  const parsed = JSON.parse(r.text);
  assert.equal(parsed.format, 'agent-flow/v1');
  assert.equal(parsed.nodes.length, 1);
});

test('markdown：逐步列出，标出顺序与上游', () => {
  const r = exportFlow(g([n('w1', 'wait', { ms: 1 }), n('l1', 'log', { text: 'x' })], [e('w1', 'l1')]), 'markdown');
  assert.ok(r.text.includes('## 1.'));
  assert.ok(r.text.includes('## 2.'));
  assert.ok(r.text.includes('接 w1'));
});

/* ================= 不可翻译的必须显式 ================= */

test('翻译不了的节点要出现在 skipped 里，并在文本里留 TODO', () => {
  const r = exportFlow(g([n('c1', 'condition', { rules: [] })]), 'shell');
  assert.equal(r.skipped.length, 1, '条件节点没被标记成未翻译');
  assert.ok(r.text.includes('TODO'), '文本里没留 TODO —— 用户会以为翻完了');
});

test('skipped 要说清原因，不是笼统一句', () => {
  const r = exportFlow(g([n('c1', 'condition')]), 'python');
  assert.ok(r.skipped[0].reason.length > 0);
  assert.equal(r.skipped[0].kind, 'condition');
});

test('控制流节点在 markdown 里要提醒"看不到分支"', () => {
  const r = exportFlow(g([n('c1', 'condition')]), 'markdown');
  assert.ok(r.text.includes('控制流'), '没提醒控制流的结构丢失');
});

/**
 * 这条是这套导出的立意 ——
 * 静默跳过的后果是：用户拿到一份脚本，跑起来"少了点什么"却毫无线索。
 * 宁可生成带 TODO 的脚本，也不要生成看起来完整其实是错的。
 */
test('混合图：能翻的翻出来，翻不了的都留痕', () => {
  const r = exportFlow(g([
    n('w1', 'wait', { ms: 1000 }),
    n('c1', 'condition'),
    n('l1', 'log', { text: 'done' }),
  ], [e('w1', 'c1'), e('c1', 'l1')]), 'shell');
  assert.ok(r.text.includes('sleep 1.000'), '能翻的没翻出来');
  assert.ok(r.text.includes('done'), '能翻的没翻出来');
  assert.equal(r.skipped.length, 1, '翻不了的没记下来');
  assert.equal(r.count, 2, 'count 应只算成功翻译的');
});

/* ================= 生成的脚本必须是合法的 ================= */

/**
 * 第一版生成的是**语法错误**的脚本：URL 没引号、JSON 路径写成
 * `print(data.items.0.title)`。那比不生成更糟 —— 用户拿到一份
 * 看起来完整的脚本，一跑就报错，还不知道是导出器的毛病。
 */
test('shell：URL 必须有引号（curl 的裸 URL 会语法错误）', () => {
  const r = exportFlow(g([n('h1', 'generic-http', { url: 'https://a.b/c' })]), 'shell');
  assert.ok(/curl[^"]*"https:\/\/a\.b\/c"/.test(r.text), `实际：${r.text}`);
});

test('python：requests 的 URL 必须是字符串字面量', () => {
  const r = exportFlow(g([n('h1', 'generic-http', { url: 'https://a.b/c' })]), 'python');
  assert.ok(/requests\.get\("https:\/\/a\.b\/c"\)/.test(r.text), `实际：${r.text}`);
});

test('JSON 路径生成的是合法索引表达式，不是 d.a.0.b', () => {
  const r = exportFlow(g([n('e1', 'extract', { mode: 'json', path: 'data.items.0.title' })]), 'shell');
  assert.ok(r.text.includes('["data"]'), '路径没转成索引');
  assert.ok(r.text.includes('[0]'), '数字段没当下标');
  assert.ok(!/print\(data\./.test(r.text), '还是把路径原样塞进了 print —— 那是语法错误');
});

test('模板引用与生成的变量名必须一致', () => {
  const r = exportFlow(g([
    n('e1', 'extract', { mode: 'json', path: 'a' }),
    n('l1', 'log', { text: '结果 {{e1.output}}' }),
  ], [e('e1', 'l1')]), 'python');
  assert.ok(r.text.includes('out_e1 ='), 'extract 的变量名不对');
  assert.ok(r.text.includes('{out_e1}'), `log 里引用的变量名不一致：${r.text}`);
  assert.ok(!r.text.includes('out_e1_output'), '引用了不存在的变量 —— 运行时取到空值');
});

test('log 没有级别前缀时不该多出空串参数', () => {
  const r = exportFlow(g([n('l1', 'log', { text: 'hi' })]), 'python');
  assert.ok(!r.text.includes('print(f""'), `多了空串参数：${r.text}`);
});

test('成环的节点要被标出来，不能静默丢掉', () => {
  const r = exportFlow(g(
    [n('a1', 'wait', { ms: 1 }), n('b1', 'wait', { ms: 1 })],
    [e('a1', 'b1'), e('b1', 'a1')],
  ), 'shell');
  assert.ok(r.skipped.some((x) => x.reason.includes('环')), '成环没被标记');
});
