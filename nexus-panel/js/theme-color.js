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

/**
 * 颜色串 → { r, g, b, a }（a 归一到 0..1）；认不出的一律 null。
 * ============================================================
 * ⚠️ 这是全项目**唯一**的颜色解析判据：theme-manager.js 的 scaleAlpha
 * 也必须走它（早先那里另有一份几乎一样的解析，于是同一个 bug 得修两遍）。
 *
 * alpha 可能是百分比（CSS Color 4 的 `rgb(0 0 0 / 50%)`），**必须**按
 * 百分比换算。早先与 RGB 通道的处理不一致 —— 通道认百分比、alpha 不认，
 * 于是 `rgb(255 255 255 / 12%)` 被读成 **1**（完全不透明）：
 * 设置页的 alpha 滑块显示满格，用户点一下取色器就把 12% 写成不透明，
 * **且不可恢复**（原值已被覆盖）。正是本文件开头那段注释警告的后果，
 * 换一条路犯了。
 */
export function parseCssColor(v) {
  const s = String(v || '').trim();
  if (!s || s === 'transparent' || s === 'none') return null;

  /* 通道可能是百分比（rgb(50% 20% 10%)），统一换算到 0-255 */
  const to255 = (x) => {
    const t = String(x).trim();
    if (t.endsWith('%')) return Math.round((parseFloat(t) / 100) * 255);
    return Math.round(parseFloat(t));
  };
  /* alpha 同样可能是百分比，且**必须**先判百分比再走 0..1 数值 */
  const toAlpha = (x) => {
    const t = String(x).trim();
    const n = t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t);
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
  };
  const clamp255 = (n) => Math.max(0, Math.min(255, n));

  if (s.startsWith('#')) {
    const raw = s.slice(1);
    /* 非十六进制字符（#GGG、#12ab-cd）必须判 null，不能靠 parseInt：
       parseInt('GGG', 16) 是 NaN，而 NaN >> 16 === 0 —— 于是非法色被当成
       纯黑（rgba(0,0,0,...)）返回，正是"点一下就把透明改成黑"那类问题。 */
    if (!/^[0-9a-f]+$/i.test(raw)) return null;
    let h = raw;
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (h.length === 8) {
      // #rrggbbaa —— CSS Color 4，浏览器已普遍支持
      const n = parseInt(h.slice(0, 6), 16);
      return {
        r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255,
        a: parseInt(h.slice(6, 8), 16) / 255,
      };
    }
    if (h.length === 6) {
      const n = parseInt(h, 16);
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    return null;
  }

  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (!m) return null;                        // 渐变、命名色等：认不出就交给调用方决定
  const parts = m[1].split(/[,/\s]+/).filter(Boolean).map((x) => x.trim());
  if (parts.length < 3) return null;
  const r = to255(parts[0]);
  const g = to255(parts[1]);
  const b = to255(parts[2]);
  if (![r, g, b].every(Number.isFinite)) return null;
  return {
    r: clamp255(r), g: clamp255(g), b: clamp255(b),
    /* rgb() 三参数没有 alpha，视作 1 */
    a: parts.length > 3 ? toAlpha(parts[3]) : 1,
  };
}

/** 把任意颜色串拆成 { hex, alpha }；解析不了的（transparent / 渐变）返回 null */
export function splitColor(v) {
  const c = parseCssColor(v);
  if (!c) return null;
  const hex = '#' + [c.r, c.g, c.b]
    .map((n) => n.toString(16).padStart(2, '0')).join('');
  return { hex, alpha: c.a };
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
