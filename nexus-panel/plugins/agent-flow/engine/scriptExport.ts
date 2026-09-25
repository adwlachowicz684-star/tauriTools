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
function subst(tpl: string, style: 'sh' | 'py'): string {
  const raw = String(tpl ?? '');
  if (!raw) return style === 'sh' ? '' : '""';

  let hasRef = false;
  // 先把引用收出来，避免后面的引号转义把它们弄坏
  const slots: string[] = [];
  const body = raw.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, path: string) => {
    const parts = String(path).split('.');
    const id = parts[0];
    hasRef = true;
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
    const what = l.sourceArg && l.sourceArg !== OUT_DEFAULT
      ? `的「${outLabelOf(srcKind, l.sourceArg)}」`
      : '的输出';
    return `${prefix}注意：参数「${l.targetArg}」在画布上来自「${srcName}」${what}，`
      + `这里取的是节点上填的值 —— 两者可能不同`;
  });
}

/* ------------------------------------------------------------------ */
/* Shell                                                               */
/* ------------------------------------------------------------------ */

function shellLine(n: GraphNode, skipped: Skipped[]): string | null {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const kind = str(d.kind ?? d.type);
  const v = (k: string) => subst(str(d[k]), 'sh');
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
    case 'const':
      return `${me}=${shq(v('value'))}   # ${n.id}: 常量`;
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
  let count = 0;
  for (const id of order) {
    const n = g.nodes.find((x) => x.id === id);
    if (!n) continue;
    const line = shellLine(n, skipped);
    if (line) { lines.push(line); count += 1; }
    else { lines.push(`# TODO 未翻译：${id}（${str((n.data as Record<string, unknown>)?.kind ?? '')}）`); }
    lines.push(...paramLinkNoteOf(g, id, '# '));
  }
  return { text: lines.join('\n') + '\n', skipped, count };
}

/* ------------------------------------------------------------------ */
/* Python                                                              */
/* ------------------------------------------------------------------ */

function pyLine(n: GraphNode, skipped: Skipped[], indent = ''): string | null {
  const d = (n.data ?? {}) as Record<string, unknown>;
  const kind = str(d.kind ?? d.type);
  const v = (k: string) => subst(str(d[k]), 'py');
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
    case 'const':
      return `${indent}${me} = ${v('value')}   # ${n.id}: 常量`;
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
    'def main():',
    '    input_text = ""',
  ];
  if (lines[lines.length - 1] === '    input_text = ""') lines.push('');
  let count = 0;
  for (const id of order) {
    const n = g.nodes.find((x) => x.id === id);
    if (!n) continue;
    const line = pyLine(n, skipped, '    ');
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
    case 'const': return `输出固定值 ${str(d.value).slice(0, 40)}`;
    case 'clock': return `输出当前时间（格式 ${str(d.format)}）`;
    case 'translate': return `翻译成 ${str(d.targetLang)}`;
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
