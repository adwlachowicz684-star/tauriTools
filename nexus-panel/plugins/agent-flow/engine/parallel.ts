import type { ParallelNodeData, ParallelRule, ConditionOp } from '../types';
import { OP_META } from '../types';
import { testCondition } from './condition';

/**
 * 并发度求解（纯逻辑，可单测）。
 *
 * 并发节点的作用：给它的**下游**设定并发上限，直到遇到下一个并发节点为止。
 * 这样一条流水线里可以让"耗时的 AI 任务"串行跑（避免撞限频），
 * 又让"轻量的文件处理"并行跑。
 */

export type ParallelOutcome = {
  /** 解析出的并发数；'all' 模式返回 Infinity，由调用方映射到实际并发上限 */
  concurrency: number;
  /** 命中的规则下标；-1 表示走兜底 */
  ruleIndex: number;
  /** 非法正则等错误，不阻断执行 */
  errors: string[];
  /** 人类可读的说明，便于界面展示 */
  reason: string;
};

/** 全局并发上限，防止 'all' 模式把 CLI 进程打爆 */
export const MAX_CONCURRENCY = 16;

/**
 * 求解单个并发节点。
 *
 * 容错原则与条件节点一致：非法正则只跳过该规则并记录，不让整条流水线挂掉。
 */
export function resolveParallel(node: ParallelNodeData, text: string): ParallelOutcome {
  const errors: string[] = [];

  if (node.mode === 'all') {
    return {
      concurrency: Infinity,
      ruleIndex: -1,
      errors,
      reason: '不限制并发',
    };
  }

  if (node.mode === 'fixed') {
    const c = clampConcurrency(node.concurrency);
    return { concurrency: c, ruleIndex: -1, errors, reason: `固定 ${c}` };
  }

  // byRule：从上到下找第一条命中
  const rules = node.rules ?? [];
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    const r = testCondition(rule.op, text, rule.value);
    if (r === null) {
      errors.push(`规则 ${i + 1} 的正则非法：${rule.value}`);
      continue; // 跳过坏规则，继续试下一条
    }
    if (r) {
      const c = clampConcurrency(rule.concurrency);
      return {
        concurrency: c,
        ruleIndex: i,
        errors,
        reason: `命中规则 ${i + 1}：并发 ${c}`,
      };
    }
  }

  const fb = clampConcurrency(node.fallbackConcurrency);
  return {
    concurrency: fb,
    ruleIndex: -1,
    errors,
    reason: rules.length > 0 ? `未命中，兜底并发 ${fb}` : `兜底并发 ${fb}`,
  };
}

/** 并发数钳制到 [1, MAX_CONCURRENCY] */
export function clampConcurrency(n: number): number {
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(Math.floor(n), MAX_CONCURRENCY);
}

/**
 * 把 Infinity（'all' 模式）映射成实际可用的并发数。
 * 取 min(可用任务数, MAX_CONCURRENCY)。
 */
export function effectiveConcurrency(resolved: number, taskCount: number): number {
  if (!Number.isFinite(resolved)) return Math.max(1, Math.min(taskCount, MAX_CONCURRENCY));
  return Math.max(1, Math.min(resolved, Math.max(1, taskCount)));
}

/**
 * 并发规则的中文摘要（节点卡片上显示）。
 *
 * ============ 算子名只从 OP_META 取 ============
 *
 * 以前这里自带一张 opText，与 types.ts 的 OP_META、condition.ts 的
 * describeConditionCore 各写一份，共三处。已经分叉过：
 * 「匹配正则」（这里）vs「正则匹配」（OP_META）。
 *
 * 顺带修掉另一处不一致：以前**一律**拼上「比较值」，
 * 于是选「非空」时卡片显示「非空「」→ 并发 2」——
 * 那个空引号是"这里没问过 needsValue"留下的。
 */
export function describeRule(rule: ParallelRule): string {
  const meta = OP_META[rule.op as ConditionOp];
  const t = meta?.label ?? rule.op;
  const needsValue = meta ? meta.needsValue : true;
  const v = needsValue ? `「${rule.value}」` : '';
  return `${t}${v}→ 并发 ${rule.concurrency}`;
}
