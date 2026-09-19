/**
 * 连锁动作模板的占位符清单（#501）。
 *
 * 集中放在这里，是为了让「界面插入按钮」与「后端实际替换」共用同一份真源 ——
 * 早先是界面上写一句提示文字、后端在 `chain.rs::fill_all` 里 replace，
 * 两边各写各的，加一个占位符要改两处，漏一处就是"按钮插进去却不生效"。
 * `chain-test.mjs` 会比对这份清单与 fill_all 的 replace 调用，对不上直接判红。
 */

export interface PlaceholderDef {
  /** 字面量，含花括号，插入时原样写入 */
  token: string;
  /** 按钮上显示的名字（去掉花括号，避免按钮过宽） */
  label: string;
  /** 分组：本插件写法 / 原版兼容写法 / 工具相关 */
  group: 'own' | 'legacy' | 'tool';
  /** 悬浮说明：说清它会被替换成什么 */
  hint: string;
}

export const PLACEHOLDERS: PlaceholderDef[] = [
  { token: '{path}', label: 'path', group: 'own', hint: '当前卡片文件夹的完整路径' },
  { token: '{name}', label: 'name', group: 'own', hint: '当前卡片文件夹名（不含上级路径）' },
  { token: '{项目路径}', label: '项目路径', group: 'legacy', hint: '原版写法，等价于 {path}' },
  { token: '{项目名称}', label: '项目名称', group: 'legacy', hint: '原版写法，等价于 {name}' },
  { token: '{工具根目录}', label: '工具根目录', group: 'tool', hint: '数据目录（原版指 exe 所在目录）' },
  { token: '{工具路径}', label: '工具路径', group: 'tool', hint: '数据目录，与 {工具根目录} 同值' },
  { token: '{工具文件名}', label: '工具文件名', group: 'tool', hint: '宿主程序名（nexus-panel）' },
];

export const GROUP_TITLE: Record<PlaceholderDef['group'], string> = {
  own: '本项目',
  legacy: '原版兼容',
  tool: '工具',
};

export const GROUP_ORDER: PlaceholderDef['group'][] = ['own', 'legacy', 'tool'];

/** 按分组顺序取，供界面渲染 */
export function placeholdersByGroup(): { group: PlaceholderDef['group']; items: PlaceholderDef[] }[] {
  return GROUP_ORDER.map((g) => ({ group: g, items: PLACEHOLDERS.filter((p) => p.group === g) }));
}

/**
 * 在光标处插入文本，返回 [新值, 插入后的光标位置]。
 *
 * 两个细节决定了它好不好用：
 *   · **有选中时替换选中部分**——符合所有编辑器的习惯，而不是把内容插到选中前面；
 *   · **返回光标下标**——受控组件重渲染后焦点位置会丢，调用方要按这个下标还原，
 *     否则连续插入两个占位符时，第二个会跑到第一个前面去（很难查的"顺序怪"）。
 */
export function insertAtCursor(
  value: string,
  selStart: number | null,
  selEnd: number | null,
  text: string,
): { next: string; caret: number } {
  const len = value.length;
  const start = Math.max(0, Math.min(selStart ?? len, len));
  const end = Math.max(start, Math.min(selEnd ?? len, len));
  const next = value.slice(0, start) + text + value.slice(end);
  return { next, caret: start + text.length };
}
