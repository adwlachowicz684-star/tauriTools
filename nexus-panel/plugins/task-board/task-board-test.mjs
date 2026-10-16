// task-board 纯逻辑单测（node 直接跑，无依赖）
// 覆盖 core.mjs：状态机、归一化、排序、过滤、历史上限、时间格式化。
// 登记在 package.json：test:tb-core

import {
  STATUSES,
  canTransition,
  actionsFor,
  normalizeTask,
  normalizeStore,
  sortTasks,
  filterTasks,
  allTags,
  nextTaskId,
  pushHistory,
  applyTransition,
  fmtTime,
  relTime,
  groupTasks,
  sortTasksBy,
  statsOf,
  UNASSIGNED,
  NOTAG,
} from './core.mjs';

let pass = 0;
let fail = 0;
function t(name, cond) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`✗ ${name}`);
  }
}

/* ---------------- 状态机 ---------------- */
t('todo 可认领', canTransition('todo', 'claimed'));
t('todo 可直接开工', canTransition('todo', 'doing'));
t('todo 不能直接送审', !canTransition('todo', 'review'));
t('claimed 可开工', canTransition('claimed', 'doing'));
t('claimed 可退回', canTransition('claimed', 'todo'));
t('claimed 不能送审（必须先开工）', !canTransition('claimed', 'review'));
t('doing 可送审', canTransition('doing', 'review'));
t('review 可通过', canTransition('review', 'done'));
t('review 可打回', canTransition('review', 'doing'));
t('done 可重开', canTransition('done', 'review'));
t('done 不能回 doing（只能走 review）', !canTransition('done', 'doing'));
t('非法状态拒绝', !canTransition('todo', 'nope'));
t('自流转允许', canTransition('doing', 'doing'));

t('todo 操作含认领+开始', actionsFor('todo').map((a) => a.to).join() === 'claimed,doing');
t('review 的打回必须写备注', actionsFor('review').find((a) => a.to === 'doing').needNote === true);
t('done 只有重开', actionsFor('done').length === 1 && actionsFor('done')[0].to === 'review');

/* ---------------- 归一化 ---------------- */
const nt = normalizeTask({ id: 'x', title: 't' });
t('normalizeTask 补 status', nt.status === 'todo');
t('normalizeTask 补 priority', nt.priority === 'P2');
t('normalizeTask tags 空数组', Array.isArray(nt.tags) && nt.tags.length === 0);
t('normalizeTask assignee null', nt.assignee === null);
t('normalizeTask 坏数据不炸', normalizeTask(null).title === '(无标题)');
t('normalizeTask 过滤非字符串 tag', normalizeTask({ tags: ['a', 1, null, 'b'] }).tags.join() === 'a,b');

const ns = normalizeStore(null);
t('normalizeStore 空库 nextId=1', ns.nextId === 1 && ns.tasks.length === 0 && ns.agents.length === 0);
t('normalizeStore tasks 非数组按空处理', normalizeStore({ tasks: 'oops' }).tasks.length === 0);
t('normalizeStore nextId 非法回 1', normalizeStore({ nextId: -5 }).nextId === 1);
t('normalizeStore agents 补 name/role', (() => {
  const a = normalizeStore({ agents: [{ id: 'dev-a' }] }).agents[0];
  return a.name === 'dev-a' && a.role === 'dev';
})());

/* ---------------- 排序 ---------------- */
const mk = (id, priority, updatedAt) => ({ id, title: id, detail: '', status: 'todo', priority, tags: [], reporter: 'x', assignee: null, createdAt: 0, updatedAt, history: [] });
const sorted = sortTasks([mk('a', 'P3', 30), mk('b', 'P0', 10), mk('c', 'P1', 20), mk('d', 'P1', 99)]);
t('排序：优先级优先', sorted.map((x) => x.id).join() === 'b,d,c,a');

/* ---------------- 过滤 ---------------- */
const list = [
  { ...mk('t1', 'P0', 1), tags: ['bug', 'ui'], assignee: 'dev-a' },
  { ...mk('t2', 'P2', 2), tags: ['feat'], assignee: null },
];
t('过滤优先级', filterTasks(list, { priority: 'P0' }).length === 1);
t('过滤标签', filterTasks(list, { tag: 'feat' })[0].id === 't2');
t('过滤未认领', filterTasks(list, { assignee: '__none__' })[0].id === 't2');
t('过滤认领人', filterTasks(list, { assignee: 'dev-a' })[0].id === 't1');
t('关键词命中 id', filterTasks(list, { q: 't2' }).length === 1);
t('关键词不命中', filterTasks(list, { q: 'zzz' }).length === 0);

/* ---------------- 标签统计 ---------------- */
t('allTags 按次数倒序去重（同次数保持插入序）', allTags([...list, { ...mk('t3', 'P2', 3), tags: ['bug'] }]).join() === 'bug,ui,feat');

/* ---------------- id ---------------- */
t('nextTaskId 四位补零', nextTaskId({ nextId: 7 }) === 'tb-0007');
t('nextTaskId 进位不丢', nextTaskId({ nextId: 12345 }) === 'tb-12345');

/* ---------------- 历史 ---------------- */
let h = mk('h1', 'P2', 0);
for (let i = 0; i < 120; i++) h = pushHistory(h, 'dev-a', 'note', `n${i}`, 1000 + i);
t('pushHistory 上限 100', h.history.length === 100);
t('pushHistory 保留最新', h.history[99].note === 'n119');
t('pushHistory 刷 updatedAt', h.updatedAt === 1119);

/* ---------------- 流转 ---------------- */
const base = mk('f1', 'P2', 0);
const moved = applyTransition(base, 'doing', 'dev-a', '开工', 555);
t('applyTransition 改状态', moved.status === 'doing');
t('applyTransition 记历史', moved.history.length === 1 && moved.history[0].note === 'todo -> doing（开工）');
t('applyTransition 刷 updatedAt', moved.updatedAt === 555);
t('applyTransition 拒非法流转', applyTransition(base, 'done', 'x') === null);
t('applyTransition 不改原对象', base.status === 'todo');

/* ---------------- 时间 ---------------- */
const now = Date.now();
t('fmtTime 今天给时分', /^\d{2}:\d{2}$/.test(fmtTime(now)));
t('fmtTime 0 给占位', fmtTime(0) === '—');
t('relTime 刚刚', relTime(now - 30_000) === '刚刚');
t('relTime 分钟前', relTime(now - 5 * 60_000) === '5 分钟前');
t('relTime 小时前', relTime(now - 3 * 3600_000) === '3 小时前');
t('relTime 天前', relTime(now - 2 * 24 * 3600_000) === '2 天前');

/* ---------------- 分组（groupTasks） ---------------- */
const gl = [
  { ...mk('g1', 'P0', 1), status: 'done', assignee: 'dev-a', tags: ['bug'] },
  { ...mk('g2', 'P1', 2), status: 'todo', assignee: null, tags: ['ui', 'perf'] },
  { ...mk('g3', 'P2', 3), status: 'doing', assignee: 'dev-a', tags: [] },
  { ...mk('g4', 'P1', 4), status: 'doing', assignee: 'dev-b', tags: ['bug', 'ui'] },
];
t('分组 status：按固定顺序只返回非空组', groupTasks(gl, 'status').map((g) => g.key).join() === 'todo,doing,done');
t('分组 status：组内任务正确', groupTasks(gl, 'status').find((g) => g.key === 'done').tasks[0].id === 'g1');
t('分组 status：空组不出现', groupTasks(gl, 'status').every((g) => g.tasks.length > 0));
t('分组 priority：按固定顺序', groupTasks(gl, 'priority').map((g) => g.key).join() === 'P0,P1,P2');
t('分组 assignee：未认领置顶', groupTasks(gl, 'assignee')[0].key === UNASSIGNED);
t('分组 assignee：其余按数量倒序', groupTasks(gl, 'assignee').map((g) => g.key).join() === '__none__,dev-a,dev-b');
t('分组 assignee：未认领组只含无主任务', groupTasks(gl, 'assignee')[0].tasks.every((x) => x.assignee === null));
t('分组 tag：并集语义（多标签任务同时进多组）', groupTasks(gl, 'tag').find((g) => g.key === 'bug').tasks.map((x) => x.id).sort().join() === 'g1,g4');
t('分组 tag：无标签任务进 __notag__', groupTasks(gl, 'tag').some((g) => g.key === NOTAG && g.tasks[0].id === 'g3'));
t('分组 tag：按数量倒序（同数量按 key 升序，伪分组 __notag__ 置尾）', groupTasks(gl, 'tag').map((g) => g.key).join() === 'bug,ui,perf,__notag__');
t('分组：空输入返回空数组', groupTasks([], 'status').length === 0);

/* ---------------- 排序（sortTasksBy） ---------------- */
const sl = [
  { ...mk('s1', 'P2', 10), title: '乙', assignee: 'dev-b', status: 'todo', createdAt: 5 },
  { ...mk('s2', 'P0', 30), title: '甲', assignee: null, status: 'done', createdAt: 9 },
  { ...mk('s3', 'P1', 20), title: '丙', assignee: 'dev-a', status: 'doing', createdAt: 1 },
];
t('sortTasksBy 优先级 asc', sortTasksBy(sl, 'priority', 'asc').map((x) => x.id).join() === 's2,s3,s1');
t('sortTasksBy 优先级 desc', sortTasksBy(sl, 'priority', 'desc').map((x) => x.id).join() === 's1,s3,s2');
t('sortTasksBy 状态 asc（todo 在前）', sortTasksBy(sl, 'status', 'asc').map((x) => x.id).join() === 's1,s3,s2');
t('sortTasksBy 状态 desc（done 在前）', sortTasksBy(sl, 'status', 'desc').map((x) => x.id).join() === 's2,s3,s1');
t('sortTasksBy 未认领恒排最后（asc 也拦不住）', sortTasksBy(sl, 'assignee', 'asc').map((x) => x.id).join() === 's3,s1,s2');
t('sortTasksBy 未认领恒排最后（desc 同样）', sortTasksBy(sl, 'assignee', 'desc').map((x) => x.id).join() === 's1,s3,s2');
t('sortTasksBy 更新时间倒序', sortTasksBy(sl, 'updatedAt', 'desc').map((x) => x.id).join() === 's2,s3,s1');
t('sortTasksBy 更新时间升序', sortTasksBy(sl, 'updatedAt', 'asc').map((x) => x.id).join() === 's1,s3,s2');
t('sortTasksBy 创建时间倒序', sortTasksBy(sl, 'createdAt', 'desc').map((x) => x.id).join() === 's2,s1,s3');
t('sortTasksBy 标题（中文按拼音）', sortTasksBy(sl, 'title', 'asc').map((x) => x.id).join() === 's3,s2,s1');
t('sortTasksBy 同级兜底 updatedAt 倒序', sortTasksBy([mk('x1', 'P1', 10), mk('x2', 'P1', 99)], 'priority', 'asc').map((x) => x.id).join() === 'x2,x1');
t('sortTasksBy 不改原数组', (() => {
  const src = [mk('o1', 'P2', 1), mk('o2', 'P0', 2)];
  sortTasksBy(src, 'priority', 'asc');
  return src[0].id === 'o1';
})());

/* ---------------- 统计（statsOf） ---------------- */
const NOW = 1_000_000_000_000;
const DAY = 24 * 3600 * 1000;
const statStore = {
  v: 1,
  nextId: 5,
  agents: [{ id: 'dev-a', name: '甲', role: 'dev', lastSeen: 1 }],
  tasks: [
    { ...mk('c1', 'P0', NOW - 30 * DAY), status: 'done', assignee: 'dev-a', tags: ['bug', 'ui'], createdAt: 1, history: [{ at: NOW - 2 * DAY, by: 'dev-a', action: 'status', note: 'doing -> done' }] },
    { ...mk('c2', 'P1', NOW - 8 * DAY), status: 'todo', assignee: null, tags: ['ui'], createdAt: 1, history: [{ at: NOW - 8 * DAY, by: 'manual', action: 'create', note: '' }] },
    { ...mk('c3', 'P2', NOW - 1 * DAY), status: 'doing', assignee: 'dev-a', tags: ['ui'], createdAt: 1, history: [{ at: NOW - 1 * DAY, by: 'dev-a', action: 'status', note: 'claimed -> doing' }] },
    { ...mk('c4', 'P3', NOW - 2 * DAY), status: 'review', assignee: 'dev-b', tags: [], createdAt: 1, history: [] },
  ],
};
const st = statsOf(statStore, NOW);
t('statsOf 总数', st.total === 4);
t('statsOf open = 未完成', st.open === 3);
t('statsOf active = doing+review', st.active === 2);
t('statsOf done', st.done === 1);
t('statsOf byStatus 全状态有键（含计数为 0 的）', STATUSES.every((s) => typeof st.byStatus[s] === 'number') && st.byStatus.claimed === 0 && st.byStatus.done === 1);
t('statsOf byPriority', st.byPriority.P0 === 1 && st.byPriority.P3 === 1 && st.byPriority.P2 === 1);
t('statsOf byAssignee 未认领置顶且按数倒序', st.byAssignee.map((x) => x.id).join() === '__none__,dev-a,dev-b');
t('statsOf topTags 前 10 且带计数', st.topTags[0].tag === 'ui' && st.topTags[0].count === 3);
t('statsOf recent 跨任务按时间倒序', st.recent.map((x) => x.taskId).join() === 'c3,c1,c2');
t('statsOf recent 上限 8 条', statsOf({ tasks: Array.from({ length: 10 }, (_, i) => ({ ...mk(`r${i}`, 'P2', 1), history: [{ at: i, by: 'x', action: 'note', note: '' }] })) }, NOW).recent.length === 8);
t('statsOf recent 带 taskId/title', st.recent[0].taskId === 'c3' && typeof st.recent[0].title === 'string');
t('statsOf stale = 未完成且超 7 天（done 不算陈旧）', st.stale.map((x) => x.id).join() === 'c2');
t('statsOf stale 按 updatedAt 升序（最僵硬在前）', (() => {
  const s2 = statsOf({ tasks: [mk('z1', 'P1', NOW - 8 * DAY), mk('z2', 'P1', NOW - 20 * DAY)] }, NOW);
  return s2.stale.map((x) => x.id).join() === 'z2,z1';
})());
t('statsOf 边界：刚满 7 天不算陈旧', statsOf({ tasks: [mk('edge', 'P1', NOW - 7 * DAY)] }, NOW).stale.length === 0);
t('statsOf agents 透传', st.agents.length === 1 && st.agents[0].name === '甲');
t('statsOf 空库不炸', statsOf({ v: 1, nextId: 1, tasks: [], agents: [] }, NOW).total === 0);

/* ---------------- 汇总 ---------------- */
console.log(`task-board core: 通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
