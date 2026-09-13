import type {
  ConditionNodeData, ConditionOp, ConditionRule, ConditionItem, ConditionLogic,
} from '../types';
import { OP_META, DEFAULT_BRANCH, LOGIC_META, ruleConditions } from '../types';

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

/**
 * 取某条条件要判定的文本。
 *
 * 参数只用到 source 字段，所以 ConditionRule 和 ConditionItem 都能传进来 ——
 * 多条件与单条件共用同一套来源解析。
 */
function resolveSource(cond: { source?: string }, ctx: EvalInput): string {
  const src = cond.source ?? '';
  if (src === 'input') return ctx.input ?? '';
  if (src !== '') return ctx.outputs[src] ?? '';
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

export type RuleEval = {
  /** true / false；null 表示规则有错（如所有条件都非法）应被跳过 */
  matched: boolean | null;
  /** 被停用的规则：不参与判定，也不算错 */
  disabled?: boolean;
  errors: string[];
};

/**
 * 判定一条规则（可能含多条条件）。
 *
 * 组合规则：
 *  - 规则整体停用 → 返回 false（不命中，继续看下一条），不报错
 *  - 所有条件都停用 → 同样视为不命中
 *  - 只统计"启用的条件"；非法正则那条算 null，被排除在组合之外
 *    （与既有语义一致：非法正则跳过该条，不中断流程）
 *  - 若启用的条件全是 null → 整条规则返回 null，由调用方跳过
 */
export function testRuleWithCtx(rule: ConditionRule, ctx: EvalInput): RuleEval {
  const errors: string[] = [];

  if (rule.enabled === false) {
    return { matched: false, disabled: true, errors };
  }

  const all = ruleConditions(rule);
  const active = all.filter((c) => c.enabled !== false);
  if (active.length === 0) {
    return { matched: false, errors };
  }

  const logic: ConditionLogic = rule.logic ?? 'and';
  const results: Array<boolean | null> = [];

  active.forEach((c, i) => {
    const text = resolveSource(c, ctx);
    const r = testCondition(c.op, text, c.value ?? '');
    if (r === null) {
      errors.push(`条件 ${i + 1}「${OP_META[c.op]?.label ?? c.op}」的正则非法：${c.value}`);
      return; // 不参与组合
    }
    results.push(r);
  });

  if (results.length === 0) {
    // 启用的条件全部非法 → 这条规则无法判定，交给调用方跳过并提示
    return { matched: null, errors };
  }

  const combined = logic === 'or'
    ? results.some(Boolean)
    : results.every(Boolean);
  return { matched: combined, errors };
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
    const ev = testRuleWithCtx(rule, ctx);
    errors.push(...ev.errors);

    if (ev.matched === null) continue; // 配置错误 → 跳过这条规则

    if (ev.matched) {
      // 展示第一条条件的来源文本，够用户判断为什么命中
      const first = ruleConditions(rule)[0];
      const text = first ? resolveSource(first, ctx) : (ctx.input ?? '');
      return {
        rule,
        branchId: rule.id,
        inspected: text.slice(0, MAX_SHOW),
        error: errors.length ? errors.join('；') : null,
      };
    }
  }

  // 没有规则命中：走兜底分支（若节点启用了）
  const firstRule = rules[0];
  const firstCond = firstRule ? ruleConditions(firstRule)[0] : undefined;
  const firstText = firstCond ? resolveSource(firstCond, ctx) : (ctx.input ?? '');
  return {
    rule: null,
    branchId: node.defaultBranch ? '__default__' : null,
    inspected: firstText.slice(0, MAX_SHOW),
    error: errors.length ? errors.join('；') : null,
  };
}

/** 给界面用的中文摘要 */
/**
 * 单条条件的中文摘要（简洁版，用于节点卡片）。
 * 参数只用到 op / value / source，所以规则与条件对象都能传。
 */
function describeConditionCore(c: { op: ConditionOp; value?: string; source?: string }): string {
  const opText: Record<string, string> = {
    contains: '包含', notContains: '不包含', equals: '等于', notEquals: '不等于',
    startsWith: '开头是', regex: '匹配正则', nonEmpty: '非空', isEmpty: '为空', always: '总是',
  };
  const t = opText[c.op] ?? c.op;
  const needsValue = !['nonEmpty', 'isEmpty', 'always'].includes(c.op);
  const src = c.source ? `${c.source} ` : '';
  return needsValue ? `${src}${t}「${c.value ?? ''}」` : `${src}${t}`;
}

/** 给界面用的中文摘要。多条件时用「且 / 或」连接 */
export function describeRule(rule: ConditionRule): string {
  const conds = ruleConditions(rule);
  if (conds.length > 1) {
    const joiner = (rule.logic ?? 'and') === 'or' ? ' 或 ' : ' 且 ';
    return conds.map((c) => describeConditionCore(c)).join(joiner);
  }
  return describeConditionCore(rule);
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

  const conds = ruleConditions(rule);
  const multi = conds.length > 1;

  // 规则整体停用：其余检查都没意义，只提示一次
  if (rule.enabled === false) {
    issues.push({ level: 'warn', message: '这条规则已停用，判定时会被跳过' });
    return issues;
  }

  const activeCount = conds.filter((c) => c.enabled !== false).length;
  if (activeCount === 0) {
    issues.push({ level: 'warn', message: '所有条件都已关闭，这条规则永远不会命中' });
    return issues;
  }

  conds.forEach((c, i) => {
    const prefix = multi ? `条件 ${i + 1}：` : '';
    if (c.enabled === false) return; // 关掉的条件不检查

    const emptyValue = (c.value ?? '').trim() === '';
    const emptyValueMatters = ['contains', 'notContains', 'regex'].includes(c.op);

    if (emptyValue && emptyValueMatters) {
      issues.push({
        level: 'warn',
        message: `${prefix}比较值留空时这条恒为真。想判断"有没有内容"请改用「非空」`,
      });
    }

    if (c.op === 'regex' && !emptyValue) {
      try {
        new RegExp(c.value);
      } catch (err) {
        issues.push({
          level: 'error',
          message: `${prefix}正则写错了：${err instanceof Error ? err.message : String(err)}。运行时这条会被跳过`,
        });
      }
    }
  });

  // AND 组合下，一条「为空」+ 一条「非空」互相矛盾，永远不可能同时满足
  if (multi && (rule.logic ?? 'and') === 'and') {
    const ops = conds.filter((c) => c.enabled !== false).map((c) => c.op);
    const hasImpossiblePair =
      (ops.includes('isEmpty') && ops.includes('nonEmpty')) ||
      (ops.includes('equals') && ops.includes('notEquals') &&
       conds.some((c) => c.op === 'equals') && conds.some((c) => c.op === 'notEquals') &&
       new Set(conds.filter((c) => c.op === 'equals' || c.op === 'notEquals').map((c) => c.value)).size === 1);
    if (hasImpossiblePair) {
      issues.push({
        level: 'warn',
        message: 'AND 组合下这些条件互相矛盾，这条规则永远不会命中',
      });
    }
  }

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
    // 命中即停：always 之后的规则永远不会被执行。
    // 多条件时只要含恒真的 always 且是 AND，效果等同于 always
    const conds = ruleConditions(r);
    const isAlways = conds.length === 1
      ? conds[0].op === 'always'
      : (r.logic ?? 'and') === 'and' && conds.some((c) => c.op === 'always' && c.enabled !== false);
    if (r.enabled !== false && isAlways && i < rules.length - 1) {
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
    // 示例文本作为每条条件的输入：编辑阶段验证的是"算子逻辑对不对"
    const ctx: EvalInput = { outputs: {}, input: text, upstream: [] };
    const ev = testRuleWithCtx(rule, ctx);
    results.push({ ruleId: rule.id, label: rule.label, matched: ev.matched });
    if (branchId === null && ev.matched === true) {
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

export type ConditionDesc = {
  sourceText: string;
  opLabel: string;
  opIcon: string;
  opColor: string;
  valueText: string | null;
  sentence: string;
};

export type ConditionDescWithState = ConditionDesc & { enabled: boolean; id: string };

export type RuleExpression = {
  parts: ConditionDescWithState[];
  logic: ConditionLogic;
  logicLabel: string;
  logicColor: string;
  text: string;
};

/** 单条条件的结构化描述 */
export function describeCondition(cond: ConditionItem): ConditionDesc {
  const meta = OP_META[cond.op];
  const sourceText = cond.source === 'input'
    ? '全局输入'
    : cond.source
      ? `节点 ${cond.source}`
      : '全部上游输出';

  const valueText = meta.needsValue ? (cond.value || '') : null;
  const sentence = valueText === null
    ? `${sourceText} ${meta.label}`
    : `${sourceText} ${meta.label}「${valueText || '（空）'}」`;

  return {
    sourceText,
    opLabel: meta.label,
    opIcon: meta.icon,
    opColor: meta.color,
    valueText,
    sentence,
  };
}

/** 整条规则的组合方式描述（含 AND/OR 连接词） */
export function describeRuleExpression(rule: ConditionRule): RuleExpression {
  const conds = ruleConditions(rule);
  const logic: ConditionLogic = rule.logic ?? 'and';
  const parts = conds.map((c) => ({
    ...describeCondition(c),
    enabled: c.enabled !== false,
    id: c.id,
  }));
  const joiner = LOGIC_META[logic].short;
  const text = parts
    .filter((p) => p.enabled)
    .map((p) => p.sentence)
    .join(` ${joiner} `) || '（无启用的条件）';
  return { parts, logic, logicLabel: LOGIC_META[logic].label, logicColor: LOGIC_META[logic].color, text };
}

/**
 * 结构化描述一条规则（取第一条条件），供界面拼装可视化表达式。
 *
 * 多条件场景请用 describeRuleExpression，它会给出全部条件与连接词。
 */
export function describeRuleParts(rule: ConditionRule): ConditionDesc {
  return describeCondition(ruleConditions(rule)[0]);
}
