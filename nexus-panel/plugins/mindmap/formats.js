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
export function nodeText(n, fallback = '未命名') {
  const t = String(n?.data?.text ?? '')
    .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ')
    .trim();
  return t || fallback;
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

/** 由 (depth, text) 序列重建 kityminder 树（纯函数，可测） */
export function rowsToKm(rows, rootFallback = '中心主题') {
  const list = (rows || []).filter((r) => r && String(r.text ?? '').trim());
  if (!list.length) {
    return { root: { data: { text: rootFallback }, children: [] } };
  }
  const make = (text) => ({ data: { text: String(text).trim() }, children: [] });
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
    out.push({ depth, text: nodeText(n, ''), collapsed: isCollapsed(n) });
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
    // 根节点不需要 FOLDED（根永远展开）
    if (depth > 0 && isCollapsed(n)) attrs.push('FOLDED="true"');
    const kids = n?.children || [];
    if (!kids.length) {
      lines.push('  '.repeat(depth + 1) + `<node ${attrs.join(' ')}/>`);
      return;
    }
    lines.push('  '.repeat(depth + 1) + `<node ${attrs.join(' ')}>`);
    for (const c of kids) emit(c, depth + 1);
    lines.push('  '.repeat(depth + 1) + '</node>');
  }
}

/**
 * FreeMind XML → 画布内容。
 * 只认 <node> 的 TEXT 属性；其余（edge/font/hook/cloud）一概忽略 ——
 * 它们承载的都是样式，本工具的主题体系不认。
 */
export function fromFreemind(text) {
  const rows = readXmlNodes(text, 'node', 'TEXT');
  if (!rows) return null;
  if (!rows.length) return null;
  const { root } = rowsToKm(rows);
  // 折叠状态回填
  applyCollapsed(root, rows.map((r) => r.collapsed));
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
  const rows = readXmlNodes(text, 'outline', 'text');
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
const MERMAID_NEEDS_QUOTE = /[()[\]{}"#;:,`]|^\s|\s$|\s\s/;

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
    // 头行 / 指令行
    if (/^\s*mindmap\s*$/i.test(raw)) continue;
    if (/^\s*(%%|\/\/:)/.test(raw)) continue;      // 注释
    const indent = (raw.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '  ').length;
    const body = mermaidTextOf(raw);
    if (!body) continue;
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
  const anyMarker = src.some((l) => /@startmindmap/i.test(l));
  for (const raw of src) {
    const line = raw.trim();
    if (/@startmindmap/i.test(line)) { inBlock = true; continue; }
    if (/@endmindmap/i.test(line)) { inBlock = false; continue; }
    if (anyMarker && !inBlock) continue;
    if (!line || line.startsWith("'")) continue;
    const m = line.match(/^(\*+)\s*(.*)$/);
    if (!m) continue;
    const t = m[2].trim();
    if (!t) continue;
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
function readXmlNodes(text, tag, attr) {
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
    rows.push({
      depth: depthOf(el),
      text: el.getAttribute(attr) ?? '',
      collapsed: String(el.getAttribute('FOLDED') || '').toLowerCase() === 'true',
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
export const FORMAT_META = {
  freemind: { label: 'FreeMind', ext: 'mm', mime: 'application/xml', note: 'FreeMind / Freeplane / XMind 可导入' },
  opml: { label: 'OPML', ext: 'opml', mime: 'text/x-opml', note: 'OmniOutliner / Workflowy / 幕布 等大纲工具' },
  mermaid: { label: 'Mermaid', ext: 'mmd', mime: 'text/plain', note: 'GitHub / GitLab / Notion / Obsidian 原生渲染' },
  plantuml: { label: 'PlantUML', ext: 'puml', mime: 'text/plain', note: 'PlantUML / Confluence / 多数 Wiki' },
};
