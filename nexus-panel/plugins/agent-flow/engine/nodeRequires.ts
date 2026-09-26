/**
 * 节点「能力需求」声明表。
 *
 * 存在的理由：原先每个执行器都自己写一遍
 *     if (!opts.fsExecutor) throw new NodeFailError('未提供文件操作执行器');
 * 这样的前置校验。重复 7 处，且各有各的措辞 —— 有的带"（当前可能运行在
 * 浏览器模式）"提示，有的不带；有的失败时给下游输出 'false'，有的留空。
 *
 * 下沉到这里之后：
 *   - 执行器不用再写校验，只管业务逻辑
 *   - 底层改报错措辞 / 加统一的降级提示，所有节点自动跟着变
 *
 * 这个文件刻意**不 import 任何东西**：
 * runnerKit 要读它做校验，而 runnerRegistry → runners/* → runnerKit，
 * 若它再去 import runnerRegistry 就成环了。保持零依赖最省事。
 */

/*
 * 唯一的一个运行时 import。
 *
 * types.ts 只有 `import type`（编译后全被擦掉），所以它运行时不依赖任何人 ——
 * 引它不会成环。这里要的是 targetsOf：更新检测合并成多目标之后，
 * "这个节点到底需不需要网络抓取"取决于它挂了哪些目标。
 */
import { targetsOf } from '../types';

export type Requirement = {
  /** RunOptions 里的字段名 */
  key: string;
  /** 中文名，用于拼报错："未提供{label}执行器" */
  label: string;
  /** 失败时给下游的输出。更新检测类要给 'false'，好让条件判断走"无更新" */
  failOutput?: string;
  /** 只在特定条件下才需要（例：OCR 只在"本地文件"来源时才要读图能力） */
  when?: (d: Record<string, unknown>) => boolean;
};

type Table = Record<string, Requirement[] | undefined>;

export const REQUIRES: Table = {
  fs: [{ key: 'fsExecutor', label: '文件操作' }],
  ocr: [
    // 只在"本地文件"来源时才需要读图能力；网络地址走 URL 直传，不需要
    { key: 'imageReader', label: '图片读取', when: (d) => d.imageSource === 'file' },
    { key: 'llmCaller', label: '大模型调用' },
  ],
  translate: [{ key: 'llmCaller', label: '大模型调用' }],
  /*
   * 合并后的大模型节点：三种用途都要 llmCaller，
   * 其中「图片识别 + 本地文件」多要一个读图能力。
   *
   * 不登记的话，没有 llmCaller 时 opts.llmCaller!() 直接抛
   * "is not a function" —— 与"你没配连接"差了十万八千里。
   */
  llmChat: [
    {
      key: 'imageReader',
      label: '图片读取',
      when: (d) => d.use === 'ocr' && d.imageSource === 'file',
    },
    { key: 'llmCaller', label: '大模型调用' },
  ],
  /*
   * 网络抓取只在**有订阅源类目标**时才需要。
   *
   * 一个节点可能只盯 GitHub 仓库（走 githubFetch，不碰网络抓取）——
   * 不写 when 的话，纯仓库的节点会因为"没有网络抓取能力"直接失败，
   * 而它根本用不上这个能力。
   */
  update: [
    {
      key: 'fetcher',
      label: '网络请求',
      failOutput: 'false',
      when: (d) => (targetsOf(d as never)).some(
        (t) => t.enabled !== false && t.kind !== 'github',
      ),
    },
    {
      key: 'githubFetch',
      label: 'GitHub 拉取',
      failOutput: 'false',
      when: (d) => (targetsOf(d as never)).some(
        (t) => t.enabled !== false && t.kind === 'github',
      ),
    },
  ],
  /*
   * CLI（task）节点：唯一的外部能力是命令行执行器。
   *
   * 没登记时它没有**任何**前置校验 —— 执行器里直接 `opts.executor(...)`，
   * 缺能力时抛的是 "opts.executor is not a function"，
   * 与"当前环境跑不了命令行"差了十万八千里，AI 也无从提前判断。
   */
  task: [{ key: 'executor', label: '命令行执行' }],
  /*
   * 读表格：只有「读表格」这一步要读盘，推导/筛选/汇总接的是上游的表。
   *
   * 没登记时它靠执行器里自写的一句校验兜着 —— 措辞与别处不一致，
   * 且界面（契约里的 requires 是从这张表派生的）根本不知道它需要能力，
   * 于是画布上显示绿灯、跑起来才报错。
   */
  tableRead: [{ key: 'tableReader', label: '表格读取' }],
  'github-update': [{ key: 'githubFetch', label: 'GitHub 拉取', failOutput: 'false' }],
  'github-push': [{ key: 'githubPush', label: 'GitHub 推送' }],
  // 提取节点不在此列：它是纯本地字符串处理，不需要任何执行器
  'generic-http': [{ key: 'httpRequester', label: 'HTTP 请求', failOutput: '' }],
  /*
   * 只有播放音频文件需要外部能力（读本地文件）。
   * 等待 / 日志 / 提示音 / 时间 / 常量 都是纯本地逻辑，
   * 不登记 —— 它们在浏览器模式下也能跑。
   */
  'play-audio': [{ key: 'playAudioReader', label: '音频读取' }],
  /*
   * 合并后的「播放声音」节点：只有来源选「本地文件」才需要读盘能力。
   *
   * 不写 when 的话，纯系统音效的节点会因为"没有音频读取能力"直接失败 ——
   * 而它根本不读盘（Web Audio 实时合成），浏览器模式下也能响。
   * 那是**误报**，用户会以为必须装桌面端才能用提示音。
   */
  beep: [
    {
      key: 'playAudioReader',
      label: '音频读取',
      when: (d) => d.source === 'file',
    },
  ],
};

/** 取某节点数据所需的能力清单（已按 when 过滤） */
export function requiresOf(d: Record<string, unknown>): Requirement[] {
  const kind = String(d?.kind ?? '');
  const list = REQUIRES[kind];
  if (!list) return [];
  return list.filter((r) => (r.when ? r.when(d) : true));
}
