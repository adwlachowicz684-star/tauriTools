/**
 * 按钮上的快捷键提示（#50）。
 *
 * **键位一律从 HOTKEYS 动态取，不手抄**。
 * 手抄的后果在这个项目里已经出现过一次：README 写"MCP 工具 13 个"、
 * 实际注册 24 个 —— 同一份事实抄了两遍，改一边另一边就漂。
 * 键位提示若手抄，改键位后按钮上显示的还是旧值，而 tooltip 是新的，
 * 用户按按钮上的提示去按却没反应。
 */

import { effectiveCombo, formatCombo } from './hotkeys';

/** 工具栏按钮 → 快捷键 id 的映射。只有真有键位的才登记 */
export const TOOLBAR_HINT_IDS: Record<string, string> = {
  备份: 'backupNow',
  使用说明: 'toggleTips',
  刷新: 'refresh',
  清除无效项: 'clearInvalid',
};

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
  const c = effectiveCombo(actionId, overrides ?? null);
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
  return !!effectiveCombo(actionId, overrides ?? null);
}

/**
 * 按钮文案 + 键位拼成一行时的显示文本。
 *
 * 键位放**文字后面**而不是做成角标：按钮本来就不宽，
 * 角标会挤压文字；一行小字更省地方，也更好读。
 */
export function hintText(
  label: string,
  actionId: string | undefined,
  overrides: Record<string, string> | null | undefined,
  isMac: boolean,
  enabled: boolean,
): string {
  if (!shouldShowHint(enabled, actionId, overrides)) return label;
  /* 不用 `actionId!` 非空断言：测试要直接吃这份源码，
     而剥离器会把 `!` 留在表达式里（`x!` 不是它能处理的形态）。 */
  const id = actionId ?? '';
  return `${label}  ${comboHintOf(id, overrides, isMac)}`;
}
