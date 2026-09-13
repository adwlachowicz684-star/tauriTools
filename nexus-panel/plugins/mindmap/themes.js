/**
 * 思维导图插件 · 主题 / 布局元数据
 * ------------------------------------------------------------
 * 与 C# 侧 KityMinderContract.cs 一一对应（值经 kityminder-core 运行时核验）。
 * 注意：core 另有 -compact / -compat 变体未列出。
 */

/** 内置配色主题：值 / 中文名 / 参考底色（仅用于 UI 色块预览） */
export const THEMES = [
  { value: 'fresh-blue', label: '清新蓝', bg: '#FBFBFB', root: '#73A1BF' },
  { value: 'fresh-green', label: '清新绿', bg: '#FBFBFB', root: '#73BF76' },
  { value: 'fresh-red', label: '清新红', bg: '#FBFBFB', root: '#BF7373' },
  { value: 'fresh-soil', label: '土壤棕', bg: '#FBFBFB', root: '#BF9373' },
  { value: 'fresh-purple', label: '清新紫', bg: '#FBFBFB', root: '#7B73BF' },
  { value: 'fresh-pink', label: '清新粉', bg: '#FBFBFB', root: '#BF7394' },
  { value: 'snow', label: '雪白', bg: '#3A4144', root: '#E9DF98' },
  { value: 'classic', label: '经典黄', bg: '#3A4144', root: '#E9DF98' },
  { value: 'wire', label: '线框灰', bg: '#000000', root: '#999999' },
  { value: 'fish', label: '青色', bg: '#3A4144', root: '#E9DF98' },
];

/** 布局模板：与编辑器【外观】页签模板下拉一致 */
export const LAYOUTS = [
  { value: 'default', label: '思维导图' },
  { value: 'right', label: '逻辑结构图' },
  { value: 'filetree', label: '目录组织图' },
  { value: 'structure', label: '组织结构图' },
  { value: 'fish-bone', label: '鱼骨头图' },
  { value: 'tianpan', label: '天盘图' },
];

export const DEFAULT_THEME = 'fresh-blue';
export const DEFAULT_LAYOUT = 'default';

/**
 * 自定义主题的默认调色板。
 * 键名刻意与 kityminder-core 主题表解耦：编辑器页的 registerCustomTheme() 负责
 * 把这套扁平字段翻译进 core 的主题对象（含默认值兜底）。
 */
export function blankTheme(id, name) {
  return {
    id,
    name: name || '自定义主题',
    palette: {
      background: '#FBFBFB',
      textColor: '#333333',
      selectedColor: '#2B6CB0',
      connectColor: '#4A90D9',
      connectWidth: 2,
      rootBackground: '#4A90D9',
      rootFontSize: 16,
      rootRadius: 5,
      rootSpace: 10,
      mainBackground: '#DCE9F7',
      mainFontSize: 14,
      mainRadius: 3,
      mainSpace: 5,
      mainMargin: 20,
      subBackground: '#FFFFFF',
      subFontSize: 12,
      subRadius: 5,
      subSpace: 5,
      subMargin: 20,
    },
  };
}

/** 主题名 → 是否内置 */
export function isBuiltinTheme(name) {
  return THEMES.some((t) => t.value === name);
}
