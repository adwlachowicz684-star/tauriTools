import test from 'node:test';
import assert from 'node:assert/strict';
import { argTypeIssues, valueKindOf, argTypedKinds } from '../engine/argTypes';
import { validateNode, badgeTextOf } from '../engine/nodeValidate';

/**
 * 参数类型校验。
 *
 * 核心场景（用户实测）：
 *   比较节点选「包含」→ 填「苹果」「果」 → 绿灯
 *   把运算改成「大于」            → **仍然绿灯，但结果是错的**
 *
 * 运行时不会报错：`compareOp` 里两边不是数字就退化成文本比较，
 * 「苹果」>「果」按字典序成立，输出 true。
 * 这是"有合法降级行为"的错误，运行时校验抓不到，只能静态判定。
 */

const cmp = (op: string, a: unknown, b: unknown) =>
  argTypeIssues('compare', { kind: 'compare', op, a, b });

test('包含 → 大于：改成数字运算后立刻报出类型错', () => {
  // 第一步：包含 + 文本，没问题
  assert.deepEqual(cmp('contains', '苹果', '果'), []);
  // 第二步：只改运算，值没动 —— 必须报出来
  const bad = cmp('gt', '苹果', '果');
  assert.equal(bad.length, 2, '两边都要报');
  assert.equal(bad[0].expect, 'num');
  assert.equal(bad[0].actual, 'text');
  assert.match(bad[0].message, /数字/);
  assert.match(bad[0].message, /文本/);
});

test('报错要说清是哪个参数（只说"类型不对"等于没报）', () => {
  const bad = cmp('gt', '苹果', '果');
  assert.match(bad[0].message, /左边/);
  assert.match(bad[1].message, /右边/);
});

test('改回数字绿灯就恢复 —— 不能一直红着', () => {
  assert.deepEqual(cmp('gt', '10', '5'), []);
});

/* ---------------- 等价比大小：什么都能比 ---------------- */

test('等于 / 不等于：文本与数字都放行', () => {
  assert.deepEqual(cmp('eq', '苹果', '果'), []);
  assert.deepEqual(cmp('eq', '10', '5'), []);
  assert.deepEqual(cmp('neq', 'abc', '1'), []);
});

/* ---------------- 模板引用一律放行 ---------------- */

test('模板引用不校验 —— 编辑时看不到值，猜错比漏报更糟', () => {
  assert.deepEqual(cmp('gt', '{{上游.output}}', '5'), []);
  assert.deepEqual(cmp('gt', '{{a.output}}', '{{b.output}}'), []);
  assert.deepEqual(cmp('contains', '{{x.output}}', '果'), []);
});

test('空值不校验 —— 那是"没填"，归缺参管，不重复报', () => {
  assert.deepEqual(cmp('gt', '', ''), []);
  assert.deepEqual(cmp('gt', '   ', '5'), []);
});

/* ---------------- 数学运算 ---------------- */

test('数学：四则运算两边都要数字', () => {
  const m = (op: string, a: unknown, b: unknown) =>
    argTypeIssues('math', { kind: 'math', op, a, b });
  assert.deepEqual(m('add', '1', '2'), []);
  assert.deepEqual(m('add', 'abc', '2').length, 1);
  assert.deepEqual(m('add', 'abc', 'def').length, 2);
});

test('数学：单目运算只校验第一个数', () => {
  const m = (op: string, a: unknown, b: unknown) =>
    argTypeIssues('math', { kind: 'math', op, a, b });
  // 取整是单目，b 用不到 —— 不该报 b
  assert.deepEqual(m('round', '3.7', '随便什么'), []);
  assert.deepEqual(m('round', 'abc', '随便什么').length, 1);
});

test('数学：小数与负数算数字', () => {
  const m = (op: string, a: unknown, b: unknown) =>
    argTypeIssues('math', { kind: 'math', op, a, b });
  assert.deepEqual(m('add', '-3.5', '2e3'), []);
});

/* ---------------- 带单位算文本 ---------------- */

test('「100元」「50%」算文本 —— 它们进 num() 会变 0', () => {
  assert.equal(valueKindOf('100元'), 'text');
  assert.equal(valueKindOf('50%'), 'text');
  assert.equal(valueKindOf('100'), 'num');
  assert.equal(valueKindOf('-2.5'), 'num');
});

/* ---------------- 文本与随机 ---------------- */

test('文本：截取的下标要数字，源文本要文本', () => {
  const t = argTypeIssues('text', { kind: 'text', op: 'substr', a: 'abcdef', b: 'x', c: '3' });
  assert.equal(t.length, 1);
  assert.equal(t[0].key, 'b', '只有下标 b 错了');
  assert.equal(t[0].expect, 'num');
});

test('随机：上下界要数字', () => {
  assert.deepEqual(argTypeIssues('random', { kind: 'random', op: 'int', a: '1', b: '10' }), []);
  assert.equal(argTypeIssues('random', { kind: 'random', op: 'int', a: 'abc', b: '10' }).length, 1);
});

/* ---------------- 没有契约的运算一律放行 ---------------- */

test('表里没有的运算不校验 —— 宁可漏报也不误报', () => {
  assert.deepEqual(cmp('未知运算', '苹果', '果'), []);
  assert.deepEqual(argTypeIssues('math', { kind: 'math', op: 'xxx', a: 'a', b: 'b' }), []);
});

test('没有契约的节点种类不校验', () => {
  assert.deepEqual(argTypeIssues('task', { kind: 'task', a: 'x' }), []);
  assert.deepEqual(argTypeIssues(undefined, { a: 'x' }), []);
  assert.deepEqual(argTypeIssues('compare', null), []);
});

/* ---------------- 接入圆点 ---------------- */

test('类型错 → 圆点红色 + 徽章显示「错参」', () => {
  const issue = validateNode({ data: { kind: 'compare', op: 'gt', a: '苹果', b: '果' } });
  assert.equal(issue.level, 'error');
  assert.equal(issue.typeError, true);
  assert.equal(badgeTextOf(issue), '错参');
});

test('缺参仍显示「缺参」，不与错参混淆', () => {
  // 比较节点没填值 → 缺参，不是错参
  const issue = validateNode({ data: { kind: 'compare', op: 'gt', a: '', b: '' } });
  assert.equal(issue.typeError, undefined, '空值不走类型校验');
});

test('正常配置是绿灯', () => {
  const issue = validateNode({ data: { kind: 'compare', op: 'gt', a: '10', b: '5' } });
  assert.equal(issue.level, 'ok');
});

test('有契约的种类都在清单里（用于核对覆盖）', () => {
  const kinds = argTypedKinds();
  for (const k of ['math', 'compare', 'text', 'random']) {
    assert.ok(kinds.includes(k), `${k} 该有类型契约`);
  }
});
