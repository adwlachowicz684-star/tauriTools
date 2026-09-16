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
  update: [{ key: 'fetcher', label: '网络请求', failOutput: 'false' }],
  'github-update': [{ key: 'githubFetch', label: 'GitHub 拉取', failOutput: 'false' }],
  'github-push': [{ key: 'githubPush', label: 'GitHub 推送' }],
};

/** 取某节点数据所需的能力清单（已按 when 过滤） */
export function requiresOf(d: Record<string, unknown>): Requirement[] {
  const kind = String(d?.kind ?? '');
  const list = REQUIRES[kind];
  if (!list) return [];
  return list.filter((r) => (r.when ? r.when(d) : true));
}
