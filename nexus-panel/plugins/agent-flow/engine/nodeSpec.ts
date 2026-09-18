/**
 * 节点契约 —— 「这个积木产出什么、能吃下什么」。
 *
 * ================= 为什么要有这份东西 =================
 *
 * 注册表已经能回答"有哪些积木、每个积木填什么参数、哪些参数必填"，
 * 但回答不了**决定一条链能不能成立**的那件事：
 *
 *   A 产出什么？B 能吃下什么？
 *
 * 此前这层只存在于注释和人的脑子里。于是 AI（或人）拼装时最容易犯的
 * 一类错误完全没被拦住：
 *
 *   上游 →「等待 2 秒」→ 提取
 *
 * 看着天经地义，但「等待」的输出是 `已等待 2000ms` 这样一句状态标记，
 * **不是**上游传下来的数据。提取节点吃到的是那句标记，取不到任何东西，
 * 而且**不报错**（取不到默认给空串）。
 *
 * ================= 端口种类 =================
 *
 * 区分 'mark' 与 'any' 是本文件的核心价值：
 *
 *   'any'  透传上游 —— 插在链中间不破坏数据（日志标记）
 *   'mark' 输出状态描述 —— 插在链中间会**截断**上游数据（等待/提示音）
 *
 * 这两者外观上都是"有个输出"，语义却相反。
 */

import { REQUIRES } from './nodeRequires';

/*
 * ================= 模板变量语义 =================
 *
 * 拼装实测（五个场景）里，唯一失败的那条就是栽在这里：
 * 凭直觉写了 `text: '{{input}}'`，以为它是"上游传来的"。
 * 实际它是**工作流全局输入** —— 那条链上为空，于是翻译拿到空文本失败。
 *
 * 更危险的是：全局输入恰好有值时，流程会"看起来跑通了"
 * 但翻译的是错的内容。**不报错的时候才最坑。**
 */
export type TemplateVar = {
  syntax: string;
  desc: string;
  /** 容易用错的点。没有则不写 */
  warn?: string;
};

export const TEMPLATE_VARS: TemplateVar[] = [
  {
    syntax: '{{节点id.output}}',
    desc: '取指定节点的输出。能取到**任意**已执行节点，不限于直接上游',
  },
  {
    syntax: '{{input}}',
    desc: '工作流全局输入',
    warn: '**不是**上游输出。嵌合时才表示直接上方那一块的输出；未嵌合的节点用它会拿到全局输入（常为空）',
  },
  {
    syntax: '{{chain.output}}',
    desc: '嵌合串上、本节点之前所有输出的拼接',
    warn: '仅在嵌合（Scratch 式上下吸附）时有意义',
  },
  { syntax: '{{loop.item}}', desc: '循环体内：本轮的元素' },
  { syntax: '{{loop.index}}', desc: '循环体内：本轮下标' },
  { syntax: '{{loop.count}}', desc: '循环体内：总轮数' },
  {
    syntax: '{{节点id.字段名}}',
    desc: '取节点产出附加字段（如更新检测节点的 title / link）',
    warn: '字段名由各节点的 nodeFields 决定，不是所有节点都有',
  },
];

/** 输出端口的数据种类 */
export type PortKind =
  /** 普通文本，可直接被下游消费 */
  | 'text'
  /** JSON 文本，适合接「数据提取」 */
  | 'json'
  /** 是/否，主要给条件节点判断 */
  | 'bool'
  /** 文件引用列表（文件操作节点的产出） */
  | 'files'
  /**
   * 状态标记 —— 如「已等待 2000ms」「已播放提示音」。
   * 它是**描述动作完成**，不是承载上游数据。
   * 插在链中间会截断数据流，是最容易踩的坑。
   */
  | 'mark'
  /**
   * 表格（CSV 文本）。
   *
   * 单独一个种类是因为它**只能被表格类节点消费**：
   * 把一张表接到翻译节点上没有任何意义，而按 'text' 判定的话
   * 这种接法会被判成合法，用户会拿到一串 CSV 原文而不知所以。
   */
  | 'table'
  /** 透传上游（日志标记）。上游没数据时等于空 */
  | 'any'
  /** 不产出任何内容 */
  | 'none';

/** 能吃下什么。'any' = 都行；'none' = 不需要输入 */
export type Accepts = 'any' | 'none' | PortKind[];

export type NodeSpec = {
  /** 产出什么 */
  produces: PortKind;
  /**
   * 需要哪些外部能力（RunOptions 里的键）。
   *
   * 从 engine/nodeRequires.ts 的 REQUIRES 派生，不在这里重抄一份 ——
   * 那份是校验时真正用的，抄两份必然漂移。
   *
   * 给 AI 的用途：提前知道某条链在本机能不能跑（浏览器模式下
   * 缺 fsExecutor / llmCaller 等能力时，节点会直接失败）。
   */
  requires: string[];
  /**
   * 不在 fields 里、因此派生不出来的参数。
   *
   * 典型是参数卡片组管的字段（如 llm 配置）—— 它由 `llm-config`
   * 卡片组提供，fields 里根本没有这一项，但从字段清单派生时
   * 会漏掉，AI 手工构造节点数据就会缺这个字段而失败。
   */
  hiddenParams?: ParamSpec[];
  /**
   * 能吃下什么。
   *
   * 注意这里描述的是**语义上能不能用**，不是"物理上能不能连" ——
   * 本文件只做提示，不硬阻止（理由见 canConnect）。
   */
  accepts: Accepts;
  /** 一句话说明产出什么，给 AI 与提示文案用 */
  producesDesc?: string;
  /**
   * 参数无法从 fields 派生（该节点用整体自定义面板）。
   * 为 true 时 params 需手写。
   */
  manualParams?: boolean;
  /** manualParams 时手写的参数说明 */
  params?: ParamSpec[];
};

export type ParamSpec = {
  key: string;
  /** 给 AI 看的说明 */
  desc: string;
  /** 是否必填 */
  required?: boolean;
  /** 枚举取值 */
  options?: string[];
};

export const PORT_LABEL: Record<PortKind, string> = {
  text: '文本',
  json: 'JSON',
  bool: '是/否',
  files: '文件',
  mark: '状态标记（非数据）',
  table: '表格（CSV）',
  any: '透传上游',
  none: '无输出',
};

/* ------------------------------------------------------------------ */
/* 各节点契约                                                          */
/* ------------------------------------------------------------------ */

const S = (
  produces: PortKind,
  accepts: Accepts,
  producesDesc?: string,
  extra?: { manualParams?: boolean; params?: ParamSpec[]; hiddenParams?: ParamSpec[] },
): NodeSpec => ({
  produces,
  accepts,
  producesDesc,
  /*
   * requires 在这里按 kind 反查 REQUIRES，而不是每条手写。
   * 手写就会变成"同一件事写两遍"，改了 nodeRequires 忘了这里，
   * AI 拿到的能力清单就是错的（而且不会报错）。
   *
   * 反查靠 kind —— 但 S() 不知道自己的 key，所以填在 SPECS 定义之后
   * 统一回填（见文件末尾的 fillRequires）。
   */
  requires: [],
  ...extra,
});

/**
 * 按 dataKind 索引（与 nodeValidate 同一套键，便于核对覆盖）。
 *
 * 放在这里而不是节点定义文件里：那些文件是 tsx，import 了 React 组件，
 * 而这份契约要能被纯 Node 环境消费（测试、以及将来喂给 AI 的接口）。
 *
 * 代价是"节点定义在 A、契约在 B" —— 用 tests/nodeSpec.test.ts 盯着
 * 两者覆盖一致，不会漏。
 */
export const SPECS: Record<string, NodeSpec> = {
  // 起点：产出流程输入
  trigger: S('text', 'none', '流程的初始输入（手动文本 / 触发带来的内容）', {
    manualParams: true,
    params: [
      { key: 'mode', desc: '触发方式', required: true, options: ['manual', 'interval', 'cron', 'watch', 'webhook', 'conversation'] },
      { key: 'enabled', desc: '是否启用' },
    ],
  }),

  // 任务：CLI 的输出
  task: S('text', 'any', 'CLI 的执行输出'),

  // 流程控制
  /*
   * 条件节点的参数是**唯一必须写清结构**的 ——
   * 它用整体自定义面板，fields 里派生不出来，
   * 而它恰恰是 AI 拼流程时最需要生成的（"如果有更新就…"）。
   * 实测时我因为不知道 ConditionRule 长什么样，只能去看源码才写对。
   */
  condition: S('mark', 'any', '分支标记文本（如「[条件] 走「是」」）—— 作用是分流，不转换数据', {
    manualParams: true,
    params: [
      {
        key: 'rules',
        desc: '规则列表，从上到下判定，命中第一条即走对应分支。'
          + '每条 = { id, label, op, value, source }；'
          + 'source 填上游节点 id，或 "input" 表示全局输入，'
          + '空字符串表示拼接全部上游输出',
        required: true,
      },
      {
        key: 'defaultBranch',
        desc: '是否启用兜底分支。true 时所有规则都未命中则走 __default__ 边（分支 id 固定）',
      },
      { key: 'op', desc: '算子。常用：nonEmpty / isEmpty / contains / notContains / equals / always', options: ['nonEmpty', 'isEmpty', 'contains', 'notContains', 'equals', 'always'] },
    ],
  }),
  loop: S('any', 'any', '透传（循环体每轮一次，done 出口汇总一次）', {
    manualParams: true,
    params: [{ key: 'mode', desc: '循环方式' }, { key: 'maxIterations', desc: '最大轮数' }],
  }),
  parallel: S('any', 'any', '透传', {
    manualParams: true,
    params: [{ key: 'mode', desc: '并发模式' }, { key: 'concurrency', desc: '并发度' }],
  }),

  // 文件与数据
  fs: S('files', 'any', '文件引用列表（下游按文件处理）'),
  extract: S('text', ['text', 'json'], '从上游文本里提取出的值'),

  /*
   * AI 节点都带一份 llm 配置，但它**不在 fields 里** ——
   * 由 'llm-config' 参数卡片组提供。从字段清单派生时会漏掉，
   * AI 手工构造节点数据就会缺这个字段，执行时报
   * "Cannot read properties of undefined (reading 'provider')"
   * 这种与真实原因无关的错。
   *
   * 正确做法是用 def.create()（makeXxxNode）建节点，它会填 defaultLlmConfig()。
   */
  ocr: S('text', ['text', 'files', 'any'], '图片识别出的文字', {
    hiddenParams: [
      { key: 'llm', desc: '大模型配置 { url, model, apiKey, timeoutSec }。由 llm-config 卡片组提供，建节点时 def.create() 会填默认值' },
      { key: 'imageSource', desc: "'file' 走本地读图（需 imageReader 能力），'url' 走网络地址", options: ['file', 'url'] },
    ],
  }),
  translate: S('text', ['text'], '翻译后的文本', {
    hiddenParams: [
      { key: 'llm', desc: '大模型配置 { url, model, apiKey, timeoutSec }。由 llm-config 卡片组提供，建节点时 def.create() 会填默认值' },
    ],
  }),

  // 外部服务
  /*
   * 更新检测其实**有** fields（bili 与 wechat 共用 updateFields），
   * 参数该从字段派生 —— 盲测时标成 manualParams 且只写了 source，
   * 结果 AI 不知道还要填 biliUid / feedUrl，跑出来
   * "Cannot read properties of undefined (reading 'trim')"。
   *
   * source 不在 fields 里（由 bili / wechat 两个 type 在建节点时写入），
   * 所以放 hiddenParams。
   */
  update: S('bool', 'none', '是否有更新（true / false）—— 给条件节点判断', {
    hiddenParams: [
      /*
       * 取值是 'bilibili'（完整拼写），不是 'bili' ——
       * 'bili' 是节点的 **type**，'bilibili' 是 data.source 的取值。
       * 盲测时写成 'bili' 导致走不进 bilibili 分支，
       * 掉进 wechat 分支去 trim 空的 feedUrl，报
       * "Cannot read properties of undefined (reading 'trim')"。
       */
      { key: 'source', desc: '数据源。由节点类型决定（bili 与 wechat 两个 type 共用一份 update data），建节点时用对应的 def.create()', options: ['bilibili', 'wechat'] },
    ],
  }),
  'github-update': S('json', 'none', '仓库最新信息（JSON）'),
  'github-push': S('text', 'any', '推送结果说明'),
  'generic-http': S('json', 'any', 'HTTP 响应正文'),

  /*
   * 工具节点：全部**透传**上游。
   *
   * 原先 wait / beep / play-audio 输出的是状态文本（「已等待 2000ms」），
   * 等于控制流节点顺手把数据流掐断 ——「上游 → 等待 → 提取」取不到任何东西
   * 且不报错，是典型的静默失败。
   *
   * 现在状态改走运行日志，output 原样透传，与日志标记一致。
   */
  wait: S('any', 'any', '透传上游（只是延时，状态写进运行日志）'),
  beep: S('any', 'any', '透传上游（只是响一声）'),
  'play-audio': S('any', 'any', '透传上游（只是播放音频）'),
  clock: S('text', 'none', '格式化后的当前时间'),
  const: S('text', 'none', '常量值（支持模板）'),
  log: S('any', 'any', '原样透传上游 —— 插在链中间不破坏数据'),

  // 运算
  math: S('text', 'any', '运算结果（数字文本）'),
  text: S('text', 'any', '运算后的文本'),
  /*
   * 比较输出的是 'true'/'false' 文本。
   * 刻意不标 bool —— bool 是给条件节点判定的，
   * 而比较的结果常常还要当文本传给下游显示。
   */
  compare: S('text', 'any', "比较结果 'true' / 'false'"),
  random: S('text', 'any', '随机结果'),
  /*
   * 变量：写模式透传（写完后下游能接着用），
   * 读模式产出的是变量的值。
   * 统一记 any —— 它的接受侧其实无所谓，因为值来自上游或配置。
   */
  var: S('any', 'any', '写模式：写入的值；读模式：变量的值'),
  stop: S('any', 'any', '透传上游（只是让流程停下）'),
  ask: S('text', 'any', '人填的内容'),

  // 表格
  tableRead: S('table', 'none', '表格内容（CSV 文本）'),
  derive: S('table', ['table'], '加了新列的表格'),
  filter: S('table', ['table'], '筛选后的表格'),
  agg: S('text', ['table'], '汇总出来的一个数'),

  // 组合
  module: S('any', 'any', '模块内部最后一个节点的输出'),

  // 控制器：不产生数据，只管何时放行、放不放行。输出一律透传上游
  join: S('text', 'any', '所有到齐输入按顺序拼接（宽松模式忽略未走到的分支）'),
  gate: S('any', 'any', '透传上游；条件不满足时阻断或等待'),
  throttle: S('any', 'any', '透传上游；按间隔与次数限制放行节奏'),
  timeout: S('any', 'any', '透传上游；整条流程超预算时中断'),
  retry: S('any', 'any', '透传上游；上游内容不合格时重跑它'),
};

/*
 * 把 REQUIRES 回填进各条契约的 requires。
 *
 * 放在 SPECS 定义之后统一做，是因为 S() 拿不到自己的 key；
 * 而在每条上手写 requires 就会与 nodeRequires.ts 形成"同一件事写两遍"。
 *
 * 只取 key（能力名），不带 when 条件 ——
 * AI 需要知道的是"这条链**可能**要什么能力"，而不是某次具体数据要什么。
 */
for (const k of Object.keys(SPECS)) {
  const list = REQUIRES[k];
  if (!list) continue;
  const keys: string[] = [];
  for (const r of list) {
    if (!keys.includes(r.key)) keys.push(r.key);
  }
  SPECS[k].requires = keys;
}

/*
 * ================= 能力签名 =================
 *
 * requires 只说了"需要哪个能力"，没说"这个函数长什么样"。
 *
 * 盲测时我在这里栽了：给 update 的 fetcher 返回了
 * `{ ok:true, text:'...' }`，而 Fetcher 实际返回**字符串**，
 * 于是报 "xml.trim is not a function" —— 与"mock 写错了"
 * 完全对不上号。
 *
 * 签名抄自 engine/runTypes.ts。刻意只写"够拼装用"的部分，
 * 不追求与类型定义逐字一致（那样又会变成同一件事写两遍）。
 */
export const CAPABILITY_SIGNATURES: Record<string, string> = {
  fsExecutor: '(node, { path, target, content }) => Promise<string>',
  llmCaller: '({ url, headers, body, timeoutSec }) => Promise<{ status, text }>',
  httpRequester:
    '(url, { method, headers, body, timeoutSec, maxBytes }) '
    + '=> Promise<{ status, ok, text, headers }>',
  fetcher: '(node, url, { headers, timeoutSec }) => Promise<string>',
  githubFetch: '抓取仓库信息 => Promise<信息对象>',
  githubPush: '推送文件 => Promise<string>',
  imageReader: '(path) => Promise<string>（data URL）',
  playAudioReader: '(path) => Promise<string>（data URL）',
};

/*
 * ================= 边的结构 =================
 *
 * 契约能回答"两个积木能不能接"，但没说"接的那条线长什么样"。
 * 盲测条件节点时我把分支写进了 `data: { branch: 'r1' }`，
 * 而引擎读的是**顶层** `e.branch` —— 于是 `if (!e.branch) continue`
 * 把所有出边都跳过了，一条都没剪枝，两条分支全跑了。
 *
 * 这种错不报错，只表现为"该剪的没剪"。
 */
export type EdgeShapeDoc = {
  field: string;
  desc: string;
};

export const EDGE_SHAPE: EdgeShapeDoc[] = [
  { field: '{ id, source, target }', desc: '普通边。id 建议写成 `源->目标`' },
  {
    field: 'branch（**顶层**，不是 data.branch）',
    desc: '条件节点的出边所属分支。填规则 id，或 __default__ 表示兜底分支',
  },
  {
    field: 'loopRole（**顶层**）',
    desc: "循环节点的出边角色：'body' 循环体（每轮执行一次）/ 'done' 结束后执行一次",
  },
];

/** 条件分支边：命中规则 r1 时的正确写法 */
export const BRANCH_EDGE_EXAMPLE =
  "{ id: 'c1->l1', source: 'c1', target: 'l1', branch: 'r1' }";

/** 取契约。没声明的类型按"都能接"处理，不因此报错 */
export function specOf(dataKind: string | undefined | null): NodeSpec | null {
  if (!dataKind) return null;
  return SPECS[dataKind] ?? null;
}

/* ------------------------------------------------------------------ */
/* 连接判据                                                            */
/* ------------------------------------------------------------------ */

export type ConnectVerdict = {
  /** ok=正常；warn=能连但语义上可疑；block=不应连 */
  level: 'ok' | 'warn' | 'block';
  /** 给用户的说明。ok 时为 null */
  reason: string | null;
};

const OK: ConnectVerdict = { level: 'ok', reason: null };

function warn(reason: string): ConnectVerdict {
  return { level: 'warn', reason };
}

function block(reason: string): ConnectVerdict {
  return { level: 'block', reason };
}

/**
 * 能不能从 src 连到 dst。
 *
 * 只判断 src / dst 自身的契约（不知道已有边），
 * 所以"多个上游"这类问题不在这里处理。
 */
export function canConnect(src: NodeSpec | null, dst: NodeSpec | null): ConnectVerdict {
  // 有一方没有契约声明 → 不猜，放行
  if (!src || !dst) return OK;

  // 目标明确不需要输入：连上去也不会被用到
  if (dst.accepts === 'none') {
    return warn('这个节点不需要输入，连上去的内容不会被使用');
  }

  // 源不产出任何东西
  if (src.produces === 'none') {
    return warn('上游节点不产出内容，下游拿不到数据');
  }

  // 目标什么都吃
  if (dst.accepts === 'any') return OK;

  /*
   * 源是透传型（日志标记）：它输出什么取决于它的上游，
   * 这里拿不到那条信息，不能断言不匹配 —— 放行。
   * 少了这一步，日志标记会被误判成"类型不符"，而它恰恰是安全的。
   */
  if (src.produces === 'any') return OK;

  // 目标吃透传型 —— mark 会截断数据，值得提醒
  if (dst.accepts.includes('any') && src.produces === 'mark') {
    return warn(
      `上游输出的是状态标记（${src.producesDesc ?? '如「已等待 2000ms」'}），`
      + '不是传下来的数据。下游会拿到这句标记而不是你想处理的内容',
    );
  }

  if (dst.accepts.includes(src.produces)) return OK;

  // 明确不在可接受列表里
  return warn(
    `这个节点需要${dst.accepts.map((k) => PORT_LABEL[k]).join(' / ')}，`
    + `而上游产出的是${PORT_LABEL[src.produces]}`,
  );
}

/**
 * 嵌合（Scratch 式上下吸附）用同一套判据。
 *
 * 嵌合等价于一条隐式边，连接判据当然也该一致 ——
 * 否则会出现"拉线有提示、吸附上去没提示"的割裂。
 */
export function canStack(above: NodeSpec | null, below: NodeSpec | null): ConnectVerdict {
  return canConnect(above, below);
}

/* ------------------------------------------------------------------ */
/* 给 AI 消费的清单                                                    */
/* ------------------------------------------------------------------ */

export type BlockInfo = {
  kind: string;
  produces: PortKind;
  producesDesc: string;
  accepts: Accepts;
  /** 需要的外部能力（RunOptions 的键）。空数组 = 纯本地，浏览器模式也能跑 */
  requires: string[];
  /** 不在 fields 里、派生不出来的参数（如卡片组管的 llm 配置） */
  hiddenParams: ParamSpec[];
  /** true 表示参数需从 fields 派生（本文件不重复写） */
  paramsFromFields: boolean;
};

/**
 * 导出全部积木的契约，供 AI 拼装时参考。
 *
 * 刻意**不**在这里塞参数表：参数已经在各节点的 fields 里声明过一份，
 * 再抄一份就是"同一件事写两遍"，改一处忘另一处必然漂移。
 * 参数由调用方用 fields 派生（deriveParams），这里只标出去哪儿取。
 */
export function blockCatalog(): BlockInfo[] {
  return Object.keys(SPECS).sort().map((k) => {
    const s = SPECS[k];
    return {
      kind: k,
      produces: s.produces,
      producesDesc: s.producesDesc ?? PORT_LABEL[s.produces],
      accepts: s.accepts,
      requires: s.requires ?? [],
      hiddenParams: s.hiddenParams ?? [],
      paramsFromFields: !s.manualParams,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 参数表派生（在能 import fields 的地方调用）                          */
/* ------------------------------------------------------------------ */

/**
 * 从字段清单派生参数表。
 *
 * 这是**唯一**的参数来源 —— 本文件刻意不抄一份参数表，
 * 否则就是"同一件事写两遍"，改一处忘另一处必然漂移。
 *
 * custom 字段靠 FieldDef.spec 补齐（那段手写 JSX 读写的 key 从外面看不出来），
 * 没声明 spec 的 custom 会标成 unknown，提醒补声明。
 *
 * @param keyOf 从字段取参数名
 */
/*
 * 刻意不写 `readonly X[]`：strip-ts.py 处理不了 readonly 修饰符，
 * 会原样留下导致生成的 .mjs 语法错误。
 */
export function deriveParams(fields: unknown[]): ParamRow[] {
  const out: ParamRow[] = [];
  for (const raw of fields) {
    const f = (raw ?? {}) as Record<string, unknown>;
    const type = String(f.type ?? '');
    if (type === 'note') continue; // 纯说明，不是参数

    if (type === 'custom') {
      const spec = f.spec as { keys?: string[]; kind?: string } | undefined;
      if (spec?.keys?.length) {
        for (const k of spec.keys) out.push({ key: k, type: spec.kind ?? 'custom' });
      } else {
        out.push({ key: String(f.key ?? '(未命名)'), type: 'custom', unknown: true });
      }
      continue;
    }

    const key = f.key;
    if (typeof key === 'string' && key) out.push({ key, type });
  }
  return out;
}

export type ParamRow = { key: string; type: string; unknown?: boolean };

/** 派生结果里有多少参数没被声明清楚（用于测试盯住） */
export function unknownParams(params: ParamRow[]): number {
  return params.filter((p) => p.unknown).length;
}
