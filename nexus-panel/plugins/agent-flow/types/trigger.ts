/**
 * types.ts 第 10 卷：trigger。
 *
 * 实现按域分卷，types.ts 只留 re-export 入口；外部 175 处 import 路径不变。
 * 卷内代码按原文件行序原样保留（含私有辅助与初始化顺序），不要重排。
 */


/* ------------------------------------------------------------------ */
/* 触发器                                                              */
/* ------------------------------------------------------------------ */

export type TriggerKind = 'manual' | 'interval' | 'cron' | 'watch' | 'webhook' | 'chat';

/** 各类触发器的配置，按 kind 取用对应字段；未用到的字段留默认值即可 */
export type TriggerConfig = {
  /** interval: 间隔秒数，最小 10 */
  intervalSec: number;
  /** cron: 五段表达式，如 `0 9 * * 1-5`（分 时 日 月 周） */
  cronExpr: string;
  /** watch: 监听目录（绝对路径） */
  watchDir: string;
  /** watch: 只关心这些后缀，空数组表示全部 */
  watchExts: string[];
  /** watch: 防抖毫秒，事件合并窗口 */
  debounceMs: number;
  /** watch: 是否递归监听子目录 */
  watchRecursive: boolean;
  /** webhook: 监听端口 */
  port: number;
  /** webhook: 路径，如 /hooks/run */
  path: string;
  /** webhook: 可选的校验 token，校验 X-Token 或 Authorization: Bearer */
  token: string;
  /** webhook: 是否把请求体注入 {{input}} */
  payloadToInput: boolean;

  /* ---- chat: 监听 AI 对话 ---- */
  /** 对话文件所在目录（绝对路径）。留空则用探测到的默认目录 */
  chatDir: string;
  /** 只关心这些后缀；留空时默认 jsonl */
  chatExts: string[];
  /** 关键词，一行一个；# 开头为注释 */
  chatKeywords: string;
  /** 匹配范围：只算用户说的，还是用户与 AI 都算 */
  chatScope: 'user' | 'both';
  /** 轮询间隔秒数，最小 2 */
  chatPollSec: number;
  /**
   * 命中后注入 {{input}} 的内容模板。
   * 支持 {{keyword}} {{role}} {{text}} {{excerpt}} {{file}} {{time}}
   */
  chatTemplate: string;
};

/**
 * 一个**触发条件卡片**。
 *
 * ================= 为什么要有条目 ====================
 *
 * 以前一个触发器节点是「一份共享 config + 一个 kind 数组」：
 * 选了周期和监听两种方式，两者共用同一份 `config`，
 * 界面上则挤成一个多选勾选组 + 一堆"选中才显示"的字段。
 *
 * 后果有两个：
 *   1. 改周期秒数会顺带改到别的触发方式用到的字段（它们共用一份）
 *   2. 看不出"这个节点到底配了几个触发条件"，因为它们没有各自的边界
 *
 * 现在每种触发方式是**一张独立的卡**，各带自己的 config。
 */
export type TriggerEntry = {
  /** 卡片自身的 id —— 同一个 kind 可以配多张（比如两个不同端口的调用触发） */
  id: string;
  kind: TriggerKind;
  /** 这张卡单独停用（不影响节点上其它卡） */
  enabled?: boolean;
  /** 只覆盖这张卡关心的字段，其余用节点默认 config 兜底 */
  config?: Partial<TriggerConfig>;
};

export type Trigger = {
  /** 展开后的唯一标识：多选时形如 `${nodeId}:${kind}` */
  id: string;
  /**
   * 所属画布节点 id。
   * 一个节点可挂多种触发方式，会展开成多条 Trigger，
   * 调度器用 id 区分它们，而回写节点状态时要用它找回节点。
   */
  nodeId?: string;
  name: string;
  kind: TriggerKind;
  enabled: boolean;
  config: TriggerConfig;
  /** 触发时注入的全局输入，支持 {{input}} 之外还可写固定文本 */
  input: string;
  /** 上次触发时间（毫秒时间戳），仅用于界面展示 */
  lastFiredAt: number | null;
  /** 上次触发结果 */
  lastResult: 'success' | 'failed' | null;
};

export const TRIGGER_META: Record<TriggerKind, { label: string; hint: string; icon: string }> = {
  manual:   { label: '手动触发',   hint: '点击后立即执行一次工作流',                 icon: '▶' },
  interval: { label: '周期触发',   hint: '每隔固定秒数自动执行',                     icon: '⟳' },
  cron:     { label: '定时触发',   hint: '按 cron 表达式在指定时刻执行',             icon: '⏰' },
  watch:    { label: '监听触发',   hint: '监听目录内文件变化后执行（带防抖）',       icon: '👁' },
  webhook:  { label: '调用触发',   hint: '本地起 HTTP 服务，外部调用 URL 即触发',   icon: '🔗' },
  chat:     { label: '对话触发',   hint: '监听 AI 对话，出现关键词时执行',          icon: '💬' },
};

/*
 * 下拉里的顺序（manual 在最前：它是默认档，也是唯一不需要额外配置的一档）。
 *
 * **显式列出**而不是 `Object.keys(TRIGGER_META)`，两个原因：
 *   1. 后者返回 `string[]`，拿它去索引 `Record<TriggerKind, …>` 会报
 *      TS7053（用 any 索引），TriggerNode.tsx 里正是这么写的；
 *   2. 更要命的是**漏项不会报错** —— 少给一种方式，那一档就在下拉里
 *      悄然消失，用户根本没法选，而代码看上去完全正常。
 * 下面那两行是编译期兜底，漏任何一种即报错。
 */
export const TRIGGER_KINDS = [
  'manual', 'interval', 'cron', 'watch', 'webhook', 'chat',
] as const;

/* 顺序表必须覆盖 TriggerKind 的每一种：漏了 = 该方式在界面上选不到 */
type KindsComplete = Exclude<TriggerKind, (typeof TRIGGER_KINDS)[number]> extends never ? true : never;
const _kindsComplete: KindsComplete = true;
void _kindsComplete;

export const DEFAULT_TRIGGER_CONFIG: TriggerConfig = {
  intervalSec: 300,
  cronExpr: '0 9 * * 1-5',
  watchDir: '',
  watchExts: [],
  debounceMs: 2000,
  watchRecursive: true,
  port: 8787,
  path: '/hooks/run',
  token: '',
  payloadToInput: true,

  chatDir: '',
  chatExts: [],
  chatKeywords: '',
  chatScope: 'both',
  chatPollSec: 3,
  chatTemplate: '对话中出现「{{keyword}}」：\n{{excerpt}}',
};

let triggerSeq = 0;

export function makeTrigger(kind: TriggerKind, partial: Partial<Trigger> = {}): Trigger {
  triggerSeq += 1;
  return {
    id: partial.id ?? `trg${Date.now().toString(36)}${triggerSeq}`,
    name: partial.name ?? TRIGGER_META[kind].label,
    kind,
    enabled: partial.enabled ?? true,
    config: { ...DEFAULT_TRIGGER_CONFIG, ...(partial.config ?? {}) },
    input: partial.input ?? '',
    lastFiredAt: partial.lastFiredAt ?? null,
    lastResult: partial.lastResult ?? null,
  };
}
