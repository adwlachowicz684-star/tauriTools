/**
 * 执行范围 —— 所有流程都从触发器开始。
 *
 * ================= 为什么要这一层 =================
 *
 * 以前 runGraph 把图上**所有节点**排个序就全跑了。于是：
 *
 *   画布角落里有个调试用的 HTTP 节点，从没接过任何东西，
 *   点一下运行它也照跑 —— 半夜定时任务带起来的时候也照跑。
 *
 * 这不是"多跑了几个节点"这么轻：那些孤立节点连不上任何输入，
 * 跑出来的结果没有意义，而失败会把整条流程标红，
 * 排查时日志里有一堆跟本次触发毫无关系的记录。
 *
 * 所以执行范围必须**从触发器出发沿边算出来**，而不是"图上有就跑"。
 *
 * ================= 三条规则的取舍 =================
 *
 *  1. 入口只能是一个具体触发器
 *     自动触发（周期 / 定时 / 监听 / 调用）时，只跑被触发的那一条链路。
 *     否则一个周期任务到期会带起整张画布，等于"一次触发，全部重跑"。
 *
 *  2. 范围 = 沿正向边可达 + 参数连线的来源
 *     只有可达集的话，"拖个数字常量连到参数上"会失效 ——
 *     常量节点没接在流程链路上，被排除后目标参数拿到空值，
 *     而画布上那根紫线明明画着。
 *
 *  3. 范围外的节点静默排除
 *     不进 skipped —— 它们不是"被上游阻断"，是"本来就与本次触发无关"。
 *     混进 skipped 会让任务记录里多出一堆看不懂的灰节点。
 */

import type { Graph, GraphEdge } from '../types';
import { paramLinksOf, flowEdgesOf } from './paramLinks';

/* ------------------------------------------------------------------ */
/* 报错文案                                                            */
/* ------------------------------------------------------------------ */

/**
 * 没有触发器可以当入口。
 *
 * 导出成常量：App 侧要在运行前先判一次（早于建任务记录），
 * 两处各写一份字符串迟早会写得不一样，
 * 而"两句话长得像但不完全一样"正是排查时最难对齐的那类线索。
 */
export const ERR_NO_TRIGGER = '没有启用的触发器作为入口，流程不执行';

export function errEntryMissing(id: string): string {
  return `入口触发器 ${id} 不在当前画布上，本次不执行`;
}

/* ------------------------------------------------------------------ */
/* 判定                                                                */
/* ------------------------------------------------------------------ */

/** 一个节点是不是触发器（只看 kind，不看启用与否） */
export function isTriggerKind(data: Record<string, unknown> | undefined): boolean {
  return String((data ?? {}).kind ?? '') === 'trigger';
}

/** 图上全部触发器节点的 id */
export function triggerIdsOf(g: Graph): string[] {
  return g.nodes.filter((n) => isTriggerKind(n.data as Record<string, unknown>)).map((n) => n.id);
}

/* ------------------------------------------------------------------ */
/* 可达                                                                */
/* ------------------------------------------------------------------ */

/**
 * 从一组起点沿正向边能走到的全部节点（含起点自身）。
 *
 * 用迭代栈而不是递归：链路很深或环存在时递归会爆栈，
 * 而这里的输入是用户画的图，形状完全不可控。
 */
export function reachableFrom(
  starts: string[],
  edges: GraphEdge[],
  nodeIds?: Set<string>,
): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges ?? []) {
    if (nodeIds && (!nodeIds.has(e.source) || !nodeIds.has(e.target))) continue;
    const cur = adj.get(e.source);
    if (cur) cur.push(e.target);
    else adj.set(e.source, [e.target]);
  }
  const out = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const nxt of adj.get(id) ?? []) stack.push(nxt);
  }
  return out;
}

/**
 * 把参数连线的来源节点补进范围。
 *
 * 只看可达集内节点的入参连线，再对补进来的节点递归 ——
 * 常量连常量、常量再连运算这类链条要一路追到底，
 * 断在中间的表现是"最后那一步拿到空值"，看不出是链条上哪一环没跑。
 */
export function withParamSources(ids: Set<string>, links: { source: string; target: string }[]): Set<string> {
  const out = new Set(ids);
  const byTarget = new Map<string, string[]>();
  for (const l of links ?? []) {
    const cur = byTarget.get(l.target);
    if (cur) cur.push(l.source);
    else byTarget.set(l.target, [l.source]);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const id of [...out]) {
      for (const src of byTarget.get(id) ?? []) {
        if (out.has(src)) continue;
        out.add(src);
        grew = true;
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 入口判定                                                            */
/* ------------------------------------------------------------------ */

export type EntryScope =
  | { ok: true; ids: Set<string>; entry: string }
  | { ok: false; message: string };

/**
 * 算出这次运行该执行哪些节点。
 *
 * @param entry 入口触发器节点 id。不给则从图上全部触发器出发 ——
 *              那是"手动点运行"的语义；自动触发必须给，只跑那一条链路。
 *
 * 不传 entry 且图上没有触发器时返回 not-ok ——
 * 这正是"没有触发器的流程也执行了"那个 bug 的根因。
 */
export function entryScopeOf(g: Graph, entry?: string): EntryScope {
  const nodeIds = new Set(g.nodes.map((n) => n.id));
  let starts: string[];

  if (entry !== undefined) {
    /*
     * 指定入口但该节点不在图上 → 明确报错，不要退化成"全跑"。
     *
     * 退化最危险：后台触发器属于一张已删除的画布时，
     * "跑当前这张"会让用户以为自己的定时任务在正常工作。
     */
    if (!nodeIds.has(entry)) return { ok: false, message: errEntryMissing(entry) };
    starts = [entry];
  } else {
    starts = triggerIdsOf(g);
  }

  if (starts.length === 0) return { ok: false, message: ERR_NO_TRIGGER };

  const flow = reachableFrom(starts, flowEdgesOf(g.edges), nodeIds);
  const ids = withParamSources(flow, paramLinksOf(g.edges));
  return { ok: true, ids, entry: entry ?? starts[0] };
}
