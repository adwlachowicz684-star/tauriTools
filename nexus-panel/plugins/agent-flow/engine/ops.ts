/**
 * 运算节点的纯逻辑。
 *
 * ================= 为什么单独一层 =================
 *
 * Scratch 有整整一类"运算符"积木（加减乘除、连接字符串、随机数、比较）。
 * 本插件此前完全没有对应物 —— 要算个数只能靠模板拼字符串，
 * 而模板**不会真的计算**，`{{a.output}}` 取出来永远是文本。
 *
 * 抽成纯逻辑是为了能单测：运算的规则细节多（除零、小数位、比较的类型），
 * 混在组件里就只能靠手点验证。
 *
 * ================= 数字解析的取舍 =================
 *
 * 上游给的是**文本**，运算要的是数字。
 * 解析不出来的统一当 0 而不是报错 —— 报错会让"上游偶尔返回空"的流程
 * 频繁失败，而多数场景里空值按 0 处理是可接受的。
 * 但**除法除零**是明确报错的，因为结果没有合理默认值。
 */

export type MathOp =
  | 'add' | 'sub' | 'mul' | 'div' | 'mod'
  | 'min' | 'max' | 'round' | 'floor' | 'ceil' | 'abs';

export type TextOp =
  | 'concat' | 'length' | 'upper' | 'lower' | 'trim'
  | 'replace' | 'substr' | 'split' | 'join' | 'repeat';

export type CompareOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'startsWith' | 'endsWith';

export type RandomOp = 'int' | 'float' | 'pick' | 'shuffle' | 'bool';

/** 运算结果：要么成功出值，要么给出人话错误 */
export type OpResult = { ok: true; value: string } | { ok: false; error: string };

function ok(value: string): OpResult {
  return { ok: true, value };
}

function bad(error: string): OpResult {
  return { ok: false, error };
}

/* ------------------------------------------------------------------ */
/* 数字                                                                */
/* ------------------------------------------------------------------ */

/**
 * 文本转数字。
 *
 * 空串与非数字都当 0 —— 见文件头的取舍说明。
 * 支持百分号与千分位逗号，因为上游经常给出这类格式。
 */
export function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!s) return 0;
  if (s.endsWith('%')) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n / 100 : 0;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 格式化输出。
 *
 * 整数不显示小数点（`2` 而不是 `2.0`）——
 * 显示成 2.0 会让下游比较节点按文本比对时匹配不上。
 * 小数最多保留 10 位，避免 0.1+0.2 那种浮点尾巴。
 */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(10)));
}

export function mathOp(op: MathOp, a: unknown, b: unknown): OpResult {
  const x = num(a);
  const y = num(b);
  switch (op) {
    case 'add': return ok(fmt(x + y));
    case 'sub': return ok(fmt(x - y));
    case 'mul': return ok(fmt(x * y));
    case 'div':
      if (y === 0) return bad('除数为 0');
      return ok(fmt(x / y));
    case 'mod':
      if (y === 0) return bad('取余的除数为 0');
      return ok(fmt(x % y));
    case 'min': return ok(fmt(Math.min(x, y)));
    case 'max': return ok(fmt(Math.max(x, y)));
    case 'round': return ok(fmt(Math.round(x)));
    case 'floor': return ok(fmt(Math.floor(x)));
    case 'ceil': return ok(fmt(Math.ceil(x)));
    case 'abs': return ok(fmt(Math.abs(x)));
    default: return bad(`未知的数学运算：${String(op)}`);
  }
}

/* ------------------------------------------------------------------ */
/* 文本                                                                */
/* ------------------------------------------------------------------ */

/**
 * 取子串的起止位置用的是 1-based ——
 * Scratch 就是这么做的，用户数"第 3 个字符"时不会想到下标是 2。
 * 越界不报错，按空处理。
 */
export function textOp(op: TextOp, a: unknown, b: unknown, c: unknown = ''): OpResult {
  const s = String(a ?? '');
  const t = String(b ?? '');
  switch (op) {
    case 'concat': return ok(s + t);
    case 'length': return ok(String(s.length));
    case 'upper': return ok(s.toUpperCase());
    case 'lower': return ok(s.toLowerCase());
    case 'trim': return ok(s.trim());
    case 'replace':
      /*
       * 只替换第一个还是全部？
       * 默认全部 —— 只换第一个的话，用户面对"怎么还有没换的"会更困惑。
       * 需要精确控制时 b 可以写成正则，但那属于少数场景。
       */
      return ok(t ? s.split(t).join(String(c ?? '')) : s);
    case 'substr': {
      const from = Math.max(1, Math.round(num(b)));
      const toRaw = Math.round(num(c));
      const to = toRaw > 0 ? toRaw : s.length;
      return ok(s.slice(from - 1, to));
    }
    case 'split': {
      const sep = t || ',';
      const part = Math.round(num(c)) - 1;
      const parts = s.split(sep);
      if (part < 0) return ok(s);
      return ok(parts[part] ?? '');
    }
    case 'join': {
      // 把 a 按逗号拆开，用 b 连起来（如把列表转成一行）
      const parts = s.split(',').map((p) => p.trim());
      return ok(parts.join(t));
    }
    case 'repeat': {
      const n = Math.round(num(b));
      if (n < 0) return bad('重复次数不能为负');
      if (n > 10000) return bad('重复次数太大（上限 10000）');
      return ok(s.repeat(n));
    }
    default: return bad(`未知的文本运算：${String(op)}`);
  }
}

/* ------------------------------------------------------------------ */
/* 比较                                                                */
/* ------------------------------------------------------------------ */

/**
 * 两边都能转成数字就按数字比，否则按文本比。
 *
 * 不这么做的话 "10" < "9" 会成立（字符串比较），
 * 而这种错误**不报错**，只是结果反了，极难发现。
 */
export function compareOp(op: CompareOp, a: unknown, b: unknown): OpResult {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  const bothNum = isNumeric(sa) && isNumeric(sb);
  const x = bothNum ? num(sa) : 0;
  const y = bothNum ? num(sb) : 0;

  let r: boolean;
  switch (op) {
    case 'eq': r = bothNum ? x === y : sa === sb; break;
    case 'neq': r = bothNum ? x !== y : sa !== sb; break;
    case 'gt': r = bothNum ? x > y : sa > sb; break;
    case 'gte': r = bothNum ? x >= y : sa >= sb; break;
    case 'lt': r = bothNum ? x < y : sa < sb; break;
    case 'lte': r = bothNum ? x <= y : sa <= sb; break;
    case 'contains': r = sa.includes(sb); break;
    case 'startsWith': r = sa.startsWith(sb); break;
    case 'endsWith': r = sa.endsWith(sb); break;
    default: return bad(`未知的比较运算：${String(op)}`);
  }
  /*
   * 输出 'true' / 'false' 而不是空 ——
   * 空串在条件节点里会被当成"没内容"，从而走错分支。
   */
  return ok(r ? 'true' : 'false');
}

function isNumeric(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return Number.isFinite(Number(t));
}

/* ------------------------------------------------------------------ */
/* 随机                                                                */
/* ------------------------------------------------------------------ */

/**
 * @param rng 可注入的随机源，测试时传固定序列
 */
export function randomOp(
  op: RandomOp, a: unknown, b: unknown, rng: () => number = Math.random,
): OpResult {
  switch (op) {
    case 'int': {
      const lo = Math.round(num(a));
      const hi = Math.round(num(b));
      if (lo > hi) return bad('随机整数的最小值大于最大值');
      return ok(String(Math.floor(rng() * (hi - lo + 1)) + lo));
    }
    case 'float': {
      const lo = num(a);
      const hi = num(b);
      if (lo > hi) return bad('随机小数的最小值大于最大值');
      return ok(fmt(rng() * (hi - lo) + lo));
    }
    case 'pick': {
      const items = String(a ?? '').split(',').map((s) => s.trim()).filter((s) => s);
      if (items.length === 0) return bad('没有可选项（用逗号分隔填写）');
      const i = Math.floor(rng() * items.length);
      return ok(items[Math.min(i, items.length - 1)]);
    }
    case 'shuffle': {
      const items = String(a ?? '').split(',').map((s) => s.trim()).filter((s) => s);
      if (items.length === 0) return bad('没有可打乱的项（用逗号分隔填写）');
      // Fisher-Yates
      for (let i = items.length - 1; i > 0; i -= 1) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = items[i];
        items[i] = items[j];
        items[j] = tmp;
      }
      return ok(items.join(','));
    }
    case 'bool': return ok(rng() < 0.5 ? 'false' : 'true');
    default: return bad(`未知的随机运算：${String(op)}`);
  }
}

/** 卡片上一句话摘要：让节点不点开也能看出在算什么 */
export function opSummary(kind: string, op: string): string {
  const map: Record<string, Record<string, string>> = {
    math: {
      add: '＋', sub: '－', mul: '×', div: '÷', mod: '取余',
      min: '取较小', max: '取较大', round: '四舍五入', floor: '向下取整',
      ceil: '向上取整', abs: '绝对值',
    },
    text: {
      concat: '拼接', length: '取长度', upper: '转大写', lower: '转小写',
      trim: '去空格', replace: '替换', substr: '取子串', split: '取第几段',
      join: '连接列表', repeat: '重复',
    },
    compare: {
      eq: '等于', neq: '不等于', gt: '大于', gte: '大于等于', lt: '小于',
      lte: '小于等于', contains: '包含', startsWith: '开头是', endsWith: '结尾是',
    },
    random: {
      int: '随机整数', float: '随机小数', pick: '随机选一个',
      shuffle: '打乱顺序', bool: '随机真假',
    },
  };
  return map[kind]?.[op] ?? op;
}
