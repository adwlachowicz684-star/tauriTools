/**
 * 复制文本（全项目共用）
 * ============================================================
 *
 * 为什么首选 Rust 侧 fpx_copy_text 而不是 navigator.clipboard：
 *   宿主注释里写得很清楚 —— 插件拿不到 `allow-clipboard-write`，
 *   navigator.clipboard 会**静默失败**（点了没反应也不报错）。
 *
 * 所以：能用后端就用后端，用不了才退前端，两条都不成就明确返回 false，
 * 由调用方提示 —— 绝不允许"点了没反应"。
 *
 * 【为什么抽到 js/ 而不是留在 md 插件里】
 * 设置页的「依赖」页签也要复制安装命令。各写一份的话，
 * 将来某一处改了降级顺序，另一处就变成"复制失败但不报错"。
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
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到下面走 execCommand 兜底。
       不在这里 return false：navigator.clipboard 有两个会踩的前提
       —— 需要安全上下文、且文档处于焦点（js/host.js 里记过：
       弹窗刚渲染时焦点未必满足）。任一不满足都会 reject，
       而 execCommand 在这两种情况下**仍然可用**，
       直接判死会把本来能复制的场景变成"点了没反应"。 */
  }

  /* 最后一档兜底：execCommand 是老 API，但它是唯一在
     非安全上下文（比如 file:// 打开）与无焦点文档里还能用的。
     本文件原本缺这一档，于是"后端不可用 + navigator 被拒"时
     直接返回 false，调用方提示复制失败 —— 而同样的场景里
     js/host.js 与 plugins/project-group/utils/clipboard.ts
     都靠这一档成功了。三份实现里只有这份漏了，故补齐对齐。 */
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 不能 display:none —— 那样选不中。挪到视口外即可
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export default copyText;
