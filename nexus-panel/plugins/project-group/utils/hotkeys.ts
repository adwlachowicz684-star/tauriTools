/**
 * 常规快捷键注册表（#51 #432）。
 *
 * 此前键位散落在 `useCardHotkeys` 里硬编码，改一个键要动逻辑代码，
 * 也没法让用户自定义。这里把「有哪些动作、默认什么键」抽成一份数据，
 * 绑定与设置界面共用 —— 两者不会再对不上。
 *
 * id 是稳定标识，写进 config；**不要改已有 id 的字面量**，
 * 否则老用户存的覆盖项会失效（会被当成未知项忽略，静默退回默认）。
 */

export type HotkeyId =
  | 'open' | 'lock' | 'rename' | 'move' | 'color' | 'icon' | 'remove'
  | 'refresh' | 'clearInvalid'
  | 'cycleGroup' | 'cycleGroupBack' | 'cycleProject' | 'cycleProjectBack'
  | 'focusProject' | 'focusGroup';

export interface HotkeyDef {
  id: HotkeyId;
  label: string;
  /** 默认 combo（`mod` 在 macOS 解析为 ⌘，其它平台为 Ctrl） */
  combo: string;
  /** 该键位是否被浏览器/系统占用，界面上给个提醒 */
  note?: string;
  /** 是否允许取消绑定（留空 = 不响应） */
  allowEmpty?: boolean;
}

export const HOTKEYS: HotkeyDef[] = [
  { id: 'open', label: '打开文件夹', combo: 'mod+o' },
  { id: 'lock', label: 'ACL 保护', combo: 'mod+l', note: '浏览器占用 mod+l 定位地址栏，可能无效' },
  { id: 'rename', label: '改名', combo: 'f2' },
  { id: 'move', label: '转为另一类别', combo: 'f3' },
  { id: 'color', label: '图标与标签色', combo: 'f4' },
  { id: 'icon', label: '改图标', combo: 'f6' },
  { id: 'remove', label: '从页签移除', combo: 'delete' },
  { id: 'refresh', label: '刷新', combo: 'f5', note: '浏览器占用 f5 刷新页面，可能无效' },
  { id: 'clearInvalid', label: '清除无效项', combo: 'f8' },
  { id: 'cycleGroup', label: '下一个项目组页签', combo: 'mod+tab' },
  { id: 'cycleGroupBack', label: '上一个项目组页签', combo: 'mod+shift+tab' },
  { id: 'cycleProject', label: '下一个项目页签', combo: 'mod+pagedown' },
  { id: 'cycleProjectBack', label: '上一个项目页签', combo: 'mod+pageup' },
  { id: 'focusProject', label: '焦点切到项目栏', combo: 'mod+arrowleft' },
  { id: 'focusGroup', label: '焦点切到项目组栏', combo: 'mod+arrowright' },
];

export const HOTKEY_BY_ID: Record<string, HotkeyDef> =
  Object.fromEntries(HOTKEYS.map((h) => [h.id, h]));

/** 覆盖表 → 生效的 combo（没覆盖的用默认）。 */
export function effectiveCombo(
  id: HotkeyId,
  overrides: Record<string, string> | null | undefined,
): string {
  const v = overrides?.[id];
  // 显式设成空串 = 取消绑定；undefined/null = 没改过，用默认
  return v !== undefined && v !== null ? v : (HOTKEY_BY_ID[id]?.combo ?? '');
}

/** 全部生效键位（给绑定与冲突检测用）。 */
export function effectiveMap(overrides: Record<string, string> | null | undefined) {
  const out: Partial<Record<HotkeyId, string>> = {};
  for (const h of HOTKEYS) out[h.id] = effectiveCombo(h.id, overrides);
  return out;
}

/**
 * 找出重复绑定到同一个 combo 的动作。
 *
 * 两个动作抢一个键时，SDK 的注册顺序决定谁生效 —— 用户会看到"按 A 键却做了 B 事"，
 * 而且完全不知道是自己设重了。宁可在设置里明确报出来。
 */
export function findConflicts(
  overrides: Record<string, string> | null | undefined,
): { combo: string; ids: HotkeyId[] }[] {
  const byCombo = new Map<string, HotkeyId[]>();
  const map = effectiveMap(overrides);
  for (const [id, combo] of Object.entries(map)) {
    const c = normalizeCombo(combo);
    if (!c) continue; // 空 = 未绑定，不参与冲突
    const list = byCombo.get(c) ?? [];
    list.push(id as HotkeyId);
    byCombo.set(c, list);
  }
  return [...byCombo.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([combo, ids]) => ({ combo, ids }));
}

/** 归一化：忽略大小写与分隔符差异，便于比较。 */
export function normalizeCombo(combo: string): string {
  return combo.trim().toLowerCase()
    .split('+').map((s) => s.trim()).filter(Boolean)
    .sort().join('+');
}

/** combo → 人类可读（mod → ⌘ / Ctrl）。 */
export function formatCombo(combo: string, isMac: boolean): string {
  if (!combo) return '（未绑定）';
  const order = ['mod', 'ctrl', 'shift', 'alt', 'meta'];
  const parts = combo.toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const mods = parts.filter((p) => order.includes(p));
  const rest = parts.filter((p) => !order.includes(p));
  const out: string[] = [];
  for (const m of [...order].reverse()) {
    if (mods.includes(m)) {
      if (m === 'mod') out.push(isMac ? '⌘' : 'Ctrl');
      else if (m === 'meta') out.push('⌘');
      else out.push(m === 'ctrl' ? 'Ctrl' : m[0].toUpperCase() + m.slice(1));
    }
  }
  for (const r of rest) out.push(formatKeyName(r));
  return out.join(isMac ? '' : '+');
}

function formatKeyName(k: string): string {
  const map: Record<string, string> = {
    arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
    pagedown: 'PageDown', pageup: 'PageUp',
    space: '空格', esc: 'Esc', escape: 'Esc', enter: 'Enter',
    delete: 'Del', backspace: 'Backspace', tab: 'Tab',
  };
  if (map[k]) return map[k];
  if (/^f\d{1,2}$/.test(k)) return k.toUpperCase();
  return k.length === 1 ? k.toUpperCase() : k;
}

/**
 * 从 KeyboardEvent 反推 combo 字符串（设置界面"按下新键"用）。
 * 返回 null 表示这一下不构成有效组合（比如只按了一个修饰键）。
 */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  // 单按修饰键不算
  if (['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock'].includes(k)) return null;

  const parts: string[] = [];
  const ctrl = e.ctrlKey || e.metaKey; // 统一记作 mod
  if (ctrl) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');

  const key = keyNameFromEvent(e);
  if (!key) return null;
  parts.push(key);
  return parts.join('+');
}

function keyNameFromEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  if (/^F\d{1,2}$/.test(k)) return k.toLowerCase();
  const lower = k.toLowerCase();
  if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'pagedown', 'pageup',
       'tab', 'enter', 'escape', 'delete', 'backspace', 'home', 'end',
       'insert', 'printscreen'].includes(lower)) {
    return lower === 'escape' ? 'esc' : lower;
  }
  if (k === ' ') return 'space';
  // 单字符（字母数字标点）
  if (k.length === 1) return lower;
  return null;
}
