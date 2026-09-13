import type { ConditionNodeData, ConditionOp, ConditionRule } from '../types';
import { OP_META, DEFAULT_BRANCH } from '../types';

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

/* ------------------------------------------------------------------ */
/* 面板可视化用的配套函数                                              */
/*                                                                     */
/* 都写成纯函数：不依赖 React，可以在 node --test 里直接验证。          */
/* 界面只负责把结果画出来，判断逻辑不被 UI 绑住。                        */
/* ------------------------------------------------------------------ */

export type RuleIssue = {
  level: 'warn' | 'error';
  message: string;
};

/**
 * 检查一条规则的配置问题。
 *
 * 重点是那些"看起来能跑、结果却不是你想要的"情况：
 *  - 比较值留空 → contains / notContains / regex 会恒为真
 *  - 正则写错 → 运行时该规则被跳过，等于这条规则不存在
 * 这两类都不报错、不阻断，只能靠编辑时提示。
 */
export function validateRule(rule: ConditionRule): RuleIssue[] {
  const issues: RuleIssue[] = [];
  if (!rule) return issues;

  const emptyValue = (rule.value ?? '').trim() === '';
  const emptyValueMatters = ['contains', 'notContains', 'regex'].includes(rule.op);

  if (emptyValue && emptyValueMatters) {
    issues.push({
      level: 'warn',
      message: '比较值留空时这条规则恒为真（相当于总是走这个分支）。想判断"有没有内容"请改用「非空」',
    });
  }

  if (rule.op === 'regex' && !emptyValue) {
    try {
      new RegExp(rule.value);
    } catch (err) {
      issues.push({
        level: 'error',
        message: `正则写错了：${err instanceof Error ? err.message : String(err)}。运行时这条规则会被跳过`,
      });
    }
  }

  // 兜底类算子放在非末尾位置会吃掉后面的规则
  return issues;
}

/**
 * 检查整个条件节点的问题，包含规则顺序层面的提示。
 */
export function validateCondition(node: ConditionNodeData): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const rules = node.rules ?? [];

  if (rules.length === 0) {
    issues.push({
      level: 'warn',
      message: '还没有任何规则。没有规则时只会走兜底分支，且兜底未启用则下游全被跳过',
    });
  }

  rules.forEach((r, i) => {
    for (const it of validateRule(r)) issues.push(it);
    // 命中即停：always 之后的规则永远不会被执行
    if (r.op === 'always' && i < rules.length - 1) {
      issues.push({
        level: 'warn',
        message: `第 ${i + 1} 条是「总是」，它后面的 ${rules.length - i - 1} 条规则永远不会被执行`,
      });
    }
  });

  /*
    兜底检查不能只在"有规则"时做 —— 无规则且无兜底是最危险的情况：
    条件节点什么都走不通，下游整条链静默全跳过，比有规则时更容易被忽略。
  */
  if (!node.defaultBranch) {
    issues.push({
      level: 'warn',
      message: '未启用兜底分支：所有规则都不命中时，下游全部被跳过',
    });
  }

  return issues;
}

export type RuleSimResult = {
  ruleId: string;
  label: string;
  /** true / false；null 表示这条规则有错（如非法正则）会被跳过 */
  matched: boolean | null;
};

export type SimResult = {
  results: RuleSimResult[];
  /** 命中的规则 id；走兜底为 '__default__'；都没有为 null */
  branchId: string | null;
  /** 命中规则的名字，便于界面直接显示 */
  branchLabel: string;
};

/**
 * 用一段示例文本模拟判定。
 *
 * 这里刻意忽略各规则的 source 配置，把示例文本当作每条规则的输入 ——
 * 编辑阶段通常还没运行过，上游输出是空的；
 * 用户想验证的是"算子逻辑对不对"，而不是"上游到底输出了什么"。
 */
export function simulateCondition(node: ConditionNodeData, text: string): SimResult {
  const rules = node.rules ?? [];
  const results: RuleSimResult[] = [];
  let branchId: string | null = null;
  let branchLabel = '';

  for (const rule of rules) {
    const r = testRule(rule, text);
    results.push({ ruleId: rule.id, label: rule.label, matched: r });
    if (branchId === null && r === true) {
      branchId = rule.id;
      branchLabel = rule.label;
    }
  }

  if (branchId === null) {
    if (node.defaultBranch) {
      branchId = DEFAULT_BRANCH;
      branchLabel = '兜底';
    } else {
      branchLabel = '（无分支，下游全跳过）';
    }
  }
  return { results, branchId, branchLabel };
}

/** 结构化描述一条规则，供界面拼装可视化表达式 */
export function describeRuleParts(rule: ConditionRule): {
  sourceText: string;
  opLabel: string;
  opIcon: string;
  opColor: string;
  valueText: string | null;
  sentence: string;
} {
  const meta = OP_META[rule.op];
  const sourceText = rule.source === 'input'
    ? '全局输入'
    : rule.source
      ? `节点 ${rule.source}`
      : '全部上游输出';

  const valueText = meta.needsValue ? (rule.value || '（空）') : null;
  const sentence = valueText === null
    ? `${sourceText} ${meta.label}`
    : `${sourceText} ${meta.label}「${valueText}」`;

  return {
    sourceText,
    opLabel: meta.label,
    opIcon: meta.icon,
    opColor: meta.color,
    valueText,
    sentence,
  };
}
