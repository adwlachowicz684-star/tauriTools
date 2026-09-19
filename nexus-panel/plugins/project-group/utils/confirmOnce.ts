/**
 * 「本次运行期间不再提示」的开关（#43）。
 *
 * **刻意用模块级变量而不是 config**：
 * 这个勾选项是"本次客户端期间"的临时意愿 —— 关掉软件就该恢复提示。
 * 写进 config 的话，用户哪天勾了一次就再也不会看到确认弹窗，
 * 等他忘了这回事、误发一条指令时，根本想不起来是这里关掉的。
 *
 * 模块级变量的生命周期 = 页面存活期间。插件跑在 iframe 里，
 * 刷新或重启就重置，正好就是"本次客户端期间"的语义。
 */

let skip = false;

/** 是否需要弹确认 */
export const needConfirm = (): boolean => !skip;

/** 设置"不再提示" */
export const setSkipConfirm = (v: boolean): void => { skip = v; };

/** 当前是否已设为不再提示（供界面回显勾选状态） */
export const isSkipConfirm = (): boolean => skip;
