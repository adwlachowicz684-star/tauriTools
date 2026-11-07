/**
 * 单文件形态判据（webview-safe，零依赖）
 * ============================================================================
 *
 * 为什么单独存在（第 64 轮 P0 修复）
 * ------------------------------------------------------------
 * 第 63 轮让 js/installed-frame.js 复用「构建期唯一的 checkSingleFile」，
 * 直接 import 了 ../scripts/single-file.mjs，而那份脚本顶层 import 了
 * node:path 内建模块、inlineHtml() 里还用 Buffer。从生产入口 js/host.js
 * 做 import BFS 实测：主壳闭包 27 个模块里恰好 1 个 node: 内建 import，
 * 就是这一条；它也是 js/ 下唯一一次跨目录 import 到 scripts/。
 * ES module 顶层 import 必须求值，webview 里解析不了 node:path ——
 * 症状是**整个主面板加载失败**，不只是插件分支；而第 63 轮 18 个守卫
 * 全绿（守卫跑在 Node，node:path 天然可用）。
 *
 * 第 41–47 轮花六轮才把编排层闭包里的 node: 销空，第 43 轮还专门记过
 *「静态 import 链」这个盲区；但既有运行时守卫的入口是 js/plugin-market.js，
 * 扫描集合只含 js/，从未覆盖主壳入口，也没把 scripts/ 当可达边界。
 *
 * 怎么修
 * ------------------------------------------------------------
 * 纯判据搬到 js/ 下这个零依赖模块；scripts/single-file.mjs 只保留 Node 侧的
 * inlineHtml() 内联器，并从这里**重导出**同一批函数：
 *   · 判据仍然只有一份 —— 没有复制正则、没有第二套实现；
 *   · js/ 闭包不再跨到 scripts/，12 仓共享镜像里 import 目标齐全；
 *   · 本文件无 node: import、无 Node 全局、无 fs，webview 可直接加载。
 *
 * ⚠️ 下面这些函数从 scripts/single-file.mjs 原文整段搬来，判据语义一字未改
 *    （含 #n / %23n 片段误报修正、空 src 误报修正、三种静态 import 形态
 *     的复查）。改动判据会让构建期与运行期一起变松/变紧，两个守卫一起盯着。
 */

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

/** 取标签属性串里某个属性的值（支持单双引号）。
 *  导出是为了让 scripts/single-file.mjs 的 inlineHtml() 复用同一份实现，
 *  不在那边另写一条正则。运行时模块不需要它。 */
export function attrValue(attrs, name) {
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
    /* 静态 import ./assets/... 说明根本不是一个 chunk，内联了个残的。
       ⛔ 只认「import 后跟空格再 from」会放过三种真实形态（2026-11-02 实测全漏）：
       压缩无空格、re-export、副作用导入。漏的代价：复查报 ok=true → 构建流程
       认为产物自包含 → asset 协议下运行到才 404，插件白屏且不报错。 */
    const stat = [
      ...body.matchAll(/(?:^|[;{}\s])(?:import|export)\b[^;'"]*?\bfrom\s*["'](\.[^"']+)["']/g),
      ...body.matchAll(/(?:^|[;{}\s])import\s*["'](\.[^"']+)["']/g),
    ].map((d) => d[1]);
    for (const u of new Set(stat)) {
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
