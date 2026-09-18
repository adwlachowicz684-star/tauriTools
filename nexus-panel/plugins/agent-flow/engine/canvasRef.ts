/**
 * 跨画布调用 —— 把一张画布当作一个节点用。
 *
 * ================= 体感与实现 =================
 *
 * 体感上："每张画布 = 触发器 + 一个大模块，只是这个大模块跨画布调用"。
 * 实现上正是这么做的：复用 engine/modules.ts 的展开思路 ——
 * 执行时把「画布引用节点」替换成目标画布的内部节点，
 * 于是拓扑排序、失败传播、跳过这些既有规则全部自动成立，
 * 引擎里不需要为"跨画布"写任何专门的调度逻辑。
 *
 * ================= 为什么展开而不是"递归跑一次" =================
 *
 * 另一种做法是遇到画布节点就递归调 runGraph，把结果塞回 output。
 * 那样：
 *   · 子画布内部的失败要跨层往上报，传播规则得重写一遍
 *   · 日志会断在两个画布里，看不出内部是哪一步挂的
 *   · 并发度、循环上下文这些要跨层传递
 * 展开成一图就都没这些问题 —— 代价只是节点 id 要加前缀。
 *
 * ================= 接口怎么定 =================
 *
 * 两条路并用：
 *   ① 自动推导：入口 = 没有上游的内部节点，出口 = 没有下游的
 *   ② 显式标注：画布里可以放「画布输入 / 画布输出」节点
 *
 * 有显式节点时以它为准 —— 用户放这些节点就是想自己定接口。
 * 没有时退回自动推导，这样一张普通画布不用做任何改造就能被引用。
 */

import type { AnyNode, AnyEdge } from './moduleTypes';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/**
 * 画布的最小视图 —— 执行时只需要这些。
 *
 * 不直接依赖 Canvas 类型：那是存储层的形状，
 * 引擎层依赖它会让测试必须构造完整存档。
 */
export type CanvasView = {
  id: string;
  name: string;
  nodes: AnyNode[];
  edges: AnyEdge[];
};

export type CanvasPorts = {
  /** 入口内部节点 id */
  entries: string[];
  /** 出口内部节点 id */
  exits: string[];
  /** 入口里哪些是显式标注的 */
  explicitIn: string[];
  explicitOut: string[];
};

/* ------------------------------------------------------------------ */
/* 接口推导                                                            */
/* ------------------------------------------------------------------ */

export const KIND_CANVAS_IN = 'canvasIn';
export const KIND_CANVAS_OUT = 'canvasOut';
export const KIND_CANVAS_REF = 'canvasRef';

function kindOf(n: AnyNode): string {
  const d = (n?.data ?? {}) as Record<string, unknown>;
  return String(d.kind ?? '');
}

/**
 * 推导一张画布的对外接口。
 *
 * 显式节点优先：放了「画布输入」就以它们为入口 ——
 * 用户放这些节点的目的就是自己定接口，自动推导会覆盖他的意图。
 *
 * 但**显式节点存在却一个都没连**时要说清楚：
 * 那多半是刚拖出来还没接，按"接口为空"处理会让父画布连不上却没提示。
 */
export function canvasPorts(view: CanvasView): CanvasPorts {
  const nodes = view.nodes ?? [];
  const edges = view.edges ?? [];
  const ids: string[] = [];
  for (const n of nodes) {
    const id = String(n?.id ?? '');
    // 画布引用节点本身也可能没有上下游，但它不该被当成接口
    if (id && kindOf(n) !== KIND_CANVAS_REF) ids.push(id);
  }

  const hasUp = new Set<string>();
  const hasDown = new Set<string>();
  for (const e of edges) {
    hasUp.add(String(e?.target ?? ''));
    hasDown.add(String(e?.source ?? ''));
  }

  const explicitIn = ids.filter((id) => kindOf(nodes.find((n) => n.id === id) as AnyNode) === KIND_CANVAS_IN);
  const explicitOut = ids.filter((id) => kindOf(nodes.find((n) => n.id === id) as AnyNode) === KIND_CANVAS_OUT);

  const entries = explicitIn.length > 0
    ? explicitIn
    : ids.filter((id) => !hasUp.has(id));
  const exits = explicitOut.length > 0
    ? explicitOut
    : ids.filter((id) => !hasDown.has(id));

  return { entries, exits, explicitIn, explicitOut };
}

/**
 * 接口健康度检查。
 *
 * 接口有问题时**不静默**：父画布连上去却拿不到东西，
 * 比"这里有个配置错误"难查得多。
 */
export type PortIssue = { level: 'warn' | 'block'; message: string };

export function checkPorts(view: CanvasView): PortIssue[] {
  const p = canvasPorts(view);
  const out: PortIssue[] = [];
  const name = view.name || view.id;

  if (p.entries.length === 0) {
    out.push({ level: 'block', message: `画布「${name}」没有入口（没有画布输入节点，也没有无上游的节点）` });
  }
  if (p.exits.length === 0) {
    out.push({ level: 'block', message: `画布「${name}」没有出口（没有画布输出节点，也没有无下游的节点）` });
  }
  // 显式标了但没接 —— 多半是刚拖出来还没连线
  if (p.explicitIn.length > 0 && p.entries.length === p.explicitIn.length) {
    const hasUp = new Set((view.edges ?? []).map((e) => String(e?.source ?? '')));
    const unlinked = p.explicitIn.filter((id) => !hasUp.has(id));
    if (unlinked.length === p.explicitIn.length && p.explicitIn.length > 0) {
      out.push({ level: 'warn', message: `画布「${name}」的画布输入节点还没接下游` });
    }
  }

  /*
   * 画布里只有「调用别的画布」的节点 —— 接口推导不出来。
   *
   * 这种情况在展开后其实是有接口的（被调画布的接口会透传上来），
   * 但 canvasPorts 拿不到被调画布的内容，所以这里只做提示：
   * 静默说"没有入口"会让人以为要把画布改坏，实际它不是问题。
   */
  const allNodes = view.nodes ?? [];
  const onlyRefs = allNodes.length > 0
    && allNodes.every((n) => kindOf(n) === KIND_CANVAS_REF);
  if (onlyRefs && out.some((i) => i.level === 'block')) {
    out.push({
      level: 'warn',
      message: `画布「${name}」只调用了别的画布，接口由被调用的那张决定`,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 跨画布展开                                                          */
/* ------------------------------------------------------------------ */

/** 展开后的内部节点 id 前缀，与模块那一套保持同一个分隔符 */
export function canvasInnerId(instanceId: string, nodeId: string): string {
  return `${instanceId}__${nodeId}`;
}

export type ExpandOutcome = {
  nodes: AnyNode[];
  edges: AnyEdge[];
  /** 每个画布引用实例 → 它的入口/出口（展开后的 id） */
  ports: Map<string, { entries: string[]; exits: string[] }>;
  /** 展开失败/跳过的实例及原因。不静默丢弃 */
  problems: { instanceId: string; reason: string }[];
};

/** 解析函数：由调用方提供「画布 id → 内容」，找不到返回 null */
export type CanvasResolver = (canvasId: string) => CanvasView | null;

/**
 * 展开图里所有画布引用节点。
 *
 * @param stack 调用栈，用于检测循环引用（A 引用 B，B 又引用 A）
 */
export function expandCanvasRefs(
  graph: { nodes: AnyNode[]; edges: AnyEdge[] },
  resolve: CanvasResolver,
  opts: { stack?: string[]; maxDepth?: number } = {},
): ExpandOutcome {
  const maxDepth = opts.maxDepth ?? 8;
  const stack = opts.stack ?? [];
  const problems: ExpandOutcome['problems'] = [];
  const ports: ExpandOutcome['ports'] = new Map();

  const outNodes: AnyNode[] = [];
  const outEdges: AnyEdge[] = [];

  for (const n of graph.nodes) {
    const d = (n?.data ?? {}) as Record<string, unknown>;
    const id = String(n?.id ?? '');

    if (String(d.kind ?? '') !== KIND_CANVAS_REF) {
      outNodes.push(n);
      continue;
    }

    const canvasId = String(d.canvasId ?? '').trim();
    if (!canvasId) {
      problems.push({ instanceId: id, reason: '没有指定要调用哪张画布' });
      outNodes.push(n);
      continue;
    }

    /*
     * 循环引用必须挡住 ——
     * A 调 B、B 又调 A 会无限展开，表现为栈溢出或内存爆掉，
     * 而用户完全不知道是哪两张画布绕起来了。
     */
    if (stack.includes(canvasId)) {
      problems.push({
        instanceId: id,
        reason: `画布之间存在循环调用（${[...stack, canvasId].join(' → ')}）`,
      });
      outNodes.push(n);
      continue;
    }
    if (stack.length >= maxDepth) {
      problems.push({
        instanceId: id,
        reason: `跨画布调用层数超过 ${maxDepth} 层，太深了`,
      });
      outNodes.push(n);
      continue;
    }

    const view = resolve(canvasId);
    if (!view) {
      problems.push({ instanceId: id, reason: `找不到画布「${canvasId}」（可能已被删除）` });
      outNodes.push(n);
      continue;
    }

    /* 递归展开：子画布里可能还有画布引用节点 */
    const inner = expandCanvasRefs(
      { nodes: view.nodes ?? [], edges: view.edges ?? [] },
      resolve,
      { stack: [...stack, canvasId], maxDepth },
    );
    for (const p of inner.problems) problems.push(p);

    const p = canvasPorts({ ...view, nodes: inner.nodes, edges: inner.edges });
    if (p.entries.length === 0 || p.exits.length === 0) {
      problems.push({
        instanceId: id,
        reason: `画布「${view.name}」接口不完整（入口 ${p.entries.length} 个、出口 ${p.exits.length} 个）`,
      });
    }

    /* 内部节点加前缀后并入 */
    const idMap = new Map<string, string>();
    for (const inNode of inner.nodes) {
      const oldId = String(inNode?.id ?? '');
      const newId = canvasInnerId(id, oldId);
      idMap.set(oldId, newId);
      outNodes.push({
        ...inNode,
        id: newId,
        data: rewriteDataTemplates(inNode.data, idMap) as Record<string, unknown>,
      });
    }

    /* 内部边：两端都改成新 id */
    for (const e of inner.edges) {
      const s = idMap.get(String(e?.source ?? ''));
      const t = idMap.get(String(e?.target ?? ''));
      if (!s || !t) continue;
      outEdges.push({ ...e, id: `${id}__${String(e?.id ?? `${s}-${t}`)}`, source: s, target: t });
    }

    ports.set(id, {
      entries: p.entries.map((x) => idMap.get(x) ?? x),
      exits: p.exits.map((x) => idMap.get(x) ?? x),
    });
  }

  /* 外部边：接到入口/出口 */
  for (const e of graph.edges) {
    const s = String(e?.source ?? '');
    const t = String(e?.target ?? '');
    const srcIsRef = ports.has(s);
    const dstIsRef = ports.has(t);

    if (!srcIsRef && !dstIsRef) {
      outEdges.push(e);
      continue;
    }
    // 出：内部所有出口 → 外部目标
    if (srcIsRef) {
      const src = ports.get(s);
      for (const ex of src?.exits ?? []) {
        outEdges.push({ ...e, id: `${s}__out__${String(e?.id ?? t)}__${ex}`, source: ex, target: t });
      }
    }
    // 入：外部源 → 内部所有入口（多入口时每个都接）
    if (dstIsRef) {
      const dst = ports.get(t);
      for (const en of dst?.entries ?? []) {
        outEdges.push({ ...e, id: `${t}__in__${String(e?.id ?? s)}__${en}`, source: s, target: en });
      }
    }
    // 两端都是画布引用 → 笛卡尔积（出口 × 入口）
    if (srcIsRef && dstIsRef) {
      // 上面两个分支已经各接了一半，这里补上直连
      const src = ports.get(s);
      const dst = ports.get(t);
      for (const ex of src?.exits ?? []) {
        for (const en of dst?.entries ?? []) {
          outEdges.push({
            ...e,
            id: `${s}__${t}__${ex}__${en}`,
            source: ex,
            target: en,
          });
        }
      }
    }
  }

  return { nodes: outNodes, edges: outEdges, ports, problems };
}

/**
 * 重写 data 里的模板引用。
 *
 * 内部节点写 `{{A.output}}`，展开后 A 变成了 `inst__A`，
 * **不重写就取不到值，而且不报错** —— 只是渲染成空串。
 * 这是模块那一轮踩过的坑，这里直接复用同一套处理。
 */
export function rewriteDataTemplates(
  data: unknown,
  idMap: Map<string, string>,
): unknown {
  if (!data || typeof data !== 'object') return data;
  const src = data as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'string') {
      out[k] = rewriteRefsInText(v, idMap);
      continue;
    }
    if (Array.isArray(v)) {
      out[k] = v.map((x) => (typeof x === 'string' ? rewriteRefsInText(x, idMap) : x));
      continue;
    }
    if (v && typeof v === 'object') {
      out[k] = rewriteDataTemplates(v, idMap);
      continue;
    }
    out[k] = v;
  }
  return out;
}

const REF_RE = /\{\{\s*([A-Za-z0-9_\u4e00-\u9fa5]+)\s*\./g;

function rewriteRefsInText(text: string, idMap: Map<string, string>): string {
  if (!text.includes('{{')) return text;
  return text.replace(REF_RE, (m, id: string) => {
    const to = idMap.get(id);
    return to ? `{{${to}.` : m;
  });
}

/* ------------------------------------------------------------------ */
/* 收集：一张画布引用了哪些画布                                          */
/* ------------------------------------------------------------------ */

export function referencedCanvases(nodes: AnyNode[]): string[] {
  const out = new Set<string>();
  for (const n of nodes ?? []) {
    const d = (n?.data ?? {}) as Record<string, unknown>;
    if (String(d.kind ?? '') !== KIND_CANVAS_REF) continue;
    const cid = String(d.canvasId ?? '').trim();
    if (cid) out.add(cid);
  }
  return [...out];
}

/**
 * 检测一组画布之间有没有循环引用。
 *
 * 每次保存画布时跑一次最合适 ——
 * 等到执行时才发现在循环，用户已经在别的画布上改了半天。
 */
export function findCanvasCycles(
  canvases: CanvasView[],
): string[][] {
  const byId = new Map<string, CanvasView>();
  for (const c of canvases ?? []) byId.set(c.id, c);

  const cycles: string[][] = [];
  const state = new Map<string, 0 | 1 | 2>(); // 0未访问 1在栈中 2已完成
  const path: string[] = [];

  const visit = (id: string): void => {
    if (state.get(id) === 1) {
      // 找到环：从 path 里第一次出现 id 的位置截出来
      const at = path.indexOf(id);
      if (at >= 0) cycles.push([...path.slice(at), id]);
      return;
    }
    if (state.get(id) === 2) return;
    state.set(id, 1);
    path.push(id);

    const view = byId.get(id);
    for (const dep of referencedCanvases(view?.nodes ?? [])) {
      if (byId.has(dep)) visit(dep);
    }

    path.pop();
    state.set(id, 2);
  };

  for (const c of canvases ?? []) visit(c.id);
  return cycles;
}
