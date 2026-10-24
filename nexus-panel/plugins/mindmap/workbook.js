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
import { EMPTY_NODE_TEXT, inlineText, flattenBreaks, ROOT_TEXT, rowsWithVirtualRoot, stripBom, skipYamlFrontmatter } from './formats.js';

/*
 * 中心主题文案住在 formats.js（那边导入侧插虚拟根要用，而它不能反过来
 * 依赖本文件），这里原样转出 —— 只保留一个定义，别处一律从这里拿。
 */
export { ROOT_TEXT };

const SHEET_MARK = /^##\s*画布[:：]\s*(.*)$/;

/**
 * Markdown 能表达的层级上限（ATX 标题最多 6 个 `#`）。
 *
 * CommonMark 规定 7 个及以上 `#` **不是标题**（`####### x` 是普通段落），
 * 所以更深的层**没有合法写法** —— 只能拍平到第 6 级。
 * 常量化是为了让「上限」只有一个出处：写侧截断、读侧正则、越界统计
 * 三处各自写死 6 的话，改一处不改另一处就会出现「写得出读不进」的行。
 */
export const MARKDOWN_MAX_LEVEL = 6;

/* ------------------------------ 构造 ------------------------------ */

export function newSheetId() {
  return 'sh' + Math.random().toString(36).slice(2, 12);
}

/** 空画布内容：仅一个根节点（kityminder importJson 可直接吃） */
export function emptyContent(rootText = ROOT_TEXT) {
  return JSON.stringify({
    root: { data: { text: rootText || ROOT_TEXT }, children: [] },
    template: DEFAULT_LAYOUT,
    theme: DEFAULT_THEME,
  });
}

export function newSheet(title = '画布 1', rootText = ROOT_TEXT) {
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
      // BUG 122：关系线是画布级字段，规范化重建对象时必须跟着走 ——
      // 少了这一步，导入带关系线的文件后只要存一次盘，关系线就没了
      ...(Array.isArray(s.xrelationships) && s.xrelationships.length
        ? { xrelationships: s.xrelationships }
        : {}),
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
    // BUG 122：副本也要带着关系线。deepCopyContent 是深拷贝，节点 id 原样
    // 保留，所以关系线引用的端点在副本里仍然在（同 id 在本画布内存在）。
    ...(Array.isArray(src.xrelationships) && src.xrelationships.length
      ? { xrelationships: src.xrelationships.map((r) => ({ ...r })) }
      : {}),
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
    /*
     * 第 7 级及更深一律截断成 6 个 `#` —— 于是它们**互相变成兄弟**。
     * 深度损失由 deepNodeCount() 统计、导出侧据此提示（见那里的注释）。
     */
    const sharp = '#'.repeat(Math.min(depth + 1, MARKDOWN_MAX_LEVEL));
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
 * 统计「Markdown 装不下」的节点数：层级深到连 6 个 `#` 都表示不了的那部分。
 *
 * 深度按 0 起算（根 = 0），层级 = 深度 + 1。第 7 级（深度 6）及更深
 * 全部被截断成 6 个 `#`，于是它们**互相变成兄弟** ——
 * 一棵 10 层的链导出再导回，第 6 级以下会摊成同一层的平铺列表。
 *
 * 用它而不是等导入时才发现：导入是**整体替换且不可撤销**，等用户把
 * 拍平后的文件导回来，原始层级已经没了。导出那一句提示是唯一的机会。
 *
 * @param {Array} sheets 画布数组（content 为 kityminder JSON 文本或对象）
 * @param {number} [max] 层级上限，默认 MARKDOWN_MAX_LEVEL
 * @returns {number} 会被拍平的节点数（0 = 没有损失）
 */
export function deepNodeCount(sheets, max = MARKDOWN_MAX_LEVEL) {
  let n = 0;
  for (const s of sheets || []) {
    let root;
    try {
      root = (typeof s?.content === 'string' ? JSON.parse(s.content) : s?.content)?.root;
    } catch { continue; }        // 坏内容不算 —— 它本来也导不出东西
    if (!root) continue;
    (function walk(node, depth) {
      if (!node) return;
      if (depth >= max) n++;
      for (const c of node.children || []) walk(c, depth + 1);
    })(root, 0);
  }
  return n;
}

/**
 * Markdown 文本 → 大纲行 `[{ depth, text }]`。
 *
 * 这是 `markdownToSheet()`（真的建树）与 `markdownRowCount()`（导入闸门）
 * **共用的唯一一份行解析**。
 *
 * 为什么必须共用一份：两边各写一份正则，历史上出过三次事故 ——
 *   BUG 90  · 一边 `\s{0,3}` 一边顶格 → 闸门说「有大纲」、解析出来是空的
 *             → 一张空画布顶掉用户全部内容
 *   BUG 101 · 带 CR 的行一边认一边不认 → 同一个文件两种判断
 *   BUG 102 · 分块标记行被闸门当成节点 → 只有标记的块也放行
 * 抽成一份之后，「两边口径不一致」在结构上就不可能再发生。
 */
export function mdOutlineRows(md) {
  const rows = [];
  let fence = null;      // 围栏代码块的标记字符（` 或 ~ 或更多），闭合前一律跳过
  let base = -1;         // 最近一个标题的深度；一个标题都没有时 -1（列表首项成为根）
  const indents = [null]; // 列表缩进栈：相对缩进定层级，2 / 4 空格混用都成立
  /*
   * BUG 149：先剥掉文件开头的 BOM。
   * 不剥的话首行是 `\uFEFF# A`，井号前多了一个字符 → 不命中标题正则 →
   * **整行被跳过**；首行若正好是分块标记 `## 画布：X`，那张画布的标题就
   * 静默变成默认「画布 1」。Windows 记事本存 UTF-8 默认带 BOM，很常见。
   */
  const src = stripBom(md).split(/\r?\n/);
  /*
   * BUG 168：跳过文件开头的 **YAML frontmatter**（`---` … `---` / `...`）。
   *
   * Obsidian / Typora / Notion / Hugo / Jekyll 导出的 `.md` 几乎都带这一段，
   * 里面写 title / tags / aliases / date。早先不认它，于是其中的**列表项**
   * 被当成大纲节点混进脑图：
   *
   *   '---\ntitle: 项目\ntags:\n  - 设计\n  - 开发\n---\n# 项目启动'
   *     修复前 → 中心主题 >（设计、开发、项目启动）
   *     修复后 → 项目启动
   *
   * 而 `tags:` / `aliases:` / `categories:` 下面写成列表正是 frontmatter 里
   * 最常见的写法。导入又是整体替换且不可撤销，一条提示都没有。
   *
   * ⓘ 跳法在 formats.skipYamlFrontmatter() 里，与 Mermaid（BUG 167）和
   *   格式嗅探（BUG 169）**共用同一份** —— 各写一份必然只修一处。
   *
   * ⓘ 只在**开头**跳、且必须有闭合行，所以多画布文件的分块内容不受影响。
   *   本工具自己导出 .md 从不写 frontmatter，往返不受影响。
   */
  for (const rawLine of src.slice(skipYamlFrontmatter(src))) {
    /*
     * BUG 101：先把行里的换行终止符摊平成空格，再判"是不是大纲行"。
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
     * ★ 分块标记行不是节点行（BUG 102）。
     * `## 画布：项目A` 自己就命中标题正则，数它等于把「有 N 张画布」误当成
     * 「有 N 个节点」（详见 markdownRowCount 那段注释）。
     */
    if (SHEET_MARK.test(raw)) {
      base = -1;
      indents.length = 0;
      indents.push(null);
      continue;
    }
    /*
     * **围栏代码块**：里面的 `- item` / `# x` 都不是大纲（BUG 145）。
     * 不分这个的话，README 之类文档里的示例代码会被当成一整排节点。
     */
    const fm = raw.match(/^ {0,3}(`{3,}|~{3,})/);
    if (fm) {
      const mark = fm[1][0];
      if (!fence) fence = mark;
      else if (fence === mark) fence = null;
      continue;
    }
    if (fence) continue;

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
    if (m) {
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
      base = depth;
      indents.length = 0;
      indents.push(null);
      continue;
    }

    /*
     * **列表项**（BUG 145）。
     *
     * 早先只认 `#` 标题，其余行一律丢掉。而 Obsidian / Typora / 幕布 / Notion
     * 导出的 Markdown **大量用列表表示层级**，于是导入后只剩标题那几行、
     * 列表内容全部消失，且不报错、不计入任何提示：
     *
     *   '# 项目\n- 设计\n  - UI\n  - 交互\n- 开发'
     *     修复前 → 只有「项目」一个节点
     *     修复后 → 项目 / 设计（UI、交互）/ 开发
     *
     * 危险的是**放行与解析不一致**：`markdownRowCount` 看见 `# 项目` 说
     * 「有大纲」→ 放行导入 → 解析出的画布几乎是空的 → 整体替换顶掉用户
     * 全部画布（导入不可撤销）。这正是 BUG 36 / 90 / 103 点名要防的事故。
     *
     * ⓘ 支持列表是**只读侧的兼容**：本工具导出 Markdown 只用 `#`（见
     *   sheetToMarkdown），所以自己的往返不受影响。
     */
    const li = raw.match(/^([ \t]*)(?:[-*+]|\d{1,9}[.)])([ \t]+)(.*)$/);
    if (!li) continue;
    let text = li[3].trim();
    /*
     * **水平线不是列表项**：`---` / `***` / `- - -` / `___` 都该跳过。
     * 不判的话 YAML front matter 的分隔线和章节分隔线会变成一排节点。
     * （`---` 本身不匹配上面的正则 —— 标记后必须跟空白 —— 但 `- - -` 匹配。）
     */
    if (!text || /^[-*_=~\s]+$/.test(text)) continue;
    /*
     * ⓘ 这里**不解** `\画布：` 的前导反斜杠 —— 与标题那条分支不同。
     *
     * 前导反斜杠是 `sheetToMarkdown` 加的**转义**（防止节点文字撞上分块
     * 标记 `## 画布：`），而它只加在**标题行**上：本工具导出 Markdown 从不
     * 写裸列表行（下面注释里有说明），所以列表项里的 `\` 一律是**文字本身**。
     *
     * 早先这里顺手也解了一次，于是从别处导入的 `- \画布：X` 会被改成
     * `画布：X` —— 静默改了别人的内容。变异验证也证明这条分支**没有任何
     * 用例能观测到**（删掉它全套测试照样绿），属于"看着在把关、其实没把关"。
     */
    /*
     * 层级按**相对缩进的栈**算，不是"每 N 空格一层"。
     *
     * 列表缩进 2 空格和 4 空格都极常见，写死一个比例必然错层；用栈就能同时
     * 成立：缩进变大 → 进一层；变小 → 退到对应层；相等 → 同级。
     * 行首制表符按 2 空格展开（CommonMark 是 4，但"一个 tab 一层"的文件
     * 更常见；关键是层级单调、不丢内容）。
     */
    const indent = li[1].replace(/\t/g, '  ').length;
    if (indents[indents.length - 1] === null) {
      // 本段列表的第一项：以它的缩进为基准（整段缩进的列表不该被当成子层）
      indents[indents.length - 1] = indent;
    } else {
      while (indents.length > 1 && indents[indents.length - 1] > indent) indents.pop();
      if (indents[indents.length - 1] < indent) indents.push(indent);
    }
    // 列表挂在最近那个标题下面（base = -1 时首项自己就是根）
    rows.push({ depth: base + 1 + (indents.length - 1), text });
  }
  return rows;
}

/**
 * Markdown → kityminder JSON 文本。
 * 认 ATX 标题行（'#' 开头）与列表项（BUG 145），其余行忽略。
 */
export function markdownToSheet(md) {
  const rows = mdOutlineRows(md);
  if (!rows.length) return emptyContent();

  /*
   * ★ 顶层同级条目不能再被串成父子链（BUG 146）／更浅的标题不能再被挂到
   *   更深的标题下面（BUG 147）。
   *
   * 两条判据与 OPML 多顶层、PlantUML 多根（BUG 148）**共用同一份实现**
   *   —— formats.rowsWithVirtualRoot()，详解见那边。
   *
   * 这里只留一句「为什么必须是**这里**插、不能插进 mdOutlineRows()」：
   * 后者也被导入闸门 markdownRowCount() 调用，而它是按**整份文件**算的
   * （多画布文件里每个块各有一个顶层条目），在那里插会凭空多出一个
   * 不属于任何块的行（实测：多出 101 条失败）。
   */
  const list = rowsWithVirtualRoot(rows, ROOT_TEXT);

  const root = { data: { text: list[0].text }, children: [] };
  const stack = [{ depth: list[0].depth, node: root }];
  for (let i = 1; i < list.length; i++) {
    const { depth, text } = list[i];
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
 * 这段文本里有几条能当大纲用的行（标题行 + 列表项）。
 *
 * 为什么需要它：`markdownToSheet()` 对**任何**输入都会给出一棵树 ——
 * 一条大纲行都没有时返回 `emptyContent()`，也就是一张空的「中心主题」画布。
 * 于是「导入一个根本不是大纲的文件」不会报错，而是**静默地**拿一张空画布
 * 把用户现有的全部画布顶掉（导入是整体替换、且不可撤销），状态栏还写
 * 「已保存」。导入方必须先问一句「这里到底有没有大纲」，没有就别替换。
 *
 * ★ 直接复用 `mdOutlineRows()`（BUG 145）。
 *
 * 早先这里是**自己抄了一份正则**，只数 `#` 标题。抄两份的代价历史上付过
 * 三次（BUG 90 口径不一致 / BUG 101 CR / BUG 102 分块标记），而 BUG 145
 * 之后又多一条：解析器认列表、闸门不认 → 纯列表文件被拦下（还好），
 * 而「标题 + 列表」的文件**放行却几乎全空**（事故）。
 *
 * 现在两边是同一个函数，"这里说有、那边解析出来是空的"在结构上不可能发生。
 * 分块标记行在 mdOutlineRows 里跳过（BUG 102）；空标题补占位（BUG 99）。
 */
export function markdownRowCount(md) {
  return mdOutlineRows(md).length;
}

/** Markdown → 画布数组（识别 '## 画布：' 分块；无分块时视作单画布） */
export function markdownToWorkbook(md) {
  /*
   * BUG 149：先剥 BOM。分块标记是**在这一层**认的（`## 画布：X`），
   * 首行带 BOM 时不命中 SHEET_MARK → 这一块没有标题 → 导回后画布名叫
   * 默认的「画布 1」，而用户文件里明明写着「画布：项目A」。
   */
  const text = stripBom(md);
  const rawLines = text.split(/\r?\n/);
  /*
   * BUG 170：分块**之前**先跳过文件开头的 YAML frontmatter。
   *
   * frontmatter 在**第一个分块标记之前**，所以它会被塞进 `cur.lines`；
   * 等 `## 画布：X` 一来，`cur` 就被 push 成一个 chunk —— 于是凭空多出
   * 一张**空白画布**「画布 1」，且 `activeId` 指向它：用户打开看到的是
   * 一片空白，只会以为导入失败了。
   *
   * 更糟的是这里与 `mdOutlineRows`（BUG 168）**各跳一半**：那边跳过之后
   * frontmatter 一行都不剩（实测 `mdOutlineRows(frontmatter)` = []），
   * 这一层却又把它留成一个块 —— 于是那个块解析出来是空的「中心主题」，
   * 静默多一张空画布，一条提示都没有。
   *
   * ⓘ 跳法同样是 `formats.skipYamlFrontmatter()`，与 Mermaid（BUG 167）、
   *   Markdown 大纲（BUG 168）、格式嗅探（BUG 169）**共用一份**；
   *   各写一份必然只修一处，这正是本项目反复付学费的模式。
   * ⓘ `flattenBreaks` 先摊一遍：`## 画布：含\r回车` 那类行（BUG 101）
   *   与 `---\r` 同理，不摊平就判不中。
   */
  const lines = rawLines.slice(skipYamlFrontmatter(rawLines.map(flattenBreaks)));
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
    // BUG 149：带 BOM 的工作簿快照 JSON.parse 直接抛错 → 整个文件导不进来
    obj = JSON.parse(stripBom(text));
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
