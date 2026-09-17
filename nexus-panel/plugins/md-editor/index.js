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

/** 打开编辑面板，返回编辑后的文本；取消则 reject */
async function edit({ text = '', title = 'Markdown' } = {}) {
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
    const paint = () => { pv.innerHTML = render(ta.value); };
    ta.addEventListener('input', paint);

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
      onclick: () => { ui.innerHTML = ''; reject(new Error('已取消')); },
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

  /** 只要渲染结果（调用方自己做编辑框时用） */
  async render({ text } = {}) { return render(text); },
});
