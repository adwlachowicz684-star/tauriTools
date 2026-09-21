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
  | 'focusProject' | 'focusGroup'
  /* 以下 5 条是照原版 ShortcutCatalog 补齐的（#221 #222 #223 #225 #226）。
     键位取原版默认值，用户可在设置里改。
     #224 HideToTray（Ctrl+~）不在此列 —— 托盘属宿主能力，已随 P8-3 移交
     主窗口任务，插件内注册也调不动。 */
  | 'toggleTips' | 'backupNow' | 'toggleMcp' | 'toggleSidebar' | 'openMarkdown';

/** 设置面板的分组（#229：原版按用途分三组展示） */
export type HotkeyGroup = 'general' | 'card' | 'tab';

export const GROUP_LABEL: Record<HotkeyGroup, string> = {
  general: '常规',
  card: '项目操作',
  tab: '页签切换',
};

export interface HotkeyDef {
  id: HotkeyId;
  label: string;
  /** 默认 combo（`mod` 在 macOS 解析为 ⌘，其它平台为 Ctrl） */
  combo: string;
  /** 设置面板里归到哪一组（#229） */
  group: HotkeyGroup;
  /** 该键位是否被浏览器/系统占用，界面上给个提醒 */
  note?: string;
  /** 是否允许取消绑定（留空 = 不响应） */
  allowEmpty?: boolean;
}

export const HOTKEYS: HotkeyDef[] = [
  /* ---- 常规 ---- */
  { id: 'refresh', label: '刷新', combo: 'f5', group: 'general', note: '浏览器占用 f5 刷新页面，可能无效' },
  { id: 'clearInvalid', label: '清除无效项', combo: 'f8', group: 'general' },
  { id: 'backupNow', label: '一键备份', combo: 'f7', group: 'general' },
  { id: 'toggleTips', label: '使用说明', combo: 'f1', group: 'general', note: 'F1 在部分浏览器里是自带帮助' },
  { id: 'toggleMcp', label: 'MCP 服务面板', combo: 'mod+m', group: 'general' },
  { id: 'openMarkdown', label: '编辑当前文件', combo: 'mod+d', group: 'general',
    note: '内置 Markdown 编辑器归共用组件，当前落到外部编辑器' },
  /* 原版记的是 `~`（WPF 的 Key 枚举里 shift 隐含在字符中）。
     Web 不行：`matchCombo` 要求 shift **精确匹配**，而按出 `~` 必然带 shift，
     写裸 `~` 会让默认键位永远匹配不上。所以显式写 shift。 */
  { id: 'toggleSidebar', label: '展开/收起左栏', combo: 'shift+~', group: 'general' },

  /* ---- 项目操作 ---- */
  { id: 'open', label: '打开文件夹', combo: 'mod+o', group: 'card' },
  { id: 'lock', label: 'ACL 保护', combo: 'mod+l', group: 'card', note: '浏览器占用 mod+l 定位地址栏，可能无效' },
  { id: 'rename', label: '改名', combo: 'f2', group: 'card' },
  { id: 'move', label: '转为另一类别', combo: 'f3', group: 'card' },
  { id: 'color', label: '图标与标签色', combo: 'f4', group: 'card' },
  { id: 'icon', label: '改图标', combo: 'f6', group: 'card' },
  { id: 'remove', label: '从页签移除', combo: 'delete', group: 'card' },

  /* ---- 页签切换 ---- */
  { id: 'cycleGroup', label: '下一个项目组页签', combo: 'mod+tab', group: 'tab' },
  { id: 'cycleGroupBack', label: '上一个项目组页签', combo: 'mod+shift+tab', group: 'tab' },
  { id: 'cycleProject', label: '下一个项目页签', combo: 'mod+pagedown', group: 'tab' },
  { id: 'cycleProjectBack', label: '上一个项目页签', combo: 'mod+pageup', group: 'tab' },
  { id: 'focusProject', label: '焦点切到项目栏', combo: 'mod+arrowleft', group: 'tab' },
  { id: 'focusGroup', label: '焦点切到项目组栏', combo: 'mod+arrowright', group: 'tab' },
];

/** 按设置面板的分组顺序取键位（#229）。组序固定，组内保持注册表顺序。 */
export function hotkeysByGroup(): { group: HotkeyGroup; items: HotkeyDef[] }[] {
  const order: HotkeyGroup[] = ['general', 'card', 'tab'];
  return order.map((g) => ({ group: g, items: HOTKEYS.filter((h) => h.group === g) }));
}

export const HOTKEY_BY_ID: Record<string, HotkeyDef> =
  Object.fromEntries(HOTKEYS.map((h) => [h.id, h]));

/**
 * 把任意字符串收窄成 `HotkeyId`（类型守卫）。
 *
 * 为什么要它：动作 id 可能来自配置 / 外部数据，是 `string`；
 * 直接传给 `effectiveCombo` 过不了类型检查，而用 `as HotkeyId`
 * 断言会把"id 写错了"这类真问题抹平 —— 拼错的 id 会静默取不到键位，
 * 界面上表现为"这个按钮没有快捷键提示"，没人会想到是 id 拼错。
 *
 * 判定用 `HOTKEY_BY_ID` 而不是另写一份 id 列表：
 * 抄一份列表的话，往 `HOTKEYS` 里加动作时忘了同步这里，
 * 新动作的键位提示就会永远不显示。
 */
export function isHotkeyId(id: string): id is HotkeyId {
  return Object.prototype.hasOwnProperty.call(HOTKEY_BY_ID, id);
}

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
  // 按 order **正序**输出：mod/ctrl 在前、shift 居中、alt 在后。
  // 曾经写成 reverse，结果 Ctrl+Shift+G 被显示成 Shift+Ctrl+G。
  const out: string[] = [];
  for (const m of order) {
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

/**
 * 是否 macOS。键位提示要按平台显示 ⌘ 还是 Ctrl。
 *
 * **全项目只此一份**：工具栏按钮与说明弹窗都要用它，
 * 两份各自算的话，在测试环境（navigator 不存在）下都会得到 false，
 * 而在真实环境一旦某处换了判定方式，就会出现
 * "按钮显示 ⌘、说明里写 Ctrl"——用户照其中一个按却没反应。
 */
export const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
