/**
 * 项目范围 —— 任务面板「只看本项目的记录」。
 *
 * ================= 为什么需要它 =================
 *
 * 任务是全局的：所有画布（流程）的运行记录混在一个列表里。
 * 项目一多，盯自己那几条要在几百条里翻；更麻烦的是后面要接
 * AI 自动布置与领取任务 —— 那时跨项目的记录混在一起就是
 * **上下文污染**：一个项目的待办会被另一个项目的记录挤掉，
 * 而模型分不清哪条该它领。
 *
 * 所以先在数据层把"这条记录属于哪个项目"定死，
 * 界面只是把它显示出来。AI 侧领取任务时调的是同一个判定，
 * 不会和界面看到的范围分叉。
 *
 * ================= 项目 = 画布分组 =================
 *
 * 工具里已有「画布分组」（canvasGroups），它就是把若干画布归成一堆，
 * 语义上正是"一个项目下的几张图"。所以不新建一层概念 ——
 * 新建一层就要维护两份归属，而两份归属迟早不一致。
 *
 * ================= 三种范围 =================
 *
 *   all        全部项目（默认）
 *   group      某个分组
 *   ungrouped  不属于任何分组的画布
 *
 * 「未分组」是必需的第三档：不是每张画布都被归了组，
 * 少了它就没有任何一个范围能看到那些画布的记录 ——
 * 于是"切到某个项目后，我那张独立画布的记录凭空消失了"。
 */

import type { CanvasGroup } from './canvasGroups';

/*
  类型**转手导出**一份：用到的地方（组件、测试）都从这里拿。
  少的那一跳是刻意的 —— 直接 import canvasGroups 会把 kv（依赖
  localStorage）也拉进依赖图，纯逻辑的测试在 node 里就跑不起来。
  这里是 `export type`，编译后整条 import 被擦除，运行时零依赖。
*/
export type { CanvasGroup };

export type ProjectScope =
  | { kind: 'all' }
  | { kind: 'group'; groupId: string }
  | { kind: 'ungrouped' };

export const ALL_SCOPE: ProjectScope = { kind: 'all' };
export const UNGROUPED_SCOPE: ProjectScope = { kind: 'ungrouped' };

/** 存进 kv 的形态。归一在这里，别处不再各判一次 */
export function scopeKeyOf(s: ProjectScope): string {
  if (s.kind === 'group') return `g:${s.groupId}`;
  if (s.kind === 'ungrouped') return 'ungrouped';
  return 'all';
}

/**
 * 反解。认不出的一律回 **全部** ——
 * 存着一个已经删掉的分组时，最坏结果是多看几条别的项目的记录，
 * 而不是打开就一片空白（那看着像"任务全丢了"）。
 */
export function parseScopeKey(v: unknown): ProjectScope {
  if (typeof v !== 'string') return ALL_SCOPE;
  if (v === 'ungrouped') return UNGROUPED_SCOPE;
  if (v.startsWith('g:')) {
    const id = v.slice(2);
    return id ? { kind: 'group', groupId: id } : ALL_SCOPE;
  }
  return ALL_SCOPE;
}

/* ------------------------------------------------------------------ */
/* 归属索引                                                            */
/* ------------------------------------------------------------------ */

export type ProjectIndex = {
  /** 画布 id → 所属分组 id。同一画布被放进多个组时取**第一个** */
  groupOf: Map<string, string>;
  /** 分组 id → 成员画布 id */
  membersOf: Map<string, Set<string>>;
  /** 当前存在的画布 id */
  liveCanvases: Set<string>;
};

/**
 * 建索引。
 *
 * 按 groups 的顺序取第一个所属组，而不是让一张画布同时属于多个组：
 * 同时属于多组的话，同一个项目的记录会在两个项目里各出现一次，
 * 而"同一条任务在两个项目里都显示"正是要避免的那种混乱。
 */
export function buildProjectIndex(
  groups: CanvasGroup[],
  canvasIds: string[],
): ProjectIndex {
  const groupOf = new Map<string, string>();
  const membersOf = new Map<string, Set<string>>();
  for (const g of groups) {
    const set = new Set<string>();
    for (const id of g.members) {
      set.add(id);
      if (!groupOf.has(id)) groupOf.set(id, g.id);
    }
    membersOf.set(g.id, set);
  }
  return { groupOf, membersOf, liveCanvases: new Set(canvasIds) };
}

/**
 * 这条记录是否落在范围内。
 *
 * 画布**已经被删**的记录：只在「全部项目」下可见。
 *
 * 它不属于任何活着的项目，放进某个项目视图里就是一条无主的记录 ——
 * 删了画布还留着它上次跑的记录，正是"这个项目里怎么有条我不认识的"。
 */
export function scopeMatches(scope: ProjectScope, canvasId: string, idx: ProjectIndex): boolean {
  if (scope.kind === 'all') return true;
  if (!idx.liveCanvases.has(canvasId)) return false;
  const g = idx.groupOf.get(canvasId);
  if (scope.kind === 'group') return g === scope.groupId;
  return g === undefined;
}

export function filterByScope<T extends { canvasId: string }>(
  items: T[],
  scope: ProjectScope,
  idx: ProjectIndex,
): T[] {
  if (scope.kind === 'all') return items;
  return items.filter((it) => scopeMatches(scope, it.canvasId, idx));
}

/* ------------------------------------------------------------------ */
/* 选项                                                                */
/* ------------------------------------------------------------------ */

export type ScopeOption = {
  /** 直接就是 kv 里的形态，选中即存，不再来回转换 */
  key: string;
  label: string;
  /** 该项目下的画布数。0 也显示 —— 空项目也要能选，否则看不出它存在 */
  count: number;
};

/**
 * 下拉选项。
 *
 * 一个分组都没有时返回空数组 —— 此时调用方**隐藏切换器**：
 * 只放一个「全部项目」的下拉，等于摆了个点不动的控件，
 * 而且会让人以为"项目"是个还没配好的功能。
 */
export function scopeOptions(
  groups: CanvasGroup[],
  canvasIds: string[],
): ScopeOption[] {
  if (groups.length === 0) return [];
  const idx = buildProjectIndex(groups, canvasIds);
  const out: ScopeOption[] = [{ key: 'all', label: '全部项目', count: canvasIds.length }];
  for (const g of groups) {
    const n = canvasIds.filter((id) => idx.groupOf.get(id) === g.id).length;
    out.push({ key: scopeKeyOf({ kind: 'group', groupId: g.id }), label: g.name, count: n });
  }
  const loose = canvasIds.filter((id) => idx.groupOf.get(id) === undefined).length;
  out.push({ key: 'ungrouped', label: '未分组', count: loose });
  return out;
}

/**
 * 把存下来的范围归到当前还存在的分组上。
 *
 * 分组被删了以后，存着的 groupId 就指不到任何东西 ——
 * 不修的话切过去**一条记录都没有**，而界面上看不出是这个项目没了，
 * 还是任务真的全空了。回落「全部」至少还有东西可看。
 */
export function normalizeScope(scope: ProjectScope, groups: CanvasGroup[]): ProjectScope {
  if (scope.kind !== 'group') return scope;
  return groups.some((g) => g.id === scope.groupId) ? scope : ALL_SCOPE;
}

/** 当前范围的显示名。头部要写"当前项目" */
export function scopeLabel(scope: ProjectScope, groups: CanvasGroup[]): string {
  if (scope.kind === 'ungrouped') return '未分组';
  if (scope.kind === 'group') {
    const g = groups.find((x) => x.id === scope.groupId);
    return g ? g.name : '全部项目';
  }
  return '全部项目';
}
