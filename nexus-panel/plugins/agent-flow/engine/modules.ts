import { cloneData } from './duplicate';

/**
 * 模块 —— 把多个节点打包成一个可复用的块。
 *
 * ================= 语义（与自定义节点、参数卡片一致）=================
 *
 *   模块库 = 定义，画布上的模块节点 = 实例。
 *
 *   · 改模块库里的定义 → **所有实例跟着变**
 *   · 改某个实例内部的节点 → **该实例脱钩成独立副本**，不再跟随
 *   · 脱钩后的实例改什么都不影响模块库，也不影响别的实例
 *
 * 这是「库是库，实例是实例」这条规则的第三次应用。
 * 反向（实例改动同步回库）会导致改一个流程波及别处，
 * 而用户根本记不住哪些流程共用了哪个模块。
 *
 * ================= 为什么执行时展开而不是黑盒 =================
 *
 * 展开成内部节点后：
 *   · 日志能看到模块内部每一步，出错能定位到具体节点
 *   · 条件、循环这些控制节点在模块内部依然可用
 *   · 不需要为"模块"单独实现一套执行逻辑
 *
 * 黑盒做法（当成一个节点跑）要自己实现子图调度、失败传播、循环上下文，
 * 等于把 runner 重做一遍，且内部出错时只能看到"模块失败"四个字。
 */

export const MODULES_KEY = 'agent-flow.modules.v1';
const FORMAT_VERSION = 1;

/** 模块内部的一条边。结构与画布边相同，但 id 只在模块内唯一 */
export type ModuleEdge = {
  id: string;
  source: string;
  target: string;
  branch?: string;
  label?: string;
  loopRole?: 'body' | 'done';
};

/** 模块定义。nodes / edges 是画布结构的子集（id/type/data/position + 边） */
export type ModuleDef = {
  id: string;
  name: string;
  color: string;
  /** 模块内部的节点。data 里的 status/output 等运行时字段不存 */
  nodes: Record<string, unknown>[];
  edges: ModuleEdge[];
  createdAt: number;
};

export type KV = {
  get: (k: string) => string | null;
  set: (k: string, v: string) => void;
};

function defaultKV(): KV {
  return {
    get: (k: string) => {
      try {
        return typeof localStorage === 'undefined' ? null : localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set: (k: string, v: string) => {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(k, v);
      } catch {
        /* 存不下就算了 */
      }
    },
  };
}

function isDef(x: unknown): x is ModuleDef {
  const o = x as ModuleDef;
  return (
    !!o
    && typeof o.id === 'string' && o.id.length > 0
    && typeof o.name === 'string'
    && Array.isArray(o.nodes)
    && Array.isArray(o.edges)
  );
}

export function loadModules(kv: KV = defaultKV()): ModuleDef[] {
  const raw = kv.get(MODULES_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed?.modules;
    if (!Array.isArray(list)) return [];
    return list.filter(isDef);
  } catch {
    return [];
  }
}

export function saveModules(list: ModuleDef[], kv: KV = defaultKV()): void {
  kv.set(MODULES_KEY, JSON.stringify({ version: FORMAT_VERSION, modules: list }));
}

function newId(): string {
  return `md${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function addModule(
  input: { name: string; color?: string; nodes: Record<string, unknown>[]; edges: ModuleEdge[] },
  kv: KV = defaultKV(),
): ModuleDef {
  const list = loadModules(kv);
  const def: ModuleDef = {
    id: newId(),
    name: input.name.trim() || '未命名模块',
    color: input.color ?? '#f59e0b',
    // 深拷贝：调用方之后改了传入的数组，模块内容不该跟着变
    nodes: cloneData(input.nodes) as unknown as Record<string, unknown>[],
    edges: cloneData(input.edges) as unknown as ModuleEdge[],
    createdAt: Date.now(),
  };
  list.push(def);
  saveModules(list, kv);
  return def;
}

export function renameModule(id: string, name: string, kv: KV = defaultKV()): void {
  const t = name.trim();
  if (!t) return;
  saveModules(loadModules(kv).map((m) => (m.id === id ? { ...m, name: t } : m)), kv);
}

export function removeModule(id: string, kv: KV = defaultKV()): void {
  saveModules(loadModules(kv).filter((m) => m.id !== id), kv);
}

export function findModule(id: string | undefined | null, kv: KV = defaultKV()): ModuleDef | null {
  if (!id) return null;
  return loadModules(kv).find((m) => m.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* 接口推导                                                            */
/* ------------------------------------------------------------------ */

/**
 * 推导入口与出口 —— 不用手工指定。
 *
 *   入口 = 模块内没有上游的内部节点
 *   出口 = 模块内没有下游的内部节点
 *
 * 这样"模块对外是什么样"完全由内部结构决定，加删内部节点时接口自动跟着变，
 * 不会出现"手工标了入口但那个节点已经删了"这种对不上的情况。
 */
export type ModulePorts = { entries: string[]; exits: string[] };

export function modulePorts(def: ModuleDef): ModulePorts {
  const ids = def.nodes.map((n) => String(n.id ?? ''));
  const hasUp = new Set(def.edges.map((e) => e.target));
  const hasDown = new Set(def.edges.map((e) => e.source));

  // 按 nodes 顺序输出，保证多次调用结果稳定（Set 的遍历顺序依赖插入序，也不稳）
  const entries = ids.filter((id) => id && !hasUp.has(id));
  const exits = ids.filter((id) => id && !hasDown.has(id));
  return { entries, exits };
}

/* ------------------------------------------------------------------ */
/* 运行时字段清理                                                       */
/* ------------------------------------------------------------------ */

const RUNTIME_KEYS = ['status', 'output', 'error'];

/**
 * 存进模块前剥掉运行时字段。
 *
 * 与 duplicate.stripRuntime 同一套口径：不剥的话，把跑过的节点存成模块，
 * 之后拖出来的实例都带着 status='success' 和旧 output ——
 * **看起来"已经跑完了"，实际一次都没跑**。
 */
export function stripRuntimeNodes(nodes: Record<string, unknown>[]): Record<string, unknown>[] {
  return nodes.map((n) => {
    const data = { ...((n.data ?? {}) as Record<string, unknown>) };
    for (const k of RUNTIME_KEYS) delete data[k];
    // 运行时字段还有一批 last* 前缀的（lastSha / lastCommit …）
    for (const k of Object.keys(data)) {
      if (k.startsWith('last')) delete data[k];
    }
    return { ...n, data };
  });
}

/* ------------------------------------------------------------------ */
/* 展开：把模块实例替换成内部节点                                        */
/* ------------------------------------------------------------------ */

/** 展开后的内部节点 id 前缀。用双下划线，避免与内部节点自己的 id 混淆 */
export function innerId(instanceId: string, nodeId: string): string {
  return `${instanceId}__${nodeId}`;
}

type AnyNode = { id: string; data?: Record<string, unknown> };
type AnyEdge = { id: string; source: string; target: string; branch?: string; loopRole?: string };

/**
 * 把 {{innerId.xxx}} 之类的引用改写成展开后的 id。
 *
 * 必须做这一步：内部节点之间互相引用 `{{A.output}}`，
 * 展开后 A 的 id 变成了 `inst__A`，不重写就取不到值 ——
 * 而这种失效不报错，只是模板渲染成空串，极难发现。
 */
function rewriteTemplates(text: unknown, map: Map<string, string>): unknown {
  if (typeof text !== 'string' || text.indexOf('{{') < 0) return text;
  return text.replace(/\{\{\s*([A-Za-z0-9_-]+)\s*\./g, (m, id: string) => {
    const to = map.get(id);
    return to ? `{{${to}.` : m;
  });
}

/** 递归改写 data 里的所有字符串值 */
function rewriteData(data: unknown, map: Map<string, string>): unknown {
  if (typeof data === 'string') return rewriteTemplates(data, map);
  if (Array.isArray(data)) return data.map((x) => rewriteData(x, map));
  if (data && typeof data === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      out[k] = rewriteData(v, map);
    }
    return out;
  }
  return data;
}

/**
 * 展开图里的所有模块节点。
 *
 * @param resolve 由调用方提供「模块 id → 内部结构」。
 *                传入而不是直接读 localStorage：执行引擎是纯逻辑层，
 *                测试要在 Node 下跑它，不能依赖浏览器存储。
 *                返回 null 表示该实例已脱钩（用自己 data 里的 inner）或模块已删。
 */
export function expandModules(
  graph: { nodes: AnyNode[]; edges: AnyEdge[] },
  resolve: (moduleId: string, data: Record<string, unknown>) => ModuleDef | null,
): { nodes: AnyNode[]; edges: AnyEdge[] } {
  const outNodes: AnyNode[] = [];
  const outEdges: AnyEdge[] = [];
  /** 模块实例 id → 它的入口/出口（展开后 id） */
  const portMap = new Map<string, { entries: string[]; exits: string[] }>();

  for (const n of graph.nodes) {
    const data = (n.data ?? {}) as Record<string, unknown>;
    if (data.kind !== 'module') {
      outNodes.push(n);
      continue;
    }

    /*
     * 结构来源优先级：先看看有没有脱钩副本，没有再查模块库。
     * 脱钩的实例完全独立，即使模块库里那条被删了也能正常跑 ——
     * 这正是脱钩的意义。
     */
    const own = data.inner as { nodes?: unknown[]; edges?: unknown[] } | undefined;
    const moduleId = String(data.moduleId ?? '');
    const def = own?.nodes ? ({
      id: moduleId || n.id,
      name: String(data.label ?? '模块'),
      color: '',
      nodes: own.nodes as Record<string, unknown>[],
      edges: (own.edges ?? []) as ModuleEdge[],
      createdAt: 0,
    } as ModuleDef) : resolve(moduleId, data);

    if (!def || def.nodes.length === 0) {
      // 模块被删了且没脱钩：留一个空节点占位，至少流程不崩
      outNodes.push({ ...n, data: { ...data, output: '', error: '模块已删除' } });
      portMap.set(n.id, { entries: [], exits: [] });
      continue;
    }

    const ports = modulePorts(def);
    const idMap = new Map<string, string>();
    for (const inner of def.nodes) {
      const rawId = String(inner.id ?? '');
      if (rawId) idMap.set(rawId, innerId(n.id, rawId));
    }

    for (const inner of def.nodes) {
      const newId = idMap.get(String(inner.id)) ?? String(inner.id);
      outNodes.push({
        ...(inner as AnyNode),
        id: newId,
        data: {
          ...(rewriteData((inner as AnyNode).data ?? {}, idMap) as Record<string, unknown>),
          status: 'idle',
          output: '',
          error: '',
        },
      });
    }

    // 内部边：两端都改写
    for (const e of def.edges) {
      outEdges.push({
        ...e,
        id: `${n.id}__${e.id}`,
        source: idMap.get(e.source) ?? e.source,
        target: idMap.get(e.target) ?? e.target,
      });
    }

    portMap.set(n.id, {
      entries: ports.entries.map((x) => idMap.get(x) ?? x),
      exits: ports.exits.map((x) => idMap.get(x) ?? x),
    });
  }

  /*
   * 外部边接到模块的入口 / 出口上。
   *
   * 一个模块可能有多个入口 / 出口：
   *   · 外部 → 模块：连到**每个**入口（都要拿到输入）
   *   · 模块 → 外部：从**每个**出口连出去
   *
   * 用各自的出口分别连，而不是合并 —— 合并需要引入一个额外的汇聚节点，
   * 而那个节点不在用户的画布上，日志里会出现没见过的 id。
   */
  for (const e of graph.edges) {
    const fromPort = portMap.get(e.source);
    const toPort = portMap.get(e.target);

    if (!fromPort && !toPort) {
      outEdges.push(e);
      continue;
    }

    if (toPort && !fromPort) {
      // 外部 → 模块入口
      for (const t of toPort.entries) {
        outEdges.push({ ...e, id: `${e.id}__${t}`, target: t });
      }
      continue;
    }

    if (fromPort && !toPort) {
      // 模块出口 → 外部。branch 要保留（条件节点依赖它判断分支）
      for (const s of fromPort.exits) {
        outEdges.push({ ...e, id: `${e.id}__${s}`, source: s });
      }
      continue;
    }

    // 模块 → 模块：笛卡尔积（每个出口连到每个入口）
    if (fromPort && toPort) {
      for (const s of fromPort.exits) {
        for (const t of toPort.entries) {
          outEdges.push({ ...e, id: `${e.id}__${s}__${t}`, source: s, target: t });
        }
      }
    }
  }

  return { nodes: outNodes, edges: outEdges };
}

/* ------------------------------------------------------------------ */
/* 导入导出                                                            */
/* ------------------------------------------------------------------ */

export function exportModules(kv: KV = defaultKV()): string {
  return JSON.stringify({ version: FORMAT_VERSION, modules: loadModules(kv) }, null, 2);
}

export type ImportResult = { added: number; updated: number; skipped: string[] };

export function importModules(
  json: string,
  opts?: { mode?: 'merge' | 'replace' },
  kv: KV = defaultKV(),
): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('不是合法的 JSON');
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { modules?: unknown })?.modules;
  if (!Array.isArray(list)) throw new Error('文件里没有模块列表');

  const result: ImportResult = { added: 0, updated: 0, skipped: [] };
  const current = opts?.mode === 'replace' ? [] : loadModules(kv);

  for (const item of list) {
    if (!isDef(item)) {
      result.skipped.push(String((item as { name?: string })?.name ?? '(无名)'));
      continue;
    }
    const at = current.findIndex((m) => m.id === item.id);
    if (at >= 0) {
      current[at] = item;
      result.updated += 1;
    } else {
      current.push(item);
      result.added += 1;
    }
  }

  saveModules(current, kv);
  return result;
}
