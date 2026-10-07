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
import { decodeRefList } from './io.js';
/*
 * 空文字节点的占位文案用 formats.js 里那一个常量（见 BUG 99）。
 *
 * 导入侧（markdownToSheet）补位、导出侧（sheetToMarkdown）回落，
 * 两处必须用同一个值：各写一份的话，改了一处不改另一处，
 * Markdown 往返就会凭空多出/少掉「未命名」。
 */
import { EMPTY_NODE_TEXT, inlineText, flattenBreaks } from './formats.js';

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
      // 内容既可能是字符串也可能是对象：
      //   · newSheet() 建新画布时存的是 emptyContent() 的字符串
      //   · 编辑后 exportJson() 返回对象，doSave/capture 直接赋给 s.content
      // 原写法 `typeof === 'string' ? s.content : emptyContent()` 会把
      // **所有编辑过的内容一律换成默认空画布** —— 表现为每次打开插件、
      // 或每切换一次文件/画布，内容就变回「中心主题」。必须两种都保留。
      content: typeof s.content === 'string'
        ? s.content
        : (s.content && typeof s.content === 'object' ? s.content : emptyContent()),
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

/**
 * 复制一张画布（对齐 C# MindMapSheet.Clone + DuplicateSheetAsync）。
 * 新 id、标题「原名 副本」（重名追加序号），内容与主题/布局一并带走。
 *
 * content 可能是对象（运行时）也可能是字符串（落盘后），
 * 这里统一深拷贝，避免副本与原画布共享同一个对象引用 —— 改一个另一个跟着变。
 */
export function cloneSheet(src, sheets = []) {
  const used = new Set((sheets || []).map((s) => s.title));
  const base = `${src.title || '画布'} 副本`;
  let title = base;
  let n = 2;
  while (used.has(title)) title = `${base} ${n++}`;

  return {
    id: newSheetId(),
    title,
    theme: src.theme,
    layout: src.layout,
    content: deepCopyContent(src.content),
  };
}

/** 画布内容深拷贝：对象走 JSON 往返，字符串原样返回（本身已是独立副本） */
function deepCopyContent(content) {
  if (content == null) return null;
  if (typeof content === 'string') return content;
  try {
    return JSON.parse(JSON.stringify(content));
  } catch {
    return content;
  }
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
    /*
     * BUG 101：早先这里的替换正则**只认 LF**（`\n`），不认 CR 与 U+2028/2029。
     *
     * formats.nodeText 用的是 `[\r\n\u2028\u2029]`，这一份漏了后三个。
     * 于是节点文字含 CR 时，导出的行里带着裸 \r：
     *   `# 含\r回车`
     * 而 JS 正则的 `.` **不匹配** \r（行终止符）—— markdownToSheet 那句
     * `/^ {0,3}#{1,6}\s+(.*)$/` 整行不匹配，被当成"不是标题"跳过：
     *
     *   只有根节点含 \r  → rows 为空 → emptyContent()
     *                    → 一张空的「中心主题」顶掉用户全部画布
     *                      （rowCount 那时说"有大纲"，放行导入 —— 正是
     *                       BUG 36 点名要防的事故）
     *   根含 \r + 有子   → 根消失，子节点被抬成根
     *   中间节点含 \r    → 它的子树整层抬到祖父身上
     *
     * 同一份规范化抄两遍、漏了一处 —— 用 formats 的 inlineText 统一。
     */
    let text = inlineText(n?.data?.text);
    /*
     * 空文字必须回落成占位文案，不能导出成 `## `（井号后面什么都没有）。
     *
     * BUG 99：导回时 markdownToSheet 早先对空标题整行 `continue`，
     * 于是 `## ` 这一行被丢掉、它的子树**整层抬到祖父身上**。
     * 两边一起修才叫往返安全：这里补占位，那边不再丢行。
     * 占位与 OPML / FreeMind 那条路是同一个常量（formats.EMPTY_NODE_TEXT）。
     */
    if (!text) text = EMPTY_NODE_TEXT;
    const sharp = '#'.repeat(Math.min(depth + 1, 6));
    let line = sharp + ' ' + text;
    /*
     * 二级节点的文字若以「画布：」开头，拼出来的行正好是**分块标记**。
     *
     * 实测（单画布导出 → 导回）：
     *   节点「画布：设计」→ 导出成 `## 画布：设计`
     *   → 导回时被 SHEET_MARK 当成**新画布的分隔符**
     *   → 1 张画布变成 2 张：
     *        [0] 项目            ← 两个子节点全没了
     *        [1] 设计（根=开发） ← 「画布：设计」变成画布标题而丢失，
     *                             兄弟节点「开发」被抬成新画布的中心主题
     *   即：原节点消失 + 层级错位 + 画布数变化，三样一起来。
     *
     * 转义成 `## \画布：设计`：SHEET_MARK 要求 `##` 后紧跟「画布」，
     * 前面多了反斜杠就不再命中，分块判定安全；导回时再把这个反斜杠去掉。
     *
     * **用户本来就以反斜杠开头时也要转义**，否则这个转义不是往返安全的：
     *   · 文字 `\画布：设计` → 拼出的行 `## \画布：设计`
     *     本来就不命中 SHEET_MARK，于是不加转义
     *   · 导回时 `/^\\画布[:：]/` 照样匹配 → 去掉一个反斜杠
     *   → **用户手打的那个反斜杠被静默吃掉**（三级节点同理：那里的行
     *     是 `### 画布：`，本来不命中、也就没转义，导回却照样被解）。
     *
     * 于是 E/D 必须成对：
     *   E：文字以 `\` 开头、或以 `画布：` 开头（会撞分块标记）→ 前面加一个 `\`
     *   D：只在 `\` 后面跟的是 `画布：` 或又一个 `\` 时才去掉这一个
     *   · `画布：设计` → `\画布：设计` → 解回 `画布：设计` ✓
     *   · `\画布：设计` → `\\画布：设计` → 解回 `\画布：设计` ✓
     *   · `\普通文字`  → `\\普通文字`  → 解回 `\普通文字` ✓
     * 从别处导入的 `\普通文字`（没经过 E）不会被解 —— 保持「不做通用去反斜杠」。
     */
    if (/^\\/.test(text) || /^画布[:：]/.test(text)) line = sharp + ' \\' + text;
    lines.push(line);
    for (const c of n.children || []) walk(c, depth + 1);
  }
}

/**
 * Markdown → kityminder JSON 文本。
 * 只认 ATX 标题行（'#' 开头），其余行忽略（原 C# 版同样只处理标题层级）。
 */
export function markdownToSheet(md) {
  const rows = [];
  for (const rawLine of String(md || '').split(/\r?\n/)) {
    /*
     * BUG 101：先把行里的换行终止符摊平成空格，再判"是不是标题行"。
     *
     * 不摊平的话，`# 含\r回车` 里的 \r 让 `(.*)$` 无法匹配 —— `.` 不匹配
     * 行终止符 —— 整行被跳过，节点静默消失、子树抬层（详见 sheetToMarkdown
     * 里那段注释）。用 flattenBreaks 而不是 inlineText：后者会 trim，
     * 把「四格缩进」（CommonMark 里是代码块、不是标题）也变成合法标题。
     *
     * 这条同时挡住**别的工具**产出的文件：那种文件里的裸 CR 没经过我们的
     * 导出侧规范化，只能在这里拦。
     */
    const raw = flattenBreaks(rawLine);
    /*
     * **井号前面允许 0~3 个空格**（CommonMark：ATX 标题最多缩进三格）。
     *
     * 早先这里写的是 `^(#{1,6})\s+`，井号必须顶格；而 `markdownRowCount()`
     * 用的是 `^\s{0,3}#{1,6}\s+\S`，允许缩进 —— 两个口径不一致。
     *
     * 后果正好是 noOutline() 那段注释点名要防的事故：
     *   缩进写的标题 → rowCount 说「有大纲」→ 放行导入
     *   → markdownToSheet 一条都解析不出来 → emptyContent()
     *   → 导入是**整体替换且不可撤销**，用户的全部画布被一张空的
     *     「中心主题」顶掉，状态栏还写「已保存」。
     * 实测 `  # 项目 / ## 设计 / ## 开发` 就是这个结果。
     *
     * 缩进标题在「列表里嵌标题」「从编辑器整段复制」时很常见，
     * 所以两边统一按 CommonMark 放宽到三格（只认空格，不认制表符 ——
     * 制表符缩进在 CommonMark 里是代码块，不是标题）。
     */
    const m = raw.match(/^ {0,3}(#{1,6})\s+(.*)$/);
    if (!m) continue;
    const depth = m[1].length - 1;              // '#' → 0（中心主题）
    let text = m[2].trim();
    /*
     * 解掉 sheetToMarkdown 加的前导反斜杠（见那里的注释，E/D 必须成对）。
     *
     * **只**解「`\` 后面跟 `画布：`」或「`\` 后面又是一个 `\`」这两种形态，
     * 不做通用去反斜杠 —— 否则从别处导入的 Markdown 里以 `\` 开头的
     * 节点文字（如 `\普通文字`）会被改掉。
     */
    if (/^\\(画布[:：]|\\)/.test(text)) text = text.slice(1);
    /*
     * **空标题不能丢行**（BUG 99）。
     *
     * 早先这里是一句 `if (!text) continue;`，看着像"跳过没内容的行"，
     * 实际做的是：丢掉这一行，把它的子树**整层抬到祖父身上** ——
     * 层级静默错位，且不报错。与 formats.rowsToKm 那个 bug 是同一类，
     * 只是这条路径自己又抄了一份重建逻辑，所以上一次没被一起修掉。
     *
     * 实测：
     *   '# R\n## \n### A1\n### A2\n## B'
     *     修复前 → R / A1 / A2 / B   ← A1、A2 从三级被抬成二级
     *     修复后 → R / 未命名 /（A1、A2）/ B
     *
     * 触发它的是真实文件：从 Typora / Obsidian / 幕布 之类工具导出的
     * Markdown 里，空标题行（有 # 但没写标题）并不罕见；
     * 本工具自己导出的文件在节点文字为空白时也会写出 `## `（见 sheetToMarkdown）。
     */
    if (!text) text = EMPTY_NODE_TEXT;
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
    /*
     * BUG 101：画布标题同样必须摊平换行终止符。
     *
     * 早先这里是 `## 画布：${s.title}` —— 标题原样拼进去，于是：
     *   标题含 \n  → 拼出两行，第二行不带 `#`、不是分块标记
     *                被当成块内内容丢掉 → **标题被截断**（「含\n换行」→「含」）
     *   标题含 \r  → 整行是 `## 画布：含\r回车`
     *                SHEET_MARK 的 `(.*)$` 不匹 \r → **整行失效**
     *                → 这一块变成无标题 → 导回后叫「画布 1」
     *
     * 画布标题能带上换行的真实路径：从 .xmind 导入（XMind 的标题是 JSON
     * 字段，原样保留换行），再导出成 .md。
     * 摊平成空格后是「含 换行」—— 仍丢了一个换行，但不再截断/整块失效。
     */
    const head = `## 画布：${inlineText(s.title)}\n`;
    return head + (sheetToMarkdown(s.content) || '# （空画布）\n');
  });
  return blocks.join('\n');
}

/**
 * 这段文本里有几条 ATX 标题行（即能当大纲用的行数）。
 *
 * 为什么需要它：`markdownToSheet()` 对**任何**输入都会给出一棵树 ——
 * 一条标题都没有时返回 `emptyContent()`，也就是一张空的「中心主题」画布。
 * 于是「导入一个根本不是大纲的文件」不会报错，而是**静默地**拿一张空画布
 * 把用户现有的全部画布顶掉（导入是整体替换、且不可撤销），状态栏还写
 * 「已保存」。导入方必须先问一句「这里到底有没有大纲」，没有就别替换。
 *
 * 只数**能解析成节点**的行，与 markdownToSheet 的正则口径保持一致 ——
 * 否则两边判断会不一致：这里说有、那边解析出来是空的。
 *
 * 「能解析成节点」包括**空标题**（`## `）：BUG 99 之后空标题会补成占位节点，
 * 不再被丢掉，所以这里也必须算一条，否则又变成"那边有节点、这里说没有"。
 */
export function markdownRowCount(md) {
  let n = 0;
  for (const rawLine of String(md || '').split(/\r?\n/)) {
    // 与 markdownToSheet 逐字同一套：先摊平换行终止符，再判（BUG 101）。
    // 不摊平就会重演 BUG 90 —— 这里说"有大纲"、那边解析出空画布。
    const raw = flattenBreaks(rawLine);
    /*
     * 口径必须与 markdownToSheet() 逐字一致（见那里的注释）：
     * 早先这里是 `\s{0,3}`（含制表符）、那边是顶格，于是「这里说有大纲、
     * 那边解析出空画布」，导入变成静默清空。
     *
     * `(\s+\S|\s+$)`：井号后跟内容算一条；**光有井号和空格**也算一条 ——
     * 空标题现在会补成占位节点（BUG 99），不数就又对不上。
     * 井号后什么都没有（`##`）不在此列：解析器要求 `\s+`，那边同样不认。
     */
    if (/^ {0,3}#{1,6}(\s+\S|\s+$)/.test(raw)) n++;
  }
  return n;
}

/** Markdown → 画布数组（识别 '## 画布：' 分块；无分块时视作单画布） */
export function markdownToWorkbook(md) {
  const text = String(md || '');
  const lines = text.split(/\r?\n/);
  const chunks = [];
  let cur = { title: null, lines: [] };

  for (const rawLine of lines) {
    // 同 markdownToSheet：先摊平换行终止符，否则 `## 画布：含\r回车`
    // 整行不命中 SHEET_MARK（`.` 不匹 \r）→ 这一块被当成无标题（BUG 101）。
    const line = flattenBreaks(rawLine);
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
/**
 * 收集画布里所有附件的资产 id（纯函数，可测）。
 *
 * B22：用于在导入 .json 时判断「这个文件是不是从别的机器来的」。
 *
 * 本插件的 .json 只存**引用**（`{a: '<assetId>'}`），附件本体在 IndexedDB 里。
 * 换台机器导入这个 JSON，引用看着完全正常、界面上附件也还在，
 * 但**字节没有跟过来** —— 点开才发现打不开。
 * 不提前提示的话，用户会以为是文件坏了。
 *
 * 只收**解析得出 a 字段**的引用；C# 版遗留的纯路径字符串没有资产 id，
 * 那种是另一种情况（本来就打不开），不归这里管。
 *
 * @param {Array} sheets
 * @returns {string[]} 去重后的资产 id
 */
export function collectAssetRefs(sheets = []) {
  const ids = new Set();
  const visit = (node) => {
    const d = node?.data;
    if (d) {
      for (const k of ['file', 'video']) {
        const v = d[k];
        if (v == null || v === '') continue;
        /*
         * 必须走 decodeRefList，不能自己 JSON.parse 一次就当单个对象用。
         *
         * 单节点多附件改造后，`file`/`video` 存的是 **JSON 数组串**
         * （哪怕只有一个附件也是数组）；自己 parse 出来是 Array，
         * 再读 `ref.a` 恒为 undefined —— 于是**列表形式的多附件全部漏掉**，
         * 只收得到老式的「单对象串」。
         *
         * decodeRefList 已经把「数组串 / 单对象串 / 数组元素是 JSON 串 /
         * 纯路径兜底」四种形态都处理好了，这里没有理由再写一套。
         */
        for (const ref of decodeRefList(v)) {
          if (ref && typeof ref.a === 'string' && ref.a) ids.add(ref.a);
        }
      }
    }
    for (const c of node?.children || []) visit(c);
  };

  for (const s of sheets || []) {
    if (!s?.content) continue;
    let km = null;
    try { km = typeof s.content === 'string' ? JSON.parse(s.content) : s.content; } catch { continue; }
    if (!km) continue;
    visit(km.root);
  }
  return [...ids];
}

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

  // 形态一：本插件工作簿（多画布包）
  if (Array.isArray(obj.sheets)) {
    const sheets = normalizeSheets(obj.sheets);
    // A31 报出识别到的形态：导入后提示「按多画布包解析」，
    // 否则用户拿到一个不像预期的结果时，无从判断是文件不对还是解析错了。
    return { sheets, activeId: obj.activeId || sheets[0].id, form: 'workbook' };
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
    return { sheets: [sheet], activeId: sheet.id, form: 'single' };
  }
  return null;
}

/**
 * 多画布指纹：逐张比对 id + 内容。
 * 用于判断「相对最新快照是否真的有改动」—— 自动备份到点时会比对，
 * 内容没变就只重置计时器、不写盘，避免空转出一堆一模一样的快照。
 * 对齐 C# 版 IsStateEquivalent 的做法（多画布逐张比；旧备份无画布时退化为比当前内容）。
 */
/**
 * 工作簿指纹：用于「内容没变就不重复备份」的去重判断。
 *
 * 画布 content 在运行时是**对象**（kityminder 的 exportJson 返回对象，只有
 * 序列化落盘后才变成字符串）。早期版本直接做字符串拼接，对象会被转成
 * "[object Object]"，于是任何内容改动都不改变指纹 —— 备份去重退化成
 * 「只有增删/排序画布才备份，改内容永远不备份」。必须按内容序列化。
 */
export function fingerprintSheets(sheets) {
  return (sheets || [])
    .map((s) => (s.id || '') + '\u0000' + contentText(s.content))
    .join('\u0001');
}

/** 画布内容 → 可比较的文本（对象/字符串都兼容） */
function contentText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content);
  } catch {
    // 循环引用等极端情况：退化为稳定占位，至少不会崩
    return '[unstringifiable]';
  }
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
