/**
 * 条件节点与算子的单元测试。
 *
 * 运行：npm i -D tsx && npx tsx --test tests/condition.test.ts
 *
 * 除了判定语义本身，这里也覆盖"面板可视化"用到的配套函数：
 * 试跑结果必须和引擎真实行为一致（空值恒真、equals 先 trim），
 * 否则界面显示的就是错的，比没有提示更糟。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateCondition, testCondition, describeRule,
  validateRule, validateCondition, simulateCondition, describeRuleParts,
} from '../engine/condition';
import type { ConditionNodeData, ConditionRule } from '../types';
import { DEFAULT_BRANCH } from '../types';


/* ================================================================== */
/* 面板可视化配套：校验 / 试跑 / 结构化描述                            */
/* ================================================================== */

const R = (o: Partial<ConditionRule> = {}): ConditionRule => ({
  id: 'r1', label: '分支', op: 'contains', value: 'x', source: '', ...o,
});

const N = (rules: ConditionRule[], defaultBranch = true): ConditionNodeData => ({
  kind: 'condition', label: 'cond', rules, defaultBranch,
  status: 'idle', output: '', error: '',
});

/* ---------- validateRule ---------- */

test('校验: 正常规则无提示', () => {
  assert.equal(validateRule(R({ op: 'contains', value: 'err' })).length, 0);
});

test('校验: contains 值为空时警告（恒为真）', () => {
  // 这是最反直觉的一条：值为空不是"不匹配"，而是恒为真
  const issues = validateRule(R({ op: 'contains', value: '' }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'warn');
  assert.ok(issues[0].message.includes('恒为真'));
});

test('校验: notContains / regex 值为空同样警告', () => {
  assert.ok(validateRule(R({ op: 'notContains', value: '' })).length === 1);
  assert.ok(validateRule(R({ op: 'regex', value: '' })).length === 1);
});

test('校验: 非法正则报 error 并给出原因', () => {
  const issues = validateRule(R({ op: 'regex', value: '[' }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'error');
  assert.ok(issues[0].message.includes('正则写错了'));
});

test('校验: 合法正则无提示', () => {
  assert.equal(validateRule(R({ op: 'regex', value: '^ERR\\d+$' })).length, 0);
});

test('校验: 无值算子留空不误报', () => {
  // nonEmpty / isEmpty / always 不需要比较值，不该提示"值留空"
  assert.equal(validateRule(R({ op: 'nonEmpty', value: '' })).length, 0);
  assert.equal(validateRule(R({ op: 'isEmpty', value: '' })).length, 0);
  assert.equal(validateRule(R({ op: 'always', value: '' })).length, 0);
});

/* ---------- validateCondition ---------- */

test('校验: 无规则且无兜底时提示', () => {
  const issues = validateCondition(N([], false));
  assert.ok(issues.some((i) => i.message.includes('还没有任何规则')));
  assert.ok(issues.some((i) => i.message.includes('未启用兜底')));
});

test('校验: always 不在末尾时提示后面规则不可达', () => {
  const issues = validateCondition(N([
    R({ id: 'a', op: 'always' }),
    R({ id: 'b', op: 'contains', value: 'x' }),
  ]));
  const warn = issues.find((i) => i.message.includes('永远不会被执行'));
  assert.ok(warn, '应提示不可达');
  assert.ok(warn!.message.includes('1 条'));
});

test('校验: always 在末尾时不提示', () => {
  const issues = validateCondition(N([
    R({ id: 'a', op: 'contains', value: 'x' }),
    R({ id: 'b', op: 'always' }),
  ]));
  assert.equal(issues.filter((i) => i.message.includes('永远不会被执行')).length, 0);
});

/* ---------- simulateCondition ---------- */

test('试跑: 命中第一条即返回该分支', () => {
  const r = simulateCondition(N([
    R({ id: 'a', label: '报错', op: 'contains', value: 'error' }),
    R({ id: 'b', label: '正常', op: 'contains', value: 'ok' }),
  ]), 'there is an error here');
  assert.equal(r.branchId, 'a');
  assert.equal(r.branchLabel, '报错');
});

test('试跑: 都不命中走兜底', () => {
  const r = simulateCondition(N([
    R({ id: 'a', op: 'contains', value: 'error' }),
  ]), 'all good');
  assert.equal(r.branchId, DEFAULT_BRANCH);
  assert.equal(r.branchLabel, '兜底');
});

test('试跑: 未启用兜底时返回 null', () => {
  const r = simulateCondition(N([
    R({ id: 'a', op: 'contains', value: 'error' }),
  ], false), 'all good');
  assert.equal(r.branchId, null);
});

test('试跑: 逐条给出命中状态', () => {
  const r = simulateCondition(N([
    R({ id: 'a', op: 'contains', value: 'error' }),
    R({ id: 'b', op: 'startsWith', value: 'OK' }),
  ]), 'error happened');
  assert.equal(r.results.length, 2);
  assert.equal(r.results[0].matched, true);
  assert.equal(r.results[1].matched, false);
});

test('试跑: 非法正则那条标记为 null（会被跳过）', () => {
  const r = simulateCondition(N([
    R({ id: 'a', op: 'regex', value: '[' }),
    R({ id: 'b', op: 'contains', value: 'x' }),
  ]), 'x');
  assert.equal(r.results[0].matched, null, '非法正则应标记为 null 而不是 false');
  assert.equal(r.branchId, 'b', '跳过坏规则后应命中下一条');
});

test('试跑: 空值 contains 恒为真（与引擎一致）', () => {
  // 引擎里 v === '' 时返回 true，试跑必须体现这个行为，否则界面在骗人
  const r = simulateCondition(N([R({ op: 'contains', value: '' })]), 'anything');
  assert.equal(r.results[0].matched, true);
});

test('试跑: equals 会先 trim（与引擎一致）', () => {
  const r = simulateCondition(N([R({ op: 'equals', value: 'true' })]), '  true  \n');
  assert.equal(r.results[0].matched, true);
});

/* ---------- describeRuleParts ---------- */

test('描述: 拆出来源 / 算子 / 值', () => {
  const p = describeRuleParts(R({ op: 'contains', value: 'error', source: 'n1' }));
  assert.equal(p.sourceText, '节点 n1');
  assert.equal(p.opLabel, '包含');
  // valueText 是裸值，引号由界面自己加（便于自由排版）；sentence 里已带引号
  assert.equal(p.valueText, 'error');
  assert.ok(p.sentence.includes('包含'));
  assert.ok(p.sentence.includes('「error」'));
});

test('描述: 来源为空时显示"全部上游输出"', () => {
  assert.equal(describeRuleParts(R({ source: '' })).sourceText, '全部上游输出');
});

test('描述: input 显示为"全局输入"', () => {
  assert.equal(describeRuleParts(R({ source: 'input' })).sourceText, '全局输入');
});

test('描述: 无值算子 valueText 为 null', () => {
  assert.equal(describeRuleParts(R({ op: 'nonEmpty' })).valueText, null);
  assert.ok(describeRuleParts(R({ op: 'nonEmpty' })).sentence.includes('非空'));
});

test('描述: 算子带图标与配色', () => {
  const p = describeRuleParts(R({ op: 'regex', value: 'a' }));
  assert.ok(p.opIcon.length > 0);
  assert.ok(p.opColor.startsWith('#'));
});
