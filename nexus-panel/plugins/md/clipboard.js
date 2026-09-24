/**
 * 复制文本（F3 / F5 共用）
 * ============================================================
 *
 * 为什么首选 Rust 侧 fpx_copy_text 而不是 navigator.clipboard：
 *   宿主注释里写得很清楚 —— 插件拿不到 `allow-clipboard-write`，
 *   navigator.clipboard 会**静默失败**（点了没反应也不报错）。
 *   md 目前是同页插件（与宿主同文档），但那是"它恰好不是 iframe"，
 *   不是"复制一定可用"；改回 iframe 就会突然失效。
 *
 * 所以：能用后端就用后端，用不了才退前端，两条都不成就明确报 false，
 * 由调用方提示 —— 绝不允许"点了没反应"。
 */

/**
 * @param {{invoke?: Function}|null|undefined} ctx
 * @param {string} text
 * @returns {Promise<boolean>}
 */
export async function copyText(ctx, text) {
  if (!text) return false;

  if (typeof ctx?.invoke === 'function') {
    try {
      await ctx.invoke('fpx_copy_text', { text });
      return true;
    } catch {
      /* 落到下面走前端兜底。
         不在这里 return false：后端失败不代表前端也失败，
         直接判死会把本来能复制的场景变成"点不动"。 */
    }
  }

  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
