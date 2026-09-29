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
 * 平台清单从 types.ts 派生，不在这里手抄一份。
 *
 * 抄一份就是"同一件事写两遍"：加平台时漏改这里，
 * 契约会安静地少几个平台 —— 不报错，只是 AI 拼出来的流程用不上。
 */
import { UPDATE_SOURCE_KEYS, OP_META, type ConditionOp } from '../types';

/*
 * 算子清单同样从 types.ts 派生。
 *
 * 以前这里手抄了 6 个（desc 里还写了「常用」来软化它），而 OP_META 有 9 个 ——
 * 漏掉的是 notEquals / startsWith / regex。
 *
 * 后果与 update 那次一模一样：拼装方只看 options，于是条件节点永远配不出
 * 「匹配正则」「不等于」「开头是」三种规则 —— 流程能跑、不报错，
 * 只是这三种分支你根本不会想到去用。
 */
const CONDITION_OPS: string[] = Object.keys(OP_META) as ConditionOp[];

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
  /**
   * 除主输出外还能取到的**具名输出字段**。
   *
   * ================= 为什么契约里必须有这一项 =================
   *
   * TEMPLATE_VARS 里明写了 `{{节点id.字段名}}` 可以取"节点产出附加字段"，
   * 并且 warn 说"字段名由各节点的 nodeFields 决定，不是所有节点都有"。
   * 但在补上这一项之前，**没有任何一处告诉消费方每个节点有哪些字段名** ——
   * AI 只能猜，猜错的结果不是报错，而是模板取到空串：
   * 下游拿到空值继续往下跑，界面与日志都正常，只有结果不对。
   *
   * 卡片上那些可拖的出口（NODE_OUTPUTS）对 AI 也不可见：它拼的是数据，
   * 不是拖线，所以"有功能但够不着"这一侧只能靠这里补。
   *
   * ================= 为什么不在这里手抄一份清单 =================
   *
   * 字段的**唯一定义处**是 engine/paramLinks.ts 的 NODE_OUTPUTS
   * （它是"卡片上画几个出口、连线取哪个值"的依据）。
   * 在这里再写一份就是同一件事写两遍，加字段时漏改必然漂移 ——
   * 而漂移的表现恰恰又是"少几个能取的值"，安静且难发现。
   *
   * 所以这里只留**类型与位置**，值由 blockCatalog(outFieldsOf) 注入：
   * engine/blockApi.ts 能 import paramLinks（nodeSpec 不能，依赖方向是
   * paramLinks → nodeSpec），由它把真实清单喂进来。
   */
  outFields?: OutField[];
};

/**
 * 一个具名输出字段。
 *
 * label 用**人话名字**（如「标题」「状态码」），不是 key ——
 * 报错文案与模板提示里出现的都该是前者。
 */
export type OutField = {
  /** 字段名，用于 {{节点id.字段名}} 与连线取值 */
  key: string;
  /** 显示名 */
  label: string;
  /** 这个值的种类（用于参数连线校验）。不写按文本 */
  kind?: string;
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
  /*
   * 触发器改成"一个节点可挂多种触发方式"之后，契约必须跟着改。
   *
   * 上一版这里写的是单值 `mode`，且 options 里最后一种是 `conversation`
   * —— 实际类型早已是 `triggers: TriggerKind[]`，最后一种叫 `chat`。
   *
   * 这份契约经 blockCatalog() 喂给拼装方，于是它拼出来的节点
   * 写的是 `mode: 'webhook'`，而运行时读的是 `triggers` 数组 ——
   * 数组为空 = **这个触发器永远不会触发**，且不报错、界面看着也正常
   * （卡片上还显示着触发方式那一行）。比"少几个可选平台"严重一档。
   */
  trigger: S('text', 'none', '流程的初始输入（手动文本 / 触发带来的内容）', {
    manualParams: true,
    params: [
      {
        key: 'triggers',
        desc: '触发方式列表（可以同时挂多种，任一满足即触发）。'
          + '写单个字符串与写单元素数组等价',
        required: true,
        options: ['manual', 'interval', 'cron', 'watch', 'webhook', 'chat'],
      },
      {
        key: 'config',
        desc: '各类触发方式的配置，按 kind 取对应字段，未用到的留默认即可：'
          + 'intervalSec（interval，最小 10）/ cronExpr（cron，五段表达式）/ '
          + 'watchDir + watchExts + 防抖（watch）/ 端口与路径（webhook）',
      },
      { key: 'input', desc: '手动触发时的初始文本（其余方式由事件内容填入）' },
      { key: 'enabled', desc: '是否启用；false 时该触发器不参与任何触发判定' },
    ],
  }),

  /*
   * 任务：CLI 的输出。
   *
   * paneId 是**函数调用产出的字段**（paneField()），不是字面量对象 ——
   * 源码扫描器认不出函数调用，于是文档参数表里**没有它**，
   * AI 拼装时也就不知道"CLI 节点可以挂窗格、共享配置从窗格继承"。
   *
   * 这类字段正是 hiddenParams 存在的理由：fields 里看不出来，
   * 但它是真实可写的键（走 def.create() 或 patch 都行）。
   */
  task: S('text', 'any', 'CLI 的执行输出', {
    hiddenParams: [
      {
        key: 'paneId',
        desc: '所属任务窗格（taskPane）的 id。留空 = 不挂窗格。'
          + '挂了之后：节点上填了的项优先，没填的从窗格继承（工作目录 / 默认连接 / 模型 / 自动批准）'
          + ' —— 窗格改一次，整组跟着变。由 paneField 卡片组提供。',
      },
    ],
  }),

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
      { key: 'op', desc: '算子，判定上游文本是否满足条件', options: CONDITION_OPS },
    ],
  }),
  /*
   * 循环只写了 mode / maxIterations 两个，而实际可填的有 8 个 ——
   * 漏掉的 times / separator / source / pattern / onError / collect
   * 拼装方一概不知，于是拼出来的循环永远是默认的那一套
   * （list 模式、3 次、\n 分隔、出错继续、汇总开启）。
   * 流程能跑、不报错，只是行为永远是默认值 —— 正是最难查的一类。
   */
  loop: S('any', 'any', '透传（循环体每轮一次，done 出口汇总一次）', {
    manualParams: true,
    params: [
      {
        key: 'mode',
        desc: '循环方式：times = 固定次数；list = 把上游输出按分隔符切成列表逐条跑；'
          + 'glob = 文件通配符展开（配合文件节点用）',
        required: true,
        options: ['times', 'list', 'glob'],
      },
      { key: 'times', desc: 'times 模式下的迭代次数（1-1000）' },
      { key: 'separator', desc: 'list 模式的分隔符，默认 \\n。注意它是真换行符，不是字面 "\\n"' },
      { key: 'source', desc: 'list 模式下取哪个上游的输出（节点 id）；留空用拼接后的上游输出' },
      { key: 'pattern', desc: 'glob 模式的通配符，如 src/**/*.ts' },
      { key: 'maxIterations', desc: '最大轮数上限（安全网，超出即停）' },
      { key: 'onError', desc: '某一轮失败时：continue = 跳过该轮继续，只要还有成功的轮整条循环就算完成（全部轮都失败才算失败）；stop = 整个循环停下', options: ['continue', 'stop'] },
      { key: 'collect', desc: '是否把每轮结果汇总到 done 出口；false 时 done 出口不带内容' },
    ],
  }),
  parallel: S('any', 'any', '透传', {
    manualParams: true,
    params: [
      {
        key: 'mode',
        desc: '并发模式：fixed = 固定并发数；byRule = 按条件规则从上到下第一条命中的决定；'
          + 'all = 不限制，全部并行',
        required: true,
        options: ['fixed', 'byRule', 'all'],
      },
      { key: 'concurrency', desc: 'fixed 模式下的并发度（同时跑几个）' },
      {
        key: 'rules',
        desc: 'byRule 模式的规则列表，从上到下判定、第一条命中即用其并发数。'
          + '每条 = { id, op, value, concurrency, label? }；op 与条件节点同一套算子。'
          + 'mode 为 byRule 时必填，否则并发数无从决定',
        options: CONDITION_OPS,
      },
      { key: 'fallbackConcurrency', desc: 'byRule 模式下所有规则都没命中时用的并发数' },
    ],
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

  /*
   * 合并后的大模型节点：一个节点覆盖三种用途。
   *
   * **以前这里根本没有 llmChat 这一条** —— 它是后来加的节点，
   * 契约没跟上。后果是导出脚本与"这条链在本机能不能跑"的判定
   * 对它一无所知：没配 llmCaller 时直接抛 "is not a function"，
   * 而 ocr / translate 有契约，会给出"未提供大模型调用执行器"。
   * 合并后三种用途都走这一个 kind，补上这一条才算对齐。
   */
  llmChat: S('text', ['text', 'files', 'any'], '模型的回复文本', {
    hiddenParams: [
      { key: 'llm', desc: '大模型配置 { url, model, apiKey, timeoutSec }。由 llm-config 卡片组提供，建节点时 def.create() 会填默认值' },
      /*
       * use 决定后面哪些字段生效 —— 不写清楚的话 AI 拼出来一个
       * use='translate' 却不填 targetLang 的节点，运行时才报
       * "未指定目标语言"，而拼装阶段看不出问题。
       */
      { key: 'use', desc: '用途', options: ['chat', 'ocr', 'translate'] },
      { key: 'imageSource', desc: '仅 use=ocr："file" 走本地读图（需 imageReader 能力），"url" 走网络地址', options: ['file', 'url'] },
      { key: 'url', desc: '仅 use=ocr 且 imageSource=url：图片地址，需 http(s) 或 data:image/ 开头' },
      { key: 'path', desc: '仅 use=ocr 且 imageSource=file：本地图片路径' },
      { key: 'detail', desc: '仅 use=ocr：图片细节', options: ['auto', 'low', 'high'] },
      { key: 'targetLang', desc: '仅 use=translate：目标语言。可填预设码（zh / en），也可填「简练的文言文」这类自由描述', required: true },
      { key: 'sourceLang', desc: '仅 use=translate：源语言，留空或 auto 让模型自动判断' },
      { key: 'glossary', desc: '仅 use=translate：术语表，每行「原文=译文」' },
      /*
       * 同 task：paneField() 是函数调用，扫描器看不出，
       * 文档参数表里没有这一项。不写在这里，AI 拼出来的大模型节点
       * 永远拿不到窗格上那一份连接 / 模型 / 角色设定 / 温度。
       */
      {
        key: 'paneId',
        desc: '所属任务窗格（apiPane）的 id。留空 = 不挂窗格。'
          + '挂了之后：system / temperature 没填时用窗格那一份，连接与模型也可继承。'
          + '由 paneField 卡片组提供。',
      },
    ],
  }),

  // 外部服务
  /*
   * 更新检测其实**有** fields（各平台共用 updateFields），
   * 参数该从字段派生 —— 盲测时标成 manualParams 且只写了 source，
   * 结果 AI 不知道还要填 biliUid / feedUrl，跑出来
   * "Cannot read properties of undefined (reading 'trim')"。
   *
   * ================= 合并成多目标之后 =================
   *
   * 现在的更新检测是**一个节点盯多个平台**：数据在 targets 数组里，
   * 每张卡自己带 kind（盯哪个平台）与 feedUrl（订阅源地址）。
   *
   * 而这份契约在合并后**一直没跟上** —— 它还写着单目标时代的
   * `source` 且只列了 bilibili / wechat 两个取值。后果是：
   *
   *   blockCatalog() 是给 AI 拼装用的，它告诉消费方"这个节点只有两个平台"，
   *   于是拼出来的流程永远用不上小红书 / 微博 / 知乎等其余 15 个平台；
   *   而且 contract 里没提 feedUrl，AI 也不会去填。
   *
   * 这类失效**不报错**：老字段靠 targetsOf() 读时合成，流程照样能跑，
   * 只是能力少了一大截，而界面与日志看着都正常。
   *
   * 平台清单刻意从 UPDATE_SOURCE_KEYS 派生，不在这里手抄 ——
   * 抄一份就必然漂移（这行的上一版就是漂移的活证据）。
   *
   * ================= 为什么必须标 manualParams =================
   *
   * 这个 kind **自己没有 fields**（update.tsx 走 Inspector），
   * 但文档生成器是按 dataKind 收文件的，而 legacy 的 bili.ts / wechat.ts
   * **dataKind 同样是 'update'** 且写着 `fields: () => updateFields`。
   *
   * 于是"自动派生"会去读 updateFields.tsx，抓出合并前那 8 项旧字段
   * （biliUid / biliMode / biliCookie / feedUrl / userAgent …）排在最前面，
   * 真正的 targets 反而被挤到最后一行、还被标成"隐藏"。
   *
   * 后果不是报错，而是**教错**：照那份文档去填顶层的 biliUid / feedUrl，
   * targetsOf() 的兼容路径会把它们合成一张卡 —— 能跑、不报错，
   * 但只能盯一个源，想盯小红书时合成出来的是默认那一种。
   *
   * 所以这里显式声明 manualParams，让参数表只写 targets。
   */
  update: S('bool', 'none', '是否有更新（true / false）—— 给条件节点判断', {
    manualParams: true,
    params: [
      /*
       * kind 的取值是 'bilibili'（完整拼写），不是 'bili' ——
       * 'bili' 是节点的 **type**，'bilibili' 是 kind 的取值。
       * 盲测时写成 'bili' 导致走不进 bilibili 分支，
       * 掉进 wechat 分支去 trim 空的 feedUrl，报
       * "Cannot read properties of undefined (reading 'trim')"。
       */
      {
        key: 'targets',
        desc: '要盯的目标列表（唯一数据源）。每张 = { id, kind, name, feedUrl, enabled, lastSeenId }；'
          + 'kind 决定盯哪个平台（取值是完整拼写如 bilibili，不是节点 type bili），'
          + 'feedUrl 是订阅源地址 —— 除 youtube / podcast 外都没有官方源，'
          + '地址要照 UPDATE_SOURCE_META[kind].route 的示例拼。'
          + '新建节点用 def.create()，它会直接落一份 targets；不要建顶层的 source / feedUrl —— '
          + '老存档缺 targets 时由 targetsOf() 读时合成一张卡，那是兼容路径，不是写入路径。',
        options: UPDATE_SOURCE_KEYS,
        required: true,
      },
      /*
       * 下面四项是**节点级**参数：所有目标共用，不在卡片里。
       *
       * 它们与 biliUid / biliMode / biliCookie / feedUrl 那套旧字段
       * **名字完全不同、互不重叠**，但上一版文档把两者混在了一张表里
       * （因为旧版 bili / wechat 与 update 共用 dataKind），
       * 于是"去掉废弃字段"时把它们一起去掉了 ——
       * 而执行器一直在读：timeoutSec 缺了就退回默认 15 秒，
       * outputFormat 缺了就退回布尔输出。不报错，只是配不上去。
       */
      {
        key: 'outputFormat',
        desc: '输出格式：bool 只给 true / false（给条件节点判断），detail 额外带上标题 / 链接 / 时间',
        options: ['bool', 'detail'],
      },
      { key: 'timeoutSec', desc: '每个目标的抓取超时（秒）；留空用默认 15' },
      {
        key: 'userAgent',
        desc: '自定义 User-Agent；部分订阅源会拒绝默认的非浏览器 UA，留空用默认值',
      },
      {
        key: 'firstRunAsUpdate',
        desc: '首次运行（还没有基线）时也算作更新。默认关闭 —— 刚配好就触发一次下游通常是误报',
      },
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
  /*
   * 常量是多张卡（items 数组），fields 写不出数组结构 ——
   * 走自定义面板，参数说明在这里手写。
   * 不写的话 AI 会以为常量只有 value 一个字段，加不出第二张卡。
   */
  /*
   * 常量：只有 items 一组数据，没有顶层的 value / valueType。
   *
   * 参数说明手写（manualParams）—— fields 是平面的，写不出"卡片数组"。
   * 说明里若还列 value / valueType 那两个老字段，AI 会往一个没人读的
   * 地方写值：界面不报错、跑出来也不变，是最难查的一类。
   */
  const: S('text', 'none', '第一张卡的值（多卡时见具名输出）', {
    manualParams: true,
    params: [
      {
        key: 'items',
        desc: '常量卡列表（唯一数据源）。每张 = { id, name, valueType, value }；'
          + 'valueType 取 text / num / bool，name 是输出端口名与模板引用名 '
          + '（{{节点id.卡名}}），value 支持 {{模板}}。连线记的是卡 id，改名不断线。'
          + '新建时至少一张卡；要加值就往 items 里加一张，不要建顶层字段。',
      },
    ],
  }),
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

  // 跨画布
  canvasRef: S('any', 'any', '被调用画布的出口结果'),
  canvasIn: S('any', 'any', '外部传进来的内容（原样透传）'),
  canvasOut: S('any', 'any', '要送出画布的内容'),

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
  executor: '(node, rendered, onChunk) => Promise<string>（CLI 的完整输出）',
  tableReader: '(path) => Promise<string>（表格文件的文本）',
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
  /**
   * 除主输出外还能取到的具名输出字段。
   *
   * 不传 outFieldsOf 时为空 —— 那不是"这个节点没有具名字段"，
   * 而是"调用方没能提供清单"。要完整版请用 blockApi 的 catalog()。
   */
  outFields: OutField[];
};

/**
 * 导出全部积木的契约，供 AI 拼装时参考。
 *
 * 刻意**不**在这里塞参数表：参数已经在各节点的 fields 里声明过一份，
 * 再抄一份就是"同一件事写两遍"，改一处忘另一处必然漂移。
 * 参数由调用方用 fields 派生（deriveParams），这里只标出去哪儿取。
 */
export function blockCatalog(
  outFieldsOf?: (kind: string) => OutField[],
): BlockInfo[] {
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
      outFields: outFieldsOf ? outFieldsOf(k) : [],
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
 * 不写 `readonly X[]`：这里不需要只读约束，写了反而让入参类型变复杂，
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
