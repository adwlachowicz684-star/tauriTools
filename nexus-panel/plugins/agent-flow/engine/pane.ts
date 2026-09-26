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
import { topoLayers } from './topo';
import { paramLinksOf } from './paramLinks';

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
  /**
   * 这个节点能不能接上一次会话（要先看 CLI 支持不支持）。
   *
   * 窗格开了开关、且这个节点的 CLI **本身**支持接力才为 true ——
   * 窗格开关只是"想接力"，能不能接得上取决于 CLI。
   */
  canRelay: boolean;
  /** 命中的窗格 id；没挂窗格时是空串 */
  paneId: string;
};

/** 支持「接着上次会话」的 CLI。traecli 官方没有给恢复参数，不能带 */
export const RELAY_CLIS: readonly CliKind[] = ['codebuddy'];

/** 这个 CLI 支不支持接力 */
export function supportsRelay(cli: CliKind | string | undefined | null): boolean {
  return RELAY_CLIS.includes(String(cli ?? '') as CliKind);
}

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
  const cli = (d.cli ?? p?.cli ?? 'codebuddy') as CliKind;
  return {
    cli,
    workdir: filled(d.workdir) ? String(d.workdir) : String(p?.workdir ?? ''),
    model: filled(d.model) ? String(d.model) : String(p?.model ?? ''),
    credentialId: filled(d.credentialId) ? String(d.credentialId) : String(p?.credentialId ?? ''),
    yolo: Boolean(d.yolo) || Boolean(p?.yolo),
    shareContext: p ? p.shareContext !== false : false,
    /*
     * 能不能接力 = 窗格开了 && CLI 支持。
     * 只看窗格开关的话，traecli 也会被带上 `-c`，
     * 而它把这个参数当未知选项、直接报错退出 ——
     * 用户看到的是"开了开关之后节点全挂了"，想不到是 CLI 不支持。
     */
    canRelay: Boolean(p?.relaySession) && supportsRelay(cli),
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

/**
 * 同一窗格内、排在**本节点之前**且已经跑完的成员输出，按执行顺序。
 *
 * ================= 为什么按拓扑序而不是节点数组序 =================
 *
 * graph.nodes 是创建顺序，与执行顺序无关。按它取的话，
 * "第 1 步的结果"可能是流程里第 4 步才跑到的节点 ——
 * 上下文本身没错位、也没报错，只是顺序讲不通，读起来像乱的。
 *
 * 顺带过滤掉本节点自己：跑循环时它上一轮的输出已经在 outputs 里了，
 * 不自带来的话，第二轮会把第一轮的结果当成"上一步"再喂一遍。
 *
 * 成环的节点排不进 layers（topoLayers 会把它们放进 cyclic），
 * 这里自然取不到 —— 拿不到就少一段上下文，比编一个顺序出来强。
 *
 * ================= 排序必须计入参数连线 =================
 *
 * 窗格里两个成员之间可能只有参数连线（A 的输出填进 B 的某个参数），
 * 没有流程连线。不计入的话 A 与 B 在同一层，谁先谁后由 nodes 数组
 * 的创建顺序决定 —— 而执行顺序是 runner 那边**计入了**参数连线排的。
 *
 * 两份顺序不一致的后果：B 实际比 A 先跑完（按这里排的顺序取上下文），
 * 于是 A 刚产出的结果被当成"上一步"喂给 B，讲不通；
 * 反过来 B 排到 A 之前，则 A 的输出根本取不到，静默少一段。
 *
 * 所以这里与 runner 用同一份排序输入 —— 各排一份迟早对不上。
 */
export function panePrevOutputs(
  graph: {
    nodes?: readonly AnyNode[];
    edges?: readonly { source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null; data?: unknown }[];
  } | null | undefined,
  nodeId: string,
  paneId: string | null | undefined,
  outputs: Readonly<Record<string, string | undefined>> | undefined,
): string[] {
  const id = String(paneId ?? '').trim();
  if (!id || !graph?.nodes?.length) return [];

  const members = new Set(paneMembersOf(graph.nodes, id));
  if (members.size === 0) return [];

  const order: string[] = [];
  const links = paramLinksOf((graph.edges ?? []) as never);
  for (const layer of topoLayers(graph as never, links).layers) {
    for (const nid of layer) order.push(nid);
  }

  const out: string[] = [];
  for (const nid of order) {
    if (nid === nodeId) break; // 只取排在本节点之前的
    if (!members.has(nid)) continue;
    const v = outputs?.[nid];
    if (typeof v === 'string' && v.trim().length > 0) out.push(v);
  }
  return out;
}
