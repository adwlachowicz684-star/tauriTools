/**
 * 内联密钥保险箱 —— 节点里手填的 apiKey 落盘前先加密。
 *
 * 为什么需要这一层：
 *   画布存档（agent-flow.canvases.v1）已经脱敏了，密钥不会跟着导出分享出去。
 *   但密钥仍要"刷新后还在"，否则用户每次开面板都得重填 —— 于是它被单独
 *   存进 agent-flow.llm-keys.v1。此前这个文件是**明文**的。
 *
 * 加密到底挡住了什么 —— 说准，别让人以为上了锁就万事大吉：
 *
 *   ✅ 挡住"导出 / 分享画布"：这一条其实是 canvasStore 的脱敏立的功，
 *      与本模块无关，但效果成立。
 *   ✅ 挡住"随手翻一眼"：DevTools 里 grep 'sk-' 搜不到明文了，
 *      顺手打开存储文件看的人什么也读不出来。
 *   ❌ 挡不住"整个数据目录拷走"：deviceSalt 就存在 localStorage 里，
 *      密文和盐是一起被拿走的；本机特征（UA / 语言 / 时区 / 屏幕）也是公开的，
 *      照 deviceSeed 的算法拼一遍就能离线复现这把钥匙。
 *      所以"磁盘上是密文" ≠ "拷走也读不出来"，别这么宣传。
 *   ❌ 挡不住同进程里的其它插件：同样能算出这把钥匙。
 *
 * 结论：这是**抬成本**，不是**上锁**。
 * 真正想要"别人拿不到"，请用凭据中心的口令模式 —— 那把钥匙在用户脑子里。
 */

import {
  encryptString, decryptString, isCipherBundle, type CryptoBackend,
} from './crypto';

/** 节点 id → 密钥 */
export type SecretMap = Record<string, string>;

export type UnsealResult = {
  keys: SecretMap;
  /** 读到的是旧版明文存档（未加密） */
  legacyPlaintext: boolean;
  /** 解析/解密失败：口令或设备特征变了，或数据被改坏 */
  failed: boolean;
};

const EMPTY: UnsealResult = { keys: {}, legacyPlaintext: false, failed: false };

/** 只收非空字符串；空值不占位，等于顺手清掉了已删节点的残留 */
function pickStrings(raw: unknown): SecretMap {
  const out: SecretMap = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

/**
 * 加密待落盘的密钥。
 *
 * 没有任何密钥时返回空串 —— 调用方据此删掉存储键，
 * 避免留一个空对象在那儿让人以为还有东西。
 */
export async function sealSecrets(
  be: CryptoBackend,
  keys: SecretMap,
  pass: string,
): Promise<string> {
  const clean = pickStrings(keys);
  if (Object.keys(clean).length === 0) return '';
  const bundle = await encryptString(be, JSON.stringify(clean), pass);
  return JSON.stringify(bundle);
}

/**
 * 解出密钥。
 *
 * 三种历史格式都要认：
 *   空 / 非法  → 空结果
 *   明文 map   → 原样返回，并标记 legacyPlaintext（调用方提示 + 下次保存即升级为密文）
 *   密文包     → 解密；解不开返回 failed:true，由调用方提示，绝不静默给空
 */
export async function unsealSecrets(
  be: CryptoBackend,
  raw: string | null,
  pass: string,
): Promise<UnsealResult> {
  if (!raw) return EMPTY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { keys: {}, legacyPlaintext: false, failed: true };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { keys: {}, legacyPlaintext: false, failed: true };
  }

  // 旧版：直接就是 { 节点id: 密钥 } 的明文
  if (!isCipherBundle(parsed)) {
    const keys = pickStrings(parsed);
    return { keys, legacyPlaintext: Object.keys(keys).length > 0, failed: false };
  }

  try {
    const plain = await decryptString(be, parsed, pass);
    return { keys: pickStrings(JSON.parse(plain)), legacyPlaintext: false, failed: false };
  } catch {
    return { keys: {}, legacyPlaintext: false, failed: true };
  }
}

/*
 * 原本这里有个 isPlaintextVault(raw)，与 unsealSecrets 的 legacyPlaintext
 * 判断逻辑完全相同（都是「不是密文包 且 挑得出字符串」），但从未被业务调用 ——
 * 真正的提示走的是 App 里对 legacyPlaintext 的处理。
 * 留两份判断方式，改一处忘另一处就会不一致，故删。
 */
