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

/* --------------------- 图片内联：压缩与体积上限 --------------------- */

/**
 * 脑图把图片以 **dataURL 内联进节点数据**（图片不走 IndexedDB，只有视频/文件走），
 * 于是每张图的体积 1:1 进文档，base64 还要再膨胀 4/3。一张手机原图 4MB →
 * 内联后 5.3MB 字符，代价是三重的：
 *   · B1 撤销栈存的是**整份 JSON 快照**，改一个字就要复制一遍这 5MB；
 *   · 节点渲染要把整串塞进 SVG `<image>`，每次重排都要过一遍；
 *   · 自动落盘 / 导出 .xmind 反复序列化。
 * 实测用户那张 2.1MB 的 JPEG（内联 2.8MB 字符）在点开预览时有肉眼可见的卡顿。
 *
 * 策略：**先压缩到阈值内再内联；压不进去就拒绝**（并说明原因），
 * 而不是像旧版那样只提示一句「超过 2MB」，然后把 2.8MB 原样塞进去 ——
 * 提示了但没拦，用户只会觉得"这软件一放图就变卡"。
 *
 * 阈值单位注意：IMG_INLINE_MAX 是 **dataURL 字符数**（进文档的就是它）；
 * IMG_SOURCE_MAX / ASSET_MAX 是**原文件字节数**（判断要不要解码/入库）。
 */
export const IMG_MAX_EDGE = 1600;                       // 压缩后最长边：脑图里图片是横幅，1600 足够清晰
export const IMG_QUALITY_STEPS = [0.82, 0.72, 0.62];    // 同尺寸下依次降质
export const IMG_FALLBACK_EDGES = [1024, 800, 640];     // 质量降到底仍超阈值时，再降分辨率
export const IMG_INLINE_MAX = 1.2 * 1024 * 1024;        // 单张内联上限（dataURL 字符数）
export const IMG_SOURCE_MAX = 24 * 1024 * 1024;         // 原文件上限，超了**不解码**（解码本身要几百 MB 内存）
/**
 * 低于这个体积**原样内联、不进压缩流水线**。
 *
 * 实测（3000×2000 与 400×300 各一组，见 .workbuddy/memory 的 09-19 实测表）：
 * 小图重编码是**负优化** —— 400×300 / 6KB 的图压完变 7KB（重编码本身的量化损失），
 * 画质掉了、体积还涨了。而 300KB 以内的图哪怕一点不压，对文档体积也无感。
 * 上界同时要保证 base64 后仍在内联上限内（÷3×4 再留点富余），
 * 否则"跳过压缩"会产出超限文档 —— 这个不变式由测试锁住。
 */
export const IMG_SKIP_BELOW = 300 * 1024;
export const ASSET_MAX = 100 * 1024 * 1024;             // 视频/文件附件上限（字节）

/**
 * 等比缩放到最长边 ≤ maxEdge（纯函数，可单测）。
 *
 * 只缩不放：本来就在阈值内的图，放大只会白增体积、画质不会更好。
 * 返回整数像素，最小 1 —— 极端长条图（如 4000×3）缩完高度会算成 0，
 * canvas 尺寸为 0 会直接抛异常。
 */
export function fitImageDims(w, h, maxEdge = IMG_MAX_EDGE) {
  const W = Math.floor(Number(w) || 0);
  const H = Math.floor(Number(h) || 0);
  if (!(W > 0) || !(H > 0)) return null;
  const edge = Math.max(1, Math.floor(Number(maxEdge) || IMG_MAX_EDGE));
  const scale = Math.min(1, edge / Math.max(W, H));
  return {
    w: Math.max(1, Math.round(W * scale)),
    h: Math.max(1, Math.round(H * scale)),
    scale,
  };
}

/**
 * 编码尝试序列（纯函数，可单测）：先降质，再降分辨率。
 *
 * 顺序不能反 —— 降分辨率对观感的伤害比降质大得多（JPEG q0.62 在 1600px 上
 * 基本看不出差别，而 800px 放到全屏一眼就糊），所以质量档必须先用满。
 *
 * @param {number} maxEdge 首次尝试的最长边
 * @param {boolean} lossless 无损（PNG）时质量参数被忽略，只保留分辨率档
 */
export function encodePlan(maxEdge = IMG_MAX_EDGE, lossless = false) {
  const edge = Math.max(1, Math.floor(Number(maxEdge) || IMG_MAX_EDGE));
  const plan = lossless
    ? [{ maxEdge: edge, q: undefined }]
    : IMG_QUALITY_STEPS.map((q) => ({ maxEdge: edge, q }));
  // 降分辨率的每一档只配最低质量：此时体积已是硬约束，再在同分辨率上试中档纯属浪费一次编码
  const q = IMG_QUALITY_STEPS[IMG_QUALITY_STEPS.length - 1];
  for (const e of IMG_FALLBACK_EDGES) {
    if (e < edge) plan.push({ maxEdge: e, q: lossless ? undefined : q });
  }
  return plan;
}

/** 视频/文件附件是否超上限（调用方先判断，好给出「哪个文件、多大」的提示） */
export function overAssetLimit(file) {
  return (Number(file?.size) || 0) > ASSET_MAX;
}

/** File → dataURL。读失败返回 null（调用方按"跳过这一张"处理） */
function readDataURL(file) {
  return new Promise((res) => {
    try {
      const fr = new FileReader();
      fr.onload = () => res(String(fr.result));
      fr.onerror = () => res(null);
      fr.readAsDataURL(file);
    } catch { res(null); }
  });
}

/**
 * 解码成可绘制对象。
 * 优先 `createImageBitmap`（不建 DOM、不占一份 objectURL，且后续 drawImage 更快）；
 * 老 WebView 没有它，退回 `<img>`。
 * 返回 { width, height, src, bitmap?, url? } —— 调用方负责释放（bitmap.close / revokeObjectURL）。
 */
async function decodeImage(file) {
  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(file);
      if (bmp && bmp.width && bmp.height) {
        return { width: bmp.width, height: bmp.height, src: bmp, bitmap: bmp };
      }
    }
  } catch { /* 落到 <img> 兜底 */ }
  return new Promise((res) => {
    let url = '';
    let done = false;
    const fin = (v) => { if (done) return; done = true; res(v); };
    try {
      url = URL.createObjectURL(file);
      const img = new Image();
      // 8 秒超时：损坏的图（扩展名与实际格式不符等）偶尔既不 load 也不 error，
      // 没有超时的话整批拖放会卡死在这一张上 —— 视频首帧缩略图踩过同一个坑。
      setTimeout(() => {
        try { URL.revokeObjectURL(url); } catch { /* 已释放 */ }
        fin(null);
      }, 8000);
      img.onload = () => {
        if (!img.naturalWidth || !img.naturalHeight) {
          try { URL.revokeObjectURL(url); } catch { /* 已释放 */ }
          fin(null);
          return;
        }
        fin({ width: img.naturalWidth, height: img.naturalHeight, src: img, url });
      };
      img.onerror = () => {
        try { URL.revokeObjectURL(url); } catch { /* 已释放 */ }
        fin(null);
      };
      img.src = url;
    } catch { fin(null); }
  });
}

/**
 * 采样判断是否含透明像素 —— 只为决定编码格式。
 *
 * PNG 带 alpha 的图转 JPEG，透明区会被**填黑**（不是变白），看上去就是图坏了；
 * 反过来给不透明的图用 PNG，体积白白大一截。
 * 抽样 64×64 足够：有透明区的图几乎不会只在 4 个像素里透明。
 * 取不到像素时按"不透明"处理 —— JPEG 更小，是更安全的兜底。
 */
function hasAlphaPixels(src) {
  try {
    const c = document.createElement('canvas');
    c.width = 64; c.height = 64;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (!g) return false;
    g.drawImage(src, 0, 0, 64, 64);
    const d = g.getImageData(0, 0, 64, 64).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true;
    return false;
  } catch { return false; }
}

/** 按档位绘制并编码；失败返回 null（不抛 —— 调用方在循环里） */
function encodeCanvas(src, dims, mime, q) {
  try {
    const c = document.createElement('canvas');
    c.width = dims.w;
    c.height = dims.h;
    const g = c.getContext('2d');
    if (!g) return null;
    // 缩小时默认的低质量插值会有明显锯齿，脑图里图片一旦放大看就露出来
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    // JPEG 没有 alpha 通道，半透明像素会被合成到**黑底**上 —— 先铺白底
    if (mime === 'image/jpeg') {
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
    }
    g.drawImage(src, 0, 0, c.width, c.height);
    return mime === 'image/jpeg' ? c.toDataURL(mime, q) : c.toDataURL(mime);
  } catch { return null; }
}

/**
 * 图片文件 → 可内联的 dataURL（压缩 + 体积上限的唯一入口）。
 *
 * 返回成功：{ url, w, h, before, after, scaled, alpha }
 * 返回失败：{ error } —— 中文原因，调用方直接展示给用户。
 *
 * **绝不抛异常**：调用方在拖放循环里，一张坏图不能挡住整批附件。
 */
export async function imageToInline(file, opt = {}) {
  if (!file) return { error: '文件为空' };
  const name = String(file.name || '图片');
  const size = Number(file.size) || 0;
  const maxInline = Number(opt.maxInline) > 0 ? Number(opt.maxInline) : IMG_INLINE_MAX;
  const maxSource = Number(opt.maxSource) > 0 ? Number(opt.maxSource) : IMG_SOURCE_MAX;
  const maxEdge = Number(opt.maxEdge) > 0 ? Number(opt.maxEdge) : IMG_MAX_EDGE;
  // skipBelow 传 0 = 任何体积都进压缩流水线。存量瘦身必须这样：
  // 调用它的前提就是"这张图已经过大"，直通等于什么都不做。
  const skipBelow = opt.skipBelow === undefined
    ? IMG_SKIP_BELOW
    : Math.max(0, Number(opt.skipBelow) || 0);

  if (size > maxSource) {
    return { error: `「${name}」${formatSize(size)} 超过单张上限 ${formatSize(maxSource)}，未添加` };
  }

  const type = String(file.type || '').toLowerCase();
  const extM = /\.([^.]+)$/.exec(name);
  const ext = extM ? extM[1].toLowerCase() : '';

  // SVG 是文本，体积天然小，且 canvas 画不了（尺寸可能只写在 viewBox 里）；直接内联
  if (type === 'image/svg+xml' || ext === 'svg') {
    const url = await readDataURL(file);
    if (!url) return { error: `「${name}」读取失败` };
    if (url.length > maxInline) {
      return { error: `「${name}」矢量图 ${formatSize(url.length)} 超过内联上限 ${formatSize(maxInline)}，未添加` };
    }
    return { url, w: 0, h: 0, before: size, after: url.length, scaled: false, alpha: true };
  }

  // GIF：过 canvas 只会留下**第一帧**，那是静默丢数据，比拒绝更糟。
  // 小动图（本来就在阈值内）原样收下；超了就明说压缩不了，让用户自己决定。
  if (type === 'image/gif' || ext === 'gif') {
    const url = await readDataURL(file);
    if (!url) return { error: `「${name}」读取失败` };
    if (url.length <= maxInline) {
      return { url, w: 0, h: 0, before: size, after: url.length, scaled: false, alpha: true };
    }
    return { error: `「${name}」是动图（${formatSize(size)}），压缩会丢掉动画，未添加` };
  }

  // 小图直通：压缩收益只有几十 KB，却要付出一次重编码的画质损失
  // （PNG 截图转 JPEG 的文字振铃尤其明显），实测还会**变大**
  if (size <= skipBelow) {
    const raw = await readDataURL(file);
    if (raw && raw.length <= maxInline) {
      return { url: raw, w: 0, h: 0, before: size, after: raw.length, scaled: false, alpha: false, skipped: true };
    }
    // 读失败或（极端情况下）超上限 → 落到下面的压缩流水线
  }

  const dec = await decodeImage(file);
  if (!dec) return { error: `「${name}」无法解码（可能不是图片或文件已损坏）` };

  try {
    const alpha = hasAlphaPixels(dec.src);
    const mime = alpha ? 'image/png' : 'image/jpeg';
    let best = null;

    for (const step of encodePlan(maxEdge, alpha)) {
      const dims = fitImageDims(dec.width, dec.height, step.maxEdge);
      if (!dims) break;
      const url = encodeCanvas(dec.src, dims, mime, step.q);
      if (!url) continue;
      best = { url, dims };
      if (url.length <= maxInline) {
        return {
          url,
          w: dims.w,
          h: dims.h,
          before: size,
          after: url.length,
          scaled: dims.scale < 1,
          alpha,
        };
      }
    }

    // 走到这里说明所有档位都压不进阈值。**要把实测的最小值说出来** ——
    // 只说"失败"用户无从判断该把图裁多小
    const got = best ? `（已压到 ${formatSize(best.url.length)}）` : '';
    return { error: `「${name}」压缩后仍超过内联上限 ${formatSize(maxInline)}${got}，未添加` };
  } finally {
    // 必须释放：一次拖 20 张图，不释放会把解码后的整张位图全留在内存里
    try { dec.bitmap?.close?.(); } catch { /* 已关闭 */ }
    try { if (dec.url) URL.revokeObjectURL(dec.url); } catch { /* 已释放 */ }
  }
}

/**
 * 把**已经内联在文档里**的 dataURL 重新压一遍（存量过大图片瘦身）。
 *
 * 为什么要单独一个入口：压缩是这一版新加的，老文档里已经躺着过去塞进去的
 * 2.8MB 字符内联图 —— 它们不会因为"以后新增会自动压缩"而变小，
 * 得有一个显式动作去清。实测用户那张 2.1MB 的 JPEG 就是这么躺在那儿的。
 *
 * 与新增路径的差别：**不设直通线**（skipBelow: 0）。
 * 调用它的前提就是"这张图超了阈值"，直通等于什么都不做；
 * 而且这里的 size 是解码后的字节数，与 dataURL 字符数不是一回事。
 */
export async function shrinkDataUrl(dataUrl, opt = {}) {
  const blob = dataUrlToBlob(dataUrl);
  if (!blob || !blob.size) return { error: '图片数据已损坏，无法压缩' };
  const type = blob.type || 'image/png';
  const ext = type === 'image/png' ? 'png' : 'jpg';
  let f;
  try {
    f = new File([blob], 'inline.' + ext, { type });
  } catch {
    return { error: '当前环境不支持重新压缩图片' };
  }
  return imageToInline(f, { ...opt, skipBelow: 0 });
}

/* --------------------------- 附件 Blob 存储 --------------------------- */

/**
 * 原 C# 版附件存的是「本地文件路径」，文件被移动/重命名即失效。
 * Web 沙箱拿不到真实路径，这里改为把文件本体存进 IndexedDB，
 * 节点 data 里只记引用 { n:文件名, a:assetId, s:字节数 } —— 代价是导出文件不含附件内容。
 */
export async function putAsset(file) {
  // 上限硬拦一道。附件本体在 IndexedDB、不进节点数据，但**导出 .xmind 会连字节一起打包**，
  // 单个几百 MB 的视频会让导出直接失败（还是在整个流程最后一步才失败）。
  // 调用方一般已先用 overAssetLimit 提示过，这里只是不让它漏进来。
  if (overAssetLimit(file)) return null;
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

/**
 * 附件**列表**序列化（多附件用）。
 *
 * 单个节点可挂多个文件 / 多个视频 / 多张图片，所以 data 里存的是 **JSON 数组串**。
 *
 * 兼容策略：**写一定是数组，读两者都认**。
 * 老数据（C# 版迁移、旧 Web 版）的 `file`/`video` 是单个对象串或纯路径串，
 * 读取时包成单元素数组 —— 这样画布、侧栏、xmind 导出三条路径都不用分支。
 */
export function encodeRefList(list) {
  const arr = Array.isArray(list) ? list : (list ? [list] : []);
  return JSON.stringify(arr.filter(Boolean));
}

/**
 * 解析附件列表。
 * @returns {Array} 元素为 ref 对象；空/无效返回 []
 */
export function decodeRefList(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(normOne).filter(Boolean);
  let v = raw;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t) return [];
    // 只有数组串才按数组走；单个对象串/纯路径串走单值分支
    if (t[0] === '[') {
      try {
        const p = JSON.parse(t);
        if (Array.isArray(p)) return p.map(normOne).filter(Boolean);
      } catch { /* 解析失败，退回单值 */ }
    }
  }
  const one = normOne(v);
  return one ? [one] : [];
}

/** 归一化单个元素：对象直接用，字符串走 decodeRef（含纯路径兜底） */
function normOne(x) {
  if (!x) return null;
  if (typeof x === 'object') return x;
  const s = String(x).trim();
  if (!s) return null;
  // 元素本身也可能是 JSON 串（数组里存了序列化后的 ref）
  if (s[0] === '{') {
    try { const o = JSON.parse(s); if (o && typeof o === 'object') return o; } catch { /* 退回路径 */ }
  }
  return decodeRef(s);
}

/**
 * 往列表里追加一个引用（纯函数）。
 * 追加而非覆盖 —— 单节点多附件是本次的核心改动，任何"设置"入口都不能再整体覆盖。
 */
export function appendRef(raw, ref) {
  const list = decodeRefList(raw);
  list.push(ref);
  return encodeRefList(list);
}

/** 从列表里删掉第 index 个（纯函数） */
export function removeRefAt(raw, index) {
  const list = decodeRefList(raw);
  const i = Number(index);
  if (!(i >= 0 && i < list.length)) return encodeRefList(list);
  list.splice(i, 1);
  return encodeRefList(list);
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

/**
 * 从文件名推断视频的 MIME。
 *
 * 不能用通配 `video/*` —— 那是**不是**合法的具体类型，
 * 部分浏览器给 Blob 设这种 type 后，<video> 加载 blob: URL 会直接失败，
 * 结果是首帧永远抓不到（卡片上一片纯色，看着像图没加载出来）。
 * 抓不到真实类型时返回空串（宁可让浏览器按内容嗅探，也别给错的）。
 */
const VIDEO_EXT_MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4',
  webm: 'video/webm',
  ogg: 'video/ogg', ogv: 'video/ogg',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv',
  flv: 'video/x-flv',
  mpg: 'video/mpeg', mpeg: 'video/mpeg',
  '3gp': 'video/3gpp',
  ts: 'video/mp2t',
};

export function videoMimeOf(name) {
  const m = /\.([a-zA-Z0-9]+)\s*$/.exec(String(name || ''));
  return (m && VIDEO_EXT_MIME[m[1].toLowerCase()]) || '';
}

export function formatSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + ' MB';
  return (v / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}
