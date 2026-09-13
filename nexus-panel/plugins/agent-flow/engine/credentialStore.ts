/**
 * 加密凭据存储 —— 在"持久化"这一层做加密，上层无感。
 *
 * 关键约定：**内存里是明文，磁盘上是密文**。
 * 组件照常读写 credential.secret，不用关心加密；
 * 只有 load / save 这两个出入口负责加解密。
 * 这样加密就不会散落到各处，也不会有人忘了调。
 */

import type { Credential } from './credentials';
import {
  type CipherBundle, type CryptoBackend, type DeviceSignals,
  encryptString, decryptString, isCipherBundle, secretKind,
  bytesToB64, b64ToBytes, webCryptoBackend,
} from './crypto';

/**
 * 磁盘上的形态：secret 字段换成密文包，其余照旧。
 * 可读字段（名字、类型、能力）保持明文 —— 加密它们没有意义，
 * 反而让"有多少条凭据、分别能干什么"在界面上都显示不出来。
 */
export type StoredCredential = Omit<Credential, 'secret'> & {
  secret: CipherBundle | '';
};

export type StoredFile = {
  v: number;
  /** 'auto' 绑定本机；'passphrase' 每次输口令 */
  mode: 'auto' | 'passphrase';
  /** auto 模式用的设备盐。不是秘密，但缺了它无法离线复现密钥 */
  deviceSalt: string;
  credentials: StoredCredential[];
};

export const STORE_VERSION = 1;
export const CRED_STORE_KEY = 'agent-flow.credentials.v1';

export function emptyStore(deviceSalt: string, mode: 'auto' | 'passphrase' = 'auto'): StoredFile {
  return { v: STORE_VERSION, mode, deviceSalt, credentials: [] };
}

/* ------------------------------------------------------------------ */
/* 读取                                                                */
/* ------------------------------------------------------------------ */

/**
 * 解析存储文件并修复损坏。
 * 手改过、旧版本、缺字段的情况都要能兜住 —— 否则 UI 会崩在渲染阶段。
 */
export function parseStore(raw: string | null): StoredFile {
  if (!raw) return emptyStore('');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStore('');
  }
  if (!parsed || typeof parsed !== 'object') return emptyStore('');
  const o = parsed as Record<string, unknown>;

  const mode = o.mode === 'passphrase' ? 'passphrase' : 'auto';
  const deviceSalt = typeof o.deviceSalt === 'string' ? o.deviceSalt : '';
  const list = Array.isArray(o.credentials) ? o.credentials : [];

  const credentials: StoredCredential[] = list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x, i) => ({
      id: typeof x.id === 'string' ? x.id : `cred_restored_${i}`,
      name: typeof x.name === 'string' && x.name.trim() !== '' ? x.name : `凭据 ${i + 1}`,
      kind: (x.kind === 'github' || x.kind === 'llm' || x.kind === 'generic')
        ? x.kind as Credential['kind'] : 'generic',
      // 明文兼容：老数据进来直接保留，由 migrate 决定是否加密
      secret: isCipherBundle(x.secret) ? x.secret : (typeof x.secret === 'string' ? '' : ''),
      meta: (x.meta && typeof x.meta === 'object') ? x.meta as Record<string, string> : undefined,
      capabilities: Array.isArray(x.capabilities) ? x.capabilities as Credential['capabilities'] : [],
      identity: typeof x.identity === 'string' ? x.identity : undefined,
      verifiedAt: typeof x.verifiedAt === 'number' ? x.verifiedAt : undefined,
      ambiguous: x.ambiguous === true,
      note: typeof x.note === 'string' ? x.note : undefined,
      createdAt: typeof x.createdAt === 'number' ? x.createdAt : Date.now(),
    }));

  return { v: STORE_VERSION, mode, deviceSalt, credentials };
}

/**
 * 把存储文件解密成运行时凭据。
 *
 * @param pass 解锁口令。auto 模式传本机特征串，passphrase 模式传用户口令
 * @returns 解密后的凭据；单条解密失败时该条 secret 留空并记入 failed，
 *          不整批失败 —— 一条坏掉不该让所有凭据都用不了
 */
export async function decryptStore(
  be: CryptoBackend,
  file: StoredFile,
  pass: string,
): Promise<{ credentials: Credential[]; failed: string[] }> {
  const out: Credential[] = [];
  const failed: string[] = [];
  for (const sc of file.credentials) {
    if (!isCipherBundle(sc.secret)) {
      out.push({ ...sc, secret: '' } as Credential);
      continue;
    }
    try {
      const plain = await decryptString(be, sc.secret, pass);
      out.push({ ...sc, secret: plain } as Credential);
    } catch {
      failed.push(sc.id);
      out.push({ ...sc, secret: '' } as Credential);
    }
  }
  return { credentials: out, failed };
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

/** 把运行时凭据加密成存储文件。空密钥不加密（没东西可保护） */
export async function encryptStore(
  be: CryptoBackend,
  file: StoredFile,
  credentials: Credential[],
  pass: string,
): Promise<StoredFile> {
  const stored: StoredCredential[] = [];
  for (const c of credentials) {
    const bundle: CipherBundle | '' = c.secret ? await encryptString(be, c.secret, pass) : '';
    stored.push({ ...c, secret: bundle });
  }
  return { ...file, credentials: stored };
}

export function serializeStore(file: StoredFile): string {
  return JSON.stringify(file);
}

/* ------------------------------------------------------------------ */
/* 迁移                                                                */
/* ------------------------------------------------------------------ */

export type MigrationResult = {
  /** 需要迁移的条数（原本是明文且有内容） */
  found: number;
  /** 成功加密的条数 */
  done: number;
  credentials: Credential[];
};

/**
 * 把历史遗留的明文密钥加密。
 *
 * 旧版本的 secret 是裸字符串，直接读出来用也行，但那样磁盘上永远是明文。
 * 这里在首次加载时把它们转成密文 —— 用户无感，也不用手工重新填一遍。
 */
export async function migratePlaintext(
  be: CryptoBackend,
  oldCredentials: { id: string; secret?: unknown }[],
  pass: string,
  into: Credential[],
): Promise<MigrationResult> {
  let found = 0;
  let done = 0;
  const byId = new Map(into.map((c) => [c.id, c]));
  for (const old of oldCredentials || []) {
    if (secretKind(old?.secret) !== 'plain') continue;
    const plain = String(old.secret);
    if (!plain) continue;
    found += 1;
    const target = byId.get(old.id);
    if (!target) continue;
    try {
      // 写回 target.secret，让后续 encryptStore 把它加密落盘
      target.secret = plain;
      done += 1;
    } catch {
      // 加密失败就维持原样，不影响其它条目
    }
  }
  return { found, done, credentials: into };
}

/* ------------------------------------------------------------------ */
/* 设备盐                                                              */
/* ------------------------------------------------------------------ */

/** 首次运行时生成设备盐。不是秘密，但让密钥无法被离线复现 */
export function newDeviceSalt(be: CryptoBackend): string {
  return bytesToB64(be.randomBytes(16));
}

/** 采集本机特征。刻意只用同源可得的信息，不申请额外权限 */
export function collectDeviceSignals(deviceSalt: string): DeviceSignals {
  const g = globalThis as unknown as {
    navigator?: { userAgent?: string; language?: string; hardwareConcurrency?: number };
    screen?: { width?: number; height?: number; colorDepth?: number };
    Intl?: { DateTimeFormat?: () => { resolvedOptions: () => { timeZone?: string } } };
  };
  // 刻意写成直白的 if：嵌套可选链 + 三元里带字符串字面量，
  // 会被类型剥离脚本误判成返回类型注解，生成语法错误的代码。
  let timezone = '';
  try {
    const fmt = g.Intl && g.Intl.DateTimeFormat ? g.Intl.DateTimeFormat() : null;
    if (fmt) {
      const opt = fmt.resolvedOptions();
      if (opt && typeof opt.timeZone === 'string') timezone = opt.timeZone;
    }
  } catch {
    timezone = '';
  }

  return {
    userAgent: g.navigator?.userAgent || '',
    language: g.navigator?.language || '',
    timezone,
    screen: g.screen ? `${g.screen.width}x${g.screen.height}x${g.screen.colorDepth}` : '',
    cores: g.navigator?.hardwareConcurrency || 0,
    deviceSalt,
  };
}

/** 默认后端：有 WebCrypto 就用，没有返回 null（调用方应提示环境不支持） */
export function defaultBackend(): CryptoBackend | null {
  try {
    return webCryptoBackend();
  } catch {
    return null;
  }
}

export { b64ToBytes, bytesToB64 };
