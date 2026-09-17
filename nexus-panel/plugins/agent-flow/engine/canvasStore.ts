/**
 * 多画布管理（纯逻辑，可单测）。
 *
 * 每个画布是一个独立的工作流：自己的节点、连线、触发器。
 * 增删改名切换都在这层完成，UI 只负责调用与渲染。
 */

/*
 * 类型走 import type（编译后消失），值**不用静态 import**：
 * strip-ts 生成的 .mjs 里裸模块名不带 .mjs 后缀，Node 加载不了。
 * 用一个惰性取值绕开 —— 见下面 canvasConfigOf 的实现。
 */
import type { CanvasConfig } from './canvasConfig';

/*
 * 判断一个名字像不像密钥。
 *
 * 这里**内联**了一份，没有 import sanitize 那份 ——
 * strip-ts 生成的 .mjs 里裸模块名不带 .mjs 后缀，Node 加载不了，
 * 表现为运行时 "looksLikeSecretName is not defined"（不报编译错）。
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

/**
 * 密钥单独存放的键。
 *
 * LLM 的 apiKey 不随画布走：画布会被导出成 agent-flow.json 分享给别人，
 * 一旦带进去就是把密钥交出去了。所以 apiKey 存这里（按节点 id 索引），
 * 画布里只留空字符串，刷新后由调用方回填 —— 既不用每次重填，也导不出去。
 *
 * 这里存的是**密文**：加解密在 engine/secretVault.ts。
 * 本模块只负责"挖出来 / 填回去"，不碰加密细节，
 * 这样它可以继续当纯同步逻辑来单测。
 */
const KEYS_KEY = 'agent-flow.llm-keys.v1';

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
const SECRET_FIELDS = ['llm.apiKey', 'token'] as const;
export type SecretField = (typeof SECRET_FIELDS)[number];

/** 节点 id + 字段名 → 保险箱里的键。带上字段名，回填时才知道该写回哪个字段 */
function vaultKey(nodeId: string, field: SecretField): string {
  return `${nodeId}#${field}`;
}

/** 取节点上某个密钥字段的值；不存在或不是字符串则返回 null */
function getSecretField(data: Record<string, unknown>, field: SecretField): string | null {
  if (field === 'token') {
    const v = data.token;
    return typeof v === 'string' && v !== '' ? v : null;
  }
  const llm = data.llm;
  if (!llm || typeof llm !== 'object') return null;
  const v = (llm as Record<string, unknown>).apiKey;
  return typeof v === 'string' && v !== '' ? v : null;
}

/** 把某个密钥字段写成空串，返回新的 data */
function blankSecretField(
  data: Record<string, unknown>,
  field: SecretField,
): Record<string, unknown> {
  if (field === 'token') return { ...data, token: '' };
  const llm = data.llm;
  if (!llm || typeof llm !== 'object') return data;
  return { ...data, llm: { ...(llm as Record<string, unknown>), apiKey: '' } };
}

/** 把某个密钥字段写成指定值，返回新的 data */
function setSecretField(
  data: Record<string, unknown>,
  field: SecretField,
  value: string,
): Record<string, unknown> {
  if (field === 'token') return { ...data, token: value };
  const llm = data.llm;
  if (!llm || typeof llm !== 'object') return data;
  return { ...data, llm: { ...(llm as Record<string, unknown>), apiKey: value } };
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
 * 收集所有节点上的密钥，按「节点 id + 字段名」索引。
 *
 * 只收集当前存在的节点，等于顺手清掉了已删节点的残留。
 */
export function collectSecrets(state: PersistedState): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of state.canvases ?? []) {
    for (const n of c.nodes ?? []) {
      if (!n || typeof n !== 'object') continue;
      const o = n as Record<string, unknown>;
      if (typeof o.id !== 'string') continue;
      const d = o.data as Record<string, unknown> | undefined;
      if (!d || typeof d !== 'object') continue;
      for (const f of SECRET_FIELDS) {
        const v = getSecretField(d, f);
        if (v !== null) out[vaultKey(o.id, f)] = v;
      }
    }
  }
  return out;
}

/** 把密钥回填到节点上。找不到对应密钥的节点保持空字符串，不报错。 */
export function applySecrets(
  state: PersistedState,
  keys: Record<string, string>,
): PersistedState {
  if (!keys || Object.keys(keys).length === 0) return state;
  return {
    ...state,
    canvases: (state.canvases ?? []).map((c) => ({
      ...c,
      nodes: (c.nodes ?? []).map((n) => {
        if (!n || typeof n !== 'object') return n;
        const o = n as Record<string, unknown>;
        if (typeof o.id !== 'string') return n;
        const d = o.data as Record<string, unknown> | undefined;
        if (!d || typeof d !== 'object') return n;

        let next = d;
        for (const f of SECRET_FIELDS) {
          const v = keys[vaultKey(o.id, f)];
          if (typeof v === 'string' && v !== '') next = setSecretField(next, f, v);
        }
        if (next === d) return n;
        return { ...o, data: next };
      }),
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
 * 密钥不在这里回填 —— 它是密文，解不开要提示用户而不是静默返回空，
 * 那是异步的事，交给调用方（App）用 secretVault 处理。
 * 旧版本存在画布里的明文 apiKey 不受影响：applySecrets 从不删已有值。
 */
export function loadFromStorage(
  get: (k: string) => string | null,
): PersistedState {
  return deserialize(get(STORAGE_KEY));
}

/**
 * 保存画布。
 *
 * 刻意**不碰** KEYS_KEY：密钥的写入走 secretVault 加密后单独落盘，
 * 在这一行里顺手写会把密文覆盖成明文，等于白加密。
 */
export function saveToStorage(
  set: (k: string, v: string) => void,
  state: PersistedState,
): void {
  set(STORAGE_KEY, serialize(state));
  if (state.activeId) set(ACTIVE_KEY, state.activeId);
}

/** 清空密钥保险箱（用户选了"不保存密钥"时调用） */
export function clearSecrets(remove: (k: string) => void): void {
  remove(KEYS_KEY);
}

export const STORAGE_KEYS = {
  canvases: STORAGE_KEY,
  active: ACTIVE_KEY,
  secrets: KEYS_KEY,
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
