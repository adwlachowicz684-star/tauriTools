import test from 'node:test';
import assert from 'node:assert/strict';
import { mathOp, textOp, compareOp, randomOp, num, fmt, opSummary } from '../engine/ops';

const v = (r: { ok: boolean; value?: string; error?: string }) =>
  (r as { ok: true; value: string }).value;

/* ================= 数字解析 ================= */

test('空与非数字按 0 处理（不报错）', () => {
  assert.equal(num(''), 0);
  assert.equal(num('abc'), 0);
  assert.equal(num(undefined), 0);
  assert.equal(num('  12  '), 12);
});

test('支持百分号与千分位', () => {
  assert.equal(num('50%'), 0.5);
  assert.equal(num('1,234'), 1234);
});

/**
 * 整数不显示小数点 ——
 * 显示成 2.0 会让下游比较节点按文本比对时匹配不上。
 */
test('整数不带小数点', () => {
  assert.equal(fmt(2), '2');
  assert.equal(fmt(2.5), '2.5');
});

test('浮点尾巴被收掉（0.1+0.2）', () => {
  assert.equal(v(mathOp('add', '0.1', '0.2')), '0.3');
});

/* ================= 数学 ================= */

test('加减乘除取余', () => {
  assert.equal(v(mathOp('add', 2, 3)), '5');
  assert.equal(v(mathOp('sub', 5, 3)), '2');
  assert.equal(v(mathOp('mul', 4, 3)), '12');
  assert.equal(v(mathOp('div', 10, 4)), '2.5');
  assert.equal(v(mathOp('mod', 10, 3)), '1');
});

test('除零明确报错（结果没有合理默认值）', () => {
  const r = mathOp('div', 10, 0);
  assert.equal(r.ok, false);
  assert.ok((r as { error: string }).error.includes('0'));
});

test('取最值与取整', () => {
  assert.equal(v(mathOp('min', 3, 7)), '3');
  assert.equal(v(mathOp('max', 3, 7)), '7');
  assert.equal(v(mathOp('round', '2.6', '')), '3');
  assert.equal(v(mathOp('floor', '2.6', '')), '2');
  assert.equal(v(mathOp('ceil', '2.2', '')), '3');
  assert.equal(v(mathOp('abs', '-5', '')), '5');
});

/* ================= 文本 ================= */

test('拼接 / 长度 / 大小写 / 去空格', () => {
  assert.equal(v(textOp('concat', 'a', 'b')), 'ab');
  assert.equal(v(textOp('length', 'hello', '')), '5');
  assert.equal(v(textOp('upper', 'ab', '')), 'AB');
  assert.equal(v(textOp('lower', 'AB', '')), 'ab');
  assert.equal(v(textOp('trim', '  x  ', '')), 'x');
});

test('替换：默认替换全部', () => {
  assert.equal(v(textOp('replace', 'a-b-c', '-', '/')), 'a/b/c');
});

/** 位置从 1 开始数 —— 与用户直觉一致 */
test('取子串位置从 1 开始', () => {
  assert.equal(v(textOp('substr', 'abcdef', '2', '4')), 'bcd');
  assert.equal(v(textOp('substr', 'abcdef', '1', '')), 'abcdef');
});

test('取第几段', () => {
  assert.equal(v(textOp('split', 'a,b,c', ',', '2')), 'b');
  // 越界给空而不是报错
  assert.equal(v(textOp('split', 'a,b', ',', '9')), '');
});

test('重复次数有上限（防卡死）', () => {
  assert.equal(v(textOp('repeat', 'ab', '2')), 'abab');
  assert.equal(textOp('repeat', 'a', '999999').ok, false);
});

/* ================= 比较 ================= */

/** 这条最要紧：字符串比较下 "10" < "9" 会成立，且不报错 */
test('两边是数字就按数字比（10 大于 9）', () => {
  assert.equal(v(compareOp('gt', '10', '9')), 'true');
  assert.equal(v(compareOp('lt', '10', '9')), 'false');
});

test('非数字按文本比', () => {
  assert.equal(v(compareOp('eq', 'abc', 'abc')), 'true');
  assert.equal(v(compareOp('gt', 'b', 'a')), 'true');
});

test('包含 / 开头 / 结尾', () => {
  assert.equal(v(compareOp('contains', 'hello', 'ell')), 'true');
  assert.equal(v(compareOp('startsWith', 'hello', 'he')), 'true');
  assert.equal(v(compareOp('endsWith', 'hello', 'lo')), 'true');
});

/**
 * 输出 'true'/'false' 而不是空串 ——
 * 空串在条件节点里会被当成"没内容"，从而走错分支。
 */
test('比较结果一定是 true/false 文本，不是空', () => {
  assert.equal(v(compareOp('eq', 'a', 'b')), 'false');
  assert.notEqual(v(compareOp('eq', 'a', 'b')), '');
});

/* ================= 随机 ================= */

/** 固定 rng 序列，让随机可测 */
const seq = (xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]; };

test('随机整数在范围内', () => {
  assert.equal(v(randomOp('int', '1', '3', seq([0]))), '1');
  assert.equal(v(randomOp('int', '1', '3', seq([0.999]))), '3');
});

test('范围反了会报错', () => {
  assert.equal(randomOp('int', '5', '1').ok, false);
});

test('随机选一个', () => {
  assert.equal(v(randomOp('pick', 'a,b,c', '', seq([0]))), 'a');
  assert.equal(v(randomOp('pick', 'a,b,c', '', seq([0.99]))), 'c');
});

test('没得选会报错', () => {
  assert.equal(randomOp('pick', '', '').ok, false);
});

test('打乱保留全部元素', () => {
  const r = randomOp('shuffle', 'a,b,c', '', seq([0.5, 0.2, 0.9]));
  assert.equal(r.ok, true);
  assert.equal(v(r).split(',').sort().join(','), 'a,b,c');
});

/* ================= 摘要 ================= */

test('摘要覆盖四类运算', () => {
  assert.equal(opSummary('math', 'add'), '＋');
  assert.equal(opSummary('text', 'concat'), '拼接');
  assert.equal(opSummary('compare', 'gt'), '大于');
  assert.equal(opSummary('random', 'pick'), '随机选一个');
});
