/**
 * 快捷键：解析与匹配（**宿主侧、SDK 侧、外壳展示侧共用**）
 * ============================================================
 * 为什么要有这个文件：
 *
 * 此前「判断一次按键是否匹配某个 combo」有**两份实现**，且语义不一致：
 *
 *   · js/host.js        `accelMatches(e, accel)` —— 宿主的应用级快捷键。
 *                       认数字小键盘（Numpad/Digit），
 *                       但**不认 F5 / esc / space / '?' / super**。
 *   · js/plugin-sdk.js  `parseCombo` + `matchCombo` —— 插件侧与外壳保留键。
 *                       认 F5 / esc / space / '?' / super，
 *                       但**不认数字小键盘**。
 *
 * 两份各自都"能用"，于是长期没人发现它们不一致。后果是同一件事
 * 换个位置就换一套规则：
 *
 *   · 插件注册 `Ctrl+F5`（走宿主那条路）→ **注册成功、永不触发、不报错**；
 *   · 外壳保留键里的 `esc`（走 SDK 那条路）→ 在小键盘场景下不匹配。
 *
 * 现在收成一份，语义取**并集**：两边原本能匹配的都仍然匹配。
 * 这不是"折中"，是补掉各自的静默失效。
 *
 * ------------------------------------------------------------
 * 刻意**不**纳入的：`normCombo`（在 js/shell-shortcuts.js）。
 *
 * 它是"归一化成可比较的串"用于**撞车判断**，不是"判断这一次按键"，
 * 用途不同、输出形态也不同（排序后 join）。硬并进来只会让两边都别扭。
 * 它仍然调用本文件的 isMac()，所以平台判断只有一份。
 */

/**
 * 是否 macOS（mod 键的平台归属靠它决定）。
 *
 * 带 try：`navigator` 在隔离态 iframe（opaque origin）里访问会抛，
 * 而快捷键匹配可能发生在任何一侧 —— 平台判断不该让整个匹配崩掉。
 */
export function isMac() {
  try {
    return /mac|iphone|ipad/i.test(
      globalThis.navigator?.platform || globalThis.navigator?.userAgent || '',
    );
  } catch {
    return false;
  }
}

/**
 * 解析 combo 串（'Mod+K' / 'Ctrl+Shift+1' / 'F5' / 'esc' / '?'）。
 *
 * @returns {{key:string, mod:boolean, ctrl:boolean, shift:boolean,
 *            alt:boolean, meta:boolean}|null}
 *          没有主键（只有修饰键、或空串）时返回 null —— 这样的 combo
 *          永远不该匹配任何按键，返回 null 让调用方直接短路。
 */
export function parseCombo(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const spec = { key: '', mod: false, ctrl: false, shift: false, alt: false, meta: false };
  for (const p of parts) {
    if (p === 'mod') { spec.mod = true; }
    else if (p === 'ctrl' || p === 'control') { spec.ctrl = true; }
    else if (p === 'shift') { spec.shift = true; }
    else if (p === 'alt' || p === 'option') { spec.alt = true; }
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'super') { spec.meta = true; }
    else spec.key = p;
  }
  if (!spec.key) return null;
  return spec;
}

/**
 * 判断一次按键事件是否匹配已解析的 spec。
 *
 * 修饰键是**严格**双向匹配：声明了必须按下，没声明必须没按。
 * 否则 `mod+k` 会被 `ctrl+alt+k` 误触发 —— 那是最难排查的一类
 * （用户按了别的键，却执行了 alt+k 之外的动作）。
 *
 * 唯一的例外是 `mod`：它按平台展开成 meta 或 ctrl，
 * 展开出来的那一个不算"多按了"。
 */
export function matchCombo(e, spec) {
  if (!spec || !e) return false;
  // mod：macOS 认 meta，其它认 ctrl
  if (spec.mod && !(isMac() ? e.metaKey : e.ctrlKey)) return false;
  const metaOk = spec.meta ? e.metaKey : !e.metaKey || (spec.mod && isMac());
  const ctrlOk = spec.ctrl ? e.ctrlKey : !e.ctrlKey || (spec.mod && !isMac());
  if (!metaOk || !ctrlOk) return false;
  if (spec.alt !== e.altKey) return false;
  if (spec.shift !== e.shiftKey) return false;

  const k = String(e.key || '').toLowerCase();
  const code = String(e.code || '').toLowerCase();
  if (k === spec.key) return true;
  // 功能键：code 形如 f5 / escape
  if (code === spec.key) return true;
  if (code === 'key' + spec.key) return true;         // 'k' → keyk
  // 数字键：同时兼容主键盘与数字小键盘（来自宿主那份的既有行为）
  if (/^[0-9]$/.test(spec.key)) {
    if (code === `digit${spec.key}` || code === `numpad${spec.key}`) return true;
  }
  if (spec.key === 'esc' && k === 'escape') return true;
  if (spec.key === 'space' && (k === ' ' || code === 'space')) return true;
  if (spec.key === '?' && k === '?') return true;
  return false;
}

/**
 * 一步到位：拿原始 combo 串跟事件比。
 *
 * 宿主侧的 registerAppShortcut 用它 —— 那边每次都传字符串，
 * 不需要先 parse 一次再复用（复用发生在 Map 的 key 上，不是 spec 上）。
 */
export function accelMatches(e, accel) {
  return matchCombo(e, parseCombo(accel));
}
