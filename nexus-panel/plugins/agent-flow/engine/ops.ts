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

/* ------------------------------------------------------------------ */
/* 卡片摘要                                                            */
/* ------------------------------------------------------------------ */

/**
 * 摘要里一个参数的显示。
 *
 * 空值统一显示成 `?` —— 不写"待填"，是因为摘要要能看出
 * **缺的是哪一个**：`10 ＋ ?` 一眼就知道第二个数没填，
 * 而"参数待填"还得再点开面板去找。
 *
 * 模板（如 `{{task1.output}}`）原样显示 ——
 * 用户要确认的正是"我引用的是哪个上游"，替他渲染掉反而看不出来。
 */
export function briefArg(v: unknown, max = 16): string {
  const s = String(v ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return '?';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/*
 * 运算符在**纯文本**摘要里的符号（`add` → `＋`、`neq` → `≠`）。
 *
 * 只有这一张表。以前分 MATH_SIGN / COMPARE_SIGN 两张，
 * 判据那边还抄了第三份 DETAIL_SIGN ——
 * 加一个新运算漏改一份，卡片显示 `＋`、运行详情却写 `add`，
 * 同一件事两种写法，不报错，只有两处并排看才发现。
 */
export const OP_SIGN: Record<string, string> = {
  add: '＋', sub: '－', mul: '×', div: '÷', mod: 'mod',
  eq: '＝', neq: '≠', gt: '>', gte: '≥', lt: '<', lte: '≤',
};

/**
 * 运算符在**纯文本**摘要里的符号（`add` → `＋`、`neq` → `≠`）。
 *
 * 与 opBriefParts 用的是同一份表 —— 不另写一份：
 * 卡片上画着 `10 ≠ 5`、运行详情里却写 `10 neq 5`，是同一件事两种说法。
 *
 * 查不到返回 undefined，由调用方决定退回 op 本身
 * （min / round 这类本来就是函数名写法，没有符号）。
 */
export function opSignOf(op: string): string | undefined {
  return OP_SIGN[op];
}

/**
 * 摘要的一小段。
 *
 * ================= 为什么要拆成段 ====================
 *
 * 摘要里混着两类东西：**参数**（`10`、`5`）和**文字**（`＋`、`包含`、括号）。
 * 以前只产出一整条字符串，卡片上只能当纯文本渲染 ——
 * 于是 `10 ＋ 5` 看起来就是一句话，看不出 `10` 和 `5` 是这一格填的参数、
 * `＋` 是选的运算符。改参数时得先认出哪几个字是参数。
 *
 * 现在按 role 分好，卡片把参数渲染成下凹的输入格（与面板里填参数
 * 那一个个框同一套观感），一眼就能对上"哪块是我填的"。
 *
 * ================= 谁在用 ====================
 *
 * 卡片（OpNode）与导出的 Markdown 说明（scriptExport）共用这一份。
 * 两处各写一份的话，会出现"卡片上写着 1＋2、导出说明里只有'加'"——
 * 同一件事两种说法，而两边都没错，错的是分了两处。
 */
export type BriefPart = {
  /** val=参数值 / op=运算符 / fn=函数名 / text=字面文字（括号、逗号、"包含"这类） */
  role: 'val' | 'op' | 'fn' | 'text';
  text: string;
  /**
   * 这个格子对应的**参数 key**（a / b / c）。
   *
   * 参数连线要知道自己连的是哪个参数 —— 否则"把上游输出填进 a"
   * 和"填进 b"就无法区分，而填错参数的表现是结果不对但不报错。
   *
   * 只有 val 有：运算符与字面文字不是参数，不能接。
   */
  key?: string;
  /**
   * 编辑框的**初值** —— 必须是原始值，不能是 text。
   *
   * text 是显示用的，走过 briefArg()：超 16 字会截成"很长的一段文字…"。
   * 拿它当编辑初值的话，点一下输入框里的字就被截掉了，
   * 一失焦等于**把原始值改写成了截断后的那截** ——
   * 且没有任何报错，只是数据悄悄少了一截。
   */
  raw?: string;
  /**
   * 在卡片上**就地改**：改哪个字段、怎么改。
   *
   * kind='text' 点一下变输入框；kind='select' 点一下弹下拉；
   * kind='area' 是**多行**文本（提示词这类），在卡片上占一整块。
   *
   * 选项一般不写在这里 —— 从节点定义的 fields 里取（见 ArgCell），
   * 两处各写一份列表的话，改一处就会让卡片与面板给出不同的选项。
   * 只有"选项不来自节点 fields"时才用下面的 options 直接给
   * （触发方式就是这样：它的选项来自 TRIGGER_META，不是节点字段）。
   */
  edit?: {
    key: string;
    kind: 'text' | 'select' | 'area';
    /*
     * 实际**写入**的位置（点分路径，如 `entries.0.kind`）。
     *
     * 不填就等于 key。必须能分开，是因为 key 还有另一个用途：
     * 它是参数连线的端口 id（argHandleId）。触发器那种"节点下面挂
     * 多张卡"的结构里，端口叫 kind、但值要写进 entries[i].kind，
     * 两者不是同一个东西。
     *
     * **不写 path 的后果**：ArgCell 会拿 key 直接 patch 顶层 ——
     * 而 `kind` 在 TriggerNodeData 上是**节点种类**（恒为 'trigger'），
     * 一改它，整张卡就不再是触发器，画布上直接消失。
     */
    path?: string;
    /** 直接给定选项；不填则按 key 从节点 fields 反查 */
    options?: { value: string; label: string }[];
    /*
     * 这一个值要怎么**落盘**。返回的是整份 patch（可以一次改多个字段）。
     *
     * 不填就走 `{ [path ?? key]: v }` —— 单个字段够用时不必写它。
     * 必须写它的场景：节点下挂多张卡（常量卡 / 触发器条目），
     * 一次改动要写**整份数组**，还要顺带同步顶层的镜像字段。
     * 用点分路径写单字段的话，老节点上没有那个数组，
     * setInPath 会凭空建出一个缺 id / 缺种类的对象 ——
     * 卡片渲染时读它直接抛错，整棵 React 树崩掉。
     */
    apply?: (v: string) => Record<string, unknown>;
  };
};

/** 只有 val / op / fn 会被渲染成下凹的参数格，text 是连接它们的字 */
export function isArgPart(p: BriefPart): boolean {
  return p.role !== 'text';
}

/**
 * 拼回一整条字符串（导出说明用）。
 *
 * 两个**非** text 段之间补一个空格（否则 `10` 和 `＋` 会黏成 `10＋`）；
 * text 段自己带空格（如 `' 包含 '`、`', '`），不能再补 ——
 * 补了会变成 `min( 1 , 2 )` 这种散开的写法。
 */
function partsToText(ps: BriefPart[]): string {
  let s = '';
  for (let i = 0; i < ps.length; i += 1) {
    const p = ps[i];
    if (i > 0 && p.role !== 'text' && ps[i - 1].role !== 'text') s += ' ';
    s += p.text;
  }
  return s;
}

/** 带参数的一句话摘要（卡片与导出说明共用） */
export function opBrief(kind: string, d: Record<string, unknown>): string {
  return partsToText(opBriefParts(kind, d));
}

/** 摘要的分段形式 —— 卡片靠它把参数画成下凹的输入格 */
export function opBriefParts(kind: string, d: Record<string, unknown>): BriefPart[] {
  const op = String(d.op ?? '');
  /** 显示值：走 briefArg，超长截断、空值写 ? */
  const a = briefArg(d.a);
  const b = briefArg(d.b);
  const c = briefArg(d.c);
  /** 原始值：编辑框的初值，见 BriefPart.raw 的说明 */
  const raw = (v: unknown): string => (v === undefined || v === null ? '' : String(v));
  /** 参数格：可连线（带 key）+ 可就地改（带 raw 与 edit） */
  const V = (key: string): BriefPart => ({
    role: 'val',
    text: key === 'a' ? a : key === 'b' ? b : c,
    key,
    raw: raw(d[key]),
    edit: { key, kind: 'text' },
  });
  /**
   * 运算符格：点一下弹下拉改 op。
   *
   * raw 给的是**当前运算值**（如 'add' / 'contains'）而不是显示文字 ——
   * 下拉要靠它定位"现在选的是哪一项"。
   */
  const OP = (text: string): BriefPart => ({
    role: 'op', text, raw: op, edit: { key: 'op', kind: 'select' },
  });
  /** 函数名格（min / 取整 / 转大写）：也是 op 的一种写法，同样可点 */
  const FN = (name: string): BriefPart => ({
    role: 'fn', text: name, raw: op, edit: { key: 'op', kind: 'select' },
  });
  /** 单目函数写法：函数名 + 括号里的参数 */
  const call = (name: string, ...args: string[]): BriefPart[] => [
    FN(name),
    { role: 'text', text: '(' },
    ...args.map((k, i) => [
      ...(i > 0 ? [{ role: 'text' as const, text: ', ' }] : []),
      V(k),
    ]).flat(),
    { role: 'text', text: ')' },
  ];

  if (kind === 'math') {
    const sign = OP_SIGN[op];
    if (sign) return [V('a'), OP(sign), V('b')];
    // min / max 是函数名写法，写成 `min(1, 2)` 比 `1 min 2` 好认
    if (op === 'min' || op === 'max') return call(op, 'a', 'b');
    // 单目：取整、绝对值 —— 没有第二个数
    if (op === 'round' || op === 'floor' || op === 'ceil' || op === 'abs') return call(op, 'a');
    return [{ role: 'text', text: opSummary(kind, op) }];
  }

  if (kind === 'text') {
    switch (op) {
      case 'concat': return [V('a'), OP('＋'), V('b')];
      case 'length': return call('长度', 'a');
      case 'upper': return call('转大写', 'a');
      case 'lower': return call('转小写', 'a');
      case 'trim': return call('去空格', 'a');
      // 替换要三个参数才说得清，用箭头表示"换成"
      case 'replace':
        return [V('a'), { role: 'text', text: '：' }, V('b'), OP('→'), V('c')];
      case 'substr':
        return [
          V('a'), { role: 'text', text: '[' },
          V('b'), { role: 'text', text: '~' },
          V('c'), { role: 'text', text: ']' },
        ];
      /*
       * 分段要三个参数才说得清 —— 「按什么分」看不见的话，
       * 卡片上只有 `x,y,z 第 2 段`，逗号还是空格完全看不出来，
       * 而这两者结果不同。
       *
       * 以前这里只画了 a 和 c：规则表列着三个参数，摘要却只画两个，
       * 多的那个（分隔符）在卡片上彻底消失，且不报错。
       */
      case 'split':
        return [
          V('a'), { role: 'text', text: ' 按 ' }, V('b'),
          { role: 'text', text: ' 分，第 ' }, V('c'), { role: 'text', text: ' 段' },
        ];
      case 'join':
        return [
          { role: 'text', text: '连接 ' }, V('a'),
          { role: 'text', text: '（用「' }, V('b'), { role: 'text', text: '」）' },
        ];
      case 'repeat': return [V('a'), OP('×'), V('b')];
      default:
        return [{ role: 'text', text: opSummary(kind, op) }];
    }
  }

  if (kind === 'compare') {
    const sign = OP_SIGN[op];
    if (sign) return [V('a'), OP(sign), V('b')];
    /*
     * 「包含 / 开头 / 结尾」也是运算符，只是写成中文字。
     *
     * 以前它们是 text 段（纯文字），于是卡片上这一处**点不了** ——
     * 想改只能打开面板，而旁边 `>` `<` 那些符号格点一下就能改，
     * 同一个节点的同一个东西两种待遇，看着像有的坏了。
     *
     * 改成 op 段后与符号格一致（带边框、可点）。
     * partsToText 会在两个非 text 段之间自动补空格，
     * 所以导出的那句话与改之前**逐字相同**（有测试盯着）。
     */
    if (op === 'contains') return [V('a'), OP('包含'), V('b')];
    if (op === 'startsWith') return [V('a'), { role: 'text', text: ' 以 ' }, V('b'), OP('开头')];
    if (op === 'endsWith') return [V('a'), { role: 'text', text: ' 以 ' }, V('b'), OP('结尾')];
    return [{ role: 'text', text: opSummary(kind, op) }];
  }

  if (kind === 'random') {
    switch (op) {
      case 'int':
        return [FN('随机整数'), V('a'), { role: 'text', text: '~' }, V('b')];
      case 'float':
        return [FN('随机小数'), V('a'), { role: 'text', text: '~' }, V('b')];
      case 'pick': return [FN('随机选一个'), { role: 'text', text: '：' }, V('a')];
      case 'shuffle': return [FN('打乱'), { role: 'text', text: '：' }, V('a')];
      case 'bool': return [FN('随机真假')];
      default: return [{ role: 'text', text: opSummary(kind, op) }];
    }
  }

  return [{ role: 'text', text: opSummary(kind, op) }];
}
