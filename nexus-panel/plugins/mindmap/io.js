/**
 * 思维导图插件 · 文件导入导出与附件存储
 * ============================================================
 * 持久化策略（按需求）：「导入导出文件为主 + 实时缓存」。
 *   · 实时缓存由 store.js 负责（IndexedDB），本文件只管"显式落盘/读取"；
 *   · 落盘优先用 File System Access API（能弹真正的保存对话框、可覆盖原文件）；
 *     WebView2 若不支持则回退到 <a download>（由 WebView 决定保存位置）。
 */

import * as store from './store.js';

/* ------------------------------ 读取 ------------------------------ */

/** 弹出文件选择框，返回 File 或 null（取消） */
export function pickFile(accept = '') {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    if (accept) inp.accept = accept;
    inp.style.cssText = 'position:fixed;left:-9999px;';
    document.body.appendChild(inp);
    let done = false;
    const finish = (f) => {
      if (done) return;
      done = true;
      // 显式注销：匿名监听器只能等 inp 被丢弃后由 GC 连带回收，命名函数可以在这里摘干净
      inp.removeEventListener('change', onChange);
      inp.remove();
      resolve(f);
    };
    const onChange = () => finish(inp.files?.[0] || null);
    inp.addEventListener('change', onChange);
    // 部分 WebView 在窗口失焦时不派发 change，这里用 visibilitychange 兜底检测取消
    window.addEventListener('focus', function onFocus() {
      setTimeout(() => {
        if (!inp.files || !inp.files.length) finish(null);
      }, 400);
      window.removeEventListener('focus', onFocus);
    }, { once: true });
    inp.click();
  });
}

/**
 * 读取文本文件内容。
 * 不直接用 file.text()：它是较新的 Blob API，部分老 WebView2 / 测试环境下不存在，
 * 必须回退到 FileReader（实测 jsdom 的 File 就没有 .text）。
 */
export function readText(file) {
  if (typeof file.text === 'function') return file.text();
  if (typeof FileReader === 'undefined') {
    return Promise.reject(new Error('当前环境不支持读取文件（缺少 File.text / FileReader）'));
  }
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(fr.error || new Error('文件读取失败'));
    fr.readAsText(file);
  });
}

/** 读成字节（.xmind 是 zip，必须按二进制读） */
export function readBytes(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  if (typeof FileReader === 'undefined') {
    return Promise.reject(new Error('当前环境不支持读取文件（缺少 File.arrayBuffer / FileReader）'));
  }
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('文件读取失败'));
    fr.readAsArrayBuffer(file);
  });
}

/* --------------------- 附件：字节级读写（XMind 打包用） --------------------- */

/**
 * 按节点里存的引用串取出附件字节。
 * @param {string} refJson encodeRef 产出的 JSON 串
 * @returns {Promise<Uint8Array|null>} 附件丢失或引用不合法时返回 null
 */
export async function loadAssetBytes(refJson) {
  const r = decodeRef(refJson);
  if (!r?.a) return null;
  const rec = await store.get('asset:' + r.a, null);
  if (!rec?.blob) return null;
  try {
    // 走 readBytes：Blob.arrayBuffer 在部分环境缺失，那里已备好 FileReader 回退。
    // 直接调 blob.arrayBuffer() 会抛错并被吞成 null，导出时附件就静默丢了。
    return new Uint8Array(await readBytes(rec.blob));
  } catch {
    return null;
  }
}

/**
 * 把字节存为附件，返回可写进节点 data 的引用串。
 * @param {string} name 文件名
 * @param {Uint8Array} bytes
 * @returns {Promise<string|null>} 引用串；写入失败返回 null
 */
export async function saveAssetBytes(name, bytes) {
  try {
    const blob = new Blob([bytes]);
    const id = 'as' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    const ok = await store.set('asset:' + id, {
      name: name || '附件',
      size: bytes?.length || 0,
      type: blob.type || '',
      // 从 XMind 包里还原出来的字节没有原文件的修改时间，只有入库时间。
      // 两者都记，面板优先显示 mtime（这里与 addedAt 相同）。
      mtime: Date.now(),
      addedAt: Date.now(),
      blob,
    });
    return ok ? encodeRef({ n: name || '附件', a: id, s: bytes?.length || 0 }) : null;
  } catch {
    return null;
  }
}

/* ------------------------------ 保存 ------------------------------ */

/**
 * 保存文本/二进制到用户指定的位置。
 * @returns {'ok'|'cancel'|'fallback'|'error'}
 */
export async function saveBlob(filename, blob) {
  if (window.showSaveFilePicker) {
    try {
      const ext = (filename.split('.').pop() || '').toLowerCase();
      const types = ext ? [{ description: ext.toUpperCase() + ' 文件', accept: { [guessMime(ext)]: ['.' + ext] } }] : [];
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return 'ok';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancel';
      // 其他错误（如不支持的 accept）继续走回退
    }
  }
  return downloadBlob(filename, blob);
}

/** <a download> 回退：由 WebView 决定保存位置（通常会落到下载目录或弹另存为） */
export function downloadBlob(filename, blob) {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    return 'fallback';
  } catch {
    return 'error';
  }
}

export function saveText(filename, text, mime = 'text/plain;charset=utf-8') {
  return saveBlob(filename, new Blob([text], { type: mime }));
}

/** base64 dataUrl（PNG 导出用）→ Blob */
export function dataUrlToBlob(dataUrl) {
  const s = String(dataUrl || '');
  const comma = s.indexOf(',');
  // 不是合法 dataUrl（比如编辑器导出失败返回空串）时 indexOf 给 -1，
  // 后面 slice(0, -1) 会静默产出一段垃圾而不报错。这里显式拦掉。
  if (comma < 0) return new Blob([], { type: 'application/octet-stream' });
  const meta = s.slice(0, comma);
  const b64 = s.slice(comma + 1);
  const isBase64 = meta.indexOf(';base64') >= 0;
  const mime = (meta.match(/data:([^;]*)/) || [, 'application/octet-stream'])[1];
  if (!isBase64) return new Blob([decodeURIComponent(b64)], { type: mime });
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function guessMime(ext) {
  const map = {
    json: 'application/json',
    md: 'text/markdown',
    txt: 'text/plain',
    png: 'image/png',
    svg: 'image/svg+xml',
  };
  return map[ext] || 'application/octet-stream';
}

/** 带时间戳的默认文件名：脑图-20260912-1430.json */
/**
 * 文件名安全化：剔除路径非法字符（对齐 C# SanitizeFileName）。
 * 用于主题导出等「按内容命名」的场景（stampName 会带时间戳，不适合这类）。
 */
export function safeFileName(name) {
  let s = String(name || '').replace(/[\\/:*?"<>|]/g, '_').replace(/[\u0000-\u001f]/g, '_').trim();
  // 纯点号（'.' / '..'）在多数文件系统上指向目录本身，不能当落盘名用。
  // 附件名来自导入的 .xmind，是不可信输入。
  if (/^\.+$/.test(s)) s = '_' + s;
  return s || '未命名';
}

export function stampName(base, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${base}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

/* --------------------------- 附件 Blob 存储 --------------------------- */

/**
 * 原 C# 版附件存的是「本地文件路径」，文件被移动/重命名即失效。
 * Web 沙箱拿不到真实路径，这里改为把文件本体存进 IndexedDB，
 * 节点 data 里只记引用 { n:文件名, a:assetId, s:字节数 } —— 代价是导出文件不含附件内容。
 */
export async function putAsset(file) {
  const id = 'as' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
  const ok = await store.set('asset:' + id, {
    name: file.name,
    size: file.size,
    type: file.type || '',
    // 本机文件才有真实修改时间（File.lastModified）；
    // 从 XMind 导入还原出来的附件是新建 Blob，lastModified 会是「现在」，此时两者一致。
    mtime: Number(file.lastModified) || Date.now(),
    addedAt: Date.now(),
    blob: file,
  });
  return ok ? id : null;
}

/**
 * 把探测到的媒体元信息写回资产记录，避免每次打开面板都重新解析文件头。
 * 解析一次要读最多 4MB 并遍历 box 树，视频大了还得多等 video 元素出元数据。
 */
export async function saveAssetMeta(id, meta) {
  if (!id || !meta) return false;
  const rec = await store.get('asset:' + id, null);
  if (!rec) return false;
  rec.meta = meta;
  return await store.set('asset:' + id, rec);
}

/**
 * 读取资产记录。
 *
 * 默认会顺带建一个 Blob URL 挂在 `url` 上 —— 但绝大多数调用方只要元信息
 * （大小/类型/时间）或字节，用不到 URL，于是每处都得记得 revoke，漏一处就是泄漏。
 * 因此加 `wantUrl` 开关：要播放/预览才传 true，其余场景不建。
 *
 * @param {string} id
 * @param {boolean} [wantUrl=false] 是否需要可播放/可预览的 Blob URL
 */
export async function getAsset(id, wantUrl = false) {
  if (!id) return null;
  const rec = await store.get('asset:' + id, null);
  if (!rec) return null;
  const url = wantUrl && rec.blob ? URL.createObjectURL(rec.blob) : null;
  return { ...rec, url };
}

export async function dropAsset(id) {
  if (id) await store.del('asset:' + id);
}

/** 节点 data 里的附件引用序列化为字符串（kityminder 只存字符串值） */
export function encodeRef(ref) {
  return JSON.stringify(ref);
}

export function decodeRef(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;      // 已是对象（容错）
  try {
    return JSON.parse(raw);
  } catch {
    // 兼容 C# 版留下的纯路径字符串
    return { n: String(raw).split(/[\\/]/).pop() || String(raw), a: null, s: 0, legacyPath: String(raw) };
  }
}

export function formatSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
