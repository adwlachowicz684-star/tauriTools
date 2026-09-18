/**
 * Excel 批量写入的规划与风险检查。
 *
 * ================= 为什么需要这一层 =================
 *
 * "几千万条公式"这件事，直接调 MCP 工具逐格写是行不通的：
 * 一次工具调用写一格，几千万次调用 —— 光往返就几个小时。
 *
 * 可行的做法是**写模板到范围**：Excel 自己把公式填下去（相对引用自动递增）。
 * 于是真正的工作单元从"单元格"变成"模板 + 范围"，
 * 数量从几千万降到几百 —— 这就是这套东西能成立的前提。
 *
 * 这一层只做**规划与检查**（纯逻辑，可单测），不碰任何具体通道：
 * MCP 实时（COM 驱动真 Excel）与文件型（openpyxl）共用同一份计划。
 *
 * ================= 三个会静默毁掉结果的坑 =================
 *
 * ① 易失函数（OFFSET / INDIRECT / TODAY / NOW / RAND …）
 *    每次改动都触发**全表重算**。几十万格时只是卡，
 *    几千万格时直接"Excel 资源不足"，而且不告诉你哪条公式的锅。
 *
 * ② 全列引用（A:A / SUM(A:A)）
 *    强制扫描 1048576 行。有 100 条这样的公式就是一亿次运算。
 *
 * ③ 批量写入时不切手动计算
 *    每写一次范围 Excel 就重算一次 —— 几百次写入 = 几百次全表重算。
 *    正确做法：写之前切手动、写完再算一次、最后切回自动。
 */

/* ------------------------------------------------------------------ */
/* Excel 的硬上限                                                      */
/* ------------------------------------------------------------------ */

/** 单个工作表的最大行数 */
export const MAX_ROWS = 1048576;
/** 单个工作表的最大列数 */
export const MAX_COLS = 16384;

/* ------------------------------------------------------------------ */
/* 易失函数                                                            */
/* ------------------------------------------------------------------ */

/**
 * 易失函数清单 —— 每次重算都会重新求值，不只在依赖变化时。
 *
 * 这份清单必须显式维护：Excel 不会告诉你"这条公式是易失的"，
 * 而它的代价在几千万格时才暴露出来。
 */
export const VOLATILE_FUNCS = [
  'OFFSET', 'INDIRECT', 'TODAY', 'NOW', 'RAND', 'RANDBETWEEN',
  'CELL', 'INFO', 'AREAS', 'INDEX',
] as const;

export type FuncHit = { name: string; at: number };

/**
 * 找出公式里的函数调用。
 *
 * 只在**括号外**匹配标识符 ——
 * 简单按 /\w+\(/ 扫的话，字符串常量里的 "abc(" 会被误判成函数，
 * 而在数值推导里这种误报会让人去改一条根本没问题的公式。
 */
export function findFuncs(formula: string): FuncHit[] {
  const out: FuncHit[] = [];
  const src = String(formula ?? '');
  let i = 0;
  let inStr = false;
  let buf = '';
  for (let p = 0; p < src.length; p += 1) {
    const c = src[p];
    if (c === '"') { inStr = !inStr; buf = ''; continue; }
    if (inStr) continue;

    if (/[A-Za-z_]/.test(c)) { buf += c; continue; }

    if (c === '(' && buf.length > 0) {
      // 前面跟了 sheet 引用或单元格地址（如 Sheet1! 或 A1:）的不算函数
      const prev = src.slice(0, p - buf.length).trimEnd();
      const lastChar = prev.slice(-1);
      const isRef = lastChar === '!' || /[0-9$]/.test(lastChar) || prev.endsWith('$');
      if (!isRef) out.push({ name: buf.toUpperCase(), at: p - buf.length });
      buf = '';
      continue;
    }
    buf = '';
    i = p;
  }
  void i;
  return out;
}

/** 找出易失函数 */
export function findVolatile(formula: string): FuncHit[] {
  const set = new Set<string>(VOLATILE_FUNCS);
  return findFuncs(formula).filter((f) => set.has(f.name));
}

/* ------------------------------------------------------------------ */
/* 全列引用                                                            */
/* ------------------------------------------------------------------ */

export type FullColHit = { ref: string; at: number };

/**
 * 找出全列引用（A:A / $A:$A / A:B）。
 *
 * 不匹配单元格区域（A1:A100）—— 那是正确写法。
 * 只匹配形如 A:A 这种没有行号的引用。
 */
export function findFullColRefs(formula: string): FullColHit[] {
  const src = String(formula ?? '');
  const out: FullColHit[] = [];
  const re = /(\$?[A-Z]{1,3})\s*:\s*(\$?[A-Z]{1,3})(?![0-9])/g;
  for (;;) {
    const m = re.exec(src);
    if (!m) break;
    // 后面紧跟数字说明是 A1:B2 这种，不是全列
    const after = src.slice(m.index + m[0].length);
    if (/^\s*[0-9]/.test(after)) continue;
    if (/^[A-Z]{1,3}\s*[0-9]/.test(after)) continue;
    out.push({ ref: m[0], at: m.index });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 范围解析                                                            */
/* ------------------------------------------------------------------ */

export type CellRef = { col: number; row: number };

/** "A1" / "$B$12" → {col,row}，列从 1 开始 */
export function parseCellRef(s: string): CellRef | null {
  const m = /^\$?([A-Za-z]{1,3})\$?([0-9]{1,7})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const col = colToNum(m[1].toUpperCase());
  const row = Number(m[2]);
  if (col < 1 || row < 1) return null;
  return { col, row };
}

export function colToNum(letters: string): number {
  let n = 0;
  for (const ch of String(letters ?? '')) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n;
}

export function numToCol(n: number): string {
  let out = '';
  let x = Math.max(1, Math.floor(n));
  while (x > 0) {
    const r = (x - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    x = Math.floor((x - 1) / 26);
  }
  return out;
}

export type Range = {
  sheet?: string;
  from: CellRef;
  to: CellRef;
};

/** "Sheet1!A2:A1000" / "A2:A1000" */
export function parseRange(s: string): Range | null {
  const src = String(s ?? '').trim();
  if (!src) return null;
  const bang = src.lastIndexOf('!');
  let sheet: string | undefined;
  let body = src;
  if (bang >= 0) {
    sheet = src.slice(0, bang).replace(/^'|'$/g, '');
    body = src.slice(bang + 1);
  }
  const parts = body.split(':');
  const from = parseCellRef(parts[0] ?? '');
  if (!from) return null;
  const to = parts.length > 1 ? parseCellRef(parts[1]) : from;
  if (!to) return null;
  return { sheet, from, to };
}

/** 单元格数 */
export function rangeSize(r: Range): number {
  const rows = Math.abs(r.to.row - r.from.row) + 1;
  const cols = Math.abs(r.to.col - r.from.col) + 1;
  return rows * cols;
}

/* ------------------------------------------------------------------ */
/* 分片                                                                */
/* ------------------------------------------------------------------ */

export type Shard = {
  sheet: string;
  from: CellRef;
  to: CellRef;
  cells: number;
};

/**
 * 把一大块按行分片，保证每片不超过单个工作表的行数上限。
 *
 * 几千万格必然超出一张表（1048576 行上限），所以必须分片。
 * 不自动分的话，写一半会失败 —— 而失败时前面已写的还在，
 * 得到一个写了一半的表，比完全没写更难处理。
 */
export function shardByRows(
  totalRows: number,
  firstRow: number,
  colFrom: number,
  colTo: number,
  sheetNamer: (i: number) => string,
  maxRows = MAX_ROWS,
): Shard[] {
  const rows = Math.max(0, Math.floor(totalRows));
  if (rows === 0) return [];
  const cap = Math.max(1, Math.floor(maxRows));
  const out: Shard[] = [];
  let left = rows;
  let cursor = Math.max(1, Math.floor(firstRow));
  let idx = 0;
  while (left > 0) {
    const sheet = sheetNamer(idx);
    // 这一片能写多少行：受总剩余与"本表从 cursor 起还剩多少"双重限制
    const roomInSheet = cap - cursor + 1;
    const take = Math.min(left, Math.max(1, roomInSheet));
    out.push({
      sheet,
      from: { col: colFrom, row: cursor },
      to: { col: colTo, row: cursor + take - 1 },
      cells: take * Math.abs(colTo - colFrom + 1),
    });
    left -= take;
    // 下一片从新表的第 firstRow 行开始
    cursor = Math.max(1, Math.floor(firstRow));
    idx += 1;
    if (idx > 5000) break; // 安全阀，避免异常输入导致死循环
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 计划                                                                */
/* ------------------------------------------------------------------ */

export type Step =
  | { kind: 'setCalc'; mode: 'manual' | 'automatic' }
  | { kind: 'writeFormula'; sheet: string; ref: string; formula: string; cells: number }
  | { kind: 'recalc' }
  | { kind: 'save' };

export type Risk = {
  level: 'warn' | 'block';
  message: string;
};

export type BatchPlan = {
  steps: Step[];
  totalCells: number;
  shards: number;
  risks: Risk[];
};

/**
 * 生成"填充一整列"的写入计划。
 *
 * 核心是三步夹心：**手动计算 → 批量写 → 重算一次 → 恢复自动**。
 * 少了第一步，几百次写入会触发几百次全表重算；
 * 少了最后一步，用户会得到一个"改了参数不动"的表而毫无线索。
 */
export function planFillDown(opts: {
  sheet: string;
  startRef: string;
  rows: number;
  formula: string;
  cols?: number;
  sheetNamer?: (i: number) => string;
  save?: boolean;
}): BatchPlan {
  const risks: Risk[] = [];
  const formula = String(opts.formula ?? '').trim();
  const rows = Math.max(0, Math.floor(opts.rows ?? 0));

  if (!formula) {
    risks.push({ level: 'block', message: '没填公式' });
  }
  /*
   * 公式不带 = 开头时**补上**，不报错 ——
   * 用户从 Excel 复制出来的是不带 = 的，报错很不友好。
   * 但要在风险里说一句，免得有人故意想写文本。
   */
  const normalized = formula && !formula.startsWith('=') ? `=${formula}` : formula;

  const start = parseCellRef(opts.startRef);
  if (!start) risks.push({ level: 'block', message: `起始单元格「${opts.startRef}」看不懂` });

  if (rows > MAX_ROWS) {
    risks.push({
      level: 'warn',
      message: `${rows} 行超过单表上限 ${MAX_ROWS}，会拆到多张表`,
    });
  }

  /* 易失函数 —— 在这个规模下是硬伤 */
  const vol = findVolatile(normalized);
  if (vol.length > 0) {
    risks.push({
      level: 'warn',
      message: `公式里有易失函数 ${vol.map((v) => v.name).join(' / ')} —— 每次改动都会全表重算，${rows} 行规模下会卡死`,
    });
  }

  /* 全列引用 */
  const full = findFullColRefs(normalized);
  if (full.length > 0) {
    risks.push({
      level: 'warn',
      message: `公式里有全列引用 ${full.map((f) => f.ref).join(' / ')} —— 每次都要扫 ${MAX_ROWS} 行，建议改成限定区域`,
    });
  }

  if (risks.some((r) => r.level === 'block')) {
    return { steps: [], totalCells: 0, shards: 0, risks };
  }

  const c0 = start!.col;
  const cols = Math.max(1, Math.floor(opts.cols ?? 1));
  const c1 = c0 + cols - 1;
  if (c1 > MAX_COLS) {
    risks.push({ level: 'block', message: `列数超出上限 ${MAX_COLS}` });
    return { steps: [], totalCells: 0, shards: 0, risks };
  }

  const namer = opts.sheetNamer ?? ((i: number) => (i === 0 ? opts.sheet : `${opts.sheet}_${i + 1}`));
  const shards = shardByRows(rows, start!.row, c0, c1, namer);

  const steps: Step[] = [{ kind: 'setCalc', mode: 'manual' }];
  for (const s of shards) {
    const ref = `${colLetter(c0)}${s.from.row}:${colLetter(c1)}${s.to.row}`;
    steps.push({
      kind: 'writeFormula',
      sheet: s.sheet,
      ref,
      formula: normalized,
      cells: s.cells,
    });
  }
  steps.push({ kind: 'setCalc', mode: 'automatic' });
  steps.push({ kind: 'recalc' });
  if (opts.save !== false) steps.push({ kind: 'save' });

  const totalCells = shards.reduce((a, s) => a + s.cells, 0);
  if (totalCells === 0) {
    risks.push({ level: 'warn', message: '行数为 0，没有要写的单元格' });
  }

  return { steps, totalCells, shards: shards.length, risks };
}

function colLetter(n: number): string {
  return numToCol(n);
}

/* ------------------------------------------------------------------ */
/* 外部链接陈旧判定                                                    */
/* ------------------------------------------------------------------ */

export type ExternalLink = {
  /** 源工作簿路径 */
  source: string;
  /** 缓存里记录的源最后修改时间（毫秒）；没有就填 0 */
  cachedMtime?: number;
  /** 源的当前最后修改时间（毫秒）；文件不存在时填 null */
  currentMtime?: number | null;
  /** Excel 是否报告"链接已断开" */
  broken?: boolean;
};

export type LinkState = {
  source: string;
  stale: boolean;
  missing: boolean;
  reason: string;
};

/**
 * 判断外部链接是否陈旧。
 *
 * 这是"多工作簿同步"里最容易出事的一环：
 * 源文件没打开时，Excel 用的是**缓存值**。如果源改过而没刷新，
 * 表里显示的是旧数 —— **不报错，看着还挺合理**。
 *
 * 所以必须显式判定并说出来，而不是默默信任。
 */
export function checkLinks(links: ExternalLink[]): LinkState[] {
  const out: LinkState[] = [];
  for (const l of links ?? []) {
    const src = String(l.source ?? '').trim();
    if (!src) continue;

    if (l.broken === true) {
      out.push({ source: src, stale: true, missing: true, reason: 'Excel 报告链接已断开' });
      continue;
    }
    if (l.currentMtime === null || l.currentMtime === undefined) {
      out.push({
        source: src, stale: true, missing: true,
        reason: '源文件不存在（可能在别的机器上，或路径变了）',
      });
      continue;
    }
    const cached = Number(l.cachedMtime ?? 0);
    const cur = Number(l.currentMtime);
    if (cached > 0 && cur > cached) {
      out.push({
        source: src, stale: true, missing: false,
        reason: `源文件比缓存新 —— 表里是旧值，刷新后才能用上新数据`,
      });
      continue;
    }
    out.push({ source: src, stale: false, missing: false, reason: '与源一致' });
  }
  return out;
}

/** 有没有陈旧的链接。给节点决定"要不要继续"用 */
export function anyStale(states: LinkState[]): boolean {
  return (states ?? []).some((s) => s.stale);
}
