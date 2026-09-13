import { useMemo, useState } from 'react';
import type { Api } from '../api';
import { errText } from '../api';

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

function normalize(hex: string): string | null {
  const s = (hex || '').trim();
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
  if (!m) return null;
  let t = m[1];
  if (t.length === 3) t = t.split('').map((c) => c + c).join('');
  return `#${t.toUpperCase()}`;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = normalize(hex) ?? '#000000';
  return [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n) || 0)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

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
  const [rgb, setRgb] = useState<[number, number, number]>(() => hexToRgb(value ?? '#7C8CFF'));
  const [hexText, setHexText] = useState(value ?? '');
  const [picking, setPicking] = useState(false);

  const current = useMemo(() => rgbToHex(...rgb), [rgb]);

  const applyHex = (raw: string) => {
    const hex = normalize(raw);
    setHexText(raw);
    if (!hex) return;
    setRgb(hexToRgb(hex));
    onChange(hex);
  };

  const setChannel = (i: 0 | 1 | 2, v: number) => {
    const next = [...rgb] as [number, number, number];
    next[i] = Math.max(0, Math.min(255, Number.isFinite(v) ? v : 0));
    setRgb(next);
    const hex = rgbToHex(...next);
    setHexText(hex);
    onChange(hex);
  };

  const pick = async () => {
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
        <button className="p-btn" disabled={picking} onClick={pick} title="读取当前鼠标位置的颜色">
          {picking ? '取色中…' : '⌖ 吸管'}
        </button>
        <button className="p-btn" onClick={() => { setHexText(''); onChange(null); }}>
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
