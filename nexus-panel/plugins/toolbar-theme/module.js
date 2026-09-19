/**
 * 工具栏插件：切换主题
 *
 * 原先硬编码在标题栏里的 ◐ 按钮，现在抽成插件 ——
 * 右上角那排位置变成插件显示口，将来第三方也能往那儿放东西。
 *
 * 选择器本身在 js/theme-picker.js（与无构建模式共用同一份实现），
 * 这里只负责"点开它并挂到按钮下方"。
 */
import { openThemePicker } from '../../js/theme-picker.js';

export default {
  id: 'toolbar-theme',
  label: '◐',
  tip: '切换主题（缩略图选择）',
  order: 10,
  onClick(api) {
    openThemePicker({
      anchor: api.el,
      onPick: (t) => {
        if (t) api.toast(`已切换到「${t.name}」`, 'ok');
      },
    });
  },
};
