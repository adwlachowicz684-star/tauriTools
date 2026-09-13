/**
 * 大模型 API 调用的共享层。
 *
 * OCR 与翻译两个节点都要调大模型，差异只在"消息怎么拼"，
 * 请求构造、响应解析、错误提示完全一样 —— 抽出来避免两处各写一套。
 *
 * 这里只负责"把请求体和返回结果算对"，不发请求：
 * 真正的网络调用由 runner 注入的 llmCaller 执行（走 Tauri http 或浏览器 fetch），
 * 这样本模块可以在 node --test 里直接验证。
 */

/** 大模型服务商预设 */
export type LlmProvider =
  | 'openai'
  | 'deepseek'
  | 'zhipu'
  | 'moonshot'
  | 'qwen'
  | 'siliconflow'
  | 'custom';

export type LlmConfig = {
  provider: LlmProvider;
  /** 自定义时填完整地址；预设也会给默认值，可覆盖 */
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 超时秒数 */
  timeoutSec: number;
};

export type ProviderMeta = {
  label: string;
  /** chat completions 的完整地址 */
  baseUrl: string;
  /** 默认模型 */
  model: string;
  /** 是否支持图片输入（视觉模型） */
  vision: boolean;
  hint?: string;
};

/**
 * 服务商预设。
 *
 * 全部兼容 OpenAI 的 /chat/completions 格式，所以请求体只有一份构造逻辑。
 * vision 标记用于 OCR 节点：选了不支持图片的服务商时提前提示，
 * 否则用户要等到拿到 400 才知道选错了。
 */
export const PROVIDER_META: Record<LlmProvider, ProviderMeta> = {
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    vision: true,
    hint: 'gpt-4o / gpt-4o-mini 支持图片',
  },
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1/chat/completions',
    model: 'deepseek-chat',
    vision: false,
    hint: '当前不支持图片，OCR 节点请换别家',
  },
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    model: 'glm-4-flash',
    vision: true,
    hint: '视觉用 glm-4v 系列，如 glm-4v-flash',
  },
  moonshot: {
    label: 'Moonshot',
    baseUrl: 'https://api.moonshot.cn/v1/chat/completions',
    model: 'moonshot-v1-8k',
    vision: false,
    hint: '当前不支持图片',
  },
  qwen: {
    label: '通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
    model: 'qwen-plus',
    vision: true,
    hint: '视觉用 qwen-vl-max / qwen-vl-plus',
  },
  siliconflow: {
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1/chat/completions',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    vision: true,
    hint: '视觉模型名含 VL，如 Qwen/Qwen2.5-VL-72B-Instruct',
  },
  custom: {
    label: '自定义',
    baseUrl: '',
    model: '',
    vision: true,
    hint: '任意兼容 OpenAI 格式的地址（如本地 Ollama / vLLM）',
  },
};

/** 一条文本消息 */
export type TextPart = { type: 'text'; text: string };
/** 一条图片消息。url 可以是 http(s) 地址，也可以是 data:image/...;base64,... */
export type ImagePart = { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export type ContentPart = TextPart | ImagePart;

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ContentPart[];
};

export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  /** 0~2，翻译/识别这类确定性任务建议低值 */
  temperature?: number;
  max_tokens?: number;
  stream?: false;
};

/** 补全后的配置：地址与模型都已有确定值 */
export type ResolvedConfig = {
  url: string;
  model: string;
  apiKey: string;
  timeoutSec: number;
};

export type ConfigIssue = { level: 'warn' | 'error'; message: string };

/**
 * 补全配置：预设地址 + 用户覆盖。
 *
 * 地址为空视为"用预设"，而不是"地址为空" —— 用户切到自定义服务商后
 * 地址框是空的，这时回退到预设比直接报错更符合预期。
 */
export function resolveConfig(cfg: LlmConfig): ResolvedConfig {
  const preset = PROVIDER_META[cfg.provider] ?? PROVIDER_META.custom;
  return {
    url: (cfg.baseUrl ?? '').trim() || preset.baseUrl,
    model: (cfg.model ?? '').trim() || preset.model,
    apiKey: (cfg.apiKey ?? '').trim(),
    timeoutSec: cfg.timeoutSec > 0 ? cfg.timeoutSec : 60,
  };
}

/** 校验配置。返回的问题按"会不会导致必失败"分级 */
export function validateConfig(cfg: LlmConfig, needVision = false): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const r = resolveConfig(cfg);

  if (!r.url) {
    issues.push({ level: 'error', message: 'API 地址为空。选「自定义」时要填完整地址' });
  } else if (!isHttpUrl(r.url)) {
    issues.push({ level: 'error', message: 'API 地址要以 http:// 或 https:// 开头' });
  }

  if (!r.model) {
    issues.push({ level: 'error', message: '模型名为空' });
  }

  if (!r.apiKey) {
    issues.push({
      level: 'error',
      message: '未填 API Key。本地服务（Ollama 等）可随便填一个占位值',
    });
  }

  if (needVision) {
    const preset = PROVIDER_META[cfg.provider];
    // 只有选了预设且明确不支持视觉时才提示；自定义未知，不乱说
    if (preset && !preset.vision && cfg.provider !== 'custom') {
      issues.push({
        level: 'error',
        message: `${preset.label} 的 ${r.model} 不支持图片，OCR 节点请换一个服务商`,
      });
    }
  }

  return issues;
}

/** 构造请求头 */
export function buildHeaders(apiKey: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/* ------------------------------------------------------------------ */
/* 响应解析                                                            */
/* ------------------------------------------------------------------ */

export type LlmResponse = {
  ok: boolean;
  status: number;
  /** 成功时是模型输出的文本；失败时是空串 */
  text: string;
  /** 失败时的人类可读原因 */
  error: string;
  /** 原始响应体，调试用（截断） */
  raw: string;
};

/**
 * 从各家响应体里取模型输出。
 *
 * 虽然都用 OpenAI 格式，但仍有差异：
 *  - OpenAI / DeepSeek / 智谱：choices[0].message.content（字符串）
 *  - 少数网关：choices[0].text
 *  - Claude 兼容层：content[0].text
 * 逐个尝试，都取不到再报错。
 */
export function extractContent(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, any>;

  const choices = b.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] ?? {};
    const msg = first.message;
    if (msg && typeof msg === 'object') {
      const c = msg.content;
      if (typeof c === 'string') return c;
      // 多模态返回里 content 可能是数组
      if (Array.isArray(c)) {
        const parts = c
          .map((p: any) => (typeof p === 'string' ? p : (p?.text ?? '')))
          .filter((s: unknown) => typeof s === 'string');
        if (parts.length) return parts.join('');
      }
    }
    if (typeof first.text === 'string') return first.text;
  }

  // Claude 风格
  if (Array.isArray(b.content)) {
    const parts = b.content
      .map((p: any) => (typeof p === 'string' ? p : (p?.text ?? '')))
      .filter((s: unknown) => typeof s === 'string');
    if (parts.length) return parts.join('');
  }

  return '';
}

/** 从各家错误响应里取错误描述 */
export function extractError(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, any>;
  if (typeof b.error === 'string') return b.error;
  if (b.error && typeof b.error === 'object') {
    return String(b.error.message ?? b.error.code ?? '');
  }
  if (typeof b.message === 'string') return b.message;
  if (typeof b.msg === 'string') return b.msg;
  return '';
}

/**
 * 把 HTTP 状态码翻译成人话。
 *
 * 401 和 429 是最常见的两种，但默认只显示 "HTTP 401"，
 * 用户往往不知道是 key 错了还是额度没了 —— 这里直接说清楚。
 */
export function describeHttpError(status: number, serverMsg: string): string {
  const extra = serverMsg ? `（${serverMsg}）` : '';
  if (status === 401 || status === 403) {
    return `API Key 无效或没有权限${extra}。检查 Key 是否正确、是否过期`;
  }
  if (status === 404) {
    return `接口地址不存在${extra}。检查 API 地址是否完整（多数要带 /v1/chat/completions）`;
  }
  if (status === 429) {
    return `触发限流或额度不足${extra}。稍后重试，或检查账户余额`;
  }
  if (status === 400) {
    return `请求被拒绝${extra}。常见原因：模型名不对，或该模型不支持图片`;
  }
  if (status >= 500) {
    return `服务端出错${extra}。稍后重试`;
  }
  return `HTTP ${status}${extra}`;
}

/** 解析一次调用的结果 */
export function parseResponse(status: number, rawText: string): LlmResponse {
  const raw = (rawText ?? '').slice(0, 2000);
  let body: unknown = null;
  try {
    body = JSON.parse(rawText);
  } catch {
    const trimmed = (rawText ?? '').trim();
    if (status >= 200 && status < 300) {
      /*
        大模型 API 只会返回 JSON。出现 HTML 说明前面有网关报错
        （典型：502 的 Nginx 页面），但 HTTP 状态码仍是 200。
        当成成功的话，用户会拿到一堆 HTML 标签还以为跑通了。
      */
      // 不用正则分组（类型剥离器会把 (?: 当类型语法吃掉），startsWith 更直白
      const lower = trimmed.toLowerCase();
      if (lower.startsWith('<!doctype') || lower.startsWith('<html')) {
        return {
          ok: false, status, text: '',
          error: `返回的是 HTML 页面而不是 JSON（多半是网关报错）：${trimmed.slice(0, 80)}`,
          raw,
        };
      }
      // 个别网关/本地服务会直接吐纯文本，这种情况接受
      return { ok: true, status, text: trimmed, error: '', raw };
    }
    return {
      ok: false, status, text: '',
      error: `返回不是 JSON：${(rawText || '(空)').slice(0, 120)}`,
      raw,
    };
  }

  if (status < 200 || status >= 300) {
    return { ok: false, status, text: '', error: describeHttpError(status, extractError(body)), raw };
  }

  const text = extractContent(body);
  if (!text) {
    return {
      ok: false, status, text: '',
      error: `响应里没有取到内容${extractError(body) ? `（${extractError(body)}）` : ''}`,
      raw,
    };
  }
  return { ok: true, status, text, error: '', raw };
}

/* ------------------------------------------------------------------ */
/* 翻译相关的文本处理                                                  */
/* ------------------------------------------------------------------ */

export type LangPreset = { code: string; label: string };

/**
 * 判断是否为 http(s) 地址。
 *
 * 正则里刻意不写转义斜杠（`^https?:\/\/`）：
 * 类型剥离器处理 `\/` 时会把后面的 `//` 当成注释起点，
 * 生成 `/^https` 这种残缺正则。用 `:`` 判断协议同样准确，且没有这个坑。
 */
export function isHttpUrl(u: string): boolean {
  return /^https?:/i.test(u.trim());
}

/** 图片地址：http(s) 或 base64 data URL 都合法 */
export function isUsableImageUrl(u: string): boolean {
  const t = (u ?? '').trim();
  return isHttpUrl(t) || t.startsWith('data:image/');
}

/** 常用目标语言。保留"自定义"以便写更具体的说法（如"简练的文言文"） */
export const TARGET_LANGS: LangPreset[] = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'fr', label: '法语' },
  { code: 'de', label: '德语' },
  { code: 'es', label: '西班牙语' },
  { code: 'ru', label: '俄语' },
];

/**
 * 构造翻译用的 system 提示。
 *
 关键约束是"只输出译文" —— 否则模型会加「好的，这是翻译：」之类的客套话，
 * 直接把结果喂给下游就会混进噪声。
 */
export function buildTranslateSystem(target: string, source: string, glossary?: string): string {
  const srcText = source && source !== 'auto' ? `源语言为${source}，` : '自动识别源语言，';
  const terms = (glossary ?? '').trim();
  const termRule = terms
    ? `\n术语表（必须严格按此翻译）：\n${terms}\n`
    : '';
  return [
    '你是专业翻译引擎。',
    `${srcText}把用户输入翻译成${target}。`,
    termRule,
    '要求：只输出译文本身，不要任何解释、前缀、引号包裹或 Markdown 代码块标记。',
    '保留原文的换行、空白与标点结构。代码、命令、变量名、文件路径不翻译。',
  ].join('');
}
