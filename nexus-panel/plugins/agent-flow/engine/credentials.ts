/**
 * 凭据中心 —— 纯逻辑层（可单测，不碰 DOM / localStorage）。
 *
 * 三个概念分清楚：
 *   凭据 Credential   存一把密钥（GitHub 令牌、某家 API Key……）
 *   能力 Capability   这把密钥能干的事（github:read / github:write / llm:chat…）
 *   需求 Need         某个节点要用它干什么
 *
 * 节点只声明"我需要 github:write"，不关心用的是哪把密钥；
 * 保存凭据时校验出能力，匹配交给 satisfies。改一把密钥，
 * 所有引用它的节点同时生效 —— 这就是"多个节点共享一个 key"。
 */

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export type CredentialKind = 'github' | 'llm' | 'generic';

/** 能力。命名习惯：`<领域>:<动作>` */
export type Capability =
  | 'github:read'
  | 'github:write'
  | 'llm:chat'
  | 'llm:vision';

export type Credential = {
  id: string;
  /** 展示名，用户在凭据列表里看到的东西 */
  name: string;
  kind: CredentialKind;
  /** 密钥本体。绝不进导出的 JSON */
  secret: string;
  /** 领域专属附加信息：llm 的 baseUrl、github 的默认 owner/repo */
  meta?: Record<string, string>;
  /** 校验得出的能力。未校验过为空数组 */
  capabilities: Capability[];
  /** 校验到的身份，如 GitHub 用户名 */
  identity?: string;
  /** 上次校验时间（毫秒） */
  verifiedAt?: number;
  /**
   * 权限无法自动判定时置 true。
   * 典型是 GitHub fine-grained token：响应头不带 X-OAuth-Scopes，
   * API 也没法直接问出写权限。此时保守只给 read，由用户在界面上确认。
   */
  ambiguous?: boolean;
  note?: string;
  createdAt: number;
};

/** 校验结果 */
export type VerifyResult = {
  ok: boolean;
  identity?: string;
  capabilities: Capability[];
  ambiguous?: boolean;
  /** 给人看的说明，尤其是失败的理由 */
  message: string;
};

/* ------------------------------------------------------------------ */
/* 能力蕴含                                                            */
/* ------------------------------------------------------------------ */

/**
 * 蕴含表：拥有 key 所列之一，即视为满足 value。
 *
 * github:write 蕴含 read —— 能推代码自然能读仓库。
 * llm:vision 与 llm:chat 互不蕴含：有些视觉模型只接图，
 * 而不少纯文本模型接不了图。分开声明才不会错配。
 */
const IMPLIES: Record<Capability, Capability[]> = {
  'github:read': [],
  'github:write': ['github:read'],
  'llm:chat': [],
  'llm:vision': [],
};

/** 展开一个能力为它自己 + 所有被蕴含的能力 */
export function expandCapability(c: Capability): Capability[] {
  const out: Capability[] = [c];
  for (const sub of IMPLIES[c] || []) {
    for (const x of expandCapability(sub)) {
      if (out.indexOf(x) < 0) out.push(x);
    }
  }
  return out;
}

/** 单条需求的满足判定 */
export function satisfiesOne(have: Capability[], need: Capability): boolean {
  const owned: Capability[] = [];
  for (const h of have) {
    for (const x of expandCapability(h)) {
      if (owned.indexOf(x) < 0) owned.push(x);
    }
  }
  return owned.indexOf(need) >= 0;
}

/** 一组需求是否全部满足；返回缺失的部分 */
export function missingCapabilities(
  have: Capability[],
  need: Capability[],
): Capability[] {
  return (need || []).filter((n) => !satisfiesOne(have, n));
}

/** 凭据能否用于声明了 need 的节点 */
export function satisfies(cred: Credential, need: Capability[]): boolean {
  return missingCapabilities(cred.capabilities || [], need).length === 0;
}

/** 从一组凭据里挑出能满足 need 的 */
export function pickFor(
  creds: Credential[],
  need: Capability[],
): Credential[] {
  return (creds || []).filter((c) => satisfies(c, need));
}

/* ------------------------------------------------------------------ */
/* 节点需求声明                                                        */
/* ------------------------------------------------------------------ */

/**
 * 各节点需要的能力。
 * 新增带密钥的节点时在这里登记，界面与校验自动跟随。
 */
export const NODE_NEEDS: Record<string, Capability[]> = {
  ocr: ['llm:vision'],
  translate: ['llm:chat'],
  'github-update': ['github:read'],
  'github-push': ['github:write'],
};

export function needsOf(nodeKind: string): Capability[] {
  return NODE_NEEDS[nodeKind] || [];
}

/** 节点需要的凭据类型（用于界面里过滤可选凭据） */
export function kindForNeed(need: Capability[]): CredentialKind | null {
  if (!need || need.length === 0) return null;
  if (need.some((n) => n.indexOf('github:') === 0)) return 'github';
  if (need.some((n) => n.indexOf('llm:') === 0)) return 'llm';
  return 'generic';
}

/* ------------------------------------------------------------------ */
/* GitHub 能力推导                                                     */
/* ------------------------------------------------------------------ */

/**
 * 从 GitHub API 响应推导能力。
 *
 * @param scopesHeader 响应头 X-OAuth-Scopes，形如 "repo, workflow"
 * @param ok           请求是否成功（401/403 时为 false）
 *
 * 三种情况：
 *  1. classic PAT → 有 X-OAuth-Scopes，直接读
 *  2. fine-grained PAT → 没有这个头，无法判定写权限 → 保守给 read + ambiguous
 *  3. 请求失败 → 无能力
 *
 * 第 2 种不猜：猜错的话用户会在推送时撞 403，
 * 而"保守 + 让用户确认"至少让他此刻就知道有这件事。
 */
export function detectGithubCapabilities(
  scopesHeader: string | null | undefined,
  ok: boolean,
): { capabilities: Capability[]; ambiguous: boolean } {
  if (!ok) return { capabilities: [], ambiguous: false };

  // 无 scope 头：fine-grained token，或被擦掉了头
  if (!scopesHeader) {
    return { capabilities: ['github:read'], ambiguous: true };
  }

  const scopes = scopesHeader
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');

  // 空字符串（header 存在但没内容）= 无额外授权的 classic token，
  // 仍可读公开仓库
  if (scopes.length === 0) {
    return { capabilities: ['github:read'], ambiguous: true };
  }

  const caps: Capability[] = [];
  const has = (s: string) => scopes.indexOf(s) >= 0;

  // 读：repo / public_repo 都能读（public_repo 只能读公开的）
  if (has('repo') || has('public_repo') || has('read:org')) {
    caps.push('github:read');
  }
  // 写：repo 覆盖私有与公开；public_repo 只能写公开的
  if (has('repo') || has('public_repo')) {
    caps.push('github:write');
  }

  return { capabilities: caps, ambiguous: false };
}

/**
 * 兜底提示：能力不足时告诉用户该去申请什么。
 * 这个是纯文本生成，方便界面直接展示。
 */
export function scopeHintFor(need: Capability[]): string {
  if (need.indexOf('github:write') >= 0) {
    return '推送需要 repo（私有库）或 public_repo（公开库）权限。';
  }
  if (need.indexOf('github:read') >= 0) {
    return '读取公开仓库无需特殊权限；私有库需要 repo。';
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 建凭据                                                              */
/* ------------------------------------------------------------------ */

let seq = 0;

export function makeCredential(
  partial: Partial<Credential> = {},
): Credential {
  seq += 1;
  const now = Date.now();
  return {
    id: partial.id || `cred_${now}_${seq}`,
    name: partial.name || '未命名凭据',
    kind: partial.kind || 'generic',
    secret: partial.secret || '',
    meta: partial.meta,
    capabilities: partial.capabilities || [],
    identity: partial.identity,
    verifiedAt: partial.verifiedAt,
    ambiguous: partial.ambiguous,
    note: partial.note,
    createdAt: partial.createdAt ?? now,
  };
}

/**
 * 凭据脱敏：导出 / 落盘前调用。
 *
 * 只留 id 与名字，密钥与能力明细都不带走 ——
 * 能力里能反推出权限范围，也不宜外泄。
 */
export function redactCredential(c: Credential): Credential {
  return {
    ...c,
    secret: '',
    meta: undefined,
    capabilities: [],
    identity: undefined,
    verifiedAt: undefined,
    note: undefined,
  };
}

export function redactCredentials(list: Credential[]): Credential[] {
  return (list || []).map(redactCredential);
}

/** 按 id 取凭据；找不到返回 null（调用方决定如何提示） */
export function findCredential(
  list: Credential[],
  id: string | undefined,
): Credential | null {
  if (!id) return null;
  const hit = (list || []).find((c) => c.id === id);
  return hit || null;
}

/**
 * 解析节点用的密钥：优先走凭据引用，没有则退回节点内联值。
 *
 * 保留内联是为了兼容旧画布 —— 那些节点里直接存了 apiKey，
 * 不认它们的话用户一升级就全部失效。
 */
export function resolveSecret(
  list: Credential[],
  credentialId: string | undefined,
  inline: string | undefined,
): string {
  const c = findCredential(list, credentialId);
  if (c && c.secret) return c.secret;
  return inline || '';
}
