/**
 * 按钮上的快捷键提示（#50）。
 *
 * **键位一律从 HOTKEYS 动态取，不手抄**。
 * 手抄的后果在这个项目里已经出现过一次：README 写"MCP 工具 13 个"、
 * 实际注册 24 个 —— 同一份事实抄了两遍，改一边另一边就漂。
 * 键位提示若手抄，改键位后按钮上显示的还是旧值，而 tooltip 是新的，
 * 用户按按钮上的提示去按却没反应。
 */

import { effectiveCombo, formatCombo, isHotkeyId } from './hotkeys';

/*
 * 不再做「按钮文案 → 键位 id」的映射表。
 *
 * 原因：按钮文案会随措辞改（"备份"改"立即备份"），而 id 是键位表的键 ——
 * 靠文案反查 id 的话，改一次措辞就**静默失去提示**（不报错，只是按钮上
 * 不再显示键位）。调用方直接传 id（`comboHint('backupNow')`）就没有这层耦合。
 */

/**
 * 取某个动作当前生效的键位（已应用用户覆盖），用于显示。
 *
 * 返回空串表示该动作**被用户取消绑定**了 —— 此时按钮上不该显示任何提示，
 * 而不是退回默认值（用户取消绑定就是要它不再存在）。
 */
export function comboHintOf(
  actionId: string,
  overrides: Record<string, string> | null | undefined,
  isMac: boolean,
): string {
  /* 收窄而不是断言：拼错的 id 静默取不到键位，界面上只是"没提示" */
  const c = isHotkeyId(actionId) ? effectiveCombo(actionId, overrides ?? null) : '';
  return c ? formatCombo(c, isMac) : '';
}

/**
 * 是否显示键位提示。
 *
 * 三处都要满足才显示：
 *   · 设置里开了（#50 的开关）
 *   · 该动作有键位（可能已被取消绑定）
 *   · 有对应的动作 id（不是每个按钮都有快捷键）
 */
export function shouldShowHint(
  enabled: boolean,
  actionId: string | undefined,
  overrides: Record<string, string> | null | undefined,
): boolean {
  if (!enabled || !actionId) return false;
  return isHotkeyId(actionId) ? !!effectiveCombo(actionId, overrides ?? null) : false;
}

/**
 * 工具栏按钮上要显示的键位串（已格式化），拿不到就是空串。
 *
 * 这是 App 侧**唯一**的入口：显示与否的判据（开关 / 有 id / 没被取消绑定）
 * 和格式化都在这里，调用方不该再各写一份 `showHints && isHotkeyId(...)`。
 */
export function toolbarHint(
  actionId: string,
  overrides: Record<string, string> | null | undefined,
  isMac: boolean,
  enabled: boolean,
): string {
  if (!shouldShowHint(enabled, actionId, overrides)) return '';
  /* 不用 `actionId!`：测试直接吃这份源码，剥离器处理不了 `x!` 这种形态 */
  return comboHintOf(actionId ?? '', overrides, isMac);
}
