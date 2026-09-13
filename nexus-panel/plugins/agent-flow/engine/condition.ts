import type { ConditionNodeData, ConditionOp, ConditionRule } from '../types';

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
