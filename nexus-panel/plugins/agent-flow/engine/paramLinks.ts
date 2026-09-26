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
import { constItemKey, constItemLabel, constsOf, type ConstNodeData } from '../types';
import { specOf } from './nodeSpec';
import { argExpectOf, type ArgTypeIssue, type ValueKind } from './argTypes';

/* ------------------------------------------------------------------ */
/* handle 约定                                                        */
/* ------------------------------------------------------------------ */

/**
 * 出口 handle 的 id。
 *
 * 参数连线从这个出口出发。节点右侧那个默认出口是流程出口，
 * 两者共用同一个 handle 的话，拖出来的线无法判断用户想连哪一种。
 */
export const OUT_HANDLE = 'out';

/**
 * 默认输出参数的 key。
 *
 * 一个节点可以有多个具名输出（见 outputsOf），但绝大多数只有一个 ——
 * 那个就是它，名字叫 'out'。
 */
export const OUT_DEFAULT = 'out';

/**
 * 输出参数 handle 的 id：out:输出key
 *
 * ================= 为什么输出也要具名 =================
 *
 * 以前只有节点右侧一个总出口（OUT_HANDLE），连线从它拖到某个参数格。
 * 单输出时够用，但一旦节点有**多个输出**（自定义输出参数、
 * 模块的多出口、一次算出好几个值），一个总出口就说不清
 * 这根线取的是哪一个 —— 而取错的表现是"值不对但不报错"。
 *
 * 对称地：输入侧早就已经是 arg:key（每个参数格一个入口）。
 * 输出侧不跟上，两端就不对等，"参数指向参数"也就无从谈起。
 */
export function outHandleId(key: string): string {
  return `out:${key}`;
}

/**
 * 从 handle id 反解输出 key。不是输出端口则返回 null。
 *
 * ================= 为什么裸 'out' 不算输出端口 =================
 *
 * 节点右侧那个总出口（OUT_HANDLE）是**流程出口**，本意是"我跑完接着跑你"。
 * 把它也算成输出端口的话，从它拖到某个参数格会被判成参数连线 ——
 * 一根流程线被画成紫虚线，用户以为只是取个值，实际下游多了一条执行路径。
 *
 * 所以输出参数必须走**输出卡片上的端口**（out:xxx），与流程出口分开。
 *
 * ================= 那升级前连好的线怎么办 =================
 *
 * 老存档的参数连线 sourceHandle 就是裸 'out'。它们靠
 * `data.kind === 'param'` 仍然被认成参数连线（见 isParamEdge / paramLinksOf），
 * 只是**画线**时 handle 对不上 —— 由 normalizeParamEdges 在渲染时补成
 * 'out:out'。判定与画线两条路分开，老线才不会变成废线。
 */
export function parseOutHandle(h: string | null | undefined): string | null {
  if (!h) return null;
  if (h === OUT_HANDLE) return null;
  return h.startsWith('out:') ? h.slice('out:'.length) : null;
}

/**
 * 把老参数连线的 handle 补成输出端口写法（渲染前用，不落盘）。
 *
 * 不改存档是刻意的：存进去就要考虑"改坏了怎么回退"，
 * 而这里要的只是"线能画在正确的口子上"。
 */
export function normalizeParamEdges<T extends GraphEdge>(edges: T[]): T[] {
  let changed = false;
  const out = edges.map((e) => {
    if (!isParamEdge(e)) return e;
    const d = e.data as Record<string, unknown> | undefined;
    const targetArg = typeof d?.targetArg === 'string' ? d.targetArg : null;
    if (!targetArg) return e;
    if (parseOutHandle(e.sourceHandle) !== null) return e;
    changed = true;
    const key = typeof d?.sourceArg === 'string' ? d.sourceArg : OUT_DEFAULT;
    return {
      ...e,
      sourceHandle: outHandleId(key),
      targetHandle: e.targetHandle ?? argHandleId(targetArg),
    };
  });
  return changed ? out : edges;
}

/**
 * 一个输出参数。
 *
 * ================= 为什么要具名 =================
 *
 * 一个节点跑完往往不止产出一个值：
 *
 *   更新检测 → 有没有更新 / 标题 / 链接 / 时间
 *   GitHub   → 提交号 / 分支 / 提交说明 / 作者
 *   表格读取 → 行数 / 列数 / 摘要
 *
 * 只有一个总出口的话，"把**标题**接到日志节点的文本上"做不到 ——
 * 只能整串输出一起接过去，然后在下游自己截。
 * 而截取规则写在模板里，改上游格式就失效，且不报错。
 *
 * 所以输出侧与输入侧对称：输入是 arg:key（一个参数一个入口），
 * 输出是 out:key（一个输出参数一个出口）。
 */
export type OutPort = {
  /** 输出参数的 key，连线上记的就是它（sourceArg） */
  key: string;
  /** 卡片上显示的名字。不写则直接用 key（多数字段名本身就是中文字） */
  label?: string;
  /**
   * 这个输出参数的值种类。不写则按 key 推：
   * 主输出走 producesArgOf（跟节点产出走），具名字段一律按文本。
   */
  kind?: ValueKind;
};

/** 输出参数在卡片上显示的名字 */
export function outLabel(p: OutPort): string {
  return p.label ?? p.key;
}

/**
 * 一个节点有哪些**输出参数**。
 *
 * 默认只有一个（OUT_DEFAULT）。有多输出的节点在这里按 kind 展开 ——
 * 这张表是"输出卡片上画几个出口"的唯一依据，
 * 散在组件里各写一份就会出现"卡片上有口子、连线却认不出来"。
 *
 * ================= 这张表与执行器的对账 =================
 *
 * 这里登记的具名字段，必须与对应 runner 实际写入的 fields 一致 ——
 * 写错一个字，表现是"卡片上有这个口子，连了线却取不到值"，
 * 而且**不报错**（取不到就保留手填值）。
 *
 * 所以 tests/outParams.test.ts 扫执行器源码做反向对账：
 * 这里多登记、或执行器少写一个，测试都会红。
 */
export const NODE_OUTPUTS: Record<string, OutPort[]> = {
  update: [
    { key: OUT_DEFAULT, label: '结论' },
    { key: 'updated', label: '是否有更新', kind: 'bool' },
    { key: 'title', label: '标题', kind: 'text' },
    { key: 'url', label: '链接', kind: 'text' },
    { key: 'date', label: '时间', kind: 'text' },
  ],
  'github-update': [
    { key: OUT_DEFAULT, label: '结论' },
    { key: 'sha', label: '提交号' },
    { key: 'branch', label: '分支' },
    { key: 'message', label: '提交说明' },
    { key: 'author', label: '作者' },
    { key: 'date', label: '时间' },
    { key: 'via', label: '来源' },
  ],
  'github-push': [
    { key: OUT_DEFAULT, label: '结论' },
    { key: 'commit', label: '提交号' },
    { key: 'via', label: '来源' },
  ],
  extract: [
    { key: OUT_DEFAULT, label: '结论' },
    { key: 'text', label: '内容' },
    { key: 'len', label: '字数', kind: 'num' },
  ],
  ocr: [
    { key: OUT_DEFAULT, label: '结论' },
    { key: 'text', label: '内容' },
    { key: 'chars', label: '字数', kind: 'num' },
  ],
  translate: [
    { key: OUT_DEFAULT, label: '结论' },
    { key: 'text', label: '译文' },
    { key: 'chars', label: '字数', kind: 'num' },
  ],
  tableRead: [
    { key: OUT_DEFAULT, label: '结论' },
    { key: '行数', kind: 'num' },
    { key: '列数', kind: 'num' },
    { key: '摘要' },
  ],
  agg: [
    { key: OUT_DEFAULT, label: '结论' },
    { key: '结果', kind: 'num' },
    { key: '列名' },
    { key: '方式' },
  ],
  filter: [
    { key: OUT_DEFAULT, label: '结论' },
    { key: '保留行数', kind: 'num' },
    { key: '摘要' },
  ],
  derive: [
    { key: OUT_DEFAULT, label: '结论' },
    { key: '行数', kind: 'num' },
    { key: '摘要' },
  ],
  canvasIn: [
    { key: OUT_DEFAULT, label: '结论' },
    { key: '端口' },
    { key: '说明' },
  ],
  canvasOut: [
    { key: OUT_DEFAULT, label: '结论' },
    { key: '端口' },
    { key: '说明' },
  ],
};

/**
 * 某个节点的输出参数清单。老数据 / 未登记的类型 → 单输出。
 *
 * ================= 常量是**动态**的 =================
 *
 * 常量节点上的卡由用户随时增删，端口数量跟着变 ——
 * 静态表写不出"现在有几张卡"，所以 const 走 data 现场算。
 * 只有一张卡时也照样给具名端口：多一个口子不会让人困惑
 * （标签写着卡名），而"有时有、有时没有"才会。
 */
export function outputsOf(
  dataKind: string | undefined | null,
  data?: Record<string, unknown> | null,
): OutPort[] {
  if (dataKind === 'const') {
    const items = constsOf(data as unknown as ConstNodeData);
    return [
      { key: OUT_DEFAULT, label: '结论' },
      ...items.map((it, i) => ({
        key: constItemKey(it, i),
        label: constItemLabel(it, i),
      })),
    ];
  }
  const list = dataKind ? NODE_OUTPUTS[dataKind] : undefined;
  return list && list.length > 0 ? list : [{ key: OUT_DEFAULT }];
}

/**
 * 某个**具体输出参数**的值种类。
 *
 * ================= 为什么不能一律按节点产出算 =================
 *
 * producesArgOf 回答的是"这个节点主输出是什么"（更新检测 → 是/否）。
 * 但同一节点上「标题」是文本、「字数」是数字 ——
 * 一律按主输出算，把"标题接到日志文本"标成错参，那是**误报**；
 * 反过来把"字数接到大于"漏过去，该报的不报。
 *
 * 两种方向都错，所以必须按**具体那一个输出**判。
 */
export function outKindOf(
  dataKind: string | undefined | null,
  key: string | undefined | null,
  data?: Record<string, unknown> | null,
): ValueKind {
  if (key && key !== OUT_DEFAULT) {
    const hit = outputsOf(dataKind, data).find((p) => p.key === key);
    /* 具名字段：登记了就按登记，没登记（自定义输出）一律按文本 */
    if (hit?.kind) return hit.kind;
    /*
     * 常量卡按**这张卡的种类**判：数字卡接到「大于」上合法、
     * 布尔卡接到条件判定上合法。一律按文本会让前者被误报成错参。
     */
    if (dataKind === 'const' && hit) {
      const items = constsOf(data as unknown as ConstNodeData);
      const it = items.find((x, i) => constItemKey(x, i) === key);
      return it?.valueType ?? 'text';
    }
    return 'text';
  }
  return producesArgOf(dataKind, data);
}

/**
 * 某个输出参数的名字（给报错文案用）。
 *
 * 报错里写「接的是上游 title（文本）」没人看得懂 ——
 * 用户见的是卡片上那行「标题」。
 */
export function outLabelOf(
  dataKind: string | undefined | null,
  key: string | undefined | null,
  data?: Record<string, unknown> | null,
): string {
  const ports = outputsOf(dataKind, data);
  const hit = key ? ports.find((p) => p.key === key) : undefined;
  return hit ? outLabel(hit) : (key ?? OUT_DEFAULT);
}

/**
 * 取来源节点**某个输出**的值。
 *
 * ================= 为什么具名输出要另走一条路 =================
 *
 * 主输出是 `outputs[id]`（一个字符串）；
 * 具名字段是执行器写进 `nodeFields[id]` 的那张表（{{id.标题}} 也读它）。
 * 两条路都走同一张表的话，"字数"这种附加信息会污染主输出。
 *
 * ================= 返回 null 的含义 =================
 *
 * null = **这个输出这次没有产出**（来源没跑到、或节点没写这个字段）。
 * 调用方必须据此**保留手填值**而不是填空串 ——
 * 填成空串的表现是"我明明填了值，连了线之后就没了"。
 */
export function outValueOf(
  sourceArg: string | undefined,
  output: string,
  fields: Record<string, string> | undefined,
): string | null {
  const key = sourceArg && sourceArg !== OUT_DEFAULT ? sourceArg : null;
  if (key === null) return output;
  const v = fields?.[key];
  return typeof v === 'string' ? v : null;
}

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

/**
 * sourceHandle / targetHandle 是否构成一条参数连线。
 *
 * 现在是**参数指向参数**：源端必须是某个输出端口（out:xxx），
 * 目标端必须是某个参数入口（arg:xxx）。
 */
export function isParamHandles(
  sourceHandle: string | null | undefined,
  targetHandle: string | null | undefined,
): boolean {
  return parseOutHandle(sourceHandle) !== null && parseArgHandle(targetHandle) !== null;
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
  /**
   * 取来源节点的**哪个输出**。缺省 = 默认输出。
   *
   * 多输出节点必须记它：不记的话两根线（一个取 result、一个取 count）
   * 长得一样，而"取到的是哪一个"取决于边的顺序 —— 顺序在存档里不保证。
   */
  sourceArg?: string;
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
    /*
     * sourceArg 也能从 sourceHandle 上读出来 —— 老存档的 handle 是
     * 'out' 或 'out:xxx'，data 里没有 sourceArg。
     * 两个来源都要认，否则升级前的线会取不到值。
     */
    const sourceArg = typeof d?.sourceArg === 'string'
      ? d.sourceArg
      : (parseOutHandle(e.sourceHandle) ?? undefined);
    out.push({
      id: e.id, source: e.source, target: e.target, targetArg, sourceArg,
    });
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
  sourceArg?: string,
): GraphEdge {
  return {
    id: `p:${source}->${target}:${targetArg}`,
    source,
    target,
    /*
     * 源端写明是哪个输出端口。
     *
     * 不写的话，多输出节点的两根线长一样，取哪个取决于边的顺序。
     * 单输出节点也统一带上 —— 省掉"什么时候有、什么时候没有"的判断。
     */
    sourceHandle: outHandleId(sourceArg ?? OUT_DEFAULT),
    targetHandle: argHandleId(targetArg),
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
    /*
     * sourceArg 同时写进 data 与 sourceHandle。
     *
     * 写两处不是冗余：handle 是 React Flow 画线要用的（决定线从哪个口子出来），
     * data 是**存档**里唯一跟着边走的东西。
     * 只写 handle 的话，某些路径（模块打包、导出导入）重建边时可能丢 handle，
     * 而丢掉的表现是"线还在但取不到值"。
     */
    data: { kind: 'param', targetArg, sourceArg: sourceArg ?? OUT_DEFAULT } as unknown as GraphEdge['data'],
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
export function producesArgOf(
  dataKind: string | undefined | null,
  data?: Record<string, unknown> | null,
): ValueKind {
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
    /*
     * 常量：**按第一张卡的种类**产出。
     *
     * 三种常量 dataKind 都是 'const'，产出的值种类却不同
     * （数字常量出 num、布尔常量出 bool）—— 不读种类的话
     * 数字常量接到「大于」上会被当成文本，报不该报的「错参」。
     *
     * 读的是 items[0]：主输出就是第一张卡，两者必须一致。
     * 具体某一张卡走 outKindOf（按卡 id 找）。
     */
    case 'const': {
      const items = constsOf(data as unknown as ConstNodeData);
      const vt = String(items[0]?.valueType ?? 'text');
      if (vt === 'num') return 'num';
      if (vt === 'bool') return 'bool';
      return 'text';
    }
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

    /*
     * 按**这一根线取的是哪个输出**判，而不是按节点主输出。
     *
     * 更新检测的主输出是「是/否」，但它的「标题」是文本 ——
     * 一律按主输出算，把"标题接到日志文本"判成错参就是误报。
     */
    const srcKind = (srcData?.kind as string | undefined) ?? null;
    const actual = outKindOf(srcKind, link.sourceArg, srcData);
    // unknown = 上游产出看不出来（mark / any / none），不在这报
    if (actual === 'unknown' || actual === 'any') continue;

    if (actual === expect) continue;

    const what = link.sourceArg && link.sourceArg !== OUT_DEFAULT
      ? `上游「${outLabelOf(srcKind, link.sourceArg, srcData)}」`
      : '上游输出';

    (out[link.target] ??= []).push({
      key: link.targetArg,
      expect,
      actual,
      message: `「${link.targetArg}」接的是${what}（${valueKindLabel(actual)}），但这里要${valueKindLabel(expect)}`,
    });
  }
  return out;
}

/**
 * 值种类的人话名字。
 *
 * 输出卡片上显示的就是它 —— 卡片上要写"数字"而不是 PortKind 里的"文本"，
 * 因为参数连线按**值种类**校验（见 producesArgOf），
 * 写 PortKind 会让"数字常量"在卡片上显示成"文本"。
 */
export function valueKindLabel(v: ValueKind): string {
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
