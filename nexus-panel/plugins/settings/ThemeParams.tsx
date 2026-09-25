import type { ReactNode } from 'react';

/**
 * 主题参数的颜色控件。
 *
 * 为什么要自己写而不是直接用 <input type="color">：
 *   原生取色器只认 #rrggbb，**丢掉 alpha**。而很多主题变量恰恰带 alpha ——
 *   玻璃的 --surface 是 rgba(36,41,57,0.9)、--border 是 rgba(255,255,255,.12)、
 *   新拟态的 --border 更是 transparent。只用原生控件的话，
 *   点一下颜色就把 0.9 变成 1，玻璃面板瞬间变实心，且不可恢复（原值已被覆盖）。
 *
 * 所以拆成两段：颜色用原生取色器（拾色体验最好），alpha 单独一条滑块，
 * 两者拼回 rgba()。alpha 为 1 时输出 hex，避免"明明不透明却写成长串 rgba"。
 */

/** 把任意颜色串拆成 { hex, alpha }；解析不了的（transparent / 渐变）返回 null */
function splitColor(v: string): { hex: string; alpha: number } | null {
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
  const to255 = (x: string) => {
    if (x.endsWith('%')) return Math.round((parseFloat(x) / 100) * 255);
    return Math.round(parseFloat(x));
  };
  const [r, g, b] = [to255(parts[0]), to255(parts[1]), to255(parts[2])];
  if ([r, g, b].some((n) => !Number.isFinite(n))) return null;
  const a = parts.length > 3 ? parseFloat(parts[3]) : 1;
  const hex = '#' + [r, g, b].map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('');
  return { hex, alpha: Number.isFinite(a) ? Math.max(0, Math.min(1, a)) : 1 };
}

/** hex + alpha → CSS 串。alpha 为 1 时输出 hex（更短、也更好读） */
function joinColor(hex: string, alpha: number) {
  if (alpha >= 1) return hex;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  /* 保留两位小数：0.9 而不是 0.9000000000000001 */
  return `rgba(${r}, ${g}, ${b}, ${Math.round(alpha * 100) / 100})`;
}

export { splitColor, joinColor };

export default function ColorField({
  value, original, onChange,
}: {
  value: string;
  /** 主题自带值，用于"已改"标记与还原 */
  original: string;
  onChange: (v: string) => void;
}) {
  const cur = splitColor(value);
  const orig = splitColor(original);
  const alpha = cur?.alpha ?? 1;

  /* 解析不了的值（transparent / none / 渐变）不硬塞进取色器 ——
     那会显示成黑色，用户点一下就把"透明"改成了黑，与意图完全相反。
     改为给一个"设为透明"的入口，让用户自己决定。 */
  if (!cur) {
    return (
      <div className="tp-color">
        <span
          className="tp-chip tp-chip-none"
          title={`当前值：${value || '（空）'}`}
        />
        <input
          className="p-input sm tp-hex"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          spellCheck={false}
        />
        {/*
          这里**不再**自带「还原」按钮 —— 统一交给 ThemeParamsPanel 的外层。
          两个理由：
            · 重复：外层已有一个，颜色项会出现两个还原按钮；
            · 误导：本处条件是 `original !== value`，而 value 取自
              exportVarsFor（含派生与风格参数缩放）。用户只是拖了玻璃透明度
              滑块、压根没碰这一项，value 也会与 original 不同 ——
              于是「没改过的项也显示还原」，点下去还会把缩放结果写死，
              之后拖滑块对这一项就失效了。
          外层的判据才是对的：`overrides[key] != null`（用户显式改过）。
        */}
      </div>
    );
  }

  return (
    <div className="tp-color">
      <input
        type="color"
        className="tp-picker"
        value={cur.hex}
        onChange={(e) => onChange(joinColor(e.target.value, alpha))}
      />
      <input
        className="p-input sm tp-hex"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        title="可直接粘贴 #rgb / #rrggbb / rgba(...)"
      />
      {/* alpha 只在"原值本来带透明"或"当前已被改成带透明"时出现 ——
          给一个完全不透明的 --text 显示透明度滑块毫无意义，只会让人误调。 */}
      {(alpha < 1 || (orig?.alpha ?? 1) < 1) ? (
        <span className="tp-alpha">
          <input
            type="range"
            className="p-range"
            min={0} max={1} step={0.05}
            value={alpha}
            title="不透明度"
            onChange={(e) => onChange(joinColor(cur.hex, Number(e.target.value)))}
          />
          <span className="p-mono p-muted tp-alpha-num">
            {Math.round(alpha * 100)}%
          </span>
        </span>
      ) : null}
      {/* 同上：还原按钮由外层统一渲染，这里不重复给。 */}
    </div>
  );
}

/** 长度 / 数字滑块：把 "14px" / "0.055" 这类带单位的串拆成数字再拼回去 */
export function NumberField({
  value, unit, min, max, step, onChange,
}: {
  value: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: string) => void;
}) {
  const raw = parseFloat(String(value).replace(/[^0-9.\-]/g, ''));
  const n = Number.isFinite(raw) ? raw : min;
  const decimals = step < 1 ? (String(step).split('.')[1] || '').length : 0;
  return (
    <div className="tp-num">
      <input
        type="range"
        className="p-range"
        min={min} max={max} step={step}
        value={n}
        onChange={(e) => {
          const v = Number(e.target.value);
          onChange(decimals ? v.toFixed(decimals) + unit : String(v) + unit);
        }}
      />
      <span className="p-mono p-muted tp-num-val">
        {decimals ? n.toFixed(decimals) : String(n)}{unit}
      </span>
    </div>
  );
}

/** 分组标题下的说明文字 */
export function GroupDesc({ children }: { children: ReactNode }) {
  return <div className="p-muted tp-group-desc">{children}</div>;
}
