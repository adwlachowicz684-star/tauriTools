import { useEffect, useState } from 'react';
import {
  HOTKEYS, GROUP_LABEL, comboFromEvent, findConflicts, formatCombo, hotkeysByGroup,
  normalizeCombo, type HotkeyId,
} from '../utils/hotkeys';

const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

/**
 * draft 里**真正算「已自定义」**的键 —— 与默认不同的那几项。
 *
 * 判据必须与「存出去的形态」完全一致（两处共用它），否则界面上两个信号
 * 会互相矛盾、且刷新前后不一致：
 *   · 取消绑定是**显式空串**，此前计数用 `normalizeCombo(v)` 非空判定，
 *     空串被算成 0 —— 用户取消了 3 个绑定，界面显示「已自定义 0 项」，
 *     而「全部恢复默认」按钮仍可点（draft 非空）：一个说没改、一个说改了；
 *   · 把键位改**回**默认值仍被算成已自定义 —— 显示「已自定义 1 项」，
 *     但它根本不会存出去，保存后重开显示 0 项。
 *
 * 放在模块级而不是组件内：它是纯函数，放这里才能被单测直接加载
 * （组件里的闭包只能写"源码里有这行"的文本断言，测不到判据对不对）。
 */
export function customizedKeys(d: Record<string, string>): string[] {
  return Object.keys(d).filter((k) => {
    const def = HOTKEYS.find((h) => h.id === k)?.combo ?? '';
    return normalizeCombo(d[k]) !== normalizeCombo(def);
  });
}

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

  // 外部值变了（保存后重新加载）同步进来
  useEffect(() => { setDraft({ ...(value ?? {}) }); }, [value]);

  const conflicts = findConflicts(draft);
  const conflictIds = new Set(conflicts.flatMap((c) => c.ids));

  /**
   * draft → 存出去的形态。
   *
   * 只剔除「与默认相同」的项；**显式空串要保留** —— 它代表"用户主动取消了这个绑定"，
   * 若也一并剔除，读回来没有这个键就会退回默认值，
   * 用户以为取消了，重启后又活了。
   *
   * 判据走 `customizedKeys`，与界面上「已自定义 N 项」同源。
   */
  const commit = (d: Record<string, string>) => {
    const out: Record<string, string> = {};
    for (const k of customizedKeys(d)) out[k] = d[k];
    onChange(Object.keys(out).length ? out : null);
  };

  const setOne = (id: HotkeyId, combo: string) => {
    const next = { ...draft, [id]: combo };
    setDraft(next);
    commit(next);          // 必须立刻提交：否则界面变了但没存，刷新就丢
    setCapturing(null);
  };

  const resetOne = (id: HotkeyId) => {
    const next = { ...draft };
    delete next[id];
    setDraft(next);
    commit(next);
  };

  const resetAll = () => { setDraft({}); onChange(null); };

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
      <div className="p-row" style={{ marginBottom: 'var(--sp-4, 8px)' }}>
        {/* 两个判据都走 customizedKeys：一个说"改了 N 项"、另一个却置灰/可点，
            用户就分不清自己到底有没有改过 */}
        <button className="p-btn" onClick={resetAll}
          disabled={customizedKeys(draft).length === 0}>
          全部恢复默认
        </button>
        <span className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
          已自定义 {customizedKeys(draft).length} 项
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

      {/* 分三组展示（#229）：键位已 20 条，摊平一长条很难找到要改的那条 */}
      <div className="fpx-hotkey-list">
        {hotkeysByGroup().map(({ group, items }) => (
          <div className="fpx-hotkey-group" key={group}>
            <div className="fpx-hotkey-group-title">{GROUP_LABEL[group]}</div>
            {items.map((h) => {
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
        ))}
      </div>

      <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-4, 8px)' }}>
        点击键位后按下新组合键；Esc 放弃，Del / Backspace 取消绑定。
        {IS_MAC ? 'mod = ⌘' : 'mod = Ctrl'}。
        浏览器自身占用的键（如 F5、Ctrl+L）可能拦不住，标 ⚠ 的即是。
      </div>
    </div>
  );
}
