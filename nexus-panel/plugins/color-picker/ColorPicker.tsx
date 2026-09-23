import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  hexToRgb, rgbToHex, normalizeHex, hexToHsv, hsvToRgb, hsvToHex, type Hsv, PRESET_COLORS, DEFAULT_COLOR,
} from './color';
import { SvPanel, HueBar } from './SvPanel';
import { useNexus } from '../../src/nexus-react';

/* 预设色在 ./color —— 取色服务与内联色盘共用同一份，
   两处各存一份迟早漂移（同一个"常用色"在两个界面显示成不同颜色）。 */
export { PRESET_COLORS };

/**
 * 色盘（跨插件共用组件）
 * ------------------------------------------------------------
 * **已从 project-group/components 搬到 color-picker 下。**
 *
 * 两种用法共用这一份实现：
 *   · 内联（project-group 的弹窗里）—— 实时预览，拖动时外面的卡片跟着变
 *   · 服务弹窗（color-picker 服务）—— 别的插件通过 ctx.services.color.pick 调用
 *
 * 与"改成调服务"相比，共享组件保留了内联的实时预览能力 ——
 * 模态弹窗拿不到中间态（拖动时看不见外面的变化），那是降级。
 */

const MAX_CUSTOM = 24;

/**
 * 未设标签色时色盘的**起始色**。
 *
 * 它不代表"卡片是这个颜色"（没设色就是没设色，预览块上会标「默认」），
 * 只是给用户一个能看的起点：直接拖面板就是在它基础上调，
 * 不必先盲选一个预设色块再微调。
 */

/** 色盘：预设 24 色 + 自定义常用色（可增删持久化）+ RGB/HEX 输入 + 吸管 + 恢复默认 */
export function ColorPicker({
  value, customColors, onChange, onSaveCustom, onLog, compact, preset, actions,
}: {
  /** 右下角动作（服务模式的「取消/确定」）。内联模式不给 —— 它实时生效，没有确认。 */
  actions?: React.ReactNode;
  /**
   * 预设色（"常用色"那一排）。
   *
   * 不给则用共享的 PRESET_COLORS。
   * 给的话由调用方决定 —— 不同调用方可能想给不同的一套
   * （比如项目标签色一套、状态色一套）。
   */
  preset?: string[];
  /** 日志回调（可选）：不给的话就不记日志，取色失败也不报错 */
  onLog?: (msg: string, isError?: boolean) => void;
  value: string | null;
  customColors: string[];
  /** 实时回调：拖动/输入过程中只改预览，不落盘 */
  onChange: (hex: string | null) => void;
  /** 自定义常用色整表保存 */
  onSaveCustom: (colors: string[]) => void;
  compact?: boolean;
}) {
  /**
   * 内部状态用 HSV。
   *
   * 此前存 RGB，而 SV 面板的两个轴是饱和度与明度 —— 用 RGB 反推的话，
   * 每拖一次都要做一次 RGB→HSV→RGB 往返，灰阶（s=0）还会**丢失色相**
   * （任何灰色的 HSV 都是 h=0），拖过一次黑白色块后就再也回不到原来的色调。
   */
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value ?? DEFAULT_COLOR));
  const [hexText, setHexText] = useState(value ?? '');
  const [picking, setPicking] = useState(false);
  /**
   * 吸管已**待命**：等用户把鼠标移到目标位置再点一下（#4 的可行形态）。
   *
   * 原来是一点吸管就立刻取色 —— 而那一刻光标**正在吸管按钮上**，
   * 于是取到的是按钮自己的颜色：每次都返回同一个值，功能形同虚设。
   * 后端是起 PowerShell 读 Cursor.Position，从点击到真正取样有上百毫秒，
   * 指望"点完赶紧移开鼠标"并不现实。
   *
   * 改成两段式：点一下进入待命 → 用户移到位 → 再点一下，此刻光标就在目标上。
   * 全程 Esc 可取消。
   */
  const [armed, setArmed] = useState(false);
  /* 屏幕取色直接走 ctx.invoke，不再依赖 project-group 的 api 模块 ——
     这个组件已经不归 project-group 所有了。 */
  const ctx = useNexus();

  const current = useMemo(() => hsvToHex(hsv), [hsv]);
  const rgb = useMemo(() => hsvToRgb(hsv), [hsv]);

  /** 面板拖动：只改预览，不落盘（落盘由外层点保存触发） */
  const applyHsv = (next: Hsv) => {
    setHsv(next);
    const hex = hsvToHex(next);
    setHexText(hex);
    onChange(hex);
  };

  const applyHex = (raw: string) => {
    const hex = normalizeHex(raw);
    setHexText(raw);
    if (!hex) return;
    setHsv(hexToHsv(hex));
    onChange(hex);
  };

  const setChannel = (i: 0 | 1 | 2, v: number) => {
    const next = [...rgb] as [number, number, number];
    next[i] = Math.max(0, Math.min(255, Number.isFinite(v) ? v : 0));
    const hex = rgbToHex(...next);
    setHsv(hexToHsv(hex));
    setHexText(hex);
    onChange(hex);
  };

  /** 真正取样：此刻光标已在目标位置，不传坐标让后端读 Cursor.Position */
  const doPick = async () => {
    setArmed(false);
    setPicking(true);
    try {
      const hex = await ctx.invoke<string>('fpx_pick_color', { x: null, y: null });
      applyHex(hex);
      onLog?.(`取到颜色 ${hex}`);
    } catch (e) {
      onLog?.(String((e as Error)?.message ?? e), true);
    } finally {
      setPicking(false);
    }
  };

  // 待命期间 Esc 取消；不挂这个的话用户点错了只能硬取一个色
  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setArmed(false); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [armed]);

  const addCustom = () => {
    if (customColors.length >= MAX_CUSTOM) {
      onLog?.(`自定义色最多 ${MAX_CUSTOM} 个`, true);
      return;
    }
    if (customColors.includes(current)) return;
    onSaveCustom([...customColors, current]);
  };

  /* 恢复默认：把默认色填进输入框与面板（#676）
     —— 此前 hexText 被清成空、面板却仍是默认紫，两处对不上；
     清空的另一个后果是用户没法在默认色基础上微调，只能先盲选一个。 */
  const resetDefault = () => {
    setHsv(hexToHsv(DEFAULT_COLOR));
    setHexText(DEFAULT_COLOR);
    onChange(null);
  };

  return (
    <div className={compact ? 'fpx-picker compact' : 'fpx-picker'}>
      {/* ① 可视化选色区：SV 面板 + 色相条。
          此前只能靠预设色块和 RGB 数字调，没有一个能"看颜色"的地方。 */}
      <div className="fpx-picker-visual">
        {/* 高度不再写 176：交给 CSS 弹性分配，弹窗才不会溢出滚动。
            详见 style.css 里 .fpx-picker-visual 的说明。 */}
        <SvPanel hsv={hsv} onChange={applyHsv} />
        <HueBar hsv={hsv} onChange={applyHsv} />
      </div>

      {/* ② 数值行：预览块 + R/G/B + 色值，同一中轴横排（照搬 WPF 的 rgbRow）。

          WPF 里色值是**只读文本**，这里保留可编辑：用户可以整段粘贴
          `#AABBCC` 进来，只读就得先手动拆成三个数字。这是有意偏离原版。 */}
      <div className="fpx-value-row">
        <div className="fpx-preview-block" style={{ background: current }}>
          {!value && <span className="fpx-preview-def">默认</span>}
        </div>
        {(['R', 'G', 'B'] as const).map((label, i) => (
          <label key={label} className="fpx-channel">
            <span>{label}</span>
            <input
              className="p-input"
              type="number"
              min={0}
              max={255}
              value={rgb[i]}
              aria-label={`${label} 通道`}
              onChange={(e) => setChannel(i as 0 | 1 | 2, Number(e.target.value))}
            />
          </label>
        ))}
        <input
          className="p-input fpx-hex"
          value={hexText}
          placeholder="#RRGGBB"
          spellCheck={false}
          aria-label="十六进制颜色值"
          onChange={(e) => applyHex(e.target.value)}
        />
      </div>

      {/* ③ 常用色 */}
      <section className="fpx-picker-sec">
        <div className="fpx-picker-label">常用色（单击应用）</div>
        <div className="fpx-swatches">
          {(preset ?? PRESET_COLORS).map((c) => (
            <button
              key={c}
              className={`fpx-swatch${current === c ? ' active' : ''}`}
              style={{ background: c }}
              title={c}
              aria-label={`使用颜色 ${c}`}
              onClick={() => applyHex(c)}
            />
          ))}
        </div>
      </section>

      {/* 待命遮罩：portal 到 body。
          不放在本组件里是因为外壳 `.dialog` 有 backdrop-filter，
          它会成为 fixed 后代的包含块，遮罩会被关在弹窗盒子里而不是铺满视口。 */}
      {armed && createPortal(
        <div className="fpx-pick-overlay" onPointerDown={doPick}>
          <div className="fpx-pick-hint">
            <b>取色模式</b>
            <div>把鼠标移到要取的位置，<b>单击</b>取样</div>
            <div className="dim">Esc 取消</div>
          </div>
        </div>,
        document.body,
      )}

      {/* ④ 我的常用色 */}
      <section className="fpx-picker-sec">
        <div className="fpx-picker-label">
          我的常用色（悬浮显示删除）
          <span className="p-muted">（{customColors.length}/{MAX_CUSTOM}）</span>
        </div>
        <div className="fpx-swatches">
          {customColors.length === 0 && <span className="p-muted">（还没有，点「收藏当前色」添加）</span>}
          {customColors.map((c) => (
            <span key={c} className="fpx-swatch-wrap">
              <button
                className={`fpx-swatch${current === c ? ' active' : ''}`}
                style={{ background: c }}
                title={c}
                aria-label={`使用颜色 ${c}`}
                onClick={() => applyHex(c)}
              />
              {/* 删除是真按钮（键盘可达），不是只能右键 ——
                  此前设置页那排收藏色只给右键，键盘用户删不掉。 */}
              <button
                className="fpx-swatch-del"
                title="删除"
                aria-label={`删除颜色 ${c}`}
                onClick={() => onSaveCustom(customColors.filter((x) => x !== c))}
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      </section>

      {/* ⑤ 底部动作行：左=吸管/存为常用/恢复默认，右=确认（照搬 WPF 的 btnRow）。
          右侧留给调用方（服务模式的「取消/确定」），内联模式没有就只留左边。 */}
      <div className="fpx-actions">
        <button
          className="p-btn"
          disabled={picking || armed}
          onClick={() => setArmed(true)}
          title="进入取色模式：移开鼠标后再点一下取样，Esc 取消"
        >
          {picking ? '取色中…' : armed ? '请点击取样…' : '吸管'}
        </button>
        <button className="p-btn" onClick={addCustom}
          title={`把当前颜色存进我的常用色（最多 ${MAX_CUSTOM} 个）`}>
          存为常用
        </button>
        <button className="p-btn" onClick={resetDefault}
          title="清除自定义颜色，还原默认外观">
          恢复默认
        </button>
        {actions ? <div className="fpx-actions-right">{actions}</div> : null}
      </div>
    </div>
  );
}
