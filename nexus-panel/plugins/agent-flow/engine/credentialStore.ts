/**
 * 加密连接存储 —— 在"持久化"这一层做加密，上层无感。
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
 * 反而让"有多少条连接、分别能干什么"在界面上都显示不出来。
 */
export type StoredCredential = Omit<Credential, 'secret'> & {
  /**
   * 磁盘上的形态：密文 bundle，或**尚未加密的明文**。
   *
   * ⛔ 以前这里是 `CipherBundle | ''`，于是"磁盘上躺着明文"这件事
   * **在类型上就无法表示** —— parseStore 里那句注释写着
   * 「明文兼容：老数据进来直接保留」，而它两个分支都只能返回 ''，
   * 因为类型不允许返回字符串。
   *
   * 结果是：明文在**读盘那一刻**就被抹掉，migratePlaintext 永远看不到它
   * （found 恒 0，成了死代码），老存档的密钥永久丢失且无任何提示。
   */
  secret: CipherBundle | string;
};

/**
 * 保险箱主密钥从哪来。
 *
 *   auto        本机特征派生 —— 盐明文躺在数据目录里，拷走目录即可离线解开
 *   oskeyring   OS 连接管理器 —— 钥匙在 OS 手里，拷走目录解不开，且不用每次输口令
 *   passphrase  用户口令     —— 每次打开要输，钥匙只在用户脑子里
 */
export type VaultMode = 'auto' | 'oskeyring' | 'passphrase';

export type StoredFile = {
  v: number;
  /** 'auto' 绑定本机；'oskeyring' 存 OS 连接管理器；'passphrase' 每次输口令 */
  mode: VaultMode;
  /** auto 模式用的设备盐。不是秘密，但缺了它无法离线复现密钥 */
  deviceSalt: string;
  credentials: StoredCredential[];
};

export const STORE_VERSION = 1;
export const CRED_STORE_KEY = 'agent-flow.credentials.v1';

export function emptyStore(deviceSalt: string, mode: VaultMode = 'auto'): StoredFile {
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

  /*
   * 认三种，不认识的退回 'auto'。
   *
   * 以前只判了 passphrase —— 加了 oskeyring 之后，不补这里的话
   * 存的是 oskeyring、读回来变 auto，于是用**设备特征**去解
   * 用 OS 密钥加密的数据，一条都解不开，且界面上没有任何提示。
   * 老存档（只有 auto / passphrase）不受影响。
   */
  const mode: VaultMode =
    o.mode === 'passphrase' ? 'passphrase'
      : o.mode === 'oskeyring' ? 'oskeyring'
        : 'auto';
  const deviceSalt = typeof o.deviceSalt === 'string' ? o.deviceSalt : '';
  const list = Array.isArray(o.credentials) ? o.credentials : [];

  const credentials: StoredCredential[] = list
    .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
    .map((x, i) => ({
      id: typeof x.id === 'string' ? x.id : `cred_restored_${i}`,
      name: typeof x.name === 'string' && x.name.trim() !== '' ? x.name : `连接 ${i + 1}`,
      kind: (x.kind === 'github' || x.kind === 'llm' || x.kind === 'generic' || x.kind === 'cli')
        ? x.kind as Credential['kind'] : 'generic',
      /*
       * ⛔ 以前这里两个分支都返回 ''（"保留明文"是句假话）——
       * 明文在读盘时就被抹掉，后面 migrate 拿到的永远是空。
       * 现在真的保留，交给 migratePlaintext 转成密文。
       */
      secret: isCipherBundle(x.secret) ? x.secret : (typeof x.secret === 'string' ? x.secret : ''),
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
 * 把存储文件解密成运行时连接。
 *
 * @param pass 解锁口令。auto 模式传本机特征串，passphrase 模式传用户口令
 * @returns 解密后的连接；单条解密失败时该条 secret 留空并记入 failed，
 *          不整批失败 —— 一条坏掉不该让所有连接都用不了
 */
export async function decryptStore(
  be: CryptoBackend,
  file: StoredFile,
  pass: string,
): Promise<{ credentials: Credential[]; failed: string[]; plaintext: number }> {
  const out: Credential[] = [];
  const failed: string[] = [];
  for (const sc of file.credentials) {
    if (!isCipherBundle(sc.secret)) {
      /*
       * 不是密文 → 要么**空密钥**（用户还没填），要么老存档遗留的**明文**。
       *
       * ⛔ 曾经把这两种一律计入 failed，两个方向都错：
       *   空密钥 → 假警报。一条都没填的库会被 judgeUnlock 判成 'all'，
       *           于是"口令不对，一条都没解开"，拿正确口令也进不去。
       *   明文   → 它其实读得出来，算"解不开"是谎报；
       *           下面 migratePlaintext 会把它取回来，落盘时转成密文。
       */
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
  /*
   * 明文迁移**只能**在这里做 —— 这是唯一还看得到磁盘原始形态的地方。
   *
   * ⛔ migratePlaintext 此前全项目零调用方（只有测试在用）：明文永远转不成
   * 密文，而下一次落盘时 `secret: ''` 会把磁盘上那份明文**覆盖成空** ——
   * 密钥永久丢失，连原始明文都没得救了，且全程无提示。
   */
  const mig = await migratePlaintext(be, file.credentials, pass, out);
  return { credentials: mig.credentials, failed, plaintext: mig.done };
}

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

/** 把运行时连接加密成存储文件。空密钥不加密（没东西可保护） */
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
  /**
   * 已取回并写回**待加密**的条数。
   *
   * ⛔ 以前这里写"成功加密的条数"，而加密根本不在这里发生 ——
   * 这一步只把明文塞回 credentials，真正的加密在后面 encryptStore。
   * 名字说"已加密"、算的是"已取出"，encryptStore 一旦失败，
   * 报出去的"成功 N 条"就是假的。
   */
  done: number;
  /** found 里找不到对应连接的条数（明文还在磁盘上，这一步救不回来） */
  skipped: number;
  /** 被抢救回来的连接 id —— 调用方靠它把这些从 failed 里摘掉 */
  rescued: string[];
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
  let skipped = 0;
  const rescued: string[] = [];
  const byId = new Map(into.map((c) => [c.id, c]));
  for (const old of oldCredentials || []) {
    if (secretKind(old?.secret) !== 'plain') continue;
    const plain = String(old.secret);
    if (!plain) continue;
    found += 1;
    const target = byId.get(old.id);
    if (!target) { skipped += 1; continue; }
    /*
     * ⛔ 以前这里包了个 try/catch，注释写着"加密失败就维持原样" ——
     * 而这一行是**普通赋值**，secret 不是 getter，永远不会抛。
     * 那个 catch 是死的：它让人以为失败被兜住了，实际没有任何失败路径。
     *
     * 真正的加密在后面 encryptStore；这里只负责把明文塞回去。
     */
    target.secret = plain;
    done += 1;
    rescued.push(old.id);
  }
  return { found, done, skipped, rescued, credentials: into };
}

/* ------------------------------------------------------------------ */
/* 解锁判定                                                            */
/* ------------------------------------------------------------------ */

export type UnlockVerdict =
  /** 全部解开 */
  | { kind: 'ok' }
  /** 解开了一部分：可以进，但**必须**告诉用户有几条没解开 */
  | { kind: 'partial'; failedCount: number }
  /** 一条都没解开：多半是口令不对 */
  | { kind: 'all' };

/**
 * 解锁该不该放行、放行后要不要说话。
 *
 * ⛔ 以前这里只判"是不是全失败"，于是**部分失败一律静默放行**：
 * 三条里解不开一条，界面照常进、错误区被清空，用户看到的是
 * "解锁成功" —— 而那一条的 secret 是空串，用到它的节点运行时才报错。
 * 真正出问题的那条在列表里看起来和别的一模一样。
 *
 * 收成纯函数是为了让这条判定能被单测钉住：它是"进不进"的唯一依据，
 * 散在 hook 里改一次就各写一份。
 */
export function judgeUnlock(total: number, failedCount: number): UnlockVerdict {
  if (total > 0 && failedCount >= total) return { kind: 'all' };
  if (failedCount > 0) return { kind: 'partial', failedCount };
  return { kind: 'ok' };
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
