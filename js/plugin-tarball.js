/**
 * .tar.gz → entries —— 安装链路上唯一缺失的一环
 * ============================================================================
 *
 * 为什么到现在才补它
 * ------------------------------------------------------------
 * js/plugin-installer.js 的文件头写着「解包成条目 → 调用方」，
 * 而 plugin-installer-test.mjs 从头到尾都是**手工构造 entries**：
 *
 *     installPlugin({ root, id, entries: goodEntries('demo','1.0.0') })
 *
 * 于是六个逻辑模块各自 80/83/57/29/76 项全绿，但整条链路是断的：
 * 远端下载下来的是 **.tar.gz 的字节流**，没人把它变成 entries。
 * 「每个模块都测过」不等于「它们串得起来」—— 这正是孤儿模块的
 * 典型失效形状：单看全是好的，接起来才发现中间少一段。
 *
 * 职责边界（严格不越界）
 * ------------------------------------------------------------
 * 本模块**只做格式解析**：gzip 解压 + USTAR 头解析 → {name, content, dir}。
 *
 * ⛔ 不做路径安全判断。条目名一律**原样保留**（包括 `../../evil`、
 *    绝对路径、软链），交给 plugin-installer.js 的 normalizeRelPath /
 *    safeJoin / extractEntries 去拦。这里若"顺手"过滤掉坏条目，
 *    就是静默丢弃 —— 用户看不到包里有过一次越界尝试，
 *    而 installer 那两条判据也永远没机会被验证。
 *
 * ⛔ 不引入第三方 tar 包。node_modules 是软链、会被环境清空，
 *    整树重装在本项目已反复失败。
 *
 * webview 可运行性（第 43 轮实测后改）
 * ------------------------------------------------------------
 * 只扫 `import node:*` 会漏掉两处同样致命的阻塞，本模块原先两处全占：
 *
 *   1. **Buffer 全局**：`Buffer.isBuffer` / `buf.toString('utf8',a,b)` /
 *      `Buffer.from` 都是 Node 专有，webview 里没有 Buffer。
 *      换成 Uint8Array + TextDecoder + 手写 ascii 解码；
 *      USTAR 的控制流、校验和判据、PAX/GNU 长名处理**一条没改**。
 *   2. **静态 import 链**：原先只为拿 sniffArchive 就 import
 *      plugin-installer.js，而它顶层 import node:fs/path/crypto。
 *      自己没写 node: 不代表能在 webview 加载 —— 整条链会被拖死。
 *      魔数嗅探已抽到 js/archive-magic.js（零依赖）。
 *
 * gzip 用 Web 标准 DecompressionStream（webview 与 Node 20 都有），
 * 它是异步流，所以 **unpackTarGz 返回 Promise**，调用方必须 await。
 * 解析仍是纯函数 parseTar(tar)，可以单独测、单独验。
 *
 * 只支持 .tar.gz。zip 明确报错，不降级、不猜测 ——
 * 「装不上，告诉你原因」优于「悄悄按另一种格式试」。
 */

import {
  sniffArchive, isBytes, asciiBytes, utf8Bytes, bytesCopy,
} from './archive-magic.js';

const BLOCK = 512;

/** USTAR 校验和：把 148..155 当成 8 个空格后，对整块求和 */
function checksumOk(head) {
  const stored = Number.parseInt(
    asciiBytes(head.subarray(148, 156)).replace(/\0/g, '').trim(), 8,
  );
  if (!Number.isFinite(stored)) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += (i >= 148 && i < 156) ? 32 : head[i];
  return sum === stored;
}

/** 读 NUL 结尾的定长字段 */
function zstr(buf, from, to) {
  return utf8Bytes(buf.subarray(from, to)).replace(/\0[\s\S]*$/, '');
}

/** 解析 PAX 扩展头里的 path= —— 只认 path，其它键值忽略 */
function paxPath(body) {
  const text = utf8Bytes(body);
  // 记录格式: "<长度> <key>=<value>\n"，长度含自身与换行
  const m = /(?:^|\n)\d+\s+path=([^\n]*)\n/.exec(text);
  return m ? m[1] : null;
}

/** gzip → 未压缩字节。DecompressionStream 是异步流，失败会抛 */
async function gunzipBytes(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 解析一个**未压缩**的 tar 字节序列（Uint8Array / Buffer 均可）。
 * 纯函数、零平台依赖 —— USTAR 逻辑与改造前逐条一致。
 *
 * @returns {{ok:boolean, entries:Array, skipped:Array, warnings:string[], error:string|null}}
 */
export function parseTar(tar) {
  const entries = [], skipped = [], warnings = [];
  if (!isBytes(tar) || tar.length < BLOCK) {
    return { ok: false, entries, skipped, warnings, error: 'tar 为空或不是字节序列' };
  }

  let off = 0;
  let longName = null;   // GNU 'L'：下一条的真实名字
  let nextPath = null;   // PAX 'x'：下一条的 path

  while (off + BLOCK <= tar.length) {
    const head = tar.subarray(off, off + BLOCK);
    if (head.every((b) => b === 0)) break;           // 两个全零块 = 结束

    if (!checksumOk(head)) {
      return { ok: false, entries, skipped, warnings,
        error: `tar 头校验和不匹配（偏移 ${off}），拒绝继续解析坏包` };
    }

    const rawName = zstr(head, 0, 100);
    const prefix = zstr(head, 345, 500);
    const sizeStr = asciiBytes(head.subarray(124, 136)).replace(/\0/g, '').trim();
    const size = Number.parseInt(sizeStr || '0', 8);
    const type = String.fromCharCode(head[156] || 0);

    if (!Number.isFinite(size) || size < 0 || off + BLOCK + size > tar.length) {
      return { ok: false, entries, skipped, warnings,
        error: `tar 条目 ${rawName} 的 size 非法或数据被截断` };
    }

    const body = tar.subarray(off + BLOCK, off + BLOCK + size);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    /* --- 元数据条目：只影响下一条的名字，本身不落盘 --- */
    if (type === 'L') { longName = utf8Bytes(body).replace(/\0[\s\S]*$/, ''); continue; }
    if (type === 'x' || type === 'g') {
      const p = paxPath(body);
      if (type === 'x' && p) nextPath = p;
      else if (type === 'g' && p) warnings.push(`忽略全局 PAX 扩展头 path=${p}`);
      continue;
    }

    if (type === '1' || type === '2' || type === '3' || type === '4'
        || type === '6' || type === '7' || type === 'K' || type === 'V') {
      skipped.push({ name: rawName, reason: `不支持的 tar 条目类型 '${type}'（链接/设备/卷标），跳过` });
      continue;
    }

    let name = prefix ? `${prefix}/${rawName}` : rawName;
    if (longName !== null) { name = longName; longName = null; }
    if (nextPath !== null) { name = nextPath; nextPath = null; }

    const isDir = type === '5' || name.endsWith('/');
    entries.push({
      name,
      dir: isDir,
      content: isDir ? undefined : bytesCopy(body),
    });
  }

  if (entries.length === 0) {
    return { ok: false, entries, skipped, warnings, error: 'tar 里没有任何条目' };
  }
  return { ok: true, entries, skipped, warnings, error: null };
}

/**
 * .tar.gz → entries（**async**：DecompressionStream 是异步流）。
 * 失败一律返回 {ok:false, error}，不抛 —— 网络来的字节流不可信，
 * 抛出去会让整个安装流程崩掉，而它本该只是「这个包装不上，告诉你原因」。
 */
export async function unpackTarGz(buf) {
  const kind = sniffArchive(buf);
  if (kind === 'zip') {
    return { ok: false, entries: [], skipped: [], warnings: [],
      error: '产物是 zip，本通道只支持 .tar.gz；未降级尝试' };
  }
  if (kind !== 'gzip') {
    return { ok: false, entries: [], skipped: [], warnings: [],
      error: '产物不是 .tar.gz（魔数不匹配），拒绝解析' };
  }
  let tar;
  try {
    tar = await gunzipBytes(buf);
  } catch (e) {
    return { ok: false, entries: [], skipped: [], warnings: [],
      error: `gzip 解压失败: ${String((e && e.message) || e)}` };
  }
  return parseTar(tar);
}
