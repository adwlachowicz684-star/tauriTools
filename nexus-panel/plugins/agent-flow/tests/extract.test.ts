import test from 'node:test';
import assert from 'node:assert/strict';
import { extractText, parseJsonPath, parseLineRule } from '../engine/extract';

/* ---------- JSON 路径解析 ---------- */

test('JSON 路径：支持点号、下标、混合写法', () => {
  assert.deepEqual(parseJsonPath('data.items[0].title'), ['data', 'items', 0, 'title']);
  // 纯数字段也当下标：从接口文档抄下来的路径常是这种
  assert.deepEqual(parseJsonPath('data.items.0.title'), ['data', 'items', 0, 'title']);
  // 根就是数组
  assert.deepEqual(parseJsonPath('[0].title'), [0, 'title']);
  // 连续下标
  assert.deepEqual(parseJsonPath('a.b[2][3]'), ['a', 'b', 2, 3]);
  // 空串不是合法路径
  assert.equal(parseJsonPath('   '), null);
});

/* ---------- JSON 提取 ---------- */

const json = JSON.stringify({
  data: { items: [{ title: '第一条', url: 'https://a' }, { title: '第二条', url: 'https://b' }] },
  count: 2,
  flag: true,
});

test('JSON 提取：取嵌套字段', () => {
  const r = extractText(json, 'json', 'data.items[0].title');
  assert.equal(r.ok, true);
  assert.equal(r.text, '第一条');
});

test('JSON 提取：负数下标从末尾取', () => {
  const r = extractText(json, 'json', 'data.items[-1].title');
  assert.equal(r.ok, true);
  assert.equal(r.text, '第二条');
});

test('JSON 提取：布尔与数字转成字符串（条件节点要能判等于 true）', () => {
  assert.equal(extractText(json, 'json', 'flag').text, 'true');
  assert.equal(extractText(json, 'json', 'count').text, '2');
});

test('JSON 提取：取到对象时转 JSON 并给提示，而不是 [object Object]', () => {
  const r = extractText(json, 'json', 'data.items[0]');
  assert.equal(r.ok, true);
  assert.equal(r.text, '{"title":"第一条","url":"https://a"}');
  assert.match(r.warn ?? '', /JSON 字符串/);
});

test('JSON 提取：路径取不到 / 响应不是 JSON 都要明确报错', () => {
  const miss = extractText(json, 'json', 'data.items[9].title');
  assert.equal(miss.ok, false);
  assert.match(miss.error ?? '', /取不到/);

  const bad = extractText('这不是 JSON', 'json', 'a');
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /不是合法 JSON/);
});

test('JSON 提取：未填路径要给提示，而不是静默返回空', () => {
  const r = extractText(json, 'json', '  ');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /请填写 JSON 路径/);
});

/* ---------- 正则 ---------- */

test('正则：默认取第一个捕获组', () => {
  const r = extractText('标题：今天天气不错\n正文：……', 'regex', '标题[:：]\\s*(.+)');
  assert.equal(r.ok, true);
  assert.equal(r.text, '今天天气不错');
});

test('正则：没写捕获组时取整段匹配（比报错更符合预期）', () => {
  const r = extractText('订单号 A-123 已创建', 'regex', 'A-\\d+');
  assert.equal(r.ok, true);
  assert.equal(r.text, 'A-123');
});

test('正则：没匹配到 / 正则不合法都要说清原因', () => {
  const none = extractText('abc', 'regex', 'zzz');
  assert.equal(none.ok, false);
  assert.match(none.error ?? '', /没有匹配到/);

  const bad = extractText('abc', 'regex', '([a-z');
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? '', /正则不合法/);
});

test('正则：取了不存在的捕获组要报第几个、共几个', () => {
  const r = extractText('abc', 'regex', '(a)(b)', 5);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /第 5 个捕获组/);
});

/* ---------- 按行 ---------- */

const lines = '第一行\n第二行\n第三行';

test('按行：first / last / 行号 / 负数行号', () => {
  assert.equal(extractText(lines, 'line', 'first').text, '第一行');
  assert.equal(extractText(lines, 'line', 'last').text, '第三行');
  assert.equal(extractText(lines, 'line', '1').text, '第二行');
  assert.equal(extractText(lines, 'line', '-1').text, '第三行');
});

test('按行：包含关键字（两种写法都要认）', () => {
  assert.equal(extractText(lines, 'line', 'contains:第三').text, '第三行');
  // 直接写关键字
  assert.equal(extractText(lines, 'line', '第二').text, '第二行');
});

test('按行：行号越界要说共几行', () => {
  const r = extractText(lines, 'line', '99');
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /共 3 行/);
});

test('按行：规则解析', () => {
  assert.deepEqual(parseLineRule('first'), { kind: 'first' });
  assert.deepEqual(parseLineRule('last'), { kind: 'last' });
  assert.deepEqual(parseLineRule('-2'), { kind: 'index', value: -2 });
  assert.deepEqual(parseLineRule('contains:x'), { kind: 'contains', value: 'x' });
});

/* ---------- 原样输出 ---------- */

test('原样输出：不做任何处理', () => {
  const r = extractText('  原文  ', 'text', '');
  assert.equal(r.ok, true);
  assert.equal(r.text, '  原文  ');
});

test('空输入不崩', () => {
  assert.equal(extractText('', 'text', '').ok, true);
  assert.equal(extractText('', 'line', 'first').text, '');
  assert.equal(extractText('', 'json', 'a').ok, false);
});
