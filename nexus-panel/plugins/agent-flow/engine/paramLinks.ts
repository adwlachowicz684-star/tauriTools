/**
 * 参数连线 —— 「这个参数的值，来自哪个节点的输出」。
 *
 * ================= 要解决什么 =================
 *
 * 运算类节点（数学 / 比较 / 文本 / 随机）的参数都是**一个文本框**，
 * 值可以手填，也可以写 `{{上游.output}}` 这种模板。于是同一个结果
 * 有两种写法，而画布上**看不出这个参数到底吃的是谁的输出**：
 *
 *   比较节点：a = 「苹果」  b = 「果」     ← 这两个值是哪来的？
 *
 * 现在连一条线就能说清，不用再去读参数框里的模板串。
 *
 * ================= 为什么单独一层 =================
 *
 * 参数连线与流程连线（A 跑完跑 B）是**两件事**：
 *
 *   流程连线  决定**执行顺序**与数据主干（input 往下传）
 *   参数连线  只决定**某个参数的值**从哪来
 *
 * 混在一起的后果很具体：条件节点的分支判定是"沿流程边走哪条"，
 * 参数连线若被当成流程边，一个"给参数取值"的动作会凭空多出一条
 * 执行路径 —— 表现为某个节点跑了两次，而且看不出为什么。
 *
 * 所以两者在**同一个 edges 数组里共存**（React Flow 只渲染这个数组），
 * 但执行前必须分开，见 flowEdgesOf / paramLinksOf。
 *
 * ================= 判定的唯一入口 =================
 *
 * "这条边是不是参数连线"这个判定**只能写在这两个函数里**。
 * 散在各处就会出现"有的地方当流程边、有的地方当参数连线"的半边症状，
 * 而这类症状的表现是"偶尔多跑一次"，极难联想回这里。
 */

import type { GraphEdge, GraphNode } from '../types';
import { specOf } from './nodeSpec';
import { argExpectOf, type ArgTypeIssue, type ValueKind } from './argTypes';

/* ------------------------------------------------------------------ */
/* handle 约定                                                        */
/* ------------------------------------------------------------------ */

/**
 * 出口 handle 的 id。
 *
 * 参数连线**必须**从这个出口出发：节点右侧那个默认出口是流程出口，
 * 两者共用同一个 handle 的话，拖出来的线无法判断用户想连哪一种。
 */
export const OUT_HANDLE = 'out';

/**
 * 参数连线的颜色。
 *
 * 线的颜色走 CSS 变量 `--af-t-param`（能跟主题），
 * 但**箭头不行**：React Flow 的 marker 是在建边那一刻生成的
 * `<marker fill="...">`，而且 `fill` 是**表现属性**不是 CSS 属性 ——
 * 浏览器不解析表现属性里的 `var()`，写了箭头会直接消失。
 *
 * 于是箭头色只能烘死在这里。两处各写一个数字必然漂移，
 * 所以抽成常量 + 加守卫（测试断言两边同一个值）。
 */
export const PARAM_COLOR = '#c084fc';

/** 参数入口 handle 的 id：arg:参数key */
export function argHandleId(key: string): string {
  return `arg:${key}`;
}

/** 从 handle id 反解参数 key。不是参数入口则返回 null */
export function parseArgHandle(h: string | null | undefined): string | null {
  if (!h) return null;
  return h.startsWith('arg:') ? h.slice('arg:'.length) : null;
}

/** sourceHandle / targetHandle 是否构成一条参数连线 */
export function isParamHandles(
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined,
): boolean {
  return sourceHandle === OUT_HANDLE && parseArgHandle(targetHandle) !== null;
}

/* ------------------------------------------------------------------ */
/* 判定与分离                                                          */
/* ------------------------------------------------------------------ */

/**
 * 一条参数连线。
 *
 * 只记三件事：从哪来、到哪去、填进哪个参数。
 * 不记值 —— 值是运行时才有的，记下来就变成"第二份值"，
 * 改了上游这里还是旧值，表现为"改了没反应"。
 */
export type ParamLink = {
  id: string;
  source: string;
  target: string;
  /** 目标节点上被填充的参数 key */
  targetArg: string;
};

/**
 * 这条边是不是参数连线。
 *
 * 判据写在**边的 data 上**而不是 handle 上：连线一旦建好，
 * handle 的关系就固定了，而 data 是唯一随边一起存档的东西。
 */
export function isParamEdge(e: GraphEdge): boolean {
  const d = e.data as Record<string, unknown> | undefined;
  return d?.kind === 'param';
}

/** 从边数组里取出全部参数连线 */
export function paramLinksOf(edges: GraphEdge[]): ParamLink[] {
  const out: ParamLink[] = [];
  for (const e of edges) {
    if (!isParamEdge(e)) continue;
    const d = e.data as Record<string, unknown> | undefined;
    const targetArg = typeof d?.targetArg === 'string' ? d.targetArg : null;
    // 没有 targetArg 的参数连线是废线（连到了节点但没说填哪个参数），跳过
    if (!targetArg) continue;
    out.push({ id: e.id, source: e.source, target: e.target, targetArg });
  }
  return out;
}

/**
 * 取出全部**流程连线**。
 *
 * 执行时的一切遍历（拓扑分层、分支、循环、停止传播、并发继承）
 * 都只认这个结果 —— 它们拿到参数连线会把它当成一条执行路径。
 */
export function flowEdgesOf(edges: GraphEdge[]): GraphEdge[] {
  return edges.filter((e) => !isParamEdge(e));
}

/** 建一条参数连线（给 onConnect 用） */
export function makeParamEdge(
  source: string,
  target: string,
  targetArg: string,
): GraphEdge {
  return {
    id: `p:${source}->${target}:${targetArg}`,
    source,
    target,
    /*
     * type 是 React Flow 选组件的依据。
     * 不设它，参数连线会画成普通流程线 —— 两种线长得一样，
     * 用户只能靠"它连到了哪个 handle"去猜，那看不见。
     */
    type: 'param',
    /*
     * 箭头。
     *
     * 参数连线**必须**有方向：它回答的是"谁的值给谁用"。
     * 没有箭头的话，一根线两端的节点看着完全对等，
     * 只能去猜是上游供值还是下游供值。
     *
     * 值写成字符串字面量而不 import MarkerType：engine/ 下这些文件
     * 是要能在纯 node 里跑测试的，引 @xyflow/react 会把 React 整包拖进来。
     * 'arrowclosed' 是 MarkerType.ArrowClosed 的值，稳定公开。
     */
    markerEnd: { type: 'arrowclosed', color: PARAM_COLOR, width: 16, height: 16 },
    data: { kind: 'param', targetArg } as unknown as GraphEdge['data'],
  };
}

/* ------------------------------------------------------------------ */
/* 产出值的种类                                                        */
/* ------------------------------------------------------------------ */

/**
 * 某个节点**产出值的种类**（用 argTypes 的三元口径）。
 *
 * ================= 为什么不能直接搬 PortKind =================
 *
 * `nodeSpec` 的 PortKind 是**给流程连接用的粗粒度**语义
 * （text / json / bool / files / table / mark / any / none），
 * 它回答的是"这条数据流能不能接上"。
 *
 * 而参数校验要的是"这个值能不能参与运算"，粒度不同：
 *
 *   数学节点 produces = 'text'（它的输出确实是文本）
 *   但它产出的是**数字文本**，接到比较的「大于」上完全合法
 *
 * 按 PortKind 判会把"数学 → 比较·大于"标红，
 * 而这是最常见、最该支持的接法。**误报比漏报更糟**。
 *
 * ================= 为什么写成 SPECS 的补充字段 =================
 *
 * 这张表如果单独维护，节点改了产出这里不跟着改就漂移，
 * 而漂移的表现是"该报的没报" —— 静默失效，没人会发现。
 * 所以它只填**能确定**的少数几种，其余一律从 produces 推。
 */
export function producesArgOf(dataKind: string | undefined | null): ValueKind {
  switch (dataKind) {
    // 产出一定是数字文本（即使 PortKind 写的是 text）
    case 'math':
    case 'random':
    case 'agg':
      return 'num';
    // 产出 true / false 文本
    case 'compare':
    case 'update':
    case 'gate':
      return 'bool';
    default:
      break;
  }
  const produces = specOf(dataKind)?.produces;
  switch (produces) {
    case 'text':
    case 'json':
      return 'text';
    case 'bool':
      return 'bool';
    case 'table':
      return 'table';
    case 'files':
      return 'files';
    /*
     * 状态标记（"已等待 2000ms"）：它是**描述动作完成**，
     * 不是承载数据，拿去当参数值几乎一定是错的。
     * 但它是文本，报"类型不符"会让人以为是格式问题。
     * 归 unknown = 不参与校验，由连线时的提示文案去说（见 linkHintOf）。
     */
    case 'mark':
      return 'unknown';
    /*
     * 透传 / 无输出：编辑时看不出会是什么值，一律放行。
     * 判成任何具体种类都是猜，猜错就是误报。
     */
    case 'any':
    case 'none':
    default:
      return 'unknown';
  }
}

/* ------------------------------------------------------------------ */
/* 连线时的提示                                                        */
/* ------------------------------------------------------------------ */

/**
 * 连线**当下**给用户的提示（不是红灯，是建议）。
 *
 * 与类型校验分开：类型校验拦的是"接上去一定算错"，
 * 这里说的是"能接，但语义上可疑"。
 *
 * 典型就是 mark —— 「等待 2 秒」的输出是状态标记，
 * 接到数学节点的参数上不报错，但拿到的是"已等待 2000ms"这句文本，
 * 参与运算会变成 0，而且不报错。**这时候只能靠连线时提醒**。
 */
export function linkHintOf(
  srcKind: string | undefined | null,
  targetArg: string,
): string | null {
  const produces = specOf(srcKind)?.produces;
  if (produces === 'mark') {
    return `「${specOf(srcKind)?.producesDesc ?? '这个节点'}」的输出是状态标记，不是数据；拿去当参数会拿到一句描述文字`;
  }
  if (produces === 'none') return '这个节点不产出任何内容，接上去会拿到空值';
  void targetArg;
  return null;
}

/* ------------------------------------------------------------------ */
/* 类型校验                                                            */
/* ------------------------------------------------------------------ */

/**
 * 参数连线的类型校验。
 *
 * ================= 为什么连了线还要校验 =================
 *
 * 用户提的那个例子正是这里的动机：
 *
 *   1. 数值运算接了一个「包含」判定的输出（文本） → 合法
 *   2. 后来把上游改成「大于」                    → 输出变成 bool
 *   3. 目标参数的期望还是文本                    → **现在不符了**
 *
 * 第 3 步界面上不会有任何变化（连线没动），
 * 只有把"上游产出什么"与"这里期望什么"重新对一遍才发现。
 * 所以校验必须**跟着上游节点的当前配置走**，不是连线时判一次就完。
 *
 * 返回按节点分组：key = 目标节点 id，值 = 该节点的问题清单。
 */
export function paramLinkIssues(
  nodes: GraphNode[],
  links: ParamLink[],
): Record<string, ArgTypeIssue[]> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: Record<string, ArgTypeIssue[]> = {};

  for (const link of links) {
    const src = byId.get(link.source);
    const dst = byId.get(link.target);
    if (!src || !dst) continue;

    const srcData = src.data as Record<string, unknown> | undefined;
    const dstData = dst.data as Record<string, unknown> | undefined;
    const dstKind = (dst.data as Record<string, unknown> | undefined)?.kind as string | undefined;

    // 目标参数期望什么：走 argTypes 那张表（它已按 op 分过层）
    const expect = argExpectOf(dstKind, dstData, link.targetArg);
    if (!expect || expect === 'any') continue;

    const actual = producesArgOf((srcData?.kind as string | undefined) ?? null);
    // unknown = 上游产出看不出来（mark / any / none），不在这报
    if (actual === 'unknown' || actual === 'any') continue;

    if (actual === expect) continue;

    (out[link.target] ??= []).push({
      key: link.targetArg,
      expect,
      actual,
      message: `「${link.targetArg}」接的是上游输出（${valueLabel(actual)}），但这里要${valueLabel(expect)}`,
    });
  }
  return out;
}

function valueLabel(v: ValueKind): string {
  switch (v) {
    case 'num':
      return '数字';
    case 'text':
      return '文本';
    case 'bool':
      return '是/否';
    case 'table':
      return '表格';
    case 'files':
      return '文件';
    default:
      return '任意内容';
  }
}

/* ------------------------------------------------------------------ */
/* 执行时填充                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把参数连线的值填进节点数据。
 *
 * ================= 为什么在渲染模板之前 =================
 *
 * 节点参数里可能还写着 `{{xxx}}`，模板渲染会把它替换掉。
 * 若先填连线值再渲染模板，而连线拿到的上游输出里恰好含 `{{...}}`
 * （比如上游是读文件、内容里带花括号），那串会被当成模板再解析一次。
 *
 * 所以顺序是：**先渲染模板 → 再覆盖成连线值**。
 * 连线值是大白话"这个值就是上游输出"，不再做任何解释。
 *
 * 这个函数的调用点在 runner 里每个节点执行之前。
 */
export function applyParamLinks<T extends Record<string, unknown>>(
  data: T,
  values: Record<string, string>,
): T {
  if (Object.keys(values).length === 0) return data;
  return { ...data, ...values } as T;
}

/**
 * 取出某个节点**作为目标**的参数连线。
 *
 * 按 targetArg 去重：同一个参数被连了两条线时，
 * 后者覆盖前者会让"到底用的哪个"取决于边的顺序 ——
 * 而边的顺序在存档里是不保证的，表现为"偶尔取到另一个值"。
 * 所以一条参数只认第一条，多的在连线时就该拦掉。
 */
export function linksInto(links: ParamLink[], targetId: string): ParamLink[] {
  const seen = new Set<string>();
  const out: ParamLink[] = [];
  for (const l of links) {
    if (l.target !== targetId) continue;
    if (seen.has(l.targetArg)) continue;
    seen.add(l.targetArg);
    out.push(l);
  }
  return out;
}
