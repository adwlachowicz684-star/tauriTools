/**
 * 多画布管理（纯逻辑，可单测）。
 *
 * 每个画布是一个独立的工作流：自己的节点、连线、触发器。
 * 增删改名切换都在这层完成，UI 只负责调用与渲染。
 */

/*
 * 类型走 import type（编译后消失），值**不用静态 import**：
 * 用惰性取值而不是在模块顶层直接 import —— 见下面 canvasConfigOf 的实现。
 */
import type { CanvasConfig } from './canvasConfig';
import { SECRET_PATHS } from './sanitize';

/*
 * 判断一个名字像不像密钥。
 *
 * 这里**内联**了一份，没有 import sanitize 那份 ——
 * 若在模块顶层直接取，会出现运行时 "looksLikeSecretName is not defined"
 * （且不报编译错，只在加载顺序不对时才炸）。
 * 两份的一致性由 tests/canvasConfig 里那条测试盯着。
 */
function looksLikeSecretName(name: string): boolean {
  const n = String(name ?? '').toLowerCase().replace(/[^a-z]/g, '');
  if (!n) return false;
  const hints = ['token', 'secret', 'password', 'passwd', 'apikey', 'accesskey'];
  for (const h of hints) {
    if (n.includes(h)) return true;
  }
  return false;
}

export type Canvas = {
  id: string;
  name: string;
  /** 节点，元素类型由调用方决定（React Flow 节点） */
  nodes: unknown[];
  edges: unknown[];
  /**
   * 画布级配置：MCP 服务与全局环境变量。
   *
   * 属于**这张画布**，不是某个节点，也不做全局共享 ——
   * 换一张画布该有各自的配法（不同流程要连不同的服务）。
   */
  config?: CanvasConfig;
  createdAt: number;
  updatedAt: number;
};

export type CanvasMeta = {
  id: string;
  name: string;
  nodeCount: number;
  edgeCount: number;
  updatedAt: number;
};

let seq = 0;

export function makeCanvas(name: string, partial: Partial<Canvas> = {}): Canvas {
  seq += 1;
  const now = Date.now();
  return {
    id: partial.id ?? `cv${now.toString(36)}${seq}`,
    name,
    nodes: partial.nodes ?? [],
    edges: partial.edges ?? [],
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}

/** 新建时给个不重复的默认名：工作流 1 / 2 / 3 … */
export function nextCanvasName(existing: Canvas[], base = '工作流'): string {
  const used = new Set(existing.map((c) => c.name));
  let i = 1;
  while (used.has(`${base} ${i}`)) i += 1;
  return `${base} ${i}`;
}

/**
 * 改名。
 * 同名自动加后缀，避免两个画布分不清；空名回退到原名。
 */
export function renameCanvas(
  list: Canvas[],
  id: string,
  rawName: string,
): { list: Canvas[]; name: string } {
  const name = (rawName ?? '').trim();
  const target = list.find((c) => c.id === id);
  if (!target) return { list, name: rawName };

  if (name === '' || name === target.name) {
    return { list, name: target.name };
  }

  // 与其他画布重名 → 追加 (2) (3)…
  const others = new Set(list.filter((c) => c.id !== id).map((c) => c.name));
  let finalName = name;
  if (others.has(finalName)) {
    let i = 2;
    while (others.has(`${name} (${i})`)) i += 1;
    finalName = `${name} (${i})`;
  }

  return {
    list: list.map((c) => (c.id === id ? { ...c, name: finalName, updatedAt: Date.now() } : c)),
    name: finalName,
  };
}

export function removeCanvas(
  list: Canvas[],
  id: string,
): { list: Canvas[]; removed: Canvas | null } {
  const removed = list.find((c) => c.id === id) ?? null;
  return { list: list.filter((c) => c.id !== id), removed };
}

/**
 * 删除后该激活谁。
 * 优先选被删画布的**后一个**，没有则前一个，都没有则 null（说明全删光了）。
 * 这个顺序符合直觉：删掉中间一项，焦点落到它后面那项。
 */
export function nextActiveId(list: Canvas[], removedId: string, removedIndex: number): string | null {
  if (list.length === 0) return null;
  if (removedIndex < 0) return list[0]?.id ?? null;
  const nextIdx = Math.min(removedIndex, list.length - 1);
  return list[nextIdx].id;
}

/**
 * 内容是否真的变了。
 *
 * 先比引用（React Flow 没动过时给的是同一份数组），再比序列化结果。
 * 只比引用不够：画布改动后拿到的总是新数组，那样每次都会刷新 updatedAt。
 */
function sameContent(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // 循环引用之类的极端情况：宁可当作变了，也不能漏存
    return false;
  }
}

/**
 * 更新某个画布的节点与连线。
 *
 * **幂等**：内容没变就原样返回入参，不刷 updatedAt。
 *
 * 不幂等会怎样（这是个真实的 bug，别把优化删掉）：
 * 保存 effect 调它 → 产生新的 canvases 引用与新的 updatedAt →
 * effect 的依赖里有 canvases → 再跑一次 → 400ms 后再保存……
 * 于是即使什么都不做，也会每 400ms 全量序列化写一次 localStorage。
 * updatedAt 一直跳还会让 sortForDisplay 的结果反复重排。
 *
 * 返回原数组（而不是新数组）还有一层好处：React 见到引用没变会直接跳过
 * 重渲染与后续 effect，循环从两头都被掐断。
 */
export function updateCanvasContent(
  list: Canvas[],
  id: string,
  patch: { nodes?: unknown[]; edges?: unknown[] },
): Canvas[] {
  const target = list.find((c) => c.id === id);
  if (!target) return list;

  const nodes = patch.nodes ?? target.nodes;
  const edges = patch.edges ?? target.edges;
  if (sameContent(target.nodes, nodes) && sameContent(target.edges, edges)) {
    return list;
  }

  return list.map((c) =>
    c.id === id
      ? {
          ...c,
          nodes,
          edges,
          updatedAt: Date.now(),
        }
      : c,
  );
}

export function toMeta(c: Canvas): CanvasMeta {
  return {
    id: c.id,
    name: c.name,
    nodeCount: c.nodes.length,
    edgeCount: c.edges.length,
    updatedAt: c.updatedAt,
  };
}

/** 列表展示用：按更新时间倒序（最近编辑的在前面） */
export function sortForDisplay(list: Canvas[]): Canvas[] {
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
}

/* ------------------------------------------------------------------ */
/* 持久化                                                              */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = 'agent-flow.canvases.v1';
const ACTIVE_KEY = 'agent-flow.activeCanvas.v1';

/*
 * ⚠️ 密钥**不再单独落盘**（原 `agent-flow.llm-keys.v1` 保险箱已移除）。
 *
 * 原先的做法：把节点上内联填的 apiKey / token 挖出来加密存一份，刷新后回填。
 * 那条路的问题是加密用的盐与本机特征都在本机，拿到整个数据目录的人
 * 照样能复现钥匙 —— 是"抬成本"不是"上锁"。
 *
 * 现在统一走**凭据中心**：节点只存 credentialId 引用，密钥本体由凭据库保管，
 * 可选 OS 凭据管理器 / 本机加密 / 口令模式三种，其中口令模式的钥匙不落盘。
 *
 * 节点上内联填写的字段仍然保留（兼容旧画布），但**只活在内存里** ——
 * redactSecrets 保证它既不写进画布存档、也不随导出走，刷新后为空。
 */

export type PersistedState = {
  canvases: Canvas[];
  activeId: string | null;
};

/* ------------------------------------------------------------------ */
/* 密钥脱敏                                                            */
/* ------------------------------------------------------------------ */

/**
 * 节点上可能存着密钥的字段。
 *
 * llm.apiKey —— OCR / 翻译节点的大模型密钥
 * token      —— GitHub 节点的内联令牌（更新检测 / 推送）
 *
 * 后者权限更大：一个带 repo 的令牌能直接改别人的仓库，
 * 所以两个字段一起脱敏，不因为"清单里只提了 apiKey"就放过它。
 */
/*
 * 密钥字段清单**直接复用 sanitize 的 SECRET_PATHS**，不再自己抄一份。
 *
 * 以前这里是 `['llm.apiKey', 'token']` —— 比 SECRET_PATHS 少了
 * 'config.token'（webhook 触发器的校验密钥）。
 *
 * 后果：那个 token 会被 stripSecrets 认出来（面板上提示"不会存"），
 * 却**不会被挖进保险箱**，于是明文留在画布存档与导出文件里。
 * 而 webhook token 泄露意味着别人能伪造请求触发你的工作流 ——
 * 工作流能起 CLI、读写授权目录。
 *
 * 这正是"同一件事两处写"的老问题，只是这次抄的是安全清单。
 * 以后新增密钥字段只改 SECRET_PATHS 一处。
 */
const SECRET_FIELDS = SECRET_PATHS;
export type SecretField = (typeof SECRET_PATHS)[number];

/** 按点号路径取值。路径不存在或不是非空字符串则返回 null */
function pathGet(data: Record<string, unknown>, path: string): string | null {
  const parts = path.split('.');
  let cur: unknown = data;
  for (const p of parts) {
    if (!cur || typeof cur !== 'object') return null;
    cur = (cur as Record<string, unknown>)[p];
  }
  return typeof cur === 'string' && cur !== '' ? cur : null;
}

/** 按点号路径写值，返回新的 data。只改这一条路径，其余保持原引用 */
function pathSet(
  data: Record<string, unknown>,
  path: string,
  value: string,
): Record<string, unknown> {
  const parts = path.split('.');
  if (parts.length === 1) return { ...data, [parts[0]]: value };
  const head = data[parts[0]];
  if (!head || typeof head !== 'object' || Array.isArray(head)) return data;
  return {
    ...data,
    [parts[0]]: { ...(head as Record<string, unknown>), [parts[1]]: value },
  };
}

/** 取节点上某个密钥字段的值；不存在或不是字符串则返回 null */
function getSecretField(data: Record<string, unknown>, field: SecretField): string | null {
  return pathGet(data, field);
}

/** 把某个密钥字段写成空串，返回新的 data */
function blankSecretField(
  data: Record<string, unknown>,
  field: SecretField,
): Record<string, unknown> {
  return pathSet(data, field, '');
}

/**
 * 判断并处理单个节点：把密钥字段挖空。
 *
 * 用鸭子类型而不是导入 isOcr / isTranslate：
 *  · Canvas.nodes 是 unknown[]，这层不该知道具体节点类型
 *  · 以后新增任何带 llm / token 的节点都会自动覆盖，不用回来改
 *
 * 只认「节点形态」{ id, data: { kind, … } }，不去递归扫 output ——
 * 否则用户让 AI 生成一段恰好含 llm 字样的文本，会被误改。
 */
function redactNode(n: unknown): unknown {
  if (!n || typeof n !== 'object') return n;
  const o = n as Record<string, unknown>;
  const d = o.data;
  if (!d || typeof d !== 'object') return n;
  const dd = d as Record<string, unknown>;
  if (typeof dd.kind !== 'string') return n;

  let next = dd;
  for (const f of SECRET_FIELDS) {
    if (getSecretField(next, f) !== null) next = blankSecretField(next, f);
  }
  if (next === dd) return n;
  return { ...o, data: next };
}

/** 节点数组脱敏。导出文件、写 localStorage 之前都应该过一遍。 */
export function redactNodes(nodes: unknown[]): unknown[] {
  return (nodes ?? []).map(redactNode);
}


/**
 * 画布配置里的 MCP 环境变量脱敏。
 *
 * 变量名由用户随便起，没法用固定路径枚举 ——
 * 所以按**名字像不像密钥**判断（见 sanitize 的 looksLikeSecretName）。
 *
 * 这是画布新增的一处明文存放地：env 是"最顺手填 token 的地方"，
 * 不脱敏的话导出画布就会把密钥带出去。
 */
export function redactEnv(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars ?? {})) {
    out[k] = looksLikeSecretName(k) ? '' : v;
  }
  return out;
}

/** 整个持久化状态脱敏（每个画布的节点都过一遍） */
export function redactSecrets(state: PersistedState): PersistedState {
  return {
    ...state,
    canvases: (state.canvases ?? []).map((c) => ({
      ...c,
      nodes: redactNodes(c.nodes),
      ...(c.config
        ? {
            config: {
              ...c.config,
              env: { ...(c.config.env ?? { vars: {} }), vars: redactEnv(c.config.env?.vars ?? {}) },
            },
          }
        : {}),
    })),
  };
}

/**
 * 序列化并脱敏。
 *
 * 这里默认脱敏而不是让调用方自己记得调 —— 密钥泄露属于「忘了就出事」，
 * 不该依赖调用方的自觉。需要明文（比如内存里传一份副本）请直接用
 * JSON.stringify，别走这个函数。
 */

export function serialize(state: PersistedState): string {
  return JSON.stringify(redactSecrets(state));
}

/**
 * 反序列化并做完整性修复。
 *
 * 为什么不能直接用 JSON.parse 的结果：
 *  - 手改过的 localStorage 可能缺字段
 *  - 旧版本存的数据没有新增字段
 *  - activeId 可能指向已不存在的画布
 * 任一种都会让 UI 崩在渲染阶段，所以这里统一兜底。
 */
export function deserialize(raw: string | null): PersistedState {
  if (!raw) return { canvases: [], activeId: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { canvases: [], activeId: null };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { canvases: [], activeId: null };
  }

  const obj = parsed as Record<string, unknown>;
  const rawList = Array.isArray(obj.canvases) ? obj.canvases : [];

  const canvases: Canvas[] = rawList
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map((x, i) => ({
      id: typeof x.id === 'string' ? x.id : `cv_restored_${i}`,
      name: typeof x.name === 'string' && x.name.trim() !== '' ? x.name : `工作流 ${i + 1}`,
      nodes: Array.isArray(x.nodes) ? x.nodes : [],
      edges: Array.isArray(x.edges) ? x.edges : [],
      createdAt: typeof x.createdAt === 'number' ? x.createdAt : Date.now(),
      updatedAt: typeof x.updatedAt === 'number' ? x.updatedAt : Date.now(),
    }));

  // 去重 id，避免 React key 冲突导致渲染错乱
  const seen = new Set<string>();
  const deduped = canvases.map((c) => {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      return c;
    }
    let k = 2;
    while (seen.has(`${c.id}_${k}`)) k += 1;
    const nid = `${c.id}_${k}`;
    seen.add(nid);
    return { ...c, id: nid };
  });

  let activeId = typeof obj.activeId === 'string' ? obj.activeId : null;
  if (activeId && !deduped.some((c) => c.id === activeId)) {
    activeId = deduped[0]?.id ?? null; // 指向已删除的画布 → 退到第一个
  }

  return { canvases: deduped, activeId };
}

/**
 * 读取：只管画布（已脱敏）。
 *
 * 密钥不在这里回填 —— 内联填写的密钥只活在内存里，刷新后为空。
 * 要跨会话保留，请在凭据中心建条目、节点里填 credentialId 引用。
 *
 * 旧画布里残留的明文 apiKey 不受影响：这里只做脱敏，不删已有值。
 */
export function loadFromStorage(
  get: (k: string) => string | null,
): PersistedState {
  return deserialize(get(STORAGE_KEY));
}

/**
 * 保存画布。
 *
 * 只写画布与当前激活 id。密钥一律不落盘（见本文件顶部说明）。
 */
export function saveToStorage(
  set: (k: string, v: string) => void,
  state: PersistedState,
): void {
  set(STORAGE_KEY, serialize(state));
  if (state.activeId) set(ACTIVE_KEY, state.activeId);
}

export const STORAGE_KEYS = {
  canvases: STORAGE_KEY,
  active: ACTIVE_KEY,
};

/**
 * 更新画布级配置。
 *
 * 与 updateCanvasContent 分开：内容（nodes/edges）几乎每次编辑都变，
 * 配置很少动。混在一起会让"改一个 MCP 名字"触发整份内容比对。
 *
 * 同样是幂等的 —— 没变就原样返回，避免触发保存循环
 * （那个 bug 修过一次，见 App.tsx 的保存 effect）。
 */
export function updateCanvasConfig(
  list: Canvas[],
  id: string,
  config: CanvasConfig,
): Canvas[] {
  const target = list.find((c) => c.id === id);
  if (!target) return list;
  if (sameContent(target.config, config)) return list;
  return list.map((c) => (c.id === id ? { ...c, config, updatedAt: Date.now() } : c));
}

/**
 * 取画布配置；没存过给一份空的。
 *
 * 空配置的结构在这里内联给出，不 import ——
 * 与 mcpServers / env 的形状保持一致的唯一保证是下面这条测试：
 * tests/canvasStore 里的「空配置与 canvasConfig.emptyCanvasConfig 同构」。
 */
export function canvasConfigOf(c: Canvas | null | undefined): CanvasConfig {
  return c?.config ?? { mcpServers: [], env: { vars: {} } };
}
