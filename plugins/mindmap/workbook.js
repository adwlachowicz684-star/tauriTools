/**
 * 思维导图插件 · 工作簿模型与序列化
 * ============================================================
 * 一本脑图 = 多张画布（sheet），每张画布自带主题与布局 —— 与 C# 侧
 * MindMapWorkbook.cs 的模型一一对应，保证 .json 工作簿文件两侧互通。
 *
 * Markdown 互通格式（对齐 MindMapMarkdown.cs）：
 *   · 单画布：'#' 数量即层级（一级 = 中心主题，最深 6 级）
 *   · 多画布：以 '## 画布：<标题>' 分块，块内沿用 '#' 层级
 */

import { DEFAULT_THEME, DEFAULT_LAYOUT } from './themes.js';

const SHEET_MARK = /^##\s*画布[:：]\s*(.*)$/;

/* ------------------------------ 构造 ------------------------------ */

export function newSheetId() {
  return 'sh' + Math.random().toString(36).slice(2, 12);
}

/** 空画布内容：仅一个根节点（kityminder importJson 可直接吃） */
export function emptyContent(rootText = '中心主题') {
  return JSON.stringify({
    root: { data: { text: rootText || '中心主题' }, children: [] },
    template: DEFAULT_LAYOUT,
    theme: DEFAULT_THEME,
  });
}

export function newSheet(title = '画布 1', rootText = '中心主题') {
  return {
    id: newSheetId(),
    title,
    content: emptyContent(rootText),
    theme: DEFAULT_THEME,
    layout: DEFAULT_LAYOUT,
  };
}

/** 规范化：补齐字段、去重 id、保证至少一张画布、activeId 有效 */
export function normalizeSheets(sheets) {
  const list = Array.isArray(sheets) ? sheets.filter(Boolean) : [];
  const seen = new Set();
  const out = list.map((s, i) => {
    let id = typeof s.id === 'string' && s.id ? s.id : newSheetId();
    while (seen.has(id)) id = newSheetId();
    seen.add(id);
    return {
      id,
      title: typeof s.title === 'string' && s.title ? s.title : `画布 ${i + 1}`,
      content: typeof s.content === 'string' ? s.content : emptyContent(),
      theme: s.theme || DEFAULT_THEME,
      layout: s.layout || DEFAULT_LAYOUT,
    };
  });
  return out.length ? out : [newSheet()];
}

/** 生成不重复的画布名：画布 1 / 画布 2 … */
export function nextTitle(sheets) {
  const used = new Set(sheets.map((s) => s.title));
  for (let i = 1; i < 10000; i++) {
    const t = `画布 ${i}`;
    if (!used.has(t)) return t;
  }
  return `画布 ${Date.now()}`;
}

/** 空工作簿 */
export function newWorkbook() {
  const s = newSheet();
  return { sheets: [s], activeId: s.id };
}

/* --------------------------- Markdown 互转 --------------------------- */

/**
 * 单张画布 → Markdown。
 * @param {string} content kityminder exportJson 文本
 */
export function sheetToMarkdown(content) {
  let root;
  try {
    root = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    return '# （空画布）\n';
  }
  const node = root?.root;
  if (!node) return '# （空画布）\n';
  const lines = [];
  walk(node, 0);
  return lines.join('\n') + '\n';

  function walk(n, depth) {
    if (!n) return;
    const text = String(n?.data?.text ?? '').replace(/\s*\n\s*/g, ' ').trim();
    lines.push('#'.repeat(Math.min(depth + 1, 6)) + ' ' + text);
    for (const c of n.children || []) walk(c, depth + 1);
  }
}

/**
 * Markdown → kityminder JSON 文本。
 * 只认 ATX 标题行（'#' 开头），其余行忽略（原 C# 版同样只处理标题层级）。
 */
export function markdownToSheet(md) {
  const rows = [];
  for (const raw of String(md || '').split(/\r?\n/)) {
    const m = raw.match(/^(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const depth = m[1].length - 1;              // '#' → 0（中心主题）
    const text = m[2].trim();
    if (!text) continue;
    rows.push({ depth, text });
  }
  if (!rows.length) return emptyContent();

  const root = { data: { text: rows[0].text }, children: [] };
  const stack = [{ depth: rows[0].depth, node: root }];
  for (let i = 1; i < rows.length; i++) {
    const { depth, text } = rows[i];
    const node = { data: { text }, children: [] };
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1];
    // 层级跳跃（如 # 直接到 ###）时按相邻处理，避免丢节点
    parent.node.children.push(node);
    stack.push({ depth, node });
  }
  return JSON.stringify({
    root,
    template: DEFAULT_LAYOUT,
    theme: DEFAULT_THEME,
  });
}

/** 整个工作簿 → Markdown（多画布分块） */
export function workbookToMarkdown(sheets) {
  const blocks = sheets.map((s) => {
    const head = `## 画布：${s.title}\n`;
    return head + (sheetToMarkdown(s.content) || '# （空画布）\n');
  });
  return blocks.join('\n');
}

/** Markdown → 画布数组（识别 '## 画布：' 分块；无分块时视作单画布） */
export function markdownToWorkbook(md) {
  const text = String(md || '');
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let cur = { title: null, lines: [] };

  for (const line of lines) {
    const m = line.match(SHEET_MARK);
    if (m) {
      if (cur.title !== null || cur.lines.length) chunks.push(cur);
      cur = { title: (m[1] || '').trim() || null, lines: [] };
      continue;
    }
    cur.lines.push(line);
  }
  if (cur.title !== null || cur.lines.length) chunks.push(cur);

  const list = chunks.length ? chunks : [{ title: null, lines }];
  const sheets = list.map((c, i) => {
    const content = markdownToSheet(c.lines.join('\n'));
    return {
      id: newSheetId(),
      title: c.title || `画布 ${i + 1}`,
      content,
      theme: DEFAULT_THEME,
      layout: DEFAULT_LAYOUT,
    };
  });
  return sheets.length ? sheets : [newSheet()];
}

/* --------------------------- 工作簿文件 --------------------------- */

/**
 * 导出为 .json 工作簿文本。
 * 顶层带 kind 标记，导入时可区分「工作簿 / 单画布 / 未知」。
 */
export function serializeWorkbook(sheets, activeId) {
  const list = normalizeSheets(sheets);
  return JSON.stringify(
    {
      kind: 'nexus-mindmap-workbook',
      version: 1,
      activeId: activeId || list[0]?.id || '',
      sheets: list,
    },
    null,
    2,
  );
}

/**
 * 解析导入的 .json 文本，返回 { sheets, activeId }。
 * 兼容三种形态：本插件工作簿 / kityminder 单画布导出 / 任意含 root 的 JSON。
 */
export function parseWorkbook(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;

  // 形态一：本插件工作簿
  if (Array.isArray(obj.sheets)) {
    const sheets = normalizeSheets(obj.sheets);
    return { sheets, activeId: obj.activeId || sheets[0].id };
  }
  // 形态二：kityminder 单画布导出（含 root）
  if (obj.root) {
    const sheet = {
      id: newSheetId(),
      title: '画布 1',
      content: JSON.stringify(obj),
      theme: obj.theme || DEFAULT_THEME,
      layout: obj.template || DEFAULT_LAYOUT,
    };
    return { sheets: [sheet], activeId: sheet.id };
  }
  return null;
}

/**
 * 多画布指纹：逐张比对 id + 内容。
 * 用于判断「相对最新快照是否真的有改动」—— 自动备份到点时会比对，
 * 内容没变就只重置计时器、不写盘，避免空转出一堆一模一样的快照。
 * 对齐 C# 版 IsStateEquivalent 的做法（多画布逐张比；旧备份无画布时退化为比当前内容）。
 */
export function fingerprintSheets(sheets) {
  return (sheets || []).map((s) => (s.id || '') + '\u0000' + (s.content || '')).join('\u0001');
}

/** 从画布 JSON 文本里取出 theme / template（导入旧文件时恢复外观） */
export function readSheetAppearance(content) {
  try {
    const o = typeof content === 'string' ? JSON.parse(content) : content;
    return { theme: o?.theme || DEFAULT_THEME, layout: o?.template || DEFAULT_LAYOUT };
  } catch {
    return { theme: DEFAULT_THEME, layout: DEFAULT_LAYOUT };
  }
}

/** 把 theme / template 写进画布 JSON 文本（导出时保留外观） */
export function writeSheetAppearance(content, theme, layout) {
  try {
    const o = typeof content === 'string' ? JSON.parse(content) : content;
    if (o && typeof o === 'object') {
      o.theme = theme;
      o.template = layout;
      return JSON.stringify(o);
    }
  } catch { /* 坏内容原样返回 */ }
  return content;
}
