/**
 * 把整张画布导出成脚本 / 说明 —— 画布级的全局功能。
 *
 * ================= 为什么要有这个 =================
 *
 * 画布是"搭"出来的，但有些场合要"跑"的东西是一份文件：
 *   · 交给 cron / 系统定时任务
 *   · 交给不会用这个界面的人
 *   · 交给 AI 读，让它理解这段流程在做什么
 *
 * 四种格式各有用途，所以都生成，不做单选。
 *
 * ================= 不可翻译的部分必须显式 =================
 *
 * 画布能表达的东西比脚本多：条件分支、循环、并发、MCP 调用……
 * 遇到翻译不了的地方，**写成注释并标注「未能翻译」**，绝不静默跳过。
 *
 * 静默跳过的后果是：用户拿到一份脚本，跑起来"少了点什么"，
 * 而没有任何线索告诉他少了什么、为什么少。
 * 宁可生成一份带 TODO 注释的脚本，也不要生成一份看起来完整其实是错的。
 */

import type { Graph, GraphNode } from '../types';
import { constsOf, constItemLabel, constItemKey, type ConstNodeData } from '../types';
import { topoLayers } from './topo';
import { tokenRe } from './template';
import { opBrief } from './ops';
import { paramLinksOf, linksInto, outLabelOf, outputsOf, OUT_DEFAULT } from './paramLinks';
import { findPane, resolveApiPane, DEFAULT_TEMPERATURE } from './pane';
import { loopBodyOf, unescapeSeparator } from './loop';

export type ExportFormat = 'shell' | 'python' | 'json' | 'markdown';

export const EXPORT_FORMATS: { id: ExportFormat; label: string; ext: string; desc: string }[] = [
  { id: 'shell', label: 'Shell 脚本', ext: 'sh', desc: '能直接跑，适合定时任务' },
  { id: 'python', label: 'Python 脚本', ext: 'py', desc: '可读性与扩展性更好' },
  { id: 'json', label: '流程 JSON', ext: 'json', desc: '可在另一个环境导入重放' },
  { id: 'markdown', label: 'Markdown 说明', ext: 'md', desc: '给人或 AI 读的步骤说明' },
];

/** 未被翻译的节点 —— 调用方要把它显示给用户 */
export type Skipped = { id: string; kind: string; reason: string };

export type ExportResult = {
  text: string;
  skipped: Skipped[];
  /** 参与生成的节点数 */
  count: number;
};

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

const str = (v: unknown): string => (v == null ? '' : String(v));
const num = (v: unknown, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

/** Shell 单引号转义：把 ' 换成 '\'' */
const shq = (s: string): string => `'${s.split("'").join("'\\''")}'`;

/** Python 字符串字面量（双引号 + 转义） */
const pyq = (s: string): string => JSON.stringify(s);

/*
 * 变量命名 —— **生成处与引用处必须用同一套规则**。
 *
 * 第一版踩过：生成时叫 `out_e1`，模板 `{{e1.output}}` 却展开成
 * `out_e1_output`，于是脚本里引用了一个不存在的变量。
 * 这种错不报语法错，只在运行时取到空值 —— 最难查的一类。
 */
const shVar = (id: string): string =>
  `OUT_${String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
const pyVar = (id: string): string =>
  `out_${String(id).toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

/**
 * 把模板 {{x.output}} 换成脚本里的变量引用。
 *
 * shell 返回**裸内容**（不加引号，调用方按需包 "…"）；
 * python 返回**带引号的表达式**（"…" 或 f"…"），因为 python 里
 * 字符串字面量必须有引号，而 URL 漏引号会直接语法错误。
 */
/**
 * 常量卡的**引用表**：`节点id.卡名` → 该卡的键（连线键，即卡 id）。
 *
 * ================= 为什么必须单独建这张表 =================
 *
 * 常量多卡之后，下游引用的写法是 `{{c1.价格}}`（执行器按卡名往 fields 里
 * 再写一份，模板要人能读懂的名字）。而 subst 原来的逻辑是
 * 「按**节点**展开」—— `{{c1.价格}}` 会被换成 `$OUT_C1`，
 * 也就是**第一张卡**的值。
 *
 * 不报错、脚本看着完全正常，只是取到的是另一张卡的值。
 * 这比"取不到"难查得多：取不到会留下 `{{}}` 的痕迹，取错什么痕迹都没有。
 *
 * 值存**卡的键**（id）而不是卡名：卡名由用户随时改，且可能是中文——
 * 中文进 shVar 会被洗成 `_`，两张卡都变成 `OUT_C1__`，变量名直接撞车。
 * 卡的键是稳定的 ASCII（建卡时生成），不会撞。
 */
/**
 * 图里所有**具名输出**的引用集合：`节点id.字段名`。
 *
 * ================= 为什么要单独收这张表 =================
 *
 * subst 对 `{{id.字段}}` 一律塌成 `OUT_ID`（整个节点的输出）。
 * 对卡片上的常量那是对的（已由 constCardRefs 单独指向那张卡），
 * 但对其余节点是**静默取错值**：
 *
 *   {{h1.status}}  状态码
 *   {{h1.ok}}      是否成功
 *   {{h1.len}}     响应长度
 *   {{h1.out}}     响应体
 *
 * 四个完全不同的引用，导出后**全变成 $OUT_H1**。
 * 脚本能跑、看着完整，只是值是错的 —— 比拼不出变量难查得多，
 * 因为拼不出会留下 {{}} 的痕迹，取错了什么痕迹都没有。
 *
 * 脚本里拿不到这些字段（curl 一行拿不到状态码、CLI 改了哪些文件
 * 只有跑完才知道），所以这里选择**保留字面量并记进 skipped**，
 * 而不是继续塌成整个输出 —— 塌过去是"能跑但错"，留下来是"看得见"。
 */
export function namedOutRefs(g: Graph): Set<string> {
  const out = new Set<string>();
  for (const n of g.nodes ?? []) {
    const d = (n.data ?? {}) as Record<string, unknown>;
    const kind = str(d.kind ?? (n as { type?: string }).type);
    // 与 outFieldsOf 同一份定义：主输出（OUT_DEFAULT）不算具名字段
    for (const port of outputsOf(kind, d)) {
      if (port.key === OUT_DEFAULT) continue;
      out.add(`${n.id}.${port.key}`);
    }
  }
  return out;
}

export function constCardRefs(g: Graph): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of g.nodes ?? []) {
    const d = (n.data ?? {}) as Record<string, unknown>;
    if (str(d.kind ?? (n as { type?: string }).type) !== 'const') continue;
    constsOf(d as unknown as ConstNodeData).forEach((it, i) => {
      const key = constItemKey(it, i);
      const name = constItemLabel(it, i);
      if (!name) return;
      out.set(`${n.id}.${name}`, key);
    });
  }
  return out;
}

/**
 * 大模型节点**挂了窗格之后**真正生效的配置表：节点 id → 生效值。
 *
 * ================= 为什么必须单独算这张表 =================
 *
 * 窗格的规矩是「节点没填的项从窗格继承」（见 pane.ts 的注释）。
 * 而导出脚本读的是节点自己的 data —— 于是模型名、system 提示词、
 * 温度全配在窗格上时，导出的脚本里 `model=""`。
 *
 * 不报错、脚本看着完整、也跑得起来，只是**用错了模型**。
 * 这比拼不出变量更难查：拼不出会留下痕迹，用错了什么痕迹都没有。
 *
 * ================= 为什么不在这里重写一遍继承规则 =================
 *
 * 直接调 pane.ts 的 resolveApiPane。
 * 继承规则（尤其是 temperature 的三级回落、yolo 取 OR）抄一份到导出侧，
 * 改规则时漏改就是"画布上跑一个样、导出成脚本另一个样"，
 * 而两份都不会报错。
 */
export function llmPaneEffOf(
  g: Graph,
): Map<string, ReturnType<typeof resolveApiPane>> {
  const out = new Map<string, ReturnType<typeof resolveApiPane>>();
  for (const n of g.nodes ?? []) {
    const d = (n.data ?? {}) as Record<string, unknown>;
    if (str(d.kind ?? (n as { type?: string }).type) !== 'llmChat') continue;
    const paneId = str(d.paneId ?? '');
    if (!paneId) continue;
    const pane = findPane(g.nodes ?? [], paneId);
    // 窗格被删了而 paneId 还在时按没有窗格处理（与运行时一致，见 pane.ts）
    out.set(n.id, resolveApiPane(d as never, pane));
  }
  return out;
}

/**
 * 引用里"脚本这一侧没有对应物"的那几类。
 *
 * ================= 为什么不能静默给个变量名 =================
 *
 * {{params.X}} / {{env.X}}（画布参数）的值**不在图数据里** —— 它们存在
 * 画布配置上，而 export 只拿到 nodes + edges（Graph 类型就没有 params 字段）。
 * {{loop.*}} 同理：循环结构本身就没法翻译成脚本（见下面 toShell 的说明）。
 *
 * 以前这两类与 input 一起被拼成 `INPUT_XXX`：
 *   · shell → `$INPUT_XXX` 从未定义，`set -u` 下直接退出
 *   · python → `input_xxx` 未定义，NameError
 * 而 {{input}} 更糟：它拼出的是 **`input`** —— python 的内建函数，
 * `f"{input}"` 渲染成 `<built-in function input>`，**不报错、值永远错**。
 *
 * 所以与运行时（template.ts）保持同一口径：解析不了就**保留 {{原样}}**，
 * 让人一眼看出这里没接上；同时回调通知调用方，记进 skipped 让界面也提示。
 */
const UNRESOLVABLE_REF = new Set(['params', 'env', 'loop']);

/**
 * 引用取不到时记进 skipped 的理由。
 *
 * 具名输出与画布参数是**两种不同的取不到**，理由必须分开写：
 * 混成一句的话，用户看到"脚本里请自行补上"会以为是参数没配，
 * 而实际是"这个字段脚本里根本没有，得换个写法"。
 */
function refReason(path: string): string {
  const tpl = `{{${path}}}`;
  const id = String(path).split('.')[0];
  if (UNRESOLVABLE_REF.has(id)) {
    return `引用了 ${tpl} —— 画布参数/循环变量不在图数据里，脚本里请自行补上`;
  }
  return `引用了 ${tpl} —— 这是个具名输出字段，脚本里取不到（塌成整个节点的输出会取错值），已原样保留`;
}

function subst(
  tpl: string,
  style: 'sh' | 'py',
  cardRef?: Map<string, string>,
  onUnresolved?: (key: string) => void,
  namedOut?: Set<string>,
  loopRef?: Record<string, string> | null,
): string {
  const raw = String(tpl ?? '');
  if (!raw) return style === 'sh' ? '' : '""';

  let hasRef = false;
  // 先把引用收出来，避免后面的引号转义把它们弄坏
  const slots: string[] = [];
  /*
   * 字符集直接取 template.ts 的 tokenRe() —— 不再自己写一份。
   *
   * 以前这里是 `[A-Za-z0-9_.]`，不含中文 —— 而常量卡的默认名是
   * 「文本1」「数字2」这类中文（用户不改名时就是它）。
   * 于是 `{{c1.价格}}` **整段匹配不上**，原样留在脚本里。
   * 运行时用的是另一份正则（支持中文），能取到值 ——
   * 于是"画布上跑是对的、导出成脚本就变成字面量 {{c1.价格}}"，
   * 没有任何报错，只有结果不对。
   */
  const body = raw.replace(tokenRe(), (_m, path: string) => {
    const parts = String(path).split('.');
    const id = parts[0];
    hasRef = true;

    /*
     * 常量卡：指向**那一张卡**自己的变量，不是整个节点的变量。
     * 变量名用卡的键（稳定、ASCII），见 constCardRefs。
     */
    if (cardRef && parts.length > 1) {
      const cardKey = cardRef.get(String(path));
      if (cardKey) {
        const cv = style === 'sh'
          ? `$${shVar(id)}_${shVar(cardKey).replace(/^OUT_/, '')}`
          : `${pyVar(id)}_${pyVar(cardKey).replace(/^out_/, '')}`;
        slots.push(cv);
        return `\u0000${slots.length - 1}\u0000`;
      }
    }

    /*
     * 全局输入：脚本里真有这个变量（shell 的 $INPUT_TEXT / python 的 input_text）。
     *
     * {{input}} 与 {{input.output}} 是同一个东西 ——
     * template.ts 里 nodeId==='input' 时不看 field，一律返回 ctx.input。
     * 所以这里也**不拼 rest**，两种写法都指向同一个变量。
     * 以前 {{input.output}} 被拼成 INPUT_OUTPUT（从未定义），
     * {{input}} 被拼成 python 的 input（内建函数）—— 见 UNRESOLVABLE_REF 的说明。
     */
    if (id === 'input') {
      slots.push(style === 'sh' ? '$INPUT_TEXT' : 'input_text');
      return `\u0000${slots.length - 1}\u0000`;
    }
    /*
     * 循环变量：在循环体内能翻成脚本里的真变量。
     * 放在 UNRESOLVABLE_REF 之前 —— 那一支会把它当成"取不到"留下字面量，
     * 而脚本里其实有对应的变量，留字面量等于白做。
     */
    if (loopRef && loopRef[String(path)]) {
      // shell 要的是 `$名` 这个字符串内容，与上面 OUT_ID 同一口径
      slots.push(style === 'sh' ? `$${loopRef[String(path)]}` : loopRef[String(path)]);
      return `\u0000${slots.length - 1}\u0000`;
    }
    if (UNRESOLVABLE_REF.has(id)) {
      onUnresolved?.(String(path));
      return `{{${path}}}`;
    }
    /*
     * 具名输出：脚本里取不到，保留字面量并记账。
     * 见 namedOutRefs —— 塌成 OUT_ID 是"能跑但值错"。
     */
    if (namedOut && namedOut.has(String(path))) {
      onUnresolved?.(String(path));
      return `{{${path}}}`;
    }
    else {
      /*
       * shell 里要的是 `$OUT_E1` 这个**字符串内容**（后面会被拼进
       * 别的引号里），不是 JS 变量插值 —— 写成模板串 `${...}`
       * 会在 JS 层就被求值，生成出莫名其妙的东西。
       */
      slots.push(style === 'sh' ? `$${shVar(id)}` : pyVar(id));
    }
    return `\u0000${slots.length - 1}\u0000`;
  });

  if (style === 'sh') {
    let out = body;
    for (let i = 0; i < slots.length; i += 1) {
      out = out.split(`\u0000${i}\u0000`).join(slots[i]);
    }
    return out;
  }

  /*
   * python：字面量部分要转义，引用部分拼进 f-string。
   *
   * 花括号也要翻倍 —— f-string 里 `{{` 才渲染出一个 `{`。
   * 不翻倍的话，上面保留下来的 `{{params.X}}` 会被 f-string 吃掉一层，
   * 变成 `{params.X}`：看着还像占位符，但**与运行时留下的痕迹不一样**，
   * 用户照着去搜 `{{params.X}}` 搜不到。
   *
   * 顺带把用户自己写的 `{` 也一并修对了 —— 以前它没被转义，
   * 生成的是 `f"a{b"` 这种语法错 / 静默吞字的脚本。
   */
  let out = body.split('"').join('\\"');
  /*
   * 只在真的要生成 f-string 时才翻倍 ——
   * 没有引用时输出的是普通 `"..."`，那里的 `{` 就是字面量，翻了反而错。
   */
  if (hasRef) out = out.split('{').join('{{').split('}').join('}}');
  for (let i = 0; i < slots.length; i += 1) {
    out = out.split(`\u0000${i}\u0000`).join(`{${slots[i]}}`);
  }
  return hasRef ? `f"${out}"` : `"${out}"`;
}

/** JSON 路径 data.items.0.title → 真正的取值表达式 */
function jsonPathExpr(path: string, style: 'sh' | 'py'): string {
  const segs = String(path ?? '').split('.').filter((x) => x !== '');
  if (segs.length === 0) return style === 'sh' ? 'd' : 'cur';
  if (style === 'py') {
    /*
     * 纯数字段当下标 —— 用 .0 会变成属性访问，取不到列表元素，
     * 而且不报错（返回 undefined 才怪，python 里是 AttributeError 才对，
     * 但混在 json 里常常被 try 吞掉）。
     */
    return segs
      .map((sg) => (/^\d+$/.test(sg) ? `[${sg}]` : `[${JSON.stringify(sg)}]`))
      .join('');
  }
  const chain = segs
    .map((sg) => (/^\d+$/.test(sg) ? `[${sg}]` : `[${JSON.stringify(sg)}]`))
    .join('');
  return `d${chain}`;
}


/*
 * 参数连线在脚本里的**显式说明**。
 *
 * 画布上跑时，参数连线把来源节点的 output 填进目标参数；
 * 而脚本里这一行取的是**节点上手填的值** —— 只有产出值的少数节点
 * （常量、时钟、提取…）会赋给一个变量，多数节点（日志、等待、HTTP…）
 * 根本没有对应的变量可供引用，翻译不过去。
 *
 * 所以按本文件自己的原则：翻译不了就写成注释标出来，绝不静默。
 * 不标的话用户会拿到一份"能跑、但值和画布上不一样"的脚本，
 * 而没有任何线索 —— 那正是本文件开头批判的那件事。
 */
function paramLinkNoteOf(
  g: Graph,
  nodeId: string,
  prefix: string,
): string[] {
  const links = linksInto(paramLinksOf(g.edges), nodeId);
  if (links.length === 0) return [];
  return links.map((l) => {
    const src = g.nodes.find((x) => x.id === l.source);
    const srcName = str((src?.data as Record<string, unknown> | undefined)?.label
      ?? (src?.data as Record<string, unknown> | undefined)?.name) || l.source;
    /*
     * 具名输出要指名是哪一个。
     *
     * 只写"来自「更新检测」的输出"，而它其实接的是「标题」——
     * 拿着脚本去对照画布时会对不上，那正是这段注释要避免的事。
     */
    const srcKind = str((src?.data as Record<string, unknown> | undefined)?.kind) || undefined;
    const srcRec = src?.data as Record<string, unknown> | undefined;
    const what = l.sourceArg && l.sourceArg !== OUT_DEFAULT
      ? `的「${outLabelOf(srcKind, l.sourceArg, srcRec)}」`
      : '的输出';
    return `${prefix}注意：参数「${l.targetArg}」在画布上来自「${srcName}」${what}，`
      + `这里取的是节点上填的值 —— 两者可能不同`;
  });
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

/**
 * 汇合节点在脚本里的拼接。
 *
 * 画布上 join 的输出是**各上游输出按分隔符拼起来、跳过空串**（见
 * runners/join.ts）。这是**能算出来的** —— 上一轮却被归到"算不出来
 * 留空"，于是 `{{j1.output}}` 恒为空，汇合下游全线空值。
 *
 * 空串跳过这条是刻意的：条件/并发分支里没走的那条，画布上 outputs
 * 里没它（取空串）、脚本里变量是 ""（上一轮已初始化），两边都跳过它。
 */
function joinPartsOf(
  n: GraphNode,
  skipped: Skipped[],
  ups: string[],
): { sep: string; strict: boolean } {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const strict = str(d.mode) === 'strict';
  if (strict) {
    /*
     * 严格模式是"缺一条输入就整条失败"。脚本里所有变量都有定义，
     * 判不出"缺没缺" —— 硬翻只会变成"看着翻了、其实没校验"。
     */
    skipped.push({
      id: n.id,
      kind: 'join',
      reason: '严格汇合（缺一条输入就失败）在脚本里不翻 —— 脚本里变量都有定义，判不出「缺失」',
    });
  }
  return { sep: unescapeSeparator(str(d.joinBy ?? '\\n')), strict };
}

/**
 * shell 里的分隔符字面量。
 *
 * 含换行/制表符时不能用单引号直接包 —— 真实控制字符会**把这一行撑成
 * 两行**，生成的脚本看着是断的（虽然 bash 仍能跑）。
 * 用 ANSI-C 引用（$'\\n'）让它保持在一行里，人也读得懂。
 */
function shSepSep(sep: string): string {
  if (/^[\x20-\x7e]*$/.test(sep)) return shq(sep);
  return "$'" + sep
    .split('\\').join('\\\\')
    .split("'").join("\\'")
    .split('\n').join('\\n')
    .split('\t').join('\\t')
    .split('\r').join('\\r') + "'";
}

function shellJoinOf(n: GraphNode, skipped: Skipped[], ups: string[]): string | null {
  const { sep } = joinPartsOf(n, skipped, ups);
  const me = shVar(n.id);
  if (ups.length === 0) return `${me}=""   # ${n.id}: 汇合（没有输入）`;
  if (ups.length === 1) return `${me}=${'$'}${shVar(ups[0])}   # ${n.id}: 汇合`;
  const qsep = shSepSep(sep);
  return [
    `${me}=""`,
    `for _v in ${ups.map((u) => `"${'$'}${shVar(u)}"`).join(' ')}; do`,
    `  [ -n "$_v" ] || continue`,
    `  if [ -z "${'$'}${me}" ]; then ${me}="$_v"; else ${me}="${'$'}${me}"${qsep}"$_v"; fi`,
    `done   # ${n.id}: 汇合（跳过空串）`,
  ].join('\n');
}

function pyJoinOf(n: GraphNode, skipped: Skipped[], indent: string, ups: string[]): string | null {
  const { sep } = joinPartsOf(n, skipped, ups);
  const me = pyVar(n.id);
  if (ups.length === 0) return `${indent}${me} = ""   # ${n.id}: 汇合（没有输入）`;
  if (ups.length === 1) return `${indent}${me} = ${pyVar(ups[0])}   # ${n.id}: 汇合`;
  const list = ups.map((u) => pyVar(u)).join(', ');
  return `${indent}${me} = ${pyq(sep)}.join([_v for _v in [${list}] if _v != ""])   # ${n.id}: 汇合（跳过空串）`;
}

function shellLine(
  n: GraphNode,
  skipped: Skipped[],
  cardRef?: Map<string, string>,
  namedOut?: Set<string>,
  loopRef?: Record<string, string> | null,
  ups: string[] = [],
): string | null {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const kind = str(d.kind ?? d.type);
  const v = (k: string) => subst(str(d[k]), 'sh', cardRef, (key) => {
    skipped.push({ id: n.id, kind, reason: refReason(key) });
  }, namedOut, loopRef);
  const me = shVar(n.id);

  switch (kind) {
    case 'join': return shellJoinOf(n, skipped, ups);
    case 'wait': {
      const ms = num(d.ms, 1000);
      return `sleep ${(ms / 1000).toFixed(3)}   # ${n.id}: 等待 ${ms}ms`;
    }
    case 'log': {
      const lv = str(d.level || 'info');
      const tag = lv === 'error' ? '[ERR] ' : lv === 'warn' ? '[WARN] ' : '';
      // 整句用双引号包住，内部的 " 要转义，否则引号一多就断
      const body = v('text').split('"').join('\\"');
      return `echo "${tag}${body}"   # ${n.id}`;
    }
    case 'const': {
      /*
       * 每张卡各导出一个变量：`OUT_ID` 是第一张（整节点的默认引用），
       * `OUT_ID_卡键` 是那一张卡 —— 下游写 `{{id.卡名}}` 时指向后者。
       *
       * ================= 为什么不再"只导第一张" =================
       *
       * 以前这里只写 `OUT_ID` 并往 skipped 里记一句"导出不全"。
       * 但 downstream 引用 `{{id.卡名}}` 时会被 subst 换成 `OUT_ID`，
       * 也就是**第一张卡**的值 —— 不报错、脚本看着正常，只是值错了。
       * 记一句 skipped 挡不住这个（用户不会把 skipped 和值错联系起来）。
       *
       * 卡的值里可能还含 {{env.X}} 之类，所以仍要过一遍 subst；
       * 但**不能**带 cardRef —— 常量卡的值引用另一张卡没有意义，
       * 传进去反而可能自引用到还没定义的变量。
       */
      const cards = constsOf(n.data as unknown as ConstNodeData);
      const lines: string[] = [];
      cards.forEach((it, i) => {
        const cardVar = `${me}_${shVar(constItemKey(it, i)).replace(/^OUT_/, '')}`;
        lines.push(`${cardVar}=${shq(subst(str(it.value ?? ''), 'sh'))}`
          + `   # ${n.id} 的卡「${constItemLabel(it, i)}」`);
        // 第一张同时是整节点的默认引用（{{id}} 不带卡名时取它）
        if (i === 0) lines.push(`${me}=$${cardVar}   # ${n.id}: 常量（默认取第一张）`);
      });
      if (lines.length === 0) return null;
      return lines.join('\n');
    }
    case 'clock':
      return `${me}=$(date ${shq(v('format') || '+%Y-%m-%d %H:%M:%S')})   # ${n.id}: 当前时间`;
    case 'extract': {
      const mode = str(d.mode || 'json');
      if (mode === 'json') {
        const expr = jsonPathExpr(str(d.path), 'sh');
        return `${me}=$(echo "$OUT_INPUT" | python3 -c ${shq(`import json,sys;d=json.load(sys.stdin);print(${expr})`)} )   # ${n.id}: 提取 ${str(d.path)}`;
      }
      skipped.push({ id: n.id, kind, reason: `提取模式 ${mode} 无法用 shell 一行表达` });
      return null;
    }
    case 'generic-http': {
      const url = v('url');
      const method = str(d.method || 'GET').toUpperCase();
      const body = str(d.body) ? ` --data ${shq(v('body'))}` : '';
      return `${me}=$(curl -sS -X ${method}${body} "${url}")   # ${n.id}: HTTP ${method}`;
    }
    /*
     * 大模型节点：shell 里不生成。
     *
     * 请求体是一坨嵌套 JSON，用单引号包 python -c 那一套
     * （见 extract 的做法）在提示词里出现引号时就会断 ——
     * 生成的脚本看着完整，跑起来是语法错。
     *
     * 这里明确说"用 python 版"，而不是落到 default 那句
     * "这类节点没有对应的 shell 写法"：后者让人以为这个功能没做，
     * 而实际情况是**有对应写法，只是不在 shell 里**。
     */
    case 'llmChat':
      skipped.push({
        id: n.id, kind,
        reason: '调用大模型需要拼嵌套 JSON 请求体，shell 一行表达不安全 —— 请导出 python 版',
      });
      return null;
    default:
      skipped.push({ id: n.id, kind, reason: '这类节点没有对应的 shell 写法' });
      return null;
  }
}

/**
 * 图里每个循环节点的**循环体成员**（loop id → 成员 id）。
 *
 * 直接复用 engine/loop.ts 的 loopBodyOf ——
 * 导出侧自己判一遍的话，"哪些节点算循环体"就会出现两套说法：
 * 画布上跑 3 个节点、脚本里循环包了 2 个，两边都不报错。
 */
export function loopBodiesOf(g: Graph): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const n of g.nodes ?? []) {
    const d = (n.data ?? {}) as Record<string, unknown>;
    if (str(d.kind ?? (n as { type?: string }).type) !== 'loop') continue;
    out.set(n.id, loopBodyOf(n.id, g));
  }
  return out;
}

/**
 * 循环变量在脚本里的名字：`{{loop.item}}` → 该循环的变量。
 *
 * 变量名带循环 id —— 嵌套循环时内外层各用各的，
 * 都叫 loop_item 的话内层会把外层的覆盖掉，
 * 表现为"外层循环第二轮开始拿到的都是内层的最后一轮"。
 */
function loopVarNames(id: string, style: 'sh' | 'py'): Record<string, string> {
  const k = style === 'sh' ? shVar(id) : pyVar(id);
  return {
    'loop.item': style === 'sh' ? `${k}_ITEM` : `${k}_item`,
    'loop.index': style === 'sh' ? `${k}_INDEX` : `${k}_index`,
    'loop.count': style === 'sh' ? `${k}_COUNT` : `${k}_count`,
  };
}

/**
 * 这个循环能不能翻译成脚本里的真循环。
 *
 * ================= 为什么只有 times 能翻 =================
 *
 * list 要按分隔符切上游输出、glob 要靠 Rust 展开通配符 ——
 * 这两样在脚本里都得重写一遍切分/展开规则，
 * 而重写的结果就是"画布上切出 5 项、脚本里切出 4 项"，
 * 没有报错，只有轮数不对。那正是这里要防的东西。
 *
 * 所以只能翻 times（次数写死在节点上，脚本里原样用），
 * 其余模式退回平铺并明说"脚本里只跑一次"。
 */
function loopFixedTimes(d: Record<string, unknown>): number {
  if (str(d.mode || 'times') !== 'times') return 0;
  const t = Math.floor(Number(d.times ?? 0));
  return Number.isFinite(t) && t >= 1 ? t : 0;
}

/* ------------------------------------------------------------------ */
/* 条件分支                                                           */
/* ------------------------------------------------------------------ */

/**
 * 给条件表达式用的替换：取不到就**保留 {{原样}}**，
 * 由调用方据此判定"翻不了"。
 *
 * 不能把 unresolved 丢掉：条件里引用的东西取不到时，
 * 生成 `out_xxx` 就是个未定义变量，跑起来 NameError，
 * 而留 {{}} 至少让人一眼看出这里没接上。
 */
function pysubst(
  t: string,
  cardRef?: Map<string, string>,
  namedOut?: Set<string>,
  loopRef?: Record<string, string> | null,
): string {
  return subst(t, 'py', cardRef, () => {}, namedOut, loopRef);
}

/**
 * output 就是"上游原样透传"的那些节点。
 *
 * 之所以列出来：这些节点在画布上**有输出**（下游可以引用），
 * 但脚本里它们大多只有一行动作（print / sleep / 播放），
 * 从没为 `out_xx` 赋过值 —— 下游写 `{{xx.output}}` 就拿一个
 * **从未定义过的变量**，跑起来 NameError。
 *
 * 判据见 tests：表里的每一项，其 runner 必须真的读上游并返回。
 */
const PASSTHROUGH_KINDS = new Set([
  'log', 'beep', 'playAudio', 'wait', 'retry', 'throttle', 'timeout', 'gate',
]);

/**
 * 上游拼接的赋值行（与画布上的 upstreamText 同一口径）。
 */function passAssignOf(
  g: Graph,
  id: string,
  style: 'sh' | 'py',
): string {
  const ups = (g.edges ?? []).filter((e) => e.target === id).map((e) => e.source);
  const nm = (x: string) => (style === 'sh' ? shVar(x) : pyVar(x));
  if (ups.length === 0) {
    return style === 'sh'
      ? `${nm(id)}=$INPUT_TEXT`
      : `${nm(id)} = input_text`;
  }
  if (ups.length === 1) {
    return style === 'sh'
      ? `${nm(id)}=${'$'}${nm(ups[0])}`
      : `${nm(id)} = ${nm(ups[0])}`;
  }
  const joined = ups.map((u) => (style === 'sh' ? `"${'$'}${nm(u)}"` : nm(u)));
  return style === 'sh'
    ? `${nm(id)}="$(printf '%s\\n%s' ${joined.join(' ')})"`
    : `${nm(id)} = "\\n".join([${joined.join(', ')}])`;
}

/**
 * 给"脚本里没有产出"的节点补的赋值行。
 *
 * 不补的话，下游 `{{xx.output}}` 就是一个从未定义过的变量 ——
 * python 里 NameError、shell 里空值，脚本直接崩或静默出错，
 * 而这恰恰是最难发现的那一类：脚本看着完整，一运行才炸。
 *
 * 两种值，差别是刻意的：
 * · 确认透传的 → 上游拼接（与画布同一口径）
 * · 其余       → 空串 + 注释，**不拿上游顶替**
 *   顶替 = 能跑但值不对（比如数学节点的输出是算出来的，不是上游原文）
 */
function assignLineOf(g: Graph, id: string, kind: string, style: 'sh' | 'py'): string {
  if (PASSTHROUGH_KINDS.has(kind)) return passAssignOf(g, id, style);
  const nm = style === 'sh' ? shVar(id) : pyVar(id);
  const tail = `${id} 的输出在脚本里算不出来，留空（不拿上游顶替）`;
  return style === 'sh' ? `${nm}=""   # ${tail}` : `${nm} = ""   # ${tail}`;
}

/** 某节点的直接上游（按边序，去重）—— join 拼接与透传都按这个列表 */
function upsOf(g: Graph, id: string): string[] {
  const seen: string[] = [];
  for (const e of g.edges ?? []) {
    if (e.target === id && !seen.includes(e.source)) seen.push(e.source);
  }
  return seen;
}

/** 打平后的拓扑序（与 toShell/toPython 里同一口径） */
function flatOrder(g: Graph): string[] {
  const { layers, cyclic } = topoLayers(g, paramLinksOf(g.edges));
  const out: string[] = [];
  for (const l of layers) for (const id of l) out.push(id);
  for (const id of cyclic) out.push(id);
  return out;
}


type CondItem = { op: string; value?: string; source?: string; enabled?: boolean };
type CondRuleLike = {
  id?: string; label?: string; op?: string; value?: string; source?: string;
  enabled?: boolean; logic?: string; conditions?: CondItem[];
};

/** 归一化取一条规则的条件列表（与 engine/condition.ts 同一口径） */
function ruleCondsOf(rule: CondRuleLike): CondItem[] {
  if (rule.conditions && rule.conditions.length > 0) return rule.conditions;
  return [{ op: str(rule.op), value: str(rule.value), source: str(rule.source) }];
}

/**
 * 一条条件能不能翻成脚本里的判定表达式。
 *
 * ================= 什么情况下不翻 =================
 *
 * · source 为空 —— 画布上的语义是"拼接全部上游输出"，脚本里
 *   重写一遍拼接规则就是"画布上拼了 3 个、脚本里拼 2 个"，
 *   没有报错，只有判定结果不对。那正是这里要防的。
 * · op 是正则 —— JS 的 RegExp 与 python 的 re 语法不完全一致，
 *   翻过去就是"看着对、判定错"，比不翻更糟。
 * · 替换后仍带 {{ }} —— 说明引用的东西脚本里取不到（具名输出等），
 *   留着就是未定义变量，跑起来 NameError。
 */
function condExprOf(
  c: CondItem,
  subst: (t: string) => string,
): string | null {
  const src0 = str(c.source ?? '');
  if (src0 === '') return null;
  const op = str(c.op || 'nonEmpty');
  if (op === 'regex') return null;

  /*
   * 只生成 python 表达式 —— shell 不翻条件，理由见 toShell 里的说明。
   * 半翻（python 有分支、shell 没有但不吭声）比全不翻更危险，
   * 所以 shell 侧会明确记一条"两条分支都会执行"。
   */
  const src = src0 === 'input' ? 'input_text' : subst(`{{${src0}.output}}`);
  if (src.includes('{{')) return null;

  const vRaw = str(c.value ?? '');
  const val = vRaw === '' ? '' : subst(vRaw);
  if (val.includes('{{')) return null;

  /*
   * value 为空时 contains / notContains 恒为真（与 testCondition 同一口径）——
   * 不特判的话脚本里会变成 `"".strip() in x`，永远是 True，
   * 而画布上也是 True，看着一致；但一旦 value 是模板且结果为空就分叉了。
   * 所以按同一口径显式写 True。
   */
  if ((op === 'contains' || op === 'notContains') && val === '') return 'True';

  switch (op) {
    case 'always': return 'True';
    case 'nonEmpty': return `str(${src}).strip() != ""`;
    case 'isEmpty': return `str(${src}).strip() == ""`;
    case 'contains': return `${val} in str(${src})`;
    case 'notContains': return `${val} not in str(${src})`;
    case 'equals': return `str(${src}).strip() == str(${val}).strip()`;
    case 'notEquals': return `str(${src}).strip() != str(${val}).strip()`;
    case 'startsWith': return `str(${src}).lstrip().startswith(${val})`;
    default: return null;
  }
}

/** 一条规则的判定表达式；翻不了返回 null */
function ruleExprOf(
  rule: CondRuleLike,
  subst: (t: string) => string,
): string | null {
  const active = ruleCondsOf(rule).filter((c) => c.enabled !== false);
  if (active.length === 0) return null;
  const parts: string[] = [];
  for (const c of active) {
    const e = condExprOf(c, subst);
    if (e === null) return null;
    parts.push(e);
  }
  const or = str(rule.logic ?? 'and') === 'or';
  const joiner = or ? ' or ' : ' and ';
  return parts.length === 1 ? parts[0] : `(${parts.join(joiner)})`;
}

/** 条件节点能翻成 if / elif / else 时，各分支的表达式（按顺序） */
export function condPlanOf(
  d: Record<string, unknown>,
  subst: (t: string) => string,
): { arms: Array<{ key: string; label: string; expr: string | null }> } | null {
  const rules = (Array.isArray(d.rules) ? d.rules : []) as CondRuleLike[];
  const live = rules.filter((r) => r.enabled !== false);
  if (live.length === 0) return null;

  const arms: Array<{ key: string; label: string; expr: string | null }> = [];
  for (const r of live) {
    const expr = ruleExprOf(r, subst);
    if (expr === null) return null; // 一条翻不了就整段不翻 —— 半翻比不翻更危险
    arms.push({ key: str(r.id), label: str(r.label || r.id), expr });
  }
  if (d.defaultBranch === true) {
    arms.push({ key: '__default__', label: '兜底', expr: null });
  }
  return arms.length > 0 ? { arms } : null;
}

/**
 * 条件节点各分支的成员，以及"汇合点"（多个分支都会到达的节点）。
 *
 * 汇合点必须放在 if/else **之后** —— 塞进某个分支里的话，
 * 走另一条分支时它根本不执行，而画布上两条路都会汇到它。
 */
export function condBranchesOf(
  g: Graph,
  id: string,
): { arms: Map<string, string[]>; joins: string[] } {
  const order = flatOrder(g);
  const fwd = new Map<string, string[]>();
  for (const e of g.edges) {
    if (!fwd.has(e.source)) fwd.set(e.source, []);
    fwd.get(e.source)!.push(e.target);
  }
  const walk = (starts: string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = [...starts];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === id || seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(fwd.get(cur) ?? []));
    }
    return seen;
  };

  const startsByBranch = new Map<string, string[]>();
  for (const e of g.edges) {
    if (e.source !== id) continue;
    const b = str((e as unknown as { branch?: string }).branch ?? '');
    if (!b) continue;
    if (!startsByBranch.has(b)) startsByBranch.set(b, []);
    startsByBranch.get(b)!.push(e.target);
  }

  const reach = new Map<string, Set<string>>();
  for (const [b, starts] of startsByBranch) reach.set(b, walk(starts));

  const seenCount = new Map<string, number>();
  for (const s of reach.values()) {
    for (const x of s) seenCount.set(x, (seenCount.get(x) ?? 0) + 1);
  }
  const joins = order.filter((x) => (seenCount.get(x) ?? 0) >= 2);

  const arms = new Map<string, string[]>();
  for (const [b, s] of reach) {
    arms.set(b, order.filter((x) => s.has(x) && (seenCount.get(x) ?? 0) < 2));
  }
  return { arms, joins };
}

function toShell(g: Graph): ExportResult {
  /*
   * topoLayers 返回分层结果（{ layers, cyclic }），没有一维的 order。
   * 展平即可 —— 脚本是顺序执行的，层内顺序无意义。
   *
   * **cyclic 不能丢**：成环的节点排不进拓扑序，静默丢掉的话
   * 用户会拿到一份"少了几个节点"的脚本而毫无线索。
   */
  const skipped: Skipped[] = [];
  const { layers, cyclic } = topoLayers(g, paramLinksOf(g.edges));
  const order: string[] = [];
  for (const l of layers) for (const id of l) order.push(id);
  for (const id of cyclic) {
    skipped.push({ id, kind: '', reason: '这个节点处在环里，排不进执行顺序' });
  }
  const lines = [
    '#!/usr/bin/env bash',
    '# 由画布自动生成 —— 请勿手改后指望能同步回去',
    '#',
    '# 说明：条件与「固定次数」循环已生成对应结构；',
    '#       并发在脚本里是顺序执行（结果一致，只是不并行）；',
    '#       其余情形及未翻译的节点在下方以 "# TODO" 标出。',
    'set -euo pipefail',
    '',
    /*
     * 全局输入 {{input}} 在脚本里的对应物。
     *
     * python 那侧一直是 `input_text = ""`（在 main() 里），
     * 而 shell 这边**根本没有** —— {{input}} 被拼成 $INPUT，
     * set -u 下直接 unbound variable 退出。
     * 名字跟 python 对齐（INPUT_TEXT），两边才是同一件事。
     */
    'INPUT_TEXT=""   # 全局输入 {{input}}：整段流程的入参',
    '',
  ];
  const cardRef = constCardRefs(g);
  const namedOut = namedOutRefs(g);
  const bodies = loopBodiesOf(g);
  let count = 0;

  /*
   * 递归而不是平铺：循环体成员交给它的循环节点包起来，
   * 平铺的话脚本里只跑一次 —— 能跑、看着完整、轮数不对，
   * 而这恰恰是最难发现的那一类错。
   */
  const done = new Set<string>();
  const emit = (ids: string[], loopRef: Record<string, string> | null): void => {
    for (const id of ids) {
      if (done.has(id)) continue;
      const n = g.nodes.find((x) => x.id === id);
      if (!n) continue;
      const d = (n.data ?? {}) as Record<string, unknown>;
      const kind = str(d.kind ?? (n as { type?: string }).type);

      /*
       * shell 不翻条件判定：nonEmpty 在画布上是"去掉首尾空白后非空"，
       * shell 里写成 `[ -n "$X" ]` 差的就是那一次 trim ——
       * 看着一样、判定不同，正是这里要防的"能跑但结果不对"。
       * 所以 python 翻、shell 明说各分支都会执行。
       */
      if (kind === 'condition') {
        const { arms } = condBranchesOf(g, id);
        const total = [...arms.values()].reduce((m, x) => m + x.length, 0);
        if (total > 0) {
          skipped.push({
            id, kind,
            reason: `条件分支在 shell 脚本里不生成判断 —— ${total} 个分支节点都会执行，而画布上只走一条；要分支请导出 python 版`,
          });
        }
      }

      if (kind === 'loop') {
        done.add(id);
        const times = loopFixedTimes(d);
        const members = (bodies.get(id) ?? new Set<string>());
        const inner = order.filter((x) => members.has(x));
        if (times > 0 && inner.length > 0) {
          const nm = loopVarNames(id, 'sh');
          const k = shVar(id);
          lines.push(`# ${id}: 循环（固定 ${times} 次）`);
          lines.push(`${nm['loop.count']}=${times}`);
          lines.push(`${nm['loop.index']}=0`);
          lines.push(`while [ "${'$'}${nm['loop.index']}" -lt "${'$'}${nm['loop.count']}" ]; do`);
          lines.push(`  ${nm['loop.item']}=$(( ${nm['loop.index']} + 1 ))`);
          const t0 = lines.length;
          emit(inner, nm);
          // 循环体按两空格缩进，读起来才看得出它们在循环里
          for (let i = t0; i < lines.length; i += 1) {
            if (lines[i].startsWith('  ')) continue;
            lines[i] = `  ${lines[i]}`;
          }
          lines.push(`  ${nm['loop.index']}=$(( ${nm['loop.index']} + 1 ))`);
          lines.push('done');
          /*
           * 循环节点的输出在画布上是"各轮收集起来的结果"，脚本里
           * 没有等价物 —— 给空串并注明，而不是拿最后一轮顶替
           * （顶替 = 能跑但内容不对）。
           */
          lines.push(`${k}=""   # 循环 ${id} 的输出是各轮收集的结果，脚本里留空`);
          count += 1;
          continue;
        }
        /* 翻不成真循环：明说循环体在脚本里只跑一次，别让人以为展开过 */
        if (inner.length > 0) {
          skipped.push({
            id, kind,
            reason: `循环体（${inner.length} 个节点）在脚本里只跑一次 —— 画布上会重复执行，脚本不是`,
          });
        }
      }

      done.add(id);
      if (kind === 'parallel') {
        skipped.push({
          id, kind,
          reason: '并发在脚本里是顺序执行 —— 结果一致，只是不并行（画布上的并发度上限在脚本里没有对应物）',
        });
      }
      const line = shellLine(n, skipped, cardRef, namedOut, loopRef, upsOf(g, id));
      const own = line ? new RegExp(`\\b${shVar(id)}=`).test(line) : false;
      if (!own) lines.push(assignLineOf(g, id, kind, 'sh'));
      if (line) { lines.push(line); count += 1; }
      else { lines.push(`# TODO 未翻译：${id}（${str((n.data as Record<string, unknown>)?.kind ?? '')}）`); }
      lines.push(...paramLinkNoteOf(g, id, '# '));
    }
  };
  emit(order, null);

  return { text: lines.join('\n') + '\n', skipped, count };
}

/* ------------------------------------------------------------------ */
/* Python                                                              */
/* ------------------------------------------------------------------ */

function pyLine(
  n: GraphNode,
  skipped: Skipped[],
  indent = '',
  cardRef?: Map<string, string>,
  paneEff?: Map<string, ReturnType<typeof resolveApiPane>>,
  namedOut?: Set<string>,
  loopRef?: Record<string, string> | null,
  ups: string[] = [],
): string | null {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const kind = str(d.kind ?? d.type);
  const v = (k: string) => subst(str(d[k]), 'py', cardRef, (key) => {
    skipped.push({ id: n.id, kind, reason: refReason(key) });
  }, namedOut, loopRef);
  /*
   * 同上，但替换一段**给定的文本**而不是节点上的某个字段。
   * 窗格继承来的 system 提示词也要走同一套替换 ——
   * 否则窗格上写了 {{上游.output}} 会原样留在脚本里。
   */
  const vs = (s: string) => subst(str(s), 'py', cardRef, (key) => {
    skipped.push({ id: n.id, kind, reason: refReason(key) });
  }, namedOut, loopRef);
  const me = pyVar(n.id);

  switch (kind) {
    case 'join': return pyJoinOf(n, skipped, indent, ups);
    case 'wait': {
      const ms = num(d.ms, 1000);
      return `${indent}time.sleep(${ms / 1000})   # ${n.id}: 等待 ${ms}ms`;
    }
    case 'log': {
      const lv = str(d.level || 'info');
      const tag = lv === 'error' ? '[ERR] ' : lv === 'warn' ? '[WARN] ' : '';
      // 没有前缀时只传一个参数 —— 传 f"" 会在输出里多个空串
      const arg = tag ? `f"${tag}", ${v('text')}` : v('text');
      return `${indent}print(${arg})   # ${n.id}`;
    }
    case 'const': {
      // 每张卡各导出一个变量，理由见 shell 那一支
      const cards = constsOf(n.data as unknown as ConstNodeData);
      const lines: string[] = [];
      cards.forEach((it, i) => {
        const cardVar = `${me}_${pyVar(constItemKey(it, i)).replace(/^out_/, '')}`;
        lines.push(`${indent}${cardVar} = ${subst(str(it.value ?? ''), 'py')}`
          + `   # ${n.id} 的卡「${constItemLabel(it, i)}」`);
        // 第一张同时是整节点的默认引用（{{id}} 不带卡名时取它）
        if (i === 0) {
          lines.push(`${indent}${me} = ${cardVar}   # ${n.id}: 常量（默认取第一张）`);
        }
      });
      if (lines.length === 0) return null;
      return lines.join('\n');
    }
    case 'clock': {
      // format 是 strftime 格式串，不是模板 —— 不做 {{}} 替换
      const fmt = str(d.format) || '%Y-%m-%d %H:%M:%S';
      return `${indent}${me} = time.strftime(${pyq(fmt)})   # ${n.id}: 当前时间`;
    }
    case 'extract': {
      const mode = str(d.mode || 'json');
      if (mode === 'json') {
        return `${indent}${me} = _jget(input_text, ${pyq(str(d.path))})   # ${n.id}`;
      }
      skipped.push({ id: n.id, kind, reason: `提取模式 ${mode} 需要手写，已留 TODO` });
      return null;
    }
    case 'generic-http': {
      const url = v('url');
      const method = str(d.method || 'GET').toLowerCase();
      const body = str(d.body) ? `, data=${v('body')}` : '';
      return `${indent}${me} = requests.${method}(${url}${body}).text   # ${n.id}`;
    }
    /*
     * 大模型节点。
     *
     * ================= 密钥绝不能写进导出脚本 =================
     *
     * 脚本是要落到磁盘上的文件，而节点的地址与密钥来自**连接**。
     * 把密钥原样写进脚本，等于把口令以明文存了一份在导出目录里 ——
     * 用户会以为自己只是导出了一份流程。
     *
     * 所以密钥与地址一律走环境变量，脚本里只留模型名与提示词。
     *
     * ================= 为什么用辅助函数而不是内联 =================
     *
     * 请求体是一坨嵌套 JSON，内联进一行的结果没人看得懂，
     * 而多行又与"一个节点一行"的结构对不上。
     * 抽出 _llm / _llm_img，与既有的 _jget 同一套做法。
     */
    case 'llmChat': {
      const use = str(d.use || 'chat');
      /*
       * 挂了窗格时用**继承后**的生效值，而不是节点自己的 data。
       *
       * 模型名 / system / 温度常常只配在窗格上（那正是窗格存在的意义），
       * 只读 d.model 的话导出的脚本里 model=""，用错模型且不报错。
       * 详见 llmPaneEffOf 的注释。
       */
      const eff = paneEff?.get(n.id);
      const effModel = eff ? str(eff.model) : str(d.model);
      const effSys = eff ? str(eff.system) : str(d.system);
      // 温度三级回落（节点 → 窗格 → 默认）由 resolveApiPane 算好，
      // 没挂窗格时这里走同一条规则，避免出现"挂了窗格和不挂是两套算法"
      const effTemp = eff
        ? eff.temperature
        : typeof d.temperature === 'number' && isFinite(d.temperature)
          ? d.temperature
          : DEFAULT_TEMPERATURE;
      const model = pyq(effModel || '');
      const sysArg = effSys ? `, system=${vs(effSys)}` : '';
      const tempArg = effTemp === DEFAULT_TEMPERATURE ? '' : `, temperature=${effTemp}`;
      if (use === 'ocr') {
        /*
         * 本地图片要先读成 base64 才能放进请求体 ——
         * 那不是"一行"，硬拼只会生成一份看起来完整其实跑不通的脚本。
         * 明确留 TODO，而不是静默退化成纯文本提问。
         */
        if (str(d.imageSource || 'url') === 'file') {
          skipped.push({
            id: n.id, kind,
            reason: '图片识别用的是本地图片，脚本里要先 base64 编码，已留 TODO',
          });
          return null;
        }
        return `${indent}${me} = _llm_img(${v('prompt')}, ${pyq(str(d.url))}, model=${model}${sysArg}${tempArg})   # ${n.id}: 图片识别`;
      }
      return `${indent}${me} = _llm(${v('prompt')}, model=${model}${sysArg}${tempArg})   # ${n.id}: 调用大模型`;
    }
    default:
      skipped.push({ id: n.id, kind, reason: '这类节点没有对应的 python 写法' });
      return null;
  }
}

function toPython(g: Graph): ExportResult {
  /*
   * topoLayers 返回分层结果（{ layers, cyclic }），没有一维的 order。
   * 展平即可 —— 脚本是顺序执行的，层内顺序无意义。
   *
   * **cyclic 不能丢**：成环的节点排不进拓扑序，静默丢掉的话
   * 用户会拿到一份"少了几个节点"的脚本而毫无线索。
   */
  const skipped: Skipped[] = [];
  const { layers, cyclic } = topoLayers(g, paramLinksOf(g.edges));
  const order: string[] = [];
  for (const l of layers) for (const id of l) order.push(id);
  for (const id of cyclic) {
    skipped.push({ id, kind: '', reason: '这个节点处在环里，排不进执行顺序' });
  }
  const lines = [
    '#!/usr/bin/env python3',
    '"""由画布自动生成 —— 请勿手改后指望能同步回去。',
    '',
    '条件与「固定次数」循环已生成对应结构；',
    '并发在脚本里是顺序执行（结果一致，只是不并行）；',
    '其余情形及未翻译的节点在下方以 "# TODO" 标出。',
    '"""',
    'import time',
    'import requests',
    '',
    '',
    'def _jget(text, path):',
    '    """按 a.b.0.c 这样的路径取 JSON 值"""',
    '    import json',
    '    cur = json.loads(text)',
    '    for p in [p for p in path.split(".") if p != ""]:',
    '        cur = cur[int(p)] if isinstance(cur, list) else cur[p]',
    '    return cur',
    '',
    '',
  ];
  /*
   * 图里有大模型节点才带上这两个函数。
   *
   * 无条件加的话每份脚本都多二十行与本次流程无关的代码，
   * 而"按需加"的判定必须看**节点种类**而不是导出的行 ——
   * 图片识别的本地图片模式是 return null（留 TODO），
   * 按导出行判会把函数漏掉，脚本里就调用了一个不存在的 _llm。
   */
  const hasLlm = g.nodes.some((x) => str((x.data as Record<string, unknown> | undefined)?.kind) === 'llmChat');
  if (hasLlm) {
    lines.push(
      /*
       * 默认值取 pane.ts 的 DEFAULT_TEMPERATURE，不在这里另写一个 0.3。
       * 写死的话改了默认温度会出现"脚本里是 0.3、画布上跑是 0.7"，
       * 两边都不报错。
       */
      `def _llm(prompt, model="", system="", temperature=${DEFAULT_TEMPERATURE}):`,
      '    """调用 OpenAI 兼容接口 —— 地址与密钥取自环境变量，不落盘"""',
      '    return _llm_call(prompt, model, system, None, temperature)',
      '',
      '',
      `def _llm_img(prompt, image_url, model="", system="", temperature=${DEFAULT_TEMPERATURE}):`,
      '    """同上，但带上图片地址"""',
      '    return _llm_call(prompt, model, system, image_url, temperature)',
      '',
      '',
      `def _llm_call(prompt, model, system, image_url, temperature=${DEFAULT_TEMPERATURE}):`,
      '    import os',
      '    msgs = []',
      '    if system:',
      '        msgs.append({"role": "system", "content": system})',
      '    if image_url:',
      '        msgs.append({"role": "user", "content": [',
      '            {"type": "text", "text": prompt},',
      '            {"type": "image_url", "image_url": {"url": image_url}},',
      '        ]})',
      '    else:',
      '        msgs.append({"role": "user", "content": prompt})',
      '    r = requests.post(',
      '        os.environ.get("LLM_BASE_URL", "").rstrip("/") + "/chat/completions",',
      '        headers={"Authorization": "Bearer " + os.environ.get("LLM_API_KEY", "")},',
      '        json={"model": model, "messages": msgs, "temperature": temperature},',
      '    )',
      '    return r.json()["choices"][0]["message"]["content"]',
      '',
      '',
    );
  }
  lines.push(
    'def main():',
    '    input_text = ""',
  );
  if (lines[lines.length - 1] === '    input_text = ""') lines.push('');
  const cardRef = constCardRefs(g);
  const namedOut = namedOutRefs(g);
  const paneEff = llmPaneEffOf(g);
  const bodies = loopBodiesOf(g);
  let count = 0;

  const emit = (ids: string[], indent: string, loopRef: Record<string, string> | null): void => {
    for (const id of ids) {
      if (done.has(id)) continue;
      const n = g.nodes.find((x) => x.id === id);
      if (!n) continue;
      const d = (n.data ?? {}) as Record<string, unknown>;
      const kind = str(d.kind ?? (n as { type?: string }).type);

      /*
       * 条件节点：能翻就生成真的 if/elif/else。
       * 翻不成的话**必须明说各分支都会执行** ——
       * 画布上走 A 分支，脚本里 A、B 都跑（比如 B 是"推送/删除"），
       * 而这与"拼不出变量"不同：后者留 {{}} 的痕迹，分支跑错了没有。
       */
      if (kind === 'condition') {
        done.add(id);
        const { arms: armOrder, joins } = condBranchesOf(g, id);
        const subst = (t: string) => pysubst(t, cardRef, namedOut, loopRef);
        const plan = condPlanOf(d, subst);

        if (plan && plan.arms.length > 0) {
          let opened = false;
          const k = pyVar(id);
          lines.push(`${indent}${k} = ""`);
          /*
           * 各分支的成员都先初始化成空串。
           *
           * 画布上没走的那条分支，其节点 output 就是空串
           * （upstreamText 里 `outputs[u] ?? ''`），
           * 而脚本里不初始化的话，汇合点引用它就是 UnboundLocalError ——
           * 脚本直接崩，而不是"拿到空串"，这正是两边必须一致的地方。
           */
          const members0 = new Set<string>();
          for (const a of plan.arms) {
            for (const m of armOrder.get(a.key) ?? []) members0.add(m);
          }
          for (const m of flatOrder(g)) {
            if (members0.has(m)) lines.push(`${indent}${pyVar(m)} = ""`);
          }
          for (const a of plan.arms) {
            const members = armOrder.get(a.key) ?? [];
            const head = a.expr === null
              ? (opened ? `${indent}else:` : `${indent}if True:`)
              : (opened ? `${indent}elif ${a.expr}:` : `${indent}if ${a.expr}:`);
            lines.push(`${head}   # 分支：${a.label}`);
            lines.push(`${indent}    ${k} = "走「${a.label}」"`);
            if (members.length === 0) lines.push(`${indent}    pass`);
            else emit(members, `${indent}    `, loopRef);
            opened = true;
          }
          /*
           * 一条分支都没生成时补 pass —— `if ...:` 下面空着是语法错误。
           */
          if (!opened) lines.push(`${indent}pass`);
          // 汇合点放在分支之外：塞进某条分支的话走另一条就不执行了
          emit(joins, indent, loopRef);
          count += 1;
          continue;
        }

        const branchCount = [...armOrder.values()].reduce((m, x) => m + x.length, 0);
        if (branchCount > 0) {
          skipped.push({
            id, kind,
            reason: `条件分支在脚本里不生成 if/elif —— ${branchCount} 个分支节点都会执行，而画布上只走一条`,
          });
        }
      }

      if (kind === 'loop') {
        done.add(id);
        const times = loopFixedTimes(d);
        const members = bodies.get(id) ?? new Set<string>();
        const inner = order.filter((x) => members.has(x));
        if (times > 0 && inner.length > 0) {
          const nm = loopVarNames(id, 'py');
          lines.push(`${indent}# ${id}: 循环（固定 ${times} 次）`);
          lines.push(`${indent}${nm['loop.count']} = ${times}`);
          lines.push(`${indent}for ${nm['loop.index']} in range(${nm['loop.count']}):`);
          lines.push(`${indent}    ${nm['loop.item']} = str(${nm['loop.index']} + 1)`);
          emit(inner, `${indent}    `, nm);
          count += 1;
          continue;
        }
        if (inner.length > 0) {
          skipped.push({
            id, kind,
            reason: `循环体（${inner.length} 个节点）在脚本里只跑一次 —— 画布上会重复执行，脚本不是`,
          });
        }
      }

      done.add(id);
      if (kind === 'parallel') {
        /*
         * 并发节点在画布上是"给下游设并发度上限"，脚本里一律顺序执行 ——
         * 结果一致（只是不并行），所以这里不翻结构，但**必须说出来**：
         * 静默平铺的话，用户会以为脚本里也真的并发跑了。
         */
        skipped.push({
          id, kind,
          reason: '并发在脚本里是顺序执行 —— 结果一致，只是不并行（画布上的并发度上限在脚本里没有对应物）',
        });
      }
      const line = pyLine(n, skipped, indent, cardRef, paneEff, namedOut, loopRef, upsOf(g, id));
      const own = line ? new RegExp(`\\b${pyVar(id)}\\s*=`).test(line) : false;
      if (!own) lines.push(`${indent}${assignLineOf(g, id, kind, 'py')}`);
      if (line) { lines.push(line); count += 1; }
      else { lines.push(`${indent}# TODO 未翻译：${id}（${str((n.data as Record<string, unknown>)?.kind ?? '')}）`); }
      lines.push(...paramLinkNoteOf(g, id, `${indent}# `));
    }
  };
  const done = new Set<string>();
  emit(order, '    ', null);

  lines.push('', '', 'if __name__ == "__main__":', '    main()', '');
  return { text: lines.join('\n'), skipped, count };
}

/* ------------------------------------------------------------------ */
/* JSON                                                                */
/* ------------------------------------------------------------------ */

function toJson(g: Graph): ExportResult {
  const payload = {
    format: 'agent-flow/v1',
    exportedAt: new Date().toISOString(),
    nodes: g.nodes,
    edges: g.edges,
  };
  return { text: JSON.stringify(payload, null, 2) + '\n', skipped: [], count: g.nodes.length };
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

function toMarkdown(g: Graph): ExportResult {
  /*
   * topoLayers 返回分层结果（{ layers, cyclic }），没有一维的 order。
   * 展平即可 —— 脚本是顺序执行的，层内顺序无意义。
   *
   * **cyclic 不能丢**：成环的节点排不进拓扑序，静默丢掉的话
   * 用户会拿到一份"少了几个节点"的脚本而毫无线索。
   */
  const skipped: Skipped[] = [];
  const { layers, cyclic } = topoLayers(g, paramLinksOf(g.edges));
  const order: string[] = [];
  for (const l of layers) for (const id of l) order.push(id);
  for (const id of cyclic) {
    skipped.push({ id, kind: '', reason: '这个节点处在环里，排不进执行顺序' });
  }
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const upstream = new Map<string, string[]>();
  for (const e of g.edges ?? []) {
    const t = str((e as Record<string, unknown>).target);
    const s = str((e as Record<string, unknown>).source);
    if (!upstream.has(t)) upstream.set(t, []);
    upstream.get(t)!.push(s);
  }

  const lines = ['# 流程说明', '', '> 由画布自动生成。', ''];
  let step = 0;
  for (const id of order) {
    const n = byId.get(id);
    if (!n) continue;
    const d = (n.data ?? {}) as Record<string, unknown>;
    const kind = str(d.kind ?? d.type);
    step += 1;
    const ups = upstream.get(id) ?? [];
    const from = ups.length ? `（接 ${ups.join('、')}）` : '（起点）';
    lines.push(`## ${step}. ${str(d.label || id)} \`${kind}\``, '');
    lines.push(`- 位置：${id} ${from}`);
    const brief = briefOf(d, kind);
    if (brief) lines.push(`- 做什么：${brief}`);
    if (ups.length === 0 && kind !== 'trigger') {
      lines.push('- ⚠ 没有上游 —— 它可能拿不到输入');
    }
    if (kind === 'condition' || kind === 'loop' || kind === 'parallel') {
      skipped.push({ id, kind, reason: '控制流的结构在说明里只有顺序，看不到分支' });
      lines.push('- ⚠ 控制流节点：说明里只能体现顺序，分支/循环结构请看画布');
    }
    /*
     * 与 shell / python 同一口径：参数连线也要标。
     * 三处各写一份容易漏，漏的那份就是"这一步的说明看着完整其实是错的"。
     */
    for (const note of paramLinkNoteOf(g, id, '  ')) {
      lines.push(`- ⚠ ${note.replace(/^\s*/, '')}`);
    }
    lines.push('');
  }
  lines.push('---', '', `共 ${step} 步。`);
  return { text: lines.join('\n'), skipped, count: g.nodes.length };
}

function briefOf(d: Record<string, unknown>, kind: string): string {
  /*
   * 四个运算节点与画布卡片共用 opBrief ——
   * 各写一份的话，会出现"卡片上写着 1 ＋ 2、导出说明里只写了'加'"，
   * 同一件事两种说法，而两边单看都没错。
   */
  if (kind === 'math' || kind === 'text' || kind === 'compare' || kind === 'random') {
    return opBrief(kind, d);
  }
  switch (kind) {
    case 'wait': return `等待 ${num(d.ms, 1000)} 毫秒`;
    case 'log': return `记录一条日志：${str(d.text).slice(0, 60)}`;
    case 'generic-http': return `${str(d.method || 'GET')} ${str(d.url).slice(0, 60)}`;
    case 'extract': return `按 ${str(d.mode || 'json')} 规则从上游取值`;
    case 'const': {
      const cards = constsOf(d as unknown as ConstNodeData);
      const first = str(cards[0]?.value).slice(0, 40);
      return cards.length > 1
        ? `输出 ${cards.length} 个固定值（首个 ${first}）`
        : `输出固定值 ${first}`;
    }
    case 'clock': return `输出当前时间（格式 ${str(d.format)}）`;
    case 'translate': return `翻译成 ${str(d.targetLang)}`;
    /*
     * 大模型节点 —— 合并出来的那一个。
     *
     * **以前这里根本没有 llmChat 这一支**，于是它落到 default 返回空串：
     * 导出的 markdown / 说明里这个节点**没有描述**，
     * 拿着脚本对照画布时看不出这一步干了什么。
     *
     * 不报错、也不留 TODO（skipped 只记翻译不出来的节点，
     * 而描述是空串并不算"翻译不出来"）—— 所以只能靠对账发现。
     */
    case 'llmChat': {
      const use = str(d.use || 'chat');
      if (use === 'ocr') return '调用大模型识别图片内容';
      if (use === 'translate') return `调用大模型翻译成 ${str(d.targetLang)}`;
      return `调用大模型问一句（${str(d.model) || '未指定模型'}）`;
    }
    case 'task': return `跑一条 CLI 指令`;
    default: return '';
  }
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export function exportFlow(g: Graph, fmt: ExportFormat): ExportResult {
  switch (fmt) {
    case 'shell': return toShell(g);
    case 'python': return toPython(g);
    case 'json': return toJson(g);
    case 'markdown': return toMarkdown(g);
    default: return { text: '', skipped: [], count: 0 };
  }
}

/** 一次导出全部四种 */
export function exportAll(g: Graph): Record<ExportFormat, ExportResult> {
  const out = {} as Record<ExportFormat, ExportResult>;
  for (const f of EXPORT_FORMATS) out[f.id] = exportFlow(g, f.id);
  return out;
}
