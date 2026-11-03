/**
 * types.ts 第 6 卷：llm。
 *
 * 实现按域分卷，types.ts 只留 re-export 入口；外部 175 处 import 路径不变。
 * 卷内代码按原文件行序原样保留（含私有辅助与初始化顺序），不要重排。
 */
import type { LlmConfig } from '../engine/llm';
import type { NodeParam } from '../engine/params';
import type { VaultMode } from '../engine/credentialStore';
import type { NodeData } from './condition';
import type { GraphNode, NodeSize, NodeStatus } from './core';
import type { FsNodeData, GenericHttpNodeData } from './io';

/* ================================================================== */
/* OCR / 翻译节点（调用大模型 API）                                    */
/* ================================================================== */

/** 图片来源：网络地址 / 本地文件 */
export type ImageSource = 'url' | 'file';

export const IMAGE_SOURCE_META: Record<ImageSource, { label: string; hint: string }> = {
  url:  { label: '网络地址', hint: '填 http(s) 图片地址，直接交给模型，不需要本地读取' },
  file: { label: '本地文件', hint: '读取本地图片转 base64 后发送。需要桌面端运行' },
};

export type OcrNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'ocr';
  label: string;
  /** 大模型配置（与翻译节点共用） */
  llm: LlmConfig;
  /** 凭据 id；留空则用 llm.apiKey 的内联值 */
  credentialId: string;
  imageSource: ImageSource;
  /** url 模式：图片地址；支持 {{上游.output}} */
  url: string;
  /** file 模式：本地路径 */
  path: string;
  /**
   * 识别要求。留空用默认提示。
   * 支持 {{上游.output}}，便于"先让 agent 说要识别哪张图"
   */
  prompt: string;
  /** 图片细节级别，影响 token 消耗 */
  detail: 'auto' | 'low' | 'high';
  status: NodeStatus;
  output: string;
  error: string;
  /** 上次识别出的字符数，仅用于界面展示 */
  lastChars?: number;
};

export type TranslateNodeData = {
  /** 画布显示高度；不填按中号处理 */
  size?: NodeSize;
  /**
   * 嵌合在哪个节点下面（Scratch 式上下吸附）。
   * null / 缺省表示不在串里。关系只存在子节点上，见 engine/stack.ts 的说明。
   */
  stackParent?: string | null;
  /** 串顶节点折叠了整条串（只是隐藏，不影响执行） */
  stackCollapsed?: boolean;
  kind: 'translate';
  label: string;
  llm: LlmConfig;
  /** 凭据 id；留空则用 llm.apiKey 的内联值 */
  credentialId: string;
  /** 待翻译文本，支持 {{上游.output}} */
  text: string;
  /** 目标语言，可填预设 code 之外的任意说法 */
  targetLang: string;
  /** 源语言；auto 表示自动识别 */
  sourceLang: string;
  /** 术语表，每行一条，形如 "GPU=图形处理器" */
  glossary: string;
  status: NodeStatus;
  output: string;
  error: string;
  lastChars?: number;
};

export function isOcr(d: NodeData): d is OcrNodeData {
  return (d as OcrNodeData).kind === 'ocr';
}

export function isTranslate(d: NodeData): d is TranslateNodeData {
  return (d as TranslateNodeData).kind === 'translate';
}

export function makeOcrNode(id: string, partial: Partial<OcrNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'ocr',
      label: partial.label ?? '图片识别',
      llm: partial.llm ?? defaultLlmConfig(),
      imageSource: partial.imageSource ?? 'url',
      url: partial.url ?? '',
      path: partial.path ?? '',
      prompt: partial.prompt ?? defaultOcrPrompt(),
      detail: partial.detail ?? 'auto',
      credentialId: partial.credentialId ?? '',
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

/**
 * 大模型 API 节点 —— 直接调一次大模型，不做 OCR / 翻译这类预设加工。
 *
 * 与 OCR、翻译的区别：那两个把"消息怎么拼"写死了（必须带图、必须带目标语言），
 * 这个节点把 system / user 两段都交给用户，是最通用的那一档。
 */
/**
 * 大模型节点的用途。
 *
 * 图片识别与翻译原本是**两个独立节点**，但它们与「自由对话」的差别
 * 只在消息的拼法：那两个把 system 写死了（必须带图 / 必须带目标语言），
 * 自由对话把两段都交给用户。请求构造、响应解析、错误提示三处完全相同
 * —— 分成三个节点后，改一处请求逻辑要改三遍，漏一处就是"这个节点
 * 还是旧行为，且不报错"。
 *
 * 所以合并成同一个节点，用这个字段区分。
 *
 * 刻意**可选**：缺省按 'chat' 处理。老存档里没有这个字段，
 * 而它们当初的行为正是自由对话 —— 缺省必须是 chat，不能是别的。
 */
export type LlmUse = 'chat' | 'ocr' | 'translate';

export const LLM_USE_META: Record<LlmUse, { label: string; hint: string; sub: string }> = {
  chat: {
    label: '自由对话',
    hint: 'system 与 user 两段都自己写，最通用的一档',
    sub: '直接调一次大模型，自己写提示词',
  },
  ocr: {
    label: '图片识别',
    hint: '把图片交给视觉模型，读出里面的文字。选了这项需要模型支持图片输入',
    sub: '把图片里的文字读出来（需视觉大模型）',
  },
  translate: {
    label: '翻译',
    hint: 'system 由目标语言与术语表拼出，你只填待翻译内容',
    sub: '把文本翻成另一种语言（需自己的 API Key）',
  },
};

export type LlmChatNodeData = {
  size?: NodeSize;
  stackParent?: string | null;
  stackCollapsed?: boolean;
  kind: 'llmChat';
  label: string;
  /**
   * 大模型配置（兜底）。
   *
   * 地址与密钥**优先取自连接**，这一份只在没配连接时兜底（老画布迁移前）。
   */
  llm?: LlmConfig;
  /** 连接 id（大模型凭据） */
  credentialId: string;
  /** 模型名。模型清单来自 credentialId 指向的连接 */
  model: string;
  /** 用途：自由对话 / 图片识别 / 翻译。缺省 chat */
  use?: LlmUse;
  /** system 提示词（角色设定）。挂了 API 窗格且自己没填时用窗格的 */
  system: string;
  /** user 提示词，支持 {{上游.output}} */
  prompt: string;
  /* ---- 仅 use='ocr' 用到 ---- */
  /** 图片来源。缺省 url */
  imageSource?: ImageSource;
  /** url 模式：图片地址；支持 {{上游.output}} */
  url?: string;
  /** file 模式：本地图片路径 */
  path?: string;
  /** 图片细节：auto / low / high。省 token 或识别更准 */
  detail?: 'auto' | 'low' | 'high';
  /* ---- 仅 use='translate' 用到 ---- */
  /** 目标语言。可填预设码（zh / en），也可填「简练的文言文」这类自由描述 */
  targetLang?: string;
  /** 源语言。留空（或 auto）让模型自动判断 */
  sourceLang?: string;
  /** 术语表，每行「原文=译文」，保证专有名词译法一致 */
  glossary?: string;
  /**
   * 温度 0~2。
   *
   * 刻意**可选**：不填时依次回落到窗格、再回落到默认 0.3。
   * 给默认值的话节点上永远有值，窗格那一份就永远轮不上 ——
   * 表现为"窗格改了温度，里面的节点毫无反应"。
   */
  temperature?: number;
  /** 最大输出 token；0 或留空 = 不限制 */
  maxTokens?: number;
  /** 是否要求结构化 JSON 输出 */
  jsonMode?: boolean;
  /** 属于哪个 API 任务窗格（节点 id） */
  paneId?: string;
  /** 自定义参数，下游用 {{id.参数名}} 引用 */
  params?: NodeParam[];
  status: NodeStatus;
  output: string;
  error: string;
};

export function makeLlmChatNode(id: string, partial: Partial<LlmChatNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'llmChat',
      label: partial.label ?? '大模型',
      llm: partial.llm ?? defaultLlmConfig(),
      credentialId: partial.credentialId ?? '',
      model: partial.model ?? '',
      use: partial.use ?? 'chat',
      system: partial.system ?? '',
      prompt: partial.prompt ?? '',
      imageSource: partial.imageSource ?? 'url',
      url: partial.url ?? '',
      path: partial.path ?? '',
      detail: partial.detail ?? 'auto',
      /*
       * 目标语言默认给 'zh'：切到「翻译」时这一栏直接可用。
       * 给空串的话用户切过去第一件事就是报错"未指定目标语言"，
       * 而他从来没见过这一栏 —— 属于凭空多出来的一步。
       */
      targetLang: partial.targetLang ?? 'zh',
      sourceLang: partial.sourceLang ?? 'auto',
      glossary: partial.glossary ?? '',
      temperature: partial.temperature,
      maxTokens: partial.maxTokens ?? 0,
      jsonMode: partial.jsonMode ?? false,
      paneId: partial.paneId,
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

export function makeTranslateNode(id: string, partial: Partial<TranslateNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'translate',
      label: partial.label ?? '翻译',
      llm: partial.llm ?? defaultLlmConfig(),
      text: partial.text ?? '',
      targetLang: partial.targetLang ?? 'zh',
      sourceLang: partial.sourceLang ?? 'auto',
      glossary: partial.glossary ?? '',
      credentialId: partial.credentialId ?? '',
      status: partial.status ?? 'idle',
      output: partial.output ?? '',
      error: partial.error ?? '',
    },
  };
}

/**
 * 三种存储方式的界面文案。
 *
 * 刻意写清每种"防得住什么、防不住什么" ——
 * 只写"更安全"会让人以为是无敌的。
 */
export const VAULT_MODE_META: Record<VaultMode, { label: string; hint: string }> = {
  oskeyring: {
    label: 'OS 凭据管理器',
    hint: '主密钥存在 Windows 凭据管理器 / macOS 钥匙串里，不在应用数据目录 —— '
      + '拷走整个数据目录也解不开，且不用每次输口令。'
      + '能登录这台机器的人仍可取到，要防那个请用口令模式',
  },
  auto: {
    label: '本机加密',
    hint: '主密钥由本机特征派生，自动解锁。盐明文存在数据目录里 —— '
      + '拿到整个目录的人仍能离线解开，只防"别的脚本顺手读"',
  },
  passphrase: {
    label: '口令加密',
    hint: '每次打开要输口令，钥匙只在你自己脑子里 —— 唯一能防"整台机器被拿走"的方式',
  },
};

/** 默认识别提示：按原布局输出，不额外解释 */
export function defaultOcrPrompt(): string {
  return '识别图片中的所有文字，按原文的排列顺序输出。只输出识别到的文字本身，不要任何解释或描述。';
}

export function defaultLlmConfig(partial: Partial<LlmConfig> = {}): LlmConfig {
  return {
    provider: partial.provider ?? 'openai',
    baseUrl: partial.baseUrl ?? '',
    model: partial.model ?? '',
    apiKey: partial.apiKey ?? '',
    timeoutSec: partial.timeoutSec ?? 60,
  };
}

export function isFs(d: NodeData): d is FsNodeData {
  return (d as FsNodeData).kind === 'fs';
}

export function makeGenericHttpNode(id: string, partial: Partial<GenericHttpNodeData> = {}): GraphNode {
  return {
    id,
    data: {
      kind: 'generic-http',
      label: partial.label ?? 'HTTP 请求',
      url: partial.url ?? '',
      method: partial.method ?? 'GET',
      headersText: partial.headersText ?? '',
      body: partial.body ?? '',
      bodyIsJson: partial.bodyIsJson ?? true,
      timeoutSec: partial.timeoutSec ?? 30,
      maxBytesKb: partial.maxBytesKb ?? 512,
      credentialId: partial.credentialId ?? '',
      failOnHttpError: partial.failOnHttpError ?? true,
    } as GenericHttpNodeData,
  };
}
