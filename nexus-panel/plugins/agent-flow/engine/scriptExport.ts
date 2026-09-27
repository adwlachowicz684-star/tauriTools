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
import { opBrief } from './ops';
import { paramLinksOf, linksInto, outLabelOf, OUT_DEFAULT } from './paramLinks';

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

function subst(tpl: string, style: 'sh' | 'py', cardRef?: Map<string, string>): string {
  const raw = String(tpl ?? '');
  if (!raw) return style === 'sh' ? '' : '""';

  let hasRef = false;
  // 先把引用收出来，避免后面的引号转义把它们弄坏
  const slots: string[] = [];
  /*
   * 字符集必须与**运行时**的 template.ts 一致（含中文、连字符、下划线）。
   *
   * 以前这里是 `[A-Za-z0-9_.]`，不含中文 —— 而常量卡的默认名是
   * 「文本1」「数字2」这类中文（用户不改名时就是它）。
   * 于是 `{{c1.价格}}` **整段匹配不上**，原样留在脚本里。
   * 运行时用的是另一份正则（支持中文），能取到值 ——
   * 于是"画布上跑是对的、导出成脚本就变成字面量 {{c1.价格}}"，
   * 没有任何报错，只有结果不对。
   */
  const body = raw.replace(/\{\{\s*([A-Za-z0-9_.\-\u4e00-\u9fa5]+)\s*\}\}/g, (_m, path: string) => {
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

    if (id === 'input' || id === 'env' || id === 'loop') {
      const rest = parts.slice(1).join('_');
      const name = `INPUT${rest ? `_${rest.toUpperCase()}` : ''}`.replace(/[^A-Z0-9_]/g, '_');
      slots.push(style === 'sh' ? `$${name}` : name.toLowerCase());
    } else {
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

  // python：字面量部分要转义，引用部分拼进 f-string
  let out = body.split('"').join('\\"');
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

function shellLine(n: GraphNode, skipped: Skipped[], cardRef?: Map<string, string>): string | null {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const kind = str(d.kind ?? d.type);
  const v = (k: string) => subst(str(d[k]), 'sh', cardRef);
  const me = shVar(n.id);

  switch (kind) {
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
    '# 说明：画布里的条件/循环/并发/MCP 调用不在这份脚本里，',
    '#       未翻译的节点在下方以 "# TODO" 标出。',
    'set -euo pipefail',
    '',
  ];
  const cardRef = constCardRefs(g);
  let count = 0;
  for (const id of order) {
    const n = g.nodes.find((x) => x.id === id);
    if (!n) continue;
    const line = shellLine(n, skipped, cardRef);
    if (line) { lines.push(line); count += 1; }
    else { lines.push(`# TODO 未翻译：${id}（${str((n.data as Record<string, unknown>)?.kind ?? '')}）`); }
    lines.push(...paramLinkNoteOf(g, id, '# '));
  }
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
): string | null {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const kind = str(d.kind ?? d.type);
  const v = (k: string) => subst(str(d[k]), 'py', cardRef);
  const me = pyVar(n.id);

  switch (kind) {
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
      const model = pyq(str(d.model) || '');
      const sys = v('system');
      const sysArg = str(d.system) ? `, system=${sys}` : '';
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
        return `${indent}${me} = _llm_img(${v('prompt')}, ${pyq(str(d.url))}, model=${model}${sysArg})   # ${n.id}: 图片识别`;
      }
      return `${indent}${me} = _llm(${v('prompt')}, model=${model}${sysArg})   # ${n.id}: 调用大模型`;
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
    '画布里的条件/循环/并发/MCP 调用不在这份脚本里，',
    '未翻译的节点在下方以 "# TODO" 标出。',
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
      'def _llm(prompt, model="", system=""):',
      '    """调用 OpenAI 兼容接口 —— 地址与密钥取自环境变量，不落盘"""',
      '    return _llm_call(prompt, model, system, None)',
      '',
      '',
      'def _llm_img(prompt, image_url, model="", system=""):',
      '    """同上，但带上图片地址"""',
      '    return _llm_call(prompt, model, system, image_url)',
      '',
      '',
      'def _llm_call(prompt, model, system, image_url):',
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
      '        json={"model": model, "messages": msgs},',
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
  let count = 0;
  for (const id of order) {
    const n = g.nodes.find((x) => x.id === id);
    if (!n) continue;
    const line = pyLine(n, skipped, '    ', cardRef);
    if (line) { lines.push(line); count += 1; }
    else { lines.push(`    # TODO 未翻译：${id}（${str((n.data as Record<string, unknown>)?.kind ?? '')}）`); }
    lines.push(...paramLinkNoteOf(g, id, '    # '));
  }
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
