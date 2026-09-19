/**
 * 把保险箱主密钥放进 **操作系统凭据管理器**。
 *
 * ================= 为什么需要第三种模式 ====================
 *
 * 以前只有两种：
 *
 *   auto        主密钥 = 本机特征（UA/语言/时区/屏幕/核数 + 盐）拼出来的字符串
 *   passphrase  主密钥 = 用户每次输的口令
 *
 * auto 的问题（af_flow.rs 里也记着）：
 *   盐文件就躺在应用数据目录里，明文明放。
 *   **谁把整个数据目录拷走，谁就能离线复现密钥、解开全部凭据。**
 *   它防的只是"同页面其它脚本顺手读"，防不住离线拷贝。
 *
 * passphrase 能防，但每次打开都要输一遍。
 *
 * 第三种：主密钥存进 OS 凭据管理器 ——
 *   Windows 凭据管理器 / macOS 钥匙串 / Linux Secret Service。
 *   钥匙不在数据目录里，而在 OS 手里，且与用户登录态绑定。
 *   既不用每次输口令，又防得住"拷走整个目录"。
 *
 * ================= 三条硬规矩 ====================
 *
 * ① **不可用时必须明确说，绝不静默降级。**
 *    静默退回 auto 的话，用户以为在用 OS 保护，实际还是老样子 ——
 *    这种"假的安全感"比没有更糟。
 *
 * ② **主密钥必须是随机生成的**，不能从设备特征派生。
 *    派生的等于把钥匙又放回机器里，白做。
 *
 * ③ **写进去之前先回读验证。**
 *    存不进去、或存进去读不回来（Linux 上钥匙串要解锁时很常见），
 *    如果照样拿它加密，凭据就永久解不开了 —— 那是数据丢失。
 */

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/**
 * 在 OS 凭据管理器里的标识。
 *
 * service 与 account 一起定位一条记录，所以不用再往里塞随机后缀 ——
 * 换了名字就等于换了个保险箱，之前存的密钥找不回来。
 */
export const OS_KEYRING_SERVICE = 'nexus-panel.agent-flow';
export const OS_KEYRING_ACCOUNT = 'credential-vault-key';

/** 主密钥字节数。32 字节 = 256 位，跟 AES-256 的密钥长度对齐 */
export const OS_KEYRING_KEY_BYTES = 32;

/* ------------------------------------------------------------------ */
/* 读取结果                                                            */
/* ------------------------------------------------------------------ */

export type OsKeyringRead =
  /** 读到了。value 一定是非空字符串 */
  | { ok: true; value: string }
  /** 没有这条记录（还没存过），不是错误 */
  | { ok: true; value: null }
  /** 凭据管理器不可用或读失败 */
  | { ok: false; reason: string };

/** 把一次读取的结果归一成 OsKeyringRead —— 边界都收在这里，调用方不用各自判一遍 */
export function toOsKeyringRead(raw: unknown): OsKeyringRead {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== 'string') {
    return { ok: false, reason: `凭据管理器返回了非字符串：${typeof raw}` };
  }
  /*
   * 空串当"没有"。
   * 有些后端在记录不存在时会返回空串而不是 null；
   * 把它当成一个真的密钥去解密，会得到一个"口令不对"的错，
   * 而真正的处理方式是"新建一条" —— 两者要修的方向完全不同。
   */
  if (raw.trim() === '') return { ok: true, value: null };
  return { ok: true, value: raw };
}

/* ------------------------------------------------------------------ */
/* 生成主密钥                                                          */
/* ------------------------------------------------------------------ */

/**
 * 生成一个新的主密钥。
 *
 * 用 16 进制而不是 base64：hex 在所有平台都能原样进出，
 * 而 base64 里的 + / = 在某些凭据管理器里会被转义。
 */
export function newOsKeyringKey(randomBytes: (n: number) => Uint8Array): string {
  const a = randomBytes(OS_KEYRING_KEY_BYTES);
  let out = '';
  for (let i = 0; i < a.length; i += 1) {
    out += a[i].toString(16).padStart(2, '0');
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 启动时的决策                                                        */
/* ------------------------------------------------------------------ */

export type OsKeyringPlan =
  /** 用读到的这个密钥去解密 */
  | { action: 'use'; key: string }
  /** 生成一个新密钥，存进凭据管理器，再用它加密 */
  | { action: 'create'; key: string }
  /** 凭据管理器不可用 —— 必须明确告知，不能静默降级 */
  | { action: 'unavailable'; reason: string };

/**
 * 启动时该做什么。
 *
 * 不在这里生成密钥（那要调随机源），而是把"该做什么"算出来，
 * 由调用方执行 —— 这样这条决策能被单测覆盖。
 */
export function planOsKeyringStart(read: OsKeyringRead): OsKeyringPlan {
  if (!read.ok) return { action: 'unavailable', reason: read.reason };
  if (read.value === null) return { action: 'create', key: '' };
  return { action: 'use', key: read.value };
}

/* ------------------------------------------------------------------ */
/* 写后回读                                                            */
/* ------------------------------------------------------------------ */

export type OsKeyringWriteCheck =
  | { ok: true }
  | { ok: false; reason: string };

/**
 * 写完回读，确认真的存住了。
 *
 * 这是防"凭据永久解不开"的最后一道关：
 * Linux 的 Secret Service 在钥匙串锁着时会**接受写入但读不出来**，
 * 此时若拿这个密钥去加密，下次打开就再也解不开了。
 *
 * 回读不一致 → 明确失败，让调用方别用它加密。
 */
export function judgeOsKeyringWrite(readBack: OsKeyringRead, expected: string): OsKeyringWriteCheck {
  if (!readBack.ok) {
    return { ok: false, reason: `写入后无法回读：${readBack.reason}` };
  }
  if (readBack.value === null) {
    return {
      ok: false,
      reason: '写入后回读为空 —— 凭据管理器没有真正存住（钥匙串可能处于锁定状态）',
    };
  }
  if (readBack.value !== expected) {
    /*
     * 读回来的是别的值：可能是另一条记录被读到了，
     * 也可能后端做了截断/转义。不管哪种，都不能拿 expected 去加密 ——
     * 那样存进去的是用 A 加密、将来读出来用 B 解密，必然全解不开。
     */
    return {
      ok: false,
      reason: '写入后回读与写入值不一致，凭据管理器可能做了转义或截断',
    };
  }
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 模式说明                                                            */
/* ------------------------------------------------------------------ */

/**
 * 界面上怎么描述这个模式。
 *
 * 刻意写清"防得住什么、防不住什么" ——
 * 只说"更安全"会让人以为是无敌的，而实际上
 * 能登录这台机器的用户仍然能取到密钥。
 */
export function osKeyringHint(): string {
  return '主密钥存在操作系统凭据管理器里（Windows 凭据管理器 / macOS 钥匙串），'
    + '不在应用数据目录中 —— 拷走整个数据目录也解不开。'
    + '能登录这台机器的人仍可取到，要防那个请用口令模式。';
}
