import { cloneData } from './duplicate';
import { defaultKV, loadList, saveWrapped, type KV } from './kv';
import { redactNodes, stripViewKeys } from './sanitize';
import { assertNoReplaceWipe } from './impExp';

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
import { paramRefsOfNodes } from './canvasParams';

export type ModuleEdge = {
  id: string;
  source: string;
  target: string;
  branch?: string;
  label?: string;
  loopRole?: 'body' | 'done';
  /**
   * 参数连线：填进目标节点的哪个参数。
   *
   * 不带它的话，打包成模块时参数连线会被重建成**流程连线** ——
   * "我只是想取个值"变成"多一条执行路径"，目标节点多跑一次，
   * 而界面上只是线变了个颜色，没有任何提示。
   */
  targetArg?: string;
  /**
   * 参数连线：取上游的**哪个输出**。
   *
   * 只有 targetArg 的话，多输出节点（更新检测的「标题」这类副输出）
   * 打包进模块再展开，会退回默认主输出 ——
   * 值取错了，而界面上看不出这根线原本接的是哪个口子。
   *
   * 缺省（以及老存档没有这个字段）即主输出，与 OUT_DEFAULT 同义。
   */
  sourceArg?: string;
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
  /**
   * 模块内部引用到的画布参数名。
   *
   * 存它而不是每次现扫的原因：模块拖到一张画布上时，
   * 内部节点**不在画布的 nodes 里**（只有运行时才展开），
   * 于是画布侧扫不出它引用了什么 ——
   * 而"刚拖进来、还没填参数"恰恰是最该提醒的时刻。
   * 由 addModule 从内部节点算好存下来。
   */
  paramRefs?: string[];
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

/**
 * 唯一的写入口 —— 脱敏收在这一层，而不是各调用点各写一份。
 *
 * ================= 为什么收在这里 =================
 *
 * 以前是"谁要存谁自己记得脱敏"，结果就是**漏一条**：
 *   · addModule（从选区打包）—— 记得了，走 redactNodes
 *   · App 的 exitModuleEdit（编辑模块库里的模块再保存）—— 忘了，
 *     只调了 stripRuntimeNodes，于是节点上内联填的 token 明文落进
 *     localStorage，而同一个节点"存在画布里是空串、存到模块里是明文"。
 *
 * 这种不一致**不报错**：导出时 exportModules 还会再脱一层，所以表面上看
 * 不出问题，明文只是静静躺在本地。但"本地明文"本身就与"密钥一律不落盘"
 * 的契约冲突，而且整条链上只要有一处忘了脱，明文就出去了。
 *
 * 放在各调用点各写一份，正是这次漏一条的成因 —— 所以这里统一兜住。
 * 幂等：addModule / importModules 存前已经脱过，再脱一次结果不变。
 */
export function saveModules(list: ModuleDef[], kv: KV = defaultKV()): void {
  const safe = (list ?? []).map((m) => (
    m && Array.isArray(m.nodes)
      ? { ...m, nodes: redactNodes(m.nodes) as Record<string, unknown>[] }
      : m
  ));
  saveWrapped(kv, MODULES_KEY, FORMAT_VERSION, 'modules', safe);
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
    /*
     * 深拷贝：调用方之后改了传入的数组，模块内容不该跟着变。
     *
     * 顺带脱敏，判据与画布存档同一份（./sanitize 的 redactNodes）：
     * 模块是**要导出分享**的，节点上内联填的 token / apiKey / 请求头
     * 不脱的话，导出一份模块文件就等于把密钥贴给别人。
     * 而画布存档走的是同一批节点数据却会脱敏 ——
     * 同一个节点"存在画布里是空串、存成模块是明文"，
     * 这种不一致不报错，只能靠共用一份判定来避免。
     */
    nodes: redactNodes(cloneData(input.nodes) as unknown as unknown[]) as Record<string, unknown>[],
    edges: cloneData(input.edges) as unknown as ModuleEdge[],
    createdAt: Date.now(),
    // 从内部节点扫出来 —— 见 ModuleDef.paramRefs 的说明
    paramRefs: paramRefsOfNodes(input.nodes ?? []),
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
import { makeParamEdge, OUT_DEFAULT, isParamEdge } from './paramLinks';
import { isTriggerNode } from './triggerRegistry';
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
  return expandWith(graph, resolve, []);
}

/**
 * @param visiting 正在展开的模块 id 栈 —— 只用于环检测，见下面的说明。
 */
function expandWith(
  graph: { nodes: AnyNode[]; edges: AnyEdge[] },
  resolve: (moduleId: string, data: Record<string, unknown>) => ModuleDef | null,
  visiting: string[],
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
    /* 脱钩副本没有 moduleId，用节点 id 当追踪键（它的内部结构是自己的） */
    const trackId = moduleId || String(n.id ?? '');

    /*
     * 环检测：模块 A 里套着 A（或 A→B→A）时不能往下展开。
     *
     * 不挡住就是无限递归 —— 而"无限"表现在界面上是卡死或爆栈，
     * 用户看不出是自己把模块套进了自己里面。
     *
     * 挡住之后留下一个带原因的占位节点，由 module 执行器把它报成失败
     * （见 engine/runners/module.ts）—— 留着"绿着成功、什么都没做"更糟。
     */
    if (visiting.indexOf(trackId) >= 0) {
      const path = [...visiting.slice(visiting.indexOf(trackId)), trackId].join(' → ');
      outNodes.push({ ...n, data: { ...data, output: '', error: `模块循环引用（${path}）` } });
      portMap.set(n.id, { entries: [], exits: [] });
      continue;
    }

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

    /*
     * 递归展开模块内部。
     *
     * 模块里可以套模块（选中一个模块实例再打包一次就有了），
     * 而以前只展开一层：内层那个模块节点原样留在运行时图里，
     * 它没有执行器（见 runnerRegistry 的白名单说明），于是**直通** ——
     * 绿着 success、output 是空串、里面的活一件没干、整条流程 ok:true。
     * 用户看到的是"流程跑通了"，而内层模块里的写文件 / 命令行 / 接口
     * 一次都没执行。
     *
     * 展开要在**取端口之前**做：不展开的话 modulePorts 会把内层模块节点
     * 当成入口/出口，而它展开后已经不存在了 —— 外部边就会连到一个
     * 已经不存在的 id 上。
     */
    const body = expandWith(
      { nodes: (def.nodes ?? []) as AnyNode[], edges: (def.edges ?? []) as AnyEdge[] },
      resolve,
      [...visiting, trackId],
    );
    const bodyNodes = body.nodes as unknown as Record<string, unknown>[];
    const bodyEdges = body.edges as unknown as ModuleEdge[];

    const ports = modulePorts({ ...def, nodes: bodyNodes, edges: bodyEdges } as ModuleDef);
    const idMap = new Map<string, string>();
    for (const inner of bodyNodes) {
      const rawId = String(inner.id ?? '');
      if (rawId) idMap.set(rawId, innerId(n.id, rawId));
    }

    for (const inner of bodyNodes) {
      const newId = idMap.get(String(inner.id)) ?? String(inner.id);
      const innerData = ((inner as AnyNode).data ?? {}) as Record<string, unknown>;
      const data: Record<string, unknown> = {
        ...(rewriteData(innerData, idMap) as Record<string, unknown>),
        status: 'idle',
        output: '',
        /*
         * 这里统一把 error 清成 ''，因为新展开出来的节点不该带着
         * 上一次运行的错误。但**展开失败的占位节点要留下原因** ——
         * 它的 error 不是"上一次跑错了"，而是"这个模块没能展开"
         * （模块被删 / 循环引用）。清掉的话它又会变回
         * "绿着成功、什么都没做"，而 runModule 报不出原因。
         */
        error: String(innerData.kind ?? '') === 'module'
          ? String(innerData.error ?? '')
          : '',
      };
      /*
       * 嵌合（stackParent）与窗格归属（paneId）存的是**节点 id 本身**，
       * 而 rewriteData 只改 {{...}} 模板里的引用 —— 改不到这两个。
       *
       * 不重指向的话它们仍指向模块内的原始 id（'A'），
       * 而展开后那个 id 已经不存在了（只有 'inst__A'）：
       *   · stackEdges 的判据是"父在不在节点集合里"，找不到就**丢弃**
       *     这条关系 —— 嵌合等价于一条隐式边，丢了就是"没连上"；
       *   · paneId 指不到窗格，节点拿不到共享配置（工作目录 / 模型）。
       *
       * 两者都**不报错**：编辑模块时界面上是嵌好的、窗格也选好了，
       * 保存成功、日志干净，跑起来才发现不是那么回事。
       *
       * 断开规则沿用 duplicate.ts 那一套（同一件事不写第二份口径）：
       *   · stackParent：父不在模块内 → 断开（留着指向不存在的 id 更糟）
       *   · paneId：窗格不在模块内 → 保留（多对一，指外面那份是对的）
       */
      const sp = data.stackParent;
      if (typeof sp === 'string' && sp) {
        const mapped = idMap.get(sp);
        if (mapped) data.stackParent = mapped;
        else delete data.stackParent;
      }
      const pane = data.paneId;
      if (typeof pane === 'string' && pane) {
        const mapped = idMap.get(pane);
        if (mapped) data.paneId = mapped;
      }
      outNodes.push({ ...(inner as AnyNode), id: newId, data } as AnyNode);
    }

    /*
     * 内部边：两端都改写。
     *
     * 参数连线要在这一步**还原成完整的边形状** ——
     * 存档里只存了 targetArg（省得存一整个 data），
     * 而展开回画布后 isParamEdge 看的是 data.kind。
     * 不还原的话参数连线会变成一条普通流程线：
     * 值不会填进参数，反而多出一条执行路径。
     */
    for (const e of bodyEdges) {
      const source = idMap.get(e.source) ?? e.source;
      const target = idMap.get(e.target) ?? e.target;
      if (e.targetArg) {
        const pe = makeParamEdge(source, target, e.targetArg, e.sourceArg);
        outEdges.push({ ...pe, id: `${n.id}__${e.id}` } as never);
        continue;
      }
      outEdges.push({
        ...e,
        id: `${n.id}__${e.id}`,
        source,
        target,
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

/**
 * 模块导出。
 *
 * 导出时**再脱一遍**，尽管存的时候已经脱过。
 *
 * 为什么不只靠存时脱敏：老用户机器上的 localStorage 里已经躺着
 * 脱敏之前存下的明文（那批数据是这次修复之前写进去的）。
 * 只在存时脱敏，"修好了"就只是"以后不再新写明文"，
 * 而**已经写进去的那些照样被导出带走**。
 *
 * 与 exportCustomPresets 同一套做法（那边导出的也是 sanitize 过的值）。
 */
export function exportModules(kv: KV = defaultKV()): string {
  const list = loadModules(kv).map((m) => ({
    ...m,
    nodes: redactNodes(m.nodes) as Record<string, unknown>[],
  }));
  return JSON.stringify({ version: FORMAT_VERSION, modules: list }, null, 2);
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
    /*
     * 导入的文件不受我们控制 —— 可能来自别人的机器，也可能手改过。
     * 与自定义预设同一套：落库前先脱敏，免得"导入别人的文件"
     * 把对方的密钥明文写进自己的 localStorage。
     */
    const safe = { ...item, nodes: redactNodes(item.nodes) as Record<string, unknown>[] };
    const at = current.findIndex((m) => m.id === item.id);
    if (at >= 0) {
      current[at] = safe;
      result.updated += 1;
    } else {
      current.push(safe);
      result.added += 1;
    }
  }

  /*
   * 与自定义预设、变量共用同一条防线（engine/impExp.ts）：
   * replace 是"先清空再往里塞"，而"塞不进去"不会撤销清空 ——
   * 文件全是坏条目时，"导入失败"和"清空"会同时发生。
   */
  assertNoReplaceWipe({
    mode: opts?.mode,
    list,
    added: result.added,
    updated: result.updated,
    count: () => loadModules(kv).length,
    noun: '模块',
  });

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
  /**
   * 参数连线的目标参数名（普通流程边为 undefined）。
   *
   * 必须进类型而不是靠 unknown 传：打包时的去重键要带上它，
   * 否则「同一个外部节点给模块内两个不同参数供值」这两条线
   * 会被当成同一条去重掉 —— 表现为存完模块少一条参数连线，
   * 界面上看不出少的是哪一条。
   */
  targetArg?: string;
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
  /** 参数连线：填进目标节点的哪个参数（跨边界时不能丢，理由同 ModuleEdge） */
  targetArg?: string;
  /** 参数连线：取上游的哪个输出（跨边界时不能丢，理由同 ModuleEdge） */
  sourceArg?: string;
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
 * 「返回类型注解里的对象类型」写法较长，
 * 内联写会原样留下 `: { ok: boolean; reason?: string }`，
 * 生成的 .mjs 直接语法错误（这个脚本的第九个坑）。
 */
export type CanPackResult = { ok: boolean; reason?: string };

export function canPack(nodes: PackableNode[]): CanPackResult {
  const list = (nodes ?? []).filter((n) => String(n?.id ?? '') !== '');
  if (list.length === 0) return { ok: false, reason: '还没选节点' };

  /*
   * 触发器不能进模块。
   *
   * 全局触发器只扫**画布顶层**的节点（collectGlobalTriggers 遍历
   * canvas.nodes），而模块内部那层它根本看不到 —— 打包之后，
   * 触发器仍然静静躺在模块里、面板上照常显示着端口和启用开关，
   * 而自动触发**永远不会发生**，也没有任何提示。
   *
   * 更迷惑的是手动运行**能跑**：展开后的运行时图里 kind 还是 'trigger'，
   * runGraph 把它当入口。于是表现为"手动点运行有反应，配好的
   * webhook / 定时一次都没触发"，是极难排查的那一种。
   *
   * 判据走 triggerRegistry 那一份（不在这里另写一个 kind === 'trigger'）：
   * 两份判据必然漂移，而漂移的方向总是"一处认、一处不认"。
   */
  if (list.some((n) => isTriggerNode(n?.data))) {
    return {
      ok: false,
      reason: '触发器不能打包进模块：模块内部不会被全局扫描，'
        + '打包后自动触发（webhook / 定时）永远不会发生，也不报错。'
        + '请把触发器留在画布上，只打包它后面的节点',
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 模块存档 ↔ 画布：边的来回转换                                       */
/* ------------------------------------------------------------------ */

/*
 * 两边存的形状不一样，必须显式转换，不能 `{...e}` 直接搬：
 *
 *   · 画布边（FlowEdge）：branch / loopRole / kind / targetArg / sourceArg
 *     都放在 **data** 里，另外还有 type / sourceHandle / targetHandle /
 *     markerEnd 这些"画线用"的字段。
 *   · 模块边（ModuleEdge）：branch / loopRole / targetArg / sourceArg
 *     放在**顶层**，data 那套一概不存（省体积，也省得两处对不上）。
 *
 * 以前 App 里进/出模块编辑是两处各写一份内联映射，而它们**合起来是坏的**：
 * 进去时把模块边原样当画布边（branch 落到了顶层，data 是空的），
 * 出来时又去读 e.data?.branch —— 读到的是 undefined。
 *
 * 净结果：**进入模块编辑、什么都没改、点「完成」，模块内部的
 * 条件分支（branch）、循环出口（loopRole）、参数连线（targetArg）
 * 全部静默丢失**。用户什么都没做，模块就坏了，而且没有任何提示。
 *
 * 同一个形状转换写两遍，两边必然对不上 —— 所以收成这一对函数，
 * 进和出都走它们，并由测试盯着"往返之后字段还在"。
 */

/** 模块存档里的边 → 画布上的边 */
export function moduleEdgesToFlow(edges: ModuleEdge[]): Record<string, unknown>[] {
  return (edges ?? []).map((e) => {
    if (e.targetArg) {
      /*
       * 参数连线要还原成**完整的边形状**。
       *
       * 存档里只有一个 targetArg，而画布上 isParamEdge 看的是 data.kind、
       * 画什么样的线看的是 type / sourceHandle / targetHandle。
       * 只搬 targetArg 的话，参数连线会显示并运行成一条普通流程线 ——
       * "我只是想取个值"变成"多一条执行路径"，目标节点多跑一次。
       *
       * id 要沿用模块里那条边的 id：编辑期间 React Flow 靠它认边，
       * 换成 makeParamEdge 生成的 id 会让"删掉这根线"之类的操作认错边。
       */
      const pe = makeParamEdge(e.source, e.target, e.targetArg, e.sourceArg);
      return { ...pe, id: e.id } as unknown as Record<string, unknown>;
    }
    const data: Record<string, unknown> = {};
    if (e.branch) data.branch = e.branch;
    if (e.loopRole) data.loopRole = e.loopRole;
    const out: Record<string, unknown> = {
      id: e.id, source: e.source, target: e.target,
    };
    if (e.label) out.label = e.label;
    if (Object.keys(data).length > 0) out.data = data;
    return out;
  });
}

/** 画布上的边 → 模块存档里的边 */
export function flowEdgesToModule(edges: readonly unknown[]): ModuleEdge[] {
  return (edges ?? []).map((raw) => {
    const e = raw as {
      id?: unknown; source?: unknown; target?: unknown; label?: unknown;
      data?: Record<string, unknown> | undefined;
      branch?: unknown; loopRole?: unknown;
    };
    const d = e.data;
    const out: ModuleEdge = {
      id: String(e.id ?? ''),
      source: String(e.source ?? ''),
      target: String(e.target ?? ''),
    };
    if (typeof e.label === 'string' && e.label) out.label = e.label;

    /*
     * 参数连线：kind 在 data 里（isParamEdge 就是这么判的）。
     * 顶层那份 branch / loopRole 也要认 —— 模块定义历史上存过顶层形状，
     * 两种都能遇到，只认一种的话另一种会在保存时悄悄丢掉。
     */
    if (d && isParamEdge({ data: d } as never)) {
      const a = d.targetArg;
      if (typeof a === 'string' && a) out.targetArg = a;
      const src = d.sourceArg;
      if (typeof src === 'string' && src && src !== OUT_DEFAULT) out.sourceArg = src;
      return out;
    }
    const branch = (d?.branch ?? e.branch) as string | undefined;
    if (typeof branch === 'string' && branch) out.branch = branch;
    const role = (d?.loopRole ?? e.loopRole) as 'body' | 'done' | undefined;
    if (role === 'body' || role === 'done') out.loopRole = role;
    return out;
  });
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

  /*
   * 打包结果也要脱敏，不只是 addModule 存的时候再脱。
   *
   * packSelection 的产物会先给界面预览 / 撤销栈用一轮，
   * 然后才落到 addModule。只在存时脱的话，内存里那份
   * （以及任何拿 packSelection 结果直接干别的的调用方）
   * 仍然带着明文 —— 而"内存里那份"随时可能被别处写进存档。
   *
   * 判据同样是 ./sanitize 的 redactNodes，不在这里另写一份。
   */
  const nodes = stripRuntimeNodes(redactNodes(list.map((n) => ({
    id: String(n.id),
    position: {
      x: Number((n.position as { x: number })?.x ?? 0) - minX,
      y: Number((n.position as { y: number })?.y ?? 0) - minY,
    },
    data: stripViewKeys((n.data ?? {}) as Record<string, unknown>),
  }))) as Record<string, unknown>[]);

  const edges: ModuleEdge[] = [];
  const crossing: CrossingEdge[] = [];

  /*
   * 已经收进去的连接（source→target 对），用于给嵌合边去重。
   * 嵌合与拉线可能表达同一条连接 —— 显式拉的线带 branch / loopRole，
   * 是更明确的意图，所以**已有真实边就不再补嵌合边**。
   * 两条都留的话同一对节点间会多出一条边，执行时表现为重复触发。
   */
  /*
   * 取边上的"参数连线参数"。不是参数连线返回 undefined。
   *
   * 判据走边的 data（isParamEdge 就是这么判的），不靠 handle ——
   * 打包时 handle 关系不在存档里，data 才是跟着边一起存的那个。
   *
   * sourceArg 也要一起取：只带 targetArg 的话，多输出节点的那根线
   * 展开后会退回主输出，取到的是另一个输出的值，且不报错。
   * 默认值（OUT_DEFAULT）不写进存档 —— 写了反而多一处要判空的地方。
   */
  const paramMetaOf = (e: unknown): { targetArg: string; sourceArg?: string } | undefined => {
    const d = (e as { data?: unknown } | undefined)?.data as Record<string, unknown> | undefined;
    if (d?.kind !== 'param') return undefined;
    const a = d.targetArg;
    if (typeof a !== 'string' || !a) return undefined;
    const raw = d.sourceArg;
    if (typeof raw === 'string' && raw && raw !== OUT_DEFAULT) {
      return { targetArg: a, sourceArg: raw };
    }
    return { targetArg: a };
  };

  const linked = new Set<string>();

  const pushInner = (
    id: string, source: string, target: string,
    branch?: string, loopRole?: 'body' | 'done' | undefined,
    param?: { targetArg: string; sourceArg?: string },
  ) => {
    /*
     * targetArg 只在参数连线上有。undefined 时不要写进对象 ——
     * 写一个 targetArg: undefined 进存档，展开时判空会分不清
     * "没这个字段"和"字段是 undefined"，干净的存档更好排查。
     */
    edges.push(param
      ? { id, source, target, branch, loopRole, ...param }
      : { id, source, target, branch, loopRole });
    linked.add(`${source}->${target}`);
  };

  for (const e of allEdges ?? []) {
    const s = String(e?.source ?? '');
    const t = String(e?.target ?? '');
    const inS = ids.has(s);
    const inT = ids.has(t);

    if (inS && inT) {
      pushInner(
        String(e?.id ?? `${s}-${t}`), s, t, e?.branch, e?.loopRole,
        paramMetaOf(e),
      );
      continue;
    }
    /* 一端在里面、一端在外面 —— 摘出来，替换后重新挂到实例上 */
    if (inS && !inT) {
      crossing.push({
        kind: 'out', outer: t, inner: s,
        branch: e?.branch, loopRole: e?.loopRole, ...(paramMetaOf(e) ?? {}),
      });
      continue;
    }
    if (!inS && inT) {
      crossing.push({
        kind: 'in', outer: s, inner: t,
        branch: e?.branch, loopRole: e?.loopRole, ...(paramMetaOf(e) ?? {}),
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
    /*
     * 去重键必须带上 targetArg。
     *
     * 不带的话，"同一个外部节点给模块内两个不同参数供值"这两条线
     * 会被当成同一条去重掉 —— 表现为存完模块少了一条参数连线，
     * 而界面上看不出少的是哪一条。
     */
    const key = `${source}->${target}|${c.branch ?? ''}|${c.loopRole ?? ''}|${c.targetArg ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const base = {
      id: `x_${instanceId}_${seen.size}`,
      source,
      target,
      branch: c.branch,
      loopRole: c.loopRole,
    };
    out.push(c.targetArg ? { ...base, targetArg: c.targetArg } : base);
  }
  return out;
}
