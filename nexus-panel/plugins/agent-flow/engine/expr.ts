/**
 * 表达式求值 —— 游戏数值推导的核心。
 *
 * ================= 为什么自己写 =================
 *
 * 需要的是"用户填一个公式，对表格每一行算出结果"：
 *
 *   攻击力 * (1 + 暴击率) - 防御力 * 0.5
 *
 * eval() 不能用的理由不只是安全：它拿不到行上下文，
 * 而且报错信息是 "SyntaxError: Unexpected token"，用户看不懂。
 *
 * 所以写一个递归下降解析器，约 150 行，换来三件事：
 *   · 能给出人话错误（"第 3 个字符附近多了个右括号"）
 *   · 能支持函数名（round / min / max …）
 *   · 能单测 —— 数值推导算错了不报错，只表现为结果不对，
 *     这是最难发现的一类 bug，必须有测试盯着
 *
 * ================= 支持的语法 =================
 *
 *   数字      123  1.5  .5
 *   变量      攻击力  a  _x      （由调用方替换进来，这里只认标识符）
 *   四则      + - * / % ^
 *   一元      -x
 *   括号      ( )
 *   函数      round(x) min(a,b) max floor ceil abs sqrt pow clamp
 *
 * 刻意**不做**：字符串、比较、逻辑、赋值。
 * 推导列只需要算出数值，做多了反而让错误信息变模糊。
 */

export type ExprResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* 词法                                                                */
/* ------------------------------------------------------------------ */

type Tok =
  | { t: 'num'; v: number }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'comma' };

/** 合法变量名：中英文、数字、下划线、点（点用于 a.b 这种作用域） */
function isNameChar(c: string): boolean {
  return /[A-Za-z0-9_\u4e00-\u9fa5.]/.test(c);
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }

    if (c >= '0' && c <= '9') {
      let j = i;
      let dot = false;
      while (j < src.length) {
        const d = src[j];
        if (d >= '0' && d <= '9') { j += 1; continue; }
        if (d === '.' && !dot) { dot = true; j += 1; continue; }
        break;
      }
      // 支持 1e3 这种科学计数
      if (j < src.length && (src[j] === 'e' || src[j] === 'E')) {
        let k = j + 1;
        if (k < src.length && (src[k] === '+' || src[k] === '-')) k += 1;
        if (k < src.length && src[k] >= '0' && src[k] <= '9') {
          while (k < src.length && src[k] >= '0' && src[k] <= '9') k += 1;
          j = k;
        }
      }
      out.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    // .5 这种以点开头的小数
    if (c === '.' && i + 1 < src.length && src[i + 1] >= '0' && src[i + 1] <= '9') {
      let j = i + 1;
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j += 1;
      out.push({ t: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }

    if (isNameChar(c) && !(c >= '0' && c <= '9')) {
      let j = i;
      while (j < src.length && isNameChar(src[j])) j += 1;
      out.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }

      // 两字符的比较符要先于单字符匹配，否则 >= 会被切成 > 和 =
    const two = src.slice(i, i + 2);
    if (two === '>=' || two === '<=' || two === '==') {
      out.push({ t: 'op', v: two });
      i += 2;
      continue;
    }
    if (c === '!' && src[i + 1] === '=') {
      out.push({ t: 'op', v: '!=' });
      i += 2;
      continue;
    }
    /*
     * 单个 = 当相等用 ——
     * 用户从 Excel 公式里过来习惯写 =，报错不如接受它。
     * 但要在错误信息里说清"赋值不支持"，免得有人写 a = 1 期待赋值生效。
     */
    if ('+-*/%^><'.includes(c)) { out.push({ t: 'op', v: c }); i += 1; continue; }
    if (c === '=') { out.push({ t: 'op', v: '==' }); i += 1; continue; }
    if (c === '(') { out.push({ t: 'lparen' }); i += 1; continue; }
    if (c === ')') { out.push({ t: 'rparen' }); i += 1; continue; }
    if (c === ',') { out.push({ t: 'comma' }); i += 1; continue; }

    // 全角符号是最常见的输入错误，单独提示
    if ('＋－＊／％（）＾，'.includes(c)) {
      throw new ExprError(`这里有全角符号「${c}」，请换成半角`);
    }
    throw new ExprError(`不认识的字符「${c}」（第 ${i + 1} 个字符）`);
  }
  return out;
}

export class ExprError extends Error {}

/* ------------------------------------------------------------------ */
/* 函数                                                                */
/* ------------------------------------------------------------------ */

type Fn = { arity: [number, number]; fn: (xs: number[]) => number };

const FUNCS: Record<string, Fn> = {
  round: { arity: [1, 1], fn: (x) => Math.round(x[0]) },
  floor: { arity: [1, 1], fn: (x) => Math.floor(x[0]) },
  ceil: { arity: [1, 1], fn: (x) => Math.ceil(x[0]) },
  abs: { arity: [1, 1], fn: (x) => Math.abs(x[0]) },
  sqrt: { arity: [1, 1], fn: (x) => Math.sqrt(x[0]) },
  min: { arity: [1, 8], fn: (x) => Math.min(...x) },
  max: { arity: [1, 8], fn: (x) => Math.max(...x) },
  pow: { arity: [2, 2], fn: (x) => Math.pow(x[0], x[1]) },
  /** clamp(v, lo, hi) —— 数值推导里钳制上下限极常用 */
  clamp: { arity: [3, 3], fn: (x) => Math.min(Math.max(x[0], x[1]), x[2]) },
  /** 随机：0~1。给了会让每次运行结果不同，属于有意为之 */
  rand: { arity: [0, 0], fn: () => Math.random() },
};

export function funcNames(): string[] {
  return Object.keys(FUNCS);
}

/* ------------------------------------------------------------------ */
/* 解析与求值                                                          */
/* ------------------------------------------------------------------ */

/**
 * 取变量值。返回 undefined 表示"没这个变量" ——
 * 与"值为 0"必须区分开，否则用户拼错列名会静默算成 0。
 */
export type VarLookup = (name: string) => number | undefined;

export function evalExpr(src: string, vars: VarLookup | Record<string, number> = {}): ExprResult {
  const lookup: VarLookup = typeof vars === 'function'
    ? vars
    : (n) => (vars as Record<string, number>)[n];
  try {
    const toks = tokenize(src);
    if (toks.length === 0) return { ok: false, error: '表达式是空的' };

    /*
     * 递归下降解析写成**闭包函数**而不是 class ——
     * strip-ts.py 处理不了 class 里带类型注解的方法签名
     * （会原样留下 `peek(): Tok | undefined {`，生成的 .mjs 直接语法错误）。
     * 这是这个脚本的第七个坑，改用闭包绕开。
     */
    let pos = 0;
    const peek = () => toks[pos];
    const next = () => toks[pos++];

    const expectEnd = (): void => {
      const t = peek();
      if (t) throw new ExprError(`算式后面多了点东西（${describe(t)}）`);
    };

    const parseAtom = (): number => {
      const t = next();
      if (!t) throw new ExprError('算式没写完');
      if (t.t === 'num') return t.v;

      if (t.t === 'lparen') {
        const v = parseExpr();
        const close = next();
        if (!close || close.t !== 'rparen') throw new ExprError('括号没闭合');
        return v;
      }
      if (t.t === 'op' && t.v === '-') return -parseAtom();

      if (t.t === 'name') {
        if (peek() && peek()?.t === 'lparen') return callFunc(t.v);
        const v = lookup(t.v);
        /*
         * 变量没找到 —— 明确报错。
         * 静默当 0 的话，用户把"攻击力"写成"功击力"会得到一个
         * 看着合理但完全错误的结果，这是数值推导里最危险的一类错误。
         */
        if (v === undefined) throw new ExprError(`不认识的变量「${t.v}」—— 检查列名是否写对了`);
        return v;
      }
      throw new ExprError(`这里不该出现 ${describe(t)}`);
    };

    const callFunc = (name: string): number => {
      next(); // 吃掉左括号
      const args: number[] = [];
      const close = peek();
      if (close && close.t === 'rparen') {
        next();
      } else {
        for (;;) {
          args.push(parseExpr());
          const t = next();
          if (!t) throw new ExprError(`函数 ${name} 的括号没闭合`);
          if (t.t === 'rparen') break;
          if (t.t !== 'comma') throw new ExprError(`函数 ${name} 的参数之间要用逗号分隔`);
        }
      }
      const f = FUNCS[name];
      if (!f) {
        throw new ExprError(`不认识的函数「${name}」，可用：${Object.keys(FUNCS).join(' / ')}`);
      }
      if (args.length < f.arity[0] || args.length > f.arity[1]) {
        const need = f.arity[0] === f.arity[1]
          ? `${f.arity[0]} 个`
          : `${f.arity[0]}~${f.arity[1]} 个`;
        throw new ExprError(`函数 ${name} 需要 ${need}参数，这里给了 ${args.length} 个`);
      }
      return f.fn(args);
    };

    /** 幂运算右结合：2^3^2 = 2^(3^2) */
    const parsePower = (): number => {
      const base = parseAtom();
      const t = peek();
      if (t && t.t === 'op' && t.v === '^') {
        next();
        return Math.pow(base, parseUnary());
      }
      return base;
    };

    const parseUnary = (): number => {
      const t = peek();
      if (t && t.t === 'op' && (t.v === '-' || t.v === '+')) {
        next();
        const v = parseUnary();
        return t.v === '-' ? -v : v;
      }
      return parsePower();
    };

    const parseMulDiv = (): number => {
      let left = parseUnary();
      for (;;) {
        const t = peek();
        if (t && t.t === 'op' && '*/%'.includes(t.v)) {
          next();
          const right = parseUnary();
          if (t.v === '*') left *= right;
          /*
           * 除零当 0，不报错 ——
           * 推导表里常有空行或 0 防御力的边界行，
           * 报错会让整张表算不出来，而 0 是这类场景可接受的答案。
           */
          else if (t.v === '/') left = right === 0 ? 0 : left / right;
          else left = right === 0 ? 0 : left % right;
          continue;
        }
        return left;
      }
    };

    /** 比较运算，优先级最低。成立返回 1，不成立返回 0 */
    const parseCompare = (): number => {
      let left = parseAddSub();
      for (;;) {
        const t = peek();
        if (t && t.t === 'op' && ['>', '>=', '<', '<=', '==', '!='].includes(t.v)) {
          next();
          const right = parseAddSub();
          if (t.v === '>') left = left > right ? 1 : 0;
          else if (t.v === '>=') left = left >= right ? 1 : 0;
          else if (t.v === '<') left = left < right ? 1 : 0;
          else if (t.v === '<=') left = left <= right ? 1 : 0;
          else if (t.v === '==') left = left === right ? 1 : 0;
          else left = left !== right ? 1 : 0;
          continue;
        }
        return left;
      }
    };

    const parseAddSub = (): number => {
      let left = parseMulDiv();
      for (;;) {
        const t = peek();
        if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
          next();
          const right = parseMulDiv();
          left = t.v === '+' ? left + right : left - right;
          continue;
        }
        return left;
      }
    };

    const parseExpr = (): number => {
      let left = parseCompare();
      for (;;) {
        const t = peek();
        if (t && t.t === 'op' && (t.v === '+' || t.v === '-')) {
          next();
          const right = parseMulDiv();
          left = t.v === '+' ? left + right : left - right;
          continue;
        }
        return left;
      }
    };

    const v = parseExpr();
    expectEnd();
    if (!Number.isFinite(v)) return { ok: false, error: '算出来的结果不是有效数字（可能是除零）' };
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof ExprError) return { ok: false, error: e.message };
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

function describe(t: Tok): string {
  if (t.t === 'num') return `数字 ${t.v}`;
  if (t.t === 'name') return `「${t.v}」`;
  if (t.t === 'op') return `运算符 ${t.v}`;
  if (t.t === 'lparen') return '左括号';
  if (t.t === 'rparen') return '右括号';
  return '逗号';
}

/**
 * 格式化输出数值。
 *
 * 整数不显示小数点（显示成 2.0 会让下游按文本比对时匹配不上），
 * 小数最多 10 位，避免 0.1+0.2 的浮点尾巴。
 */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toFixed(10)));
}
