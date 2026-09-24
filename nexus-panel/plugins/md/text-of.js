/**
 * 从 React 子节点里取出纯文本。
 * ============================================================
 * 用途：代码块的复制按钮要拿**原始代码**，而 rehype-highlight 已经
 * 把它切成了一堆 <span class="hljs-keyword">…</span>。
 * textContent 拿不到（那是 DOM 才有的），只能递归 React 元素树。
 *
 * 为什么不能直接用 children 当字符串：
 *   children 是数组 / 元素，直接 String() 出来是 "[object Object]"，
 *   复制按钮会静默复制一串垃圾 —— 不报错，粘贴后才发现。
 */

/**
 * @param {*} node React 子节点
 * @returns {string}
 */
export function reactTextOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(reactTextOf).join('');
  /* React 元素：children 挂在 props 上。
     函数组件没有 props.children，走到这里返回 '' 是正确的
     —— 那不是文本节点。 */
  if (node.props && 'children' in node.props) return reactTextOf(node.props.children);
  return '';
}
