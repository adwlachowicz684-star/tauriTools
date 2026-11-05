/**
 * 归档字节的零依赖工具（webview / Node 双运行时）
 * ============================================================================
 *
 * 为什么单独抽这个文件
 * ------------------------------------------------------------
 * js/plugin-tarball.js 原先只为拿一个 sniffArchive 就 import
 * js/plugin-installer.js，而 installer 顶层 import 了
 * node:fs / node:path / node:crypto —— **静态 import 会把整条依赖链拉进
 * webview bundle**。扫「哪个文件写了 import node:」看不出这件事：
 * tarball 自己一个 node: 都没写，却照样加载不了。
 *
 * 这个文件里只有纯函数，不 import 任何东西，也不碰 Buffer / process。
 * 谁需要魔数嗅探或字节解码都从这里取，避免再出现「为了一个纯函数
 * 拖进一整条 Node 依赖链」。
 *
 * ⛔ isBytes 刻意不用 `instanceof Uint8Array`：在 vm 隔离环境里，
 *    外部 realm 传进来的字节数组 instanceof 会是 false。用鸭子类型 +
 *    ArrayBuffer.isView 的形状判定，跨 realm 才不会把合法输入误判成无效。
 */

/** 是否可当字节序列读（Uint8Array / Buffer / 跨 realm 的同类视图） */
export function isBytes(v) {
  if (!v || typeof v !== 'object') return false;
  if (typeof v.length !== 'number' || typeof v.subarray !== 'function') return false;
  if (typeof DataView !== 'undefined' && v instanceof DataView) return false;
  return v.length === 0 || typeof v[0] === 'number';
}

/** 拷一份独立字节，避免条目 content 与解压缓冲区共享内存 */
export function bytesCopy(b) {
  const out = new Uint8Array(b.length);
  out.set(b);
  return out;
}

/** 定长 ASCII 字段（tar 头里的八进制 size / checksum 全是 ASCII） */
export function asciiBytes(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] & 0xff);
  return s;
}

/** UTF-8 字段（文件名、PAX path）—— TextDecoder 是 Web 标准 */
export function utf8Bytes(b) {
  return new TextDecoder('utf-8').decode(b);
}

/**
 * 嗅探归档类型（只看魔数，不看扩展名 —— 扩展名是对方给的，不可信）
 * @param {Uint8Array|ArrayBufferView|null} buf
 * @returns {'gzip'|'zip'|null}
 */
export function sniffArchive(buf) {
  if (!isBytes(buf) || buf.length < 2) return null;
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  return null;
}
