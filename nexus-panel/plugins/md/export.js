/**
 * md F9 —— 导出（纯逻辑，可在 node 里真跑）
 * ============================================================
 * 只放"算字符串"的部分，不碰 DOM、不调后端：
 *   · 目标路径怎么来
 *   · 导出的 HTML 长什么样
 *
 * 运行：node md-export-test.mjs
 */

/* ============================================================
   1. 目标路径
   ============================================================ */

/*
 * 后端允许的扩展名（fpx::fpx_export_text 的白名单）。
 * 前端必须**同口径**校验一次：
 *   后端拒了只报一句"只允许导出 html/md/txt"，用户不知道是自己文件名怪
 *   还是功能坏了。前端先拦并说明，能省掉一次无谓的往返。
 *
 * 更重要的是：前端不校验的话，用户填个 .exe 会被后端拒，
 * 而错误信息看起来像"功能不支持" —— 排查方向全错。
 */
export const EXPORT_EXTS = ['html', 'htm', 'md', 'markdown', 'txt'];

/**
 * 由源路径推出导出路径。
 *
 * @param {string} srcPath 源文件的**完整路径**（只有文件名不行）
 * @param {'html'|'md'} kind
 * @returns {string}
 *
 * 为什么必须要求完整路径：
 *   拖入的文档拿不到磁盘路径（浏览器沙箱只给 File 对象），
 *   没有路径就不知道该写到哪 —— 这时**必须明确说清楚**，
 *   而不是随便挑个目录写下去（那会变成"导出成功但找不到文件"）。
 */
export function exportPathOf(srcPath, kind) {
  const p = String(srcPath || '').replace(/\\/g, '/').trim();
  if (!p) return '';
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.slice(0, slash) : '';
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = kind === 'html' ? 'html' : 'md';
  return dir ? `${dir}/${stem}.${ext}` : `${stem}.${ext}`;
}

/**
 * 目标路径合不合规（前端预判）。
 * @returns {{ ok: boolean, why?: string }}
 */
export function checkExportPath(path) {
  const p = String(path || '').trim();
  if (!p) return { ok: false, why: '没有目标路径' };
  const dot = p.lastIndexOf('.');
  const ext = dot >= 0 ? p.slice(dot + 1).toLowerCase() : '';
  if (!EXPORT_EXTS.includes(ext)) {
    return { ok: false, why: `只允许导出 ${EXPORT_EXTS.join(' / ')}，收到 .${ext || '(无扩展名)'}` };
  }
  return { ok: true };
}

/* ============================================================
   2. 导出的 HTML —— 必须自包含
   ============================================================ */

/*
 * 为什么不能只导出 bodyHtml：
 *   渲染结果的排版与配色全靠宿主的 neumorphism.css（.markdown-body）。
 *   导出的文件在外部浏览器打开时**拿不到宿主 CSS**，
 *   于是打开是一堆没样式的裸文字 —— 用户只会认为"导出坏了"。
 *
 * 所以这里内联一份自足样式。
 *
 * 颜色**不能写死**：写死则导出文件的配色永远是这一套，
 * 在暗色主题下导出的却是白底，用户会认为是 bug。
 * 由调用方把当前主题的实际颜色值读出来传进来（readVar 注入），
 * 这样导出文件与屏幕上看到的一致。
 */
export function buildExportHtml({ title, bodyHtml, vars }) {
  const v = vars || {};
  const cssVars = Object.entries(v)
    .filter(([, val]) => val && String(val).trim())
    .map(([k, val]) => `    ${k}: ${String(val).trim()};`)
    .join('\n');

  /*
   * 变量值直接拼进 <style> —— 这些值来自 getComputedStyle 读到的
   * CSS 变量，是一串颜色/尺寸文本。若某天上游塞进 `}` 之类字符
   * 就能提前闭合 style 标签，所以过滤掉尖括号与 `}`。
   * （导出的是用户自己的主题值，风险低，但这层过滤几乎零成本。）
   */
  const safeVars = /[<>}]/.test(cssVars) ? '' : cssVars;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title || 'Markdown 导出')}</title>
<style>
  :root {
${safeVars || '    --md-bg: #ffffff;\n    --md-fg: #24292f;\n    --md-dim: #57606a;\n    --md-border: #d0d7de;'}
  }
${BASE_CSS}
</style>
</head>
<body>
<div class="markdown-body">
${bodyHtml || ''}
</div>
</body>
</html>`;
}

/** 转义 title —— 它来自文件名，可能含 `<`/`&`，不转义会破坏 head */
export function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 基础样式。
 *
 * 刻意**只用 CSS 变量 + 极少的固定值**：
 * 变量读不到时（比如主题没定义 --text）上面 :root 里给了兜底，
 * 所以不会出现"导出文件是一片黑字黑底"。
 *
 * 不复制 neumorphism.css 全文 —— 那份是给整个应用的，
 * 复制进来会把一堆无关选择器也带出去，且随宿主改动漂移。
 */
export const BASE_CSS = `
  body {
    margin: 0;
    padding: 28px 32px;
    background: var(--md-bg, var(--bg, #ffffff));
    color: var(--md-fg, var(--text, #24292f));
    font: 15px/1.7 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .markdown-body { max-width: 900px; margin: 0 auto; }
  .markdown-body h1,
  .markdown-body h2,
  .markdown-body h3,
  .markdown-body h4 {
    margin: 24px 0 12px;
    line-height: 1.35;
    font-weight: 600;
  }
  .markdown-body h1 { font-size: 26px; border-bottom: 1px solid var(--md-border, var(--border, #d0d7de)); padding-bottom: 8px; }
  .markdown-body h2 { font-size: 21px; border-bottom: 1px solid var(--md-border, var(--border, #d0d7de)); padding-bottom: 6px; }
  .markdown-body h3 { font-size: 17px; }
  .markdown-body h4 { font-size: 15px; }
  .markdown-body p { margin: 10px 0; }
  .markdown-body ul,
  .markdown-body ol { margin: 10px 0; padding-left: 26px; }
  .markdown-body li { margin: 4px 0; }
  .markdown-body a { color: var(--md-link, #0969da); text-decoration: none; }
  .markdown-body a:hover { text-decoration: underline; }
  .markdown-body blockquote {
    margin: 12px 0;
    padding: 4px 14px;
    border-left: 3px solid var(--md-border, var(--border, #d0d7de));
    color: var(--md-dim, var(--text-dim, #57606a));
  }
  .markdown-body code {
    padding: 2px 5px;
    border-radius: 4px;
    background: var(--md-code-bg, rgba(127, 127, 127, 0.14));
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
    font-size: 13px;
  }
  .markdown-body pre {
    margin: 14px 0;
    padding: 14px 16px;
    overflow: auto;
    border-radius: 8px;
    background: var(--md-code-bg, rgba(127, 127, 127, 0.14));
  }
  .markdown-body pre code { padding: 0; background: none; }
  .markdown-body table {
    margin: 14px 0;
    border-collapse: collapse;
  }
  .markdown-body th,
  .markdown-body td {
    padding: 7px 12px;
    border: 1px solid var(--md-border, var(--border, #d0d7de));
  }
  .markdown-body th { background: var(--md-code-bg, rgba(127, 127, 127, 0.14)); }
  .markdown-body img { max-width: 100%; }
  .markdown-body hr {
    height: 1px;
    margin: 22px 0;
    border: 0;
    background: var(--md-border, var(--border, #d0d7de));
  }
  .md-mm svg { max-width: 100%; height: auto; }
`;
