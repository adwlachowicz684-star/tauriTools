import { useEffect, useRef, useState } from 'react';
import {
  HOTKEYS, comboFromEvent, findConflicts, formatCombo, normalizeCombo,
  type HotkeyId,
} from '../utils/hotkeys';

const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/**
 * 常规快捷键自定义（#51 #432）。
 *
 * 原版有 ShortcutCatalog + 录入框 + 恢复默认。此前这边是硬编码的，改一个键要动逻辑。
 *
 * **只存改过的项**：没动过的走内置默认值。将来调整默认键位时，
 * 老用户自定义的那几项不会被悄悄重置，未改的却能跟着更新 ——
 * 反过来（一上来就把全部键位写进配置）会把默认值冻结在保存那一刻。
 */
export function HotkeySettings({
  value, onChange,
}: {
  value: Record<string, string> | null;
  onChange: (next: Record<string, string> | null) => void;
}) {
  /** 正在录入哪一项；null = 没在录入 */
  const [capturing, setCapturing] = useState<HotkeyId | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({ ...(value ?? {}) });
  const inputRef = useRef<HTMLDivElement>(null);

  // 外部值变了（保存后重新加载）同步进来
  useEffect(() => { setDraft({ ...(value ?? {}) }); }, [value]);

  const conflicts = findConflicts(draft);
  const conflictIds = new Set(conflicts.flatMap((c) => c.ids));

  const setOne = (id: HotkeyId, combo: string) => {
    setDraft((d) => {
      const next = { ...d, [id]: combo };
      // 与默认相同就删掉，保持"只存改过的项"
      const def = HOTKEYS.find((h) => h.id === id)?.combo;
      if (normalizeCombo(combo) === normalizeCombo(def ?? '')) delete next[id];
      return next;
    });
    setCapturing(null);
  };

  const resetOne = (id: HotkeyId) => {
    setDraft((d) => {
      const next = { ...d };
      delete next[id];
      return next;
    });
  };

  const resetAll = () => { setDraft({}); onChange(null); };

  /** draft → 存出去的形态：全空就是 null */
  const commit = (d: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(d)) {
      if (normalizeCombo(v) && normalizeCombo(v) !== normalizeCombo(
        HOTKEYS.find((h) => h.id === k)?.combo ?? '')) {
        out[k] = v;
      }
    }
    onChange(Object.keys(out).length ? out : null);
  };

  // 录入模式：全局捕获按键
  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setCapturing(null); return; }
      // Backspace/Delete = 取消绑定
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        setOne(capturing, '');
        return;
      }
      const c = comboFromEvent(e);
      if (c) setOne(capturing, c);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);

  return (
    <div>
      <div className="p-row" style={{ marginBottom: 8 }}>
        <button className="p-btn" onClick={resetAll}
          disabled={Object.keys(draft).length === 0}>
          全部恢复默认
        </button>
        <span className="p-muted" style={{ fontSize: 11 }}>
          已自定义 {Object.keys(draft).filter((k) => normalizeCombo(draft[k])).length} 项
        </span>
      </div>

      {conflicts.length > 0 && (
        <div className="fpx-hotkey-warn">
          ⚠ 有重复键位：
          {conflicts.map((c) => (
            <span key={c.combo}> {formatCombo(c.combo, IS_MAC)}（{c.ids.length} 个动作）</span>
          ))}
          。重复时只有一个会生效。
        </div>
      )}

      <div className="fpx-hotkey-list">
        {HOTKEYS.map((h) => {
          const cur = draft[h.id] !== undefined ? draft[h.id] : h.combo;
          const isDefault = normalizeCombo(cur) === normalizeCombo(h.combo);
          const bad = conflictIds.has(h.id);
          return (
            <div className={`fpx-hotkey-row${bad ? ' bad' : ''}`} key={h.id}>
              <span className="fpx-hotkey-label">{h.label}</span>
              <button
                className="p-btn fpx-hotkey-val"
                onClick={() => setCapturing(h.id)}
                title="点击后按下新键位；Esc 取消，Del 取消绑定"
              >
                {capturing === h.id ? '请按键…' : formatCombo(cur, IS_MAC)}
              </button>
              {!isDefault && (
                <button className="p-btn fpx-hotkey-reset" title="恢复默认"
                  onClick={() => resetOne(h.id)}>↺</button>
              )}
              {h.note && (
                <span className="fpx-hotkey-note" title={h.note}>⚠</span>
              )}
            </div>
          );
        })}
      </div>

      <div className="p-muted" style={{ fontSize: 11, marginTop: 8 }}>
        点击键位后按下新组合键；Esc 放弃，Del / Backspace 取消绑定。
        {IS_MAC ? 'mod = ⌘' : 'mod = Ctrl'}。
        浏览器自身占用的键（如 F5、Ctrl+L）可能拦不住，标 ⚠ 的即是。
      </div>

      {/* 录入时把焦点吸到一个空容器：否则输入框里的按键会被组件吃掉 */}
      {capturing && <div ref={inputRef} tabIndex={-1} />}
    </div>
  );
}
