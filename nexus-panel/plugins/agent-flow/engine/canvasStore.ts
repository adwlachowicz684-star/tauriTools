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
import { type CanvasConfig, type McpServer, emptyCanvasConfig } from './canvasConfig';
import type { CanvasParam } from './canvasParams';
import {
  SECRET_PATHS,
  looksLikeSecretName,
  redactNodes as redactNodesInSanitize,
} from './sanitize';

/*
 * 「一个名字像不像密钥」的判定**只此一份**，在 ./sanitize 里。
 *
 * 这里以前内联过一份 hints —— 理由是"模块顶层 import 会炸"，但
 * sanitize 只依赖 ./headers、不反向依赖本文件，并没有环，那条理由不成立；
 * 而抄一份的代价是实的：sanitize 那份有 'api_key'，这份没有，
 * 于是同一个变量名在两处会得到不同答案。安全口径抄成两份必然漂移。
 *
 * 所以直接用共享的那份。判定要改就改 SECRET_PATHS / SECRET_NAME_HINTS 一处。
 */

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
 * 现在统一走**连接管理器**：节点只存 credentialId 引用，密钥本体由连接库保管，
 * 可选 OS 连接管理器 / 本机加密 / 口令模式三种，其中口令模式的钥匙不落盘。
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

/*
 * 判定**不再在这里** —— 已收进 ./sanitize 的 redactNodeSecrets。
 *
 * 收走的原因：节点数据不止"画布存档"一个出口。打包成模块、存成变量、
 * 导出成文件走的都是同一批节点数据，而它们以前一律不脱敏 ——
 * 同一个节点，存在画布里是空串，存成模块就是明文。
 *
 * 留在这里的话，那些出口要么各抄一份（抄一份必然漂移），
 * 要么继续裸着。所以只保留这个名字给既有调用方，实现共用一份。
 */
export type SecretField = (typeof SECRET_PATHS)[number];

/** 节点数组脱敏。导出文件、写 localStorage 之前都应该过一遍。 */
export function redactNodes(nodes: unknown[]): unknown[] {
  return redactNodesInSanitize(nodes);
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
  return blankEnvVars(vars);
}

/**
 * 「变量名像不像密钥」这份判据的**唯一**实现。
 *
 * env.vars 与 MCP 服务的 env 是两处不同的明文存放地，以前各写了一份循环 ——
 * 逐字相同，但那就是两份：将来给一处加判据（比如"空值不用挖"），
 * 另一处不会跟着改，而两边都写着"密钥一律不落盘"。
 * 不加判据今天看不出来（两份一样），加了才分叉。
 */
export function blankEnvVars(vars: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vars ?? {})) {
    out[k] = looksLikeSecretName(k) ? '' : v;
  }
  return out;
}

/**
 * 参数卡的脱敏。
 *
 * 参数卡现在是画布上填值的地方（env.vars 已不再由界面写入），
 * 只脱敏 env.vars 的话，**填在卡里的密钥会跟着导出的画布一起出去**。
 * 而界面上那句"不要在这里填密钥"还挂着 ——
 * 承诺了会挡、实际没挡，属于"忘了就出事"。
 */
/**
 * 这个参数卡装不装得下密钥。
 *
 * 数字卡 / 布尔卡装不下 —— 值是 4096 或 true，剥掉它没有任何安全收益，
 * 只有"每次保存都把用户填的值清空"。而名字里带 token / key 的**数字**参数
 * 是常态（maxTokens、token_limit、retry_count），
 * 于是表现为：填了 4096 → 存盘 → 回来是空的 → 再填 → 还是空的。
 *
 * 与节点侧同口径：sanitize 的 blankSecretNamed 只挖字符串叶子，
 * 数字与布尔原样留下（见那里的说明）。
 *
 * 只有 text（含老数据没标 valueType 的）才按名字判。
 */
function paramHoldsSecret(p: CanvasParam | undefined): boolean {
  if (p?.valueType === 'num' || p?.valueType === 'bool') return false;
  return looksLikeSecretName(String(p?.name ?? ''));
}

export function redactParams(list: CanvasParam[] | undefined): CanvasParam[] {
  return (list ?? []).map((p) => ({
    ...p,
    value: paramHoldsSecret(p) ? '' : String(p?.value ?? ''),
  }));
}

/** 整个持久化状态脱敏（每个画布的节点都过一遍） */
/**
 * MCP 服务的环境变量脱敏。
 *
 * 服务的 env 是「启动命令要用的环境变量」—— 正是最顺手放 token 的地方
 * （GITHUB_TOKEN、NOTION_API_KEY 都写在那里）。
 *
 * 以前只脱敏了 env.vars 与 params，**漏了这一处**：
 * 填在 MCP 服务 env 里的密钥会**明文落进 localStorage**，
 * 而本文件顶部写的是「密钥一律不落盘」—— 承诺了会挡、实际没挡。
 */
function redactServerEnv(env: Record<string, string> | undefined): Record<string, string> {
  return blankEnvVars(env);
}

/**
 * 整份画布配置脱敏。
 *
 * 导出画布文件与写 localStorage 都走这一份 ——
 * 各脱各的必然漏一处（env.vars / params / 服务的 env 三处都要挡）。
 */
export function redactCanvasConfig(cfg: CanvasConfig | undefined): CanvasConfig {
  const base = normalizeCanvasConfig(cfg);
  return {
    mcpServers: base.mcpServers.map((s) => ({ ...s, env: redactServerEnv(s.env) })),
    env: { vars: redactEnv(base.env?.vars ?? {}) },
    params: redactParams(base.params),
  };
}

export function redactSecrets(state: PersistedState): PersistedState {
  return {
    ...state,
    canvases: (state.canvases ?? []).map((c) => ({
      ...c,
      nodes: redactNodes(c.nodes),
      ...(c.config ? { config: redactCanvasConfig(c.config) } : {}),
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
 * 反序列化一份画布配置。
 *
 * ============ 为什么必须要有这一步 ============
 *
 * 存档里的 config 是**手改过 / 旧版本写下的**，字段可能是任何东西：
 * mcpServers 是对象而不是数组、env.vars 是 null、params 是字符串。
 * 直接透传的话，validateCanvasConfig 会对着非数组调用 for...of →
 * 抛在渲染阶段，整张画布打不开。
 *
 * 所以这里按字段各自归一化，缺的用 emptyCanvasConfig() 补 ——
 * 与"没存过配置"拿到的是同一份结构（canvasConfigOf 那条测试盯着这一点）。
 */
export function normalizeCanvasConfig(raw: unknown): CanvasConfig {
  const base = emptyCanvasConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;

  const o = raw as Record<string, unknown>;

  const servers = Array.isArray(o.mcpServers)
    ? (o.mcpServers as unknown[]).filter(
        (x): x is McpServer => !!x && typeof x === 'object' && !Array.isArray(x),
      )
    : base.mcpServers;

  const rawVars = (o.env as { vars?: unknown } | null | undefined)?.vars;
  const vars: Record<string, string> =
    rawVars && typeof rawVars === 'object' && !Array.isArray(rawVars)
      ? (rawVars as Record<string, string>)
      : {};

  const params = Array.isArray(o.params) ? (o.params as CanvasParam[]) : (base.params ?? []);

  return { mcpServers: servers, env: { vars }, params };
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
      /*
       * config 必须带上 —— 漏掉它的后果是：画布上配的 MCP 服务与画布参数
       * **刷新后全部消失**，而节点、连线、名字都在。
       * 于是用户看到的是"我的流程还在，但服务没了"，且没有任何报错 ——
       * 他只会以为自己没存过。
       */
      config: normalizeCanvasConfig(x.config),
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
 * 拿到的画布里，密钥字段一律是空串 —— 内存里那份不落盘，
 * 刷新后由用户重新填或改走连接管理器的引用。
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
  /*
   * 走 emptyCanvasConfig() 而不是手写一份字面量 ——
   * 配置新增字段（如 params）时，手写的那份会少字段，
   * 于是"没存过配置"和"存过空配置"结构不同：
   * 调用方按其中一份判断就会出错，且不报错。
   */
  return c?.config ?? emptyCanvasConfig();
}
