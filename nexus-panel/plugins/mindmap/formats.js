/**
 * 通用脑图 / 大纲交换格式
 * ============================================================
 * 覆盖市面主流软件能读写的纯文本格式，便于跨工具迁移：
 *
 * | 格式 | 扩展名 | 代表软件 |
 * |---|---|---|
 * | **FreeMind** | `.mm` | FreeMind、Freeplane、XMind（可导入）、Docear、MindMeister |
 * | **OPML** | `.opml` | OmniOutliner、Scrivener、Workflowy、幕布、多数大纲/阅读器 |
 * | **Mermaid** | `.mmd` | GitHub、GitLab、Notion、Obsidian 原生渲染 |
 * | **PlantUML** | `.puml` | PlantUML、Confluence、多数 Wiki |
 *
 * ## 一个必须说清的限制：这些都是**单画布**格式
 *
 * FreeMind / OPML / Mermaid / PlantUML 的顶层结构都只有**一个根**，
 * 无法表达多画布工作簿。所以：
 *
 * - **导出**只写当前激活画布，并在状态栏明确说明（静默丢掉其它画布不可接受）
 * - **导入**产生一张新画布
 *
 * 需要多画布请用 `.xmind` 或本工具的 `.json`（两者都保留全部画布与附件）。
 *
 * ## 只交换「文字 + 层级 + 展开状态」
 *
 * 这些格式承载不了本工具的图标、优先级、进度、附件等扩展数据。
 * 硬塞进自定义属性只会在别的软件里变成乱码，所以一律不写。
 */

const DEFAULT_LAYOUT = 'default';
const DEFAULT_THEME = 'fresh-blue-compat';

/* ------------------------------------------------------------
   XML 基础
   ------------------------------------------------------------ */

/**
 * XML 1.0 里**根本不允许出现**的字符（连写成 `&#1;` 这样的数字引用也非法）。
 * 合法集：#x9 #xA #xD #x20-#xD7FF #xE000-#xFFFD #x10000-#x10FFFF。
 *
 * 必须带 `u` 标志：不带时字符串按 UTF-16 码元切分，emoji（代理对）会被
 * 当成两个非法码元一起删掉 —— 实测 `a😀b` 会变成 `a  b`。
 * 带 u 后按码点匹配，代理对是一个码点，不再命中。
 */
const XML_ILLEGAL = /[\u{0}-\u{8}\u{B}\u{C}\u{E}-\u{1F}\u{D800}-\u{DFFF}\u{FFFE}\u{FFFF}]/gu;

/**
 * XML 属性/文本转义（纯函数，可测）。
 *
 * `&` 必须**第一个**替换，否则会把后面生成的 `&amp;` 里的 & 又转义一遍，
 * 变成 `&amp;amp;`。
 *
 * 两件容易漏的事（BUG 74 / BUG 75）：
 *
 * ① **先清掉 XML 非法字符**。节点文字里带 0x07、0x0C 这类控制字符时
 * （从终端、PDF、其它软件粘进来的很常见），导出的 .opml / .mm 是**无效 XML**
 * —— DOMParser 直接报 parsererror，`fromOpml`/`fromFreemind` 返回 null。
 * 后果是：本插件导出的文件，本插件自己导不回来（提示"无法识别该文件"，
 * 整份导入失败），别的软件也打不开。数字引用救不了（XML 1.0 里同样非法），
 * 只能替换掉；按 nodeText 的惯例换成空格。
 *
 * ② **制表符要写成 `&#9;`**。XML 的属性值规范化会把裸 tab 变成空格，
 * 于是 `a\tb` 走 OPML 往返变成 `a b`，而 Mermaid / XMind 原样保留 ——
 * 同一段文字换个格式就换了个样子。字符引用不走属性规范化，能保住原字符。
 */
export function escXml(s) {
  return String(s ?? '')
    .replace(XML_ILLEGAL, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    .replace(/\t/g, '&#9;');
}

/** XML 实体反转义（供无 DOM 环境兜底；有 DOMParser 时由它处理） */
export function unescXml(s) {
  return String(s ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#9;/g, '\t')
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------
   kityminder 画布内容 ↔ 树
   ------------------------------------------------------------ */

/**
 * 解析画布内容为 { root, template, theme }。
 * 坏 JSON 返回 null —— 调用方据此提示，不能抛（导入流程不能被一张坏画布拦死）。
 */
export function parseKm(content) {
  if (!content) return null;
  let km = null;
  try { km = typeof content === 'string' ? JSON.parse(content) : content; } catch { return null; }
  if (!km || typeof km !== 'object' || !km.root) return null;
  return km;
}

export function stringifyKm(root, template, theme) {
  return JSON.stringify({
    root,
    template: template || DEFAULT_LAYOUT,
    theme: theme || DEFAULT_THEME,
  });
}

/**
 * 取节点文字（去换行、去首尾空格；空则给占位）。
 *
 * **必须连同 \r 一起规范化，不能只认 \n**（BUG 72）：
 * 只写 `\s*\n\s*` 时，单独的 CR（`\r`）、U+2028/2029 会**原样留在文字里**，
 * 而它们又都是 JS 正则里 `.` 不匹配的"行终止符"——
 * 于是 PlantUML 导出的行 `** 含\r回车` 在导回时被 `/^(\*+)\s*(.*)$/`
 * 判成"不是节点行"而**整条跳过**：节点凭空消失，且不报错。
 *
 * \r 不是凭空构造：.xmind 的 content.json 与原生 .json 都是 JSON，
 * JSON.parse 会如实还原文本里的 `\r` 转义，导入即带进来
 * （.mm / .opml 走 XML 属性规范化，天然会把 \r 变空格，所以只有 JSON 系受影响）。
 */
/**
 * 空文字节点的占位文案。
 *
 * 导出侧 nodeText 的 fallback 与导入侧 rowsToKm 的补位**必须是同一个**：
 * 两边各写一份，改了一处不改另一处，往返就会凭空多出/少掉「未命名」。
 */
export const EMPTY_NODE_TEXT = '未命名';

/**
 * 换行类字符 → 单个空格（**不** trim）。
 *
 * 用于**整行文本**：Markdown 的 ATX 标题最多缩进三格，整行 trim 会把
 * 四格缩进（CommonMark 里是代码块、不是标题）也变成合法标题 —— 所以
 * 这里只换行终止符，缩进语义原样保留。
 *
 * 为什么必须有它：JS 正则里 \r / \u2028 / \u2029 都是「行终止符」，
 * 而 `.` **不匹配**行终止符。于是 `# 含\r回车` 撞上 `/^#{1,6}\s+(.*)$/`
 * 时整行不匹配 → 被当成"不是标题行"跳过 → 节点凭空消失（BUG 72 那一类）。
 *
 * \r 不是凭空构造：.xmind 的 content.json 与原生 .json 都是 JSON，
 * JSON.parse 会如实还原文本里的 `\r` 转义，导入即带进来
 * （.mm / .opml 走 XML 属性规范化，天然把 \r 变空格，所以只有 JSON 系受影响）。
 */
export const flattenBreaks = (v) => String(v ?? '').replace(/[\r\n\u2028\u2029]+/g, ' ');

/**
 * 节点文字规范化：换行类字符及其前后空白 → 单个空格，并 trim。
 *
 * 导出节点文字 / 画布标题用这个；判「整行是不是标题」用 flattenBreaks。
 * 两者是同一个替换，只是要不要 trim —— 分开成两个函数，是为了让
 * 每条路都只写一遍（抄两遍必漏，BUG 100 / 101 都是这么来的）。
 */
export const inlineText = (v) => String(v ?? '').replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim();

export function nodeText(n, fallback = EMPTY_NODE_TEXT) {
  return inlineText(n?.data?.text) || fallback;
}

/** 节点是否折叠（kityminder 用 expandState: 'collapse' 表示收起） */
export const isCollapsed = (n) => String(n?.data?.expandState || '') === 'collapse';

/**
 * 遍历树。
 * @param {object} node kityminder 节点
 * @param {(n:object, depth:number, parent:object|null)=>void} fn
 */
export function walkKm(node, fn, depth = 0, parent = null) {
  if (!node) return;
  fn(node, depth, parent);
  for (const c of node?.children || []) walkKm(c, fn, depth + 1, node);
}

/**
 * 由 (depth, text) 序列重建 kityminder 树（纯函数，可测）。
 *
 * **空文字的行不能丢**（BUG 98）。
 *
 * 早先这里有一句 `filter(r => String(r.text ?? '').trim())`，
 * 看着像"跳过没内容的行"，实际做的是：**丢掉这一行，把它的子树整层抬上去**。
 * 因为后面重建层级用的是"上一行的 depth"，中间那行没了，
 * 子节点就挂到了祖父身上 —— 层级静默错位，且不报错。
 *
 * 触发它的是真实文件，不是刁钻输入：
 *   · Freeplane / FreeMind 允许空白节点，导出的就是 `TEXT=""`
 *   · 节点文字带格式时，文字在 `<richcontent>` 里，TEXT 属性可能**整个不写**
 *     （readXmlNodes 取不到就回落空串）
 *   · 只有 `title` 没有 `text` 的 OPML 同样落到这里
 *
 * 实测（OPML，中间那个 outline 文字为空且带两个子）：
 *   修复前  项目 / 设计 / 开发 / 测试   ← 设计、开发 从三级被抬成二级
 *   修复后  项目 / 未命名 /（设计、开发）/ 测试
 *
 * 根为空时更狠：整条第一分支被虚拟根顶掉（见 fromOpml 的 tops 判断）。
 *
 * 所以补位成占位文案保留下来，与导出侧 nodeText 的 fallback 同一个常量。
 */
export function rowsToKm(rows, rootFallback = '中心主题') {
  const list = (rows || []).filter((r) => !!r);
  if (!list.length) {
    return { root: { data: { text: rootFallback }, children: [] } };
  }
  const make = (text) => {
    const t = String(text ?? '').trim();
    return { data: { text: t || EMPTY_NODE_TEXT }, children: [] };
  };
  const root = make(list[0].text);
  const stack = [{ depth: list[0].depth, node: root }];
  for (let i = 1; i < list.length; i++) {
    const { depth, text } = list[i];
    const node = make(text);
    // 层级跳跃（如 0 直接到 2）时按相邻处理，避免丢节点
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) stack.pop();
    stack[stack.length - 1].node.children.push(node);
    stack.push({ depth, node });
  }
  return { root };
}

/** 树 → (depth, text, collapsed) 序列（纯函数，可测） */
export function kmToRows(root) {
  const out = [];
  walkKm(root, (n, depth) => {
    /*
     * 空文字必须走 nodeText 的**默认**占位（EMPTY_NODE_TEXT），不能传 ''。
     *
     * BUG 100：早先这里写 `nodeText(n, '')`，于是空白节点导出成空行：
     *   · PlantUML 写出 `* `（井号后什么都没有）
     *     → fromPlantUml 早先对空行 `continue` → 节点消失、子树整层抬上去；
     *       若整张图只有这一个节点，rows 为空 → **返回 null**，
     *       再导入时直接报「无法识别该文件」。
     *   · Mermaid 写出 `""`（Mermaid 的空占位）
     *     → mermaidTextOf 不认它 → 导回后节点文字变成字面 `""`。
     *
     * kmToRows 只被 toMermaid / toPlantUml 用，OPML / FreeMind / Markdown
     * 各自走 nodeText()，早已是占位 —— 把这里也统一成占位，
     * 四种交换格式的口径才一致（见 BUG 98 / 99：同一份逻辑抄两遍就会漏）。
     */
    out.push({ depth, text: nodeText(n), collapsed: isCollapsed(n) });
  });
  return out;
}

/* ------------------------------------------------------------
   FreeMind / Freeplane（.mm）
   ------------------------------------------------------------ */

/**
 * 画布 → FreeMind XML。
 *
 * `FOLDED` 用 kityminder 的 expandState 表达 —— 折叠状态丢了虽然不致命，
 * 但源图里收起的分支导出去全展开，会让人以为结构变了。
 */
export function toFreemind(content) {
  const km = parseKm(content);
  if (!km) return '';
  const lines = [
    '<map version="1.0.1">',
    '<!-- 由 Nexus Panel 脑图导出 -->',
  ];
  emit(km.root, 0);
  lines.push('</map>');
  return lines.join('\n') + '\n';

  function emit(n, depth) {
    const attrs = [`TEXT="${escXml(nodeText(n))}"`];
    // BUG 113：备注走 richcontent TYPE="NOTE"（FreeMind / Freeplane 的标准）。
    // 不写的话往返丢，别的软件打开我们导出的 .mm 也看不到备注。
    const noteHtml = noteToRichcontent(n?.data?.note, depth + 1);
    // BUG 111：LINK 是 FreeMind 的标准属性（Freeplane / XMind 都认）。
    // 不写的话往返丢，别的软件打开我们导出的 .mm 也看不到链接。
    const href = String(n?.data?.hyperlink || '').trim();
    if (href) attrs.push(`LINK="${escXml(href)}"`);
    // BUG 114：颜色走 `COLOR` / `BACKGROUND_COLOR`（FreeMind 的标准属性）。
    // 不写的话往返丢，别的软件打开我们导出的 .mm 看不到节点的配色。
    const fg = normColor(n?.data?.color);
    if (fg) attrs.push(`COLOR="${escXml(fg)}"`);
    const bg = normColor(n?.data?.background);
    if (bg) attrs.push(`BACKGROUND_COLOR="${escXml(bg)}"`);
    // 根节点不需要 FOLDED（根永远展开）
    if (depth > 0 && isCollapsed(n)) attrs.push('FOLDED="true"');
    const kids = n?.children || [];
    if (!kids.length && !noteHtml) {
      lines.push('  '.repeat(depth + 1) + `<node ${attrs.join(' ')}/>`);
      return;
    }
    lines.push('  '.repeat(depth + 1) + `<node ${attrs.join(' ')}>`);
    if (noteHtml) lines.push(noteHtml);
    for (const c of kids) emit(c, depth + 1);
    lines.push('  '.repeat(depth + 1) + '</node>');
  }

  /**
   * 纯文本备注 → `<richcontent TYPE="NOTE">` 的 XHTML 片段。
   *
   * 备注里写「a < b」不转义就会变成 XHTML 标签让整段备注显示不出来，
   * 所以正文走 escXml（它同时清掉 XML 1.0 不允许的控制字符 —— 不清理的话
   * 整份 .mm 会变成别的软件打不开的坏 XML，见 BUG 74）。
   */
  function noteToRichcontent(note, depth) {
    const t = String(note ?? '').trim();
    if (!t) return '';
    const inner = t.split(/\n{2,}/).map((p) => `<p>${escXml(p).replace(/\n/g, '<br/>')}</p>`).join('');
    return '  '.repeat(depth + 1)
      + `<richcontent TYPE="NOTE"><html><body>${inner}</body></html></richcontent>`;
  }
}

/**
 * 取 <node> 的正文：TEXT 属性没有时回落到 <richcontent TYPE="NODE">。
 *
 * FreeMind / Freeplane 在节点文字带格式（粗体、颜色、换行）时，
 * 正文写在 `<richcontent TYPE="NODE"><html>…</html></richcontent>` 里，
 * TEXT 属性**可能整个不写**、也可能只是空的。只认 TEXT 的话，
 * 这类节点导入后文字全空 —— 配合 rowsToKm 早先的丢行，节点会整个消失。
 *
 * 只在 TEXT 取不到时才用，有 TEXT 时以它为准（往返不受影响）。
 */
function freemindNodeText(el) {
  const kids = el ? (el.children || el.childNodes) : null;
  if (!kids) return null;
  for (const c of Array.from(kids)) {
    if (String(c.nodeName || '').toLowerCase() !== 'richcontent') continue;
    // TYPE="NOTE" 是备注，不是节点正文
    const ty = String(c.getAttribute?.('TYPE') || '').toUpperCase();
    if (ty && ty !== 'NODE') continue;
    const s = String(c.textContent || '').replace(/\s+/g, ' ').trim();
    if (s) return s;
  }
  return null;
}

/**
 * FreeMind XML → 画布内容。
 * 只认 <node> 的 TEXT 属性（缺则回落 richcontent）；其余（edge/font/hook/cloud）
 * 一概忽略 —— 它们承载的都是样式，本工具的主题体系不认。
 */
export function fromFreemind(text) {
  const rows = readXmlNodes(text, 'node', 'TEXT', freemindNodeText, 'LINK', freemindNote, freemindStyle);
  if (!rows) return null;
  if (!rows.length) return null;
  const { root } = rowsToKm(rows);
  // 折叠状态回填
  applyCollapsed(root, rows.map((r) => r.collapsed));
  // BUG 111：超链接回填（LINK 是 FreeMind 的标准属性）
  applyLinks(root, rows.map((r) => r.link));
  // BUG 113：备注回填（richcontent TYPE="NOTE"）
  applyNotes(root, rows.map((r) => r.note));
  // BUG 114：颜色回填（COLOR / BACKGROUND_COLOR）
  applyStyles(root, rows.map((r) => r.style));
  return stringifyKm(root);
}

/* ------------------------------------------------------------
   OPML（.opml）
   ------------------------------------------------------------ */

/**
 * 画布 → OPML 2.0。
 *
 * `text` 属性是 OPML 里唯一必须的；`_note` 之类扩展属性写了也只是增加噪音，
 * 别的软件不会读。
 */
export function toOpml(content, title = '脑图') {
  const km = parseKm(content);
  if (!km) return '';
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escXml(title)}</title>`,
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    '    <ownerName>Nexus Panel</ownerName>',
    '  </head>',
    '  <body>',
  ];
  emit(km.root, 2);
  lines.push('  </body>', '</opml>');
  return lines.join('\n') + '\n';

  function emit(n, depth) {
    const pad = '  '.repeat(depth);
    const kids = n?.children || [];
    const attrs = [`text="${escXml(nodeText(n))}"`];
    // BUG 111：url 是 OPML 2.0 规范属性（OmniOutliner / 幕布 等都读写）
    const href = String(n?.data?.hyperlink || '').trim();
    if (href) attrs.push(`url="${escXml(href)}"`);
    if (!kids.length) {
      lines.push(`${pad}<outline ${attrs.join(' ')}/>`);
      return;
    }
    lines.push(`${pad}<outline ${attrs.join(' ')}>`);
    for (const c of kids) emit(c, depth + 1);
    lines.push(`${pad}</outline>`);
  }
}

/**
 * OPML → 画布内容。
 *
 * 多个顶层 outline 时**造一个虚拟根**把它们挂上去：
 * OPML 允许多个顶层条目，而 kityminder 必须有且只有一个 root。
 * 不造根的话，除第一个以外的顶层条目会被静默丢掉。
 */
export function fromOpml(text) {
  const rows = readXmlNodes(text, 'outline', 'text', null, 'url');
  if (!rows) return null;
  if (!rows.length) return null;
  const tops = rows.filter((r) => r.depth === 0);
  let rows2 = rows;
  if (tops.length > 1) {
    // 整体下移一层，前面插入虚拟根
    rows2 = [{ depth: 0, text: '中心主题' }]
      .concat(rows.map((r) => ({ ...r, depth: r.depth + 1 })));
  }
  const { root } = rowsToKm(rows2);
  // BUG 111：超链接回填（url 是 OPML 2.0 规范属性）。
  // 用 rows2 而不是 rows —— 多顶层 outline 时会插入虚拟根，索引必须对齐。
  applyLinks(root, rows2.map((r) => r.link));
  return stringifyKm(root);
}

/* ------------------------------------------------------------
   Mermaid mindmap（.mmd）
   ------------------------------------------------------------ */

/**
 * 需要加引号的 Mermaid 特殊字符。
 *
 * Mermaid 里 `(`、`)`、`[`、`]`、`{`、`}`、`"`、`#`、`;`、`:` 等都有语法含义。
 * 节点文字里含这些字符时**必须**用 `["..."]` 包裹，
 * 否则轻则渲染错乱，重则整张图**解析失败一片空白**。
 * 空白同样致命（纯空格节点会让 Mermaid 报语法错误）。
 */
/*
 * `^%`：文字以 `%` 开头必须加引号（BUG 104）。
 *
 * Mermaid 里 `%%` 起头是注释，而裸写的话整行会被 fromMermaid 当注释丢掉 ——
 * 节点消失、子树抬层。加引号后行首是 `[`，不再命中注释判定。
 * 只管**开头**：中间的 `50%` 之类在 Mermaid 里没有语法含义，照旧裸写。
 */
const MERMAID_NEEDS_QUOTE = /[()[\]{}"#;:,`]|^\s|\s$|\s\s|^%/;

/** 单个节点文字 → 安全的 Mermaid 写法（纯函数，可测） */
export function mermaidLabel(text) {
  const t = String(text ?? '').replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ').trim();
  if (!t) return '""';                     // 空节点也要占位，否则整张图解析失败
  if (MERMAID_NEEDS_QUOTE.test(t)) {
    /*
     * **先把字面 `#` 转成 `#35;` 再转义 `"`**（BUG 73），顺序不能反：
     * `"` 的转义产物本身就是 `#quot;`，先转引号再处理 `#`
     * 会把刚生成的 `#quot;` 又拆成 `#35;quot;`。
     *
     * 不转义会怎样：unescMermaid 见到 `#quot;` / `#35;` / `#40;` / `#41;`
     * 一律还原，于是节点里**本来写着** `a#quot;b` 的文字，导出再导回
     * 就变成 `a"b` —— 静默改内容，且不报错。实测 `a#quot;b`→`a"b`、
     * `a#35;b`→`a#b`。
     *
     * `#35;` 是 Mermaid 自己的数字实体（# 的转义），渲染出来就是 `#`，
     * 所以转义后给别的软件看也不会变样。
     */
    return `["${t.replace(/#/g, '#35;').replace(/"/g, '#quot;')}"]`;
  }
  return t;
}

/**
 * 从 Mermaid 节点行里剥出纯文字（纯函数，可测）。
 * 处理 `id((text))`、`id[text]`、`id(text)`、`id{{text}}`、裸文字 几种写法。
 */
export function mermaidTextOf(line) {
  let s = String(line ?? '').trim();
  if (!s) return '';
  // 去掉开头的 id（如 `root((x))` 里的 root、`id1[x]` 里的 id1）。
  //
  // **必须要求 id 后紧跟 `[` `(` `{`** —— 否则 `B`、`plan` 这类
  // 纯文字节点会被整条当成 id 吃掉，解析结果为空、节点直接丢失。
  // （这个 bug 初版就有：回环测试里 B / B1 两个节点凭空消失。）
  s = s.replace(/^[A-Za-z_][\w-]*(?=\s*[\[({])/, '');
  // 去掉结尾（可能有 onCreate 之类指令）
  const m = s.match(/^(?:\(\((.*)\)\)|\["(.*)"\]|\[(.*)\]|\(\((.*)\)\)|\((.*)\)|\{\{(.*)\}\}|(.*))$/s);
  let t = '';
  if (m) {
    t = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? '';
  }
  return unescMermaid(String(t)).trim();
}

/**
 * Mermaid 用 `#quot;` 等数字实体表示标点的转义形式。
 *
 * **必须一趟扫完，不能链式多次 replace**（BUG 73）：
 * 链式时前一条的**产物**会被后一条再吃掉 ——
 * `#35;` 还原成 `#` 之后，紧跟的 `40;` 凑成新的 `#40;`，又被换成 `(`。
 * 实测 `a#40;b` 被还原成 `a(b`。单趟匹配下每处只被认领一次，不重入。
 */
export function unescMermaid(s) {
  return String(s ?? '').replace(/#(?:quot|35|40|41);|<br\s*\/?>/gi, (m) => {
    switch (m.toLowerCase()) {
      case '#quot;': return '"';
      case '#35;': return '#';
      case '#40;': return '(';
      case '#41;': return ')';
      default: return ' ';          // <br> / <br/>：Mermaid 的换行，这里并成一个空格
    }
  });
}

/**
 * 画布 → Mermaid mindmap。
 *
 * 缩进用 **2 空格**：Mermaid 官方示例与多数编辑器都用它，
 * tab 在部分渲染器里会解析失败。
 *
 * 根节点写成 `root((文字))` —— 双括号是 Mermaid 里「中心主题」的惯用形状，
 * 视觉上和脑图一致。
 */
export function toMermaid(content) {
  const km = parseKm(content);
  if (!km) return '';
  const rows = kmToRows(km.root);
  const lines = ['mindmap'];
  for (const r of rows) {
    const pad = '  '.repeat(r.depth + 1);
    const label = mermaidLabel(r.text);
    /*
     * 根节点**不能**无脑写成 `root((${label}))`。
     *
     * label 在文字含特殊字符时本身就是 `["文字"]`（方括号 + 引号），
     * 再套一层 `(())` 就变成 `root((["项目(2024)"]))` —— 两层括号嵌套，
     * Mermaid 认不出，而 mermaidTextOf 读回来只能拿到整串
     * `["项目(2024)"]`（实测 4 例：括号 / # / 引号 / 中括号全部损坏），
     * 于是「导出成 Mermaid 再导回来」中心主题就变成一串带着方括号的怪东西。
     *
     * 需要引号时改用 `root["文字"]`（方形节点）—— 形状从圆变方是
     * 视觉上的小退化，但往返才是正确性问题，正确性优先。
     * 不需要引号时保持 `root((文字))`（圆形，中心主题的惯用形状）。
     */
    lines.push(pad + (r.depth === 0
      ? (label.charCodeAt(0) === 91 /* '[' */ ? 'root' + label : `root((${label}))`)
      : label));
  }
  return lines.join('\n') + '\n';
}

/**
 * Mermaid → 画布内容。
 * 按**缩进**定层级；`mindmap` 头行可省略。
 */
export function fromMermaid(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    /*
     * 头行 / 指令行。
     *
     * ★ `mindmap` 头行**只有在它确实是头行时**才能跳过（BUG 104）。
     *
     * 早先写成 `if (/^\s*mindmap\s*$/i.test(raw)) continue;` —— 正则带 `\s*`
     * 所以**缩进也匹配**，于是节点文字就叫「mindmap」的节点被整条吃掉，
     * 它的子树整层抬到祖父身上（`mindmap` / `MindMap` / `MINDMAP` 三种写法
     * 全中，因为还带 i）。实测：根 → mindmap → （子1、子2）、尾，导回后
     * 5 个节点变 4 个，子1/子2 变成根的直接子。
     *
     * 头行一定是「第一条节点之前的那行」，所以只在 rows 为空时跳过 ——
     * 此时不可能有节点行（根节点写在 2 空格缩进上，从来不是裸 `mindmap`）。
     */
    if (!rows.length && /^\s*mindmap\s*$/i.test(raw)) continue;
    /*
     * 注释行。它同样会吞节点：节点文字以 `%%` 开头时，mermaidLabel 写出的
     * 是裸 `%% …`，导回就被当成注释丢掉（同 BUG 104）。文字侧已经把它纳入
     * 「必须加引号」的判定（见 MERMAID_NEEDS_QUOTE 的 `^%`），加引号后
     * 行首是 `[`、不再命中注释 —— 两边一起才叫往返安全。
     */
    if (/^\s*(%%|\/\/:)/.test(raw)) continue;      // 注释
    const indent = (raw.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '  ').length;
    let body = mermaidTextOf(raw);
    /*
     * **整行就是** `""` 时当空节点 —— 那是 Mermaid 自己的空占位
     * （mermaidLabel('') 就写它）。不认它的话，别的工具导出的 .mmd 里
     * 空白节点会变成**字面两个引号**。
     *
     * 判的是**整行**而不是取出的文字：节点文字真的就是 `""` 时，
     * 它含引号、导出走 `["#quot;#quot;"]`（带方括号），不是裸 `""`；
     * 照 body 判断会把「文字是 `""`」也误判成空节点（往返变「未命名」）。
     */
    if (raw.trim() === '""') body = '';
    /*
     * **空文字不能丢行**（BUG 100，与 BUG 98 / 99 同一类）：
     * 丢掉一行等于把它的子树整层抬到祖父身上，层级静默错位。
     */
    if (!body) body = EMPTY_NODE_TEXT;
    rows.push({ depth: Math.floor(indent / 2), text: body });
  }
  if (!rows.length) return null;
  const { root } = rowsToKm(rows);
  return stringifyKm(root);
}

/* ------------------------------------------------------------
   PlantUML mindmap（.puml）
   ------------------------------------------------------------ */

/** 画布 → PlantUML mindmap（纯函数，可测） */
export function toPlantUml(content) {
  const km = parseKm(content);
  if (!km) return '';
  const rows = kmToRows(km.root);
  const lines = ['@startmindmap'];
  for (const r of rows) {
    lines.push('*'.repeat(r.depth + 1) + ' ' + r.text);
  }
  lines.push('@endmindmap');
  return lines.join('\n') + '\n';
}

/** PlantUML mindmap → 画布内容（纯函数，可测） */
export function fromPlantUml(text) {
  const rows = [];
  let inBlock = false;
  const src = String(text || '').split(/\r?\n/);
  // 允许没有 @startmindmap / @endmindmap 包裹（有些片段只有 * 行）
  // ★ 只看**非节点行**（BUG 104）：节点行以 `*` 开头，文字里带
  //   `@startmindmap` 时也会被 `/@startmindmap/i` 命中，于是那一行被当成
  //   标记吃掉 —— 节点消失 + 子树抬层，与 Mermaid 的 `mindmap` 头行同一个毛病。
  const anyMarker = src.some((l) => !l.trim().startsWith('*') && /@startmindmap/i.test(l));
  for (const raw of src) {
    const line = raw.trim();
    // 同上：节点行（以 `*` 开头）永不参与标记判定
    if (!line.startsWith('*')) {
      if (/@startmindmap/i.test(line)) { inBlock = true; continue; }
      if (/@endmindmap/i.test(line)) { inBlock = false; continue; }
    }
    if (anyMarker && !inBlock) continue;
    if (!line || line.startsWith("'")) continue;
    const m = line.match(/^(\*+)\s*(.*)$/);
    if (!m) continue;
    let t = m[2].trim();
    /*
     * **空标题不能丢行**（BUG 100，与 BUG 98 / 99 同一类）。
     *
     * 早先这里是一句 `if (!t) continue;`：
     *   · 空白节点所在行被丢掉 → 它的子树**整层抬到祖父身上**
     *   · 整张图只有这一个节点时 rows 为空 → 返回 **null**
     *     → 再导入时报「无法识别该文件」，整份文件报废
     *
     * 本工具自己导出就会踩到：toPlantUml 早先走 kmToRows(含 `nodeText(n,'')`)，
     * 空白节点写出 `* ` 空行，导回来就是上面两条后果。
     */
    if (!t) t = EMPTY_NODE_TEXT;
    rows.push({ depth: m[1].length - 1, text: t });
  }
  if (!rows.length) return null;
  const { root } = rowsToKm(rows);
  return stringifyKm(root);
}

/* ------------------------------------------------------------
   内部：XML → (depth, text) 序列
   ------------------------------------------------------------ */

/**
 * 把 XML 里指定标签按嵌套层级读成 (depth, text)。
 *
 * 走 DOMParser 而不是正则：正则碰上 `TEXT="a>b"`、
 * 属性值里带 `>`、多行文本这些情况都会解析错，
 * 而这类输入在真实用户文件里并不罕见。
 *
 * @param {string} text XML 原文
 * @param {string} tag 标签名
 * @param {string} attr 取文字的属性名
 * @returns {Array|null} null = 解析失败（不是「空」）
 */
function readXmlNodes(text, tag, attr, fallbackText = null, linkAttr = null, noteReader = null, styleReader = null) {
  const src = String(text || '').trim();
  if (!src) return null;
  let doc = null;
  try {
    const P = globalThis.DOMParser;
    if (!P) return null;
    doc = new P().parseFromString(src, 'application/xml');
  } catch { return null; }
  if (!doc) return null;
  // 解析错误时 DOMParser 会返回一个 <parsererror> 文档，而不是抛异常
  if (doc.getElementsByTagName('parsererror').length) return null;
  const nodes = doc.getElementsByTagName(tag);
  if (!nodes.length) return null;

  const rows = [];
  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    let t = el.getAttribute(attr) ?? '';
    // 主属性取不到（缺属性 / 空值）时才用兜底 —— 有值就以它为准，往返不受影响
    if (!String(t ?? '').trim() && fallbackText) t = fallbackText(el) ?? '';
    rows.push({
      depth: depthOf(el),
      text: t,
      collapsed: String(el.getAttribute('FOLDED') || '').toLowerCase() === 'true',
      // BUG 111：FreeMind 的 LINK / OPML 的 url 都是**标准属性**，别的软件
      // 普遍读写。早先只读 TEXT/text，于是导入别人的文件时节点上的链接
      // 全部静默消失 —— 不报错，用户只会觉得"这软件不支持超链接"。
      link: linkAttr ? String(el.getAttribute(linkAttr) || '') : '',
      // BUG 113：FreeMind 的备注在 `<richcontent TYPE="NOTE">` 里（XHTML）。
      note: noteReader ? String(noteReader(el) || '') : '',
      // BUG 114：颜色（COLOR / BACKGROUND_COLOR）
      style: styleReader ? styleReader(el) : null,
    });
  }
  return rows;

  function depthOf(el) {
    let d = 0;
    let p = el.parentNode;
    while (p) {
      if (p.nodeName === tag) d++;
      p = p.parentNode;
    }
    return d;
  }
}

/** 把折叠状态按先序回填到树上 */
/** 行序列里的链接回填到树上（与 applyCollapsed 同构：按前序一一对齐） */
function applyLinks(root, links) {
  let i = 0;
  walkKm(root, (n) => {
    const href = links && String(links[i] || '').trim();
    if (href) {
      n.data = n.data || {};
      n.data.hyperlink = href;
    }
    i++;
  });
}

/**
 * 取 <node> 的备注：`<richcontent TYPE="NOTE">`（FreeMind / Freeplane 的标准写法）。
 *
 * ⓘ 与 `freemindNodeText` 的区别：那边要的是**正文**（TYPE="NODE"），
 *   这边要的是**备注**（TYPE="NOTE"），两者互斥 —— 把 NOTE 当正文会让节点
 *   文字变成备注内容（BUG 113 之前这里根本不读，备注整条静默消失）。
 */
function freemindNote(el) {
  const kids = el ? (el.children || el.childNodes) : null;
  if (!kids) return '';
  for (const c of Array.from(kids)) {
    if (String(c.nodeName || '').toLowerCase() !== 'richcontent') continue;
    if (String(c.getAttribute?.('TYPE') || '').toUpperCase() !== 'NOTE') continue;
    const txt = elToPlain(c);
    if (txt) return txt;
  }
  return '';
}

/**
 * XHTML **元素** → 纯文本（带换行）。
 *
 * 不能直接用 `textContent`：DOM 解析完标签已经没了，`<br/>` 和 `</p>` 都
 * 无从判断 —— 实测「第一行<br/>第二行」会变成「第一行第二行」，
 * 两个段落也会被拼成一段（BUG 113）。所以得自己走一遍子节点：
 * `<br>` 是换行，块级标签**结束**时补一个换行，其余只取文字。
 * XML 里的实体（`&lt;` `&amp;`）在文本节点里已经还原好了。
 */
function elToPlain(el) {
  let out = '';
  for (const c of Array.from(el.childNodes || [])) {
    if (c.nodeType === 3) { out += String(c.nodeValue || ''); continue; }
    if (c.nodeType !== 1) continue;
    const tag = String(c.nodeName || '').toLowerCase();
    if (tag === 'br') { out += '\n'; continue; }
    out += elToPlain(c);
    if (/^(p|div|li|h[1-6]|tr|blockquote|ul|ol|table|pre)$/.test(tag)) out += '\n';
  }
  return normalizeNoteText(out);
}

/** 行序列里的备注回填到树上（与 applyCollapsed / applyLinks 同构） */
function applyNotes(root, notes) {
  let i = 0;
  walkKm(root, (n) => {
    const t = notes && String(notes[i] || '').trim();
    if (t) {
      n.data = n.data || {};
      n.data.note = t;
    }
    i++;
  });
}

/**
 * 取 <node> 的颜色：`COLOR`（文字色）与 `BACKGROUND_COLOR`（填充色）。
 *
 * ⓘ 这两个是 FreeMind 1.0.1 的**标准属性**（Freeplane / XMind 的 FreeMind
 *   导入都认）。早先读侧一眼不看、写侧也不写，于是导入别人的 .mm 时节点
 *   颜色**静默丢失**，自己导出的 .mm 往返同样丢 —— 与 BUG 106（XMind 的
 *   样式键名写错）是同一类：给用户标色的节点导出再打开变回默认。
 */
function freemindStyle(el) {
  const out = {};
  const c = normColor(el?.getAttribute?.('COLOR'));
  if (c) out.color = c;
  const b = normColor(el?.getAttribute?.('BACKGROUND_COLOR'));
  if (b) out.background = b;
  return out;
}

/** 行序列里的颜色回填到树上（与 applyCollapsed / applyLinks / applyNotes 同构） */
function applyStyles(root, styles) {
  let i = 0;
  walkKm(root, (n) => {
    const st = styles && styles[i];
    if (st) {
      n.data = n.data || {};
      for (const k of Object.keys(st)) n.data[k] = st[k];
    }
    i++;
  });
}

function applyCollapsed(root, flags) {
  let i = 0;
  walkKm(root, (n) => {
    if (flags[i]) {
      n.data = n.data || {};
      n.data.expandState = 'collapse';
    }
    i++;
  });
}

/* ------------------------------------------------------------
   格式识别
   ------------------------------------------------------------ */

/**
 * 嗅探文本/文件名属于哪种格式（纯函数，可测）。
 *
 * **先按内容、后按扩展名**：用户常把 `.opml` 存成 `.xml`、
 * 把 `.mmd` 存成 `.txt`，只认扩展名会大面积误判。
 *
 * @returns {'xmind'|'freemind'|'opml'|'mermaid'|'plantuml'|'markdown'|'json'|null}
 */
export function detectFormat(text, name = '') {
  const src = String(text || '');
  const head = src.slice(0, 4096).trim();
  const ext = (String(name).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';

  // 内容嗅探优先
  if (head.startsWith('{') || head.startsWith('[')) {
    try { JSON.parse(src); return 'json'; } catch { /* 不是 JSON，继续 */ }
  }
  if (/<opml\b/i.test(head)) return 'opml';
  if (/<map\b/i.test(head)) return 'freemind';
  if (/^\s*mindmap\s*$/im.test(head.split('\n')[0] || '') || /^\s*mindmap\s*$/im.test(head)) return 'mermaid';
  if (/@startmindmap/i.test(head)) return 'plantuml';
  /*
   * **ATX 标题必须先于「裸 * 列表」判断** —— 顺序反了会丢内容。
   *
   * 后一条 `/^\*+\s+\S/` 是 PlantUML 片段的嗅探（无 @startmindmap 包裹时），
   * 而 Markdown 用 `*` 当项目符号同样命中它。实测：
   *
   *   '# 项目\n## 设计\n* 要点一\n* 要点二'
   *     原顺序 → plantuml → 解析成「要点一 | 要点二」
   *             **两个标题全丢**，只剩列表项
   *     改后   → markdown → 「项目 / 设计」，符合文件本意
   *
   * 判据：PlantUML mindmap 的行首是 `*`/`**`，**不会**出现 `# 标题`；
   * 而带 `#` 标题的文件必然是 Markdown。两者同时出现时，Markdown 是唯一合理解。
   */
  if (/^\s*#{1,6}\s+\S/m.test(head)) return 'markdown';
  // PlantUML 片段（无包裹标记）—— 走到这里说明没有 ATX 标题，不会误吃 Markdown
  if (/^\*+\s+\S/m.test(head)) return 'plantuml';

  // 兜底：按扩展名
  if (ext === 'xmind') return 'xmind';
  if (ext === 'mm') return 'freemind';
  if (ext === 'opml') return 'opml';
  if (ext === 'mmd' || ext === 'mermaid') return 'mermaid';
  if (ext === 'puml' || ext === 'plantuml') return 'plantuml';
  if (ext === 'json') return 'json';
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  return null;
}

/**
 * 从文件名取标题主干（纯函数，可测）。
 *
 * 导入交换格式时用文件名当画布标题 —— 否则新画布一律叫「画布 1」，
 * 连导几张之后用户分不清哪个是哪个。
 *
 * 去掉路径分隔符（Windows 的 `\` 与 POSIX 的 `/`）和最后一个扩展名；
 * 空结果给回 fallback，避免出现标题为空的画布。
 */
export function baseTitle(name, fallback = '导入的脑图') {
  const s = String(name ?? '').trim();
  const base = s.split(/[\\/]/).pop() || '';
  const stem = base.replace(/\.[^.]*$/, '').trim();
  return stem || fallback;
}

/** 各格式的显示名与扩展名，供 UI 与提示复用 */
/**
 * 节点自定义样式的 data 键 —— 与 xmind.js 的 `StyleMap` 对齐，另加内核用的
 * 三个字重/字形键。交换格式（.mm / .opml / .mmd / .puml）**一律不带样式**，
 * 这里只用来数「有多少节点设了样式」，好让导出时说清楚丢了什么。
 */
const NODE_STYLE_KEYS = [
  'background', 'node-stroke', 'node-stroke-width', 'node-radius',
  'node-line-stroke', 'node-line-width', 'color', 'font-size',
  'font-family', 'text-align', 'vertical-align',
  'font-weight', 'font-style', 'font-strikethrough',
];

/**
 * 各交换格式**实际带得走**的字段（其余一概装不下）。
 *
 * ⓘ 折叠状态只有 FreeMind 带得走（`FOLDED`），OPML / Mermaid / PlantUML
 *   都不带 —— 早先 exportExchange 的注释写「只带文字+层级+折叠状态」，
 *   把这三种也算进去了，与实测不符（BUG 111）。
 * ⓘ 超链接：FreeMind 走 `LINK`、OPML 走 `url`，都是规范属性（BUG 111 补上）。
 * ⓘ 备注：FreeMind 走 `<richcontent TYPE="NOTE">`（BUG 113 补上）。
 * ⓘ 样式：FreeMind 只带得走**颜色**两项（`COLOR` / `BACKGROUND_COLOR`，
 *   BUG 114 补上）—— 字号 / 圆角 / 连线等一概没有对应属性，仍是丢的。
 */
export const EXCHANGE_KEEP = {
  freemind: { hyperlink: true, collapsed: true, note: true,
    styleKeys: ['color', 'background'] },
  opml: { hyperlink: true },
  mermaid: {},
  plantuml: {},
};

/**
 * 数一数导成交换格式会**丢**多少东西。
 *
 * 这些格式只装得下文字和层级；备注、优先级、进度、标签、自定义样式一概
 * 不带（超链接与折叠状态看 `EXCHANGE_KEEP`）。不说的话，用户拿 .opml 当
 * 备份、日后导回来才发现备注和进度全没了 —— 而**导入是整体替换且不可
 * 撤销**，那时已经晚了。导出那句提示是唯一的机会（同 deepNodeCount）。
 *
 * @param {string|object} content 画布内容（kityminder JSON 文本或对象）
 * @param {string} kind freemind / opml / mermaid / plantuml
 * @returns {{note:number, hyperlink:number, priority:number, progress:number,
 *            labels:number, collapsed:number, style:number, nodes:number}}
 *          各类**受影响节点数**（nodes = 去重后的合计节点数）
 */
export function exchangeLoss(content, kind) {
  const keep = EXCHANGE_KEEP[kind] || {};
  const out = { note: 0, hyperlink: 0, priority: 0, progress: 0,
    labels: 0, collapsed: 0, style: 0, nodes: 0 };
  const km = parseKm(content);
  if (!km) return out;
  const touched = new Set();
  const bump = (node, key) => {
    if (node?.data?.id != null) touched.add(String(node.data.id));
    else touched.add(node);
    out[key]++;
  };
  walkKm(km.root, (n) => {
    const d = n?.data || {};
    if (!keep.note && String(d.note || '').trim()) bump(n, 'note');
    if (!keep.hyperlink && String(d.hyperlink || '').trim()) bump(n, 'hyperlink');
    const pri = Number(d.priority);
    if (pri >= 1 && pri <= 9) bump(n, 'priority');
    const pg = Number(d.progress);
    if (pg > 0) bump(n, 'progress');
    if (Array.isArray(d.labels) && d.labels.length) bump(n, 'labels');
    if (!keep.collapsed && isCollapsed(n)) bump(n, 'collapsed');
    // BUG 114：按格式细分 —— FreeMind 带得走颜色两项，只设了颜色的节点
    // 不该被算成"样式丢失"（早先一刀切会误报）。
    const keepStyles = keep.styleKeys || [];
    if (NODE_STYLE_KEYS.some((k) => d[k] != null && String(d[k]) !== ''
      && !keepStyles.includes(k))) bump(n, 'style');
  });
  out.nodes = touched.size;
  return out;
}

/**
 * XMind 备注的 **XHTML → 纯文本**。
 *
 * XMind 把备注同时存成两份（见 buildTopic 的说明）：`plain` 是纯文本，
 * `realHTML` 是 XHTML。别的软件（XMind 2020+、各类生成工具）常常**只写
 * realHTML**，于是只认 plain 的读法会把备注**整条静默丢掉** —— 实测
 * `{realHTML:{content:'<p>这是备注</p>'}}` 导入后 `data.note` 是 undefined，
 * 节点上看着像从来没写过备注，也不报错。
 *
 * 直接把 XHTML 当文本存更糟：面板那个单行输入框会原样显示 `<p>第一行</p>`，
 * 用户看到的是一串标签。所以块级标签要变成换行、行内标签去掉、实体还原。
 *
 * ⓘ FreeMind 的 `<richcontent TYPE="NOTE">` 同样是 XHTML（BUG 113），
 *   所以这两个函数从 xmind.js 提到这里共用 —— 各写一份迟早对不上。
 */
export function htmlToPlain(html) {
  let s = String(html ?? '');
  if (!s) return '';
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|blockquote)>/gi, '\n');
  s = s.replace(/<[^>]*>/g, '');                    // 剩下的（含行内标签）直接去掉
  s = s.replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');                       // & 必须最后解，否则二次反转义
  return normalizeNoteText(s);
}

/**
 * 颜色归一到 FreeMind 认得的 `#rrggbb`。
 *
 * FreeMind / Freeplane 的 `COLOR` / `BACKGROUND_COLOR` 只吃 `#rrggbb`；
 * 而 kityminder 的色值是 CSS，什么写法都可能有（`#f00` 缩写、`rgb()`、
 * 具名色）。能算出来的都算；算不出来的原样返回 —— 至少本工具自己往返
 * 不丢（写进 .mm 是转义过的字符串，不会把文件搞成坏 XML）。
 */
function normColor(v) {
  let s = String(v ?? '').trim();
  if (!s) return '';
  if (/^#[0-9a-f]{3}$/i.test(s)) {
    return '#' + s.slice(1).split('').map((ch) => ch + ch).join('').toLowerCase();
  }
  if (/^#[0-9a-f]{6}$/i.test(s)) return s.toLowerCase();
  const m = s.match(/^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/i);
  if (m) {
    const hex = m.slice(1, 4)
      .map((x) => Math.max(0, Math.min(255, Number(x))).toString(16).padStart(2, '0'))
      .join('');
    return '#' + hex;
  }
  return s;
}

/** 备注纯文本的收尾归一化（去行尾空白、合并空行、去首尾空行） */
function normalizeNoteText(s) {
  return String(s ?? '').replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 纯文本 → XMind 备注的 XHTML（写 realHTML 时用）。
 *
 * 段落按空行/换行拆成 `<p>`；`&<>` 必须转义，否则 XMind 解析这段 XHTML
 * 时会把它当成标签 —— 备注里写「a < b」就足以让整段备注显示不出来。
 */
export function plainToHtml(text) {
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const ps = String(text ?? '').split(/\n{2,}/).map((p) =>
    `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`);
  return ps.join('');
}

export const FORMAT_META = {
  freemind: { label: 'FreeMind', ext: 'mm', mime: 'application/xml', note: 'FreeMind / Freeplane / XMind 可导入' },
  opml: { label: 'OPML', ext: 'opml', mime: 'text/x-opml', note: 'OmniOutliner / Workflowy / 幕布 等大纲工具' },
  mermaid: { label: 'Mermaid', ext: 'mmd', mime: 'text/plain', note: 'GitHub / GitLab / Notion / Obsidian 原生渲染' },
  plantuml: { label: 'PlantUML', ext: 'puml', mime: 'text/plain', note: 'PlantUML / Confluence / 多数 Wiki' },
};
