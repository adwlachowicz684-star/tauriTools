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
/**
 * 选文件。multiple=true 时返回 File[]（A4 图标批量导入用；
 * C# 版是 OpenFileDialog 的 Multiselect）。
 * 取消时返回 null（单文件）或 []（多文件）。
 */
export function pickFile(accept = '', multiple = false) {
  return new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    if (accept) inp.accept = accept;
    if (multiple) inp.multiple = true;
    inp.style.cssText = 'position:fixed;left:-9999px;';
    document.body.appendChild(inp);
    let done = false;
    const finish = (f) => {
      if (done) return;
      done = true;
      inp.remove();
      resolve(f);
    };
    const take = () => {
      const files = inp.files ? [...inp.files] : [];
      if (!files.length) return multiple ? [] : null;
      return multiple ? files : files[0];
    };
    inp.addEventListener('change', () => finish(take()));
    // 部分 WebView 在窗口失焦时不派发 change，这里用 visibilitychange 兜底检测取消
    window.addEventListener('focus', function onFocus() {
      setTimeout(() => {
        if (!inp.files || !inp.files.length) finish(multiple ? [] : null);
      }, 400);
      window.removeEventListener('focus', onFocus);
    }, { once: true });
    inp.click();
  });
}

/** 多选文件（批量导入图标用） */
export function pickFiles(accept = '') {
  return pickFile(accept, true);
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

/**
 * A38 SVG → 高分辨率 PNG。
 *
 * 内核自带的 `exportData('png')` 拿的是 SVG 的**自然尺寸**，
 * 传更大的 width/height 只是在四周补白（源码里是 `drawImage(img, x, y,
 * a.width, a.height)` —— 没有缩放），并不是真正的高分辨率。
 *
 * 真正的高分辨率必须**重设 SVG 的宽高但保留 viewBox**：SVG 是矢量，
 * viewBox 不变的前提下把 width/height 放大 N 倍，光栅化出来就是 N 倍
 * 像素密度，文字与连线都不会糊。
 *
 * @param {string} svgText 内核 exportData('svg') 的结果
 * @param {number} [scale=1] 倍数，1/2/3
 * @returns {Promise<Blob|null>}
 */
/**
 * A38 目标像素尺寸（纯函数，可单测）。
 *
 * 倍率必须钳到 [1,8]：
 * - 低于 1 会产出 0 像素的图；
 * - 不设上限的话，一个 800×600 的图配 100 倍就是 80000×60000 像素，
 *   canvas 按 4 字节/像素算是 19 GB —— 浏览器直接崩，而不是「慢一点」。
 *
 * @returns {{W:number,H:number,s:number}|null} 宽高无效时返回 null
 */
export function pngScaleDims(w, h, scale) {
  const W0 = parseFloat(w);
  const H0 = parseFloat(h);
  if (!(W0 > 0) || !(H0 > 0)) return null;
  const s = Math.max(1, Math.min(8, Number(scale) || 1));
  return { W: Math.round(W0 * s), H: Math.round(H0 * s), s };
}

/**
 * A38 把 SVG 文本放大到目标倍率，返回新的 SVG 文本（纯 DOM 操作，可单测）。
 *
 * 关键：**只改 width/height，viewBox 保持不动**。SVG 是矢量，viewBox 不变
 * 的前提下放大 width/height，光栅化出来的就是更高的**像素密度**；
 * 若连 viewBox 一起改，就变成把同一张小图铺到大画布上 —— 图还是糊的，
 * 只是四周多了空白，这正是内核自带 png 导出的做法。
 *
 * @returns {string|null} 无法解析或宽高无效时返回 null
 */
export function scaleSvgText(svgText, scale = 1) {
  const text = String(svgText || '');
  if (!text) return null;

  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  } catch {
    return null;
  }
  if (!doc || doc.querySelector('parsererror')) return null;
  const svg = doc.querySelector('svg');
  if (!svg) return null;

  const dims = pngScaleDims(svg.getAttribute('width'), svg.getAttribute('height'), scale);
  if (!dims) return null;

  svg.setAttribute('width', String(dims.W));
  svg.setAttribute('height', String(dims.H));
  // xmlns 必须显式补上：DOMParser 出来的 svg 序列化后可能不带，
  // 没有命名空间浏览器会拒绝把它当图片加载（且只报笼统的 load 失败）
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');

  try {
    return new XMLSerializer().serializeToString(svg);
  } catch {
    return null;
  }
}

export async function svgToPngBlob(svgText, scale = 1) {
  const svgSrc = String(svgText || '');
  if (!svgSrc) return null;

  const doc0 = new DOMParser().parseFromString(svgSrc, 'image/svg+xml');
  const svg0 = doc0.querySelector('svg');
  if (!svg0 || doc0.querySelector('parsererror')) return null;
  const dims = pngScaleDims(svg0.getAttribute('width'), svg0.getAttribute('height'), scale);
  if (!dims) return null;

  const xml = scaleSvgText(svgSrc, scale);
  if (!xml) return null;
  const { W, H } = dims;

  // 先铺背景色：SVG 上的 style="background:…" 在 canvas 里**不保证**渲染，
  // 漏了会得到一张透明底的图 —— 放到深色文档里看就是「图没了」
  const bg = /background:\s*([^;]+)/.exec(svg0.getAttribute('style') || '');
  const bgColor = bg ? bg[1].trim() : '';

  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('SVG 光栅化失败'));
      img.src = url;
    });

    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    if (bgColor && bgColor !== 'transparent' && bgColor !== 'none') {
      ctx.fillStyle = bgColor;
      ctx.fillRect(0, 0, W, H);
    }

    ctx.drawImage(img, 0, 0, W, H);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    // 无论成败都要收：Blob URL 不 revoke 会一直占着内存
    URL.revokeObjectURL(url);
  }
}

/* --------------------------- 打印 / PDF --------------------------- */

/**
 * 打印 / PDF 的页面样式（纯函数，可测）。
 *
 * 【这不是从 WPF 移植的功能】
 * WPF 原版**没有打印能力** —— 全仓搜 `Print` 零命中（唯一的 `PrintWindow`
 * 是 `ScreenCaptureService` 里截窗口的 Windows API，与文档打印无关）。
 * 清单里 A34–A37 / A41 / B29 六项出处全写着「未定位到确切行号」，
 * 实际是未经核实的推测。这里是作为 **Web 版新增能力**实现的。
 *
 * 走 `window.print()` 而非 Tauri Rust 命令，理由：
 *   1. 浏览器的打印对话框**自带预览**（覆盖打印预览需求）；
 *   2. 目标里通常有「另存为 PDF」（覆盖 PDF 导出需求）；
 *   3. 不需要写 Rust，风险与维护成本都低得多。
 * 代价是无法「静默导出 PDF」，必须由用户在对话框里确认。
 *
 * @param {object} [o]
 * @param {boolean} [o.landscape=false] true=A4 横向（脑图通常更宽，横向更合适）
 * @param {number} [o.margin=10] 页边距（毫米）
 * @returns {string} CSS 文本
 */
export function printPageCss(o = {}) {
  const landscape = !!o.landscape;
  const raw = Number(o.margin);
  // 非法值（负数 / NaN）退回默认 —— 负页边距会让内容被裁掉且没有提示
  const margin = Number.isFinite(raw) && raw >= 0 ? raw : 10;
  return `@page { size: A4 ${landscape ? 'landscape' : 'portrait'}; margin: ${margin}mm; }`;
}

/**
 * 打印时用于「只显示待打印内容」的样式（纯函数，可测）。
 *
 * 两段缺一不可：
 *
 * 1. `print-color-adjust: exact` —— 浏览器打印默认**丢弃背景**，
 *    深色画布会印成一张白纸，节点底色全没了。这条是打印能看的**前提**。
 * 2. 隐藏其它兄弟节点 —— 否则会把整个面板（侧栏、工具栏、页签）
 *    一起印上去。用 `body > *` 选兄弟而非给每个元素加类，
 *    将来新增顶层元素不用记得同步。
 *
 * @param {string} sel 打印根容器的选择器
 */
export function printHideCss(sel = '.mm-print-root') {
  return [
    '@media print {',
    `  body > *:not(${sel}) { display: none !important; }`,
    `  ${sel} { display: block !important; position: static !important; }`,
    // 背景色必须保留（深色主题否则印成白纸）
    '  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }',
    '}',
  ].join('\n');
}

/**
 * 把 SVG 处理成适合打印的形态（纯函数，可测）。
 *
 * 关键：**只去掉固定宽高，viewBox 保持不动**。SVG 是矢量，交给 CSS 用
 * `width:100%; height:auto` 让它按纸张宽度等比缩放；若把 viewBox 一起改，
 * 就变成拉伸变形或留大片空白。
 *
 * 同时补 `preserveAspectRatio` —— 不同浏览器对「只有 viewBox 没有宽高」
 * 的 SVG 默认行为不一致，显式指定才稳定。
 *
 * @returns {string} 处理后的 SVG 文本；解析失败原样返回（打印总比报错好）
 */
export function fitSvgForPrint(svgText) {
  const text = String(svgText || '');
  if (!text) return text;
  try {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (!doc || doc.querySelector('parsererror')) return text;
    const svg = doc.querySelector('svg');
    if (!svg) return text;

    // 宽高交给 CSS 控制（去掉内联的像素宽高，否则会溢出纸张）
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.setAttribute('class', 'mm-print-svg');
    return new XMLSerializer().serializeToString(svg);
  } catch {
    // 解析不了就用原样 —— 打印出来总好过抛异常
    return text;
  }
}

/**
 * 打印 SVG（当前画布）。
 *
 * @param {string} svgText 完整画布的 SVG（必须是 exportSvg() 的全图，
 *                         不是可视视口 —— 视口截图印出来只有一角）
 * @param {object} [opts]
 * @param {boolean} [opts.landscape]
 * @param {number} [opts.margin]
 * @param {string} [opts.title] 打印时页眉显示的标题
 * @param {Function} [opts.print] 自定义触发打印的函数（走 Tauri Rust 命令）。
 *                                返回 `true` = 已发起；返回 `false` = 该路径不可用，
 *                                本函数会自动回退到 `window.print()`。
 *                                这么设计是为了让 io 层不引入 Tauri 依赖 ——
 *                                路径选择交给调用方，io 只负责准备打印视图。
 * @returns {Promise<boolean>} 是否真的发起了打印
 */
export async function printSvg(svgText, opts = {}) {
  const text = String(svgText || '');
  if (!text) return false;
  // jsdom / 无打印能力的环境要安静地失败，不能抛
  if (typeof document === 'undefined') return false;

  const style = document.createElement('style');
  style.textContent = [
    printPageCss(opts),
    printHideCss('.mm-print-root'),
    '.mm-print-root { display: none; }',
    '.mm-print-svg { width: 100%; height: auto; display: block; }',
  ].join('\n');

  const host = document.createElement('div');
  host.className = 'mm-print-root';
  // 用 textContent 塞进一个预容器再取 innerHTML：
  // 直接 innerHTML = svgText 也可行，但先过一次解析器能过滤掉畸形标记
  host.innerHTML = fitSvgForPrint(text);

  document.head.appendChild(style);
  document.body.appendChild(host);

  // 打印时临时改标题：多数浏览器把它用作 PDF 文件名与页眉，
  // 不改的话导出的 PDF 会叫「页面标题」这种无意义的名字
  const prevTitle = document.title;
  if (opts.title) document.title = String(opts.title);

  let timer = null;
  const cleanup = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    style.remove();
    host.remove();
    if (opts.title) document.title = prevTitle;
    if (typeof window !== 'undefined') window.removeEventListener('afterprint', cleanup);
  };

  /**
   * 触发打印：优先用调用方给的路径（Tauri Rust 命令），
   * 它返回 false 表示不可用（非 macOS / 不在 Tauri 环境 / 命令未注册），
   * 此时回退 window.print()。
   */
  let ok = false;
  if (opts.print) {
    try {
      ok = (await opts.print()) === true;
    } catch {
      ok = false;   // 路径不可用（如不在 Tauri 环境），继续回退
    }
  }
  if (!ok && typeof window !== 'undefined' && typeof window.print === 'function') {
    try {
      window.print();
      ok = true;
    } catch {
      // 某些宿主提供了 window.print 但调用即抛（无打印后端）。
      // 必须转成 false 而不是让异常冒出去：调用方据此提示「当前环境不支持」，
      // 冒泡上去只会变成一个看不懂的 unhandled rejection。
      ok = false;
    }
  }

  if (!ok) {
    // 没发起成功就立刻收：留着一个隐藏的打印容器在 DOM 里毫无意义
    cleanup();
    return false;
  }

  // 不能立刻清理：print() 在某些浏览器是同步阻塞、在另一些是异步的，
  // 同步移除会让对话框还没渲染内容就没了。用 afterprint + 定时器双保险。
  if (typeof window !== 'undefined') window.addEventListener('afterprint', cleanup);
  timer = setTimeout(cleanup, 60 * 1000);
  // Node/测试环境里 unref，否则这个 60 秒的兜底定时器会吊住进程不退出。
  // 浏览器端没有 unref，条件调用即可，不影响打印本身。
  if (typeof timer?.unref === 'function') timer.unref();
  return true;
}

/* --------------------------- SVG → PDF（矢量） --------------------------- */

/**
 * 取 SVG 的固有尺寸（纯函数，可测）。
 *
 * 先看 width/height 属性，取不到再看 viewBox ——
 * 只认 width/height 会在「只有 viewBox」的 SVG 上拿不到尺寸，
 * 而 kityminder 两种都可能给出。
 *
 * @returns {{w:number, h:number}} 取不到时返回 {0,0}（调用方据此回退）
 */
export function svgSize(svgText) {
  const text = String(svgText || '');
  if (!text) return { w: 0, h: 0 };
  try {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (!doc || doc.querySelector('parsererror')) return { w: 0, h: 0 };
    const svg = doc.querySelector('svg');
    if (!svg) return { w: 0, h: 0 };

    const num = (v) => {
      const n = parseFloat(v);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };
    let w = num(svg.getAttribute('width'));
    let h = num(svg.getAttribute('height'));
    if (w && h) return { w, h };

    const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb.every(Number.isFinite)) {
      // viewBox 的 x/y 是原点偏移，尺寸只看后两位
      if (!w) w = vb[2] > 0 ? vb[2] : 0;
      if (!h) h = vb[3] > 0 ? vb[3] : 0;
    }
    return { w, h };
  } catch {
    return { w: 0, h: 0 };
  }
}

/**
 * 算 SVG → PDF 的 dpi（纯函数，可测）。
 *
 * svg2pdf 用 dpi 把 SVG 像素换算成 PDF 点（1pt = 1/72 inch）：
 *     pdfPt = px * 72 / dpi
 *
 * 所以「缩放到目标尺寸」对应的 dpi 是 `72 / scale`。
 *
 * **取 min(宽比, 高比)** 而不是只管宽度：脑图常常又宽又扁，
 * 只按宽度适配的话高度可能溢出纸面，svg2pdf 生成的是**单页**，
 * 溢出不会自动分页而是把页面撑大，打印时仍会被缩放 —— 等于白算。
 *
 * **只缩不放**（scale ≤ 1）：小图放大不会多出任何信息，
 * 而缩小的目的是不裁切。
 *
 * @param {string} svgText
 * @param {object} [o]
 * @param {boolean} [o.landscape=false]
 * @param {number} [o.margin=10] 页边距（毫米）
 * @returns {number} dpi；拿不到尺寸时返回 72（svg2pdf 默认值，不缩放）
 */
export function pdfDpi(svgText, o = {}) {
  const { w, h } = svgSize(svgText);
  if (!w || !h) return 72;

  const raw = Number(o.margin);
  const margin = Number.isFinite(raw) && raw >= 0 ? raw : 10;
  const MM = 72 / 25.4;                       // 1mm = 2.8346pt
  // A4：210×297mm；横向时宽高互换
  const pw = (o.landscape ? 297 : 210) - margin * 2;
  const ph = (o.landscape ? 210 : 297) - margin * 2;
  if (pw <= 0 || ph <= 0) return 72;

  const scale = Math.min((pw * MM) / w, (ph * MM) / h, 1);
  if (!Number.isFinite(scale) || scale <= 0) return 72;
  return 72 / scale;
}

/**
 * base64 → Blob（纯函数式，便于测试时替换）。
 *
 * 不直接 `fetch('data:...')` 的原因：data: URL 长度在部分浏览器有限制，
 * 而 PDF 动辄几 MB，超了会静默失败（拿回一个空 blob）。
 * 手动解码走 Uint8Array 没有这个上限。
 */
export function base64ToBlob(b64, type = 'application/pdf') {
  const raw = String(b64 || '');
  if (!raw) return null;
  try {
    const bin = atob(raw);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type });
  } catch {
    return null;
  }
}

/**
 * 拖放文件归类（纯函数，可测）。
 *
 * @returns {'image'|'video'|'file'}
 *   - image → 内联进节点的 `image` 字段（dataURL，导出的 .xmind 自带图片）
 *   - video → 资产引用 `video`
 *   - file  → 资产引用 `file`
 *
 * **不能只看 MIME**：部分环境（某些文件管理器、跨平台拖拽、老浏览器）拖进来的
 * `File.type` 是空串，只看 type 会把 .png 当成"其它文件"存进资产库，
 * 结果画布上不显示图片、只多一个文件图标。所以 type 为空时按扩展名兜底。
 *
 * 反过来也成立：有些环境把 .mkv 标成 `video/x-matroska`（能认），
 * 但也有标成 `application/octet-stream` 的，同样要靠扩展名。
 */
const EXT_IMAGE = /\.(png|jpe?g|gif|bmp|webp|svg|ico|avif)$/i;
const EXT_VIDEO = /\.(mp4|webm|og[gv]|mov|m4v|avi|mkv|flv)$/i;

export function classifyFile(name, type) {
  const t = String(type || '').toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  // type 为空或太笼统（octet-stream）时按扩展名兜底
  if (t && t !== 'application/octet-stream') return 'file';
  const n = String(name || '').toLowerCase();
  if (EXT_IMAGE.test(n)) return 'image';
  if (EXT_VIDEO.test(n)) return 'video';
  return 'file';
}

/** 拖放/附加时给新节点起的名字：文件名去掉扩展名 */
export function stemOf(name, fallback = '附件') {
  const s = String(name ?? '').trim().split(/[\\/]/).pop() || '';
  const stem = s.replace(/\.[^.]*$/, '').trim();
  return stem || fallback;
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

/**
 * 从路径里取所在目录（A17）。
 *
 * 只用于 C# 版遗留的纯路径引用 —— 新附件存在 IndexedDB 里，没有文件系统
 * 路径可谈。取不到目录时返回空串而不是 '—'：调用方要据此决定整行要不要显示
 * （显示一个全是破折号的行没有意义）。
 *
 * 分隔符同时兼容 \ 与 /：老路径来自 Windows，但也可能由 JSON 转义过。
 */
export function dirOf(path) {
  const p = String(path || '').replace(/\\/g, '/');
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : '';
}

export function formatSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
