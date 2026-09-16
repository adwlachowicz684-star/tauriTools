/**
 * 节点复制（Ctrl+拖动、以及将来的 Ctrl+D / 右键复制都走这里）。
 *
 * 只放**纯逻辑**：不依赖注册表、不依赖 React，便于单测。
 * UI 层负责造 id 与铺默认值（那两件事需要访问注册表）。
 */

/** 一个最小够用的节点形状。画布上的节点字段更多，结构兼容即可 */
export type DupNode = {
  id: string;
  position: { x: number; y: number };
  data?: unknown;
  selected?: boolean;
  dragging?: boolean;
};

/** 最小够用的边形状 */
export type DupEdge = {
  id: string;
  source: string;
  target: string;
  selected?: boolean;
};

/**
 * 每次运行都会变的字段。
 *
 * 复制时必须清掉，否则新节点会带着上一份执行结果：
 * 复制一个跑过的 HTTP 节点，副本显示「已完成」且 output 是旧响应 ——
 * 用户会以为它跑过了，实际一次都没跑。
 *
 * 与 engine/customPresets.ts 共用同一套口径（那边用于存预设）。
 */
const RUNTIME_KEYS = ['status', 'output', 'error'];

/**
 * 去掉运行时状态，只留配置。
 *
 * 用「三个固定键 + last* 前缀」的黑名单而不是白名单：
 * 各节点配置字段差异太大，白名单既长又容易漏；
 * 而运行时字段的命名是收敛的（都是 last 开头，或就那三个）。
 * 副作用：往后新增的运行时字段，只要沿用 last* 命名就自动被清掉。
 *
 * 注意它**不**补 status/output/error 的默认值 ——
 * 调用方应当先用 def.create(newId) 铺一遍全字段默认值，再叠这里的结果。
 * 这样默认值只有一处（节点定义），不会在这里抄第二份。
 */
export function stripRuntime(data: unknown): Record<string, unknown> {
  const src = (data ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(src)) {
    if (RUNTIME_KEYS.indexOf(k) >= 0) continue;
    if (k.indexOf('last') === 0) continue;
    out[k] = src[k];
  }
  return out;
}

/**
 * 深拷贝节点数据。
 *
 * 必须深拷贝：data 里有嵌套对象（llm: {...}、config: {...}、rules: [...]），
 * 浅拷贝会让副本与原件共享它们 —— 改副本的模型配置，原节点跟着变。
 * 这类 bug 不会报错，只会表现为「改了一个，另一个也动了」。
 *
 * 用 JSON 而不是 structuredClone：节点数据本就该是可序列化的
 * （要存进 localStorage），顺带挡住不小心塞进来的函数 / DOM 引用。
 */
export function cloneData(data: unknown): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(data ?? {})) as Record<string, unknown>;
  } catch {
    // 循环结构之类的极端情况：退一层浅拷贝，至少副本的顶层字段是独立的
    return { ...((data ?? {}) as Record<string, unknown>) };
  }
}

export type DuplicateInput = {
  nodes: DupNode[];
  edges: DupEdge[];
  /** 要复制的节点 id（通常是当前选中的） */
  ids: string[];
  makeNodeId: (oldId: string) => string;
  makeEdgeId: (oldId: string) => string;
  /**
   * 造新节点的 data。
   * 调用方应按「def.create(newId) 铺默认 → 叠 stripRuntime(oldData)」实现。
   * 传 oldId 是因为取节点定义（从而调 create）要按原节点查。
   */
  makeData: (newId: string, oldData: unknown, oldId: string) => Record<string, unknown>;
  /** 位置偏移。拖动复制时传 {x:0,y:0}，让副本精确跟随鼠标 */
  offset?: { x: number; y: number };
};

export type DuplicateResult = {
  nodes: DupNode[];
  edges: DupEdge[];
  /** 原 id → 新 id，供调用方把后续事件（如拖动的位移）改写到副本上 */
  map: Record<string, string>;
};

/**
 * 复制一组节点以及它们之间的连线。
 *
 * **只复制内部边**（两端都在复制集合内的边）。
 * 跨集合的边不复制：否则副本会连回原节点，形成用户没画过的连接。
 */
export function duplicateElements(input: DuplicateInput): DuplicateResult {
  const { nodes, edges, ids, makeNodeId, makeEdgeId, makeData, offset } = input;
  const dx = offset ? offset.x : 0;
  const dy = offset ? offset.y : 0;

  const want: Record<string, boolean> = {};
  for (const id of ids) want[id] = true;

  const map: Record<string, string> = {};
  const outNodes: DupNode[] = [];

  for (const n of nodes) {
    if (!want[n.id]) continue;
    const newId = makeNodeId(n.id);
    map[n.id] = newId;
    outNodes.push({
      ...n,
      id: newId,
      position: { x: n.position.x + dx, y: n.position.y + dy },
      // 先克隆再交给 makeData：makeData 会在其上叠默认值与配置
      data: makeData(newId, cloneData(n.data), n.id),
      // 复制完成后应当选中副本、取消原件，否则两个都高亮，看不出谁是新加的
      selected: true,
      dragging: false,
    });
  }

  const outEdges: DupEdge[] = [];
  for (const e of edges) {
    const s = map[e.source];
    const t = map[e.target];
    if (!s || !t) continue;
    outEdges.push({
      ...e,
      id: makeEdgeId(e.id),
      source: s,
      target: t,
      selected: false,
    });
  }

  return { nodes: outNodes, edges: outEdges, map };
}
