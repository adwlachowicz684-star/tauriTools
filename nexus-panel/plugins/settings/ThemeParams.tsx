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

/*
 * 解析/合并逻辑在 js/theme-color.js —— **刻意不写在这里**。
 *
 * 设置插件是双模的（registry 按 noBuild 选 plugins/settings/index.js
 * 还是 module.tsx），无构建版跑原生 ESM，import 不到 .tsx。
 * 写在这里它只能复制一份，两边迟早漂移（改了 React 版，
 * 无构建版仍按旧规则解析，alpha 处理不一致就是典型的症状）。
 */
import { splitColor, joinColor } from '../../js/theme-color.js';

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
