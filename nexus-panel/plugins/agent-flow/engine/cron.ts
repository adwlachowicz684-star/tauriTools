/**
 * 最小可用的 5 段 cron 解析器。
 *
 * 格式：分 时 日 月 周
 *   minute  0-59
 *   hour    0-23
 *   dom     1-31
 *   month   1-12
 *   dow     0-7（0 和 7 都表示周日）
 *
 * 支持：星号、星号/n、a、a-b、a-b/n、逗号分隔列表
 *
 * 关于 dom 与 dow 的关系，遵循标准 cron 的 OR 规则：
 * 两者都被限制（都不是 `*`）时取并集；否则取交集。
 * 例如 `0 0 1 * 1` = 每月 1 号 **或** 每周一 的 00:00。
 */

export type CronField = { any: boolean; values: Set<number> };

export type CronExpr = {
  minute: CronField;
  hour: CronField;
  dom: CronField;
  month: CronField;
  dow: CronField;
};

const NAMED_MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const NAMED_DAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

/** 解析单个字段。返回 null 表示语法错误。 */
function parseField(spec: string, min: number, max: number, named?: Record<string, number>): CronField | null {
  const raw = spec.trim().toLowerCase();
  if (raw === '' ) return null;
  if (raw === '*') return { any: true, values: new Set() };

  const values = new Set<number>();

  for (const part of raw.split(',')) {
    if (part === '') return null;

    const [rangePart, stepPart] = part.split('/');
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) return null;

    let lo: number;
    let hi: number;

    if (rangePart === '*') {
      lo = min; hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = named?.[a] ?? Number(a);
      hi = named?.[b] ?? Number(b);
      if (!Number.isInteger(lo) || !Number.isInteger(hi)) return null;
    } else {
      const v = named?.[rangePart] ?? Number(rangePart);
      if (!Number.isInteger(v)) return null;
      lo = v; hi = stepPart === undefined ? v : max;
    }

    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) values.add(v);
  }

  if (values.size === 0) return null;
  return { any: false, values };
}

/** 解析完整表达式。返回 null 表示非法。 */
export function parseCron(expr: string): CronExpr | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;

  const [mi, ho, dm, mo, dw] = parts;
  const minute = parseField(mi, 0, 59);
  const hour = parseField(ho, 0, 23);
  const dom = parseField(dm, 1, 31);
  const month = parseField(mo, 1, 12, NAMED_MONTHS);
  const dowRaw = parseField(dw, 0, 7, NAMED_DAYS);

  if (!minute || !hour || !dom || !month || !dowRaw) return null;

  // 把 dow 的 7 归一化为 0（周日）
  const dowValues = new Set<number>();
  for (const v of dowRaw.values) dowValues.add(v === 7 ? 0 : v);

  return {
    minute, hour, dom, month,
    dow: { any: dowRaw.any, values: dowValues },
  };
}

/** 校验并给出人话错误，用于界面提示 */
export function validateCron(expr: string): { ok: true } | { ok: false; error: string } {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return { ok: false, error: `需要 5 段（分 时 日 月 周），当前 ${parts.length} 段` };
  }
  return parseCron(expr)
    ? { ok: true }
    : { ok: false, error: '存在无法解析的字段，检查取值范围（分0-59 时0-23 日1-31 月1-12 周0-7）' };
}

function hit(f: CronField, v: number): boolean {
  return f.any || f.values.has(v);
}

/** 判断某个时刻是否命中表达式（秒必须为 0 才可能命中） */
export function cronMatches(expr: CronExpr, d: Date): boolean {
  if (d.getSeconds() !== 0) return false;
  if (!hit(expr.minute, d.getMinutes())) return false;
  if (!hit(expr.hour, d.getHours())) return false;
  if (!hit(expr.month, d.getMonth() + 1)) return false;

  const domRestricted = !expr.dom.any;
  const dowRestricted = !expr.dow.any;
  const domOk = hit(expr.dom, d.getDate());
  const dowOk = hit(expr.dow, d.getDay());
  // 都被限制 → 并集；否则 → 交集
  return domRestricted && dowRestricted ? domOk || dowOk : domOk && dowOk;
}

const DAY_MS = 86_400_000;

/**
 * 求 from 之后的下一个触发时刻（严格晚于 from，且秒为 0）。
 * 找不到（表达式无解）时返回 null。
 */
export function nextRun(expr: string, from: Date = new Date()): Date | null {
  const parsed = parseCron(expr);
  if (!parsed) return null;

  // 从下一分钟整点开始找
  const start = new Date(from.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  for (let dayOffset = 0; dayOffset < 366; dayOffset++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + dayOffset);
    if (!hit(parsed.month, d.getMonth() + 1)) continue;

    const domRestricted = !parsed.dom.any;
    const dowRestricted = !parsed.dow.any;
    const domOk = hit(parsed.dom, d.getDate());
    const dowOk = hit(parsed.dow, d.getDay());
    if (domRestricted && dowRestricted ? !(domOk || dowOk) : !(domOk && dowOk)) continue;

    const startHour = dayOffset === 0 ? start.getHours() : 0;
    for (let h = startHour; h <= 23; h++) {
      if (!hit(parsed.hour, h)) continue;
      const startMin = dayOffset === 0 && h === start.getHours() ? start.getMinutes() : 0;
      for (let m = startMin; m <= 59; m++) {
        if (!hit(parsed.minute, m)) continue;
        const r = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0, 0);
        // 跨夏令时/月份溢出等边界：确保严格晚于 from
        if (r.getTime() > from.getTime()) return r;
      }
    }
  }
  return null;
}

/** 给界面用的中文描述（尽力而为，覆盖常见写法） */
export function describeCron(expr: string): string {
  const p = parseCron(expr);
  if (!p) return '无效的 cron 表达式';

  const seg: string[] = [];
  if (p.minute.any) seg.push('每分钟');
  else seg.push(`在 ${[...p.minute.values].sort((a, b) => a - b).join('、')} 分`);

  if (!p.hour.any) seg.push(`${[...p.hour.values].sort((a, b) => a - b).join('、')} 点`);
  if (!p.dom.any) seg.push(`每月 ${[...p.dom.values].sort((a, b) => a - b).join('、')} 号`);
  if (!p.month.any) seg.push(`${[...p.month.values].sort((a, b) => a - b).join('、')} 月`);

  if (!p.dow.any) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    seg.push([...p.dow.values].sort((a, b) => a - b).map((v) => names[v]).join('、'));
  }
  return seg.join('，');
}

export { DAY_MS };
