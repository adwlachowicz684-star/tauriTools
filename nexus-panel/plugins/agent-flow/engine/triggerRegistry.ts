/**
 * 全局触发器注册表 —— 把所有画布的触发器集中管理。
 *
 * ================= 为什么需要这一层 =================
 *
 * 触发器原本只从**当前画布**的 nodes 里收集。于是：
 * 切走一张画布，它的目录监听、webhook、周期任务就全停了。
 *
 * 对"一整套数值拆成很多张画布"来说这是致命的 ——
 * 用户会以为监听还在，实际早停了，而且**没有任何提示**。
 *
 * 所以改成：扫描**所有画布**，由全局统一代为监听。
 *
 * ================= 后台开关的语义 =================
 *
 * 触发节点上多一个「后台监听」开关（默认开）：
 *
 *   · 开着 → 全局代为监听，**不管这张画布打没打开**
 *   · 关掉 → 全局不监听；但画布被打开（激活）时仍会临时接管
 *
 * 第二条是关键：关掉不代表"这个触发器废了"，
 * 只是"别在后台偷偷跑"。用户打开那张画布时它照常工作 ——
 * 否则会出现"我明明配了周期任务，打开画布也不动"这种困惑。
 *
 * ================= 触发后怎么办 =================
 *
 * 外部事件来了 → 找到它属于哪张画布 → 跑那张画布。
 * 所以每条记录都要带 canvasId，光有 nodeId 不够 ——
 * nodeId 只在同一张画布内唯一，跨画布会撞。
 */

import type { Trigger, TriggerKind, TriggerConfig } from '../types';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/**
 * 一条全局触发器。
 *
 * 比 Trigger 多两个字段：
 *   · canvasId —— 属于哪张画布（触发后要跑它）
 *   · background —— 是否由全局代为监听
 */
export type GlobalTrigger = Trigger & {
  canvasId: string;
  canvasName?: string;
  background: boolean;
};

/** 扫描所需的最小画布视图 */
export type TriggerCanvasView = {
  id: string;
  name: string;
  nodes: { id: string; data?: Record<string, unknown> }[];
};

/* ------------------------------------------------------------------ */
/* 收集                                                                */
/* ------------------------------------------------------------------ */

const DEFAULT_BG = true;

/**
 * 后台开关的默认值。
 *
 * 导出而不是散在各处写 `!== false`：
 * 默认值改一处就够了，也方便测试断言"默认是开着的"。
 */
export function defaultBackground(): boolean {
  return DEFAULT_BG;
}

/** 读一个触发节点的后台开关；没填按默认（开） */
export function backgroundOf(data: Record<string, unknown> | undefined): boolean {
  const v = (data ?? {}).background;
  if (v === undefined || v === null) return DEFAULT_BG;
  // 老数据可能存成字符串（表单件传上来时）
  if (typeof v === 'string') return v !== 'false';
  return v !== false;
}

/** 触发节点是否被禁用（节点级开关，与后台开关是两回事） */
function enabledOf(data: Record<string, unknown> | undefined): boolean {
  const v = (data ?? {}).enabled;
  return v !== false;
}

export function isTriggerNode(data: Record<string, unknown> | undefined): boolean {
  return String((data ?? {}).kind ?? '') === 'trigger';
}

/** 兼容旧的单值字段：读取一律走这里 */
export function triggerKindsOf(data: Record<string, unknown> | undefined): TriggerKind[] {
  const d = data ?? {};
  const multi = d.triggers;
  if (Array.isArray(multi) && multi.length > 0) return multi as TriggerKind[];
  const single = d.trigger;
  if (single) return [single as TriggerKind];
  return [];
}

/**
 * 扫描所有画布，收集触发器。
 *
 * id 必须带 canvasId ——
 * 只用 nodeId 的话两张画布里各有一个 t1 会撞车，
 * 表现为"触发了但跑的是另一张画布"，极难排查。
 */
export function collectGlobalTriggers(
  canvases: TriggerCanvasView[],
  defaultConfig: TriggerConfig,
): GlobalTrigger[] {
  const out: GlobalTrigger[] = [];
  for (const c of canvases ?? []) {
    for (const n of c.nodes ?? []) {
      const d = (n?.data ?? {}) as Record<string, unknown>;
      if (!isTriggerNode(d)) continue;
      if (!enabledOf(d)) continue; // 节点被禁用 → 完全不管

      const kinds = triggerKindsOf(d);
      if (kinds.length === 0) continue;

      const base = { ...defaultConfig, ...((d.config ?? {}) as Record<string, unknown>) } as TriggerConfig;
      const bg = backgroundOf(d);

      for (const kind of kinds) {
        out.push({
          id: `${c.id}::${n.id}:${kind}`,
          nodeId: n.id,
          canvasId: c.id,
          canvasName: c.name,
          name: String(d.label ?? n.id ?? ''),
          kind,
          enabled: true,
          background: bg,
          config: base,
          input: String(d.input ?? ''),
          lastFiredAt: null,
          lastResult: null,
        } as GlobalTrigger);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 分组：哪些该由全局接管                                                */
/* ------------------------------------------------------------------ */

export type TriggerScope = {
  /** 全局代管的（不管画布打没打开都监听） */
  background: GlobalTrigger[];
  /** 仅当前激活画布才接管的 */
  foreground: GlobalTrigger[];
};

/**
 * 按后台开关分组。
 *
 * 后台的始终监听；非后台的只在它的画布处于激活态时才接管。
 */
export function splitByScope(
  all: GlobalTrigger[],
  activeCanvasId: string | null | undefined,
): TriggerScope {
  const background: GlobalTrigger[] = [];
  const foreground: GlobalTrigger[] = [];
  for (const t of all ?? []) {
    if (t.background) {
      background.push(t);
      continue;
    }
    if (activeCanvasId && t.canvasId === activeCanvasId) foreground.push(t);
  }
  return { background, foreground };
}

/** 当前实际该运行的：后台 + 激活画布的前台 */
export function activeTriggers(
  all: GlobalTrigger[],
  activeCanvasId: string | null | undefined,
): GlobalTrigger[] {
  const s = splitByScope(all, activeCanvasId);
  return [...s.background, ...s.foreground];
}

/* ------------------------------------------------------------------ */
/* 去重与说明                                                          */
/* ------------------------------------------------------------------ */

/**
 * 去掉同一个画布里重复的监听目标。
 *
 * 目录监听最容易出现：两张画布都监听同一个目录，
 * 于是改一次文件触发两遍。这在数值推导里会白跑很久。
 */
export function dedupeWatchDirs(list: GlobalTrigger[]): GlobalTrigger[] {
  const seen = new Set<string>();
  const out: GlobalTrigger[] = [];
  for (const t of list ?? []) {
    if (t.kind !== 'watch') { out.push(t); continue; }
    const dir = String((t.config as Record<string, unknown>)?.watchDir ?? '').trim();
    if (!dir) { out.push(t); continue; }
    if (seen.has(dir)) continue;
    seen.add(dir);
    out.push(t);
  }
  return out;
}

/** 给界面用的摘要：几张画布、几个后台、几个仅前台 */
export function describeRegistry(
  all: GlobalTrigger[],
  activeCanvasId: string | null | undefined,
): string {
  const total = (all ?? []).length;
  if (total === 0) return '没有启用的触发器';
  const s = splitByScope(all, activeCanvasId);
  const canvases = new Set((all ?? []).map((t) => t.canvasId)).size;
  return `${total} 个触发器分布在 ${canvases} 张画布 · 全局代管 ${s.background.length} · 仅当前画布 ${s.foreground.length}`;
}
