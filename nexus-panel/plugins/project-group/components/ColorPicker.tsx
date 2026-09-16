import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Api } from '../api';
import { errText } from '../api';
import { hexToRgb, rgbToHex, normalizeHex, hexToHsv, hsvToRgb, hsvToHex, type Hsv } from '../utils/color';
import { SvPanel, HueBar } from './SvPanel';

/** 预设常用色 24 个（取自原 C# 版 ColorPickDialog 的 PresetColors，不可删） */
export const PRESET_COLORS = [
  '#E5484D', '#D9A441', '#F5A623', '#B7C94A',
  '#46A758', '#2FAE9B', '#12A594', '#0091FF',
  '#3E63DD', '#6E56CF', '#8E4EC6', '#BF4AC8',
  '#D6409F', '#E93D82', '#FF6B35', '#FFD23F',
  '#8FD14F', '#00C2A8', '#4098D7', '#5B5BD6',
  '#9D34DA', '#F472B6', '#B4B9C2', '#7C8698',
];

const MAX_CUSTOM = 24;

/**
 * 未设标签色时色盘的**起始色**。
 *
 * 它不代表"卡片是这个颜色"（没设色就是没设色，预览块上会标「默认」），
 * 只是给用户一个能看的起点：直接拖面板就是在它基础上调，
 * 不必先盲选一个预设色块再微调。
 */
const DEFAULT_COLOR = '#7C8CFF';

/** 色盘：预设 24 色 + 自定义常用色（可增删持久化）+ RGB/HEX 输入 + 吸管 + 恢复默认 */
export function ColorPicker({
  api, value, customColors, onChange, onSaveCustom, onLog, compact,
}: {
  api: Api;
  value: string | null;
  customColors: string[];
  /** 实时回调：拖动/输入过程中只改预览，不落盘 */
  onChange: (hex: string | null) => void;
  /** 自定义常用色整表保存 */
  onSaveCustom: (colors: string[]) => void;
  onLog: (msg: string, isError?: boolean) => void;
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
      const hex = await api.pickColor();
      applyHex(hex);
      onLog(`取到颜色 ${hex}`);
    } catch (e) {
      onLog(errText(e), true);
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
      onLog(`自定义色最多 ${MAX_CUSTOM} 个`, true);
      return;
    }
    if (customColors.includes(current)) return;
    onSaveCustom([...customColors, current]);
  };

  return (
    <div className={compact ? 'fpx-picker compact' : 'fpx-picker'}>
      {/* 可视化选色区：SV 面板 + 色相条。
          此前只能靠预设色块和 RGB 数字调，没有一个能"看颜色"的地方。 */}
      <div className="fpx-picker-visual">
        <SvPanel hsv={hsv} onChange={applyHsv} />
        <HueBar hsv={hsv} onChange={applyHsv} />
      </div>

      {/* 预览 + 通道输入 */}
      <div className="p-row">
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
              onChange={(e) => setChannel(i as 0 | 1 | 2, Number(e.target.value))}
            />
          </label>
        ))}
        <input
          className="p-input fpx-hex"
          value={hexText}
          placeholder="#RRGGBB"
          onChange={(e) => applyHex(e.target.value)}
        />
        <button className="p-btn" disabled={picking || armed}
          onClick={() => setArmed(true)}
          title="进入取色模式：移开鼠标后再点一下取样，Esc 取消">
          {picking ? '取色中…' : armed ? '请点击取样…' : '⌖ 吸管'}
        </button>
        {/* 恢复默认后**把默认色填进输入框与面板**（#676）：
            之前 hexText 被清成空、面板却仍是默认紫，两处对不上；
            清空的另一个后果是用户没法在默认色基础上微调，只能先盲选一个。 */}
        <button className="p-btn" onClick={() => {
          setHsv(hexToHsv(DEFAULT_COLOR));
          setHexText(DEFAULT_COLOR);
          onChange(null);
        }}>
          恢复默认
        </button>
      </div>

      {/* 预设色 */}
      <div className="fpx-picker-label">常用色</div>
      <div className="fpx-swatches">
        {PRESET_COLORS.map((c) => (
          <button
            key={c}
            className={`fpx-swatch${current === c ? ' active' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => applyHex(c)}
          />
        ))}
      </div>

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

      {/* 自定义常用色 */}
      <div className="fpx-picker-label">
        我的常用色
        <span className="p-muted">（{customColors.length}/{MAX_CUSTOM}）</span>
        <button className="p-btn fpx-mini" onClick={addCustom}>＋ 收藏当前色</button>
      </div>
      <div className="fpx-swatches">
        {customColors.length === 0 && <span className="p-muted">（还没有，点「收藏当前色」添加）</span>}
        {customColors.map((c) => (
          <span key={c} className="fpx-swatch-wrap">
            <button
              className={`fpx-swatch${current === c ? ' active' : ''}`}
              style={{ background: c }}
              title={c}
              onClick={() => applyHex(c)}
            />
            <button
              className="fpx-swatch-del"
              title="删除"
              onClick={() => onSaveCustom(customColors.filter((x) => x !== c))}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}
