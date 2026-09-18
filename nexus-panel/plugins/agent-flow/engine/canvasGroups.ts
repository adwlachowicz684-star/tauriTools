/**
 * 画布组 —— 把多张画布归到一起。
 *
 * ================= 为什么需要 =================
 *
 * 一整套数值拆成几十张画布后，侧边那一列会变得没法用：
 * 找不到、也看不出哪些是一套。
 *
 * 分组是**纯显示层**的归类，不改变执行语义 ——
 * 跨画布调用看的是画布引用节点，与分组无关。
 * 这一点必须说清，否则用户会以为"不在一个组里就不能互相调用"。
 *
 * ================= 为什么按 id 引用而不是嵌套 =================
 *
 * 组里存画布 id 列表，不把画布塞进组对象。
 * 嵌套的话删除一张画布要同时改两处，漏改就出现
 * "组里显示着一张已经不存在的画布"，点进去是空的。
 */

export type CanvasGroup = {
  id: string;
  name: string;
  /** 成员画布 id，按显示顺序 */
  members: string[];
  /** 折叠状态（纯界面，不进执行） */
  collapsed?: boolean;
};

export const GROUPS_KEY = 'agent-flow.canvasGroups.v1';

/* ---- 存储：与其余几处同一套口径（见 kv.ts） ---- */

import { defaultKV, loadList, saveWrapped, type KV } from './kv';

const GROUPS_VERSION = 1;
const GROUPS_FIELD = 'groups';

export function loadGroups(kv: KV = defaultKV()): CanvasGroup[] {
  return loadList(kv, GROUPS_KEY, GROUPS_FIELD) as CanvasGroup[];
}

export function saveGroups(list: CanvasGroup[], kv: KV = defaultKV()): void {
  saveWrapped(kv, GROUPS_KEY, GROUPS_VERSION, GROUPS_FIELD, list);
}

/**
 * 给一张画布生成默认组名。
 *
 * 用名字而不是序号：序号在删除中间某张后会全部错位。
 */
export function nextGroupName(existing: CanvasGroup[], base = '画布组'): string {
  const names = new Set((existing ?? []).map((g) => g.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 9999; i += 1) {
    const n = `${base} ${i}`;
    if (!names.has(n)) return n;
  }
  return `${base} ${Date.now()}`;
}

/** 一张画布属于哪个组；不在任何组返回 null */
export function groupOfCanvas(groups: CanvasGroup[], canvasId: string): CanvasGroup | null {
  for (const g of groups ?? []) {
    if ((g.members ?? []).includes(canvasId)) return g;
  }
  return null;
}

/**
 * 加入一个组。
 *
 * 一张画布只属于一个组 —— 加入新组时先从旧组移除。
 * 允许同时属于多组的话，界面上同一张画布会出现两次，
 * 拖动归类时无法判断该改哪个。
 */
export function addToGroup(
  groups: CanvasGroup[],
  groupId: string,
  canvasId: string,
): CanvasGroup[] {
  return (groups ?? []).map((g) => {
    const has = (g.members ?? []).includes(canvasId);
    if (g.id === groupId) {
      return has ? g : { ...g, members: [...(g.members ?? []), canvasId] };
    }
    return has ? { ...g, members: (g.members ?? []).filter((x) => x !== canvasId) } : g;
  });
}

export function removeFromGroup(groups: CanvasGroup[], canvasId: string): CanvasGroup[] {
  return (groups ?? []).map((g) =>
    (g.members ?? []).includes(canvasId)
      ? { ...g, members: (g.members ?? []).filter((x) => x !== canvasId) }
      : g);
}

/**
 * 清理指向已删除画布的成员引用。
 *
 * 删画布时必须调一次 —— 不清的话组里会留着孤儿 id，
 * 界面上显示一个空条目，点它什么也不会发生。
 *
 * ================= 为什么不顺手删掉变空的组 =================
 *
 * 早期版本会一并删掉"成员清空了的组"，结果**刚新建的空组被立刻删掉**：
 * 点「新建组」→ 组出现 → 清理 effect 发现它成员为空 → 删掉，
 * 用户看到的就是"点了没反应"。
 *
 * "刚建的、还没拖东西进去的空组"与"成员被删光了的空组"
 * 从数据上完全一样，分不开。所以只在**加载存档时**做一次清理
 * （见 dropEmptyGroups），运行时只清引用、不动组的存亡。
 *
 * 空组留着是可接受的：界面上能看到，用户自己知道怎么处理。
 * 而"组凭空消失"是没有任何线索的。
 */
export function pruneGroups(groups: CanvasGroup[], aliveIds: string[]): CanvasGroup[] {
  const alive = new Set(aliveIds ?? []);
  const out: CanvasGroup[] = [];
  for (const g of groups ?? []) {
    const kept = (g.members ?? []).filter((x) => alive.has(x));
    /*
     * 成员没变就不换对象 ——
     * 每次都返回新数组会让调用方的 setState 每次都触发，
     * 进而每次都写一遍 localStorage。
     * 画布内容是高频变化的（编辑一下就变），这个 effect 跑得非常勤。
     */
    if (kept.length === (g.members ?? []).length) {
      out.push(g);
      continue;
    }
    out.push({ ...g, members: kept });
  }
  return out;
}

/** 成员没变时返回原数组（引用相等），调用方可用它避免无谓的 setState */
export function pruneGroupsIfChanged(
  groups: CanvasGroup[],
  aliveIds: string[],
): CanvasGroup[] {
  const alive = new Set(aliveIds ?? []);
  let changed = false;
  const out = (groups ?? []).map((g) => {
    const kept = (g.members ?? []).filter((x) => alive.has(x));
    if (kept.length !== (g.members ?? []).length) changed = true;
    return kept.length === (g.members ?? []).length ? g : { ...g, members: kept };
  });
  return changed ? out : groups;
}

/**
 * 删掉成员为空的组 —— **只在加载存档时调一次**。
 *
 * 运行时调用会删掉刚新建的空组（见 pruneGroups 的说明）。
 */
export function dropEmptyGroups(groups: CanvasGroup[]): CanvasGroup[] {
  return (groups ?? []).filter((g) => (g.members ?? []).length > 0);
}

/**
 * 侧栏显示顺序：组内的画布排在组下，未分组的平铺。
 *
 * 返回的是"条目"序列，界面照着渲染即可 ——
 * 排序规则放在这里而不是组件里，改一次两边都生效。
 */
export type SidebarEntry =
  | { kind: 'group'; group: CanvasGroup; canvases: string[] }
  | { kind: 'canvas'; canvasId: string };

export function buildSidebar(
  canvases: { id: string }[],
  groups: CanvasGroup[],
): SidebarEntry[] {
  const inGroup = new Set<string>();
  for (const g of groups ?? []) {
    for (const m of g.members ?? []) inGroup.add(m);
  }
  const out: SidebarEntry[] = [];
  for (const g of groups ?? []) {
    const members = (g.members ?? []).filter((m) => (canvases ?? []).some((c) => c.id === m));
    if (members.length === 0) continue;
    out.push({ kind: 'group', group: g, canvases: members });
  }
  for (const c of canvases ?? []) {
    if (!inGroup.has(c.id)) out.push({ kind: 'canvas', canvasId: c.id });
  }
  return out;
}
