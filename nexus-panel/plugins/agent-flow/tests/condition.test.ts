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
  evaluateCondition, testCondition, describeRule, describeRuleExpression,
  validateRule, validateCondition, simulateCondition, describeRuleParts,
  type EvalInput,
} from '../engine/condition';
import type {
  ConditionNodeData, ConditionRule, ConditionItem, GraphNode, FlowEdge,
} from '../types';
import { DEFAULT_BRANCH, ruleConditions, makeConditionNode } from '../types';
import { deleteElements } from '../engine/canvasOps';



/** 构造一条边（第二个参数即条件分支时可传 opts） */
function edge(source: string, target: string, opts: Record<string, unknown> = {}): FlowEdge {
  return { id: `${source}->${target}`, source, target, ...opts } as unknown as FlowEdge;
}
function makeNode(id: string, partial: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    data: { kind: 'task', label: id, cli: 'codebuddy', prompt: '', model: '', workdir: '',
            yolo: false, status: 'idle', output: '', error: '', ...partial },
  } as unknown as GraphNode;
}

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

/* ================================================================== */
/* 多条件（AND / OR）+ 条件开关                                        */
/* ================================================================== */

const CI = (o: Partial<ConditionItem> = {}): ConditionItem => ({
  id: 'c1', op: 'contains', value: 'x', source: '', enabled: true, ...o,
});

/** 构造一个"节点 n1 输出固定文本"的上下文 */
const ctxOf = (text: string): EvalInput => ({ outputs: {}, input: text, upstream: [] });

/* ---------- 归一化：旧数据兼容 ---------- */

test('归一化: 老版单条件规则视为一条条件', () => {
  const r = R({ op: 'equals', value: 'true', source: 'n1' });
  const cs = ruleConditions(r);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].op, 'equals');
  assert.equal(cs[0].value, 'true');
  assert.equal(cs[0].enabled, true);
});

test('归一化: 有多条件时以 conditions 为准', () => {
  const r = {
    ...R({ op: 'contains', value: 'IGNORED' }),
    conditions: [CI({ id: 'a', op: 'equals', value: 'x' })],
  } as ConditionRule;
  const cs = ruleConditions(r);
  assert.equal(cs.length, 1);
  assert.equal(cs[0].value, 'x', '应取 conditions 里的值，忽略顶层 op/value');
});

test('归一化: 老数据不写 conditions 也能正常判定', () => {
  const node = N([R({ op: 'contains', value: 'error' })]);
  const out = evaluateCondition(node, ctxOf('an error'));
  assert.equal(out.branchId, 'r1', '兼容路径必须和以前一样能命中');
});

/* ---------- AND ---------- */

test('AND: 两条都为真才命中', () => {
  const node = N([{
    ...R({ id: 'r1', op: 'contains', value: 'error' }),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'error' }),
      CI({ id: 'b', op: 'contains', value: 'fatal' }),
    ],
    logic: 'and',
  } as ConditionRule]);
  assert.equal(evaluateCondition(node, ctxOf('error fatal')).branchId, 'r1');
  assert.equal(evaluateCondition(node, ctxOf('error only')).branchId, DEFAULT_BRANCH);
});

test('AND: 默认逻辑是 and（未指定 logic 时）', () => {
  const node = N([{
    ...R({ id: 'r1' }),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'error' }),
      CI({ id: 'b', op: 'contains', value: 'fatal' }),
    ],
  } as ConditionRule]);
  assert.equal(evaluateCondition(node, ctxOf('error only')).branchId, DEFAULT_BRANCH);
});

/* ---------- OR ---------- */

test('OR: 任一条为真即命中', () => {
  const node = N([{
    ...R({ id: 'r1' }),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'error' }),
      CI({ id: 'b', op: 'contains', value: 'warn' }),
    ],
    logic: 'or',
  } as ConditionRule]);
  assert.equal(evaluateCondition(node, ctxOf('just a warn')).branchId, 'r1');
  assert.equal(evaluateCondition(node, ctxOf('all fine')).branchId, DEFAULT_BRANCH);
});

test('OR: 两条都真也命中（不冲突）', () => {
  const node = N([{
    ...R({ id: 'r1' }),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'x' }),
      CI({ id: 'b', op: 'contains', value: 'x' }),
    ],
    logic: 'or',
  } as ConditionRule]);
  assert.equal(evaluateCondition(node, ctxOf('x')).branchId, 'r1');
});

/* ---------- 条件开关 ---------- */

test('开关: 停用的条件不参与 AND 组合', () => {
  const node = N([{
    ...R({ id: 'r1' }),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'error' }),
      CI({ id: 'b', op: 'contains', value: 'NEVER', enabled: false }),
    ],
    logic: 'and',
  } as ConditionRule]);
  // 若 b 参与，'error' 不含 NEVER 就该不命中；停掉后应命中
  assert.equal(evaluateCondition(node, ctxOf('error')).branchId, 'r1');
});

test('开关: 所有条件都停用 → 规则不命中', () => {
  const node = N([{
    ...R({ id: 'r1' }),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'error', enabled: false }),
    ],
  } as ConditionRule]);
  assert.equal(evaluateCondition(node, ctxOf('error')).branchId, DEFAULT_BRANCH);
  assert.equal(validateRule(node.rules[0]).some((i) => i.message.includes('永远不会命中')), true);
});

test('开关: 规则整体停用 → 不命中且继续看下一条', () => {
  const node = N([
    { ...R({ id: 'r1', op: 'contains', value: 'error' }), enabled: false } as ConditionRule,
    R({ id: 'r2', op: 'contains', value: 'error' }),
  ]);
  const out = evaluateCondition(node, ctxOf('error'));
  assert.equal(out.branchId, 'r2', '停用的 r1 应被跳过，由 r2 命中');
});

test('开关: 所有规则都停用 → 走兜底', () => {
  const node = N([
    { ...R({ id: 'r1', op: 'contains', value: 'error' }), enabled: false } as ConditionRule,
  ]);
  assert.equal(evaluateCondition(node, ctxOf('error')).branchId, DEFAULT_BRANCH);
});

/* ---------- 非法正则与错误收集 ---------- */

test('多条件: 非法正则那条被排除，其余正常组合', () => {
  const node = N([{
    ...R({ id: 'r1' }),
    conditions: [
      CI({ id: 'a', op: 'regex', value: '[' }),
      CI({ id: 'b', op: 'contains', value: 'x' }),
    ],
    logic: 'and',
  } as ConditionRule]);
  const out = evaluateCondition(node, ctxOf('x'));
  assert.equal(out.branchId, 'r1', '坏条件应被忽略，不影响其余');
  assert.ok(out.error?.includes('条件 1'), '错误里应指明是第几条');
});

test('多条件: 启用的条件全非法 → 规则返回 null 被跳过', () => {
  const node = N([
    {
      ...R({ id: 'r1' }),
      conditions: [CI({ id: 'a', op: 'regex', value: '[' })],
    } as ConditionRule,
    R({ id: 'r2', op: 'contains', value: 'x' }),
  ]);
  const out = evaluateCondition(node, ctxOf('x'));
  assert.equal(out.branchId, 'r2', 'r1 应被跳过');
  assert.ok(out.error?.includes('正则非法'));
});

test('多条件: 停用非法正则后不再报错', () => {
  const node = N([{
    ...R({ id: 'r1' }),
    conditions: [
      CI({ id: 'a', op: 'regex', value: '[', enabled: false }),
      CI({ id: 'b', op: 'contains', value: 'x' }),
    ],
  } as ConditionRule]);
  const out = evaluateCondition(node, ctxOf('x'));
  assert.equal(out.error, null, '停用的条件不该再产生错误');
  assert.equal(out.branchId, 'r1');
});

/* ---------- 校验 ---------- */

test('校验: 多条件下按序号定位问题', () => {
  const rule = {
    ...R({ id: 'r1' }),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'ok' }),
      CI({ id: 'b', op: 'contains', value: '' }),
    ],
  } as ConditionRule;
  const issues = validateRule(rule);
  assert.ok(issues.some((i) => i.message.startsWith('条件 2：')), `应指明第 2 条，实际: ${issues.map((i) => i.message)}`);
});

test('校验: 停用的条件不参与校验', () => {
  const rule = {
    ...R({ id: 'r1' }),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'ok' }),
      CI({ id: 'b', op: 'regex', value: '[', enabled: false }),
    ],
  } as ConditionRule;
  assert.equal(validateRule(rule).length, 0);
});

test('校验: 规则停用只提示一条', () => {
  const rule = {
    ...R({ id: 'r1' }),
    enabled: false,
    conditions: [
      CI({ id: 'a', op: 'contains', value: '' }),
      CI({ id: 'b', op: 'regex', value: '[' }),
    ],
  } as ConditionRule;
  const issues = validateRule(rule);
  assert.equal(issues.length, 1);
  assert.ok(issues[0].message.includes('已停用'));
});

test('校验: AND 下「为空」与「非空」矛盾会被提示', () => {
  const rule = {
    ...R({ id: 'r1' }),
    logic: 'and',
    conditions: [
      CI({ id: 'a', op: 'isEmpty' }),
      CI({ id: 'b', op: 'nonEmpty' }),
    ],
  } as ConditionRule;
  assert.ok(validateRule(rule).some((i) => i.message.includes('互相矛盾')));
});

test('校验: 矛盾条件改成 OR 后不再提示', () => {
  const rule = {
    ...R({ id: 'r1' }),
    logic: 'or',
    conditions: [
      CI({ id: 'a', op: 'isEmpty' }),
      CI({ id: 'b', op: 'nonEmpty' }),
    ],
  } as ConditionRule;
  assert.equal(validateRule(rule).filter((i) => i.message.includes('互相矛盾')).length, 0);
});

/* ---------- 试跑 ---------- */

test('试跑: AND 组合', () => {
  const node = N([{
    ...R({ id: 'r1' }),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'error' }),
      CI({ id: 'b', op: 'contains', value: 'db' }),
    ],
    logic: 'and',
  } as ConditionRule]);
  assert.equal(simulateCondition(node, 'error in db').branchId, 'r1');
  assert.equal(simulateCondition(node, 'error in cache').branchId, DEFAULT_BRANCH);
});

test('试跑: OR 组合', () => {
  const node = N([{
    ...R({ id: 'r1' }),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'error' }),
      CI({ id: 'b', op: 'contains', value: 'warn' }),
    ],
    logic: 'or',
  } as ConditionRule]);
  assert.equal(simulateCondition(node, 'a warn').branchId, 'r1');
});

test('试跑: 停用条件不被计入', () => {
  const node = N([{
    ...R({ id: 'r1' }),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'error' }),
      CI({ id: 'b', op: 'contains', value: 'NEVER', enabled: false }),
    ],
    logic: 'and',
  } as ConditionRule]);
  assert.equal(simulateCondition(node, 'error').branchId, 'r1');
});

test('试跑: 规则停用后走兜底', () => {
  const node = N([{
    ...R({ id: 'r1', op: 'contains', value: 'error' }),
    enabled: false,
  } as ConditionRule]);
  assert.equal(simulateCondition(node, 'error').branchId, DEFAULT_BRANCH);
});

/* ---------- 描述 ---------- */

test('描述: 多条件用「且」连接', () => {
  const rule = {
    ...R(),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'x', source: 'n1' }),
      CI({ id: 'b', op: 'equals', value: 'y' }),
    ],
    logic: 'and',
  } as ConditionRule;
  const t = describeRule(rule);
  assert.ok(t.includes('且'), `应含「且」，实际: ${t}`);
  assert.ok(t.includes('包含'));
  assert.ok(t.includes('等于'));
});

test('描述: OR 用「或」连接', () => {
  const rule = {
    ...R(),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'x' }),
      CI({ id: 'b', op: 'contains', value: 'y' }),
    ],
    logic: 'or',
  } as ConditionRule;
  assert.ok(describeRule(rule).includes('或'));
});

test('描述: describeRuleExpression 给出全部条件与连接词', () => {
  const rule = {
    ...R(),
    conditions: [
      CI({ id: 'a', op: 'contains', value: 'x' }),
      CI({ id: 'b', op: 'nonEmpty', value: '', enabled: false }),
    ],
    logic: 'or',
  } as ConditionRule;
  const e = describeRuleExpression(rule);
  assert.equal(e.parts.length, 2);
  assert.equal(e.logic, 'or');
  assert.equal(e.parts[1].enabled, false);
  // 停用的条件不出现在文本里
  assert.ok(!e.text.includes('非空'), `停用条件不该出现，实际: ${e.text}`);
  assert.ok(e.text.includes('OR') === false);
});

test('描述: 单条件时无连接词', () => {
  const e = describeRuleExpression(R({ op: 'contains', value: 'x' }));
  assert.equal(e.parts.length, 1);
  assert.ok(!e.text.includes('且'));
});

/* ================================================================== */
/* 删除上游时的悬空引用检测（条件 source 不走模板语法）                */
/* ================================================================== */

test('悬空引用: 条件 source 指向被删节点时报警', () => {
  const nodes = [
    makeNode('a'),
    makeConditionNode('c', { rules: [R({ op: 'contains', value: 'x', source: 'a' })] }),
  ];
  const edges = [edge('a', 'c')];
  const res = deleteElements(nodes, edges, { nodeIds: ['a'] });
  assert.ok(res.danglingRefs.length > 0, '条件节点的 source 引用必须被检测到');
  assert.equal(res.danglingRefs[0].usedBy.includes('c'), true);
});

test('悬空引用: 多条件的 source 也被检测', () => {
  const nodes = [
    makeNode('a'),
    makeConditionNode('c', {
      rules: [{
        ...R({ id: 'r1', source: '' }),
        conditions: [
          CI({ id: 'x', op: 'contains', value: '1', source: '' }),
          CI({ id: 'y', op: 'contains', value: '2', source: 'a' }),
        ],
      } as ConditionRule],
    }),
  ];
  const res = deleteElements(nodes, [edge('a', 'c')] as FlowEdge[], { nodeIds: ['a'] });
  assert.ok(res.danglingRefs.length > 0, '第二条条件的 source 也应被检测');
});

test('悬空引用: source 为空（拼接全部上游）不报警', () => {
  const nodes = [
    makeNode('a'),
    makeConditionNode('c', { rules: [R({ op: 'contains', value: 'x', source: '' })] }),
  ];
  const res = deleteElements(nodes, [edge('a', 'c')] as FlowEdge[], { nodeIds: ['a'] });
  assert.equal(res.danglingRefs.length, 0, 'source 为空表示拼接全部上游，不是悬空引用');
});
