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
/*
 * 运行时字段清单收口在 engine/runtimeKeys.ts —— 全项目只有那一处。
 * 这里 re-export 是为了让既有 import 不用改，
 * 但**新代码请直接从 runtimeKeys 引**。
 */
export { RUNTIME_KEYS, stripRuntime } from './runtimeKeys';

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

  /*
   * 嵌合关系（stackParent）要跟着一起重指向，不能原样照抄。
   *
   * ============ 为什么必须处理 ============
   *
   * 照抄会造出两种都不是用户想要的结果：
   *
   *   ① 父**不在**复制集合里（最常见：Ctrl 拖动串中间的一环）
   *      副本仍指向原父 → 原父名下同时挂着原件与副本两个下级。
   *      而嵌合是**链**（一个父只有一个下级，见 stack.ts 的 childrenOf），
   *      多出来那个会被当成"链上的另一个分支"，取哪个全看遍历顺序 ——
   *      表现为"拖动原串时，被复制出来的那块也跟着跳"。
   *
   *   ② 父**在**复制集合里（整串一起复制）
   *      副本指向**原件** → 副本串的一半挂在原件上。
   *      于是拖副本会带着原件走，原件被改动 —— 而复制的本意是原件不动。
   *
   * 所以：父在集合内 → 指向副本；父在集合外 → 断开（副本独立）。
   * 断开是刻意的：副本落在松手的位置，通常与原来的父并不相邻，
   * 留着关系就是"关系还在、看着却是歪的"那一类。
   */
  for (const n of outNodes) {
    const d = (n.data ?? {}) as Record<string, unknown>;
    const p = d.stackParent;
    if (typeof p !== 'string') continue;
    /*
     * 空串也算"没有父"（parentIdOf 就是这么判的），
     * 留着它只是往存档里写脏值 —— 一并清掉。
     */
    if (map[p]) d.stackParent = map[p];
    else delete d.stackParent;
  }

  /*
   * 窗格归属（paneId）也要跟着重指向，但**断开规则与 stackParent 相反**：
   * 窗格不在复制集合里时保持原样，而不是清掉。
   *
   * ============ 为什么两边不一样 ============
   *
   * 嵌合是**链**（一个父只有一个下级）。副本留着关系会变成
   * "链上的另一个分支"，取哪个全看遍历顺序 —— 所以必须断开。
   *
   * 窗格是**多对一**：一个窗格本来就可以挂任意多个成员。
   * 副本继续指着原窗格既不冲突，也符合预期 ——
   * "复制一个同类节点，继承同一份共享配置"正是用户想要的。
   *
   * 反过来（断开）会把配置继承悄悄弄丢：副本变成"没挂窗格"，
   * 于是它不再继承工作目录/模型，表现为"复制出来的节点配置不对"，
   * 而用户从没做过"脱离窗格"这个改动。
   *
   * 只有一种情况需要清掉：窗格本身也被复制了，
   * 那就改成指向副本窗格（map[p] 命中），
   * 否则副本节点会被原窗格"抢走"—— 原窗格的成员数凭空 +1，
   * 而用户看着两个窗格，却分不清哪个挂了谁。
   *
   * 空串同样清掉：那是曾经挂过又被摘下来的脏值，
   * 留着会让"没挂窗格"的判断多一条分支。
   */
  for (const n of outNodes) {
    const d = (n.data ?? {}) as Record<string, unknown>;
    const p = d.paneId;
    if (typeof p !== 'string') continue;
    if (map[p]) d.paneId = map[p];
    else if (p.trim() === '') delete d.paneId;
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
