/**
 * 任务窗格 —— 纯逻辑层（可单测，不碰 DOM）。
 *
 * ================= 窗格解决什么问题 ====================
 *
 * 一批同类节点常常共享同一批配置：同一个项目目录、同一个模型、
 * 同一条连接、同样的自动批准开关。逐节点填一遍既费事，
 * 更麻烦的是"换目录要改十几处"，漏一处就表现为
 * "这个节点还在旧目录里跑"，而且不报错。
 *
 * 窗格把这些共享项收在一处：挂在窗格里的节点，
 * **自己没填的项**从窗格继承。
 *
 * ================= 继承的方向 ====================
 *
 * 一律是「节点优先，节点没填才用窗格」，只有一个例外（yolo，见下）。
 *
 * 反过来（窗格优先）的代价太大：窗格改一次，
 * 里面精心配好的节点全被盖掉，而且是静默的 ——
 * 用户改的是窗格，坏的却是节点，排查时会一头雾水。
 */

import type {
  TaskNodeData, TaskPaneNodeData, ApiPaneNodeData, LlmChatNodeData, CliKind,
} from '../types';

/** 窗格节点的两种 kind */
export const PANE_KINDS = ['taskPane', 'apiPane'] as const;
export type PaneKind = (typeof PANE_KINDS)[number];

/** 窗格里"某个字段被填了没有"。只有真正有内容才算填了 */
function filled(v: unknown): boolean {
  return String(v ?? '').trim().length > 0;
}

/**
 * 能被本模块处理的最小节点形状（不依赖画布类型，方便单测）。
 *
 * data 写成 unknown 而不是 Record<string, unknown>：
 * 调用方常把画布节点类型（data 是具体形状）直接传进来，
 * 写成具体类型的话那些调用在严格模式下编译不过 ——
 * 而本模块只读 data 里的个别字段（且都做了断言），
 * 放宽它并不会丢掉检查。
 */
type AnyNode = { id: string; data?: unknown };

/** 这个节点是不是窗格 */
export function isPaneNode(n: AnyNode | null | undefined): boolean {
  const k = (n?.data as { kind?: string } | null | undefined)?.kind;
  return k === 'taskPane' || k === 'apiPane';
}

/**
 * 画布上的窗格清单，供下拉框使用。
 *
 * 只列**同类**窗格：CLI 节点的下拉里不出现 API 窗格。
 * 混着列的话选了也无效 —— 窗格上的字段对不上，
 * 继承结果是"什么都没变"，而界面上明明已经选了一个窗格。
 */
export function paneOptionsOf(
  nodes: readonly AnyNode[],
  kind: PaneKind,
): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const n of nodes ?? []) {
    const d = n?.data as { kind?: string; label?: string } | null | undefined;
    if (d?.kind !== kind) continue;
    out.push({ value: n.id, label: String(d.label ?? n.id) });
  }
  return out;
}

/**
 * 挂在这个窗格下的成员节点 id。
 *
 * ================= 为什么临时数，而不存在窗格上 =================
 *
 * 归属关系是**节点上的 paneId 指向窗格**，单向。
 * 窗格上再存一份 members 就会有两处真相：
 * 节点改了 paneId 而窗格的 members 没跟着改，
 * 卡片上显示的数字就是错的 —— 而且是静默的，看不出哪边是真的。
 *
 * 所以名单不落盘，要用时现场数一遍（PaneNode 显示成员数、
 * 复制窗格时带成员一起复制，都走这里）。
 */
export function paneMembersOf(
  nodes: readonly AnyNode[],
  paneId: string | null | undefined,
): string[] {
  const id = String(paneId ?? '').trim();
  if (!id) return [];
  const out: string[] = [];
  for (const n of nodes ?? []) {
    if (!n?.id || isPaneNode(n)) continue;
    const d = n.data as { paneId?: string } | null | undefined;
    if (String(d?.paneId ?? '').trim() === id) out.push(n.id);
  }
  return out;
}

/**
 * 找窗格。
 *
 * 找不到返回 null —— 常见情形是窗格被删了而节点上的 paneId 还在。
 * 这时**按没有窗格处理**（用节点自己的配置），
 * 而不是报错：留着一个跑不动的节点比悄悄用回自己的配置更糟。
 */
export function findPane(
  nodes: readonly AnyNode[],
  paneId: string | null | undefined,
): AnyNode | null {
  const id = String(paneId ?? '').trim();
  if (!id) return null;
  for (const n of nodes ?? []) {
    if (n?.id === id) return isPaneNode(n) ? n : null;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* CLI 窗格                                                            */
/* ------------------------------------------------------------------ */

export type ResolvedTaskPane = {
  /** 生效的 CLI */
  cli: CliKind;
  /** 生效的工作目录 */
  workdir: string;
  /** 生效的模型 */
  model: string;
  /** 生效的连接 id */
  credentialId: string;
  /** 是否自动批准 */
  yolo: boolean;
  /** 窗格是否要求共享上下文 */
  shareContext: boolean;
  /** 命中的窗格 id；没挂窗格时是空串 */
  paneId: string;
};

/**
 * CLI 节点 + 它的窗格 → 真正生效的配置。
 *
 * ================= 为什么 yolo 是例外 ====================
 *
 * 其余字段都是"节点没填才用窗格"，唯独 yolo 取**节点 OR 窗格**：
 *
 * TaskNodeData.yolo 是必填布尔，节点建出来就是 false。
 * 按"节点优先"的话，窗格上的 yolo 永远轮不上 ——
 * 窗格里勾了"自动批准"，里面每个节点还是各自弹确认，
 * 表现为"窗格这个开关完全没用"。
 *
 * yolo 是**放宽权限**，取两者中较宽的那个也符合预期：
 * 窗格统一开自动批准，就是要让整批节点都不再问。
 */
export function resolveTaskPane(
  d: TaskNodeData,
  pane: AnyNode | null | undefined,
): ResolvedTaskPane {
  const p = (pane?.data ?? null) as TaskPaneNodeData | null;
  const paneId = p ? String(pane!.id) : '';
  return {
    cli: (d.cli ?? 'codebuddy') as CliKind,
    workdir: filled(d.workdir) ? String(d.workdir) : String(p?.workdir ?? ''),
    model: filled(d.model) ? String(d.model) : String(p?.model ?? ''),
    credentialId: filled(d.credentialId) ? String(d.credentialId) : String(p?.credentialId ?? ''),
    yolo: Boolean(d.yolo) || Boolean(p?.yolo),
    shareContext: p ? p.shareContext !== false : false,
    paneId,
  };
}

/* ------------------------------------------------------------------ */
/* API 窗格                                                            */
/* ------------------------------------------------------------------ */

export type ResolvedApiPane = {
  /** 生效的连接 id */
  credentialId: string;
  /** 生效的模型 */
  model: string;
  /** 生效的 system 提示词 */
  system: string;
  /** 生效的温度 */
  temperature: number;
  /** 是否要求 JSON 输出 */
  jsonMode: boolean;
  /** 命中的窗格 id */
  paneId: string;
};

/** 没配温度时的兜底 */
export const DEFAULT_TEMPERATURE = 0.3;

/**
 * 大模型节点 + 它的 API 窗格 → 真正生效的配置。
 *
 * temperature 走三级回落：节点 → 窗格 → 默认 0.3。
 * 节点上给默认值的话窗格那一级就永远轮不上，
 * 所以 LlmChatNodeData.temperature 刻意做成可选（见 types.ts）。
 */
export function resolveApiPane(
  d: LlmChatNodeData,
  pane: AnyNode | null | undefined,
): ResolvedApiPane {
  const p = (pane?.data ?? null) as ApiPaneNodeData | null;
  const t =
    typeof d.temperature === 'number' && isFinite(d.temperature)
      ? d.temperature
      : typeof p?.temperature === 'number' && isFinite(p.temperature)
        ? p.temperature
        : DEFAULT_TEMPERATURE;
  return {
    credentialId: filled(d.credentialId) ? String(d.credentialId) : String(p?.credentialId ?? ''),
    model: filled(d.model) ? String(d.model) : String(p?.model ?? ''),
    system: filled(d.system) ? String(d.system) : String(p?.system ?? ''),
    temperature: t,
    jsonMode: Boolean(d.jsonMode) || Boolean(p?.jsonMode),
    paneId: p ? String(pane!.id) : '',
  };
}

/* ------------------------------------------------------------------ */
/* 共享上下文                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把前面几步的结果接进本次提示词。
 *
 * ================= 为什么不直接改 prompt ====================
 *
 * 写回 prompt 的话，这段上下文会**留在存档里**：
 * 下次跑的时候它还在，于是第二次跑看到的上下文是第一次的结果 ——
 * 越跑越长，而且和当前这次的输入混在一起，根本分不清哪句是新的。
 *
 * 所以只在运行时拼，不落盘。
 *
 * @param prev 同一窗格内、本次已经跑完的上游输出（按顺序）
 */
export function withPaneContext(
  prompt: string,
  prev: readonly string[],
  shareContext: boolean,
): string {
  const body = String(prompt ?? '');
  if (!shareContext) return body;
  const lines = (prev ?? [])
    .map((s) => String(s ?? '').trim())
    .filter((s) => s.length > 0);
  if (lines.length === 0) return body;

  const head = lines
    .map((s, i) => `${i + 1}. ${s.length > 2000 ? `${s.slice(0, 2000)}…（已截断）` : s}`)
    .join('\n');

  return `【前面步骤的结果】\n${head}\n\n【本次任务】\n${body}`;
}
