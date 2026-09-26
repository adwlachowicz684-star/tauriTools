/**
 * 主题参数的颜色拆分 / 合并（框架无关）
 * ============================================================
 * ⚠️ 刻意单独成文件，而不是留在 plugins/settings/ThemeParams.tsx 里：
 * 设置插件是**双模**的（registry 按 noBuild 选 plugins/settings/index.js
 * 还是 module.tsx），两套实现都要用它。留在 .tsx 里，无构建版 import 不到
 * （它跑的是原生 ESM，不经过任何转译），只能复制一份 —— 那就是又一处
 * "两套实现漂移"的起点：改了 React 版，无构建版依旧按旧规则解析。
 *
 * 为什么不能直接用 <input type="color">：
 *   原生取色器只认 #rrggbb，**丢掉 alpha**。而很多主题变量恰恰带 alpha ——
 *   玻璃的 --surface 是 rgba(36,41,57,0.9)、--border 是 rgba(255,255,255,.12)、
 *   新拟态的 --border 更是 transparent。只用原生控件的话，
 *   点一下颜色就把 0.9 变成 1，玻璃面板瞬间变实心，且不可恢复（原值已被覆盖）。
 *
 * 所以拆成两段：颜色用原生取色器（拾色体验最好），alpha 单独一条滑块，
 * 两者拼回 rgba()。alpha 为 1 时输出 hex，避免"明明不透明却写成长串 rgba"。
 */

/** 把任意颜色串拆成 { hex, alpha }；解析不了的（transparent / 渐变）返回 null */
export function splitColor(v) {
  const s = String(v || '').trim();
  if (!s || s === 'transparent' || s === 'none') return null;

  if (s.startsWith('#')) {
    let h = s.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 8) {
      // #rrggbbaa —— CSS Color 4，浏览器已普遍支持
      return { hex: '#' + h.slice(0, 6), alpha: parseInt(h.slice(6, 8), 16) / 255 };
    }
    if (h.length === 6) return { hex: '#' + h, alpha: 1 };
    return null;
  }

  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return null;
  const parts = m[1].split(/[,/\s]+/).filter(Boolean).map((x) => x.trim());
  if (parts.length < 3) return null;
  const to255 = (x) => {
    if (x.endsWith('%')) return Math.round((parseFloat(x) / 100) * 255);
    return Math.round(parseFloat(x));
  };
  const [r, g, b] = [to255(parts[0]), to255(parts[1]), to255(parts[2])];
  if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
  const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
  const hex = '#' + [r, g, b]
    .map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
  return { hex, alpha: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1 };
}

/** hex + alpha → CSS 串。alpha 为 1 时输出 hex（更短、也更好读） */
export function joinColor(hex, alpha) {
  if (alpha >= 1) return hex;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  /* 保留两位小数：0.9 而不是 0.9000000000000001 */
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})`;
}
