/**
 * 渲染区右键菜单（F5）
 * ============================================================
 * Markdown 里的链接和图片，读完想拿地址时只能"右键 → 复制"，
 * 而渲染出来的 <a> 是真实链接、<img> 是真实图片 ——
 * 浏览器原生菜单里的"复制链接"能用，但**在不同平台上项名不一致**，
 * 且图片可能是相对路径（相对 md 文件所在目录），复制出来粘到别处就废了。
 *
 * 这里给一份统一的菜单：
 *   · 链接 → 复制链接地址
 *   · 图片 → 复制图片地址 / 复制图片（Markdown 写法）
 *
 * 刻意**不做**"在新窗口打开"：那要 shell open 能力（M 类），
 * 而 md 是只读阅读器，不该有打开任意 URL 的权限。
 */

/**
 * 判断右键落在什么上。
 *
 * @param {Element|null} el 事件目标
 * @returns {{kind:'img'|'link', value:string, text?:string}|null}
 *
 * 顺序：先 img 再 a。
 * `<a><img></a>` 这种"图片即链接"很常见，落到图片上时
 * 用户想要的是图片地址；反过来的话图片链接永远拿不到图。
 */
export function targetOf(el) {
  if (!el || typeof el.closest !== 'function') return null;
  const img = el.closest('img');
  if (img) {
    return {
      kind: 'img',
      value: img.getAttribute('src') || '',
      text: img.getAttribute('alt') || '',
    };
  }
  const a = el.closest('a');
  if (a) {
    return {
      kind: 'link',
      value: a.getAttribute('href') || '',
      text: (a.textContent || '').trim(),
    };
  }
  return null;
}

/**
 * 生成菜单项。
 *
 * @param {{kind:string, value:string, text?:string}} t
 * @returns {Array<{key:string, label:string, value:string}>}
 *
 * value 为空时不给该项 —— 空字符串复制出来是个"什么都没发生"的复制，
 * 点了没反应又不报错，正是要避免的。
 */
export function menuItemsFor(t) {
  if (!t?.value) return [];
  if (t.kind === 'img') {
    return [
      { key: 'src', label: '复制图片地址', value: t.value },
      {
        key: 'md',
        label: '复制为 Markdown',
        value: `![${t.text || ''}](${t.value})`,
      },
    ];
  }
  return [{ key: 'href', label: '复制链接地址', value: t.value }];
}
