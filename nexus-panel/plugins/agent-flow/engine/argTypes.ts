/**
 * 参数类型契约 —— 「这个积木的某个参数，在某个取值下应当是什么类型」。
 *
 * ================= 要解决什么 =================
 *
 * 运算节点（数学 / 比较 / 文本 / 随机）的参数都是**一个文本框**，
 * 期望类型却随「运算」那一项的取值而变：
 *
 *   比较 → 大于     ：两边都得是数字
 *   比较 → 包含     ：两边都得是文本
 *   比较 → 等于     ：什么都行
 *
 * 于是最典型的一类静默错误长这样：
 *
 *   1. 比较节点选「包含」，两边填「苹果」「果」  → 绿灯，结果正确
 *   2. 后来把运算改成「大于」                  → 仍然绿灯
 *   3. 跑起来：`compareOp` 里 bothNum 为假，退化成**文本比较**
 *      「苹果」>「果」 按字典序成立 → 输出 true
 *   4. 用户拿到 true，以为比的是数字
 *
 * 第 3 步不报错，界面上绿灯，日志里也只有一句 true ——
 * **这类错误只能靠参数类型校验拦住**，运行时校验不出来
 * （因为它有合法的降级行为，不是异常）。
 *
 * ================= 为什么单独一层 =================
 *
 * 与 nodeValidate（配没配齐）分开：
 *
 *   nodeValidate  回答「**有没有填**」→ 缺参 / 缺项
 *   argTypes      回答「**填的对不对**」→ 错参
 *
 * 两者都是圆点变红的理由，但成因与改法完全不同：
 * 前者补一个值，后者改一个类型。混在一起的话，
 * 用户看到红色还得先猜是"没填"还是"填错了"。
 *
 * 刻意**不 import React**，与 nodeValidate 同样理由：
 * 卡片要用它，单测要在纯 Node 下跑它。
 */

/** 参数期望的种类 */
export type ArgKind =
  /** 数字（能参与加减乘除、比大小） */
  | 'num'
  /** 文本（能参与包含 / 拼接 / 大小写） */
  | 'text'
  /** 什么都行 */
  | 'any';

/**
 * 静态判定出的值种类。
 *
 * 比 ArgKind 多一个 'unknown' ——
 * 模板引用（{{xx.output}}）在**编辑时**是看不到值的，
 * 它要到运行时才知道。判成 num / text 都是猜，一律放行。
 */
/**
 * 一个值**实际是什么种类**。
 *
 * 比 ArgKind 多几种：
 *
 *   · 'unknown' 判不出来 —— 模板引用 {{xx.output}} 在编辑时没有值，
 *     判成 num / text 都是猜，猜错的代价是把正确的流程标红
 *     （**误报比漏报更糟**），所以一律放行。
 *
 *   · 'bool' / 'table' / 'files' 是**参数连线**带来的种类。
 *     手填的值只会是 num 或 text（valueKindOf 只产出这两种），
 *     但这三种来自上游节点的产出：比较出 bool、表格节点出 table、
 *     文件节点出 files。它们接到要数字的参数上就是错的，
 *     必须能表达出来，否则"接了个表格进加减乘除"会被判成合法。
 */
export type ValueKind = ArgKind | 'unknown' | 'bool' | 'table' | 'files';

/* ------------------------------------------------------------------ */
/* 期望类型表                                                          */
/* ------------------------------------------------------------------ */

/**
 * 索引结构：dataKind → 参数 key → 该参数期望的类型。
 *
 * 之所以要按 op 再分一层，是因为**同一个参数在不同运算下期望不同**
 * （比较节点的 a：大于时要数字，包含时要文本）。
 */
type OpRule = {
  /** 该运算需要用到哪些参数。不列在内的是"用不到"，不校验 */
  args: Record<string, ArgKind>;
};

type KindRule = {
  /** 决定期望类型的那一项（一般是 `op`） */
  by: string;
  rules: Record<string, OpRule>;
};

/**
 * 每项的**人话说明**，用于报错文案。
 * 不写的话报错只能说"类型不对"，用户不知道该往哪改。
 */
const KIND_HINT: Record<ValueKind, string> = {
  num: '数字',
  text: '文本',
  any: '任意内容',
  /*
   * 下面四种**不会**作为"期望"出现（ArgKind 里没有它们）：
   * 手填的值只可能是 num / text，期望只可能要求 num / text / any。
   *
   * 但它们是合法的**实际**值 —— bool / table / files 来自参数连线上游
   * 节点的产出，unknown 是模板引用（编辑时无值）。少了这几个键，
   * `KIND_HINT[actual]` 就是 undefined，报错文案会印成
   * 「要数字，现在填的是undefined」—— 用户根本不知道改什么。
   * 文案与 paramLinks 的 valueLabel() 保持一致。
   */
  bool: '是/否',
  table: '表格',
  files: '文件',
  unknown: '任意内容',
};

const N = (...keys: string[]): OpRule => ({
  args: Object.fromEntries(keys.map((k) => [k, 'num' as ArgKind])),
});
const T = (...keys: string[]): OpRule => ({
  args: Object.fromEntries(keys.map((k) => [k, 'text' as ArgKind])),
});
const A = (...keys: string[]): OpRule => ({
  args: Object.fromEntries(keys.map((k) => [k, 'any' as ArgKind])),
});
/** 混合：显式给每个参数指定 */
const M = (args: Record<string, ArgKind>): OpRule => ({ args });

/*
 * 只列**有明确期望**的运算。
 *
 * 不列的运算一律放行 —— 宁可漏报也不要误报：
 * 把能用的参数标红，用户会直接去改它，比漏报更糟。
 */
const RULES: Record<string, KindRule> = {
  math: {
    by: 'op',
    rules: {
      add: N('a', 'b'),
      sub: N('a', 'b'),
      mul: N('a', 'b'),
      div: N('a', 'b'),
      mod: N('a', 'b'),
      min: N('a', 'b'),
      max: N('a', 'b'),
      // 单目：只有一个参数
      round: N('a'),
      floor: N('a'),
      ceil: N('a'),
      abs: N('a'),
    },
  },

  compare: {
    by: 'op',
    rules: {
      /*
       * 比大小：必须都是数字。
       *
       * 这是本文件存在的主要理由 —— 见文件头那个"苹果 > 果"的例子。
       * 不拦的话它会退化成文本比较并输出 true，全程不报错。
       */
      gt: N('a', 'b'),
      gte: N('a', 'b'),
      lt: N('a', 'b'),
      lte: N('a', 'b'),
      // 文本包含类：数字也能包含，但语义上就该是文本
      contains: T('a', 'b'),
      startsWith: T('a', 'b'),
      endsWith: T('a', 'b'),
      // 相等：两边同类型即可，什么都能比
      eq: A('a', 'b'),
      neq: A('a', 'b'),
    },
  },

  text: {
    by: 'op',
    rules: {
      concat: T('a', 'b'),
      // 取长度：长度是数字，输入是文本
      length: T('a'),
      upper: T('a'),
      lower: T('a'),
      trim: T('a'),
      // 替换：原文 / 被替换 / 替换为
      replace: T('a', 'b', 'c'),
      // 截取：起止下标是数字，源文本是文本
      substr: M({ a: 'text', b: 'num', c: 'num' }),
      /*
       * 分段：文本 / 分隔符 / **第几段**。
       *
       * 只有两个参数就漏了「第几段」—— 它填了非数字时 num() 变 0，
       * 减 1 得 -1，split 的实现里 `part < 0` 直接返回整串。
       * 于是"我填了第 2 段，它却把整串原样返回"，不报错、看不出原因。
       * 这正是本文件要拦的那类：有合法降级行为的错误。
       */
      split: M({ a: 'text', b: 'text', c: 'num' }),
      join: T('a', 'b'),
      // 重复次数是数字
      repeat: M({ a: 'text', b: 'num' }),
    },
  },

  random: {
    by: 'op',
    rules: {
      // 整数 / 浮点：上下界都是数字
      int: N('a', 'b'),
      float: N('a', 'b'),
      /*
       * 选一个 / 打乱：逗号分隔的列表，是**文本**不是数字。
       *
       * 这里不能写成 N —— 填 "a,b,c" 是最正常的用法，
       * 按数字校验会把它标红，那是**误报**：
       * 用户会照着提示去改一个本来完全正确的参数。
       * （而且 num() 会先去掉逗号，"1,2,3" 会被当成 123 而漏过，
       *   两种写法用数字校验都不可靠。）
       */
      pick: T('a'),
      shuffle: T('a'),
      /*
       * 随机真假：不吃参数 —— 显式写空 args。
       *
       * 不列的话它走"表里没有就放行"，结果一样，
       * 但那样守卫分不清"忘了写"和"刻意不校验"，
       * 下次加新运算漏配规则时也不会被发现。
       */
      bool: M({}),
    },
  },

  /*
   * 常量：按**种类**（valueType）决定它自己的值该是什么。
   *
   * 与其它几项不同 —— 其余节点校验的是"参数"，常量校验的是它**唯一的产出**。
   * 把它纳入同一张表是为了让"数字常量里填了 abc"在卡片上标「错参」，
   * 而不是等接到「大于」上时才发现算出来是 0。
   *
   * text 不列：文本什么都能填，没有"错的文本"。
   */
  const: {
    by: 'valueType',
    rules: {
      num: N('value'),
    },
  },
};

/* ------------------------------------------------------------------ */
/* 静态判定                                                            */
/* ------------------------------------------------------------------ */

/**
 * 判定一个字面量值是什么种类。
 *
 * ================= 为什么模板引用要放行 =================
 *
 * `{{上游.output}}` 在编辑时**没有任何值** —— 它要到运行时才被替换。
 * 判成 num 或 text 都是猜，而猜错的代价是：
 * 把一个完全正确的流程标红，用户被迫去改一个没问题的参数。
 *
 * 漏报（该报没报）的表现是"红灯没亮"，
 * 误报（不该报报了）的表现是"用户改坏了正确的配置"。
 * **后者更糟**，所以模板一律 'unknown' → 不校验。
 */
export function valueKindOf(v: unknown): ValueKind {
  const s = String(v ?? '').trim();

  // 空值不校验：那属于"没填"，由 nodeValidate 管（缺参），不在这里重复报
  if (!s) return 'unknown';

  // 模板引用 / 变量引用 —— 运行时才有值
  if (s.includes('{{') || s.includes('}}')) return 'unknown';

  // 纯数字（含小数、负数、科学计数法）
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(s)) return 'num';

  /*
   * 带单位的数字（"100元"、"50%"）算文本 ——
   * 它们进到 num() 里会被当 0，而这正是"看着填了却算不出来"的来源，
   * 值得报出来让用户看清楚。
   */
  return 'text';
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

export type ArgTypeIssue = {
  /** 出问题的参数 key */
  key: string;
  /** 参数名（用于文案）。没有就用 key */
  label?: string;
  /** 期望 */
  expect: ArgKind;
  /** 实际 */
  actual: ValueKind;
  /** 人话说明 */
  message: string;
};

/**
 * 校验一个节点的参数类型。
 *
 * 返回空数组 = 没问题（或无法静态判定）。
 *
 * 只在**能确定**时才报：
 *   · 该运算在表里（有明确期望）
 *   · 该参数这次运算用得到
 *   · 值不是模板引用
 *   · 值非空（空归 nodeValidate 管）
 */
export function argTypeIssues(
  dataKind: string | undefined | null,
  data: Record<string, unknown> | undefined | null,
): ArgTypeIssue[] {
  if (!dataKind || !data) return [];
  const rule = RULES[dataKind];
  if (!rule) return [];

  const opVal = String(data[rule.by] ?? '');
  const opRule = rule.rules[opVal];
  // 该运算没有明确期望 → 放行
  if (!opRule) return [];

  const out: ArgTypeIssue[] = [];
  for (const [key, expect] of Object.entries(opRule.args)) {
    // any = 什么都行，不用判
    if (expect === 'any') continue;

    const actual = valueKindOf(data[key]);
    // unknown / any 都放行
    if (actual === 'unknown' || actual === 'any') continue;
    if (actual === expect) continue;

    out.push({
      key,
      expect,
      actual,
      message:
        `${argLabel(dataKind, key)}要${KIND_HINT[expect]}，现在填的是${KIND_HINT[actual]}`,
    });
  }
  return out;
}

/**
 * 查**某一个参数**当前期望什么类型。
 *
 * ================= 为什么不从 argTypeIssues 反推 =================
 *
 * argTypeIssues 返回的是"已经出问题的清单"，用它反查期望类型
 * 得先造一个必然冲突的探针值去试探 —— 那是把查询写成了副作用，
 * 而探针值万一哪天被当成合法值（比如规则表里加了新种类），
 * 查询就静默返回 null，表现是"连了线不报"。
 *
 * 查询就该是查询：直接读规则表，读不到就是"没明确期望"。
 *
 * 返回 null = 这个参数没有明确期望（或该运算用不到它），一律放行。
 */
export function argExpectOf(
  dataKind: string | undefined | null,
  data: Record<string, unknown> | undefined | null,
  key: string,
): ArgKind | null {
  if (!dataKind || !data) return null;
  const rule = RULES[dataKind];
  if (!rule) return null;

  const opVal = String(data[rule.by] ?? '');
  const opRule = rule.rules[opVal];
  if (!opRule) return null;

  return opRule.args[key] ?? null;
}

/* ------------------------------------------------------------------ */
/* 参数名                                                              */
/* ------------------------------------------------------------------ */

/*
 * 参数名表。
 *
 * 报错文案里必须说清**哪个参数** ——
 * 只说"类型不对"的话，用户得逐个参数去试，等于没报。
 */
const ARG_LABELS: Record<string, Record<string, string>> = {
  math: { a: '第一个数', b: '第二个数' },
  compare: { a: '左边', b: '右边' },
  text: { a: '文本', b: '第二个值', c: '第三个值' },
  random: { a: '最小值', b: '最大值' },
  const: { value: '值' },
};

function argLabel(dataKind: string, key: string): string {
  return ARG_LABELS[dataKind]?.[key] ?? key;
}

/** 有明确类型契约的 dataKind 清单（测试与文档用） */
export function argTypedKinds(): string[] {
  return Object.keys(RULES);
}
