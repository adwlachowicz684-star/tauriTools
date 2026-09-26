import type {
  ConditionNodeData, TriggerNodeData, ParallelNodeData, LoopNodeData,
  FsNodeData, OcrNodeData, TranslateNodeData, UpdateNodeData,
  GithubUpdateNodeData, GithubPushNodeData, GenericHttpNodeData,
  ExtractNodeData, TaskNodeData, WaitNodeData, BeepNodeData,
  PlayAudioNodeData, ClockNodeData, ConstNodeData, ModuleNodeData,
  JoinNodeData, GateNodeData, ThrottleNodeData, TimeoutNodeData, RetryNodeData,
  LlmChatNodeData,
} from '../types';
import { targetsOf, UPDATE_SOURCE_META, needsFeedUrl, constsOf, constItemLabel } from '../types';
import { triggerEntriesOf, entryEnabled, mergeConfig } from './triggerEntries';
import { argTypeIssues, type ArgTypeIssue } from './argTypes';

/**
 * 节点配置校验 —— 画布圆点的三色预警。
 *
 * ================= 三档语义 =================
 *
 *   ok（绿）   配置齐全
 *   warn（黄） 有缺项，但**能跑通** —— 有默认值兜底，或该项本就可选
 *   error（红） 信息不全，**会阻断** —— 跑起来必然失败或毫无意义
 *
 * 黄与红的分界是"能不能跑通"，不是"重不重要"。
 * 把"没填工作目录"判成红色会让画布一片红，
 * 而它实际会用默认目录正常执行 —— 假警报比没警报更糟，
 * 用户会很快学会忽略圆点。
 *
 * ================= 为什么放一个文件 =================
 *
 * 执行器是一节点一文件（每个几十行），校验规则只有几行且需要互相参照
 * （比如"缺连接"在拉取是黄、在推送是红），拆散了反而看不出这个对照。
 * 集中一处，规则表一目了然。
 *
 * 与执行器同样刻意**不 import 任何 React**：
 * 画布卡片要用它、单测要在 Node 下直接跑它。
 */

export type IssueLevel = 'ok' | 'warn' | 'error';

export type NodeIssue = {
  level: IssueLevel;
  messages: string[];
  /**
   * 红色是不是由**参数类型错误**引起的。
   *
   * 缺参与错参都是红灯，但改法完全不同：
   *   缺参 → 补一个值
   *   错参 → 把一个值改成别的类型
   *
   * 不区分的话，徽章上都显示「缺参」，用户以为自己忘了填，
   * 于是又填一遍 —— 越填越错。
   */
  typeError?: boolean;
};

type V = { level: IssueLevel; messages: string[] };

function ok(): V {
  return { level: 'ok', messages: [] };
}
function warn(...m: string[]): V {
  return { level: 'warn', messages: m };
}
function error(...m: string[]): V {
  return { level: 'error', messages: m };
}

const blank = (v: unknown): boolean => !String(v ?? '').trim();

/* ------------------------------------------------------------------ */
/* 各节点的校验                                                        */
/* ------------------------------------------------------------------ */

function vTask(d: TaskNodeData): V {
  if (blank(d.prompt)) return error('没填提示词 —— CLI 无从下手');
  const msgs: string[] = [];
  /*
   * 挂了窗格的节点，这两项可能是从窗格继承来的（见 engine/pane.ts）。
   * 一律说"会用默认目录"是句假话：窗格上配了目录，跑的就是那个目录，
   * 而节点上确实空着 —— 界面报一句与实际不符的提示，
   * 用户会照着它去改一个本来没问题的节点。
   *
   * 所以挂在窗格下的节点改成让人去看窗格，而不是替它下结论。
   */
  const inPane = !blank(d.paneId);
  // 都有默认值兜底：用默认工作目录、用该 CLI 的默认模型
  if (blank(d.workdir)) msgs.push(inPane ? '没填工作目录，看窗格上配了没有' : '没填工作目录，会用默认目录');
  if (blank(d.model)) msgs.push(inPane ? '没指定模型，看窗格上配了没有' : '没指定模型，会用默认模型');
  return msgs.length ? warn(...msgs) : ok();
}

function vCondition(d: ConditionNodeData): V {
  const rules = Array.isArray(d.rules) ? d.rules : [];
  if (rules.length === 0) {
    // 有条兜底分支就能走下去，只是"永远走兜底"
    return d.defaultBranch
      ? warn('没有配置规则，只会走兜底分支')
      : error('没有配置规则 —— 判断不出该走哪个分支');
  }
  const empty = rules.filter(
    (r) => !Array.isArray(r.conditions) || r.conditions.length === 0,
  );
  if (empty.length > 0) {
    return warn(`${empty.length} 条规则里没有条件，它们永远不会命中`);
  }
  return ok();
}

function vTrigger(d: TriggerNodeData): V {
  /*
   * 按**触发条件卡片**逐个校验。
   *
   * 以前是"一份共享 config + 一个 kind 数组"，于是两张卡共用同一份配置：
   * 「周期」卡填了秒数、「监听」卡没填目录，两者会互相掩盖 ——
   * 共享字段被其中一张填上了，另一张就查不出自己缺什么。
   */
  const entries = triggerEntriesOf(d as unknown as Record<string, unknown>);
  if (entries.length === 0) return error('还没添加触发条件');

  const base = d.config ?? ({} as never);
  const msgs: string[] = [];
  let blocked = false;

  for (const e of entries) {
    // 停用的卡不参与校验 —— 它会让人以为"配好了却跑不起来"
    if (!entryEnabled(e)) continue;
    const cfg = mergeConfig(base, e.config);
    const k = e.kind;
    if (k === 'cron' && blank(cfg.cronExpr)) {
      msgs.push('cron 没填表达式');
      blocked = true;
    }
    if (k === 'watch' && blank(cfg.watchDir)) {
      msgs.push('目录监听没填目录');
      blocked = true;
    }
    if (k === 'chat') {
      if (blank(cfg.chatDir)) { msgs.push('对话触发没填对话目录'); blocked = true; }
      if (blank(cfg.chatKeywords)) { msgs.push('对话触发没填关键词'); blocked = true; }
    }
    if (k === 'interval') {
      const sec = Number(cfg.intervalSec);
      if (!Number.isFinite(sec) || sec < 10) {
        msgs.push('定时间隔无效（最小 10 秒）');
        blocked = true;
      }
    }
  }

  // 全部停用 = 这个节点永远不会触发，要说清楚
  if (entries.every((e) => !entryEnabled(e))) {
    msgs.push('所有触发条件都已停用');
  }

  if (blocked) return error(...msgs);
  /*
   * 口径必须是 `=== false`，不能写 `!d.enabled`。
   *
   * 老存档里没有 enabled 字段（这个字段是后来加的），取到 undefined。
   * `!undefined` 为真 → 明明是好好的触发器，界面上却写着"已停用"、
   * 校验也跟着报"不会被自动触发"，而属性面板那个勾选框用的是
   * `!== false`（显示勾选）—— 三处口径不一致，用户看到的就是
   * "这边说停用、那边说启用"，且完全不知道是自己改过还是坏了。
   */
  if (d.enabled === false) msgs.push('触发器已停用，不会被自动触发');
  return msgs.length ? warn(...msgs) : ok();
}

function vParallel(d: ParallelNodeData): V {
  if (d.mode === 'fixed') {
    const c = Number(d.concurrency);
    if (!Number.isFinite(c) || c < 1) return error('固定并发数无效（至少为 1）');
    return ok();
  }
  const rules = Array.isArray(d.rules) ? d.rules : [];
  if (rules.length === 0) {
    const fb = Number(d.fallbackConcurrency);
    return Number.isFinite(fb) && fb >= 1
      ? warn('没有配置并发规则，会用兜底并发数')
      : error('没有规则也没有兜底并发数');
  }
  return ok();
}

function vLoop(d: LoopNodeData): V {
  if (d.mode === 'times') {
    const t = Number(d.times);
    if (!Number.isFinite(t) || t < 1) return error('循环次数无效（至少为 1）');
    return ok();
  }
  if (d.mode === 'list') return blank(d.source) ? error('没填用于拆分的文本') : ok();
  if (d.mode === 'glob') return blank(d.pattern) ? error('没填文件匹配模式') : ok();
  return ok();
}

const NEEDS_TARGET = new Set(['copy', 'move', 'rename']);

function vFs(d: FsNodeData): V {
  if (blank(d.path)) return error('没填路径');
  if (NEEDS_TARGET.has(d.op) && blank(d.target)) {
    return error(`${d.op} 需要目标路径`);
  }
  return ok();
}

function vOcr(d: OcrNodeData): V {
  if (d.imageSource === 'file' && blank(d.path)) return error('没填图片路径');
  if (d.imageSource !== 'file' && blank(d.url)) return error('没填图片地址');
  if (blank(d.credentialId) && blank(d.llm?.apiKey)) {
    return warn('没选连接也没填密钥，调用模型时可能失败');
  }
  return ok();
}

/*
 * 大模型节点（AI 三节点合并后的那一个）。
 *
 * ================= 为什么必须单列 =================
 *
 * 合并之前是 ocr / translate 两个 kind，各有自己的校验函数；
 * 合并之后的 kind 是 llmChat，而这张表里长期没有它 ——
 * 于是新建的大模型节点**完全没有校验**：
 *
 *   · 提示词空着 → 徽章绿灯
 *   · 没选连接 → 徽章绿灯（老节点反而会警告）
 *
 * 表现是"配了个空节点，界面说没问题，跑起来才知道"。
 * 这类缺失不报错，只能靠对账发现（见 tests/registry.test.ts）。
 */
function vLlmChat(d: LlmChatNodeData): V {
  const msgs: string[] = [];
  const use = d.use ?? 'chat';
  /*
   * 提示词为空不判错：它可能挂在某个上游后面，靠 {{上游.output}} 取内容，
   * 校验器拿不到边，判断不了"有没有上游" —— 宁可漏报也不要误报红色。
   */
  if (blank(d.credentialId) && blank(d.llm?.apiKey)) {
    msgs.push('没选连接也没填密钥，调用模型时可能失败');
  }
  if (use === 'ocr') {
    if (d.imageSource === 'file' && blank(d.path)) return error('没填图片路径');
    if (d.imageSource !== 'file' && blank(d.url)) return error('没填图片地址');
  }
  /* 翻译缺目标语言：模型会自由发挥，译成的语言不受控 */
  if (use === 'translate' && blank(d.targetLang)) msgs.push('没填目标语言');
  return msgs.length ? warn(...msgs) : ok();
}

function vTranslate(d: TranslateNodeData): V {
  const msgs: string[] = [];
  if (blank(d.credentialId) && blank(d.llm?.apiKey)) {
    msgs.push('没选连接也没填密钥，调用模型时可能失败');
  }
  /*
   * text 为空不判错：它可能挂在某个上游后面，靠 {{上游.output}} 取内容。
   * 校验器拿不到边，判断不了"有没有上游" —— 宁可漏报也不要误报红色。
   */
  if (blank(d.targetLang)) msgs.push('没填目标语言');
  return msgs.length ? warn(...msgs) : ok();
}

/*
 * 更新检测。
 *
 * 合并成多目标之后，校验的对象从"节点"变成"每一张卡"：
 * 只报第一个有问题的那张 —— 一次全列出来会糊成一片，
 * 而修好一张再看到下一张，反而更清楚。
 *
 * 老节点没有 targets，由 targetsOf() 合成一张，规则不变。
 */
function vUpdate(d: UpdateNodeData): V {
  const list = targetsOf(d);
  const on = list.filter((t) => t.enabled !== false);
  if (list.length === 0) return error('没有监听目标');
  if (on.length === 0) return error('监听目标全都停用了');

  for (const t of on) {
    const who = (t.name ?? '').trim() || UPDATE_SOURCE_META[t.kind].label;
    if (t.kind === 'bilibili') {
      if ((t.biliMode ?? 'rss') === 'api') {
        if (blank(t.biliUid)) return error(`${who}：没填 UP 主 UID`);
      } else if (blank(t.feedUrl)) {
        return error(`${who}：RSS 模式没填订阅源地址`);
      }
    } else if (t.kind === 'github') {
      if (blank(t.owner) || blank(t.repo)) return error(`${who}：没填仓库`);
    } else if (needsFeedUrl(t.kind, t.biliMode) && blank(t.feedUrl)) {
      /*
       * 判据走 needsFeedUrl 而不是 else 兜底：
       * 加平台时只要种类登记了，校验自动跟上；
       * 忘登记的后果是那张卡**永远绿灯** —— 配置空着也看不出来。
       */
      return error(`${who}：没填订阅源地址`);
    }
  }
  return ok();
}

function vGithubUpdate(d: GithubUpdateNodeData): V {
  if (blank(d.repo)) return error('没填仓库');
  /*
   * 拉取缺令牌只是"可能受限"：公开仓库不需要鉴权，
   * 私有仓库才需要。判黄 —— 能跑，只是可能拿不到。
   */
  if (blank(d.credentialId) && blank(d.token)) {
    return warn('没选连接也没填令牌，私有仓库会拉取失败');
  }
  return ok();
}

function vGithubPush(d: GithubPushNodeData): V {
  if (blank(d.repo)) return error('没填仓库');
  if (blank(d.filesText)) return error('没填要推送的文件');
  /*
   * 推送必须有令牌，没有例外 —— 与上面的拉取不同，这里判红。
   * 这两条规则的差异正是"能不能跑通"这条分界线的具体体现。
   */
  if (blank(d.credentialId) && blank(d.token)) {
    return error('推送必须有令牌：选一个连接或填写内联令牌');
  }
  return ok();
}

function vHttp(d: GenericHttpNodeData): V {
  if (blank(d.url)) return error('没填请求地址');
  const t = Number(d.timeoutSec);
  if (Number.isFinite(t) && t <= 0) return error('超时时间无效');
  return ok();
}

/**
 * 汇合节点：没有入边就是"永远收集不齐"，这是配置错误而非待填项。
 * 但校验器拿不到边（它只看 data），所以只校验模式取值本身 ——
 * 缺入边由执行器在运行时报（那里拿得到 graph）。
 */
function vJoin(d: JoinNodeData): V {
  const m = String(d.mode ?? 'all');
  if (m !== 'all' && m !== 'strict') return error('汇合模式取值不对');
  return ok();
}

/**
 * 控制器校验。
 *
 * 共同点：不产生数据，所以"配置不全"的判据是**能不能做出判定**，
 * 而不是"内容填了没" —— 内容来自上游。
 */
function vGate(d: GateNodeData): V {
  if (!['wait', 'now'].includes(String(d.mode ?? 'wait'))) return error('判定方式取值不对');
  const c = String(d.check ?? 'nonempty');
  if (!['nonempty', 'contains', 'notContains', 'regex'].includes(c)) return error('条件取值不对');
  if (c !== 'nonempty' && !String(d.value ?? '').trim()) {
    return error(`选了「${c}」但没填比对值`);
  }
  if (d.mode === 'wait') {
    const t = Number(d.timeoutMs);
    if (!Number.isFinite(t) || t < 0) return error('最长等待不是有效毫秒数');
  }
  return ok();
}

function vThrottle(d: ThrottleNodeData): V {
  const m = Number(d.minIntervalMs);
  if (!Number.isFinite(m) || m < 0) return error('最小间隔不是有效毫秒数');
  const max = Number(d.maxPerRun ?? 0);
  if (Number.isFinite(max) && max < 0) return error('放行次数不能为负');
  return ok();
}

function vTimeout(d: TimeoutNodeData): V {
  const b = Number(d.budgetMs);
  if (!Number.isFinite(b) || b <= 0) return error('没填有效的预算时长');
  return ok();
}

function vRetry(d: RetryNodeData): V {
  if (!String(d.target ?? '').trim()) return error('没填要重试哪个节点');
  const t = Number(d.times);
  if (!Number.isFinite(t) || t < 0) return error('重试次数不是有效数字');
  const c = String(d.check ?? 'nonempty');
  if (!['nonempty', 'contains', 'notContains', 'regex'].includes(c)) return error('合格条件取值不对');
  if (c !== 'nonempty' && !String(d.value ?? '').trim()) {
    return error(`选了「${c}」但没填比对值`);
  }
  return ok();
}

function vExtract(d: ExtractNodeData): V {
  if (blank(d.spec)) {
    return error(
      d.mode === 'json' ? '没填 JSON 路径' : d.mode === 'regex' ? '没填正则表达式' : '没填行规则',
    );
  }
  return ok();
}

function vWait(d: WaitNodeData): V {
  const ms = Number(d.ms);
  if (!Number.isFinite(ms) || ms < 0) return error('等待时长不是有效数字');
  return ok();
}

function vBeep(d: BeepNodeData): V {
  const v = Number(d.volume);
  if (!Number.isFinite(v) || v < 0 || v > 1) return error('音量要在 0~1 之间');
  return ok();
}

function vPlayAudio(d: PlayAudioNodeData): V {
  return blank(d.path) ? error('没填音频文件路径') : ok();
}

function vClock(d: ClockNodeData): V {
  return blank(d.format) ? error('没填时间格式') : ok();
}

function vConst(d: ConstNodeData): V {
  /*
   * 按**每一张卡**判，而不是只看顶层 value。
   *
   * 只看顶层的话，第一张填了、第二张空着时徽章是绿的 ——
   * 而第二张卡接到下游会输出空串，连线一根没少，界面上却毫无提示。
   */
  const items = constsOf(d);
  const empties = items.filter((it) => blank(it.value));
  if (empties.length === 0) return ok();
  const one = empties.length === 1 && items.length > 1
    ? `「${constItemLabel(empties[0], items.indexOf(empties[0]))}」`
    : '';
  return warn(
    items.length > 1
      ? `有 ${empties.length} 张卡的值是空的${one}，会输出空字符串`
      : '值是空的，会输出空字符串',
  );
}

function vModule(d: ModuleNodeData): V {
  if (!d.inner && blank(d.moduleId)) return error('这个模块既没跟模块库关联，也没有自带结构');
  return ok();
}

/* ------------------------------------------------------------------ */
/* 分派                                                                */
/* ------------------------------------------------------------------ */

/**
 * 按 data.kind 分派，不用 node.type。
 *
 * 与执行器分派同样的理由：引擎拿到的图结构里节点类型被剥掉了，
 * 而 data.kind 是数据自带的。bili / wechat 两个 type 共用一份 data，
 * 也靠 kind 统一处理。
 */
type Table = Record<string, (d: never) => V>;

const VALIDATORS: Table = {
  task: vTask as never,
  condition: vCondition as never,
  trigger: vTrigger as never,
  parallel: vParallel as never,
  loop: vLoop as never,
  fs: vFs as never,
  ocr: vOcr as never,
  translate: vTranslate as never,
  llmChat: vLlmChat as never,
  update: vUpdate as never,
  'github-update': vGithubUpdate as never,
  'github-push': vGithubPush as never,
  'generic-http': vHttp as never,
  extract: vExtract as never,
  wait: vWait as never,
  beep: vBeep as never,
  'play-audio': vPlayAudio as never,
  clock: vClock as never,
  const: vConst as never,
  module: vModule as never,
  join: vJoin as never,
  gate: vGate as never,
  throttle: vThrottle as never,
  timeout: vTimeout as never,
  retry: vRetry as never,
};

/**
 * 校验单个节点。未知类型返回 ok —— 没规则时不要乱报红
 *
 * ================= 为什么多一个 linkIssues 参数 =================
 *
 * 参数连线的类型校验**看不了单个节点**：它要比的是
 * "上游产出什么" 与 "这个参数期望什么"，上游在别的节点上。
 * 而 validateNode 一次只拿一个节点，扫不到全图。
 *
 * 所以图级的那部分由调用方算好传进来，在这里与手填值的校验合并。
 * 合并而不是分两处显示：同一个参数既可能手填错、也可能连错，
 * 分成两个红点的话用户得猜该看哪个。
 */
export function validateNode(
  node: { data?: unknown } | null | undefined,
  linkIssues?: ArgTypeIssue[],
): NodeIssue {
  const d = node?.data as Record<string, unknown> | undefined;
  if (!d) return { level: 'ok', messages: [] };
  const fn = VALIDATORS[String(d.kind ?? '')];
  let base: V = { level: 'ok', messages: [] };
  if (fn) {
    try {
      base = fn(d as never);
    } catch {
      // 校验出错不该让画布白屏
      base = { level: 'ok', messages: [] };
    }
  }
  /*
   * 叠加**参数类型**校验。
   *
   * 为什么放在这里统一叠加，而不是写进各自的 validator：
   * 类型校验是**跨节点种类**的同一套规则（哪个参数在这个运算下该是什么类型），
   * 而 VALIDATORS 是按 dataKind 分派的一批各自独立的函数 ——
   * 塞进每个函数里就要写四遍，且新增节点时最容易漏。
   *
   * 更重要的是它回答的是**另一件事**：
   *   VALIDATORS  → 有没有填（缺参 / 缺项）
   *   argTypes    → 填的对不对（错参）
   *
   * 分开之后，用户看到红圆点能从文案直接分辨该"补一个值"还是"改一个类型"。
   */
  const typeIssues = [
    ...argTypeIssues(String(d.kind ?? ''), d),
    ...(linkIssues ?? []),
  ];
  if (typeIssues.length === 0) return base;
  const msgs = typeIssues.map((t) => t.message);
  return {
    level: 'error',
    messages: [...base.messages, ...msgs],
    typeError: true,
  };
}

/**
 * 徽章文案。
 *
 * 比 LEVEL_SHORT 多处理一档：红 + typeError →「错参」而不是「缺参」。
 * 写成函数而不是扩展 LEVEL_SHORT 的键 —— 那张表按**等级**索引，
 * 而"错参"是等级之下的成因，塞进同一张表会让键名变成
 * `error-type` 这种复合东西，消费端还得自己拼。
 */
export function badgeTextOf(issue: NodeIssue): string {
  if (issue.level === 'error' && issue.typeError) return '错参';
  return LEVEL_SHORT[issue.level];
}

/** 一批节点里最严重的那一档，用于"整张画布有没有问题"的汇总 */
export function worstLevel(issues: IssueLevel[]): IssueLevel {
  if (issues.includes('error')) return 'error';
  if (issues.includes('warn')) return 'warn';
  return 'ok';
}

export const LEVEL_TEXT: Record<IssueLevel, string> = {
  ok: '配置齐全',
  warn: '有缺项但可运行',
  error: '配置不全，会阻断',
};

/**
 * 配置状态在卡片徽章上的短文案。
 *
 * 卡片只回答"这个节点能不能跑"（配置完整度）——
 * **运行状态一律不显示在卡片上**：跑起来看任务窗口。
 *
 * 以前徽章显示的是"待运行 / 执行中 / 已完成"，于是整张画布
 * 每跑一次就整片刷新一遍文字，而那些信息任务窗口里全都有。
 * 配置状态才是画布上真正缺的那一项：没跑之前就要能看出缺什么。
 *
 * 具体缺什么由徽章下方的红色提示行给出（issue.messages[0]），
 * 徽章里只放一个词 —— 长句子会把标题挤没。
 */
export const LEVEL_SHORT: Record<IssueLevel, string> = {
  ok: '就绪',
  warn: '缺项',
  error: '缺参',
};

export const LEVEL_COLOR: Record<IssueLevel, string> = {
  ok: '#22c55e',
  warn: '#f59e0b',
  error: '#ef4444',
};
