import { bootServicePlugin } from '../../js/plugin-sdk.js';

/**
 * Markdown 编辑服务（kind:'service'）
 * ------------------------------------------------------------
 * 供所有插件共用的 md 编辑器：左编辑、右预览，返回编辑后的文本。
 *
 * 说明：这个服务是**新写的**，不是从别处迁来的 ——
 * 仓库里原本没有独立的 md 编辑器（mindmap/editor 是思维导图内核
 * kityminder，agent-flow 只在 llm.ts 里提到 markdown 字样），
 * 所以这里从零给了一个够用的实现。
 *
 * 预览用的是自带的极简渲染器（见 render 函数），刻意不引第三方库：
 * 为一个编辑框拉进一个完整的 markdown 解析依赖不划算，
 * 而插件真正需要的语法（标题/强调/代码/列表/引用/链接/表格）本就不多。
 */

/** 先转义 HTML，再按 md 语法替换 —— 顺序反了等于允许注入 */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 极简 Markdown → HTML。
 * 覆盖：# 标题、**粗体**、*斜体*、`行内码`、```代码块```、
 * - 列表、> 引用、[链接](url)、| 表格 |、--- 分隔线、段落与换行。
 */
function render(md) {
  let s = escapeHtml(md || '');
  const out = [];
  const lines = s.split('\n');
  let inCode = false, codeBuf = [], inList = false, inTable = false;

  const flushList = () => { if (inList) { out.push('</ul>'); inList = false; } };
  const flushTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    // 代码块（三反引号）
    if (/^```/.test(ln)) {
      if (!inCode) { flushList(); flushTable(); inCode = true; codeBuf = []; }
      else { out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`); inCode = false; }
      continue;
    }
    if (inCode) { codeBuf.push(ln); continue; }

    if (/^\s*\|.*\|\s*$/.test(ln)) {
      // 表格行；第二行是分隔行（| --- |）则跳过
      if (/^\s*\|[\s:|-]+\|\s*$/.test(ln) && inTable) continue;
      const cells = ln.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (!inTable) {
        flushList();
        out.push('<table><thead><tr>' + cells.map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
        inTable = true;
        continue;
      }
      out.push('<tr>' + cells.map((c) => `<td>${c}</td>`).join('') + '</tr>');
      continue;
    }
    flushTable();

    if (/^\s*(-|\*|\d+\.)\s+/.test(ln)) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + inline(ln.replace(/^\s*(-|\*|\d+\.)\s+/, '')) + '</li>');
      continue;
    }
    flushList();

    if (/^\s*>\s?/.test(ln)) { out.push('<blockquote>' + inline(ln.replace(/^\s*>\s?/, '')) + '</blockquote>'); continue; }
    if (/^\s*(---|\*\*\*)\s*$/.test(ln)) { out.push('<hr />'); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(ln);
    if (h) { const lv = h[1].length; out.push(`<h${lv}>${inline(h[2])}</h${lv}>`); continue; }
    if (!ln.trim()) { out.push(''); continue; }
    out.push('<p>' + inline(ln) + '</p>');
  }
  flushList(); flushTable();
  if (inCode && codeBuf.length) out.push(`<pre><code>${codeBuf.join('\n')}</code></pre>`);

  function inline(t) {
    return t
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  return out.join('\n');
}

/*
 * F11 —— 预览改用共享的 `md-render` 服务，不再自己渲染一遍。
 * ============================================================
 *
 * 为什么要换：仓库里一度存在**两套 md 渲染器**（本文件的极简版 +
 * md 插件的 react-markdown 版）。两套并存的实际后果不是"多一份代码"，
 * 而是**表现不一致**：同一段 md 在编辑预览里显示成 A，在阅读器里显示成 B。
 * 实测极简版缺这些：引用（> 被先转义吃掉）、图片（渲染成 !<a>）、
 * 有序列表降级成 ul、无任务列表、无删除线、代码块语言标记丢失、
 * 标题无 id、缩进嵌套被拍平，且 `javascript:` 协议未过滤。
 *
 * 为什么不直接删掉极简版：**必须留作降级**。
 * 本插件是 iframe，走桥接调服务；服务没注册 / 桥接超时 / 返回空时，
 * 若没有降级就只剩一块空白预览 —— 那比"显示得不完美"糟得多。
 * 所以：优先服务，任何异常都回退极简版，且**静默**（弹窗会打断编辑）。
 */
async function renderHtml(ctx, text) {
  const fallback = () => render(text);
  if (!ctx || typeof ctx.services?.call !== 'function') return fallback();
  try {
    const html = await ctx.services.call('md-render', 'renderToHtml', { text: text || '' });
    if (typeof html === 'string' && html.trim()) return html;
    return fallback();
  } catch {
    /* 服务不可用就用自带的 —— 不 rethrow：预览失败不该让整个编辑器打不开 */
    return fallback();
  }
}

/** 打开编辑面板，返回编辑后的文本；取消则 reject */
async function edit({ text = '', title = 'Markdown' } = {}, ctx) {
  const ui = document.getElementById('ui');
  if (!ui) throw new Error('md 服务：找不到挂载点');

  return new Promise((resolve, reject) => {
    const el = (tag, attrs = {}, ...kids) => {
      const n = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'style') Object.assign(n.style, v);
        else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
        else n[k] = v;
      }
      for (const k of kids) n.append(k);
      return n;
    };

    const ta = el('textarea', { value: text, spellcheck: false });
    const pv = el('div', { className: 'preview' });

    /*
     * paintSeq —— 异步渲染的**竞态**防护。
     *
     * 走服务后 paint 变成异步：打字快时多个请求同时在飞，
     * 先发的可能后回来。不加序号的话会出现"预览显示的是几秒前的内容"，
     * 而且再敲一个键又变对 —— 这类时好时坏最难查。
     * 只认**最后一次**请求的结果。
     */
    let paintSeq = 0;
    /* 防抖：每敲一个键都发一次桥接请求太频繁，120ms 肉眼无感 */
    let debounce = 0;
    const paint = async () => {
      const my = ++paintSeq;
      const html = await renderHtml(ctx, ta.value);
      if (my !== paintSeq) return;          // 已有更新的请求，丢弃
      pv.innerHTML = html;
    };
    const paintSoon = () => {
      clearTimeout(debounce);
      debounce = setTimeout(paint, 120);
    };
    ta.addEventListener('input', paintSoon);

    /* 工具栏：对选区做前后包裹。
       用 setRangeText 而不是整体替换 —— 后者会丢光标位置，
       连续点两次加粗就得重新选中一遍。 */
    const wrap = (before, after = before) => {
      const s = ta.selectionStart, e = ta.selectionEnd;
      const sel = ta.value.slice(s, e) || '文本';
      ta.setRangeText(before + sel + after, s, e, 'select');
      ta.focus(); paint();
    };
    const lineHead = (prefix) => {
      const s = ta.selectionStart;
      const lineStart = ta.value.lastIndexOf('\n', s - 1) + 1;
      ta.setRangeText(prefix, lineStart, lineStart, 'end');
      ta.focus(); paint();
    };

    const tools = [
      ['粗体', () => wrap('**')],
      ['斜体', () => wrap('*')],
      ['行内码', () => wrap('`')],
      ['标题', () => lineHead('## ')],
      ['列表', () => lineHead('- ')],
      ['引用', () => lineHead('> ')],
      ['代码块', () => wrap('\n```\n', '\n```\n')],
      ['链接', () => wrap('[', '](https://)')],
    ];

    const bar = el('div', { className: 'bar' },
      ...tools.map(([label, fn]) => el('button', { onclick: fn }, label)));

    const okBtn = el('button', {
      className: 'primary',
      onclick: () => { const v = ta.value; ui.innerHTML = ''; resolve(v); },
    }, '确定');
    const cancelBtn = el('button', {
      onclick: () => { ui.innerHTML = ''; resolve(null); },
    }, '取消');

    ui.innerHTML = '';
    ui.append(
      el('div', { className: 'hint' }, title),
      bar,
      el('div', { className: 'panes', style: { flex: '1' } },
        el('div', { className: 'pane' }, el('div', { className: 't' }, '编辑'), ta),
        el('div', { className: 'pane' }, el('div', { className: 't' }, '预览'), pv),
      ),
      el('div', { className: 'foot' }, okBtn, cancelBtn),
    );
    paint();
    ta.focus();
  });
}

bootServicePlugin({
  async describe() {
    return { name: 'Markdown 编辑服务', version: '1.0.0', methods: ['describe', 'edit', 'render'] };
  },

  /** 打开编辑面板，返回编辑后的文本 */
  async edit(args = {}) { return edit(args); },

  /*
   * 只要渲染结果（调用方自己做编辑框时用）。
   * 同样优先共享服务 —— 否则"服务返回 A、本方法返回 B"，
   * 调用方拿到的和预览里看到的对不上。
   */
  async render({ text } = {}, ctx) { return renderHtml(ctx, text); },
});
