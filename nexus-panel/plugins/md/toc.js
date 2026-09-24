/**
 * 目录（TOC）—— 从**已渲染的 DOM** 里读标题，不自己算 slug。
 * ============================================================
 *
 * 为什么不用"解析源码算锚点"：
 *   标题的 id 由 rehype-slug（github-slugger）生成，规则并不只是
 *   "小写 + 空格换 -"：它会去重（同名标题追加 -1）、处理 emoji、
 *   剥离标点。自己照抄一份几乎必然漂移 ——
 *   表现为"点了 TOC 没反应"（getElementById 拿到 null），
 *   而这种失效**不报错**，只有点了才知道。
 *
 * 所以直接问 DOM：id 是多少就是多少，零重复逻辑。
 * ============================================================
 */

/** 参与 TOC 的标题级别（h1~h6 全要，靠 level 缩进体现层级） */
const HEADING_SEL = 'h1, h2, h3, h4, h5, h6';

/**
 * 从渲染根节点里抽出标题列表。
 *
 * @param {Element|null|undefined} root 渲染容器（.md-out）
 * @returns {Array<{level:number, text:string, id:string}>}
 *
 * 只收**带 id** 的：rehype-slug 给每个标题都加了，
 * 没有 id 的说明不是标题（或插件被摘掉了），
 * 收进来只会产生点了没反应的条目。
 */
export function headingsOf(root) {
  if (!root || typeof root.querySelectorAll !== 'function') return [];
  const nodes = root.querySelectorAll(HEADING_SEL);
  const out = [];
  for (const el of Array.from(nodes)) {
    const id = el.getAttribute('id');
    if (!id) continue;
    /* 标题里可能有代码/强调等子元素，textContent 取的是拼接后的纯文本，
       正是 TOC 该显示的东西。 */
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const level = Number(String(el.tagName || '').replace(/^h/i, '')) || 1;
    out.push({ level, text, id });
  }
  return out;
}

/**
 * 当前应该高亮哪一项。
 *
 * 取"最后一个已经滚过顶部的标题"：
 *   · 没有标题在顶部之上（还在文档开头）→ 返回 null，不高亮任何一项。
 *     返回第 0 项会让"还没开始看"就高亮第一节，与直觉不符。
 *
 * @param {Array<{id:string}>} items
 * @param {Element|null} root
 * @param {number} offset 顶部容差：标题刚过顶一点点就该切高亮，
 *                        取 0 会在标题恰好贴顶时来回抖
 */
export function activeIdOf(items, root, offset = 8) {
  if (!items?.length || !root) return null;
  let current = null;
  for (const it of items) {
    const el = root.querySelector(`[id="${cssEscape(it.id)}"]`);
    if (!el) continue;
    /* getBoundingClientRect().top 是相对视口的；容器自己滚动时，
       容器顶部就是基准线，减掉它才算"滚过容器顶部多少"。 */
    const base = root.getBoundingClientRect().top;
    if (el.getBoundingClientRect().top - base - offset <= 0) current = it.id;
    else break;
  }
  return current;
}

/** 极简 CSS 转义：id 里出现引号会破坏选择器，其它字符在属性选择器里是安全的 */
function cssEscape(v) {
  return String(v).replace(/["\\]/g, '\\$&');
}
