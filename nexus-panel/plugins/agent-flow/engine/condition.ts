import type { ConditionNodeData, ConditionOp, ConditionRule } from '../types';
import { ruleConditions, OP_META, LOGIC_META, DEFAULT_BRANCH } from '../types';
import type { ConditionLogic } from '../types';

export type EvalInput = {
  /** 上游节点 id → 输出 */
  outputs: Record<string, string>;
  /** 全局输入 */
  input?: string;
  /** 该条件节点的直接上游 id 列表，用于 source 为空时拼接 */
  upstream: string[];
};

export type RuleOutcome = {
  rule: ConditionRule | null;
  /** 匹配的规则 id；走兜底时为 '__default__'；全不匹配时为 null */
  branchId: string | null;
  /** 判定依据的文本（截断后，便于界面展示） */
  inspected: string;
  /** 非法正则等错误，不阻断执行但要在界面提示 */
  error: string | null;
};

const MAX_SHOW = 300;

/** 取某条规则要判定的文本 */
function resolveSource(rule: ConditionRule, ctx: EvalInput): string {
  if (rule.source === 'input') return ctx.input ?? '';
  if (rule.source && rule.source !== '') return ctx.outputs[rule.source] ?? '';
  // 未指定来源：拼接全部上游输出；无上游时退回全局输入
  if (ctx.upstream.length > 0) {
    return ctx.upstream.map((u) => ctx.outputs[u] ?? '').join('\n');
  }
  return ctx.input ?? '';
}

/**
 * 单条判定。返回 null 表示配置错误（如非法正则）。
 *
 * 抽成独立函数是刻意的：并发节点的 byRule 模式也用同一套操作符语义，
 * 不必维护两套判定逻辑。
 */
export function testCondition(op: ConditionOp, text: string, value: string): boolean | null {
  const v = value ?? '';
  switch (op) {
    case 'always':
      return true;
    case 'nonEmpty':
      return text.trim().length > 0;
    case 'isEmpty':
      return text.trim().length === 0;
    case 'contains':
      return v === '' ? true : text.includes(v);
    case 'notContains':
      return v === '' ? true : !text.includes(v);
    case 'equals':
      return text.trim() === v.trim();
    case 'notEquals':
      return text.trim() !== v.trim();
    case 'startsWith':
      return text.trimStart().startsWith(v);
    case 'regex': {
      if (v === '') return true;
      try {
        return new RegExp(v).test(text);
      } catch {
        return null; // 非法正则
      }
    }
    default:
      return false;
  }
}

/** 单条规则的判定。返回 null 表示这条规则有配置错误（如非法正则） */
function testRule(rule: ConditionRule, text: string): boolean | null {
  return testCondition(rule.op, text, rule.value ?? '');
}

/**
 * 对条件节点求值：从上到下找第一条命中的规则。
 *
 * 重要：非法正则不会抛异常打断工作流，而是跳过该规则并在 error 里提示，
 * 否则一个手误写的 `[` 就能让整条流水线挂掉。
 */
export function evaluateCondition(node: ConditionNodeData, ctx: EvalInput): RuleOutcome {
  const rules = node.rules ?? [];
  const errors: string[] = [];

  for (const rule of rules) {
    const text = resolveSource(rule, ctx);
    const r = testRule(rule, text);

    if (r === null) {
      errors.push(`规则「${rule.label}」的正则非法：${rule.value}`);
      continue;
    }
    if (r) {
      return {
        rule,
        branchId: rule.id,
        inspected: text.slice(0, MAX_SHOW),
        error: errors.length ? errors.join('；') : null,
      };
    }
  }

  // 没有规则命中：走兜底分支（若节点启用了）
  const firstText = rules.length > 0 ? resolveSource(rules[0], ctx) : (ctx.input ?? '');
  return {
    rule: null,
    branchId: node.defaultBranch ? '__default__' : null,
    inspected: firstText.slice(0, MAX_SHOW),
    error: errors.length ? errors.join('；') : null,
  };
}

/** 给界面用的中文摘要 */
export function describeRule(rule: ConditionRule): string {
  const opText: Record<string, string> = {
    contains: '包含', notContains: '不包含', equals: '等于', notEquals: '不等于',
    startsWith: '开头是', regex: '匹配正则', nonEmpty: '非空', isEmpty: '为空', always: '总是',
  };
  const t = opText[rule.op] ?? rule.op;
  const needsValue = !['nonEmpty', 'isEmpty', 'always'].includes(rule.op);
  const src = rule.source ? `${rule.source} ` : '';
  return needsValue ? `${src}${t}「${rule.value}」` : `${src}${t}`;
}


/* ============================================================
 * 界面辅助：校验 / 试跑 / 表达式描述
 * ------------------------------------------------------------
 * 这四个是给 Inspector 用的**静态分析**能力，与上面的 evaluateCondition
 * （真正跑工作流时求值）分开：
 *   · validateRule / validateCondition —— 只看配置本身，不需要真实数据
 *   · simulateCondition —— 拿一段样例文本试跑，帮用户在写规则时确认语义
 *   · describeRuleExpression —— 多条件组合的可读摘要
 *
 * 全部走 ruleConditions() 归一化，单条件（老数据）与多条件（新数据）行为一致。
 * ============================================================ */

export type CondIssue = {
  /** error 会阻断运行；warn 只是提醒 */
  level: 'error' | 'warn';
  message: string;
};

/** 需要填比较值的操作符；空值对它们没有意义 */
const OPS_NEED_VALUE = new Set(['contains', 'notContains', 'equals', 'notEquals', 'startsWith', 'regex']);

/** 校验单条规则 */
export function validateRule(rule: ConditionRule): CondIssue[] {
  const issues: CondIssue[] = [];
  const conds = ruleConditions(rule);

  if (conds.length === 0) {
    issues.push({ level: 'error', message: '没有任何条件，这条规则永远不会命中' });
    return issues;
  }

  for (const [i, c] of conds.entries()) {
    const n = conds.length > 1 ? `第 ${i + 1} 条` : '';
    if (OPS_NEED_VALUE.has(c.op) && (c.value ?? '').trim() === '') {
      issues.push({ level: 'error', message: `${n}比较值为空，「${c.op}」需要填一个值` });
    }
    if (c.op === 'regex' && (c.value ?? '') !== '') {
      try {
        new RegExp(c.value);
      } catch {
        issues.push({ level: 'error', message: `${n}正则表达式非法：${c.value}` });
      }
    }
  }

  // 全部条件都关掉 → 组合结果恒真，通常是误操作
  if (conds.every((c) => c.enabled === false)) {
    issues.push({ level: 'warn', message: '所有条件都被关闭，这条规则会直接命中' });
  }
  return issues;
}

/** 校验整个条件节点（含规则间的关系） */
export function validateCondition(node: ConditionNodeData): CondIssue[] {
  const issues: CondIssue[] = [];
  const rules = node.rules ?? [];

  if (rules.length === 0) {
    // 没规则时：开了兜底就走兜底（合法），否则运行到这里会断流
    issues.push(node.defaultBranch
      ? { level: 'warn', message: '还没有规则，运行时会走兜底分支' }
      : { level: 'error', message: '还没有规则，且未启用兜底分支 —— 运行到这里会中断' });
    return issues;
  }

  const enabled = rules.filter((r) => r.enabled !== false);
  if (enabled.length === 0) {
    issues.push(node.defaultBranch
      ? { level: 'warn', message: '所有规则都已关闭，运行时会走兜底分支' }
      : { level: 'error', message: '所有规则都已关闭，且未启用兜底分支' });
  }

  // 重名分支：用户自己在界面上也会分不清
  const seen = new Map<string, number>();
  for (const r of rules) {
    const name = (r.label ?? '').trim();
    if (!name) continue;
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  for (const [name, n] of seen) {
    if (n > 1) issues.push({ level: 'warn', message: `有 ${n} 条规则都叫「${name}」，建议改名区分` });
  }

  for (const r of rules) {
    for (const it of validateRule(r)) {
      issues.push({ ...it, message: `规则「${r.label || r.id}」：${it.message}` });
    }
  }
  return issues;
}

export type SimulateResult = {
  /** 逐条规则的判定结果（每条独立算，不套用"命中即停"） */
  results: Array<{
    ruleId: string;
    /** true 命中 / false 未命中 / null 配置错误（如非法正则） */
    matched: boolean | null;
    /** 该规则实际判定的文本（截断） */
    text: string;
    error?: string;
  }>;
  /**
   * 试跑最终会走哪个分支。
   * null 表示没有规则命中且未启用兜底 —— 下游会被全部跳过。
   */
  branchId: string | null;
  /** 分支展示名；走兜底时是「兜底分支」 */
  branchLabel: string;
};

/**
 * 拿一段样例文本试跑全部规则。
 *
 * 两个刻意的取舍：
 *  1. results 里每条规则**独立判定**，不套用"命中即停" ——
 *     用户想看清每一条的匹配情况，而不是只看最终赢家；
 *     哪条会先命中由 branchId 单独给出。
 *  2. 来源统一用样例文本：试跑的目的是验证"这段文本会不会命中"，
 *     而不是复现真实上下游关系（那需要整条流水线跑起来）。
 */
export function simulateCondition(node: ConditionNodeData, sample: string): SimulateResult {
  const rules = node.rules ?? [];
  const text = sample ?? '';
  let branchId: string | null = null;
  let branchLabel = '';

  const results = rules.map((rule) => {
    const conds = ruleConditions(rule).filter((c) => c.enabled !== false);
    const disabled = rule.enabled === false;

    if (disabled) {
      return { ruleId: rule.id, matched: false as const, text: text.slice(0, MAX_SHOW) };
    }
    if (conds.length === 0) {
      return { ruleId: rule.id, matched: false as const, text: text.slice(0, MAX_SHOW) };
    }

    const logic = rule.logic ?? 'and';
    let matched: boolean | null = logic === 'and';
    let error = '';

    for (const c of conds) {
      const r = testCondition(c.op, text, c.value ?? '');
      if (r === null) {
        error = `正则非法：${c.value}`;
        matched = null;
        break;
      }
      matched = logic === 'and' ? (matched === true && r) : (matched === true || r);
    }

    // 命中即停：只认第一条真正命中的规则
    if (matched === true && branchId === null) {
      branchId = rule.id;
      branchLabel = rule.label || rule.id;
    }
    return {
      ruleId: rule.id,
      matched,
      text: text.slice(0, MAX_SHOW),
      ...(error ? { error } : {}),
    };
  });

  if (branchId === null && node.defaultBranch) {
    branchId = DEFAULT_BRANCH;
    branchLabel = '兜底分支';
  }
  return { results, branchId, branchLabel };
}

/**
 * 把一条规则拆成界面可直接渲染的结构化片段。
 *
 * 不返回字符串是刻意的：界面要按条件逐段上色、给关闭的条件加删除线、
 * 在条件之间插入 AND/OR 连接符 —— 拼成字符串后再切开会很脆。
 */
export function describeRuleExpression(rule: ConditionRule): {
  logic: ConditionLogic;
  logicLabel: string;
  logicColor: string;
  parts: Array<{
    id: string;
    enabled: boolean;
    sourceText: string;
    opLabel: string;
    opIcon: string;
    opColor: string;
    /** null 表示该操作符不需要比较值（如非空 / 总是） */
    valueText: string | null;
  }>;
} {
  const conds = ruleConditions(rule);
  const logic: ConditionLogic = rule.logic ?? 'and';
  const meta = LOGIC_META[logic];

  return {
    logic,
    logicLabel: meta.label,
    logicColor: meta.color,
    parts: conds.map((c) => {
      const om = OP_META[c.op];
      return {
        id: c.id,
        enabled: c.enabled !== false,
        sourceText: c.source === 'input' ? '全局输入' : (c.source || '全部上游'),
        opLabel: om?.label ?? String(c.op),
        opIcon: om?.icon ?? '?',
        opColor: om?.color ?? 'currentColor',
        valueText: om && !om.needsValue ? null : (c.value ?? ''),
      };
    }),
  };
}
