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
 * 中心主题的默认文案。
 *
 * 放在这里（而不是用得到它的 workbook.js）是因为**导入侧插虚拟根**是
 * formats.js 里的能力（OPML 多顶层 / PlantUML 多根 / Markdown 多顶层），
 * 而 workbook.js 反过来依赖 formats.js —— 常量只能住在依赖的下游。
 *
 * 常量化的理由（BUG 146 时记过一次）：它有多个使用处（新建画布、空画布、
 * 导入时插的虚拟根、rowsToKm 的根兜底）。各写一份 '中心主题' 的话，
 * 改一处不改另一处就会出现「导入出来的中心主题和新建画布的不一样」
 * 这种看不出原因的偏差。
 */
export const ROOT_TEXT = '中心主题';

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

/**
 * 字号取**数字部分**：`"20pt"` / `"20px"` / `"1.2em"` 一律 → `"20"` / `"20"` / `"1.2"`。
 * 拿不到数字（`'large'` 之类）返回 null（不是 0）—— 让调用方**不设**这个键、
 * 回落主题默认字号，比塞一个 NaN 进内核好（BUG 117：带单位的值会让
 * `line-height * font-size` 算成 NaN，实测 `<text y="NaN">`、文字位置错乱）。
 *
 * ⓘ 原本是 xmind.js 的私有函数（BUG 117 加的）。FreeMind 的 `<font SIZE>`
 *   同样要剥单位（BUG 127），两份实现迟早对不上 —— 提到这里共用。
 */
export const fontSizeNum = (v) => {
  const m = /^([+-]?\d+(?:\.\d+)?)/.exec(String(v ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? String(n) : null;
};

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
 * 顶层条目不止一个时，插一个虚拟中心主题把它们挂上去（纯函数，可测）。
 *
 * kityminder 必须有且只有一个 root，而这些格式的顶层条目可以有任意多个。
 * 不插的话，rowsToKm 会把 `rows[0]` 当根、其余顶层行挂到它下面 ——
 * **并列变成父子**，层级被静默改掉、不报错、不计入任何提示。
 *
 * 判据是统一的不变量：**插完之后 rows[0] 必须严格浅于其余所有行**，
 * 两个条件缺一不可 ——
 *   · minDepth < rows[0].depth：首行后面还有更浅的行
 *   · 顶层同级 ≥ 2 条：并列的首层需要有共同父亲
 *
 * 各格式的来历（同一条约束，历史上分别修过，各写一份就会漏）：
 *   BUG 146 · Markdown 顶层同级条目被串成父子链
 *   BUG 147 · Markdown 更浅的标题被挂到更深的标题下面
 *   BUG 148 · PlantUML 的 **Multiroot**（官方文档有这一节）被串成父子
 *   · OPML 多顶层 outline（最早的一处，原本只判了「深度 0 且有两条」）
 *
 * ⓘ **Mermaid 不走这里**：官方文档写明「one root per diagram」，而 Mermaid
 *   常见写法里 root 是**顶格**的（缩进 0），子节点同样缩进 0 —— 在那里按
 *   「顶层同级 ≥ 2」插虚拟根，会把正常的 `root / A / B` 凭空加一层
 *   （实测过，是回归）。多顶层 .mmd 本身就不合规范，保持原样。
 *
 * @param {Array<{depth:number,text:string}>} rows
 * @param {string} [rootText] 虚拟根文案，默认 ROOT_TEXT
 * @returns {Array} 新数组（不改动入参）
 */
export function rowsWithVirtualRoot(rows, rootText = ROOT_TEXT) {
  const list = (rows || []).filter((r) => !!r);
  if (!list.length) return list;
  const minDepth = list.reduce((m, r) => Math.min(m, r.depth), list[0].depth);
  let topCount = 0;
  for (const r of list) if (r.depth === minDepth) topCount++;
  if (minDepth < list[0].depth || topCount >= 2) {
    return [{ depth: minDepth - 1, text: rootText }, ...list];
  }
  return list;
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
export function rowsToKm(rows, rootFallback = ROOT_TEXT) {
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
export function toFreemind(content, rels = null) {
  const km = parseKm(content);
  if (!km) return '';
  /*
   * BUG 128：箭头连线（`<arrowlink DESTINATION>`）。
   *
   * 关系线是**内容**，不是装饰 —— 两个节点之间「有关联」是用户写进去的。
   * 早先导入别人的 .mm 时整条丢、导出时也不写：导入 → 改一点 → 导出，
   * 文件里的连接一条不剩，且不报错。与 XMind 的关系线（BUG 122）同一类。
   *
   * `DESTINATION` 引用的是**节点 ID**，所以端点节点必须带上 `ID` 属性；
   * 不在本画布里的端点先滤掉（死链画出来挂在空处，比不写更糟）。
   */
  const arrows = new Map();     // 起点节点 id → [终点节点 id]
  const endpoint = new Set();   // 需要写 ID 的节点
  if (Array.isArray(rels) && rels.length) {
    const present = new Set();
    walkKm(km.root, (n) => {
      const i = String(n?.data?.id ?? '').trim();
      if (i) present.add(i);
    });
    for (const r of rels) {
      if (!r || typeof r !== 'object') continue;
      const a = String(r.end1Id ?? '').trim();
      const b = String(r.end2Id ?? '').trim();
      if (!a || !b || a === b || !present.has(a) || !present.has(b)) continue;
      if (!arrows.has(a)) arrows.set(a, []);
      if (!arrows.get(a).includes(b)) arrows.get(a).push(b);
      endpoint.add(a);
      endpoint.add(b);
    }
  }
  const lines = [
    '<map version="1.0.1">',
    '<!-- 由 Nexus Panel 脑图导出 -->',
  ];
  emit(km.root, 0);
  lines.push('</map>');
  return lines.join('\n') + '\n';

  function emit(n, depth) {
    const attrs = [`TEXT="${escXml(nodeText(n))}"`];
    // BUG 128：只有端点节点需要 ID（其余写了纯属噪音）
    const myId = String(n?.data?.id ?? '').trim();
    if (myId && endpoint.has(myId)) attrs.push(`ID="${escXml(myId)}"`);
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
    /*
     * **根节点也要写 FOLDED**（BUG 121）。
     *
     * 早先这里写的是 `depth > 0 && isCollapsed(n)`，注释理由是
     * 「根节点不需要 FOLDED（根永远展开）」—— 这条理由**只对 UI 成立**：
     * 内核 `CollapseCommand.queryState` 里有一句 `!b.isRoot()`，所以按钮和
     * 快捷键确实点不出「折叠根」。但**对数据不成立**：
     *
     *   · 内核 `isExpanded()` 是 `data.expandState !== 'collapse' && (isRoot() ||
     *     parent.isExpanded())` —— 根**会**读自己的 expandState；
     *   · 实测（真实 Chromium）：根折叠时整图包围盒 540×40 → **80×40**，
     *     子节点文字宽度全是 0。整张图收成一个节点，是**看得见的结构**；
     *   · 而根折叠**只能从导入来** —— 正是本函数这条路的输入。Freeplane /
     *     FreeMind 允许折叠根，`.xmind` 的 `branch:"folded"` 也会带进来
     *     （xmind.js 的 buildTopic 不分层级，根也照写）。
     *
     * 后果是：导入别人的 .mm（根带 FOLDED）→ 本工具如实收下 → 再导出，
     * FOLDED 就没了。而 `EXCHANGE_KEEP.freemind.collapsed = true` 又声称
     * 这个格式带得走折叠，于是 `exchangeLoss` 算出来 collapsed:0 / nodes:0，
     * **一个字都不提示**。同一个状态走 .xmind 保得住、走 .mm 悄悄丢掉。
     */
    if (isCollapsed(n)) attrs.push('FOLDED="true"');
    /*
     * BUG 127：`<font>` / `<icon>` / `<cloud>` 是 <node> 的**子元素**，
     * 早先一样都不写 —— 导入别人的 .mm 后这些全丢、再导出就没了。
     * 有子元素就必须写成开合标签（自闭合写法塞不进子元素）。
     */
    const inner = [];
    const fontAttrs = freemindFontAttrs(n?.data);
    if (fontAttrs) inner.push(`<font ${fontAttrs}/>`);
    for (const ic of Array.isArray(n?.data?.fmIcons) ? n.data.fmIcons : []) {
      const b = String(ic ?? '').trim();
      if (b) inner.push(`<icon BUILTIN="${escXml(b)}"/>`);
    }
    const cloud = String(n?.data?.fmCloud ?? '').trim();
    if (cloud) {
      inner.push(cloud && cloud !== '1' ? `<cloud COLOR="${escXml(cloud)}"/>` : '<cloud/>');
    }
    // BUG 128：箭头连线（官方属性表里没有"标题"这一项，所以只写指向）
    for (const dest of (myId && arrows.get(myId)) || []) {
      inner.push(`<arrowlink DESTINATION="${escXml(dest)}"/>`);
    }
    const pad = '  '.repeat(depth + 1);
    const kids = n?.children || [];
    if (!kids.length && !noteHtml && !inner.length) {
      lines.push(pad + `<node ${attrs.join(' ')}/>`);
      return;
    }
    lines.push(pad + `<node ${attrs.join(' ')}>`);
    if (noteHtml) lines.push(noteHtml);
    for (const one of inner) lines.push(pad + '  ' + one);
    for (const c of kids) emit(c, depth + 1);
    lines.push(pad + '</node>');
  }

  /** 内核的字体 data 键 → `<font>` 的属性串（没有则返回 ''） */
  function freemindFontAttrs(data) {
    const a = [];
    const fam = String(data?.['font-family'] || '').trim();
    if (fam) a.push(`NAME="${escXml(fam)}"`);
    // BUG 117：存量可能是 "20px" 之类带单位的脏值，只取数字部分
    const size = fontSizeNum(data?.['font-size']);
    if (size > 0) a.push(`SIZE="${size}"`);
    const w = String(data?.['font-weight'] || '').trim().toLowerCase();
    if (w === 'bold' || (Number(data?.['font-weight']) || 0) >= 600) a.push('BOLD="true"');
    if (String(data?.['font-style'] || '').trim().toLowerCase() === 'italic') a.push('ITALIC="true"');
    return a.length ? a.join(' ') : '';
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
 * FreeMind XML → 画布内容 + 箭头连线。
 *
 * 只认 <node> 的 TEXT 属性（缺则回落 richcontent）。`<edge>` / `<hook>` 之类
 * 一概忽略 —— 它们承载的都是样式，本工具的主题体系不认。
 *
 * ⓘ 早先这里的注释写着「其余（edge/font/hook/cloud）一概忽略」，而 font 与
 *   cloud 在 BUG 127 之后是要读的 —— **过期的注释比没注释更坏**：它会让
 *   下一个读代码的人以为这里丢东西是"有意为之"。
 *
 * 关系线（`<arrowlink>`）是**画布级**数据，`stringifyKm` 装不下（它只有 root），
 * 所以单独返回；`fromFreemind` 只回内容，保持既有签名不变。
 *
 * @returns {{content:string, xrelationships:Array}|null}
 */
export function parseFreemind(text) {
  const rows = readXmlNodes(text, 'node', 'TEXT', freemindNodeText, 'LINK', freemindNote,
    freemindStyle, freemindExtras);
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
  // BUG 127：图标 / 外框回填（<icon BUILTIN> / <cloud>）
  const extras = rows.map((r) => r.extra);
  applyExtras(root, extras);
  /*
   * BUG 128：箭头连线回填。必须在 applyExtras 之后 —— 它会给端点节点补
   * `data.id`，而 applyExtras 只写 fmIcons / fmCloud，谁先谁后不影响那两项。
   */
  const xrelationships = freemindRelationships(root, extras);
  return { content: stringifyKm(root), xrelationships };
}

/**
 * FreeMind XML → 画布内容（不含关系线）。
 * @see parseFreemind 需要关系线时用那个
 */
export function fromFreemind(text) {
  return parseFreemind(text)?.content ?? null;
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
  // ★ 走 rowsWithVirtualRoot（与 PlantUML / Markdown 同一份判据），不再自己
  //   写一份「深度 0 且有两条」—— 抄一份就必然只修一处（BUG 148 的教训）。
  const rows2 = rowsWithVirtualRoot(rows);
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
 * Mermaid 节点行里的**装饰后缀**：`::icon(fa fa-book)` 与 `:::className`。
 *
 * 两者都是 Mermaid 官方语法（图标 / CSS 类），渲染时**不进标签**——官方文档
 * 明写 CSS class 的 "the suffix is stripped from the rendered label"。
 * 不剥掉的话它们会整串留在节点文字里（实测 `A ::icon(fa fa-book)` 导回
 * 后节点文字就是这一整串）。
 *
 * ⓘ 只在**行尾**剥，且要求 `::icon(` 后面确实有收尾的 `)`：
 * 引号写法 `["A::icon(x)"]` 的结尾是 `"]` 而不是 `)`，不会被误伤 ——
 * 那是**用户真写着** `A::icon(x)` 的文字（我们的写侧遇到 `(` 一律加引号）。
 *
 * ★ `:::class` 那条**还要额外排除引号**（BUG 134）。
 *
 * 它吃的是「`:::` 之后到行尾的连续非空白」，而引号写法的行尾是 `"]` ——
 * 引号不是空白，于是整段 `:::cls"]` 被吃掉，行变成 `root["a`，取出的文字
 * 就是 `root["a`。实测：节点文字叫 `会议:::重要` 时导出再导回，文字变成
 * `root["会议` —— 既被截断、又残留一对引号残片，比"整串留在文字里"更糟
 * （那是 BUG 129 修之前的样子）。裸写法 `A:::urgent` 结尾没有引号，照常剥。
 */
const MERMAID_SUFFIX = /\s*(?:::icon\([^)]*\)|:::[^\s"]+)\s*$/;

/**
 * Mermaid 节点行的形状表（纯函数，可测）。
 *
 * 括号对齐全，顺序**先长后短**：`))Bang((` 必须排在 `)Cloud(` 之前，
 * 否则前者会被后者的 `\)(.*)\(` 误吃。
 *
 * ⓘ Cloud `)x(` 与 Bang `))x((` 是 Mermaid mindmap 的官方形状
 *   （Square `[x]` / Rounded `(x)` / Circle `((x))` / Hexagon `{{x}}` 之外
 *   的两种），早先只认前四种，于是导入别人的 .mmd 时节点文字带着一对
 *   括号尾巴：`)Cloud(` 导回还是 `)Cloud(`（BUG 129）。
 *
 * 开头的 id 是**可选**的，且必须紧跟某个形状符号 —— 否则像 `A)` 这种
 * 「文字里带右括号」的行会被当成 `id + cloud` 剥掉一个字母。
 */
const MERMAID_SHAPE = /^(?:(?:[A-Za-z_][\w-]*\s*)?(?:\(\((.*)\)\)|\["(.*)"\]|\[(.*)\]|\)\)(.*)\(\(|\)(.*)\(|\((.*)\)|\{\{(.*)\}\})|(.*))$/s;

/**
 * 从 Mermaid 节点行里剥出纯文字（纯函数，可测）。
 *
 * 处理 Square `id[x]` / Rounded `id(x)` / Circle `id((x))` / Hexagon `id{{x}}`
 * / Cloud `id)x(` / Bang `id))x((` / 引号 `id["x"]` / 裸文字，并剥掉
 * `::icon(…)` 与 `:::class` 后缀（BUG 129）。
 */
export function mermaidTextOf(line) {
  let s = String(line ?? '').trim();
  if (!s) return '';
  s = s.replace(MERMAID_SUFFIX, '');
  /*
   * 去掉开头的 id（如 `root((x))` 里的 root、`id1[x]` 里的 id1）并剥形状。
   *
   * **两步合成一条正则**：早先是「先剥 id、再剥形状」，而剥 id 用的是
   * 「id 后紧跟 `[` `(` `{`」—— Cloud / Bang 以 `)` 起头，加进去又会让
   * 文字 `A)` 里的 `A` 被当成 id 吃掉。合并成「id 可选 + 后面必须是完整
   * 形状」之后，`Plain`、`A)` 这类都落到 `(.*)` 兜底，不会误伤。
   *
   * ⓘ **必须要求后面有形状符号**，否则 `B`、`plan` 这类纯文字节点会被
   *   整条当成 id 吃掉，解析结果为空、节点直接丢失。
   *   （这个 bug 初版就有：回环测试里 B / B1 两个节点凭空消失。）
   */
  const m = s.match(MERMAID_SHAPE);
  let t = '';
  if (m) {
    t = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? m[6] ?? m[7] ?? m[8] ?? '';
    /*
     * Cloud / Bang 里的**成对引号**是 Mermaid 的「特殊字符包裹」，与 `["x"]`
     * 同义 —— 官方示例就写 `))"Bang 形状"((` 和 `)"云形状的节点"(`。
     * 不剥的话文字里多出一对引号。
     *
     * ⓘ **只剥这两个分支**：`["x"]` 那条不能跟着剥 —— 它的内部已经过
     *   unescMermaid 还原，用户真写着 `"引用"` 时取出来的就是 `"引用"`，
     *   再剥一次会把它吞掉（往返从 `"引用"` 变成 `引用`）。
     */
    if ((m[4] != null || m[5] != null) && t.length >= 2
      && t.charCodeAt(0) === 34 /* " */ && t.charCodeAt(t.length - 1) === 34) {
      t = t.slice(1, -1);
    }
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
    /*
     * **独立成行的 `::icon(…)` / `:::class`（BUG 129）。**
     *
     * Mermaid 里这两个写法是**给上一个节点加装饰**，不是节点 —— 官方示例
     * 就是 `A` 下面缩进一行 `::icon(fa fa-book)`。早先不认，于是它被当成
     * 一个真实节点，导回后凭空多出一个名叫 `::icon(fa fa-book)` 的子节点
     * —— 那是**结构被改**，比丢一个装饰严重得多。
     *
     * 装饰本身带不走（kityminder 的图标库是自带的，不是 Font Awesome /
     * Material 的 id，映射不过去），所以丢弃 —— 但**不能**因此生成一个节点。
     *
     * ⓘ 只认**整行就是**装饰：节点文字真叫 `::icon(x)` 时写侧会加引号
     *   （`["::icon(x)"]`，因为它含 `(`），行首是 `[`、不会命中这里。
     */
    if (/^\s*(?:::icon\([^)]*\)|:::[^\s]+)\s*$/.test(raw)) continue;
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

/**
 * 这一行是不是 PlantUML mindmap 的**节点行**（BUG 130）。
 *
 * 官方支持三套前缀：`*`（默认）、`+`（右侧分支）、`-`（左侧分支），
 * 层级就是前缀的个数（`+++` / `---` 都是第三层）。早先只认 `*`，
 * 于是别人的文件里用 `+ / -` 写的节点**整行被忽略** —— 节点消失、
 * 子树整层抬到祖父身上（与 BUG 98 / 99 / 100 同一类，只是换了个格式）。
 *
 * 判准"这是节点行"还有一个用途：`@startmindmap` / `@endmindmap`
 * 的标记判定必须**排除节点行**（BUG 104），否则节点文字里带这两个
 * 词时，那一行会被当标记吃掉。所以这个判据和下面的解析正则
 * 必须口径一致 —— 改成一处不改另一处，就会两头都错。
 */
const isPumlNodeLine = (line) => /^[*+-]/.test(String(line ?? '').trim());

/**
 * PlantUML 节点行：三套前缀（`*` / `+` / `-`，BUG 130）+ 可选的无边框下划线
 * （BUG 131）+ 文字。
 *
 * ⓘ 这个正则和 `isPumlNodeLine` 的判据必须一致 —— 两处口径不同就会
 *   一头认、另一头不认（BUG 130 的教训）。
 */
const PUML_LINE = /^(\*+|\++|-+)(_?)\s*(.*)$/;

/**
 * `[#…]` 里是不是一个**像颜色**的值（BUG 130）。
 *
 * 只剥"确实是颜色"的那一段：节点文字真的以 `[#1] 议题`、`[#2024 计划]`
 * 这类开头时不能被剥掉，否则是被静默改了内容。
 * PlantUML 的颜色写法是 `#RGB` / `#RRGGBB` / `#RRGGBBAA` 或颜色名（纯字母）。
 */
const isPumlColorTag = (v) => /^(?:[A-Za-z]{2,20}|[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(String(v ?? ''));

/** PlantUML mindmap → 画布内容（纯函数，可测） */
export function fromPlantUml(text) {
  const rows = [];
  let inBlock = false;
  const src = String(text || '').split(/\r?\n/);
  // 允许没有 @startmindmap / @endmindmap 包裹（有些片段只有 * 行）
  // ★ 只看**非节点行**（BUG 104；BUG 130 起节点行是 `* / + / -` 三套前缀）：
  //   节点行以 `*`（或 `+` / `-`）开头，文字里带 `@startmindmap`
  //   时也会被 `/@startmindmap/i` 命中，于是那一行被当成
  //   标记吃掉 —— 节点消失 + 子树抬层，与 Mermaid 的 `mindmap` 头行同一个毛病。
  const anyMarker = src.some((l) => !isPumlNodeLine(l) && /@startmindmap/i.test(l));
  for (const raw of src) {
    const line = raw.trim();
    // 同上：节点行永不参与标记判定
    if (!isPumlNodeLine(line)) {
      if (/@startmindmap/i.test(line)) { inBlock = true; continue; }
      if (/@endmindmap/i.test(line)) { inBlock = false; continue; }
    }
    if (anyMarker && !inBlock) continue;
    if (!line || line.startsWith("'")) continue;
    /*
     * `(_?)` 是**无边框节点**（BUG 131）。
     * PlantUML 官方的 boxless 写法：下划线紧跟在前缀**之后**、中间不留空格
     * （官方文档 boxless 一节的示例就是 `***_ Ubuntu`，WBS 里是 `-_ Task …`）。
     * 不剥的话下划线整串留在节点文字里（实测 `***_ Ubuntu` 导回是 `_ Ubuntu`）。
     *
     * ⓘ 中间**有空格**的（`** _ Ubuntu` / `** _internal`）不属于这个语法 ——
     *   那时下划线是文字的一部分，剥掉就是静默改内容。所以判据是"紧贴前缀"，
     *   不是"文字以 `_` 开头"。
     */
    const m = line.match(PUML_LINE);
    if (!m) continue;
    let t = m[3].trim();
    /*
     * **inline color `*[#Orange] …`**（BUG 130）。
     * PlantUML 官方的「节点颜色」写法，颜色标记不进标签，不剥就整串留在
     * 节点文字里（实测 `*[#pink] Root` 导回是 `[#pink] Root`）。
     *
     * ⓘ 只剥 `[#` 起头、且后面是合法颜色的那一小段 —— 节点文字真的以
     *   `[#争议]` 之类开头时会被剥掉，但这种写法本身会被 PlantUML 当颜色
     *   吃掉（后果一样），所以不影响往返。
     */
    t = t.replace(/^\[#([^\]]*)\]\s*/, (all, c) => {
      if (!isPumlColorTag(c)) return all;
      /*
       * BUG 144：**剥完就空的话，它是文字本身，不是装饰**。
       *
       * 节点文字正好是 `[#pink]` / `[#ff0000]` 这类合法颜色标记时，导出去的
       * 一行是 `* [#pink]` —— 与"给空节点上粉色"长得一模一样。剥掉之后 `t`
       * 变空，节点落成占位「未命名」，**内容被静默改掉**（而且是本工具自己
       * 导出再导入的路径）。
       *
       * 所以先算出剥完剩下的那段：没有内容就整段保留。
       * 有内容才剥（`[#pink] 议题` → `议题`，这是装饰的正确读法）。
       */
      return t.slice(all.length).trim() ? '' : all;
    });
    /*
     * **多行框 `: … ;`**（BUG 130）。
     * PlantUML 用 `:` 与 `;` 包住多行文本（官方示例 `**:right_1.1 right_1.2;`），
     * 两个符号都不属于标签内容。
     *
     * ⓘ 只处理**同一行内成对**的情况：真正的多行写法（`:` 在行尾、内容
     *   跨几行、`;` 单独一行）这边按行解析无从还原，那些行会被当成
     *   非节点行跳过 —— 与「不支持」等价，好过猜错。
     */
    if (t.length >= 2 && t.charCodeAt(0) === 58 /* : */ && t.charCodeAt(t.length - 1) === 59 /* ; */) {
      /*
       * BUG 144：同上面的颜色标记 —— 整段就是一对 `: ;`（如 `:;` / `: ;`）时
       * 剥完也是空，那是节点文字本身，不是没有内容的多行框。
       */
      const inner = t.slice(1, -1).trim();
      if (inner) t = inner;
    }
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
    rows.push({
      prefixLen: m[1].length,
      indent: (raw.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '  ').length,
      text: t,
    });
  }
  if (!rows.length) return null;

  /*
   * ★ PlantUML 有**两套**判层级的语法，形态不同、必须分开认（BUG 148）：
   *
   *   ① OrgMode 式：层级 = 前缀个数（`*` / `**` / `***`），缩进无关。
   *      官方的 Multiroot 示例就是这个形态：
   *        `* Root 1 / ** Foo / ** Bar / * Root 2 / ** Lorem / ** Ipsum`
   *      —— 顶层 `*` 可以有任意多个，各自是一棵独立的树。
   *   ② Markdown 缩进式：所有行都只有**一个**前缀字符，层级靠**缩进**
   *      （官方 "Markdown indented list" 一节，`* A /  * B /   * C`）。
   *
   * 只认形态 ① 的话，形态 ② 的 `* 项目 /  * 子一` 会被读成两个 depth 0
   * 的并列行；只认形态 ② 的话，`** Foo` 的层级整个没了。
   *
   * 判据：**出现过多字符前缀 → 形态 ①**；全是单字符前缀**且有缩进**
   * → 形态 ②。两者都不是（全是单字符、也都没缩进）就按形态 ① 处理 ——
   * 那时所有行都在同一列，本来就是并列。
   */
  const orgMode = rows.some((r) => r.prefixLen >= 2) || !rows.some((r) => r.indent > 0);
  if (orgMode) {
    for (const r of rows) r.depth = r.prefixLen - 1;
  } else {
    /*
     * 形态 ②：层级按**相对缩进的栈**算（与 Markdown 列表同一套算法）。
     * 官方示例是一格一层，但两格的文件同样常见 —— 写死比例必然错层，
     * 用栈则"缩进变大进一层、变小退回去"对两种都成立。
     */
    const indents = [rows[0].indent];
    rows[0].depth = 0;
    for (let i = 1; i < rows.length; i++) {
      const ind = rows[i].indent;
      while (indents.length > 1 && indents[indents.length - 1] > ind) indents.pop();
      if (indents[indents.length - 1] < ind) indents.push(ind);
      rows[i].depth = indents.length - 1;
    }
  }

  /*
   * ★ Multiroot（形态 ① 下顶层 `*` 有多个）：不插虚拟根的话，`rows[0]`
   *   当根、第二个根被挂成它的**子节点** —— 并列变成父子，层级静默改掉。
   *   走 rowsWithVirtualRoot，与 OPML 多顶层、Markdown 同一份判据。
   */
  const { root } = rowsToKm(rowsWithVirtualRoot(rows));
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
function readXmlNodes(text, tag, attr, fallbackText = null, linkAttr = null, noteReader = null, styleReader = null, extraReader = null) {
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
      // BUG 127：FreeMind 的 <icon> / <cloud>（内核没有对应概念，只保住往返）
      extra: extraReader ? extraReader(el) : null,
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
 *
 * ⓘ 标签名必须按**本地名**判，不能拿 nodeName 直接用：XMind 8 的
 *   `<richcontent>` 走 XML 命名空间，子标签是 `<xhtml:p>`（nodeName 就是
 *   `xhtml:p`），照 nodeName 判块级标签的话一个都匹配不上 —— 段又拼成一段了。
 *
 * ⓘ 本函数由 FreeMind 的 `<richcontent TYPE="NOTE">`（BUG 113）与 XMind 8
 *   的 `<notes>`（BUG 138）共用 —— 各写一份迟早只修一处。
 */
export function elToPlain(el) {
  let out = '';
  for (const c of Array.from(el.childNodes || [])) {
    if (c.nodeType === 3) { out += String(c.nodeValue || ''); continue; }
    if (c.nodeType !== 1) continue;
    const raw = String(c.nodeName || '');
    const tag = String(c.localName || raw.replace(/^.*:/, '') || '').toLowerCase();
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
  /*
   * BUG 127：`<font NAME SIZE BOLD ITALIC/>` 是 FreeMind 1.0.1 的**标准子元素**
   * （Freeplane 同样写它）。早先只读颜色两个属性，字号 / 字体 / 粗体 / 斜体
   * 一律不看 —— 导入别人的 .mm，节点上的字体样式**静默丢失**，而自己导出的
   * .mm 也从来不写，往返同样丢。
   *
   * 这四项与颜色不同：**内核本来就渲染它们**（font-size / font-family /
   * font-weight / font-style 都是 kityminder 的 data 键，见 xmind.js 的
   * StyleMap），读出来就能在画布上看见，不是"保住了但看不见"的那种。
   */
  const f = freemindFont(el);
  for (const k of Object.keys(f)) out[k] = f[k];
  return out;
}

/** `<font>` 里 BOLD / ITALIC 只认 `true`（FreeMind 规范值），大小写都吃掉 */
const isTrueAttr = (v) => String(v ?? '').trim().toLowerCase() === 'true';

/**
 * 取 <node> 的 `<font>` 子元素（FreeMind 的字体写法），没有则返回空对象。
 *
 * 只认第一个 —— FreeMind 一个节点只有一个 <font>。
 */
function freemindFont(el) {
  const out = {};
  const kids = el ? (el.children || el.childNodes) : null;
  for (const c of Array.from(kids || [])) {
    if (c.nodeType !== 1) continue;
    if (String(c.nodeName || '').toLowerCase() !== 'font') continue;
    const name = String(c.getAttribute?.('NAME') || '').trim();
    if (name) out['font-family'] = name;
    // SIZE 是 pt（FreeMind 的字号单位），与本项目写出去的单位一致（BUG 117）；
    // 别的软件也可能写 "20px"，同样只取数字（剥不出来就不设，不塞 NaN）
    const size = Number(fontSizeNum(c.getAttribute?.('SIZE')));
    if (size > 0) out['font-size'] = size;
    if (isTrueAttr(c.getAttribute?.('BOLD'))) out['font-weight'] = 'bold';
    if (isTrueAttr(c.getAttribute?.('ITALIC'))) out['font-style'] = 'italic';
    break;
  }
  return out;
}

/**
 * 取 <node> 上「内核没有对应概念」的几样东西：`<icon>` / `<cloud>`（BUG 127）
 * 与 `<arrowlink>`（BUG 128），外加节点自己的 `ID` 属性。
 *
 * `<icon BUILTIN="flag"/>` 是 FreeMind 的标记图标（与 XMind 的 marker 同类，
 * BUG 110），`<cloud>` 是节点外框（与 XMind 的 boundary 同类）。早先两者都
 * 不读 —— 导入别人的 .mm 静默消失、再导出就没了，**一句提示都没有**。
 *
 * **`<arrowlink DESTINATION="…"/>` 是 FreeMind 的箭头连线**，与 XMind 的
 * relationship 同类（BUG 122）：两个节点之间「有关联」是用户写进去的内容，
 * 不是装饰。`DESTINATION` 指向目标节点的 `ID`（FreeMind 官方 File format
 * 页写明 `destination (id of the target node)`），所以要连 `ID` 一起读。
 *
 * 保不住图标名里的脏字符（会写出别的软件打不开的 .mm），所以走白名单；
 * 封顶与 xmarkers 一致（20 个），防止畸形文件撑爆 data。
 */
function freemindExtras(el) {
  const icons = [];
  const arrows = [];
  let cloud = '';
  const kids = el ? (el.children || el.childNodes) : null;
  for (const c of Array.from(kids || [])) {
    if (c.nodeType !== 1) continue;
    const tag = String(c.nodeName || '').toLowerCase();
    if (tag === 'icon') {
      const b = String(c.getAttribute?.('BUILTIN') || '').trim();
      if (b && /^[A-Za-z0-9._-]{1,40}$/.test(b) && !icons.includes(b) && icons.length < 20) {
        icons.push(b);
      }
    } else if (tag === 'cloud' && !cloud) {
      // `<cloud COLOR="#f00"/>` 带颜色、`<cloud/>` 不带 —— 都用真值占位，
      // 写回时按有没有颜色还原（'1' 是占位，本身不是合法色值）
      cloud = normColor(c.getAttribute?.('COLOR')) || '1';
    } else if (tag === 'arrowlink' && arrows.length < 20) {
      const d = String(c.getAttribute?.('DESTINATION') || '').trim();
      if (d && /^[A-Za-z0-9._@:-]{1,64}$/.test(d)) arrows.push(d);
    }
  }
  const id = String(el?.getAttribute?.('ID') || '').trim();
  const hasId = /^[A-Za-z0-9._@:-]{1,64}$/.test(id);
  return (icons.length || cloud || arrows.length || hasId)
    ? { icons, cloud, arrows, id: hasId ? id : '' }
    : null;
}

/**
 * 行序列里的箭头连线 → 画布级 `xrelationships`（BUG 128）。
 *
 * **与 XMind 的关系线用同一份存储**（`xrelationships`），不要再立一套
 * 「FreeMind 专用」的字段 —— 一个概念存两处，迟早只修一处（BUG 127 之前
 * 的图标就是这么漏的）。好处是 .mm 导入的连接线导出 .xmind 时同样带得走。
 *
 * 行序与前序节点**一一对应**（与 applyCollapsed / applyLinks 等四个函数同构），
 * 所以按行号就能定位节点。
 *
 * 只有**两端都能定位**才收：
 *   · `DESTINATION` 指向的 ID 在文件里没有对应节点 → 死链，比不写更糟；
 *   · 指向自己 → 自环，画不出来。
 * 与 `readRelationships`（xmind.js）同一口径。
 *
 * 端点节点会被补上 `data.id`（优先用文件里原有的 ID）—— kityminder 的
 * 关系线按节点 id 引用，而 `rowsToKm` 建出来的节点**没有 id**。
 *
 * @param {object} root kityminder 根
 * @param {Array|null} extras 每行的 `freemindExtras` 结果
 * @returns {Array} `[{ id, end1Id, end2Id }]`
 */
export function freemindRelationships(root, extras) {
  if (!root || !Array.isArray(extras) || !extras.length) return [];
  const order = [];
  walkKm(root, (n) => order.push(n));
  const indexById = new Map();
  for (let i = 0; i < order.length && i < extras.length; i++) {
    const id = extras[i]?.id;
    if (id && !indexById.has(id)) indexById.set(id, i);
  }
  const ensureId = (i) => {
    const n = order[i];
    n.data = n.data || {};
    if (!String(n.data.id ?? '').trim()) {
      n.data.id = String(extras?.[i]?.id || '').trim() || genKmId();
    }
    return String(n.data.id);
  };
  const out = [];
  for (let i = 0; i < order.length && i < extras.length; i++) {
    const arrows = extras[i]?.arrows;
    if (!arrows || !arrows.length) continue;
    for (const dest of arrows) {
      if (out.length >= MAX_FREEMIND_ARROWS) break;
      const j = indexById.get(dest);
      if (j == null || j === i) continue;   // 死链 / 自环
      out.push({ id: genKmId(), end1Id: ensureId(i), end2Id: ensureId(j) });
    }
  }
  return out;
}

/** 关系线封顶（畸形文件几千条箭头连线会撑爆画布数据） */
const MAX_FREEMIND_ARROWS = 50;

const genKmId = () => 'fm' + Math.random().toString(36).slice(2, 10);

/** 行序列里的图标 / 外框回填到树上（与 applyCollapsed 等四个函数同构） */
function applyExtras(root, extras) {
  let i = 0;
  walkKm(root, (n) => {
    const e = extras && extras[i];
    if (e) {
      n.data = n.data || {};
      if (e.icons && e.icons.length) n.data.fmIcons = e.icons;
      if (e.cloud) n.data.fmCloud = e.cloud;
    }
    i++;
  });
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
 * 取 XML/HTML 文本的**根元素名**（小写），不是根元素则返回 ''。
 *
 * 用来按「这个文件的根元素是什么」判断格式，而不是按「某个字符串出现在哪」。
 * 跳过 `<?…?>` 声明、`<!…>`（DOCTYPE）、`<!--…-->` 注释与空白。
 */
function rootElementName(head) {
  let i = 0;
  const n = head.length;
  while (i < n) {
    while (i < n && /\s/.test(head[i])) i++;
    if (i >= n || head[i] !== '<') return '';
    if (head.startsWith('<?', i)) {
      const e = head.indexOf('?>', i);
      if (e < 0) return '';
      i = e + 2;
      continue;
    }
    if (head.startsWith('<!--', i)) {
      const e = head.indexOf('-->', i);
      if (e < 0) return '';
      i = e + 3;
      continue;
    }
    if (head.startsWith('<!', i)) {
      const e = head.indexOf('>', i);
      if (e < 0) return '';
      i = e + 1;
      continue;
    }
    const m = /^<\s*([A-Za-z][\w:.-]*)/.exec(head.slice(i));
    return m ? m[1].toLowerCase() : '';
  }
  return '';
}

/**
 * 第一行非空行 —— 用于把标记匹配锚在文件开头，
 * 而不是「文件里任何地方出现过就算」。
 *
 * ⓘ 早先这里还额外跳过 PlantUML 注释行（`'…` / `/'…'/`）。那一条是**观测不到**
 *   的：删掉它，带注释前缀的真 .puml 仍会被后面那条「行首 `*`/`**`」判成
 *   plantuml（mindmap 的节点行本来就是 `*` 开头）。留着一段无法验证、删掉也
 *   看不出差别的分支，只会让人以为它在把关（本项目第 N 次栽在这类"假把关"上），
 *   所以去掉 —— 判断依据写在变异验证记录里。
 */
function firstMeaningfulLine(head) {
  for (const raw of String(head).split('\n')) {
    const l = raw.trim();
    if (l) return l;
  }
  return '';
}

/**
 * 嗅探文本/文件名属于哪种格式（纯函数，可测）。
 *
 * **先按内容、后按扩展名**：用户常把 `.opml` 存成 `.xml`、
 * 把 `.mmd` 存成 `.txt`，只认扩展名会大面积误判。
 *
 * **标记必须锚在文件开头**（BUG 120）。早先写的是「前 4096 字符里出现过就算」：
 *
 *   /<opml\b/i     —— 一篇讲 OPML 的 Markdown 里写了「<opml version="2.0"> 是根标签」
 *   /<map\b/i      —— 讲 HTML `<map>` 标签的 Markdown 同理
 *   /mindmap\s*$/im —— 正文里任何一行恰好是 "mindmap" 就算
 *   /@startmindmap/i —— 代码块里举了个 PlantUML 例子就算
 *
 * 于是这四种**正经 Markdown** 被判成别的格式。后果分两种，都不好：
 *   · 判成 opml / freemind → 解析器返回 null → 弹「解析失败」，文件**根本导不进来**
 *   · 判成 mermaid / plantuml → 解析**成功**但内容是错的：
 *       实测 '# 项目\n## 设计\nmindmap\n## 开发' → 四个标题变成**并列的兄弟节点**，
 *       层级全乱；'@startmindmap' 那条更只剩一个节点，标题整段消失。
 *     这类是**静默**的 —— 导入是整体替换且不可撤销，用户事后才发现。
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
  // 按**根元素**判断：只认「这个文件本身就是 opml / map 文档」
  const rootName = rootElementName(head);
  if (rootName === 'opml') return 'opml';
  if (rootName === 'map') return 'freemind';
  // Mermaid mindmap 的「mindmap」是**第一行**
  if (/^mindmap\s*$/i.test(head.split('\n')[0] || '')) return 'mermaid';
  if (/^@startmindmap\b/i.test(firstMeaningfulLine(head))) return 'plantuml';
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
 * ⓘ Markdown 只带「文字 + 层级」：备注 / 超链接 / 优先级 / 进度 / 标签 /
 *   折叠状态 / 自定义样式一概装不下（BUG 116 起在导出时说清）。
 * ⓘ 样式：FreeMind 带得走**颜色**两项（`COLOR` / `BACKGROUND_COLOR`，
 *   BUG 114 补上）与**字体四项**（`<font NAME SIZE BOLD ITALIC/>`，
 *   BUG 127 补上）—— 圆角 / 连线 / 描边等一概没有对应属性，仍是丢的。
 * ⓘ `<icon>` / `<cloud>` 是 FreeMind 自家的标记图标与外框（BUG 127 补上），
 *   只有 .mm 带得走 —— 其余四种格式一律丢，所以按 `fmIcons` / `fmCloud`
 *   单独判，不能混进 `markers` / `boundary`（那两个是 XMind 的数据）。
 */
export const EXCHANGE_KEEP = {
  // 空对象 = 除了文字与层级，其余一概装不下（exchangeLoss 会全算成丢失）
  markdown: {},
  freemind: { hyperlink: true, collapsed: true, note: true,
    fmIcons: true, fmCloud: true,
    // BUG 128：箭头连线（`<arrowlink>`）带得走；但它的**标题**带不走 ——
    // FreeMind 官方属性表里 arrowlink 只有 color / destination /
    // startarrow / endarrow / startinclination / endinclination，没有标题。
    relationships: true,
    styleKeys: ['color', 'background',
      'font-family', 'font-size', 'font-weight', 'font-style'] },
  opml: { hyperlink: true },
  mermaid: {},
  plantuml: {},
};

/** `data.file` / `data.images` 这类字段：可能是数组串，也可能是单值 */
function oneOrList(raw) {
  if (raw == null || raw === '') return [];
  let v = raw;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { v = JSON.parse(v); } catch { /* 不是数组串，按单值处理 */ }
  }
  const arr = Array.isArray(v) ? v : [v];
  return arr.map((x) => String(x ?? '').trim()).filter(Boolean);
}

/**
 * 数一数导成交换格式会**丢**多少东西。
 *
 * 这些格式只装得下文字和层级；备注、优先级、进度、标签、自定义样式一概
 * 不带（超链接与折叠状态看 `EXCHANGE_KEEP`）。不说的话，用户拿 .opml 当
 * 备份、日后导回来才发现备注和进度全没了 —— 而**导入是整体替换且不可
 * 撤销**，那时已经晚了。导出那句提示是唯一的机会（同 deepNodeCount）。
 *
 * ⓘ 图片 / 附件 / 外框同样是一概装不下的（BUG 119）—— 早先这三类**没数**，
 *   于是挂了照片的节点导成 .opml / .md，图全没了却一句提示都没有
 *   （实测 5 个带图/附件/外框的节点，exchangeLoss 报 nodes=0）。
 *
 * ⓘ 标记图标（`xmarkers`）与**关系线**（画布级 `xrelationships`）同样是一概
 *   装不下的（BUG 123）。这两类是 BUG 110 / BUG 122 才有的数据，加进来时没
 *   同步计入 —— 于是导入别人的 .xmind（带红旗标记、带关系线）再导出成 .opml，
 *   图标和关系线全没了却一句提示都没有，实测 exchangeLoss 报 nodes=0。
 *   关系线是**画布级**字段，不在节点里，所以走第三个参数，且不计进 nodes
 *   （"涉及 N 个节点"对它不成立）。
 *
 * @param {string|object} content 画布内容（kityminder JSON 文本或对象）
 * @param {string} kind freemind / opml / mermaid / plantuml / markdown
 * @param {object} [sheet] 画布本身（用于数关系线）
 * @returns {{note:number, hyperlink:number, priority:number, progress:number,
 *            labels:number, collapsed:number, style:number, image:number,
 *            attachment:number, boundary:number, markers:number,
 *            relationships:number, nodes:number}}
 *          各类**受影响节点数**（nodes = 去重后的合计节点数；
 *          relationships 是关系线条数，不是节点数）
 */
export function exchangeLoss(content, kind, sheet) {
  const keep = EXCHANGE_KEEP[kind] || {};
  const out = { note: 0, hyperlink: 0, priority: 0, progress: 0,
    labels: 0, collapsed: 0, style: 0, image: 0, attachment: 0,
    boundary: 0, markers: 0, relationships: 0, nodes: 0 };
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
    /*
     * BUG 119：图片（槽位 + 横幅）与图标都装不下 —— 这五种格式里**没有一种**
     *   写 image，实测产物里连 "image" 字样都没有。
     *   图标也算：它同样会丢，且节点上突然少了个图标，用户看不出来为什么。
     */
    const imgs = oneOrList(d.image);
    for (const one of oneOrList(d.images)) imgs.push(one);
    if (!keep.image && imgs.length) bump(n, 'image');
    // 附件（文件 / 视频）：同样没有任何一种交换格式写得出去
    if (!keep.attachment
      && (oneOrList(d.file).length || oneOrList(d.video).length)) bump(n, 'attachment');
    // 外框（boundaryGroup）：交换格式没有对应概念
    if (!keep.boundary && String(d.boundaryGroup ?? '').trim()) bump(n, 'boundary');
    /*
     * BUG 123：不认识的 XMind 标记图标（BUG 110 收在 `xmarkers` 里）同样
     * 没有任何一种交换格式写得出去 —— 五种格式里连 "marker" 字样都没有。
     * 它是 BUG 110 才有的数据，加进来时漏了这一步。
     */
    if (!keep.markers && Array.isArray(d.xmarkers) && d.xmarkers.length) bump(n, 'markers');
    /*
     * BUG 127：FreeMind 的 `<icon>` 收在 `fmIcons` 里，同样只有 .mm 带得走。
     * 导入别人的 .mm（带图标）再导出成 .opml / .md，图标全没了却一句提示
     * 都没有 —— 与 BUG 123 漏掉 xmarkers 是同一个洞。
     */
    if (!keep.fmIcons && Array.isArray(d.fmIcons) && d.fmIcons.length) bump(n, 'markers');
    // BUG 127：FreeMind 的 `<cloud>` 收在 `fmCloud` 里，同理只有 .mm 带得走
    if (!keep.fmCloud && String(d.fmCloud ?? '').trim()) bump(n, 'boundary');
  });
  /*
   * BUG 123：关系线（BUG 122 收在画布级 `xrelationships`）同样装不下。
   * 它是**画布级**字段，不在节点里 —— 所以单独数，且**不计进 nodes**：
   * 一句"共涉及 N 个节点"对"画布上有几条线"不成立。
   *
   * ⓘ `keep.relationships` 为真时（目前只有 .mm，BUG 128）连线本身带得走，
   *   但**标题带不走**（FreeMind 的 arrowlink 没有标题属性）—— 所以数的是
   *   "有标题的线"：把整条线说成丢失是虚报，把丢标题说成没丢是瞒报。
   */
  const rels = Array.isArray(sheet?.xrelationships)
    ? sheet.xrelationships.filter((r) => r && (r.end1Id || r.end2Id))
    : [];
  out.relationships = keep.relationships
    ? rels.filter((r) => String(r.title ?? '').trim()).length
    : rels.length;
  out.nodes = touched.size;
  return out;
}

/** `exchangeLoss` 结果里需要跨画布累加的字段 */
const LOSS_KEYS = ['note', 'hyperlink', 'priority', 'progress', 'labels',
  'collapsed', 'style', 'image', 'attachment', 'boundary', 'markers',
  'relationships', 'nodes'];

/**
 * 多张画布合计的丢失统计（Markdown 导出用）。
 *
 * **不能拿当前画布一份代替整本工作簿**：`exportMarkdown` 导出的是
 * `workbookToMarkdown(workbook.sheets)` —— 全部画布，而 `exchangeLoss`
 * 只吃一张。用 `sheet()` 那份去算，等于只报当前画布的丢失 ——
 * 备注/图片挂在别的画布上时，提示整段不出现，用户拿到的是一句干净的
 * 「已保存」，等导回来才发现没了（导入是整体替换且不可撤销）。
 *
 * `nodes` 是**逐张相加**而不是按 id 去重：不同画布的节点 id 可能重复，
 * 但它们是不同的节点，去重会把损失数少报。
 *
 * @param {Array} sheets 画布数组
 * @param {string} kind 交换格式名
 * @returns {Object} 与 `exchangeLoss` 同形状，值为各画布之和
 */
export function exchangeLossAll(sheets, kind) {
  const out = {};
  for (const k of LOSS_KEYS) out[k] = 0;
  for (const s of sheets || []) {
    const one = exchangeLoss(s?.content, kind, s);
    for (const k of LOSS_KEYS) out[k] += Number(one?.[k]) || 0;
  }
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
