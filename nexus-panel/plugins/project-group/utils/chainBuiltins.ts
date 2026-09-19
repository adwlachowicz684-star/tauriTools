/**
 * 内置连锁动作的默认值（#47 恢复默认 / #46 开发者模式）。
 *
 * 与后端 chain.rs::BUILTIN 一一对应 —— 两边必须同数同序，
 * 否则"恢复默认"会把图标恢复成一个后端并不认识的值。
 * chain-builtins-test.mjs 会比对两边，改任一侧都要同步另一侧。
 */

/** 一个内置动作：id 即 builtin 字段的值 */
export interface BuiltinAction {
  id: string;
  name: string;
  icon: string;
}

/** 后端 chain.rs::BUILTIN 的镜像（顺序即默认展示顺序） */
export const BUILTIN_ACTIONS: readonly BuiltinAction[] = [
  { id: 'chain', name: '自由任务', icon: '💬' },
  { id: 'review', name: '一键审查', icon: '🔍' },
  { id: 'merge', name: '快速归并', icon: '🗜' },
  { id: 'deploy', name: '快速部署', icon: '🚀' },
];

/** 自定义动作的默认图标（新建时用，也是"恢复默认"对自定义项的目标） */
export const CUSTOM_DEFAULT_ICON = '🧩';

/** 取某动作的默认图标：内置按表查，自定义给 🧩 */
export function defaultIconOf(builtin: string | null | undefined): string {
  const b = (builtin ?? '').trim();
  if (!b) return CUSTOM_DEFAULT_ICON;
  return BUILTIN_ACTIONS.find((x) => x.id === b)?.icon ?? CUSTOM_DEFAULT_ICON;
}

/** 取某动作的默认名称：内置按表查；自定义没有"默认名"，返回空串表示不可恢复 */
export function defaultNameOf(builtin: string | null | undefined): string {
  const b = (builtin ?? '').trim();
  if (!b) return '';
  return BUILTIN_ACTIONS.find((x) => x.id === b)?.name ?? '';
}

/**
 * 能否删除（#46）。
 *
 * 内置动作默认**不可删**：它们是四个常用入口，误删之后
 * `ensure_actions` 只在清单为空时才重建，用户会以为软件坏了。
 * 开发者模式是那道"我知道我在做什么"的闸门。
 */
export function canRemove(builtin: string | null | undefined, devMode: boolean): boolean {
  const b = (builtin ?? '').trim();
  if (!b) return true;      // 自定义动作随时可删
  return devMode;
}

/**
 * 能否改名（#46）。
 *
 * 内置动作**始终可改名** —— 改名是可逆的、也不会让入口消失，
 * 与"删除"不是一个量级的风险，没必要一并锁起来。
 * 保留这个函数是为了让这条判断显式存在，而不是散落在 JSX 里。
 */
export function canRename(): boolean {
  return true;
}
