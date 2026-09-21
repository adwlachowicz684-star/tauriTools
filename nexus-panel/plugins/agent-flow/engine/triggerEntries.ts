import type { TriggerConfig, TriggerEntry, TriggerKind } from '../types';

/**
 * 触发条件卡片 —— 一个触发器节点上可以有**多张卡**，每张互不干扰。
 *
 * ================= 为什么不是「一份 config + 一个 kind 数组」 ====================
 *
 * 老结构是 `triggers: TriggerKind[]` 配一份共享的 `config`：
 *
 *   1. 改「周期」的秒数会顺带改到别的触发方式也在读的字段 ——
 *      因为它们共用同一份 config，而"哪些字段归谁"只存在于界面代码里
 *   2. 界面上是一组勾选框 + 一堆"选中才显示"的字段，
 *      看不出这个节点到底配了几个条件、各自边界在哪
 *
 * 现在每张卡自带 `config`（只写自己关心的字段），
 * 缺的字段由节点的默认 config 兜底 —— 见 mergeConfig。
 *
 * ================= 兼容 ====================
 *
 * 大量老存档只有 `triggers` / `trigger` + 共享 config。
 * 读取时**一律**走 triggerEntriesOf 迁移成条目，不在别处直接读老字段 ——
 * 两处各读一套就会出现"界面显示两张卡、跑起来只认一种"。
 */

type AnyData = Record<string, unknown>;

/** 卡片 id：时间 + 序号。不用 kind —— 同一个 kind 可以配多张 */
export function makeEntryId(seq: number, now = Date.now()): string {
  return `te${now.toString(36)}${seq}`;
}

export function makeTriggerEntry(kind: TriggerKind, id: string): TriggerEntry {
  return { id, kind, enabled: true, config: {} };
}

/* ------------------------------------------------------------------ */
/* 读                                                                  */
/* ------------------------------------------------------------------ */

function isValidKind(v: unknown): v is TriggerKind {
  return v === 'manual' || v === 'interval' || v === 'cron'
    || v === 'watch' || v === 'webhook' || v === 'chat';
}

/**
 * 老存档的 kind 列表。
 *
 * 逐项校验而不只是看数组长度 —— 老存档里存过 `[null]`（是个真 bug，已修），
 * 长度是 1 却根本没有可用项，界面会拿到一个 undefined 去查表然后整棵崩。
 */
function legacyKinds(d: AnyData): TriggerKind[] {
  const multi = d.triggers;
  if (Array.isArray(multi)) {
    const out = multi.filter(isValidKind);
    if (out.length > 0) return out;
    return [];
  }
  const single = d.trigger;
  return isValidKind(single) ? [single] : [];
}

/**
 * 取这个节点上的全部触发条件卡片。
 *
 * 老存档（没有 entries）现算一份出来 —— **不写回**，
 * 等用户真的改了再落盘，免得打开一次就把存档全改一遍。
 */
export function triggerEntriesOf(data: AnyData | undefined): TriggerEntry[] {
  const d = data ?? {};
  const raw = d.entries;
  if (Array.isArray(raw)) {
    const out: TriggerEntry[] = [];
    for (const e of raw) {
      const id = String((e as AnyData)?.id ?? '').trim();
      const kind = (e as AnyData)?.kind;
      // id 为空会导致 React key 重复：两张卡的 key 都是 undefined
      if (!id || !isValidKind(kind)) continue;
      out.push({
        id,
        kind,
        enabled: (e as AnyData).enabled !== false,
        config: ((e as AnyData).config ?? {}) as Partial<TriggerConfig>,
      });
    }
    if (out.length > 0) return out;
  }
  return legacyKinds(d).map((k, i) => makeTriggerEntry(k, `${'legacy'}${i}_${k}`));
}

/** 这张卡实际生效的配置：节点默认 config 打底，卡片自己的覆盖上去 */
export function mergeConfig(
  base: TriggerConfig | undefined,
  own: Partial<TriggerConfig> | undefined,
): TriggerConfig {
  return { ...(base ?? ({} as TriggerConfig)), ...(own ?? {}) } as TriggerConfig;
}

/** 卡片开了吗。老存档的条目没这个字段 —— 一律当开 */
export function entryEnabled(e: TriggerEntry): boolean {
  return e.enabled !== false;
}

/* ------------------------------------------------------------------ */
/* 改                                                                  */
/* ------------------------------------------------------------------ */

export function addTriggerEntry(
  entries: TriggerEntry[],
  kind: TriggerKind,
  id: string,
): TriggerEntry[] {
  return [...entries, makeTriggerEntry(kind, id)];
}

export function removeTriggerEntry(entries: TriggerEntry[], id: string): TriggerEntry[] {
  return entries.filter((e) => e.id !== id);
}

export function patchTriggerEntry(
  entries: TriggerEntry[],
  id: string,
  patch: Partial<TriggerEntry>,
): TriggerEntry[] {
  return entries.map((e) => (e.id === id ? { ...e, ...patch } : e));
}

/** 改某张卡的 config 字段（只写它自己关心的那些） */
export function patchEntryConfig(
  entries: TriggerEntry[],
  id: string,
  patch: Partial<TriggerConfig>,
): TriggerEntry[] {
  return entries.map((e) => (
    e.id === id ? { ...e, config: { ...(e.config ?? {}), ...patch } } : e
  ));
}
