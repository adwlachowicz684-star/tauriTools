import { cloneData } from './duplicate';
import { defaultKV, loadList, saveWrapped, type KV } from './kv';
import { stripViewKeys } from './sanitize';

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

/* KV / defaultKV 统一走 ./kv */

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
  return loadList(kv, MODULES_KEY, 'modules', isDef) as ModuleDef[];
}

export function saveModules(list: ModuleDef[], kv: KV = defaultKV()): void {
  saveWrapped(kv, MODULES_KEY, FORMAT_VERSION, 'modules', list);
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

/*
 * 运行时字段清单与剥离逻辑收口在 engine/runtimeKeys.ts。
 *
 * 这里必须 import 而不能只 re-export ——
 * 只 re-export 的话本模块作用域里**没有这个绑定**，
 * 而 packSelection 内部要调它，运行时会报
 * "stripRuntimeNodes is not defined"。
 * export 一行是为了让既有的 `import { stripRuntimeNodes } from './modules'`
 * 不用改。
 */
import { stripRuntimeNodes } from './runtimeKeys';
import { stackEdges } from './stack';
export { stripRuntimeNodes };

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

/* ------------------------------------------------------------------ */
/* 打包：把画布上一批选中节点合成一个模块                                */
/* ------------------------------------------------------------------ */

export type PackableNode = {
  id: string;
  position?: { x: number; y: number };
  data?: Record<string, unknown>;
};

export type PackableEdge = {
  id: string;
  source: string;
  target: string;
  branch?: string;
  loopRole?: 'body' | 'done' | undefined;
};

export type PackResult = {
  /** 模块内部节点（已剥运行时与显示状态） */
  nodes: Record<string, unknown>[];
  /** 模块内部边：两端都在选中集合里 */
  edges: ModuleEdge[];
  /** 内部节点相对模块内部的坐标原点 */
  innerOrigin: { x: number; y: number };
  /** 模块节点该放在哪（选中集合的视觉中心） */
  at: { x: number; y: number };
  /** 跨边界的边：需要转成模块实例对外接线 */
  crossing: CrossingEdge[];
};

/**
 * 跨边界的边。
 *
 * 选中集合内部连着外面 —— 这类边**不能丢进模块**（会连到不存在的节点），
 * 也不能直接删掉（那样外部接线就断了）。
 * 必须在替换成模块节点后重新挂到模块实例上。
 */
export type CrossingEdge = {
  kind: 'in' | 'out';
  /** 模块外面的那一端 */
  outer: string;
  /** 模块内部的那一端 */
  inner: string;
  branch?: string;
  loopRole?: 'body' | 'done' | undefined;
};

export function isPackableSelected(nodes: PackableNode[]): boolean {
  return (nodes ?? []).length > 0;
}

/**
 * 判断一批节点能不能打包。
 *
 * 空集合不行，只有一个节点也建议别打 —— 那是"参数预设"的活儿，
 * 模块是给"多个节点编成一组"用的。
 */
/**
 * 返回值写成类型别名而不是内联对象 ——
 * strip-ts.py 剥不掉「返回类型注解里的对象类型」，
 * 内联写会原样留下 `: { ok: boolean; reason?: string }`，
 * 生成的 .mjs 直接语法错误（这个脚本的第九个坑）。
 */
export type CanPackResult = { ok: boolean; reason?: string };

export function canPack(nodes: PackableNode[]): CanPackResult {
  const list = (nodes ?? []).filter((n) => String(n?.id ?? '') !== '');
  if (list.length === 0) return { ok: false, reason: '还没选节点' };
  return { ok: true };
}

/**
 * 把选中的节点们打包成一个模块。
 *
 * 三件容易漏的事，都在这里处理：
 *
 * ① **跨边界的边要单独摘出来**。
 *    直接把"两端都在集合里"的边留下、其余丢掉，是最自然的写法，
 *    但那样外部接线会静默断掉 —— 用户会看到"跑不通了"却找不到原因。
 *
 * ② **内部坐标要减去原点**。
 *    模块拖到别处时，内部结构应该保持相对位置；
 *    不减原点的话每次拖出来的内部布局都在画布左上角。
 *
 * ③ **显示状态也要剥**（size / stackParent / stackCollapsed）。
 *    stackParent 尤其关键 —— 不剥的话模块内部节点还"嵌合"在
 *    某个外部节点上，展开时那条边指向不存在的地方，
 *    表现为"新模块莫名其妙跑不起来"。
 */
export function packSelection(
  picked: PackableNode[],
  allEdges: PackableEdge[],
  /**
   * 全图节点。**嵌合的跨边界连接需要它**才能算全：
   * 父被选中、子没被选中时，"父→子"这条隐式边要变成模块的出边，
   * 而光看选中集合发现不了（子上才存着 stackParent，而它不在集合里）。
   * 不传则只补"父子都被选中"的那部分 —— 整串一起存模块时够用。
   */
  allNodes?: PackableNode[],
): PackResult {
  const list = (picked ?? []).filter((n) => String(n?.id ?? '') !== '');
  const ids = new Set(list.map((n) => String(n.id)));

  /* 内部坐标原点：取选中集合的左上角 */
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of list) {
    const p = (n?.position ?? { x: 0, y: 0 }) as { x: number; y: number };
    const x = Number(p?.x ?? 0);
    const y = Number(p?.y ?? 0);
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 0; maxY = 0; }

  const innerOrigin = { x: minX, y: minY };
  // 模块节点放在原选中区域的视觉中心，避免"打包完跳到别处"
  const at = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

  const nodes = stripRuntimeNodes(list.map((n) => ({
    id: String(n.id),
    position: {
      x: Number((n.position as { x: number })?.x ?? 0) - minX,
      y: Number((n.position as { y: number })?.y ?? 0) - minY,
    },
    data: stripViewKeys((n.data ?? {}) as Record<string, unknown>),
  })));

  const edges: ModuleEdge[] = [];
  const crossing: CrossingEdge[] = [];

  /*
   * 已经收进去的连接（source→target 对），用于给嵌合边去重。
   * 嵌合与拉线可能表达同一条连接 —— 显式拉的线带 branch / loopRole，
   * 是更明确的意图，所以**已有真实边就不再补嵌合边**。
   * 两条都留的话同一对节点间会多出一条边，执行时表现为重复触发。
   */
  const linked = new Set<string>();

  const pushInner = (
    id: string, source: string, target: string,
    branch?: string, loopRole?: 'body' | 'done' | undefined,
  ) => {
    edges.push({ id, source, target, branch, loopRole });
    linked.add(`${source}->${target}`);
  };

  for (const e of allEdges ?? []) {
    const s = String(e?.source ?? '');
    const t = String(e?.target ?? '');
    const inS = ids.has(s);
    const inT = ids.has(t);

    if (inS && inT) {
      pushInner(String(e?.id ?? `${s}-${t}`), s, t, e?.branch, e?.loopRole);
      continue;
    }
    /* 一端在里面、一端在外面 —— 摘出来，替换后重新挂到实例上 */
    if (inS && !inT) {
      crossing.push({
        kind: 'out', outer: t, inner: s,
        branch: e?.branch, loopRole: e?.loopRole,
      });
      continue;
    }
    if (!inS && inT) {
      crossing.push({
        kind: 'in', outer: s, inner: t,
        branch: e?.branch, loopRole: e?.loopRole,
      });
    }
  }

  /*
   * 嵌合产生的隐式边（父 → 子）也要收进模块。
   *
   * 不补的话：嵌合成串的几个节点存成模块后，串内连接**全没了** ——
   * 节点还在，但彼此不再相连。拖出来的模块表现为"莫名其妙跑不起来"，
   * 而存的时候没有任何提示。根因是嵌合关系存在 stackParent 上，
   * 打包时会当作显示状态剥掉，而它同时又是执行语义（等价于一条边）。
   */
  for (const e of stackEdges((allNodes ?? list) as never)) {
    const s = String(e?.source ?? '');
    const t = String(e?.target ?? '');
    const inS = ids.has(s);
    const inT = ids.has(t);
    // 已经拉过线（或已经收过）就不重复补
    if (inS && inT) {
      if (!linked.has(`${s}->${t}`)) pushInner(String(e?.id ?? `stack:${s}->${t}`), s, t);
      continue;
    }
    /* 嵌合的两端只有一个在选中集合里 —— 同样算跨边界 */
    if (inS && !inT) crossing.push({ kind: 'out', outer: t, inner: s });
    else if (!inS && inT) crossing.push({ kind: 'in', outer: s, inner: t });
  }

  return { nodes, edges, innerOrigin, at, crossing };
}

/**
 * 替换成模块节点后，外部边该怎么接。
 *
 * 跨边界的边全部改挂到模块实例上：
 *   进来 → 外部源 → 模块实例
 *   出去 → 模块实例 → 外部目标
 *
 * **必须去重**：多个内部节点连到同一个外部节点时，
 * 会产生多条完全相同的边，xyflow 里表现为"看起来一条、实际叠了几条"，
 * 删的时候要删好几次。
 */
export function rewireCrossing(
  instanceId: string,
  crossing: CrossingEdge[],
): PackableEdge[] {
  const seen = new Set<string>();
  const out: PackableEdge[] = [];
  for (const c of crossing ?? []) {
    const source = c.kind === 'in' ? c.outer : instanceId;
    const target = c.kind === 'in' ? instanceId : c.outer;
    const key = `${source}->${target}|${c.branch ?? ''}|${c.loopRole ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: `x_${instanceId}_${seen.size}`,
      source,
      target,
      branch: c.branch,
      loopRole: c.loopRole,
    });
  }
  return out;
}
