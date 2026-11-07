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


/* 第 64 轮：形态判据已搬到 js/single-file-shape.mjs（webview-safe 零依赖）。
 * 本文件只保留 Node 侧的 inlineHtml 内联器，并重导出同一批判据函数 ——
 * 判据实现仍然只有一份，外部 import 路径不变。
 *
 * ⛔ 本文件**不得被 js/ 下任何运行时模块 import**：顶层 node:path 与
 *    Buffer 是 Node 专有，webview 里会整条链加载失败。构建期脚本、
 *    测试守卫（跑在 Node）可以用。installed-frame-test.mjs 的 ⑧ 节
 *    从 js/host.js 做 BFS 钉住这条边界。
 */
import { resolve, dirname } from 'node:path';
import {
  findExternalRefs, attrValue, escapeForScript, escapeForStyle,
} from '../js/single-file-shape.mjs';
export {
  classifyUrl, findExternalRefs, escapeForScript, escapeForStyle,
  checkSingleFile,
} from '../js/single-file-shape.mjs';

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

