import test from 'node:test';
import assert from 'node:assert/strict';
import { evalExpr, funcNames } from '../engine/expr';

const v = (r: { ok: boolean; value?: number }) => (r as { ok: true; value: number }).value;
const e = (r: { ok: boolean; error?: string }) => (r as { ok: false; error: string }).error;

test('四则与优先级', () => {
  assert.equal(v(evalExpr('2+3*4')), 14);
  assert.equal(v(evalExpr('(2+3)*4')), 20);
  assert.equal(v(evalExpr('10-2-3')), 5);
  assert.equal(v(evalExpr('10/4')), 2.5);
  assert.equal(v(evalExpr('10%3')), 1);
});

test('乘方右结合', () => {
  assert.equal(v(evalExpr('2^3^2')), 512);
});

test('一元负号', () => {
  assert.equal(v(evalExpr('-5+3')), -2);
  assert.equal(v(evalExpr('-(2+3)')), -5);
});

test('小数与科学计数', () => {
  assert.equal(v(evalExpr('1.5*2')), 3);
  assert.equal(v(evalExpr('.5*4')), 2);
  assert.equal(v(evalExpr('1e3')), 1000);
});

/* ================= 变量 ================= */

test('变量代入', () => {
  assert.equal(v(evalExpr('攻击力*2', { 攻击力: 100 })), 200);
});

/** 这条最要紧：拼错列名静默算成 0 会得到"看着合理但完全错误"的结果 */
test('不认识的变量报错，不静默当 0', () => {
  const r = evalExpr('攻击力*2', { 功击力: 100 });
  assert.equal(r.ok, false);
  assert.ok(e(r).includes('不认识的变量'), e(r));
});

test('中文列名能用', () => {
  assert.equal(v(evalExpr('暴击率 + 暴击伤害', { 暴击率: 0.3, 暴击伤害: 1.5 })), 1.8);
});

/* ================= 函数 ================= */

test('round / floor / ceil / abs / sqrt', () => {
  assert.equal(v(evalExpr('round(2.6)')), 3);
  assert.equal(v(evalExpr('floor(2.6)')), 2);
  assert.equal(v(evalExpr('ceil(2.2)')), 3);
  assert.equal(v(evalExpr('abs(-5)')), 5);
  assert.equal(v(evalExpr('sqrt(9)')), 3);
});

test('min / max / pow', () => {
  assert.equal(v(evalExpr('min(3,7,1)')), 1);
  assert.equal(v(evalExpr('max(3,7,1)')), 7);
  assert.equal(v(evalExpr('pow(2,10)')), 1024);
});

/** clamp 在数值推导里极常用（钳制上下限） */
test('clamp 钳制上下限', () => {
  assert.equal(v(evalExpr('clamp(150, 0, 100)')), 100);
  assert.equal(v(evalExpr('clamp(-5, 0, 100)')), 0);
  assert.equal(v(evalExpr('clamp(50, 0, 100)')), 50);
});

test('不认识的函数会列出可用的', () => {
  const r = evalExpr('foo(1)');
  assert.equal(r.ok, false);
  assert.ok(e(r).includes('不认识的函数'), e(r));
});

test('参数个数不对会报错', () => {
  assert.equal(evalExpr('clamp(1,2)').ok, false);
});

/* ================= 错误提示 ================= */

test('全角符号单独提示（最常见的输入错误）', () => {
  const r = evalExpr('2＋3');
  assert.equal(r.ok, false);
  assert.ok(e(r).includes('全角'), e(r));
});

test('括号没闭合', () => {
  assert.ok(e(evalExpr('(1+2')).includes('括号'));
});

test('空表达式', () => {
  assert.equal(evalExpr('').ok, false);
  assert.equal(evalExpr('   ').ok, false);
});

test('多余内容', () => {
  assert.equal(evalExpr('1 2').ok, false);
});

test('除零当 0，不报错', () => {
  assert.equal(v(evalExpr('10/0')), 0);
});

test('函数清单不为空', () => {
  assert.ok(funcNames().length > 0);
  assert.ok(funcNames().includes('clamp'));
});

/* ================= 比较运算（筛选条件要用） ================= */

test('大于 / 大于等于', () => {
  assert.equal(v(evalExpr('等级 > 50', { 等级: 60 })), 1);
  assert.equal(v(evalExpr('等级 > 50', { 等级: 40 })), 0);
  assert.equal(v(evalExpr('等级 >= 50', { 等级: 50 })), 1);
});

test('小于 / 小于等于', () => {
  assert.equal(v(evalExpr('等级 < 50', { 等级: 40 })), 1);
  assert.equal(v(evalExpr('等级 <= 50', { 等级: 50 })), 1);
});

test('等于 / 不等于', () => {
  assert.equal(v(evalExpr('等级 == 50', { 等级: 50 })), 1);
  assert.equal(v(evalExpr('等级 != 50', { 等级: 50 })), 0);
});

/** 单等号也接受 —— 用户从 Excel 公式过来习惯这么写 */
test('单个 = 也当等于用', () => {
  assert.equal(v(evalExpr('等级 = 50', { 等级: 50 })), 1);
});

test('比较与算术能混用（筛选"差值大于阈值"）', () => {
  assert.equal(v(evalExpr('攻击 - 防御 > 50', { 攻击: 100, 防御: 30 })), 1);
  assert.equal(v(evalExpr('攻击 - 防御 > 50', { 攻击: 60, 防御: 30 })), 0);
});
