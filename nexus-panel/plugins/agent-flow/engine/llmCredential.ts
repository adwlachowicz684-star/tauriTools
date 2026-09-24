/**
 * 大模型连接 —— 纯逻辑层（可单测，不碰 DOM / 网络）。
 *
 * ================= 为什么要有这一层 ====================
 *
 * 以前每个用到大模型的节点（OCR / 翻译）都各自存一份完整配置：
 * 服务商、API 地址、模型、API Key、超时。
 *
 * 结果是同一个 key 要在每个节点上填一遍，换 key 要改好几处，
 * 漏一处表现为"这个节点连的还是旧 key"，而且不报错。
 *
 * 现在节点只存两样：**用哪个连接** + **用哪个模型**。
 * 地址与密钥全在连接里 —— 改一处，所有引用它的节点同时生效。
 *
 * ================= 这一层放什么 ====================
 *
 * 连接里"大模型专属信息"的读写与解释：
 *   · meta 里怎么存地址与模型列表
 *   · 模型名怎么判断可能不支持图片
 *   · 连接 + 模型名 → 真正能发请求的配置（url / model / apiKey）
 *   · 老节点上那份完整配置怎么收进连接
 */

import type { Credential } from './credentials';
import {
  PROVIDER_META, resolveConfig, type LlmConfig, type LlmProvider, type ResolvedConfig,
} from './llm';

/* ------------------------------------------------------------------ */
/* 连接 meta 的键                                                      */
/* ------------------------------------------------------------------ */

/**
 * meta 是 `Record<string, string>`，键名散着写会各写各的 ——
 * 一处写 'base_url'、另一处读 'baseUrl'，读出来永远是空，
 * 而界面上只表现为"地址没生效"。
 */
export const LLM_META = {
  /** API 地址（chat completions 完整地址） */
  baseUrl: 'llm.baseUrl',
  /** 模型列表，换行分隔 */
  models: 'llm.models',
  /** 服务商预设名，用于给没填地址的连接兜底 */
  provider: 'llm.provider',
} as const;

/* ------------------------------------------------------------------ */
/* 读                                                                  */
/* ------------------------------------------------------------------ */

/** 连接里存的 API 地址。没填则按服务商预设兜底 */
export function llmBaseUrlOf(cred: Credential | null | undefined): string {
  if (!cred) return '';
  const own = (cred.meta?.[LLM_META.baseUrl] ?? '').trim();
  if (own) return own;
  // 没填地址时用服务商预设 —— 大多数用户就是直接用官方地址
  return llmProviderOf(cred) ? PROVIDER_META[llmProviderOf(cred)!].baseUrl : '';
}

/** 连接声明的服务商。取不到或非法时返回 null（不是 'custom'） */
export function llmProviderOf(cred: Credential | null | undefined): LlmProvider | null {
  if (!cred) return null;
  const p = (cred.meta?.[LLM_META.provider] ?? '').trim();
  return Object.prototype.hasOwnProperty.call(PROVIDER_META, p) ? (p as LlmProvider) : null;
}

/**
 * 模型列表。
 *
 * 去重且保持原顺序 —— 自动拉取的结果可能与手填的重复，
 * 不去重的话下拉框里会出现两个同名选项，用户分不清该选哪个。
 */
export function llmModelsOf(cred: Credential | null | undefined): string[] {
  return parseModelsText(cred?.meta?.[LLM_META.models] ?? '');
}

/** 多行文本 → 模型名数组。空行、纯空白、重复项都去掉 */
export function parseModelsText(text: string | null | undefined): string[] {
  const out: string[] = [];
  for (const raw of String(text ?? '').split('\n')) {
    const m = raw.trim();
    // 去掉行内注释（# 之后的），方便手填时写标记
    const name = m.replace(/\s+#.*$/, '').trim();
    if (name && out.indexOf(name) < 0) out.push(name);
  }
  return out;
}

/** 模型列表 → 多行文本（写回 meta） */
export function modelsTextOf(list: string[]): string {
  return parseModelsText(list.join('\n')).join('\n');
}

/* ------------------------------------------------------------------ */
/* 视觉能力提示                                                        */
/* ------------------------------------------------------------------ */

/**
 * 已知**不支持图片**的模型名特征。
 *
 * ================= 为什么只做"已知提示" ====================
 *
 * 靠名字判断一个模型能不能接图，本身没有可靠规则：
 * 各家命名习惯不同，同一家也随时会出新模型。
 * 硬判的代价是**误报** —— 把一个能接图的模型标成"不支持"，
 * 用户会以为不能用而不选，比漏报更糟（漏报最多跑到一半报错）。
 *
 * 所以只对**确认不支持**的给出提示，其余一律不说话。
 * 提示语也写成"（可能不支持图片）"而不是断言。
 */
const KNOWN_NO_VISION: { match: RegExp; label: string }[] = [
  { match: /^deepseek-(chat|reasoner|coder)/i, label: 'DeepSeek 文本模型' },
  { match: /^moonshot-v1/i, label: 'Moonshot v1' },
  { match: /^glm-4-flash$/i, label: 'GLM-4-Flash（视觉用 glm-4v 系列）' },
  { match: /^glm-4-air/i, label: 'GLM-4-Air' },
  { match: /^qwen-plus$/i, label: 'qwen-plus（视觉用 qwen-vl 系列）' },
  { match: /^qwen-turbo/i, label: 'qwen-turbo' },
  { match: /^yi-/i, label: '零一万物文本模型' },
];

/**
 * 给模型名返回的视觉提示。
 *
 * 只在这个模型**确认不支持**时返回文案；
 * 认不出来返回空字符串 —— 不说话，而不是乱说。
 */
export function visionHintOf(model: string): string {
  const m = String(model ?? '').trim();
  if (!m) return '';
  for (const k of KNOWN_NO_VISION) {
    if (k.match.test(m)) return `（不支持视觉 · ${k.label}）`;
  }
  return '';
}

/** 这个模型是否**已知**支持视觉（用于把提示排掉） */
export function knownVisionModel(model: string): boolean {
  return /\b(vl|vision|4v|4o|omni|gemini|claude-3|claude-4)\b/i.test(String(model ?? ''));
}

/* ------------------------------------------------------------------ */
/* 连接 + 模型 → 请求配置                                              */
/* ------------------------------------------------------------------ */

/**
 * 把"连接 + 选中的模型"算成真正能发请求的配置。
 *
 * 节点上不再存地址与密钥，全靠这里补 —— 这是整个简化的落点。
 */
export function resolveLlmFromCredential(
  cred: Credential | null | undefined,
  model: string,
  opts: { timeoutSec?: number; fallback?: LlmConfig } = {},
): ResolvedConfig {
  const timeoutSec = opts.timeoutSec && opts.timeoutSec > 0 ? opts.timeoutSec : 60;

  /*
   * 没有连接 → 退回节点上那份旧配置（老画布迁移前会走这条路）。
   * 直接返回空的话，老节点会突然跑不起来，而界面上看不出原因。
   */
  if (!cred) {
    return resolveConfig(opts.fallback ?? {
      provider: 'custom', baseUrl: '', model, apiKey: '', timeoutSec,
    });
  }

  const url = llmBaseUrlOf(cred);
  const list = llmModelsOf(cred);
  /*
   * 选中的模型不在列表里也**照用**。
   *
   * 列表只是"上次拉到的快照"，服务商随时可能上新模型；
   * 卡住不让用会逼用户每次上新模型都回来编辑一次连接。
   */
  const finalModel = String(model ?? '').trim()
    || (list.length > 0 ? list[0] : '')
    || (llmProviderOf(cred) ? PROVIDER_META[llmProviderOf(cred)!].model : '');

  return {
    url,
    model: finalModel,
    apiKey: (cred.secret ?? '').trim(),
    timeoutSec,
  };
}

/* ------------------------------------------------------------------ */
/* 老节点迁移                                                          */
/* ------------------------------------------------------------------ */

export type LlmMigrationInput = {
  /** 节点上那份完整配置（老格式） */
  llm?: Partial<LlmConfig> | null;
};

/**
 * 老节点上那份 llm 配置，能不能收进连接。
 *
 * 判据只有一条：**有没有密钥**。
 * 没有密钥的话收进去也是一条跑不通的连接，
 * 还不如不动 —— 节点上那份留着继续用。
 */
export function canMigrateLlm(input: LlmMigrationInput): boolean {
  const key = (input.llm?.apiKey ?? '').trim();
  return key.length > 0;
}

/**
 * 为老节点那份配置找一条可复用的连接，找不到就返回 null（调用方新建）。
 *
 * 复用判据：地址 + 密钥都相同。
 * 只比密钥不够 —— 同一个 key 也可能配了不同地址（官方 / 中转），
 * 复用错的表现是"这个节点突然连到别处去了"。
 */
export function findReusableLlmCredential(
  credentials: Credential[],
  input: LlmMigrationInput,
): Credential | null {
  const key = (input.llm?.apiKey ?? '').trim();
  const url = (input.llm?.baseUrl ?? '').trim()
    || PROVIDER_META[(input.llm?.provider ?? 'custom') as LlmProvider]?.baseUrl
    || '';
  if (!key) return null;
  for (const c of credentials) {
    if (c.kind !== 'llm') continue;
    if ((c.secret ?? '').trim() !== key) continue;
    if (llmBaseUrlOf(c) !== url) continue;
    return c;
  }
  return null;
}

/**
 * 迁移后该往节点上写什么。
 *
 * 只留 credentialId 与 model —— 地址、密钥、服务商全部清掉。
 * 不清的话两处都有地址，改连接的地址不生效，
 * 表现为"改了没反应"，而且看不出是节点上那份还在起作用。
 */
export function llmMigrationPatch(cred: Credential, input: LlmMigrationInput): Record<string, unknown> {
  const model = (input.llm?.model ?? '').trim();
  return {
    credentialId: cred.id,
    llmProvider: cred.id,
    llmModel: model || (llmModelsOf(cred)[0] ?? ''),
    llm: {
      provider: 'custom',
      baseUrl: '',
      model: '',
      apiKey: '',
      timeoutSec: input.llm?.timeoutSec ?? 60,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 自动拉取                                                            */
/* ------------------------------------------------------------------ */

/**
 * chat completions 地址 → models 列表地址。
 *
 * 各家都兼容 OpenAI 格式，所以把末尾那段换成 /models 即可：
 *   https://api.openai.com/v1/chat/completions → https://api.openai.com/v1/models
 *
 * 认不出结尾（比如自定义网关路径很怪）时返回 null ——
 * 让调用方提示手填，而不是拼出一个必然 404 的地址。
 */
export function modelsEndpointOf(chatUrl: string): string | null {
  const u = String(chatUrl ?? '').trim();
  if (!u) return null;
  const m = u.match(/^(.*?)\/?(chat\/completions|completions|responses)\/?$/i);
  if (!m) return null;
  return `${m[1]}/models`;
}

/**
 * 把拉取到的模型并进已有列表。
 *
 * 已有项**保持在前** —— 用户手写的顺序是刻意的（常用的排前面），
 * 自动拉取的结果追加在后面，不能把人排的顺序冲掉。
 */
export function mergeModels(existing: string[], fetched: string[]): string[] {
  const out = parseModelsText((existing ?? []).join('\n'));
  for (const f of parseModelsText((fetched ?? []).join('\n'))) {
    if (out.indexOf(f) < 0) out.push(f);
  }
  return out;
}

/**
 * 从 /v1/models 的响应里取出模型名数组。
 *
 * OpenAI 格式是 `{ data: [{ id: 'gpt-4o', ... }] }`。
 * 形状不认识时返回空数组 —— 调用方据此提示"没拉到，请手填"，
 * 而不是把一堆乱数据塞进下拉框。
 */
export function extractModelIds(payload: unknown): string[] {
  const data = (payload as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: string[] = [];
  for (const row of data) {
    const id = (row as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id.trim() && out.indexOf(id.trim()) < 0) {
      out.push(id.trim());
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 批量迁移                                                            */
/* ------------------------------------------------------------------ */

/** 一条画布（只要能遍历出节点即可，不依赖完整类型） */
export type MigratableCanvas = {
  id: string;
  name?: string;
  nodes: { id: string; data?: Record<string, unknown> }[];
};

export type LlmMigrationResult = {
  /** 新建出来的连接（已并入传入列表） */
  credentials: Credential[];
  /** 改过的节点，按画布 id 分组：`canvasId → { nodeId → patch }` */
  patches: Record<string, Record<string, Record<string, unknown>>>;
  /** 新收进连接的节点数 */
  migrated: number;
};

/**
 * 把所有画布上"节点内联的大模型配置"收进连接。
 *
 * ================= 为什么必须幂等 ====================
 *
 * 它在每次加载时跑（老画布随时可能被打开）。
 * 不幂等的话每开一次就多一条连接 ——
 * 表现为连接列表越来越长，而用户不知道哪条是真的。
 *
 * 幂等靠两点：
 *   ① 只处理"节点上还有密钥"的（canMigrateLlm）
 *   ② 迁移前先找可复用的连接（同地址 + 同密钥）
 * 于是已经迁过的节点（密钥已清空）第二次直接跳过。
 */
export function migrateLlmToCredentials(
  canvases: MigratableCanvas[],
  credentials: Credential[],
  make: (partial: Partial<Credential>) => Credential,
): LlmMigrationResult {
  let list = credentials.slice();
  const patches: Record<string, Record<string, Record<string, unknown>>> = {};
  let migrated = 0;

  for (const cv of canvases ?? []) {
    for (const n of cv.nodes ?? []) {
      const llm = (n.data?.llm ?? null) as Partial<LlmConfig> | null;
      if (!canMigrateLlm({ llm })) continue;

      let cred = findReusableLlmCredential(list, { llm });
      if (!cred) {
        const provider = (llm?.provider ?? 'custom') as LlmProvider;
        cred = make({
          kind: 'llm',
          /*
           * 名字带服务商与画布名 ——
           * 多条连接都叫「大模型 API Key」时分不清哪条是哪条。
           */
          name: `${PROVIDER_META[provider]?.label ?? '自定义'} · ${cv.name || cv.id}`,
          secret: (llm?.apiKey ?? '').trim(),
          meta: {
            [LLM_META.provider]: provider,
            [LLM_META.baseUrl]: (llm?.baseUrl ?? '').trim(),
            [LLM_META.models]: modelsTextOf([(llm?.model ?? '').trim()]),
          },
          capabilities: ['llm:chat', 'llm:vision'],
        });
        list = list.concat(cred);
      } else {
        // 复用时把它正在用的模型也补进清单，免得下拉框里没有
        const m = (llm?.model ?? '').trim();
        if (m && llmModelsOf(cred).indexOf(m) < 0) {
          const merged = mergeModels(llmModelsOf(cred), [m]);
          const next: Credential = {
            ...cred,
            meta: { ...(cred.meta ?? {}), [LLM_META.models]: modelsTextOf(merged) },
          };
          list = list.map((x) => (x.id === next.id ? next : x));
          cred = next;
        }
      }

      patches[cv.id] = patches[cv.id] ?? {};
      patches[cv.id][n.id] = llmMigrationPatch(cred, { llm });
      migrated += 1;
    }
  }

  return { credentials: list, patches, migrated };
}
