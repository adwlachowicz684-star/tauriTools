/**
 * types.ts 第 7 卷：tools。
 *
 * 实现按域分卷，types.ts 只留 re-export 入口；外部 175 处 import 路径不变。
 * 卷内代码按原文件行序原样保留（含私有辅助与初始化顺序），不要重排。
 */
import type { NodeData } from './condition';
import type { GraphNode, NodeSize, NodeStatus } from './core';

/* ================================================================== */
/* 工具节点：等待 / 日志标记 / 提示音 / 播放音频 / 当前时间 / 常量      */
/*                                                                    */
/* 这些节点都不依赖外部能力（不需要 CLI、凭据、文件系统通道），         */
/* 所以 engine/nodeRequires.ts 里没有它们 —— 也正因如此，             */
/* 浏览器模式下同样可用。                                              */
/* ================================================================== */

/**
 * 汇合（控制器）：等所有入边都到齐了才放行下游。
 *
 * 与"多入边节点默认的 OR 语义"的区别：
 *   普通节点 —— 只要有一条入边活着就跑（分支后汇合，走任一分支都能继续）
 *   汇合·宽松 —— 同上，但会把所有到齐的输入合并成一份输出
 *   汇合·严格 —— 任何一条入边没产出（被剪枝 / 跳过 / 失败）就算没收集全，
 *                 直接失败并让下游跳过
 */
/**
 * 判定方式 —— 闸门与重试共用。
 *
 * 单独抽出来是因为两者都在回答同一个问题："这份输出算不算合格"。
 * 各写一份的话，以后加一种判定方式要改两处。
 */
export type PassCheck =
  /** 非空即可 */
  | 'nonempty'
  /** 包含指定文本 */
  | 'contains'
  /** 不包含指定文本（如"响应里没有 error"） */
  | 'notContains'
  /** 匹配正则 */
  | 'regex';

/** 闸门：满足条件才放行下游 */
export type GateNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'gate';
  label: string;
  /** 等（轮询到超时）还是立刻判定（不满足直接失败） */
  mode: 'wait' | 'now';
  check: PassCheck;
  /** contains / notContains / regex 的比对值 */
  value?: string;
  /** wait 模式下的最长等待；到点仍未满足按 onTimeout 处理 */
  timeoutMs?: number;
  /** wait 模式的轮询间隔 */
  pollMs?: number;
  /** 等到超时仍未满足时：fail=失败并阻断下游，pass=照样放行 */
  onTimeout?: 'fail' | 'pass';
  status: NodeStatus;
  output: string;
  error: string;
};

/** 限流：控制放行的节奏 */
export type ThrottleNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'throttle';
  label: string;
  /** 两次放行之间的最小间隔（毫秒）。太快就等到够为止 */
  minIntervalMs: number;
  /** 本次运行最多放行几次；超出则失败。留空不限次 */
  maxPerRun?: number;
  status: NodeStatus;
  output: string;
  error: string;
};

/** 超时熔断：整条流程的预算超了就断在这里 */
export type TimeoutNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'timeout';
  label: string;
  /** 从**运行开始**算起的预算（毫秒），不是本节点自己的耗时 */
  budgetMs: number;
  /** 超预算时：fail=失败并阻断下游，pass=放行但记一条警告 */
  onExceed?: 'fail' | 'pass';
  status: NodeStatus;
  output: string;
  error: string;
};

/** 重试：上游成功了但内容不合格时，重跑它直到合格 */
export type RetryNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'retry';
  label: string;
  /** 要重跑的节点 id。通常填直接上游 */
  target: string;
  /** 最多重试几次（不含第一次） */
  times: number;
  /** 每次重试前的间隔 */
  intervalMs?: number;
  check: PassCheck;
  value?: string;
  status: NodeStatus;
  output: string;
  error: string;
};

export type JoinNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'join';
  label: string;
  /**
   * 严格程度。
   *   all    —— 宽松：活着的入边都到齐就放行（被剪枝的分支不算缺失）
   *   strict —— 严格：任何一条入边没产出都算没收集全
   */
  mode: 'all' | 'strict';
  /** 多个输入合并时的分隔符。支持 \n 之类的转义，默认换行 */
  joinBy?: string;
  status: NodeStatus;
  output: string;
  error: string;
};

export type WaitNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'wait';
  label: string;
  /** 等待毫秒数。支持模板，如 {{上游.output}} */
  ms: number;
  status: NodeStatus;
  output: string;
  error: string;
};

/** 日志标记：把一段文本写进运行日志，并把输出原样传给下游 */
export type LogNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'log';
  label: string;
  /** 支持模板。留空则输出上游内容 */
  text: string;
  /** 日志级别。warn / error 会带醒目标记，但都不会让流程失败 */
  level: 'info' | 'warn' | 'error';
  status: NodeStatus;
  output: string;
  error: string;
};

/**
 * 四种内置提示音。
 *
 * 刻意用 Web Audio **合成**而不是加载音频文件：
 *   · 不需要打包任何资源，也不依赖用户机器上有对应文件
 *   · 不读磁盘，因此不受 fs 授权目录限制
 *   · 浏览器与 Tauri 都能用（AudioContext 两边都有）
 */
export type BeepPreset = 'success' | 'fail' | 'notice' | 'alarm';

export const BEEP_PRESET_META: Record<BeepPreset, { label: string; hint: string }> = {
  success: { label: '成功', hint: '两声上行短音，跑完了听这个' },
  fail:    { label: '失败', hint: '两声下行低音，出错时听这个' },
  notice:  { label: '提醒', hint: '一声中音，需要你看一眼时用' },
  alarm:   { label: '警报', hint: '三声急促高音，别错过时用' },
};

/**
 * 声音来源：系统音效（Web Audio 合成）/ 本地音频文件。
 *
 * 提示音与播放音频原本是**两个节点**，但它们做的是同一件事
 * （响一声），且**都带 volume 字段**。差别只在声源：
 * 一个是内置预设音效（不需要任何文件），一个是本地文件（需要读盘）。
 * 分成两个节点后，音量校验那段逻辑就要写两遍 —— 漏一遍就是
 * "这个节点的音量不校验，填 5 也照跑"。
 *
 * 缺省 'preset'：老存档里没有这个字段，而它们当初的行为正是系统音效。
 */
export type SoundSource = 'preset' | 'file';

export const SOUND_SOURCE_META: Record<SoundSource, { label: string; hint: string }> = {
  preset: {
    label: '系统音效',
    hint: '由 Web Audio 实时合成，不需要任何音频文件，浏览器模式下也能响',
  },
  file: {
    label: '本地文件',
    hint: '播放 mp3 / wav / ogg，需要读取本地文件 —— 浏览器模式下不可用',
  },
};

export type BeepNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'beep';
  label: string;
  /** 声音来源。缺省 preset（系统音效） */
  source?: SoundSource;
  preset: BeepPreset;
  /** 仅 source='file'：音频文件路径，支持 {{上游.output}} */
  path?: string;
  /** 音量 0~1 */
  volume: number;
  /** 仅 source='file'：播完再往下走；关掉则立即返回（声音继续放） */
  waitForEnd?: boolean;
  status: NodeStatus;
  output: string;
  error: string;
};

/** 播放本地音频文件。需要 fs 能力，浏览器模式下不可用 */
export type PlayAudioNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'play-audio';
  label: string;
  /** 支持模板，如 {{上游.output}} */
  path: string;
  volume: number;
  /** 播完再往下走；关掉则立即返回（声音继续放） */
  waitForEnd: boolean;
  status: NodeStatus;
  output: string;
  error: string;
};

export type ClockNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'clock';
  label: string;
  /**
   * 格式串。支持的占位符：
   *   YYYY MM DD HH mm ss SSS
   * 其它字符原样输出，所以 "YYYY-MM-DD" 直接可用。
   */
  format: string;
  status: NodeStatus;
  output: string;
  error: string;
};

/**
 * 常量节点上的一张卡。
 *
 * 一个常量节点可以放**多张卡**（价格、阈值、开关……），每张卡各产出
 * 一个值、各带一个输出端口 —— 于是"把阈值接到大于上、把价格接到写入上"
 * 不用摆三个节点，也不用连线互相看不见。
 */
export type ConstItem = {
  id: string;
  /**
   * 这张卡的名字。
   *
   * 两个用途，都必须是人能读的中文：
   *   · 输出端口的名字（卡片上那一行、报错文案里"接的是上游「价格」"）
   *   · 模板引用 {{节点id.价格}} 读的字段
   * 留空则显示默认值（见 constItemLabel）。
   */
  name?: string;
  /** 值种类。老数据没有 → 按 text */
  valueType?: ConstValueType;
  /** 固定输出。支持模板 */
  value: string;
};

/** 卡片的显示名。没起名时退回种类名，保证输出端口永远有名字可显示 */
export function constItemLabel(it: ConstItem, i: number): string {
  return (it.name ?? '').trim() || `${CONST_TYPE_LABEL[it.valueType ?? 'text']}${i + 1}`;
}

/**
 * 常量卡的**连线键**：连线上记的是它，且改名不会断线。
 *
 * 用 id 而不是 name，是因为 name 由用户随时改 ——
 * 用 name 当键的话，改一次名，已经连好的线就取不到值了
 * （表现为"保留手填值"，不报错，最难查）。
 * 模板引用仍用 name（要人能读懂），由执行器额外写一份。
 */
export function constItemKey(it: ConstItem, i: number): string {
  return it.id || `c${i}`;
}

/** 常量卡自身的问题。与 canvasParams 的 ParamCardIssue 同形，可直接并入 */
export type ConstCardIssue = { field: string; message: string };

/**
 * 常量卡本身的问题（重名）。
 *
 * ================= 为什么必须盯 =================
 *
 * 执行器按卡名往 fields 里再写一份（模板引用要人能读懂的名字）：
 *     fields[卡id] = v;      ← 参数连线按这个取
 *     fields[卡名] = v;      ← {{节点id.卡名}} 按这个取
 * 两张卡同名时**后写的静默覆盖先写的**，于是模板取到的是后那张 ——
 * 而界面上两张卡都在、连线也都在（连线按 id，不受影响）、都不报错。
 *
 * 参数卡（canvasParams.paramIssues）那边已经盯了重名，
 * 常量卡这边此前没有 —— 同样的形态、同样的失效方式，只盯一边就是漏一半。
 *
 * 只报重名，不报空名：空名时端口还有默认显示名，
 * 且参数连线照样能用，那不是"取错值"，不值得标红。
 */
export function constIssues(items: ConstItem[]): ConstCardIssue[] {
  const issues: ConstCardIssue[] = [];
  const seen = new Set<string>();
  (items ?? []).forEach((it, i) => {
    const n = String(it?.name ?? '').trim();
    if (!n) return;
    if (seen.has(n)) {
      issues.push({
        field: n,
        message: `重名了 —— {{节点id.${n}}} 只会取到后一张，连线不受影响（它按卡 id 取）`,
      });
    }
    seen.add(n);
  });
  return issues;
}

/**
 * 一个常量节点有哪些卡。
 *
 * items 是**唯一**的数据源 —— 没有"顶层 value / valueType 合成一张"的兜底。
 *
 * 曾经有过兜底（老节点只有顶层两个字段，读时合成一张），它带来三处代价：
 *   · 顶层字段必须与第一张卡双向镜像，写卡时漏一处就是
 *     "界面看着改了、跑出来还是旧的"，且不报错
 *   · 卡的 id 是合成出来的常量 'c0'，不是用户那张卡的 id
 *   · 只读顶层字段的地方（导出说明）永远只看得见第一张卡
 * 老画布不管，兜底撤掉，数据只有一份。
 */
export function constsOf(d: ConstNodeData | null | undefined): ConstItem[] {
  /*
   * 可选链不是多余的：producesArgOf 允许不带 data 调用（"这个节点产出什么"），
   * 那是**合法**用法 —— 少了它会直接抛 TypeError，而不是返回"没有卡"。
   */
  return Array.isArray(d?.items) ? d.items : [];
}

/** 新卡的 id。前缀固定，便于在存档里一眼认出 */
export function newConstId(): string {
  return `ci${Math.random().toString(36).slice(2, 8)}`;
}

export type ConstNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'const';
  label: string;
  /**
   * 常量卡 —— **唯一的数据源**。
   *
   * 每张卡各自有 valueType / value，节点上不再有顶层的那两个字段：
   * 两份数据意味着每次写卡都要镜像一遍，漏一处就是
   * "卡片显示变了、跑出来还是旧的"，且不报错。
   */
  items: ConstItem[];
  status: NodeStatus;
  output: string;
  error: string;
};

/**
 * 常量节点的种类。
 *
 * 三种不是"换个输入控件"这么简单 —— 它们**产出的值种类不同**：
 * 数字常量接到「大于」上合法，接到「包含」上才是错参；
 * 布尔常量接到条件判定上合法，接到加减乘除上是错参。
 * 所以种类必须参与参数类型校验（见 argTypes / paramLinks）。
 */
export type ConstValueType = 'text' | 'num' | 'bool';

/**
 * 三种种类的名字（卡片上的「种类」格与面板下拉共用）。
 *
 * 放在 types.ts（数据层）而不是节点定义里：defs/const.ts 反过来 import
 * types.ts —— 表写在 defs 里就成环了。
 *
 * 用短名字（「文本」而不是「文本常量」）：合并成**一个**常量节点之后，
 * 节点本身已经叫「常量」了，种类格再写「文本常量」就成了「常量 · 文本常量」。
 */
export const CONST_TYPE_LABEL: Record<ConstValueType, string> = {
  text: '文本',
  num: '数字',
  bool: '布尔',
};

/**
 * 把各种"真 / 假"的写法收敛成 'true' / 'false'。
 *
 * 与执行器共用同一份（执行器直接 import 它），否则卡片上显示「真」、
 * 运行却输出 'false' —— 正是最难查的"看着对、跑着不对"。
 */
export function normBoolText(raw: string): string {
  const s = String(raw ?? '').trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on', '是', '真'].includes(s)) return 'true';
  return 'false';
}

export function makeGateNode(id: string, partial: Partial<GateNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'gate',
      label: partial.label ?? '闸门',
      mode: partial.mode ?? 'wait',
      check: partial.check ?? 'nonempty',
      value: partial.value ?? '',
      timeoutMs: partial.timeoutMs ?? 10000,
      pollMs: partial.pollMs ?? 500,
      onTimeout: partial.onTimeout ?? 'fail',
      status: 'idle',
      output: '',
      error: '',
    } as unknown as GateNodeData,
  } as unknown as GraphNode;
}

export function makeThrottleNode(id: string, partial: Partial<ThrottleNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'throttle',
      label: partial.label ?? '限流',
      minIntervalMs: partial.minIntervalMs ?? 1000,
      maxPerRun: partial.maxPerRun,
      status: 'idle',
      output: '',
      error: '',
    } as unknown as ThrottleNodeData,
  } as unknown as GraphNode;
}

export function makeTimeoutNode(id: string, partial: Partial<TimeoutNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'timeout',
      label: partial.label ?? '超时熔断',
      budgetMs: partial.budgetMs ?? 60000,
      onExceed: partial.onExceed ?? 'fail',
      status: 'idle',
      output: '',
      error: '',
    } as unknown as TimeoutNodeData,
  } as unknown as GraphNode;
}

export function makeRetryNode(id: string, partial: Partial<RetryNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'retry',
      label: partial.label ?? '重试',
      target: partial.target ?? '',
      times: partial.times ?? 3,
      intervalMs: partial.intervalMs ?? 1000,
      check: partial.check ?? 'nonempty',
      value: partial.value ?? '',
      status: 'idle',
      output: '',
      error: '',
    } as unknown as RetryNodeData,
  } as unknown as GraphNode;
}

export function makeJoinNode(id: string, partial: Partial<JoinNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'join',
      label: partial.label ?? '汇合',
      mode: partial.mode ?? 'all',
      joinBy: partial.joinBy ?? '\\n',
      status: 'idle',
      output: '',
      error: '',
    } as unknown as JoinNodeData,
  } as unknown as GraphNode;
}

export function makeWaitNode(id: string, partial: Partial<WaitNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'wait',
      label: partial.label ?? '等待',
      ms: partial.ms ?? 2000,
      status: 'idle',
      output: '',
      error: '',
    } as WaitNodeData,
  };
}

export function makeLogNode(id: string, partial: Partial<LogNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'log',
      label: partial.label ?? '日志标记',
      text: partial.text ?? '',
      level: partial.level ?? 'info',
      status: 'idle',
      output: '',
      error: '',
    } as LogNodeData,
  };
}

export function makeBeepNode(id: string, partial: Partial<BeepNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'beep',
      label: partial.label ?? '播放声音',
      source: partial.source ?? 'preset',
      preset: partial.preset ?? 'success',
      path: partial.path ?? '',
      volume: partial.volume ?? 0.6,
      waitForEnd: partial.waitForEnd ?? true,
      status: 'idle',
      output: '',
      error: '',
    } as BeepNodeData,
  };
}

export function makePlayAudioNode(id: string, partial: Partial<PlayAudioNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'play-audio',
      label: partial.label ?? '播放音频',
      path: partial.path ?? '',
      volume: partial.volume ?? 0.8,
      waitForEnd: partial.waitForEnd ?? true,
      status: 'idle',
      output: '',
      error: '',
    } as PlayAudioNodeData,
  };
}

export function makeClockNode(id: string, partial: Partial<ClockNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'clock',
      label: partial.label ?? '当前时间',
      format: partial.format ?? 'YYYY-MM-DD HH:mm:ss',
      status: 'idle',
      output: '',
      error: '',
    } as ClockNodeData,
  };
}

/**
 * 模块节点 —— 画布上一个模块的实例。
 *
 * 两种状态，二选一：
 *   · 跟随（moduleId 有值、inner 为空）：结构来自模块库，改库则所有实例跟着变
 *   · 脱钩（inner 有值）：自带一份结构副本，与模块库再无关系
 *
 * 为什么用"有 inner 就是脱钩"而不是再存一个 detached 布尔：
 * 两个标志位可能不同步（比如 inner 还在但 detached=false），
 * 而"有没有自带结构"本身就是脱钩的定义，不需要第二个真相。
 */
export type ModuleNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'module';
  label: string;
  /** 跟随的模块 id；脱钩后为空串 */
  moduleId: string;
  /** 脱钩后的自带结构；跟随状态下为 null */
  inner: { nodes: unknown[]; edges: unknown[] } | null;
  status: NodeStatus;
  output: string;
  error: string;
};

export function makeModuleNode(id: string, partial: Partial<ModuleNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'module',
      label: partial.label ?? '模块',
      moduleId: partial.moduleId ?? '',
      inner: partial.inner ?? null,
      status: 'idle',
      output: '',
      error: '',
    } as ModuleNodeData,
  };
}

export function isModule(d: NodeData): d is ModuleNodeData {
  return (d as ModuleNodeData).kind === 'module';
}
