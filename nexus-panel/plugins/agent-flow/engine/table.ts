/**
 * 表格（CSV）读写与逐行推导 —— 游戏数值推导的地基。
 *
 * ================= 为什么表格以 CSV 文本在节点间流动 =================
 *
 * 表格在运行时需要一个载体。可选做法是加一个"表存储"（像 vars 那样），
 * 但那样每个表格节点都要读写全局状态，两块状态容易不同步。
 *
 * 改成**表格就是 CSV 文本**，节点输出什么下游就拿到什么：
 *   · 与现有"节点输出是字符串"完全兼容，{{上游.output}} 天然能拿到表
 *   · 没有隐藏状态，重跑一定得到同样结果
 *   · CSV 能被 Excel 直接打开编辑，分工清晰：
 *     Excel 负责看和改数据，插件负责算
 *
 * ================= 为什么先支持 CSV 而不是 xlsx =================
 *
 * xlsx 是个 zip 包（里面是 XML），解析要引入依赖。
 * 而 CSV 是 Excel 能直接打开、也能直接另存为的格式 ——
 * 对"在 Excel 里编辑、在插件里推导"这个用法完全够用。
 * 解析器做成可插拔的，以后要接 xlsx 不用改节点。
 */

import { evalExpr, fmtNum, type ExprResult } from './expr';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

/** 一张表：表头 + 若干行。行是字符串数组，长度与表头一致 */
export type Table = {
  header: string[];
  rows: string[][];
};

export type ParseResult = { ok: true; table: Table } | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

/**
 * 猜分隔符。
 *
 * 只看第一行 —— Excel 另存 CSV 时全表用的是同一种分隔符，
 * 没必要（也不能）逐行猜：逐行猜会让"描述里带逗号"的行被切错。
 */
export function guessDelim(text: string): string {
  const line = firstNonEmptyLine(text);
  const cands = [',', '\t', ';', '|'];
  let best = ',';
  let bestN = 0;
  for (const c of cands) {
    const n = countOutsideQuotes(line, c);
    if (n > bestN) { bestN = n; best = c; }
  }
  return best;
}

function firstNonEmptyLine(text: string): string {
  for (const l of text.split(/\r?\n/)) {
    if (l.trim()) return l;
  }
  return '';
}

function countOutsideQuotes(line: string, ch: string): number {
  let n = 0;
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') { inQ = !inQ; continue; }
    if (c === ch && !inQ) n += 1;
  }
  return n;
}

/**
 * 解析 CSV。
 *
 * 支持引号包裹、引号内换行、两个连续引号表示转义的引号 ——
 * Excel 导出的 CSV 一定会用这些，不处理的话
 * "含有,逗号" 这种单元格会被切成两列，而且**不报错**。
 */
export function parseCsv(text: string, delim?: string): Table {
  const d = delim ?? guessDelim(text);
  const rows = splitRows(text, d);
  if (rows.length === 0) return { header: [], rows: [] };
  const header = rows[0].map((h) => h.trim());
  const body = rows.slice(1).map((r) => {
    // 行长度不齐时补齐 —— 缺的按空处理，多的丢弃
    const out = header.map((_, i) => (r[i] ?? '').trim());
    return out;
  });
  return { header, rows: body };
}

function splitRows(text: string, delim: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQ = false;
  const src = text.replace(/^\uFEFF/, ''); // 去 BOM，Excel 导出常带

  for (let i = 0; i < src.length; i += 1) {
    const c = src[i];
    if (inQ) {
      if (c === '"') {
        if (src[i + 1] === '"') { cur += '"'; i += 1; continue; }
        inQ = false;
        continue;
      }
      cur += c;
      continue;
    }
    if (c === '"') { inQ = true; continue; }
    if (c === delim) { row.push(cur); cur = ''; continue; }
    if (c === '\n') { row.push(cur); out.push(row); row = []; cur = ''; continue; }
    if (c === '\r') { if (src[i + 1] !== '\n') { row.push(cur); out.push(row); row = []; cur = ''; } continue; }
    cur += c;
  }
  row.push(cur);
  out.push(row);

  // 丢掉完全空的行（Excel 导出末尾常有一行空行）
  return out.filter((r) => !(r.length === 1 && r[0].trim() === ''));
}

/* ------------------------------------------------------------------ */
/* 序列化                                                              */
/* ------------------------------------------------------------------ */

/*
 * 分隔符**不写成默认参数**（`delim = ','`）——
 * strip-ts.py 会把字符串默认值里的 `','` 变成 `', '`（多一个空格），
 * 生成的 .mjs 因此用 ", " 当分隔符：含逗号的单元格不再被引号包住，
 * 往返一次数据就悄悄坏了，而且**不报错**。
 * 这是这个脚本的第八个坑，也是目前最阴险的一个 —— 它改的是数据不是语法。
 * 改成内部取默认，避开这个路径。
 */
export function toCsv(t: Table, delim?: string): string {
  const d = delim && delim.length > 0 ? delim : ',';
  const esc = (v: string) => {
    const s = String(v ?? '');
    if (s.includes('"') || s.includes(d) || s.includes('\n') || s.includes('\r')) {
      return `"${s.split('"').join('""')}"`;
    }
    return s;
  };
  const lines = [t.header.map(esc).join(d)];
  for (const r of t.rows) lines.push(r.map(esc).join(d));
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* 取值                                                                */
/* ------------------------------------------------------------------ */

/** 列名 → 下标。找不到返回 -1 */
export function colIndex(t: Table, name: string): number {
  const key = String(name ?? '').trim();
  return t.header.indexOf(key);
}

/**
 * 把单元格转成数字。
 *
 * 空与非数字按 0 —— 推导表里常有"这一档还没配"的空单元格，
 * 按 0 处理比让整行算不出来好。
 */
export function cellNum(v: string | undefined): number {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!s) return 0;
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/* ------------------------------------------------------------------ */
/* 推导新列                                                            */
/* ------------------------------------------------------------------ */

export type DeriveOutcome = {
  ok: boolean;
  table: Table;
  /** 每行算错的说明（行号从 2 开始，与 Excel 一致） */
  errors: string[];
};

/**
 * 对每一行求值表达式，结果写成新的一列。
 *
 * 表达式里用 `列名` 直接引用该行的值（不用 {{}}，因为这里是数值推导、
 * 不是文本模板，两种语法混在一起会让用户记不住什么时候该加括号）。
 *
 * 某行算错时**不中断整张表** ——
 * 一张 200 行的表因为第 137 行有个空值就全部算不出来，
 * 用户根本没法定位是哪一行。所以收集错误，把该行留空。
 */
export function deriveColumn(
  t: Table,
  newCol: string,
  expr: string,
  opts: { replace?: boolean } = {},
): DeriveOutcome {
  const name = String(newCol ?? '').trim();
  const errors: string[] = [];
  if (!name) return { ok: false, table: t, errors: ['没填新列名'] };
  if (!String(expr ?? '').trim()) return { ok: false, table: t, errors: ['没填公式'] };

  let idx = colIndex(t, name);
  if (idx < 0) {
    const header = [...t.header, name];
    idx = header.length - 1;
    var out: Table = { header, rows: t.rows.map((r) => [...r, '']) };
  } else if (opts.replace === false) {
    /*
     * 列名已存在且不允许覆盖 → 报错。
     * 静默覆盖的话，用户会以为推导出了新列，
     * 实际是把原始数据冲掉了（而且没法撤销）。
     */
    return { ok: false, table: t, errors: [`列「${name}」已经存在了，换个名字或勾选覆盖`] };
  } else {
    var out: Table = { header: [...t.header], rows: t.rows.map((r) => [...r]) };
  }

  const lookup = (row: string[]) => (n: string): number | undefined => {
    const i = colIndex(t, n);
    return i < 0 ? undefined : cellNum(row[i]);
  };

  for (let r = 0; r < out.rows.length; r += 1) {
    const res: ExprResult = evalExpr(expr, lookup(out.rows[r]));
    if (res.ok) {
      out.rows[r][idx] = fmtNum(res.value);
    } else {
      // 行号从 2 开始：第 1 行是表头，与 Excel 显示一致
      errors.push(`第 ${r + 2} 行：${res.error}`);
      out.rows[r][idx] = '';
    }
  }

  return { ok: errors.length === 0, table: out, errors };
}

/* ------------------------------------------------------------------ */
/* 筛选                                                                */
/* ------------------------------------------------------------------ */

export type FilterOutcome = { ok: true; table: Table } | { ok: false; error: string };

/**
 * 按条件筛行。
 *
 * 条件用表达式，结果非 0 视为真 ——
 * 这样 `攻击力 > 100` 和 `攻击力` 都能用，
 * 不必再引入一套比较语法（表达式里已经能做算术，只差真假判定）。
 */
export function filterRows(t: Table, cond: string): FilterOutcome {
  if (!String(cond ?? '').trim()) return { ok: false, error: '没填筛选条件' };

  const lookup = (row: string[]) => (n: string): number | undefined => {
    const i = colIndex(t, n);
    return i < 0 ? undefined : cellNum(row[i]);
  };

  const rows: string[][] = [];
  let firstErr = '';
  for (let r = 0; r < t.rows.length; r += 1) {
    const res = evalExpr(cond, lookup(t.rows[r]));
    if (!res.ok) {
      if (!firstErr) firstErr = `第 ${r + 2} 行：${res.error}`;
      continue;
    }
    if (res.value !== 0) rows.push(t.rows[r]);
  }
  if (firstErr) return { ok: false, error: firstErr };
  return { ok: true, table: { header: [...t.header], rows } };
}

/* ------------------------------------------------------------------ */
/* 聚合                                                                */
/* ------------------------------------------------------------------ */

export type AggOp = 'sum' | 'avg' | 'min' | 'max' | 'count';

/** 对某一列做聚合。列名不存在时报错，不给 0 —— 拼错列名静默得 0 太危险 */
export function aggregate(t: Table, col: string, op: AggOp): { ok: true; value: number } | { ok: false; error: string } {
  const idx = colIndex(t, col);
  if (idx < 0) return { ok: false, error: `没有「${col}」这一列` };
  const nums = t.rows.map((r) => cellNum(r[idx]));
  if (op === 'count') return { ok: true, value: nums.length };
  if (nums.length === 0) return { ok: true, value: 0 };
  let v: number;
  if (op === 'sum') v = nums.reduce((a, b) => a + b, 0);
  else if (op === 'avg') v = nums.reduce((a, b) => a + b, 0) / nums.length;
  else if (op === 'min') v = Math.min(...nums);
  else v = Math.max(...nums);
  return { ok: true, value: v };
}

/* ------------------------------------------------------------------ */
/* 摘要                                                                */
/* ------------------------------------------------------------------ */

/** 给节点卡片显示用：行数 × 列数 + 前几个列名 */
export function tableBrief(t: Table): string {
  if (!t.header.length) return '空表';
  const cols = t.header.slice(0, 3).join(' / ');
  const more = t.header.length > 3 ? ` …` : '';
  return `${t.rows.length} 行 × ${t.header.length} 列 · ${cols}${more}`;
}
