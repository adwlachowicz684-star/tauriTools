/**
 * 凭据加密 —— 让 localStorage 里不再出现明文密钥。
 *
 * 【防什么、不防什么，先说清楚】
 *  · 防得住：外部工具直接读取浏览器存储文件（Tauri 的 webview 数据
 *    在磁盘上常是明文的 SQLite / LevelDB）。加密后拿到的是密文。
 *  · 防得住：随手打开开发者工具扫一眼 localStorage。
 *  · 防不住：同源里运行的其它脚本 —— 它也能调用同样的解密流程。
 *    这不是本模块的缺陷，是浏览器环境的结构性限制。
 *    要防这一类，得把密钥交给 Rust 侧保管（见文末说明）。
 *
 * 所以提供两档：
 *  · auto（默认）：密钥绑定本机特征，免口令，防"外部读取"
 *  · passphrase：每次解锁要输口令，密钥不落盘，强度高得多
 */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

export const CIPHER_VERSION = 1;
export const CIPHER_ALG = 'AES-GCM';
/** GCM 标准 IV 长度：12 字节 */
export const IV_BYTES = 12;
export const SALT_BYTES = 16;
/** 32 字节 = AES-256 */
export const KEY_BYTES = 32;

/**
 * PBKDF2 迭代次数。
 * OWASP 对 HMAC-SHA256 的建议是 600k，这里取 310k：
 * 解锁是一次性操作，但太慢会让"自动解锁"在冷启动时有可感延迟。
 */
export const PBKDF2_ITER = 310000;

/** 加密后的形态。全部字段是 base64，方便直接进 JSON */
export type CipherBundle = {
  v: number;
  alg: string;
  iter: number;
  salt: string;
  iv: string;
  data: string;
};

/* ------------------------------------------------------------------ */
/* base64（纯逻辑，可单测）                                            */
/* ------------------------------------------------------------------ */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToB64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const c0 = b[i];
    const c1 = b[i + 1];
    const c2 = b[i + 2];
    out += B64[c0 >> 2];
    out += B64[((c0 & 3) << 4) | ((c1 === undefined ? 0 : c1) >> 4)];
    out += c1 === undefined ? '=' : B64[((c1 & 15) << 2) | ((c2 === undefined ? 0 : c2) >> 6)];
    out += c2 === undefined ? '=' : B64[c2 & 63];
  }
  return out;
}

export function b64ToBytes(s: string): Uint8Array {
  const clean = (s || '').replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64.indexOf(clean[i]);
    const b = B64.indexOf(clean[i + 1]);
    const c = B64.indexOf(clean[i + 2]);
    const d = B64.indexOf(clean[i + 3]);
    if (a < 0 || b < 0) continue;
    out[p++] = (a << 2) | (b >> 4);
    if (c >= 0) out[p++] = ((b & 15) << 4) | (c >> 2);
    if (d >= 0) out[p++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, p);
}

/* ------------------------------------------------------------------ */
/* 识别（纯逻辑）                                                      */
/* ------------------------------------------------------------------ */

/** 判断一个值是不是我们自己的密文包 */
export function isCipherBundle(x: unknown): x is CipherBundle {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.v === 'number' &&
    typeof o.alg === 'string' &&
    typeof o.iter === 'number' &&
    typeof o.salt === 'string' &&
    typeof o.iv === 'string' &&
    typeof o.data === 'string'
  );
}

/**
 * 判断持久化下来的凭据是否需要迁移。
 * 返回 'plain' 表示还是老格式（明文），'cipher' 表示已加密，'empty' 表示空。
 */
export function secretKind(secret: unknown): 'plain' | 'cipher' | 'empty' {
  if (secret === null || secret === undefined) return 'empty';
  if (typeof secret === 'string') return secret === '' ? 'empty' : 'plain';
  return isCipherBundle(secret) ? 'cipher' : 'empty';
}

/* ------------------------------------------------------------------ */
/* 本机特征（纯逻辑）                                                  */
/* ------------------------------------------------------------------ */

export type DeviceSignals = {
  userAgent?: string;
  language?: string;
  timezone?: string;
  screen?: string;
  cores?: number;
  /** 首次运行时生成并留存的一段随机数。本身不是秘密，但缺了它外部工具没法离线复现密钥 */
  deviceSalt?: string;
};

/**
 * 拼本机特征串。
 *
 * 刻意不追求"不可猜测"—— 这些信息外部工具理论上也能拿到一部分。
 * 目标是让"直接打开存储文件"这类最省事的攻击失效，把成本抬到
 * 攻击者必须真的理解本应用才行。
 */
export function deviceSeed(s: DeviceSignals): string {
  const parts = [
    s.userAgent || '',
    s.language || '',
    s.timezone || '',
    s.screen || '',
    String(s.cores || 0),
    s.deviceSalt || '',
  ];
  return parts.join('|');
}

/* ------------------------------------------------------------------ */
/* 后端（可注入，便于测试）                                            */
/* ------------------------------------------------------------------ */

export type CryptoBackend = {
  randomBytes(n: number): Uint8Array;
  pbkdf2(pass: string, salt: Uint8Array, iter: number): Promise<Uint8Array>;
  aesGcmEncrypt(key: Uint8Array, iv: Uint8Array, plain: Uint8Array): Promise<Uint8Array>;
  aesGcmDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array>;
};

function hasWebCrypto(): boolean {
  return typeof globalThis !== 'undefined' && !!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle;
}

/** 真实后端：走 WebCrypto。浏览器与 Tauri webview 都可用 */
export function webCryptoBackend(): CryptoBackend {
  const subtle = (globalThis as unknown as {
    crypto: { subtle: SubtleCrypto; getRandomValues: (a: Uint8Array) => Uint8Array };
  }).crypto;
  return {
    randomBytes(n: number): Uint8Array {
      const a = new Uint8Array(n);
      subtle.getRandomValues(a);
      return a;
    },
    async pbkdf2(pass: string, salt: Uint8Array, iter: number): Promise<Uint8Array> {
      const km = await subtle.subtle.importKey(
        'raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveBits'],
      );
      const bits = await subtle.subtle.deriveBits(
        { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations: iter, hash: 'SHA-256' },
        km,
        KEY_BYTES * 8,
      );
      return new Uint8Array(bits);
    },
    async aesGcmEncrypt(key: Uint8Array, iv: Uint8Array, plain: Uint8Array): Promise<Uint8Array> {
      const k = await subtle.subtle.importKey('raw', key as unknown as BufferSource, 'AES-GCM', false, ['encrypt']);
      const ct = await subtle.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        k,
        plain as unknown as BufferSource,
      );
      return new Uint8Array(ct);
    },
    async aesGcmDecrypt(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
      const k = await subtle.subtle.importKey('raw', key as unknown as BufferSource, 'AES-GCM', false, ['decrypt']);
      const pt = await subtle.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as unknown as BufferSource },
        k,
        data as unknown as BufferSource,
      );
      return new Uint8Array(pt);
    },
  };
}

export { hasWebCrypto };

/* ------------------------------------------------------------------ */
/* 加解密                                                              */
/* ------------------------------------------------------------------ */

/**
 * 派生密钥。
 * @param pass 口令；auto 模式传本机特征串，passphrase 模式传用户口令
 */
export async function deriveKey(
  be: CryptoBackend,
  pass: string,
  salt: Uint8Array,
  iter: number = PBKDF2_ITER,
): Promise<Uint8Array> {
  return be.pbkdf2(pass, salt, iter);
}

/** 加密字符串。每次都换新的 salt 与 IV —— GCM 下 IV 重用会直接泄露明文关系 */
export async function encryptString(
  be: CryptoBackend,
  plain: string,
  pass: string,
  iter: number = PBKDF2_ITER,
): Promise<CipherBundle> {
  const salt = be.randomBytes(SALT_BYTES);
  const iv = be.randomBytes(IV_BYTES);
  const key = await deriveKey(be, pass, salt, iter);
  const data = await be.aesGcmEncrypt(key, iv, new TextEncoder().encode(plain));
  return {
    v: CIPHER_VERSION,
    alg: CIPHER_ALG,
    iter,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    data: bytesToB64(data),
  };
}

/**
 * 解密。密钥错误 / 数据被篡改都会抛异常（GCM 自带完整性校验）。
 * 调用方必须 try/catch —— 拿不到明文时应提示"解锁失败"，而不是静默给空串。
 */
export async function decryptString(
  be: CryptoBackend,
  bundle: CipherBundle,
  pass: string,
): Promise<string> {
  const salt = b64ToBytes(bundle.salt);
  const iv = b64ToBytes(bundle.iv);
  const data = b64ToBytes(bundle.data);
  const key = await deriveKey(be, pass, salt, bundle.iter || PBKDF2_ITER);
  const pt = await be.aesGcmDecrypt(key, iv, data);
  return new TextDecoder().decode(pt);
}
