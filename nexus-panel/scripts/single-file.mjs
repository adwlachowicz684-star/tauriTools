/**
 * 单文件内联（把 iframe 插件产物压成一个自包含 index.html）
 * ============================================================
 * 为什么需要它
 * ------------------------------------------------------------
 * 插件市场要把插件装到 $APPDATA 并从那里加载（见
 * nexus-panel插件市场任务清单.md 阶段 0）。而 asset 协议加载有个实测复现的坑：
 *
 *   坑①  路径里的 %2F 编码 → 页面内 ./assets/*.js 解析到协议根 → 403
 *
 * 只要插件是「一个 index.html + 若干外部子资源」，坑① 必踩。
 * 而子资源全部内联进 index.html 后，**页面不再发起任何相对请求**，坑① 自然消失
 * ——这是唯一不依赖改 Rust、不依赖改 CSP 的绕法。
 *
 * 另有一层收益：单文件插件的分发形态退化成「一个 .html」，
 * 安装不必解压、不必维护 assets/ 目录树，卸载也只需删一个文件。
 *
 * 为什么是独立模块而不是塞进 build-plugins.mjs
 * ------------------------------------------------------------
 * 内联是纯文本变换（输入 html + 读文件函数，输出 html），**不依赖 vite**。
 * 抽出来才能在没有构建工具链的环境里单测 —— 否则这类逻辑只能等真构建才验，
 * 而真构建失败时排查成本极高（表现为「插件白屏」，看不出是内联问题）。
 *
 * 三条硬约束（写进注释，别改）
 * ------------------------------------------------------------
 * 1. **内联失败必须抛错，不许降级放行**。
 *    半内联的产物（js 内联了、css 没内联）比不内联更危险：页面能开、样式全丢，
 *    且没有任何报错 —— 正是本项目反复栽的「静默失效」。
 *
 * 2. **`</script>` 必须转义**。
 *    JS 内容里只要出现字面量 `</script>`（字符串、正则、注释里都可能有），
 *    HTML 解析器会**提前闭合** script 标签，剩下的 JS 变成页面正文 ——
 *    表现为「插件白屏 + 页面上出现一段源代码」。必须转义成 `<\/script`。
 *    CSS 同理用 `<\/style`（CSS 里 `\/` 是 `/` 的合法转义，语义不变）。
 *
 * 3. **内联后必须复查「还有没有外部引用」**。
 *    内联只能处理它认得出的标签；认不出的（动态 import 拉别的 chunk、
 *    CSS 里的 url(./font.woff)）会留下残口。所以有 checkSingleFile() 单独复查，
 *    且**它不是复用内联器的中间结果**，而是重新解析一遍 html ——
 *    拿被检查者的输出验被检查者，等于生成器验自己，逻辑写错时两边一起错。
 */

import { resolve, dirname } from 'node:path';

/* ------------------------------------------------------------------ *
 * URL 分类
 * ------------------------------------------------------------------ */

/**
 * 判定一个 src/href 属于哪一类。
 *
 * 分类直接决定「能否内联」与「不内联会怎样」：
 *   · relative / abs-path —— 必须内联，否则 asset 协议下必然 404（坑①）
 *   · remote              —— 内联不了（不在本地），且意味着插件依赖远端资源：
 *                            CSP 未必放行，且是供应链面，**必须报出来**
 *   · inline              —— 已经是 data:，无需处理
 *   · other               —— asset: / tauri: 等协议，原样保留
 */
export function classifyUrl(url) {
  const s = String(url || '').trim();
  if (!s) return 'other';
  if (/^data:/i.test(s)) return 'inline';
  /*
   * ⛔ `#n` / `%23n` 是**文档内片段引用**，不是外部资源。
   * 实测（2026-11-02 全量单文件构建）：demo-iframe / demo-react / project-group
   * 三个插件的 CSS 里都有 `url(%23n)`（SVG <use> 指向同文档内的 id），
   * 被 classifyUrl 判成 relative → 复查时进 warnings → ok=false，
   * 于是「这三个插件不能单文件」这条结论是**误报**。
   * 浏览器对 `#` 开头的 URL 不发网络请求，asset 协议下也不会 404。
   * （`%23` 是 `#` 的百分号编码，data URI 内联的 SVG 里常见。）
   */
  if (/^(?:#|%23)/i.test(s)) return 'fragment';
  if (/^(https?:)?\/\//i.test(s)) return 'remote';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return 'other'; // asset: tauri: blob: …
  if (s.startsWith('/')) return 'abs-path';
  return 'relative';
}

/* ------------------------------------------------------------------ *
 * 外部引用扫描
 * ------------------------------------------------------------------ */

/** 取标签属性串里某个属性的值（支持单双引号）。 */
function attrValue(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:["']([^"']*)["']|([^\\s>]+))`, 'i');
  const m = re.exec(attrs);
  if (!m) return null;
  return m[1] !== undefined ? m[1] : m[2];
}

/**
 * 扫出 index.html 里所有「要发请求」的子资源引用。
 *
 * @returns {Array<{tag:string, attr:string, url:string, kind:string,
 *                  cls:string, index:number, length:number}>}
 *   kind: script | stylesheet | modulepreload | image | prefetch | other
 *   cls : classifyUrl() 的返回值
 *   index/length: 整个标签在原串中的位置，供替换用
 */
export function findExternalRefs(html) {
  const out = [];
  const src = String(html || '');

  const push = (m, tag, attr, kindOf) => {
    const attrs = m[1] || '';
    const url = attrValue(attrs, attr);
    // ⛔ 空串也要跳过：实测 dupview 产物里有 5 个 src="" 的 <img>
    // （属性无引号/占位写法，attrValue 取到空串），被当成残留 → ok=false。
    // 空 src 不发请求，asset 协议下也不会 404 —— 那 5 条是**误报**。
    if (url == null || String(url).trim() === '') return;
    out.push({
      tag,
      attr,
      url,
      kind: kindOf(attrs),
      cls: classifyUrl(url),
      index: m.index,
      length: m[0].length,
    });
  };

  /* script src —— 阻塞渲染，最关键 */
  for (const m of src.matchAll(/<script\b([^>]*)>/gi)) {
    push(m, 'script', 'src', () => 'script');
  }
  /* link —— 按 rel 分：stylesheet 阻塞，modulepreload/prefetch 是提示 */
  for (const m of src.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1] || '';
    const rel = (attrValue(attrs, 'rel') || '').toLowerCase();
    const kind = rel.includes('stylesheet') ? 'stylesheet'
      : rel.includes('modulepreload') ? 'modulepreload'
        : /preload|prefetch|preconnect|dns-prefetch/.test(rel) ? 'prefetch'
          : 'other';
    push(m, 'link', 'href', () => kind);
  }
  /* img src —— 不阻塞，但 asset 协议下同样 404（表现为图标空白） */
  for (const m of src.matchAll(/<img\b([^>]*)>/gi)) {
    push(m, 'img', 'src', () => 'image');
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 内容转义
 * ------------------------------------------------------------------ */

/**
 * 内联进 <script> 前转义 `</script`（见文件头约束 2）。
 * 大小写不敏感：HTML 闭合标签不区分大小写，`</SCRIPT>` 一样会闭合。
 */
export function escapeForScript(js) {
  return String(js).replace(/<\/(script)/gi, '<\\/$1');
}

/** 内联进 <style> 前转义 `</style`（同上；CSS 里 `\/` 是 `/` 的合法转义）。 */
export function escapeForStyle(css) {
  return String(css).replace(/<\/(style)/gi, '<\\/$1');
}

/* ------------------------------------------------------------------ *
 * 内联
 * ------------------------------------------------------------------ */

/**
 * 把 html 里的本地子资源内联进去。
 *
 * @param {string} html
 * @param {object} opts
 *   @param {string}   opts.dir        产物目录，相对路径据此解析
 *   @param {Function} opts.readFile   读文件内容（注入式，便于单测）
 *   @param {boolean} [opts.inlineImages] 是否连 <img> 一起内联（默认否：
 *        122 个 .ico 内联会让产物膨胀到不可接受，且图标缺失只是难看不是不可用）
 * @returns {{html:string, inlined:Array, removed:Array, skipped:Array}}
 */
export function inlineHtml(html, { dir, readFile, inlineImages = false }) {
  const src = String(html || '');
  const refs = findExternalRefs(src);

  /* 只处理「本地」引用：远程引用内联不了，列进 skipped 让调用方看见 */
  const locals = refs.filter((r) => r.cls === 'relative' || r.cls === 'abs-path');
  const skipped = refs.filter((r) => r.cls === 'remote' || r.cls === 'other');

  const inlined = [];
  const removed = [];
  const replacements = []; // {index, length, text}

  for (const r of locals) {
    /* 磁盘路径：相对/绝对都从 dir 出发解析（base:'./' 的产物一定是相对路径） */
    const rel = r.url.replace(/^\.?\//, '');
    const abs = resolve(dir || '.', rel);

    if (r.kind === 'script') {
      const content = readFile(abs);
      if (content == null) {
        throw new Error(`[single-file] 待内联的脚本读不到：${r.url}（解析为 ${abs}）`);
      }
      /* 保留 type（module 必须留），去掉 src 与 crossorigin（内联后无意义） */
      const attrs = src.slice(r.index, r.index + r.length);
      const type = attrValue(attrs, 'type');
      const typeAttr = type ? ` type="${type}"` : '';

      /* 必须连原有的闭合标签一起吃掉。
         产物形如 <script src="x"></script>：只替换开标签的话，
         原闭合标签留在原地，结果变成 <script>…内容…</script></script> ——
         多出来的 </script> 会被当作正文文本渲染出来（页面上冒出一段 "。
         实测踩到：见 plugin-singlefile-test.mjs 第 4 节那条「字面量闭合序列只剩 1 处」。 */
      let consumed = r.length;
      const after = src.slice(r.index + r.length);
      const closeM = /^\s*<\/script\s*>/i.exec(after);
      if (closeM) consumed += closeM[0].length;

      replacements.push({
        index: r.index,
        length: consumed,
        text: `<script${typeAttr}>\n${escapeForScript(content)}\n</script>`,
      });
      inlined.push({ ...r, bytes: content.length });
      continue;
    }

    if (r.kind === 'stylesheet') {
      const content = readFile(abs);
      if (content == null) {
        throw new Error(`[single-file] 待内联的样式读不到：${r.url}（解析为 ${abs}）`);
      }
      const attrs = src.slice(r.index, r.index + r.length);
      const media = attrValue(attrs, 'media');
      const mediaAttr = media ? ` media="${media}"` : '';
      replacements.push({
        index: r.index,
        length: r.length,
        text: `<style${mediaAttr}>\n${escapeForStyle(content)}\n</style>`,
      });
      inlined.push({ ...r, bytes: content.length });
      continue;
    }

    /* modulepreload：模块已内联，预载提示无意义，整条删掉 */
    if (r.kind === 'modulepreload' || r.kind === 'prefetch') {
      replacements.push({ index: r.index, length: r.length, text: '' });
      removed.push(r);
      continue;
    }

    if (r.kind === 'image') {
      if (!inlineImages) {
        skipped.push(r);
        continue;
      }
      const buf = readFile(abs);
      if (buf == null) {
        throw new Error(`[single-file] 待内联的图片读不到：${r.url}（解析为 ${abs}）`);
      }
      const ext = (abs.split('.').pop() || '').toLowerCase();
      const mime = ext === 'png' ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
          : ext === 'svg' ? 'image/svg+xml'
            : ext === 'ico' ? 'image/x-icon'
              : ext === 'gif' ? 'image/gif'
                : ext === 'webp' ? 'image/webp'
                  : 'application/octet-stream';
      const b64 = Buffer.from(buf).toString('base64');
      replacements.push({
        index: r.index,
        length: r.length,
        text: `<img src="data:${mime};base64,${b64}"`,
      });
      inlined.push({ ...r, bytes: buf.length });
      continue;
    }

    /* 其它（rel 未知的 link）——不动，但报出来 */
    skipped.push(r);
  }

  /* 从后往前替换，保证前面的 index 不被破坏 */
  let out = src;
  for (const rep of replacements.sort((a, b) => b.index - a.index)) {
    out = out.slice(0, rep.index) + rep.text + out.slice(rep.index + rep.length);
  }

  return { html: out, inlined, removed, skipped };
}

/* ------------------------------------------------------------------ *
 * 复查
 * ------------------------------------------------------------------ */

/**
 * 复查产物是不是真的「自包含」。
 *
 * 独立于 inlineHtml：不读它的 inlined 列表，而是重新解析一遍 html。
 * 理由见文件头约束 3 —— 拿被检查者的输出验被检查者，等于没验。
 *
 * @returns {{ok:boolean, remaining:Array, warnings:Array}}
 *   remaining —— 仍会发请求的子资源引用（含远程）
 *   warnings  —— 内联内容里残留的「还可能拉文件」的痕迹（动态 import、CSS url()）
 */
export function checkSingleFile(html) {
  const src = String(html || '');
  /* ⛔ 只有「真会发请求」的才算残留：
     · inline  —— data: 已经是内联内容
     · fragment—— `#n` / `%23n` 文档内片段，不发请求（见 classifyUrl）
     空 src 的 <img> 同样不发请求，由 findExternalRefs 直接跳过。 */
  const remaining = findExternalRefs(src)
    .filter((r) => r.cls !== 'inline' && r.cls !== 'fragment');

  const warnings = [];

  /* 内联脚本里的动态 import：rollup 会按需生成独立 chunk，
     内联主 chunk 后这些 import(...) 指向的文件已经不在产物里 → 运行到才 404 */
  for (const m of src.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = m[1] || '';
    const dyn = [...body.matchAll(/import\s*\(\s*["']([^"']+)["']\s*\)/g)]
      .map((d) => d[1])
      .filter((u) => !/^data:/i.test(u));
    for (const u of dyn) {
      warnings.push({ kind: 'dynamic-import', url: u });
    }
    /* 静态 import ./assets/... 说明根本不是一个 chunk，内联了个残的 */
    const stat = [...body.matchAll(/(?:^|[\s;])import\s+[^"']*from\s*["'](\.[^"']+)["']/g)]
      .map((d) => d[1]);
    for (const u of stat) {
      warnings.push({ kind: 'static-import', url: u });
    }
  }

  /* CSS 里的相对 url()：字体/背景图，asset 协议下同样解析不到 */
  for (const m of src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    const body = m[1] || '';
    for (const d of body.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
      const u = d[1];
      // 与 remaining 同一套判据（复用 classifyUrl，别各写一条正则）：
      // data: 已内联、#/%23 是文档内片段、远端由 findExternalRefs 管。
      const c = classifyUrl(u);
      if (c === 'inline' || c === 'fragment' || c === 'remote') continue;
      warnings.push({ kind: 'css-url', url: u });
    }
  }

  return { ok: remaining.length === 0 && warnings.length === 0, remaining, warnings };
}
