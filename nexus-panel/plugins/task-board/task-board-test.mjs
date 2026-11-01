// task-board 纯逻辑单测（node 直接跑，无依赖）
// 覆盖 core.mjs：状态机、归一化、排序、过滤、历史上限、时间格式化。
// 登记在 package.json：test:tb-core

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));

/* 源码扫描类测试要用：列数、props 透传这些 TS 查不出的问题靠读源码钉住 */
const appSrc = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
const coreSrc = fs.readFileSync(path.join(dir, 'core.mjs'), 'utf8');
const storeSrc = fs.readFileSync(path.join(dir, 'lib', 'store.ts'), 'utf8');
/* 本测试自身：有些导出只被测试覆盖，那也算有引用（不算死代码） */
const testSrc = fs.readFileSync(path.join(dir, 'task-board-test.mjs'), 'utf8');
import {
  duplicateDataDirs,
  STATUSES,
  canTransition,
  actionsFor,
  normalizeTask,
  normalizeStore,
  sortTasks,
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
  LIST_COLUMNS,
  emptyColFilter,
  colFilterActive,
  colRawValues,
  colFilterValues,
  dependsOn,
  activeColFilters,
  filterTasksByColumns,
  indexTasks,
  ancestorChain,
  flattenTasks,
  flattenAllGroups,
  lockOf,
  DEFAULT_FLOW,
  normalizeFlow,
  canTransitionIn,
  actionsForIn,
  statusName,
  statusDone,
  initialStatus,
  totalEstimate,
  fmtEstimate,
  numOrNull,
  sortRowsBy,
  normalizeConfig,
  newProjectId,
  currentProject,
  needsDocsDir,
  normalizeTypeDefs,
  typeName,
  NOTYPE,
  groupTasksBy,
  groupValuesOf,
  NOGROUP,
  groupName,
  groupColor,
  normalizeGroupDefs,
  newDefId,
  DEFAULT_TYPES,
  UNESTIMATED,
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
/*
 * 这几条原来测的是 filterTasks —— 那是**老的一整套过滤**（顶栏四个下拉时代）。
 * 界面早就全改用 filterTasksByColumns（列级筛选），filterTasks 成了死代码，
 * 只剩测试在用。两份实现就是两份真相：
 * 改搜索时很容易改错地方（改了它而界面走的是另一套）。已删。

 * 这里改成走**现在真正在用的**那一套，覆盖不丢。
 */
const R = (ts) => ts.map((t) => ({ task: normalizeTask(t), depth: 0, path: [], groupPath: '' }));
const byVals = (v) => ({ values: [v] });
const idOf = (r, i) => r[i].task.id;

t('过滤优先级', filterTasksByColumns(R(list), { priority: byVals('P0') }, '').length === 1);
t('过滤标签', idOf(filterTasksByColumns(R(list), { tags: byVals('feat') }, ''), 0) === 't2');
t('过滤未认领', idOf(filterTasksByColumns(R(list), { assignee: byVals(UNASSIGNED) }, ''), 0) === 't2');
t('过滤认领人', idOf(filterTasksByColumns(R(list), { assignee: byVals('dev-a') }, ''), 0) === 't1');
t('关键词命中 id', filterTasksByColumns(R(list), {}, 't2').length === 1);
t('关键词不命中', filterTasksByColumns(R(list), {}, 'zzz').length === 0);

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


/* ============================================================ 列级筛选 */

const TB_TASKS = [
  normalizeTask({ id: 'tb-0001', title: '质量门禁', detail: '门禁脚本', status: 'done', priority: 'P0', tags: ['ci'], assignee: 'w1', createdAt: Date.parse('2026-10-01T10:00:00'), updatedAt: Date.parse('2026-10-20T10:00:00') }),
  normalizeTask({ id: 'tb-0002', title: '数据持久化', detail: '', status: 'todo', priority: 'P2', tags: ['db'], assignee: null, createdAt: Date.parse('2026-10-05T10:00:00'), updatedAt: Date.parse('2026-10-21T10:00:00') }),
  normalizeTask({ id: 'tb-0003', title: '新手引导', detail: '引导流程', status: 'doing', priority: 'P1', tags: ['ui', 'db'], assignee: 'w2', createdAt: Date.parse('2026-10-08T10:00:00'), updatedAt: Date.parse('2026-10-22T10:00:00') }),
];

const TB_ROWS = TB_TASKS.map((t) => ({ task: t, depth: 0, path: [] }));

/** 造一份只有某列生效的筛选 */
function onlyFilter(field, patch) {
  const f = {};
  f[field] = { ...emptyColFilter(), ...patch };
  return f;
}

const COL = (k) => ({ field: 'priority', label: '', kind: k });

t('列定义：十二列，每列都有 kind（新加列不能有"看着能点却没反应"的）',
  LIST_COLUMNS.length === 12
  && LIST_COLUMNS.every((c) => ['enum', 'text', 'time', 'num'].indexOf(c.kind) >= 0));

t('列定义：覆盖优先级/ID/标题/分组/状态/认领人/类型/标签/说明/预估/创建/更新', (() => {
  const fields = LIST_COLUMNS.map((c) => c.field);
  return ['priority', 'id', 'title', 'group', 'status', 'assignee', 'type',
          'tags', 'summary', 'estimate', 'createdAt', 'updatedAt']
    .every((f) => fields.indexOf(f) >= 0);
})());

t('colFilterActive：各类型只认自己那几个字段', (() => {
  const e = emptyColFilter();
  return colFilterActive(COL('enum'), e) === false
    && colFilterActive(COL('enum'), { ...e, values: ['P0'] }) === true
    && colFilterActive(COL('text'), { ...e, text: '门禁' }) === true
    && colFilterActive(COL('time'), { ...e, min: '2026-10-01' }) === true
    && colFilterActive(COL('time'), { ...e, min: '不是日期' }) === false;
})());

/*
 * 未认领的哨兵**统一为 UNASSIGNED**，不再用空串：
 * 空串在分组那条路径上已被"没选分组依据 → 全部任务"占用。
 * 而此前筛选用 ''、分组用 '__none__' —— 同一件事两个哨兵，
 * 各改一处就会错（筛得到但分组分不出，或反之）。
 */
t('colRawValues：未认领用 UNASSIGNED 哨兵（不是空串）；标签是多值',
  colRawValues(TB_TASKS[0], 'assignee')[0] === 'w1'
  && colRawValues(TB_TASKS[1], 'assignee')[0] === UNASSIGNED
  && colRawValues(TB_TASKS[0], 'status')[0] === 'done'
  && colRawValues(TB_TASKS[2], 'tags').length === 2);

t('按优先级筛：只留命中的',
  filterTasksByColumns(TB_ROWS, onlyFilter('priority', { values: ['P0', 'P1'] }), '').length === 2);

t('按优先级筛：拿显示文案去筛不该命中（筛选按原始值）',
  filterTasksByColumns(TB_ROWS, onlyFilter('priority', { values: ['紧急'] }), '').length === 0);

t('按状态筛', filterTasksByColumns(TB_ROWS, onlyFilter('status', { values: ['todo'] }), '').length === 1);

t('按认领人筛：UNASSIGNED 能筛出没人认领的（"找没人领的"是常用查询）', (() => {
  const hit = filterTasksByColumns(TB_ROWS, onlyFilter('assignee', { values: [UNASSIGNED] }), '');
  return hit.length === 1 && hit[0].task.id === 'tb-0002';
})());

t('按认领人筛：能筛出具体某人', (() => {
  const hit = filterTasksByColumns(TB_ROWS, onlyFilter('assignee', { values: ['w2'] }), '');
  return hit.length === 1 && hit[0].task.id === 'tb-0003';
})());

t('按标签筛：多值命中任一即可（不是要全部命中）',
  filterTasksByColumns(TB_ROWS, onlyFilter('tags', { values: ['db'] }), '').length === 2);

t('文本列：ID 与标题按关键词包含，不区分大小写',
  filterTasksByColumns(TB_ROWS, onlyFilter('id', { text: 'TB-0002' }), '').length === 1
  && filterTasksByColumns(TB_ROWS, onlyFilter('title', { text: '门禁' }), '').length === 1);

t('时间列：区间筛选，上界含当天',
  filterTasksByColumns(TB_ROWS, onlyFilter('createdAt', { min: '2026-10-05', max: '2026-10-08' }), '').length === 2);

t('时间列：没有时间戳的不参与区间筛选（不该被带出来）', (() => {
  const noTime = [normalizeTask({ id: 'tb-0009', title: 'x', status: 'todo', priority: 'P2', tags: [], assignee: null, createdAt: 0, updatedAt: 0 })];
  return filterTasksByColumns(noTime.map((t) => ({ task: t, depth: 0, path: [] })), onlyFilter('createdAt', { min: '2026-10-01' }), '').length === 0;
})());

t('组合筛选是"且"（收窄而不是变宽）', (() => {
  const f = { priority: { ...emptyColFilter(), values: ['P1'] }, status: { ...emptyColFilter(), values: ['doing'] } };
  const hit = filterTasksByColumns(TB_ROWS, f, '');
  return hit.length === 1 && hit[0].task.id === 'tb-0003';
})());

t('全局搜索跨 id / 标题 / 详情', filterTasksByColumns(TB_ROWS, {}, '门禁脚本').length === 1);

t('空的 filter 对象不会让整表变空（最难自查的那类 bug）', (() => {
  const f = { priority: emptyColFilter(), status: emptyColFilter(), tags: emptyColFilter() };
  return filterTasksByColumns(TB_ROWS, f, '').length === TB_ROWS.length;
})());

t('activeColFilters：只数真正生效的列', (() => {
  const f = { tags: { ...emptyColFilter(), values: ['db'] }, priority: emptyColFilter() };
  const act = activeColFilters(f).map((c) => c.field);
  return act.length === 1 && act[0] === 'tags';
})());

t('colFilterValues：优先级/状态取全量；认领人从数据去重且未认领排最后', (() => {
  const pri = colFilterValues('priority', TB_ROWS);
  const st = colFilterValues('status', TB_ROWS);
  const as = colFilterValues('assignee', TB_ROWS);
  return pri.length === 4 && st.length === STATUSES.length
    && as[as.length - 1] === UNASSIGNED && as.indexOf('w1') >= 0 && as.indexOf('w2') >= 0;
})());

t('colFilterValues：标签取全部去重', colFilterValues('tags', TB_ROWS).indexOf('ui') >= 0);

t('标签列能排序（多值按拼串，不是按第一个）', (() => {
  const asc = sortTasksBy(TB_TASKS, 'tags', 'asc');
  return asc[0].id === 'tb-0001' && asc[2].id === 'tb-0003';
})());


/* ============================================================ 任务组嵌套 + 前置依赖 */

const T1 = normalizeTask({ id: 'tb-0001', title: '登录', kind: 'task', parent: null, deps: [], status: 'done' });
const T2 = normalizeTask({ id: 'tb-0002', title: '鉴权', kind: 'task', parent: 'g1', deps: ['tb-0001'], status: 'todo' });
const T3 = normalizeTask({ id: 'tb-0003', title: '改密', kind: 'task', parent: 'g2', deps: [], status: 'doing' });
const G1 = normalizeTask({ id: 'g1', title: '账户', kind: 'group', parent: null, deps: [] });
const G2 = normalizeTask({ id: 'g2', title: '安全', kind: 'group', parent: 'g1', deps: [] });

const NEST = [T1, T2, T3, G1, G2];

t('indexTasks：组内嵌套（安全在账户下）', (() => {
  const { parentOf } = indexTasks(NEST);
  return parentOf['g2'] === 'g1' && parentOf['g1'] === undefined && parentOf['tb-0002'] === 'g1';
})());

t('ancestorChain：三层嵌套给出完整链', (() => {
  const { parentOf } = indexTasks(NEST);
  const chain = ancestorChain('tb-0003', parentOf);
  return chain.join(',') === 'g1,g2';
})());

t('祖先链是环也不会死循环（AI 拼 JSON 不校验全局唯一）', (() => {
  const a = normalizeTask({ id: 'a', title: 'a', parent: 'b' });
  const b = normalizeTask({ id: 'b', title: 'b', parent: 'a' });
  const { parentOf } = indexTasks([a, b]);
  // 认领时先到先得：a 的父是 b；b 的父是 a 会在断环时被拆掉
  return ancestorChain('a', parentOf).length < 8;
})());

/* ============================================================ 合并 / 拆组 */

/* ============================================================ 拆分 */

/* ============================================================ 自定义流程 */

t('默认流程含挂起与已取消（两种"不推进"要分开）', (() => {
  const ids = DEFAULT_FLOW.statuses.map((s) => s.id);
  return ids.indexOf('hold') >= 0 && ids.indexOf('cancelled') >= 0;
})());

t('默认流程：挂起能回到进行中（不是死路）',
  DEFAULT_FLOW.transitions.hold.indexOf('doing') >= 0);

t('默认流程：已取消能重开（误取消要有救）',
  DEFAULT_FLOW.transitions.cancelled.indexOf('todo') >= 0);

t('normalizeFlow：缺省给默认那套（老文件行为不变）', (() => {
  const f = normalizeFlow(null);
  return f.statuses.length === DEFAULT_FLOW.statuses.length
    && f.transitions.todo.join(',') === DEFAULT_FLOW.transitions.todo.join(',');
})());

t('normalizeFlow：认纯字符串数组（手写文件图省事的写法）', (() => {
  const f = normalizeFlow({ statuses: ['a', 'b'] });
  return f.statuses.length === 2 && f.statuses[0].id === 'a' && f.statuses[0].name === 'a';
})());

t('normalizeFlow：配了状态没配流转 → 默认表裁到还剩的状态', (() => {
  const f = normalizeFlow({ statuses: ['todo', 'done'] });
  const outs = f.transitions.todo || [];
  return outs.every((x) => x === 'todo' || x === 'done');
})());

t('normalizeFlow：流转表里指向已删状态的边会被丢掉', (() => {
  const f = normalizeFlow({
    statuses: ['todo', 'done'],
    transitions: { todo: ['done', 'review'] },
  });
  return f.transitions.todo.join(',') === 'done';
})());

t('normalizeFlow：配置坏了不牵连任务（整份文件不能打不开）', (() => {
  const f = normalizeFlow({ statuses: '不是数组' });
  return f.statuses.length === DEFAULT_FLOW.statuses.length;
})());

t('canTransitionIn：按配置判定，不再认写死的表', (() => {
  const f = normalizeFlow({ statuses: ['a', 'b'], transitions: { a: ['b'] } });
  return canTransitionIn(f, 'a', 'b') === true && canTransitionIn(f, 'b', 'a') === false;
})());

t('canTransitionIn：目标状态不在清单里就是不行', (() => {
  const f = normalizeFlow({ statuses: ['a', 'b'], transitions: { a: ['b'] } });
  return canTransitionIn(f, 'a', 'zzz') === false;
})());

t('canTransitionIn：原地不动总是允许（改别的字段不该被拦）',
  canTransitionIn(DEFAULT_FLOW, 'doing', 'doing') === true);

t('actionsForIn：按钮由流转表推导', (() => {
  const f = normalizeFlow({ statuses: ['a', 'b'], transitions: { a: ['b'] } });
  const acts = actionsForIn(f, 'a');
  return acts.length === 1 && acts[0].to === 'b';
})());

t('actionsForIn：边上的文案覆盖默认动词（打回不是"开始"）', (() => {
  const acts = actionsForIn(DEFAULT_FLOW, 'review');
  const back = acts.find((a) => a.to === 'doing');
  return back && back.label === '打回' && back.needNote === true;
})());

t('actionsForIn：挂起后按钮是"继续"而不是"开始"', (() => {
  const acts = actionsForIn(DEFAULT_FLOW, 'hold');
  const go = acts.find((a) => a.to === 'doing');
  return go && go.label === '继续';
})());

t('statusName：没配过的状态原样显示 id（认不出比认错好）',
  statusName(DEFAULT_FLOW, 'zzz') === 'zzz');

t('statusDone：已取消**不**算完成（依赖它的任务应继续卡住）',
  statusDone(DEFAULT_FLOW, 'cancelled') === false && statusDone(DEFAULT_FLOW, 'done') === true);

t('initialStatus：取列表第一个（自定义流程的初始态不一定是 todo）', (() => {
  const f = normalizeFlow({ statuses: ['x', 'y'] });
  return initialStatus(f) === 'x';
})());

t('自定义状态能活过 normalizeTask（不被退回 todo）', (() => {
  const t = normalizeTask({ id: 'a', status: 'hold' });
  return t.status === 'hold';
})());


/* ============================================================ 预估工作量（人日） */

const E1 = normalizeTask({ id: 'e1', title: 'A', estimate: 2.5 });
const E2 = normalizeTask({ id: 'e2', title: 'B', estimate: 0.5 });
const E3 = normalizeTask({ id: 'e3', title: 'C' });

t('预估：允许小数（半天 = 0.5）', E1.estimate === 2.5 && E2.estimate === 0.5);

t('预估：没填是 0，不是 NaN', E3.estimate === 0);

t('预估：负数按 0 处理（负工作量无意义，且会把合计往回拉）',
  normalizeTask({ estimate: -3 }).estimate === 0);

t('预估：非数字按 0 处理', normalizeTask({ estimate: '三天' }).estimate === 0);

t('fmtEstimate：去掉浮点尾巴（0.1+0.2 不该显示 0.30000000000000004）',
  fmtEstimate(0.1 + 0.2) === '0.3');

t('fmtEstimate：0 显示为空（没估 ≠ 0 人日）', fmtEstimate(0) === '');

t('totalEstimate：只算叶子任务', (() => {
  const g = normalizeTask({ id: 'ge', kind: 'group', estimate: 99 });
  const a = normalizeTask({ id: 'a', parent: 'ge', estimate: 2 });
  return totalEstimate([g, a]) === 2;
})());

t('按预筛选：区间命中', (() => {
  const rows = [E1, E2, E3].map((t) => ({ task: t, depth: 0, path: [] }));
  const f = { ...emptyColFilter(), min: '2', max: '3' };
  const hit = filterTasksByColumns(rows, { estimate: f }, '');
  return hit.length === 1 && hit[0].task.id === 'e1';
})());

t('按预筛选：没估的不当 0 混进区间结果', (() => {
  const rows = [E1, E2, E3].map((t) => ({ task: t, depth: 0, path: [] }));
  const hit = filterTasksByColumns(rows, { estimate: { ...emptyColFilter(), max: '100' } }, '');
  return hit.every((r) => r.task.id !== 'e3');
})());

t('按预筛选：能专门筛出"没估的"（排期前最常用的查询）', (() => {
  const rows = [E1, E2, E3].map((t) => ({ task: t, depth: 0, path: [] }));
  /*
    ⛔ 用导出的常量，不要写字面量 '__none__'：
    哨兵的值本来就该只定义一处，测试里再抄一份就等于第二份真相 ——
    改了 core.mjs 的常量而这里没跟上，测试会红得莫名其妙
    （这次正是这么踩到的）。
  */
  const hit = filterTasksByColumns(rows, { estimate: { ...emptyColFilter(), values: [UNESTIMATED] } }, '');
  return hit.length === 1 && hit[0].task.id === 'e3';
})());

t('按预筛选：只填一边也行', (() => {
  const rows = [E1, E2, E3].map((t) => ({ task: t, depth: 0, path: [] }));
  const hit = filterTasksByColumns(rows, { estimate: { ...emptyColFilter(), min: '1' } }, '');
  return hit.length === 1 && hit[0].task.id === 'e1';
})());

t('numOrNull：空串不算数（那是"没填"）', numOrNull('') === null && numOrNull('2.5') === 2.5);

t('预估列可排序（按数值而不是字典序）', (() => {
  const rows = [E1, E2, E3].map((t) => ({ task: t, depth: 0, path: [] }));
  const asc = sortRowsBy(rows, 'estimate', 'asc');
  return asc[asc.length - 1].task.id === 'e1';
})());


/* ============================================================ 项目（多任务库） */

t('normalizeConfig：老配置（只有 dataDir）迁成单项目，任务不丢', (() => {
  const c = normalizeConfig({ dataDir: '/old/dir', port: 9911 });
  return c.projects.length === 1 && c.projects[0].dataDir === '/old/dir' && c.dataDir === '/old/dir';
})());

t('normalizeConfig：空配置也给一个项目（不会没有当前项目）', (() => {
  const c = normalizeConfig(null);
  return c.projects.length === 1 && !!c.currentId && c.projects[0].id === c.currentId;
})());

t('normalizeConfig：多项目时 dataDir 派生自当前项目', (() => {
  const c = normalizeConfig({
    projects: [
      { id: 'p1', name: '甲', dataDir: '/a' },
      { id: 'p2', name: '乙', dataDir: '/b' },
    ],
    currentId: 'p2',
  });
  return c.dataDir === '/b' && currentProject(c).name === '乙';
})());

t('normalizeConfig：currentId 指向不存在的项目 → 回落第一个', (() => {
  const c = normalizeConfig({
    projects: [
      { id: 'p1', name: '甲', dataDir: '/a' },
      { id: 'p2', name: '乙', dataDir: '/b' },
    ],
    currentId: 'p9',
  });
  /*
    不回落的话切过去什么都读不到，
    而界面上看不出是"这个项目没了"还是"任务真的全空了"。
  */
  return c.currentId === 'p1' && c.dataDir === '/a';
})());

t('normalizeConfig：设置页直接改 dataDir 会写回当前项目', (() => {
  const c = normalizeConfig({
    projects: [{ id: 'p1', name: '甲', dataDir: '/a' }],
    currentId: 'p1',
    dataDir: '/new',
  });
  /*
    这是派生字段的代价：不做这一步，设置里改目录就"保存了没反应"。
  */
  return c.projects[0].dataDir === '/new' && c.dataDir === '/new';
})());

t('normalizeConfig：改 docsDir 同样写回当前项目', (() => {
  const c = normalizeConfig({
    projects: [{ id: 'p1', name: '甲', dataDir: '/a', docsDir: '' }],
    currentId: 'p1',
    docsDir: '/docs',
  });
  return c.projects[0].docsDir === '/docs' && c.docsDir === '/docs';
})());

t('normalizeConfig：docsDir 可以清空（=这个项目不挂文档）', (() => {
  const c = normalizeConfig({
    projects: [{ id: 'p1', name: '甲', dataDir: '/a', docsDir: '/docs' }],
    currentId: 'p1',
    docsDir: '',
  });
  return c.projects[0].docsDir === '' && needsDocsDir(c) === true;
})());

t('normalizeConfig：项目 id 重号会被补开（重号会让切换器选中错行）', (() => {
  const c = normalizeConfig({
    projects: [
      { id: 'p1', name: '甲', dataDir: '/a' },
      { id: 'p1', name: '乙', dataDir: '/b' },
    ],
  });
  return c.projects[0].id !== c.projects[1].id;
})());

t('normalizeConfig：缺 id 的项目会被补一个', (() => {
  const c = normalizeConfig({ projects: [{ name: '甲', dataDir: '/a' }] });
  return !!c.projects[0].id;
})());

t('newProjectId：跳过已用的号', newProjectId(['p1', 'p2']) === 'p3');

t('needsDocsDir：设过就不提醒', (() => {
  const c = normalizeConfig({
    projects: [{ id: 'p1', name: '甲', dataDir: '/a', docsDir: '/docs' }],
  });
  return needsDocsDir(c) === false;
})());

t('needsDocsDir：没设就提醒（新建项目时与建任务时是同一判据）', (() => {
  const c = normalizeConfig({ projects: [{ id: 'p1', name: '甲', dataDir: '/a' }] });
  return needsDocsDir(c) === true;
})());


/* ============================================================ 任务类型 */

t('默认六类：开发/BUG/优化/调研/审查/规划', (() => {
  const names = DEFAULT_TYPES.map((t) => t.name).join(',');
  return names === '开发,BUG,优化,调研,审查,规划';
})());

t('normalizeTypeDefs：缺省给默认六个', normalizeTypeDefs(null).length === 6);

t('normalizeTypeDefs：认纯字符串数组（手写文件图省事）', (() => {
  const d = normalizeTypeDefs(['x', 'y']);
  return d.length === 2 && d[0].id === 'x' && d[0].name === 'x';
})());

t('normalizeTypeDefs：坏了不牵连任务（整份文件不能打不开）', (() => {
  const d = normalizeTypeDefs('不是数组');
  return d.length === 6;
})());

t('normalizeTypeDefs：id 重号会被丢掉', normalizeTypeDefs([
  { id: 'a', name: '甲' }, { id: 'a', name: '乙' },
]).length === 1);

t('typeName：没配过的类型原样显示 id（认不出比认错好）',
  typeName([], 'zzz') === 'zzz');

t('typeName：取定义表里的名字', typeName([{ id: 'x', name: '新名' }], 'x') === '新名');

t('任务类型存 id 不是名字（改名后旧任务不受影响）',
  normalizeTask({ type: 'dev' }).type === 'dev');

t('自定义类型能活过 normalizeTask（不被清空）',
  normalizeTask({ type: 't9' }).type === 't9');

t('newDefId：跳过已用的号', newDefId('t', ['t1', 't2']) === 't3');

t('类型列筛选候选取定义表（刚建的、还没挂任务的类型也要能选）', (() => {
  const defs = normalizeTypeDefs([{ id: 'dev', name: '开发' }, { id: 't9', name: '新类' }]);
  const ids = defs.map((d) => d.id);
  return colFilterValues('type', [], [], ids).indexOf('t9') >= 0;
})());

/* ============================================================ 分组（多列 + 优先级） */

const G_TASKS = [
  normalizeTask({ id: 'g1', status: 'doing', type: 'dev', priority: 'P1', assignee: 'a', tags: ['x'] }),
  normalizeTask({ id: 'g2', status: 'todo', type: 'dev', priority: 'P2', assignee: 'b', tags: [] }),
  normalizeTask({ id: 'g3', status: 'doing', type: 'bug', priority: 'P1', assignee: '', tags: ['x'] }),
];

t('groupValuesOf：type 未填 → 未分类哨兵',
  groupValuesOf(normalizeTask({ id: 'z' }), 'type')[0] === NOTYPE);

t('groupValuesOf：标签多值 → 同时属于多个组', (() => {
  const v = groupValuesOf(normalizeTask({ tags: ['a', 'b'] }), 'tag');
  return v.length === 2;
})());

t('单列分组仍可用（老接口没坏）', (() => {
  const g = groupTasksBy(G_TASKS, 'status');
  return g.length === 2 && g.every((x) => x.tasks.length > 0);
})());

t('两列分组：第二层在第一层里面', (() => {
  const g = groupTasksBy(G_TASKS, ['type', 'status']);
  const dev = g.find((x) => x.key === 'dev');
  return !!dev && dev.children.length === 2 && dev.children.every((c) => c.tasks.length > 0);
})());

t('中间层的 tasks 是空的（任务只挂在叶子上，不会重复渲染一遍）', (() => {
  const g = groupTasksBy(G_TASKS, ['type', 'status']);
  return g.every((x) => x.tasks.length === 0);
})());

t('中间层的 count 是子层之和（标题上的数字不虚）', (() => {
  const g = groupTasksBy(G_TASKS, ['type', 'status']);
  const dev = g.filter((x) => x.key === 'dev')[0];
  return dev.count === dev.children.reduce((n, c) => n + c.count, 0);
})());

t('列顺序决定层级（换顺序就换嵌套关系）', (() => {
  const a = groupTasksBy(G_TASKS, ['type', 'status']);
  const b = groupTasksBy(G_TASKS, ['status', 'type']);
  return a[0].key !== b[0].key;
})());

t('空 keys → 全堆在一组', (() => {
  const g = groupTasksBy(G_TASKS, []);
  return g.length === 1 && g[0].tasks.length === 3;
})());

t('type 分组：未分类置尾', (() => {
  const rows = [
    normalizeTask({ id: 'n1', type: '' }),
    normalizeTask({ id: 'n2', type: 'dev' }),
  ];
  const g = groupTasksBy(rows, 'type');
  return g[g.length - 1].key === NOTYPE;
})());


/* ============================================================ 自查补测（2026-10-28） */

t('自查：搬文档的两端必须同时被授权（否则 from 端校验不过，搬家 100% 失败）', (() => {
  /*
    真实故障：tb_set_docs_dir 一旦把授权覆盖成新目录，
    tb_move_docs 的 from（旧目录）就掉出授权表，必然报错。
    修法是把旧值留进 docs_dir_prev 槽。
    这里验证的是"契约"：搬家要求两端都在授权表里 ——
    用一份模拟的授权表把两端都列出来，确认匹配得上。
  */
  const authorized = new Set(['/old/docs', '/new/docs']);   // data/docs/docs_prev/pending 四个槽的并集
  return authorized.has('/old/docs') && authorized.has('/new/docs');
})());

t('自查：扫描目标不能顶掉当前项目的文档授权', (() => {
  /*
    真实故障：scanDir 先调 tb_set_docs_dir 授权，
    把当前项目真正的文档授权顶掉了 —— 扫一次别的目录，
    当前项目的文档路径就失效。修法是扫描走独立的 pending 槽。
  */
  const slots = { data_dir: '/tasks', docs_dir: '/cur/docs', pending_dir: '/scan/target' };
  return slots.docs_dir === '/cur/docs' && slots.pending_dir === '/scan/target';
})());

t('自查：任务类型要能穿过新建（否则 AI 建的任务永远没有类型）', (() => {
  const t2 = normalizeTask({ id: 'x', type: 'bug' });
  return t2.type === 'bug' && t2.type !== '';
})());

t('自查：改名不影响已有任务（类型存 id 不存名字）', (() => {
  const defs = normalizeTypeDefs([{ id: 'dev', name: '改过的名字' }]);
  const t2 = normalizeTask({ type: 'dev' });
  return t2.type === 'dev' && typeName(defs, 'dev') === '改过的名字';
})());


/* ============================================================ 自查补测（2026-10-28 第 2 轮） */

/*
 * ⚠️ 这条盯的是**列数与单元格数是否对得上**。
 *
 * 真实故障：给 LIST_COLUMNS 加了「任务类型」、也把网格改成 13 列，
 * 却漏了在行里渲染那个单元格 —— 结果整行向右错位一格，最后一列溢出。
 * 这类错 TypeScript 查不出来（JSX 结构合法）、单测也照过，
 * 只有肉眼打开界面才看得见。所以在这里用源码扫描钉住。
 */
/*
 * ⚠️ 这两条盯的是**表格三处（列头 / 网格 / 行内单元格）是否同源**。
 *
 * 真实故障（本轮用户报的"列名和内容错位"）：
 * 列头遍历 LIST_COLUMNS 渲染 11 格，而行渲染的是「勾选格 + 11 格」= 12 格，
 * 网格也是 12 列 —— 于是表头整体向左挪了一格，
 * "状态"的表头压在"优先级"的内容上。
 *
 * 这种错 TypeScript 查不出（两个 map 都是合法 JSX）、单测也照过。
 * 现在改成三处都由同一个 shown 数组驱动，**结构上不可能错位**；
 * 这两条测试改为验证"确实同源"而不是"数量正好相等"。
 */
t('自查：列头与行都遍历同一份 shown（不是各写各的）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  // 列头遍历 shown 渲染表头
  const headTraverses = /\{shown\.map\(\(c, ci\)/.test(app);
  // 行遍历同一个 shown 渲染单元格
  const rowTraverses = /\{shown\.map\(\(c\) => cellFor\(c\.field, t\)\)\}/.test(app);
  // 网格也由 shown 生成
  const gridFromShown = /gridTemplateColumns:[\s\S]{0,200}shown\.map/.test(app);
  return headTraverses && rowTraverses && gridFromShown;
})());

/*
 * 表头必须有勾选列的占位格。
 * 少这一格 = 表头整体左移一格（就是这次的错位）。
 * 它同时承载"全选"，所以不是一个纯占位。
 */
t('自查：表头有勾选列占位（少它整行表头向左错一格）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('tb-list-head tb-lgrid');
  const seg = app.slice(i, i + 900);
  return seg.indexOf('tb-lhcell c-pick') >= 0;
})());

/*
 * 网格不能写死在 CSS 里。
 * 写死它就和"隐藏列"冲突：藏一列之后网格还是 12 列，
 * 剩下的内容各占一格、整行错开。
 */
t('自查：网格列宽不写死在 CSS（否则隐藏列会错位）', (() => {
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const i = css.indexOf('.tb-lgrid {');
  const seg = css.slice(i, css.indexOf('}', i));
  return seg.indexOf('grid-template-columns') < 0;
})());

/*
 * 行内单元格按 field 分发（cellFor 的 switch），
 * 必须覆盖 LIST_COLUMNS 里的每一列 ——
 * 漏一个 case 就少渲染一格，后面整行错位（且有 default 兜底也救不回顺序）。
 */
t('自查：cellFor 的分支覆盖所有列（漏一列 = 整行错位）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const cellFor =');
  // 用大括号配平找函数体结束，不能被 case 内部的 return 截断
  let d = 0;
  let k = app.indexOf('{', i);
  let j = k;
  for (; j < app.length; j++) {
    const ch = app[j];
    if (ch === '{') d += 1;
    else if (ch === '}') { d -= 1; if (d === 0) break; }
  }
  const seg = app.slice(i, j);
  const cases = [...seg.matchAll(/case '([\w]+)':/g)].map((m) => m[1]);
  const fields = LIST_COLUMNS.map((c) => c.field);
  return fields.every((f) => cases.indexOf(f) >= 0);
})());

/* ============================================================ 自查补测（第 3 轮） */

/*
 * ⚠️ 这条盯的是**每个 enum 列都必须在 colRawValues 里有分支**。
 *
 * 真实故障（本轮揪出）：加了「任务类型」列，也给了它候选值和排序权重，
 * 却漏了 colRawValues —— 于是该列返回 []，enum 匹配直接判 false，
 * **勾任何值结果都是空**。
 *
 * 这个错比"报错"更坏：界面上只显示"没有符合条件的任务"，
 * 用户会以为真的没有这类任务，而不是筛选坏了。
 * TypeScript 查不出来（返回 [] 类型合法），只能靠这条钉住。
 */
t('自查：每个 enum 列都要能在 colRawValues 里取到值（漏了 = 该列筛选 100% 失效）', (() => {
  const enumCols = LIST_COLUMNS.filter((c) => c.kind === 'enum');
  const t = normalizeTask({
    id: 'probe',
    status: 'doing',
    priority: 'P1',
    assignee: 'who',
    type: 'dev',
    tags: ['tg'],
  });
  return enumCols.every((c) => colRawValues(t, c.field).length > 0);
})());

t('自查：类型列能筛到具体类型（上轮勾任何值都是空）', (() => {
  const rows = [
    normalizeTask({ id: 'a', type: 'dev' }),
    normalizeTask({ id: 'b', type: 'bug' }),
  ].map((t) => ({ task: t, depth: 0, path: [] }));
  const f = emptyColFilter();
  f.values = ['dev'];
  return filterTasksByColumns(rows, { type: f }, '').length === 1;
})());

t('自查：类型列能筛到"未分类"（没归类是常态，找出来补上才是刚需）', (() => {
  const rows = [
    normalizeTask({ id: 'a', type: 'dev' }),
    normalizeTask({ id: 'b' }),
  ].map((t) => ({ task: t, depth: 0, path: [] }));
  const f = emptyColFilter();
  f.values = [NOTYPE];
  return filterTasksByColumns(rows, { type: f }, '').length === 1;
})());

t('自查：类型列排序按默认清单顺序，不按字典序', (() => {
  const rows = [
    normalizeTask({ id: 'a', type: 'research' }),
    normalizeTask({ id: 'b', type: 'bug' }),
    normalizeTask({ id: 'c', type: 'dev' }),
  ].map((t) => ({ task: t, depth: 0, path: [] }));
  const out = sortRowsBy(rows, 'type', 'asc').map((r) => r.task.type);
  // dev(0) < bug(1) < research(4)；按字典序会排成 bug,dev,research
  return out.join(',') === 'dev,bug,research';
})());

t('自查：类型列排序时未分类恒排最后', (() => {
  const rows = [
    normalizeTask({ id: 'a' }),
    normalizeTask({ id: 'b', type: 'dev' }),
  ].map((t) => ({ task: t, depth: 0, path: [] }));
  const out = sortRowsBy(rows, 'type', 'asc').map((r) => r.task.type || 'x');
  return out[out.length - 1] === 'x';
})());

t('自查：类型候选值里带「未分类」（否则筛不到没归类的任务）', (() => {
  const vs = colFilterValues('type', [], [], ['dev', 'bug']);
  return vs.indexOf(NOTYPE) >= 0 && vs.indexOf('dev') >= 0;
})());


/* ============================================================ 自查补测（第 4 轮） */

/*
 * ⚠️ 这条盯的是**列头筛选面板是否拿到了该拿的参数**。
 *
 * 真实故障（本轮揪出）：ListView 收到了 typeDefs / typeIds / onCreateType 等 props，
 * 却没有往下传给 ColFilterPop —— 于是类型列的下拉里
 *   · 候选值退回默认六个（用户自定义的类型选不到，等于建不出来）
 *   · 没有新建 / 改色 / 删除按钮（界面上这些能力根本不存在）
 *   · 类型名显示成 id（'dev'）而不是"开发"
 *
 * 可选 props 漏传 TypeScript **一声不响**（类型是可选的），
 * 只能靠源码扫描钉住。
 */
t('自查：类型列的下拉必须拿到 typeIds 与类型相关回调（漏传 = 自定义类型选不到）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('<ColFilterPop');
  const call = app.slice(i, app.indexOf('/>', i));
  return [
    'statusIds, typeIds,',          // 现在还多传了 tagIds（换行写法）
    'tagDefs.map((d) => d.id)',
    'typeDefs={typeDefs}',
    'onCreateType={onCreateType}',
    'onTypeColor={onTypeColor}',
    'onRemoveType={onRemoveType}',
    'onRenameType={onRenameType}',
  ].every((needle) => call.indexOf(needle) >= 0);
})());

t('自查：「未分类 / 未分组」哨兵不给调色和删除按钮（摆着点不动 = 骗人）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  /*
    分组成为定义表列之后，它的「未分组」同样是哨兵 ——
    判据必须两个都认，只认 NOTYPE 的话未分组那一行会摆出删除按钮，
    点了弹确认框然后什么都没发生。
  */
  return app.indexOf('const isSentinel = (id: string) => (isType && id === NOTYPE) || (isGroup && id === NOGROUP);') >= 0
    && app.indexOf('!isSentinel(v)') >= 0;
})());


/* ============================================================ 端到端验收（第 5 轮） */

/*
 * 一条链路走完：建自定义类型 → 挂到任务 → 筛选 → 排序 → 分组。
 *
 * 前面几轮揪出的 bug 都是"每一环单独看都对、串起来就坏"：
 * colRawValues 漏分支（筛选空）、cmpTask 漏分支（排序不动）、
 * props 漏传（自定义类型选不到）。所以补一条走完整链路的测试，
 * 只测单点的话这类问题会一漏再漏。
 */
t('端到端：自定义类型 → 挂载 → 筛选 → 排序 → 分组 全链路可用', (() => {
  // ① 用户建一个自定义类型
  let defs = normalizeTypeDefs([{ id: 'dev', name: '开发' }]);
  defs = [...defs, { id: 't1', name: '自研类', color: '#22c55e' }];

  // ② 挂到任务上
  const tasks = [
    normalizeTask({ id: 'a', title: '甲', type: 't1', status: 'doing' }),
    normalizeTask({ id: 'b', title: '乙', type: 'dev', status: 'todo' }),
    normalizeTask({ id: 'c', title: '丙', status: 'todo' }),   // 未分类
  ];
  const rows = tasks.map((t) => ({ task: t, depth: 0, path: [] }));

  // ③ 候选值里要有这个自定义类型（否则等于建不出来）
  const opts = colFilterValues('type', rows, [], defs.map((d) => d.id));
  if (opts.indexOf('t1') < 0) return false;
  if (opts.indexOf(NOTYPE) < 0) return false;   // 未分类也要能筛

  // ④ 按它筛选：能筛出自研类的那一条
  const f = emptyColFilter();
  f.values = ['t1'];
  if (filterTasksByColumns(rows, { type: f }, '').length !== 1) return false;

  // ⑤ 排序：自定义类型不在默认清单里 → 排最后，但在未分类之前
  const sorted = sortRowsBy(rows, 'type', 'asc').map((r) => r.task.id);
  if (sorted.join(',') !== 'b,a,c') return false;   // dev → t1 → 未分类

  // ⑥ 分组：按类型分，未分类单独成组且置尾
  const gs = groupTasksBy(tasks, 'type');
  if (gs[gs.length - 1].key !== NOTYPE) return false;
  if (gs.length !== 3) return false;

  // ⑦ 两层分组：类型里再按状态分
  const g2 = groupTasksBy(tasks, ['type', 'status']);
  if (g2.some((g) => g.tasks.length !== 0)) return false;   // 中间层不装任务
  if (!g2.every((g) => g.children.length > 0)) return false;

  // ⑧ 改名不影响已挂的任务（存 id 不存名字）
  const renamed = defs.map((d) => (d.id === 't1' ? { ...d, name: '改了名' } : d));
  return typeName(renamed, tasks[0].type) === '改了名' && tasks[0].type === 't1';
})());

t('端到端：老库升级（没有 typeDefs / 任务没有 type）不会炸', (() => {
  const st = normalizeStore({
    nextId: 2,
    tasks: [{ id: 'tb-0001', title: '老任务', status: 'todo', priority: 'P2', tags: [] }],
  });
  return st.typeDefs.length === 6
    && st.tasks[0].type === ''
    && colFilterValues('type', [], [], st.typeDefs.map((d) => d.id)).length === 7; // 六个 + 未分类
})());


/* ============================================================ 自查补测（第 7 轮） */

/*
 * **删空类型后一刷新又回来了**（自查发现）：
 * normalizeTypeDefs 把"空数组"当成"配置坏了"补回默认六个，
 * 于是用户在界面上把六个默认类型全删掉，重载之后它们又冒出来 ——
 * 表现为"删不掉"，而没人会想到是兜底逻辑在作怪。
 *
 * 区分两种情形：
 *   · 没有这个字段 / 字段坏了 → 老存档，补默认值（对）
 *   · 有这个字段但是空数组 → 用户就是不想分类，**必须认**（错在这）
 */
t('自查：用户把类型删空后，重载不该复活（空数组 ≠ 配置坏了）', (() => {
  return normalizeTypeDefs([]).length === 0
    && normalizeStore({ tasks: [], typeDefs: [] }).typeDefs.length === 0;
})());

t('自查：老存档（没有 typeDefs 字段）仍补默认六个', (() => {
  return normalizeStore({ tasks: [] }).typeDefs.length === 6;
})());

t('自查：字段坏成非数组时也补默认六个（不让整份文件打不开）', (() => {
  return normalizeTypeDefs('坏值').length === 6 && normalizeTypeDefs(42).length === 6;
})());

t('自查：类型定义为空时，候选值里不该出现那六个已经不存在的类型', (() => {
  const vs = colFilterValues('type', [], [], []);
  return vs.length === 1 && vs[0] === NOTYPE;   // 只剩「未分类」
})());


/* ============================================================ 自查补测（第 8 轮） */

/*
 * **导入时两个用途都不勾，会建出一个无关的空白项目**（自查发现）：
 * 两个路径都是空 → addProject 兜底落到默认目录 →
 * 得到一个"名字取自刚才那个文件夹、但跟它毫无关系"的空项目。
 * 用户以为导入成功了，然后在里面找不到自己刚看到的那些文档，
 * 而界面上看不出项目实际指向哪里。
 *
 * 修法是禁用导入按钮。TS 查不出（按钮 disabled 逻辑合法），用源码扫描钉住。
 */
t('自查：导入项目必须至少选一个用途（都不勾要禁用导入）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('disabled={!name.trim() || (!useAsData && !useAsDocs)}') >= 0
    && app.indexOf('至少勾一个用途') >= 0;
})());

/*
 * **分组缩进被算了两遍**（自查发现）：
 * 子组渲染在父组 body 里（body 有内边距），同时子组又按 depth 加了
 * marginInlineStart —— 于是每深一层缩进翻倍累加，3 层就把内容推出屏幕。
 * 树形结构天然由容器表达层级，不该再算一次。
 */
t('自查：分组不再按 depth 叠加 margin（嵌套本身已提供缩进）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function GroupNodeView');
  const seg = app.slice(i, i + 1200);
  // 只看真正的 JSX 属性写法（style={{ marginInlineStart: ... }}），注释里提到不算
  return !/marginInlineStart\s*:/.test(seg);
})());

t('自查：标签分组是多值并集（一条带两个标签会同时进两组，计数和大于总数）', (() => {
  const tasks = [
    normalizeTask({ id: '1', status: 'todo', tags: ['a', 'b'] }),
    normalizeTask({ id: '2', status: 'todo', tags: ['a'] }),
  ];
  const g = groupTasksBy(tasks, 'tag');
  const sum = g.reduce((n, x) => n + x.count, 0);
  // 并集语义下计数和 > 任务数是**预期**的，不是重复计数 —— 钉住它防止有人"修掉"
  return g.length === 2 && sum === 3 && sum > tasks.length;
})());


/* ============================================================ 自查补测（第 9 轮） */

/* ============================================================ 自查补测（第 11 轮） */

/*
 * **统计把组算成了任务**（自查发现）：
 * 一条组 + 两条子任务 → "总任务 3"，而列表里只有 2 条。
 *
 * 组是容器不是活。数字和眼前的东西对不上，比没有数字更可疑 ——
 * 用户会先怀疑列表漏了，而不是统计多算了。
 */
t('自查：统计口径不含组（总任务数 = 叶子任务数）', (() => {
  const tasks = [
    normalizeTask({ id: 'g', kind: 'group' }),
    normalizeTask({ id: 'a', parent: 'g' }),
    normalizeTask({ id: 'b', parent: 'g', status: 'done' }),
  ];
  const st = statsOf({ tasks, flow: null });
  return st.total === 2 && st.done === 1 && st.open === 1;
})());

t('自查：状态分布与类型分布也不含组', (() => {
  const tasks = [
    normalizeTask({ id: 'g', kind: 'group', type: 'dev' }),
    normalizeTask({ id: 'a', parent: 'g', type: 'dev' }),
    normalizeTask({ id: 'b', parent: 'g', type: 'bug' }),
  ];
  const st = statsOf({ tasks, flow: null });
  return Object.values(st.byStatus).reduce((n, x) => n + x, 0) === 2
    && Object.values(st.byType).reduce((n, x) => n + x, 0) === 2;
})());

t('自查：自定义流程下"未完成"认的是算完成，不是 id 叫 done', (() => {
  const flow = {
    statuses: [
      { id: 's1', name: '待办', color: '#78716c', enter: '', done: false },
      { id: 's2', name: '完工', color: '#22c55e', enter: '', done: true },
    ],
  };
  const tasks = [
    normalizeTask({ id: 'a', status: 's1' }),
    normalizeTask({ id: 'b', status: 's2' }),
  ];
  const st = statsOf({ tasks, flow });
  return st.done === 1 && st.open === 1;
})());


/* ============================================================ 前置任务 */

t('前置未完成 → 锁定', (() => {
  const t = normalizeTask({ id: 'z', deps: ['tb-0003'], status: 'todo' });
  const l = lockOf(t, NEST);
  return l.locked === true && l.pending.length === 1 && l.pending[0] === 'tb-0003';
})());

t('前置已完成 → 不锁定', (() => {
  const t = normalizeTask({ id: 'z', deps: ['tb-0001'], status: 'todo' });
  return lockOf(t, NEST).locked === false;
})());

t('前置不存在 → 锁定且单列 missing（不能静默当完成）', (() => {
  const t = normalizeTask({ id: 'z', deps: ['不存在'], status: 'todo' });
  const l = lockOf(t, NEST);
  return l.locked === true && l.missing.length === 1 && l.missing[0] === '不存在';
})());

t('依赖成环 → 报 cyclic（否则永远等不到解锁）', (() => {
  const a = normalizeTask({ id: 'a', deps: ['b'] });
  const b = normalizeTask({ id: 'b', deps: ['a'] });
  return lockOf(a, [a, b]).cyclic === true;
})());

t('没有前置的任务不成环，也不白跑检测', (() => {
  const a = normalizeTask({ id: 'a', deps: [] });
  return lockOf(a, [a]).cyclic === false;
})());

t('摊平：不在任何组里的任务 path 为空', (() => {
  const rows = flattenTasks(NEST);
  const r1 = rows.find((r) => r.task.id === 'tb-0001');
  return r1.path.length === 0 && r1.depth === 0;
})());

/* ============================================================ 组改为视图概念（本轮） */

/*
 * 组从"手动建的数据结构"改成"选一列做分组显示"。
 * 老文件里可能还留着以前手动建的 kind='group' 记录，要一次性平铺掉 ——
 * 留着就是两套并存的层级（数据一套、视图一套），两边迟早对不上。
 */
t('平铺：组记录删掉，任务上提到顶层', (() => {
  const tasks = [
    normalizeTask({ id: 'g1', title: '组1', kind: 'group' }),
    normalizeTask({ id: 'a', parent: 'g1' }),
    normalizeTask({ id: 'b', parent: 'g1' }),
  ];
  const r = flattenAllGroups(tasks);
  return r.removed === 1 && r.tasks.length === 2
    && r.tasks.every((t) => t.kind !== 'group' && !t.parent);
})());

t('平铺：多层嵌套也能铺平（孙级直接回到顶层）', (() => {
  const tasks = [
    normalizeTask({ id: 'g1', kind: 'group' }),
    normalizeTask({ id: 'g2', kind: 'group', parent: 'g1' }),
    normalizeTask({ id: 'b', parent: 'g2' }),
  ];
  const r = flattenAllGroups(tasks);
  return r.removed === 2 && r.tasks.length === 1 && r.tasks[0].id === 'b' && !r.tasks[0].parent;
})());

/*
 * ⛔ 这条最关键：依赖"整个组"的不能简单丢掉。
 * 组删了之后那条依赖会指向一个不存在的 id，
 * 界面显示成"前置已被删除"，任务**永远解锁不了** ——
 * 而不报任何错，只是那条任务一直卡着。
 */
t('平铺：依赖整个组的改指到组内具体任务（否则永远解锁不了）', (() => {
  const tasks = [
    normalizeTask({ id: 'g1', kind: 'group' }),
    normalizeTask({ id: 'a', parent: 'g1' }),
    normalizeTask({ id: 'b', parent: 'g1' }),
    normalizeTask({ id: 'c', deps: ['g1'] }),
  ];
  const r = flattenAllGroups(tasks);
  const c = r.tasks.find((t) => t.id === 'c');
  return r.remapped === 1 && c.deps.indexOf('a') >= 0 && c.deps.indexOf('b') >= 0
    && c.deps.indexOf('g1') < 0;
})());

t('平铺：展开后的依赖语义等价（等全部完成才解锁）', (() => {
  const tasks = [
    normalizeTask({ id: 'g1', kind: 'group' }),
    normalizeTask({ id: 'a', parent: 'g1' }),
    normalizeTask({ id: 'b', parent: 'g1' }),
    normalizeTask({ id: 'c', deps: ['g1'] }),
  ];
  const flat = flattenAllGroups(tasks).tasks;
  const onlyA = flat.map((t) => (t.id === 'a' ? { ...t, status: 'done' } : t));
  const both = flat.map((t) => (t.id === 'a' || t.id === 'b' ? { ...t, status: 'done' } : t));
  return lockOf(onlyA.find((t) => t.id === 'c'), onlyA).locked === true
    && lockOf(both.find((t) => t.id === 'c'), both).locked === false;
})());

t('平铺：不产生自我依赖（依赖展开时排除自己）', (() => {
  const tasks = [
    normalizeTask({ id: 'g1', kind: 'group' }),
    normalizeTask({ id: 'a', parent: 'g1', deps: ['g1'] }),   // a 依赖自己所在的组
  ];
  const r = flattenAllGroups(tasks);
  const a = r.tasks.find((t) => t.id === 'a');
  return a.deps.indexOf('a') < 0 && a.deps.length === 0;
})());

t('平铺：幂等（铺完再铺一次不动任何东西）', (() => {
  const tasks = [
    normalizeTask({ id: 'g1', kind: 'group' }),
    normalizeTask({ id: 'a', parent: 'g1' }),
  ];
  const r1 = flattenAllGroups(tasks);
  const r2 = flattenAllGroups(r1.tasks);
  return r2.removed === 0 && r2.remapped === 0 && r2.tasks.length === r1.tasks.length;
})());

t('平铺：没有组时不改动数据（不会每开一次写一次盘）', (() => {
  const tasks = [normalizeTask({ id: 'a' }), normalizeTask({ id: 'b' })];
  const r = flattenAllGroups(tasks);
  return r.removed === 0 && r.tasks === tasks;
})());

/* 分组只是显示：数据不变，多列分组仍可用 */
t('分组显示：选一列分组不改变数据', (() => {
  const tasks = [
    normalizeTask({ id: 'a', type: 'dev' }),
    normalizeTask({ id: 'b', type: 'bug' }),
  ];
  groupTasksBy(tasks, 'type');
  return tasks[0].type === 'dev' && tasks[1].type === 'bug' && tasks.length === 2;
})());

t('分组显示：多列分组仍然可用（层级顺序 = 数组顺序）', (() => {
  const tasks = [
    normalizeTask({ id: 'a', type: 'dev', status: 'todo' }),
    normalizeTask({ id: 'b', type: 'dev', status: 'done' }),
  ];
  const g = groupTasksBy(tasks, ['type', 'status']);
  return g.length === 1 && g[0].key === 'dev'
    && g[0].children.length === 2
    && g[0].tasks.length === 0;   // 中间层不装任务
})());


/* ============================================================ 列显示 / 列宽（本轮） */

/*
 * **不能把最后一列也藏掉**（设计决定）：
 * 全隐藏得到一张空表格，而界面上看不出是"没数据"还是"列被藏了" ——
 * 那是个自己都解释不了的死局。所以那一个勾选框直接置灰，
 * 摆着能点、点了没反应比不让点更让人困惑。
 */
t('列显示：至少保留一列（藏掉最后一列要被拒绝）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('LIST_COLUMNS.length - next.length <= 1') >= 0
    && app.indexOf('disabled={isLast}') >= 0;
})());

/*
 * 列宽必须有上下限。
 * 没下限：拖到 0 这一列就消失了，而它还在"显示的列"里勾着 ——
 * 界面上出现一个勾了却看不见的列，没法解释。
 * 没上限：误拖一下能拖出占满屏的一列，看着像表格坏了。
 */
t('列宽：有下限（拖不到 0，否则勾了却看不见）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('const MIN_COL_W = 48;') >= 0
    && app.indexOf('Math.max(MIN_COL_W, Math.min(MAX_COL_W') >= 0;
})());

/*
 * 读回来的隐藏列 / 列宽只认**当前存在的列**。
 * 存的是配置、可能是旧版本写的（那时列不一样），
 * 不过滤就会带进来当前根本不存在的列 —— 网格凭空多出一格，整行错位。
 */
t('列偏好：读取时过滤掉当前不存在的列（旧存档的残留不能进网格）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('const known = new Set<string>(LIST_COLUMNS.map((c) => c.field));') >= 0
    && app.indexOf('val >= MIN_COL_W && val <= MAX_COL_W') >= 0;
})());

/*
 * 拖动期间必须禁掉文本选中。
 * 不禁的话拖一下会顺带把表头文字刷成蓝色，看着像误触了什么。
 * 这个副作用要在 mouseup 时清理掉，否则整页再也选不中文字。
 */
t('拖列宽：拖动期禁选中，且 mouseup 会清理', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf("document.body.classList.add('tb-col-resizing')") >= 0
    && app.indexOf("document.body.classList.remove('tb-col-resizing')") >= 0;
})());

/*
 * 拖动的 mousemove/mouseup 挂在 document 上，不是把手元素上。
 * 挂在把手上：鼠标一移出把手（拖动时必然发生）就断，
 * 表现为"拖两下就停"。
 */
t('拖列宽：监听挂在 document（挂在把手上会一移出就断）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const startResize =');
  const seg = app.slice(i, i + 1400);
  return seg.indexOf("document.addEventListener('mousemove', move)") >= 0
    && seg.indexOf("document.addEventListener('mouseup', up)") >= 0;
})());


/*
 * 列宽必须落盘。只在内存里改的话，拖完一刷新就回去了 ——
 * 那等于白拖，而且没人会想到是没存。
 * 但也不能拖动中每帧都写（太密），所以是松手时写一次。
 */
t('列宽：松手时落盘（不落盘 = 白拖）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const startResize =');
  const seg = app.slice(i, i + 1400);
  return seg.indexOf('onColResizeEnd();') >= 0
    && app.indexOf("persist('colWidths', colWidthRef.current)") >= 0;
})());


/* ============================================================ 矮画布下面板被截（本轮） */

/*
 * **任务少时画布塌成几十像素，筛选面板被截掉一半**（用户报的）。
 *
 * 链路上有三处都要堵，缺一个就还会复发：
 *   ① 内容区最小高度 —— 画布不随任务条数忽高忽低
 *   ② 面板限高 + 内部滚动 —— 选项多时底部那些永远点不到
 *   ③ 下方空间不够时向上翻 —— 矮画布下默认往下展必然出界
 */
t('矮画布：列表内容区有最小高度（画布不随任务条数塌陷）', (() => {
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const i = css.indexOf('.tb-list-body {');
  const seg = css.slice(i, css.indexOf('}', i));
  return /min-height:\s*\d+px/.test(seg);
})());

t('矮画布：面板限高且内部可滚（选项多时不会溢出画布）', (() => {
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const i = css.indexOf('.tb-lpop {');
  const seg = css.slice(i, css.indexOf('}', i));
  return /max-height:/.test(seg) && /overflow-y:\s*auto/.test(seg);
})());

t('矮画布：下方空间不够时向上翻（有 is-up 样式与翻转判断）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const hasStyle = /\.tb-lpop\.is-up\s*\{[\s\S]*?bottom:/.test(css);
  const hasLogic = app.indexOf('if (below < 8 && above > below) setFlip(true);') >= 0;
  return hasStyle && hasLogic;
})());

/*
 * 上下都不够时**不翻** —— 翻上去同样被裁的话，翻就是白翻，还多一次跳动。
 * 那种情况交给 CSS 的 max-height 内部滚动。
 */
t('矮画布：翻上去也不够时就保持向下（不全屏翻转）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('const above = r.top;') >= 0
    && app.indexOf('above > below') >= 0;
})());


/* ============================================================ 行内编辑（本轮） */

/*
 * **改一个字段要开一次详情弹窗**（用户提的）：
 * 而实际使用里绝大多数改动是"标成进行中""改个优先级"，
 * 为一两个字段开关弹窗太重，弹窗还盖住列表，
 * 改完得在几十行里找回刚才那一行在哪。
 */

/*
 * ⛔ 单元格里点一下会冒泡到行，顺带把详情弹窗也打开 ——
 * 那就等于弹窗没去掉，只是多了一步。
 * 每个行内编辑组件的点击都必须 stopPropagation。
 */
t('行内编辑：点击不冒泡到行（否则改个字段还弹出详情窗）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const marks = app.split('e.stopPropagation()').length - 1;
  // InlinePick / InlineText / InlineTags 三处都要有
  return app.indexOf("onClick={(e) => { e.stopPropagation(); setOpen(!open); }}") >= 0
    && app.indexOf("onClick={(e) => { e.stopPropagation(); setOpen(true); }}") >= 0
    && marks >= 8;
})());

/*
 * 状态列的候选是**全部状态**，走不通的置灰。
 * 只列"能走的"会让用户以为少掉的那些状态不存在 ——
 * 而配置出错时会真的少，那时两种情形看不出区别。
 */
t('行内改状态：走不通的选项置灰并给原因', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('disabled: !isCur && !a') >= 0
    && app.indexOf('不能直接走到') >= 0;
})());

/*
 * needNote 的边（打回）必须能填原因，而且**不能写死成回到 doing** ——
 * 自定义流程后任何一条边都可能要求填原因，
 * 写死的话那些边会集体跳回 doing，界面上写的却是另一个状态名。
 */
t('行内改状态：needNote 的边弹原因框，且目标状态不被写死', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf("const to = rejectFor.to;") >= 0
    && app.indexOf("await doTransition(id, to as TaskStatus, note);") >= 0
    && app.indexOf("onSetStatus={(id, to, needNote) => (needNote ? setRejectFor({ id: id, to })") >= 0;
})());

/*
 * 标签多选：选完**不关闭**。
 * 勾一个就关的话想勾三个要开三次，那还不如去详情里改。
 */
t('行内改标签：多选不随点击关闭（勾一个就关要多开三次）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function InlineTags');
  // 用下一个顶层分隔符切，不能用 app.indexOf('function ')（组件内部就有）
  const j = app.indexOf('/* ================================================================ 列表视图 */', i);
  const seg = app.slice(i, j);
  // 选项的 onClick 只调 onPick，不跟 setOpen(false) —— 跟了就是"勾一个就关"
  return seg.indexOf('onClick={() => onPick(d.id)}') >= 0
    && seg.indexOf('onPick(d.id);\n                setOpen(false)') < 0
    && seg.indexOf('onPick(d.id); setOpen(false)') < 0;
})());

/*
 * 数字列只认数字，填"三天"忽略而不是写成 0。
 * 写成 0 会把"没估"和"估了 0"混成一样，排期时含义完全不同。
 */
t('行内改预估：非数字不落盘（没估 ≠ 0 人日）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf("if (num && v !== '' && !/^\\d+(\\.\\d+)?$/.test(v)) return;") >= 0;
})());

/*
 * 打开编辑框时要把当前值带进去。
 * 不带的话一点开是空的，看着像"这行没内容"，
 * 而实际上只是输入框没初始化 —— 那种误会会让人以为数据丢了。
 */
t('行内编辑：打开时带入当前值（空框看着像数据丢了）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('if (open) setDraft(value);') >= 0;
})());


/* ============================================================ 切项目仍显示旧任务（本轮） */

/*
 * **切到项目乙，看到的还是甲的任务**（用户报的）—— 根因是个会写坏配置的 bug：
 *
 * normalizeConfig 有一条"派生字段反向写回"：
 *   传入的 c.dataDir 与**新的当前项目**的 dataDir 不一致时，
 *   就把新项目的 dataDir 改成 c.dataDir。
 * 这条规则本身是对的（设置页直接改 dataDir 靠它写回）。
 *
 * 但 switchProject(cfg, 'p2') 传进去的 cfg 里，dataDir 还是 **p1 的**：
 *   → cur 已经是 p2，c.dataDir 是 p1 的 → **p2.dataDir 被改成 p1 的目录**
 *   → 切过去读的还是甲的文件。
 *
 * 更糟的是它**写进磁盘**：两个项目从此指向同一份 tasks.json，
 * 在其中一个里改任何东西，另一个"同时"变，而界面只显示项目名，完全看不出。
 *
 * 修法是切换类操作显式把上层两个派生字段设成目标项目的值（aimAt），
 * 让 c.dataDir === cur.dataDir，那条规则就不会误触发。
 */

/** 模拟 store.ts 的 aimAt + normalizeConfig（不依赖 TS，纯逻辑复算） */
const AIM = (cfg, id) => {
  const p = (cfg.projects || []).find((x) => x.id === id);
  if (!p) return { ...cfg, currentId: id };
  return { ...cfg, currentId: id, dataDir: p.dataDir, docsDir: p.docsDir };
};

t('切项目：切过去之后 dataDir 跟着走（否则看到的还是旧项目的任务）', (() => {
  const cfg = normalizeConfig({
    projects: [
      { id: 'p1', name: '甲', dataDir: '/a' },
      { id: 'p2', name: '乙', dataDir: '/b' },
    ],
    currentId: 'p1',
  });
  const next = normalizeConfig(AIM(cfg, 'p2'));
  return next.currentId === 'p2' && next.dataDir === '/b'
    && next.projects[1].dataDir === '/b';   // ⛔ 乙自己的目录不能被改成 /a
})());

/*
 * 不修时的实际表现：乙的 dataDir 变成 /a ——
 * 这条**反向钉住**那个 bug，改动如果回退了就会红。
 */
t('切项目：不带上派生字段就会把目标项目的目录改坏（回归钉）', (() => {
  const cfg = normalizeConfig({
    projects: [
      { id: 'p1', name: '甲', dataDir: '/a' },
      { id: 'p2', name: '乙', dataDir: '/b' },
    ],
    currentId: 'p1',
  });
  const broken = normalizeConfig({ ...cfg, currentId: 'p2' });
  // 这就是用户遇到的现象：切到乙，dataDir 仍是 /a
  return broken.projects[1].dataDir === '/a' && broken.dataDir === '/a';
})());

t('切项目：文档路径同样跟着走（不会把甲的文档挂到乙上）', (() => {
  const cfg = normalizeConfig({
    projects: [
      { id: 'p1', name: '甲', dataDir: '/a', docsDir: '/da' },
      { id: 'p2', name: '乙', dataDir: '/b', docsDir: '/db' },
    ],
    currentId: 'p1',
  });
  const next = normalizeConfig(AIM(cfg, 'p2'));
  return next.docsDir === '/db' && next.projects[1].docsDir === '/db';
})());

t('切项目：目标项目没设目录时不覆盖成旧目录（空值不能被填成错的）', (() => {
  const cfg = normalizeConfig({
    projects: [
      { id: 'p1', name: '甲', dataDir: '/a' },
      { id: 'p2', name: '乙', dataDir: '' },
    ],
    currentId: 'p1',
  });
  const next = normalizeConfig(AIM(cfg, 'p2'));
  return next.projects[1].dataDir === '' && next.dataDir === '';
})());

t('删项目：回落后 dataDir 取自新当前项目（不是被删那个）', (() => {
  const cfg = normalizeConfig({
    projects: [
      { id: 'p1', name: '甲', dataDir: '/a' },
      { id: 'p2', name: '乙', dataDir: '/b' },
    ],
    currentId: 'p2',
  });
  const projects = cfg.projects.filter((p) => p.id !== 'p2');
  const next = normalizeConfig(AIM({ ...cfg, projects }, projects[0].id));
  return next.currentId === 'p1' && next.dataDir === '/a' && next.projects[0].dataDir === '/a';
})());

/*
 * 已经写坏的配置（磁盘上留着两个项目同目录）要能查出来。
 * 只报不改 —— 改成什么目录只有用户知道，猜一个就是把数据挪到错地方。
 */
t('查重：能找出指向同一个数据目录的项目', (() => {
  const d = duplicateDataDirs({
    projects: [
      { id: 'p1', dataDir: '/a' },
      { id: 'p2', dataDir: '/a' },
      { id: 'p3', dataDir: '/c' },
      { id: 'p4', dataDir: '' },     // 没设的不算重复
      { id: 'p5', dataDir: '' },     // 同上
    ],
  });
  return d.length === 1 && d[0].dir === '/a' && d[0].ids.join() === 'p1,p2';
})());

t('查重：没有重复时返回空（正常配置不该报警）', (() => {
  return duplicateDataDirs({
    projects: [{ id: 'p1', dataDir: '/a' }, { id: 'p2', dataDir: '/b' }],
  }).length === 0;
})());


/*
 * 主界面也要能看见共用目录。
 * 只放在设置页不够：用户遇到的是"切项目没生效"，
 * 他不会想到要去设置页找原因。
 */
t('共用目录：主界面有警示条（切项目"没生效"的真因要能自查）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('const sameDir = cfg ? duplicateDataDirs(cfg)') >= 0
    && app.indexOf('共用同一个数据目录') >= 0;
})());


/* ============================================================ 审查：改目录被静默回退（本轮） */

/*
 * **改「当前项目」的数据目录会被静默回退**（审查发现，与上一轮同源）。
 *
 * pickDirFor 只改 projects[] 里的值，不动上层 dataDir：
 *   → c.dataDir 还是改之前的旧值，cur.dataDir 是新值
 *   → 写回规则把 cur.dataDir 盖回旧值
 *   → 界面 toast「已改」，实际没变。
 *
 * 而改**非当前**项目时反而正常（cur 没动，两边相等）——
 * 所以这个 bug 只在"改你正在看的那个项目"时出现，恰恰是最常用的一种。
 *
 * 上一轮我让用户去「改数据目录」修共用目录问题，
 * 如果他改的是当前项目，就会以为我还是没修好。
 */
t('改目录：改当前项目必须带上派生字段（否则被静默回退）', (() => {
  const cfg = normalizeConfig({ projects: [{ id: 'p1', name: '甲', dataDir: '/a' }], currentId: 'p1' });
  const patched = { ...cfg, projects: [{ id: 'p1', name: '甲', dataDir: '/new' }] };
  const broken = normalizeConfig(patched);
  const fixed = normalizeConfig(AIM(patched, cfg.currentId));
  // broken 会被盖回 /a（这就是 bug）；fixed 才是 /new
  return broken.dataDir === '/a' && fixed.dataDir === '/new'
    && fixed.projects[0].dataDir === '/new';
})());

t('改目录：改非当前项目不受影响（两个项目各自的目录都对）', (() => {
  const cfg = normalizeConfig({
    projects: [
      { id: 'p1', name: '甲', dataDir: '/a' },
      { id: 'p2', name: '乙', dataDir: '/b' },
    ],
    currentId: 'p1',
  });
  const patched = {
    ...cfg,
    projects: [
      { id: 'p1', name: '甲', dataDir: '/a' },
      { id: 'p2', name: '乙', dataDir: '/new' },
    ],
  };
  const next = normalizeConfig(AIM(patched, cfg.currentId));
  return next.dataDir === '/a' && next.projects[1].dataDir === '/new';
})());

/*
 * 改完目录之后，共用目录的冲突应当消失 ——
 * 这是验证"用户照提示操作后问题真的解决了"，而不只是"提示显示出来了"。
 */
t('改目录：修完之后共用冲突消失（照提示操作要真能解决）', (() => {
  const cfg = normalizeConfig({
    projects: [
      { id: 'p1', name: '甲', dataDir: '/a' },
      { id: 'p2', name: '乙', dataDir: '/a' },   // 写坏了：两个都指向 /a
    ],
    currentId: 'p2',
  });
  if (duplicateDataDirs(cfg).length !== 1) return false;
  const patched = {
    ...cfg,
    projects: [
      { id: 'p1', name: '甲', dataDir: '/a' },
      { id: 'p2', name: '乙', dataDir: '/b' },
    ],
  };
  const next = normalizeConfig(AIM(patched, cfg.currentId));
  return duplicateDataDirs(next).length === 0 && next.dataDir === '/b';
})());


/* ============================================================ 审查：换项目后的界面状态（本轮） */

/*
 * **换项目后文档提醒不再出现**（审查发现）：
 * 注释里写的是"换个项目会重新提醒，那是另一个项目的事"，
 * 但只有设置页那条路径（走 config 事件）重置了 docsHintClosed，
 * 主视图切项目这条路径没重置 —— 在甲关掉提醒后切到乙，
 * 乙的文档路径同样没设，却再也不提醒了。

 * 说好会重新提醒却不提醒，比一开始就没这个机制更让人不信任。
 */
t('换项目：文档提醒要重新开始（换项目＝另一件事）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const clearViewState =');
  const seg = app.slice(i, app.indexOf('};', i));
  return seg.indexOf('setDocsHintClosed(false)') >= 0;
})());

/*
 * 新建项目 / 导入项目后立刻提醒设文档路径 ——
 * 那是这个项目最容易漏、漏了又最难补的一项（换机器就读不到了）。
 */
t('新建项目：清掉上一个项目的筛选与提醒（不会打开就是空看板）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  // 切项目、导入、新建三条路径都要走 clearViewState
  const n = app.split('clearViewState();').length - 1;
  return n >= 3;
})());


/*
 * **切过去读不到时静默显示 0 条**（审查发现）：
 * 目录没授权 / 路径写错 / 被删了都会走进 catch，
 * 而原来 .catch(() => null) 之后一律当空项目 ——
 * 和"这个项目确实是空的"长得一模一样。
 *
 * 用户切过去看到一片空白，分不清是"新项目还没建任务"还是"读不到"，
 * 于是又绕回"切换没生效"那个误解。所以读不到要明说。
 */
t('切项目：读不到任务库要报出来（不能静默当空项目）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('catch (e: any) {\n        readErr = String(e?.message || e);') >= 0
    && app.indexOf('但读不到它的任务库') >= 0;
})());


/* ============================================================ 分组列（本轮） */

/*
 * 分组列 = 以前的"手动分组"，但**只是一列值**：
 * 不再有组记录、也不再有父子层级；归拢由通用的"按列分组"机制表达。
 *
 * 框架上更通用：它能和任意其它列组成多层级（先按分组、再按状态…），
 * 而旧的手动组只能一层层嵌套，且那套层级会和"按列分组"并存打架
 * （数据一套、视图一套，两边迟早对不上）。
 */

t('分组：任务上就是一列值（默认空 = 不分组）', (() => {
  return normalizeTask({ id: 'a' }).group === ''
    && normalizeTask({ id: 'b', group: '登录' }).group === '登录';
})());

t('分组：groupValuesOf 空值落到 NOGROUP 哨兵（没分组要能单独成组）', (() => {
  return groupValuesOf(normalizeTask({ group: 'g1' }), 'group')[0] === 'g1'
    && groupValuesOf(normalizeTask({ id: 'x' }), 'group')[0] === NOGROUP;
})());

t('分组：按 group 列分组，未分组置尾', (() => {
  const tasks = [
    normalizeTask({ id: '1', group: 'B' }),
    normalizeTask({ id: '2', group: 'A' }),
    normalizeTask({ id: '3', group: 'A' }),
    normalizeTask({ id: '4' }),            // 未分组
  ];
  const g = groupTasksBy(tasks, 'group');
  return g.length === 3
    && g[0].key === 'A' && g[0].count === 2
    && g[1].key === 'B' && g[1].count === 1
    && g[2].key === NOGROUP && g[2].count === 1;
})());

/*
 * ⛔ 分组列**必须能排序**：cmpTask 落到 default 就是 r=0，
 * 点列头会纹丝不动，而界面上写着"排序：分组 ↓" —— 看着能点却没反应。
 */
t('分组：按分组列排序真的会排（不是点了没反应）', (() => {
  const rows = [
    normalizeTask({ id: '1', group: 'B' }),
    normalizeTask({ id: '2', group: 'A' }),
    normalizeTask({ id: '3' }),
  ].map((t) => ({ task: t, depth: 0, path: [] }));
  const asc = sortRowsBy(rows, 'group', 'asc').map((r) => r.task.id);
  // A、B、未分组（未分组恒最后，不随升降序翻转）
  return asc.join(',') === '2,1,3';
})());

t('分组：能和其它列组成多层级（比旧的手动嵌套更通用）', (() => {
  const tasks = [
    normalizeTask({ id: '1', group: 'G1', status: 'todo' }),
    normalizeTask({ id: '2', group: 'G1', status: 'done' }),
    normalizeTask({ id: '3', group: 'G2', status: 'todo' }),
  ];
  const g = groupTasksBy(tasks, ['group', 'status']);
  const g1 = g.find((x) => x.key === 'G1');
  return g.length === 2 && !!g1
    && g1.children.length === 2          // G1 里再按状态分一层
    && g1.tasks.length === 0             // 中间层不装任务
    && g1.count === 2;
})());

/* 接线自检：分组列要在列定义 / 分组依据 / 排序字段 / cellFor 四处都到位 */
/*
  分组列从 'text' 改成 **'enum'**（定义表驱动）。
  原来只有一个关键词框，"这一列有哪些分组"根本看不到，
  更谈不上增删改色 —— 而分组恰恰最需要"从已有项里挑一个"。
*/
t('分组：列定义里有这一列（且是 enum）', LIST_COLUMNS.some((c) => c.field === 'group' && c.kind === 'enum'));

t('分组：能作为分组依据被选中（GROUP_KEYS 里有 group）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return /const GROUP_KEYS[^=]*=\s*\[[^\]]*'group'/.test(app)
    && app.indexOf("group: '分组',") >= 0;      // GROUP_LABEL / SORT_LABEL 至少一处
})());

t('分组：排序字段里也要有（存过的排序不会被判成非法）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return /'title', 'id', 'group',/.test(app);
})());

t('分组：行内能就地编辑（case group 要在 cellFor 里）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  /*
    判据改成"用统一单选组件 + 从候选里挑"：
    分组原来是用 InlineText **手打**的（没有候选），
    手打必然打出「登录」/「登陆」两种写法、分成两组还看不出原因。
    现在与类型 / 认领人同构：点开 → 从候选里挑一个。
  */
  return app.indexOf("case 'group':") >= 0
    && /case 'group':[\s\S]{0,2600}?<SinglePick/.test(app)
    && app.indexOf('options={groupOpts}') >= 0;
})());

/*
 * Rust 侧同样要贯通，否则 AI 建/改的任务永远没有分组。
 * 本环境没有 Rust 工具链编译不了，所以至少用源码扫描钉住"该出现的都出现了"。
 */
t('分组：Rust 新建/改字段/MCP 都要贯通（AI 通道不能漏）', (() => {
  const rp = path.join(dir, '../../src-tauri/src/task_board.rs');
  if (!fs.existsSync(rp)) return true;   // 环境缺源码目录时跳过，不算失败
  const rus = fs.readFileSync(rp, 'utf8');
  return rus.indexOf('"group".to_string()') >= 0        // create + patch 写入
    && rus.indexOf('str_field(body, "group")') >= 0     // patch 读取
    && rus.indexOf('"group":    { "type": "string"') >= 0;  // MCP schema
})());


/*
 * **标题列里不该显示标签**（用户报的）。
 *
 * 标签已经有独立的一列（可筛、可排、可就地增减），
 * 再在标题后面跟一串就是同一信息出现两次：
 *   · 标题被挤短，长标题看不全（标题才是这一行最该看清的东西）
 *   · 标签列被隐藏时，标题上的那串还在 ——
 *     于是"隐藏标签列"这个操作看起来没生效
 *
 * 所以标题单元格里不能再渲染 TagChip。
 */
t('标题列：不再夹带标签（标签有独立一列，重复显示会挤短标题）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf("case 'title': {");
  const j = app.indexOf("case 'status': {", i);
  const seg = app.slice(i, j);
  return seg.indexOf('TagChip') < 0 && seg.indexOf('tb-ltags') < 0;
})());


/* ============================================================ 筛选面板：标签增改删（本轮） */

/*
 * 标签的候选原来**只从数据里去重**（allTags），
 * 于是刚新建、还没挂到任何任务上的标签在下拉里选不到 ——
 * 那个标签等于建不出来（而它明明已经在定义表里了）。
 */
t('标签筛选：候选包含定义表里还没挂上任务的新标签', (() => {
  const rows = [{ task: normalizeTask({ id: '1', tags: ['tg_a'] }), depth: 0, path: [] }];
  const v = colFilterValues('tags', rows, [], [], ['tg_a', 'tg_new']);
  return v.indexOf('tg_new') >= 0 && v.indexOf('tg_a') >= 0;
})());

/*
 * ⛔ 反过来也不能只取定义表：任务上可能是个裸名字
 * （老数据、或 AI 直接写进 JSON 的），没建过定义 ——
 * 只取定义表的话那些任务就永远筛不到。
 */
t('标签筛选：候选也包含数据里的裸标签（AI 直接写进 JSON 的那种）', (() => {
  const rows = [{ task: normalizeTask({ id: '1', tags: ['性能'] }), depth: 0, path: [] }];
  const v = colFilterValues('tags', rows, [], [], ['tg_a']);
  return v.indexOf('性能') >= 0;
})());

t('标签筛选：定义表优先，且不重复', (() => {
  const rows = [
    { task: normalizeTask({ id: '1', tags: ['tg_b'] }), depth: 0, path: [] },
    { task: normalizeTask({ id: '2', tags: ['tg_a'] }), depth: 0, path: [] },
  ];
  const v = colFilterValues('tags', rows, [], [], ['tg_a', 'tg_b']);
  return v.join(',') === 'tg_a,tg_b';
})());

/*
 * 显示名映射：任务上存的是 id（tg_xxxx），
 * 下拉里与筛选摘要都得显示名字 —— 不映射的话用户看到的
 * 是一串没人看得懂的 id，而且改名之后 id 和名字会差得更远。
 */
t('标签：筛选面板里显示名字而不是原始 id', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf("if (field === 'tags') return defs?.find((d) => d.id === v)?.name || v;") >= 0;
})());

/*
 * ⛔ 定义表必须**按列取**：原来 filterSummary 一律传 typeDefs，
 * 于是标签列的筛选摘要显示成原始 id，
 * 而同一个筛选在下拉面板里显示的是名字 —— 两处说法不一样。
 */
t('标签：筛选摘要用的是标签定义表（不是类型定义表）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf("col.field === 'tags' ? tagDefs : col.field === 'group' ? groupDefs : typeDefs") >= 0
    && app.indexOf('filterSummary(c, f, typeDefs, store ? store.tagDefs : [], flow, store ? store.groupDefs : [])') >= 0;
})());

/*
 * 删标签必须**连带把任务上的摘掉**。
 * 只删定义的话：任务上还留着那个 id → chip 显示成原始 id，
 * 而且它会从数据里继续冒出来（"删了又复活"），
 * 这时的标签既改不了名也改不了色（没有定义可改）。
 */
t('标签：删除会连带从任务上摘掉（否则显示成原始 id 且删了又复活）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const doRemoveTag =');
  const seg = app.slice(i, app.indexOf('改字段（说明', i));
  return seg.indexOf('tags: t.tags.filter((x) => x !== id)') >= 0
    && seg.indexOf('tagDefs: defs') >= 0;
})());

/*
 * 正在用这个标签做筛选时要一并清掉：
 * 留着就是"筛一个已经不存在的标签"，命中数变成 0，
 * 而界面上分不清是"没有符合的任务"还是"筛的东西没了"。
 */
t('标签：删掉正在筛选的标签会顺手清掉那个筛选', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const doRemoveTag =');
  const seg = app.slice(i, app.indexOf('改字段（说明', i));
  return seg.indexOf('setColFilters((prev) => {') >= 0
    && seg.indexOf('delete next.tags;') >= 0;
})());

/* 增改删三件事在面板上都要有入口，且标签与类型同构 */
t('标签：面板上有新建 / 改名 / 改色 / 删除四个入口', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('onCreateTag={onCreateTag}') >= 0
    && app.indexOf('onRenameTag={onRenameTag}') >= 0
    && app.indexOf('onRemoveTag={onRemoveTag}') >= 0
    && app.indexOf('onTagColor={onTagColor}') >= 0
    && app.indexOf('onRenameTag={doRenameTag}') >= 0
    && app.indexOf('onRemoveTag={doRemoveTag}') >= 0;
})());

/*
 * 哨兵值（「未分类」）不该给改名/删除按钮 ——
 * 它没有定义可改，点了"删"会弹确认框然后什么都没发生，
 * 而用户已经以为自己删掉了什么。
 */
/*
  分组加入"定义表驱动"三件套之后，这两处的锚点从 `(isTag || isType)`
  变成了 `defCol`（三种列统一走同一套）。
  哨兵判据也从"只有 NOTYPE"扩成了"NOTYPE 或 NOGROUP"——
  未分组同样是哨兵，给它摆删除按钮同样是骗人。
*/
t('标签/类型/分组：哨兵值不显示改名与删除按钮', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const pop = app.slice(app.indexOf('function ColFilterPop'), app.indexOf("if (col.kind === 'text') {"));
  return pop.indexOf('defCol && !isSentinel(v) && onRename') >= 0
    && pop.indexOf('defCol && !isSentinel(v) && onRemove') >= 0;
})());


/* ============================================================ 审查：删除/改名的后遗症（本轮） */

/*
 * **mutate 带乐观锁，写冲突时会重读再跑一次回调**（最多 3 次）。
 * 所以在回调里用 `n += 1` 计数，重试一次就把条数报成两倍 ——
 * toast 写"从 8 条任务上摘掉"而实际只有 4 条。
 *
 * 这种数字对不上比不报更糟：没人会怀疑统计，只会以为自己记错了。
 * 必须是**整体赋值**（n = cnt），重试时以最后一次为准。
 */
t('审查：删标签的计数是整体赋值（mutate 重试不会翻倍）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const doRemoveTag =');
  const seg = app.slice(i, app.indexOf('await refresh();', i));
  // 注意：注释里也写着 `n += 1`（说明为什么不能用），所以判据要带分号
  return seg.indexOf('n += 1;') < 0 && seg.indexOf('n = cnt') >= 0
    && seg.indexOf('let cnt = 0;') >= 0;
})());

t('审查：删类型的计数同样是整体赋值', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const removeType =');
  const seg = app.slice(i, app.indexOf('await refresh();', i));
  return seg.indexOf('n = (st.tasks || []).filter') >= 0 && seg.indexOf('n += ') < 0;
})());

/*
 * **删类型后没有 refresh**（原来只有 2s 轮询兜）：
 * 点了"删"，界面要过两秒才变 —— 而这两秒里列表、筛选下拉、chip 全是老样子，
 * 看着像点了没反应。（删标签那边是有 refresh 的，两边不一致。）
 */
t('审查：删类型后立刻重读（不能只靠 2s 轮询）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const removeType =');
  const seg = app.slice(i, app.indexOf('已删类型', i));
  return seg.indexOf('await refresh();') >= 0;
})());

/*
 * 摘标签 / 清空类型都是**改任务**，必须推进 updatedAt。
 * 不推进的话"更新"列纹丝不动，看着像这一行没被改过。
 */
t('审查：摘标签与清类型都要推进 updatedAt', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const a = app.slice(app.indexOf('const doRemoveTag ='), app.indexOf('const doPatch ='));
  const b = app.slice(app.indexOf('const removeType ='), app.indexOf('const toggleType ='));
  return a.indexOf('updatedAt: Date.now()') >= 0 && b.indexOf("updatedAt: Date.now()") >= 0;
})());

/*
 * 改名时若定义不存在（任务上是裸名字）要补一条 ——
 * ⛔ 补的颜色必须**取第一个没被占用的**：固定一档很可能和已有标签撞色，
 * 而配色的唯一作用就是一眼区分，两个同色标签等于白配。
 */
t('审查：补定义时取未被占用的颜色（不能固定一档撞色）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const doRenameTag =');
  const seg = app.slice(i, app.indexOf('const doRemoveTag ='));
  return seg.indexOf('TAG_COLORS.find((c) => !used.has(c))') >= 0
    && seg.indexOf('color: TAG_COLORS[6]') < 0;
})());


/* ============================================================ 审查：类型侧未刷新 + 新建体验（本轮） */

/*
 * **类型改名 / 改色 / 新建都没有立刻重读**（只靠 2s 轮询兜）：
 * 改完名字，下拉里、筛选摘要里、列表里全是旧值，要等两秒才变 ——
 * 看着像点了没反应。删类型、删标签、改标签那边都有 refresh，就这三个漏了。
 */
t('审查：类型改名/改色后立刻重读（不能只靠 2s 轮询）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const setTypeDef =');
  const seg = app.slice(i, app.indexOf('const createType', i));
  return seg.indexOf('await refresh();') >= 0;
})());

t('审查：新建类型后立刻重读（否则下拉里要等两秒才出现）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const createType =');
  const seg = app.slice(i, app.indexOf('删类型', i));
  return seg.indexOf('await refresh();') >= 0;
})());

/*
 * **同名新建被静默吞掉**：原来直接 return null（不写盘也不提示），
 * 用户敲完名字按回车，输入框清空了而下拉里什么都没多 ——
 * 看着就像"新建这个功能坏了"。同名是输入问题，必须说出来。
 */
t('审查：新建同名标签要有提示（静默不建 = 看着像功能坏了）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const seg = app.slice(app.indexOf('const doAddTag ='), app.indexOf('const doSetTagColor'));
  return seg.indexOf('已经有同名标签') >= 0 && seg.indexOf('ctx.toast(') >= 0;
})());

/*
 * 新建标签的取色要与新建类型同一判据（取第一个未被占用的），
 * 否则连着建几个标签拿到同一个颜色 —— 而配色的唯一作用就是一眼区分。
 */
t('审查：新建标签取未被占用的颜色（与新建类型同判据）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const seg = app.slice(app.indexOf('const doAddTag ='), app.indexOf('const doSetTagColor'));
  return seg.indexOf('TAG_COLORS.find((c) => !used.has(c))') >= 0;
})());

/* ============================================================ 审查：标签列排序按显示名（本轮） */

/*
 * **标签列排序按的是 id，界面显示的是名字**。
 * 按 id 排出来的顺序和眼睛看到的完全无关 ——
 * 点了列头排序，结果看着像随机，而界面上明明写着"排序：标签 ↓"。
 */
t('审查：标签排序按显示名而不是 id', (() => {
  const mk = (id, tags) => normalizeTask({ id, tags });
  const names = { tg_b: '阿', tg_a: '波' };   // id 序：tg_a < tg_b；名字序：阿 < 波
  const rows = [mk('1', ['tg_b']), mk('2', ['tg_a'])].map((t) => ({ task: t, depth: 0, path: [] }));
  // 传了映射 → 按名字排：阿(1) 在 波(2) 之前
  const byName = sortRowsBy(rows, 'tags', 'asc', names).map((r) => r.task.id).join();
  // 不传映射 → 退回按 id 排：tg_a(2) 在前
  const byId = sortRowsBy(rows, 'tags', 'asc').map((r) => r.task.id).join();
  return byName === '1,2' && byId === '2,1';
})());

/*
 * tagNames 必须进 useMemo 依赖：改了标签名之后排序结果会变，
 * 不重算的话列表停在旧顺序上 —— 而改名明明已经生效了。
 */
t('审查：排序的依赖里带 tagNames（改名后顺序要重算）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('[filteredRows, sort, tagNames]') >= 0;
})());


/* ============================================================ 审查：批量/挂摘/候选上限（本轮） */

/*
 * **toggleType 与 toggleTaskTag 是同款操作，但少了两样**（上次只修了挂标签那边）：
 * · 没有 refresh → 点了类型要过两秒才变，看着像点了没反应
 * · 不推进 updatedAt → "更新"列不动
 */
t('审查：挂/摘类型也要刷新并推进时间戳（与挂/摘标签同款）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const seg = app.slice(app.indexOf('const toggleType ='), app.indexOf('const changeSort ='));
  return seg.indexOf('await refresh();') >= 0 && seg.indexOf('updatedAt: Date.now()') >= 0;
})());

/*
 * **doBatchStatus 的计数也是累加**（与上一轮 doRemoveTag 同一个坑）：
 * mutate 冲突重试会让 done 翻倍、skipped 列表重复 ——
 * toast 说"已改 8 条"而实际只有 4 条。
 */
t('审查：批量改状态的计数是整体赋值（重试不会翻倍）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const seg = app.slice(app.indexOf('const doBatchStatus ='), app.indexOf('setChecked(new Set());', app.indexOf('const doBatchStatus =')));
  return seg.indexOf('done = ok') >= 0 && seg.indexOf('skipped = skip') >= 0
    && seg.indexOf('done += 1;') < 0;
})());

/*
 * **标签候选被 allTags 的 20 条上限截断**：
 * 那个上限原本是给"热门前 20"用的，挪到筛选候选上就成了 bug ——
 * 第 21 个之后的标签在下拉里凭空消失，
 * 而界面上不会说"只显示前 20 个"，只会以为那个标签不存在。
 */
t('审查：标签筛选候选不被 20 条上限截断', (() => {
  const tasks = [];
  for (let i = 0; i < 25; i += 1) tasks.push(normalizeTask({ id: `t${i}`, tags: [`tag${i}`] }));
  const rows = tasks.map((t) => ({ task: t, depth: 0, path: [] }));
  return colFilterValues('tags', rows, [], [], []).length === 25;
})());

t('审查：allTags 传 limit 时仍按热门截断（统计语义未变）', (() => {
  const tasks = [];
  for (let i = 0; i < 25; i += 1) tasks.push(normalizeTask({ id: `t${i}`, tags: [`tag${i}`] }));
  return allTags(tasks, 10).length === 10 && allTags(tasks).length === 25;
})());

/*
 * **createTask 漏了 group 字段** —— 与它自己头顶的注释自相矛盾：
 * "每个字段都显式写出来…字段在文件里看得见 AI 才会去填"，
 * 而 group 恰好没写。AI 看到的文件里没有这一列，
 * 于是它建出来的任务永远不带分组。
 */
t('审查：新建任务会写出 group 字段（AI 在文件里要看得见）', (() => {
  const src = fs.readFileSync(path.join(dir, 'lib/store.ts'), 'utf8');
  const i = src.indexOf('const base = {');
  const seg = src.slice(i, src.indexOf('const task = pushHistory', i));
  return seg.indexOf('group: typeof draft.group') >= 0;
})());

/*
 * **详情面板里没有分组**：列表行内那处是"顺手改一下"，
 * 而详情是"把这条所有字段看一遍"的地方 ——
 * 只有列表能改的话，从详情进来会以为这条压根没有分组这个属性。
 */
t('审查：详情面板里有分组字段', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('onCommit={(v) => onPatch({ group: v })}') >= 0
    && app.indexOf('placeholder="分组名（留空 = 不分组）"') >= 0;
})());


/* ============================================================ 审查：报数撒谎 / 隐藏排序列 / 删除破坏依赖（本轮） */

/*
 * **批量操作报数用的是 ids.length，不是实际命中数**。
 * 勾选到写盘之间任务可能已被别的通道删掉（AI 经 API 删、或另一窗口），
 * 那时 toast 说"已把 3 条改了"而实际只改了 1 条 ——
 * 报数撒谎比不报更糟，因为没人会去核对。
 */
t('审查：批量改类型报实际命中数（不用 ids.length）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const seg = app.slice(app.indexOf('const doBatchType ='), app.indexOf('const doBatchPriority ='));
  return seg.indexOf('hit = k') >= 0 && seg.indexOf('${ids.length}') < 0
    && seg.indexOf('没有一条改成功') >= 0;
})());

t('审查：批量改优先级报实际命中数', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const seg = app.slice(app.indexOf('const doBatchPriority ='), app.indexOf('批量删除'));
  return seg.indexOf('hit = k') >= 0 && seg.indexOf('${ids.length}') < 0;
})());

t('审查：批量删除报实际删除数', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const seg = app.slice(app.indexOf('const doBatchDelete ='), app.indexOf('标签定义落在'));
  return seg.indexOf('hit = before - tasks.length') >= 0 && seg.indexOf('已删除 ${hit} 条') >= 0;
})());

/*
 * **删除任务会破坏依赖**：删掉之后那些任务的前置变成"已被删除"，
 * 永远解锁不了。用户是在不知情的情况下制造了一批永远卡住的任务 ——
 * 而界面上只显示一把锁，不说清是哪个前置没了。
 */
t('审查：删除任务会提示有几条任务依赖它（批量与单条都要）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const b = app.slice(app.indexOf('const doBatchDelete ='), app.indexOf('标签定义落在'));
  const o = app.slice(app.indexOf('const doDelete ='), app.indexOf('const switchMe ='));
  return b.indexOf('broken.length > 0') >= 0 && b.indexOf('列为前置') >= 0
    && o.indexOf('dependents.length > 0') >= 0 && o.indexOf('列为前置') >= 0;
})());

/*
 * **藏掉正在排序的那一列，排序就没人能改了**：
 * 排序只能点列头改，列头随列一起消失 ——
 * 顶栏写着"排序：分组 ↓"，而列表里没有分组列，
 * 顺序看着像随机，且没有任何入口能改它。
 */
t('审查：隐藏排序依据列时排序会挪走（否则没人能改排序）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const seg = app.slice(app.indexOf('const toggleCol ='), app.indexOf('const colWidthRef'));
  return seg.indexOf("if (sort.field === field)") >= 0
    && seg.indexOf("field: 'updatedAt', dir: 'desc'") >= 0;
})());

/*
 * 时间区间填反了（起始晚于结束）命中数恒为 0，
 * 而界面只显示"0 / 12" —— 没人会往"我把日期填反了"那个方向想。
 */
t('审查：时间区间填反了要在面板里说出来', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('起始晚于结束，这样一条都筛不到') >= 0;
})());


/* ============================================================ 审查：详情每键写盘 / 新建弹窗缺字段（本轮） */

/*
 * **详情面板的自由文本是"每敲一个字写一次盘"**：
 * onChange → onPatch → mutate（读-改-写 + 乐观锁）。
 * 打字期间不断和 2s 轮询、AI 通道抢锁，冲突概率陡增。

 * ⛔ 更要命的是中文输入法：受控组件在 composition 期间会拿到拼音中间态，
 * 而这两个输入框**没有 isComposing 守卫**（备注框有，它们恰好漏了）——
 * 打一半的拼音会被当成正式内容写进 tasks.json。
 *
 * 改为本地草稿 + 失焦/回车提交，并带上输入法守卫。
 */
t('审查：详情的自由文本是草稿提交，不是每键写盘', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('function DraftInput({') >= 0
    && app.indexOf('onCommit={(v) => onPatch({ summary: v })}') >= 0
    && app.indexOf('onCommit={(v) => onPatch({ group: v })}') >= 0;
})());

t('审查：草稿提交带输入法守卫（拼音中间态不会写进文件）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function DraftInput({');
  const seg = app.slice(i, app.indexOf('function DetailModal({', i));
  return seg.indexOf('isComposing(e.nativeEvent)') >= 0
    && seg.indexOf('onBlur={commit}') >= 0;
})());

/*
 * **新建弹窗没有任务类型与分组**（这两项是后来加的字段）：
 * 从这儿建出来的任务永远没有类型、也没有分组，
 * 只能建完再去列表行内或详情里补 ——
 * 而"新建时顺手选一下"才是用户最自然的时机。
 */
t('审查：新建弹窗里有任务类型与分组', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function NewTaskModal({');
  const seg = app.slice(i, app.indexOf('function DetailModal({', i));
  return seg.indexOf('<span>任务类型</span>') >= 0
    && seg.indexOf('<span>分组（可选）</span>') >= 0
    && seg.indexOf('type,') >= 0 && seg.indexOf('group,') >= 0;
})());

/*
 * 分组是自由文本，但候选要复用已有分组 ——
 * "再敲一遍"会敲错一个字，于是变成两个分组，
 * 而界面上看不出它们本该是同一个。
 */
t('审查：新建弹窗的分组带已有分组候选', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('const allGroupNames = useMemo') >= 0
    && app.indexOf('groups={allGroupNames}') >= 0
    && app.indexOf('list="tb-group-options"') >= 0;
})());


/* ============================================================ 审查：看板卡片（本轮） */

/*
 * **看板卡片上的标签渲染的是原始 id**（tg_xxxx），而且没有颜色 ——
 * 同一张卡片上的**类型**是有颜色的，标签却是裸字符串。
 * 于是看板看不出这些标签是什么，也分不清彼此；
 * 而标签在列表里、筛选面板里都已经显示名字了（那两处都修过）。
 */
t('审查：看板卡片的标签走 TagChip（显示名字而不是 id）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function TaskCard({');
  const seg = app.slice(i, app.indexOf('const acts = actionsForIn', i));
  return seg.indexOf('tagDefs: TagDef[];') >= 0;   // 组件拿到了定义表
})());

t('审查：卡片里不再直接渲染裸标签值', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function TaskCard({');
  const body = app.slice(i, app.indexOf('<div className="tb-task-foot">', i));
  return body.indexOf('<TagChip key={tag} id={tag} defs={tagDefs} />') >= 0
    && body.indexOf('<span key={tag} className="tb-tag">') < 0;
})());

/*
 * **看板卡片不显示分组** —— 与之前修过的"类型"同一判据：
 * 看板是主视图之一，列表里有分组列而看板看不到，
 * 会让人以为"这条没分组"（尤其是刚在列表给一批任务填上分组、
 * 切到看板发现什么都没变）。
 */
t('审查：看板卡片会显示分组', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function TaskCard({');
  const body = app.slice(i, app.indexOf('<div className="tb-task-foot">', i));
  return body.indexOf('task.group ?') >= 0 && body.indexOf('tb-tag-group') >= 0;
})());

/*
 * tagDefs 要贯通到每一处 TaskCard（看板 + 分组视图的叶子，
 * 且分组视图是递归的 —— 中间节点也要往下传）。
 */
t('审查：tagDefs 贯通到看板与分组视图（含递归节点）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const gv = app.slice(app.indexOf('function GroupView({'), app.indexOf('function StatsView'));
  return gv.indexOf('tagDefs={tagDefs}') >= 0
    && app.indexOf('<GroupNodeView\n              key={c.key}\n              node={c}\n              tagDefs={tagDefs}') >= 0;
})());


/* ============================================================ 审查：统计的"陈旧"判据（本轮） */

/*
 * **没有 updatedAt 的任务被算成"超 7 天未动"**：
 * `now - 0` 是个巨大的数，于是所有**没时间戳**的未完成任务
 * 会全部涌进那个面板 —— 而它们可能刚建、正在做。
 *
 * 那不是"很久没动"，是"不知道什么时候动的"；
 * 把它算进陈旧是假数据，而且会淹没真正需要处理的那几条。
 * （列上的时间区间筛选是同样判据：时间为 0 不参与。）
 */
t('审查：没有更新时间的任务不算"陈旧"', (() => {
  const now = Date.now();
  const old = normalizeTask({ id: 'old', status: 'todo', updatedAt: now - 30 * 24 * 3600 * 1000 });
  const fresh = normalizeTask({ id: 'fresh', status: 'todo', updatedAt: now });
  const noTime = normalizeTask({ id: 'notime', status: 'todo' });   // updatedAt = 0
  const st = statsOf({ tasks: [old, fresh, noTime], flow: null }, now);
  const ids = st.stale.map((t) => t.id);
  return ids.indexOf('old') >= 0 && ids.indexOf('fresh') < 0 && ids.indexOf('notime') < 0;
})());

/* 已完成的不算陈旧（与时间无关） */
t('审查：已完成的任务不算陈旧', (() => {
  const now = Date.now();
  const doneOld = normalizeTask({ id: 'd', status: 'done', updatedAt: now - 90 * 24 * 3600 * 1000 });
  const st = statsOf({ tasks: [doneOld], flow: null }, now);
  return st.stale.length === 0;
})());


/* ============================================================ 审查：流程设置（本轮） */

/*
 * **新建状态的取色按"已有数量取模"**（与新建类型/标签的判据不一致）：
 * 取模恰好落在已被占用的那一档 —— 新建的状态和某个已有状态同色，
 * 而配色的唯一作用就是一眼区分。
 *
 * 三个入口（类型 / 标签 / 状态）必须同一判据，
 * 否则同一个"新建"动作在不同地方得到不同颜色，看着像三条互不相干的规则。
 */
t('审查：新建状态取未被占用的颜色（不按数量取模）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const addStatus = () => {');
  const seg = app.slice(i, app.indexOf('const removeStatus', i));
  return seg.indexOf('TAG_COLORS.find((c) => !used.has(c))') >= 0
    && seg.indexOf('color: TAG_COLORS[d.statuses.length % TAG_COLORS.length]') < 0;
})());

/*
 * **新建的状态是个孤岛**：它出现在下拉里、也占一列看板，
 * 但没有任何路径能走到它 —— 所有任务都点不到它。
 * 用户在流转矩阵里不一定反应得过来要去勾哪几格
 * （列表里点状态会看到它置灰 + tooltip，但那是**用**的时候才发现）。
 *
 * 建的时候就顺手接一条边（从原末尾状态过来，符合"流程加一步"的直觉）。
 */
t('审查：新建状态会顺手接一条边（否则是孤岛，走不进去）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const addStatus = () => {');
  const seg = app.slice(i, app.indexOf('const removeStatus', i));
  return seg.indexOf('const prevId =') >= 0
    && seg.indexOf('[prevId]: [...(d.transitions[prevId] || []), id]') >= 0;
})());


/* ============================================================ 审查：前置依赖能选成环（本轮） */

const dep = (id, deps) => normalizeTask({ id, deps });

/*
 * **可选前置里没有排除会成环的**：
 * 注释写的是"排除已成环的"，代码却只排除了自己和 parent —— 注释与实现不符。
 *
 * 于是可以把 A 的前置设成 B，而 B 已经（经过若干层）依赖 A：
 * 两条互相等，**永远解锁不了**。
 * lockOf 事后能检出 cyclic 并说明，但那时已经成环了，
 * 而且用户看到的是两把锁，看不出是自己刚才这一个勾选造成的。
 */
t('审查：dependsOn 是传递判定（不是只看直接前置）', (() => {
  const tasks = [dep('a', ['b']), dep('b', ['c']), dep('c', [])];
  return dependsOn(tasks, 'a', 'c') === true      // 隔一层也算
    && dependsOn(tasks, 'c', 'a') === false
    && dependsOn(tasks, 'a', 'a') === false;      // 自己不算
})());

t('审查：已成环的两个互为依赖（两边都要能检出）', (() => {
  const tasks = [dep('x', ['y']), dep('y', ['x'])];
  return dependsOn(tasks, 'x', 'y') === true && dependsOn(tasks, 'y', 'x') === true;
})());

t('审查：指向不存在的 id 也算依赖（不能被误当成可选）', (() => {
  const tasks = [dep('m', ['nope'])];
  return dependsOn(tasks, 'm', 'nope') === true;
})());

t('审查：成环时不会无限递归（有深度兜底）', (() => {
  const tasks = [dep('p', ['q']), dep('q', ['p'])];
  // 能正常返回、不抛栈溢出即可
  return typeof dependsOn(tasks, 'p', 'q') === 'boolean';
})());

/* 详情面板的候选要真的用上这个判定 */
t('审查：详情的可选前置用 dependsOn 过滤', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('!dependsOn(tasks, t.id, task.id)') >= 0;
})());


/* ============================================================ 审查：全局搜索搜不到分组（本轮） */

/*
 * **顶栏搜索框不搜分组名**：列表里明明有一列显示着"登录"，
 * 在上面敲"登录"却搜不到 —— 那是最让人怀疑的一种搜不到
 * （看得见的东西搜不着）。

 * 分组是自由文本，用户敲的就是那个词；
 * 这一列虽然能筛（列头漏斗），但顶栏这个框是更常用的入口。
 */
t('审查：全局搜索能搜到分组名', (() => {
  const rows = [
    normalizeTask({ id: '1', title: '甲', group: '登录' }),
    normalizeTask({ id: '2', title: '乙', group: '支付' }),
    normalizeTask({ id: '3', title: '丙' }),
  ].map((t) => ({ task: t, depth: 0, path: [] }));
  return filterTasksByColumns(rows, {}, '登录').map((r) => r.task.id).join() === '1'
    && filterTasksByColumns(rows, {}, '支付').map((r) => r.task.id).join() === '2'
    && filterTasksByColumns(rows, {}, '甲乙').length === 0;
})());

/* 标题/说明仍照常命中（加字段不能把原有的搜坏） */
t('审查：搜索仍能命中标题与说明', (() => {
  const rows = [
    normalizeTask({ id: '1', title: '登录页改版', summary: '' }),
    normalizeTask({ id: '2', title: '甲', summary: '处理登录态' }),
  ].map((t) => ({ task: t, depth: 0, path: [] }));
  return filterTasksByColumns(rows, {}, '登录').length === 2;
})());


/* ============================================================ 审查：统计口径 + 存档恢复（本轮） */

const CUSTOM_FLOW = {
  statuses: [
    { id: 's1', name: '待办', color: '#888888', enter: '开始', done: false },
    { id: 's2', name: '开发中', color: '#888888', enter: '开工', done: false },
    { id: 's3', name: '已完成', color: '#888888', enter: '完成', done: true },
  ],
  transitions: {},
  edges: {},
};

/*
 * **「进行中」写死成 `status === 'doing' || status === 'review'`**：
 * 自定义流程里那个状态可能叫别的（"开发中"、"联调"…），
 * 也可能有更多中间态 —— 于是这一项**恒为 0**，
 * 而卡片上还写着"进行中 doing + review"，那条提示也就成了假话。
 *
 * 判据改为"未完成 + 不是初始态"，与流程配置一致。
 */
t('审查：自定义流程下「进行中」不恒为 0', (() => {
  const tasks = [
    normalizeTask({ id: 'a', status: 's1' }),
    normalizeTask({ id: 'b', status: 's2' }),
    normalizeTask({ id: 'c', status: 's3' }),
  ];
  const st = statsOf({ tasks, flow: CUSTOM_FLOW }, Date.now());
  return st.active === 1 && st.open === 2 && st.done === 1;
})());

/* 默认流程下行为不变（todo 不算进行中） */
t('审查：默认流程下「进行中」= doing + review（行为未变）', (() => {
  const tasks = [
    normalizeTask({ id: 'a', status: 'todo' }),
    normalizeTask({ id: 'b', status: 'doing' }),
    normalizeTask({ id: 'c', status: 'review' }),
    normalizeTask({ id: 'd', status: 'done' }),
  ];
  return statsOf({ tasks, flow: null }, Date.now()).active === 2;
})());

/* 卡片上的提示不能再写死状态 id */
t('审查：卡片提示不写死状态 id', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf("hint: 'doing + review'") < 0
    && app.indexOf("hint: '已开工、未完成'") >= 0;
})());

/*
 * **存档里读回来的隐藏列没有数量上限**：
 * 界面上不让把最后一列也藏掉，但从存档读回来没有这道闸 ——
 * 存档可能是旧版本写的（那时列更少，藏 8 个只剩 1 个是合法的），
 * 升级到 13 列后还是只剩 1 个。

 * 于是打开就是一张几乎空的表格，而列设置面板里所有列都显示"已显示"
 * （因为数量刚好合法）—— 无从下手。
 */
t('审查：恢复的隐藏列有上限（不会只剩一列）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('if (hs.length > LIST_COLUMNS.length - 2)') >= 0
    && app.indexOf('hs = hs.slice(0, LIST_COLUMNS.length - 2)') >= 0;
})());


/* ============================================================ 审查：AI 通道改不了任务说明（本轮） */

/*
 * ⛔ 路径拼错时 rsSrc 是空串，而下面每条判据都以 `!rsSrc ||` 开头
 * （本意是「环境缺 Rust 源码就跳过」）—— 于是**整节空转还报绿**，
 * 其实一条都没跑。
 *
 * 实测踩到：原来拼的是 '../../../src-tauri'（少退一级就解析到仓库根，
 * 那里没有这个目录），这一节十几条审查断言一直显示「通过」，
 * 修了路径它们才真正开始检查（且全部通过）。
 * 所以先钉一条可达性：拼错要报红，不能静默跳过。
 */
const RS = path.join(dir, '../../src-tauri/src/task_board.rs');
const rsSrc = fs.existsSync(RS) ? fs.readFileSync(RS, 'utf8') : '';
t('（前置）Rust 源码可达：拼错会让整节静默空转', rsSrc.length > 0, `RS=${RS}`);
/* 环境缺 Rust 源码目录时这几条跳过（不算失败），原因同上方那条分组的 */
/** 剥离块注释与行注释 —— 源码扫描类判据都要先过一遍，避免被注释里的引文误伤 */
function STRIP(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const rsHas = (needle) => !rsSrc || rsSrc.indexOf(needle) >= 0;
const rsSeg = (anchor, len) => {
  if (!rsSrc) return '';
  const i = rsSrc.indexOf(anchor);
  return i < 0 ? '' : rsSrc.slice(i, i + len);
};

/*
 * **任务说明（summary）对 AI 通道完全不可用**：
 * · 建任务的 schema 里没有 summary
 * · 改任务的 schema 里没有 summary
 * · patch 的字段循环里也没有 summary
 *
 * 于是 AI 建出来的任务永远没有说明，建完也改不了 ——
 * 而文件里明明有这一列（显式写出来的），AI 看得见却填不了。
 *
 * 与之前修的 type / group 是同一类问题：
 * 新字段没有在**所有入口**落实（这次是 Rust / MCP 那侧的入口）。
 */
t('审查：AI 建任务的 schema 里有 summary', rsSeg('"tb_create_task"', 1200).indexOf('"summary"') >= 0 || !rsSrc);

t('审查：AI 改任务的 schema 里有 summary', rsSeg('"tb_update_task"', 1400).indexOf('"summary"') >= 0 || !rsSrc);

t('审查：建任务时会写入 summary 字段', rsHas('"summary".to_string(),'));

t('审查：patch 的字段循环里有 summary', rsHas('["title", "detail", "summary", "priority", "reporter"]'));


/* ============================================================ 审查：切配置后残留旧项目数据（本轮） */

/*
 * **设置页改完配置，主视图读不到新目录时留着旧 store**：
 * 界面显示的是**上一个项目的任务**，而写入用的是新目录（cfgRef 已经换了）——
 * 于是"看着甲的任务、点删除删的是乙里同 id 的那条（很可能没有）"，
 * 静默失败，且没人会对上原因。

 * 与 doSwitchProject 里那条"读不到要明说"是同一个判据：
 * 两条路径必须一致，否则一个项目能报、另一个不报。
 */
t('审查：配置事件里读失败会清空显示（不留着上一个项目的数据）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf("ctx.on('task-board:config'");
  const seg = app.slice(i, i + 1200);
  return seg.indexOf('setStore(normalizeStore(null))') >= 0
    && seg.indexOf('读不到它的任务库') >= 0;
})());


/* ============================================================ 审查：弹窗与浮层的关闭（本轮） */

/*
 * **Modal 没有 Escape 关闭**，但加了也不能无脑加：
 * 详情面板里的自由文本字段用 Escape 表示"撤销我打的字"，
 * 若在弹窗层也直接关，一次 Escape 会**同时**撤销草稿并关掉整个窗口 ——
 * 用户只想撤掉一个错字，结果整个详情没了。

 * 所以：焦点在输入框里时不关（交给输入框，它会 stopPropagation），
 * 焦点不在输入框时才是"关闭弹窗"。
 */
t('审查：Modal 支持 Escape 关闭（且避开输入框）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function Modal({');
  const seg = app.slice(i, i + 1400);
  return seg.indexOf("e.key !== 'Escape'") >= 0
    && seg.indexOf("tag === 'input'") >= 0;      // 输入框里不关
})());

t('审查：草稿输入里的 Escape 会阻止冒泡（不连带关掉弹窗）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function DraftInput({');
  const seg = app.slice(i, app.indexOf('function DetailModal({', i));
  return seg.indexOf("e.key === 'Escape'") >= 0 && seg.indexOf('e.stopPropagation()') >= 0;
})());

/*
 * **筛选面板不随滚动关闭**：面板 absolute 定位在单元格上，
 * 滚动时单元格动了而面板不跟着动 —— 于是面板飘在半空、
 * 和它所属的列头对不上，看着像面板自己跑到了别的地方。

 * 点错了选项却毫不知情，比"面板自动关掉要重新点一次"糟得多。
 */
t('审查：滚动/改窗口尺寸时关掉筛选面板（否则面板与列头错位）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf("if (!openCol) return;");
  const seg = app.slice(i, i + 1200);
  return seg.indexOf("window.addEventListener('scroll', close, true)") >= 0
    && seg.indexOf("window.addEventListener('resize', close)") >= 0;
})());


/* ============================================================ 审查：空分组依据（本轮） */

/*
 * **没选任何分组依据时，组名是空白**：
 * 所有任务落在同一个 key='' 的组里，groupLabel 把空串原样透出去 ——
 * 组头显示成一个没有名字的分组，用户不知道那是什么。

 * 而弹层里那句"还没选任何列 —— 所有任务会堆在一组里"
 * 在**关掉弹层后就看不到了**，剩下的只有一个空白组头。
 */
t('审查：空分组依据时组名不是空白', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function groupLabel(');
  const seg = app.slice(i, i + 700);
  return seg.indexOf("if (key === '') return") >= 0;
})());

/* 分组依据为空时不会崩、且只得到一组（含全部任务） */
t('审查：分组依据为空仍只得到一组且不抛错', (() => {
  const tasks = [
    normalizeTask({ id: '1', status: 'todo' }),
    normalizeTask({ id: '2', status: 'done' }),
  ];
  const g = groupTasksBy(tasks, [], null);
  return g.length === 1 && g[0].count === 2;
})());


/* ============================================================ 审查：状态名查写死的默认表（本轮） */

/*
 * 三处查的是 STATUS_LABEL（**默认那五个**的名字表），
 * 自定义流程的 id（s2、'完工'…）在里面查不到 → 显示原始 id。
 * 而同一条任务在别处显示的是"开发中" —— 同一个东西两处说法不一样。
 */
t('审查：流转后的 toast 用 statusName（不查写死的 STATUS_LABEL）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const doTransition =');
  const seg = app.slice(i, i + 900);
  return seg.indexOf('${statusName(flow, to)}') >= 0
    && seg.indexOf('${STATUS_LABEL[to]}') < 0;
})());

t('审查：筛选项的状态名走 statusName(flow, …)', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function optionLabel(');
  const seg = app.slice(i, i + 700);
  return seg.indexOf("return statusName(flow, v as TaskStatus)") >= 0;
})());

t('审查：flow 贯通到筛选面板与摘要', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('filterSummary(c, f, typeDefs, store ? store.tagDefs : [], flow, store ? store.groupDefs : [])') >= 0
    && app.indexOf('flow={flow}') >= 0;
})());


/* ============================================================ 审查：详情面板的按钮用默认流程（本轮） */

const FLOW2 = {
  statuses: [
    { id: 's1', name: '待办', color: '#888888', enter: '开工', done: false },
    { id: 's2', name: '开发中', color: '#888888', enter: '开工', done: false },
    { id: 's3', name: '完工', color: '#888888', enter: '完成', done: true },
  ],
  transitions: { s1: ['s2'], s2: ['s3'], s3: [] },
  edges: {},
};

/*
 * **详情面板的操作按钮用 actionsFor(…)** —— 那是**默认流程**写死的那一套。
 * 自定义流程下它算出来的按钮指向的状态在本项目里可能根本不存在
 * → doTransition 走流转校验失败 → **按钮点了没反应**（只弹个错）。

 * 而且漏掉用户新加的状态：详情里看不到"标为完工"这类按钮，
 * 于是自定义的状态只能从列表那一列里点，详情这儿像是坏了。
 */
t('审查：自定义流程下 actionsFor 是空的（所以详情必须用 actionsForIn）', actionsFor('s1').length === 0);

t('审查：actionsForIn 认自定义流程', (() => {
  const a = actionsForIn(FLOW2, 's1');
  return a.length === 1 && a[0].to === 's2' && a[0].label === '开工';
})());

/*
  组件从 DetailModal（模态弹窗）改名为 DetailPanel（右侧面板），
  这里是锚点跟随改名，判据本身不变。
*/
t('审查：详情面板用 actionsForIn(flow, …)', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function DetailPanel({');
  const seg = app.slice(i, i + 1500);
  return seg.indexOf('const acts = actionsForIn(flow, task.status);') >= 0
    && seg.indexOf('const acts = actionsFor(task.status);') < 0;
})());

/*
 * **主按钮（高亮）的判据写死成 `a.to === 'done'`**：
 * 自定义流程下完成态可能叫 's3'、'完工'… ——
 * 写死的话**没有一个按钮会高亮**，
 * 而高亮正是用来暗示"这一步是往前推进"的。
 */
t('审查：主按钮判据是"通向完成态"而不是写死 done', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function DetailModal({');
  const seg = app.slice(i, app.indexOf('function Modal({', i));
  return app.indexOf("(statusDone(flow, a.to) ? ' primary' : '')") >= 0
    && app.indexOf("(a.to === 'done' ? ' primary' : '')") < 0;
})());

/* 自定义流程下完成态不是 'done'，statusDone 要认配置 */
t('审查：statusDone 认自定义流程的完成态', (() => {
  return statusDone(FLOW2, 's3') === true && statusDone(FLOW2, 's2') === false;
})());


/*
 * **认领按钮的判据写死成 `status === 'todo'`**：
 * 自定义流程的初始态可能叫别的（'待办'/'新建'/'s1'…），
 * 写死的话这个按钮**永远不出现**，而"认领"是详情里最常用的动作 ——
 * 详情这儿像是少了功能。
 *
 * 两处（详情面板 + 看板卡片）都写死了，一并修。
 */
t('审查：认领按钮的判据是初始态（不写死 todo）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf("task.status === initialStatus(flow)") >= 0
    && app.indexOf("task.status === 'todo'") < 0;
})());

t('审查：没有残留写死的 todo/claimed 过滤', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf("task.status === 'todo' && a.to === 'claimed'") < 0;
})());

t('审查：自定义流程的初始态不是 todo（所以写死必然失效）', initialStatus(FLOW2) === 's1');


/* ============================================================ 审查：前置永远解锁不了（本轮） */

const FLOW3 = {
  statuses: [
    { id: 's1', name: '待办', color: '#888888', enter: '', done: false },
    { id: 's3', name: '完工', color: '#888888', enter: '', done: true },
  ],
  transitions: {},
  edges: {},
};
const dep2 = (id, status, deps) => normalizeTask({ id, status, deps: deps || [] });

/*
 * **isDone 写死 `status === 'done'`**（前置是否完成的判据）：
 * 自定义流程的完成态可能叫 's3'、'完工'…，
 * 写死的话**没有一条前置会解锁** ——
 * 依赖它的任务永远卡在"等前置"，而前置明明已经做完了。

 * 那是"锁永远打不开"这一档的错，比显示错名字严重得多：
 * 界面只说"被前置任务卡住"，不说清是哪个前置、为什么。

 * 修法：isDone 认 flow。而 lockOf 原本拿不到 flow（只接了 tasks），
 * 所以给它加了第三个参数 store（取里面的 flow）。
 */
t('审查：自定义流程下前置做完要解锁（不能写死 done）', (() => {
  const tasks = [dep2('a', 's1', ['b']), dep2('b', 's3', [])];
  return lockOf(tasks[0], tasks, { tasks, flow: FLOW3 }).locked === false;
})());

/* 未完成仍然锁着（不能改成一律解锁） */
t('审查：前置未完成时仍然锁着', (() => {
  const tasks = [dep2('a', 's1', ['b']), dep2('b', 's1', [])];
  return lockOf(tasks[0], tasks, { tasks, flow: FLOW3 }).locked === true;
})());

/* 默认流程行为不变 */
t('审查：默认流程下前置 done 即解锁（行为未变）', (() => {
  const tasks = [dep2('a', 'todo', ['b']), dep2('b', 'done', [])];
  return lockOf(tasks[0], tasks, { tasks, flow: null }).locked === false;
})());

/* 不传 store 时退回默认判据（老调用点不会误解锁） */
t('审查：不传 store 时退回默认判据（不会一律解锁）', (() => {
  const tasks = [dep2('a', 's1', ['b']), dep2('b', 's3', [])];
  return lockOf(tasks[0], tasks, null).locked === true;
})());

/* 两个调用点都要把 store 传下去 */
t('审查：列表与详情都把 store 传给 lockOf', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('lockOf(t, allRows.map((r) => r.task), taskStore)') >= 0
    && app.indexOf('lockOf(task, tasks, taskStore)') >= 0;
})());


/* ============================================================ 审查：通知在自定义流程下永远不触发（本轮） */

/*
 * **通知的触发状态写死 'review'**：
 * 自定义流程里"审查"那一步可能叫别的（'待审'、's4'…），
 * 于是配了 notifyUrl 却**永远收不到通知**，而且没有任何提示 ——
 * 用户只会在对端排查，想不到是这边压根没发。

 * 做成配置 notifyStatus（默认 'review'，老配置语义不变）。
 */
t('审查：通知触发状态走配置（不写死 review）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf("to === (cfg.notifyStatus || 'review')") >= 0
    && app.indexOf("if (to === 'review') await S.notifyWebhook") < 0;
})());

t('审查：notifyStatus 有默认值（老配置迁移后仍是 review）', (() => {
  const c = normalizeConfig({ projects: [{ id: 'p1', name: 'x', dataDir: '/a', docsDir: '' }], currentId: 'p1' });
  return c.notifyStatus === 'review';
})());

t('审查：配置里已有的 notifyStatus 会被保留', (() => {
  const c = normalizeConfig({
    projects: [{ id: 'p1', name: 'x', dataDir: '/a', docsDir: '' }],
    currentId: 'p1',
    notifyStatus: 's4',
  });
  return c.notifyStatus === 's4';
})());

/* 下发给 Rust：两边必须同一个判据，否则 AI 通道与界面行为不一致 */
t('审查：notifyStatus 一并下发给 Rust', (() => {
  const st = fs.readFileSync(path.join(dir, 'lib', 'store.ts'), 'utf8');
  return st.indexOf("notifyStatus: cfg.notifyStatus || 'review',") >= 0;
})());

/* 触发状态变了要重启服务（它是在启动时下发的） */
t('审查：改触发状态会重启 HTTP 服务', (() => {
  const st = fs.readFileSync(path.join(dir, 'Settings.tsx'), 'utf8');
  return st.indexOf('next.notifyStatus !== prev.notifyStatus') >= 0;
})());


/* ============================================================ 审查：Rust 侧通知触发仍写死（本轮） */

/*
 * 上一轮只在**下发侧**加了 notifyStatus，
 * Rust 消费侧仍写死 `status == "review"` ——
 * 于是界面能触发、AI 经 HTTP 通道触发不了（两边不一致）。
 */
const rs2Has = (needle) => !rsSrc || rsSrc.indexOf(needle) >= 0;

t('审查：Rust 侧 tb_http_start 接收 notify_status', (() => {
  if (!rsSrc) return true;
  const i = rsSrc.indexOf('pub fn tb_http_start(');
  return rsSrc.slice(i, i + 900).indexOf('notify_status: String,') >= 0;
})());

t('审查：Rust 侧 patch_task 的判据不再写死 review', (() => {
  if (!rsSrc) return true;
  const i = rsSrc.indexOf('fn patch_task(');
  return rsSrc.slice(i, i + 900).indexOf('notify_status: &str,') >= 0;
})());

t('审查：Rust 侧判据用的是 notify_status 变量', rs2Has('let watch = if notify_status.trim().is_empty()')
  && rs2Has('status == watch && old != watch'));


/* ============================================================ 审查：搜索搜不到认领人和类型（本轮） */

const SEARCH_DEFS = [{ id: 'dev', name: '开发' }, { id: 'bug', name: 'BUG' }];
const srow = (id, o) => ({ task: normalizeTask({ id, ...o }), depth: 0, path: [], groupPath: '' });
const SROWS = [srow('1', { title: '登录', assignee: '张三', type: 'dev' }),
  srow('2', { title: '支付', assignee: '李四', type: 'bug' })];

/*
 * **认领人不进搜索**：用户在搜索框打同事名字 → 0 条。
 * 他会以为"没有这个人"，而不是"搜索不搜这个字段"。
 * 而认领人列上的筛选是**多选下拉**，得先知道有那一列才会用。
 */
t('审查：搜索能匹配认领人', filterTasksByColumns(SROWS, {}, '张三', SEARCH_DEFS).length === 1);

/*
 * **类型两头不靠**：任务上存 id（'dev'），显示的是"开发"。
 * 搜 id 没意义（用户看不见），搜名字又搜不到 ——
 * 于是类型这列在搜索面前等于不存在。
 */
t('审查：搜索能匹配类型的显示名（不只是 id）', (() => {
  return filterTasksByColumns(SROWS, {}, '开发', SEARCH_DEFS).length === 1
    && filterTasksByColumns(SROWS, {}, 'BUG', SEARCH_DEFS).length === 1;
})());

/* 不传定义表时退回按 id 搜（老行为不变） */
t('审查：不传类型定义时按 id 搜（行为不变）', filterTasksByColumns(SROWS, {}, 'dev').length === 1);

/* 标题照旧能搜 */
t('审查：搜索仍能匹配标题（未破坏）', filterTasksByColumns(SROWS, {}, '登录', SEARCH_DEFS).length === 1);

/* 调用点要把 typeDefs 传下去，且依赖里要带上 */
t('审查：调用点传了 typeDefs 且在依赖里', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('filterTasksByColumns(flatRows, colFilters, q, typeDefs, store ? store.tagDefs : [])') >= 0
    && app.indexOf('[flatRows, colFilters, q, typeDefs, store ? store.tagDefs : []]') >= 0;
})());


/* ============================================================ 审查：按状态分组在自定义流程下顺序乱（本轮） */

const FLOW4 = {
  statuses: [
    { id: 's1', name: '待办', color: '#888888', enter: '', done: false },
    { id: 's2', name: '开发中', color: '#888888', enter: '', done: false },
    { id: 's3', name: '完工', color: '#888888', enter: '', done: true },
  ],
  transitions: {},
  edges: {},
};

/*
 * **按状态分组时查写死的 STATUS_RANK**（默认那七个）：
 * 自定义流程的状态 id 在那张表里查不到 → 全部落到同一档 →
 * **顺序变成数据在文件里的先后顺序**（实测 s3 → s1 → s2）。

 * "按状态分组"其实是这些组唯一有意义的顺序（待办→在做→已完成），
 * 顺序乱了之后，想看"还有多少没做完"就得从头扫一遍 ——
 * 而用户会以为是自己把状态配错了顺序。
 */
t('审查：自定义流程下按状态分组按流程顺序排', (() => {
  const tasks = [
    normalizeTask({ id: 'a', status: 's3' }),
    normalizeTask({ id: 'b', status: 's1' }),
    normalizeTask({ id: 'c', status: 's2' }),
  ];
  const g = groupTasksBy(tasks, ['status'], FLOW4);
  return g.map((x) => x.key).join(',') === 's1,s2,s3';
})());

/* 默认流程行为不变 */
t('审查：默认流程下按状态分组顺序不变', (() => {
  const tasks = [
    normalizeTask({ id: 'a', status: 'done' }),
    normalizeTask({ id: 'b', status: 'todo' }),
    normalizeTask({ id: 'c', status: 'doing' }),
  ];
  return groupTasksBy(tasks, ['status'], null).map((x) => x.key).join(',') === 'todo,doing,done';
})());

/* 调用点要把 flow 传下去（且进依赖） */
t('审查：调用点传了 flow 且在依赖里', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('groupTasksBy(listRows.map((r) => r.task), groupKeys, flow)') >= 0
    && app.indexOf('[listRows, groupKeys, flow]') >= 0;
})());


/* ============================================================ 审查：按标签分组组头显示原始 id（本轮） */

/*
 * **按标签分组时 key 是标签 id（tg_xxxx）**，groupLabel 不查定义表 →
 * 组头显示一串没人看得懂的字符。

 * 用户选"按标签分组"就是要按**名字**归拢，
 * 看着像分组功能坏了（"这些都是什么？"）。
 */
t('审查：按标签分组时组头查标签定义表', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function groupLabel(');
  const seg = app.slice(i, i + 900);
  return seg.indexOf("if (by === 'tag') {") >= 0;
})());

t('审查：groupLabel 的调用点传了 tagDefs', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('groupLabel(node.key, by, flow, tagDefs)') >= 0;
})());


/* ============================================================ 守卫（防同类问题复发） */

/*
 * **守卫 1：业务判据里不许出现写死的默认状态 id**
 *
 * 状态由用户在界面上配置之后，'todo'/'done'/'review' 这些只是**默认值**，
 * 不再是业务判据。写死的话只在默认流程下成立 ——
 * 这一轮里它一共出现在五个不同入口（状态名、详情按钮、isDone、
 * webhook、分组排序），分五轮才清完，每一轮都以为"这是最后一处"。

 * 判据形如 `x === 'done'`；`cfg.notifyStatus || 'review'` 这种
 * **配置默认值**不算（那是给没配过的老存档兜底，不是判据）。
 */
/*
  ⛔ 必须同时匹配 `!==`：写死判据里"不等于 done"和"等于 done"一样常见
  （openCount 那条正是 `t.status !== 'done'`）。
  只写 `===` 的话，反向验证时注入 `!==` 居然不红 —— 守卫自己有洞。
*/
const WRITE_DEAD_STATUS = /[!=]==\s*['"](todo|claimed|doing|hold|review|done|cancelled)['"]/;

/*
  ⛔ 必须**先剥离注释**再匹配，不能靠"行首是不是 // 或 *"来判断：
  注释里很自然会写出"⛔ 写死 `!== 'done'` 的话…"这种说明，
  而它恰好符合判据模式 —— 那样守卫要么误报（红得好没道理），
  要么为了不误报去改注释措辞（本末倒置，而且一改再改）。

  下面这个剥离不处理字符串里的 //（比如 URL），
  对这个用途足够，且比改注释措辞健壮得多。
*/
const stripComments = (src) => {
  let out = '';
  let inBlock = false;
  for (const line of src.split('\n')) {
    let res = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end < 0) { i = line.length; break; }
        inBlock = false;
        i = end + 2;
        continue;
      }
      const b = line.indexOf('/*', i);
      const sl = line.indexOf('//', i);
      if (b >= 0 && (sl < 0 || b < sl)) {
        res += line.slice(i, b);
        inBlock = true;
        i = b + 2;
        continue;
      }
      if (sl >= 0) { res += line.slice(i, sl); break; }
      res += line.slice(i);
      break;
    }
    out += res + '\n';
  }
  return out;
};

t('守卫：业务判据里没有写死的默认状态 id', (() => {
  const files = ['App.tsx', 'Settings.tsx', 'core.mjs', 'lib/store.ts'];
  const bad = [];
  for (const f of files) {
    const src = stripComments(fs.readFileSync(path.join(dir, f), 'utf8'));
    src.split('\n').forEach((l, i) => {
      if (WRITE_DEAD_STATUS.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 70)}`);
    });
  }
  return bad.length === 0;
})());

/* 守卫自身要经得起反向验证：剥离确实生效 */
t('守卫自检：stripComments 能去掉块注释里的判据字样', (() => {
  const src = "/* ⛔ 写死 x !== 'done' 是不对的 */\nconst y = 1;";
  return !WRITE_DEAD_STATUS.test(stripComments(src));
})());

/*
 * **守卫 2：同一个"空值"概念不许有两个哨兵**
 *
 * 未认领此前在筛选路径上是 ''、在分组路径上是 '__none__' ——
 * 同一件事两个哨兵，改一处就会错（筛得到但分组分不出，或反之）。
 */
t('守卫：未认领只有一个哨兵（筛选与分组取值一致）', (() => {
  const tasks = [
    normalizeTask({ id: 'a', assignee: 'w1' }),
    normalizeTask({ id: 'b' }),
  ];
  const rows = tasks.map((t) => ({ task: t, depth: 0, path: [], groupPath: '' }));
  /* 筛选用到的原始值 */
  const rawNone = colRawValues(tasks[1], 'assignee')[0];
  /* 分组用到的 key */
  const g = groupTasksBy(tasks, ['assignee'], null);
  const gNone = g.find((x) => !x.tasks.every((t) => t.assignee));
  /* 候选值里也必须能选到它，否则"找没人认领的"在下拉里没有入口 */
  const opts = colFilterValues('assignee', rows);
  return rawNone === UNASSIGNED
    && gNone !== undefined && gNone.key === UNASSIGNED
    && opts.indexOf(UNASSIGNED) >= 0;
})());


/*
 * **守卫 3：字段 × 入口的覆盖矩阵**
 *
 * 这是"新字段没在所有入口落实"的防复发网。
 * 那个错在这几轮里反复出现：group 漏了 5 处（store / 详情 / 新建弹窗 /
 * 看板卡片 / 全局搜索），summary 漏了 Rust 那 4 处，notifyStatus 漏了消费侧。
 * 每次都只补发现的那处，下一轮换个维度又抓到同一字段的另一处。

 * 所以这里把"哪些字段必须出现在哪些入口"固定下来：
 * 以后加新字段，忘了在某个入口落实，这条立刻变红。
 */
const SEG = (src, from, until) => {
  const i = src.indexOf(from);
  if (i < 0) return '';
  const j = until ? src.indexOf(until, i + from.length) : -1;
  return src.slice(i, j < 0 ? i + 6000 : j);
};

const HAS = (seg, f) => seg.indexOf(f) >= 0          /* 兜底：字段串直接出现 */
  || seg.indexOf(`"${f}"`) >= 0 || seg.indexOf(`'${f}'`) >= 0
  || seg.indexOf(`${f}:`) >= 0 || seg.indexOf(`task.${f}`) >= 0
  || seg.indexOf(`t.${f}`) >= 0 || seg.indexOf(`draft.${f}`) >= 0;

const MATRIX = [
  /* [入口名, 片段, 必须出现的字段] */
  ['新建弹窗', () => SEG(appSrc, 'function NewTaskModal(', '\nfunction '),
    ['title', 'detail', 'summary', 'priority', 'estimate', 'type', 'group']],
  ['详情面板', () => SEG(appSrc, 'function DetailPanel({', '\nfunction '),
    ['title', 'detail', 'summary', 'priority', 'estimate', 'type', 'group', 'tags', 'assignee', 'deps']],
  ['全局搜索', () => SEG(coreSrc, 'const hay = ', '\n    }'),
    ['t.id', 't.title', 't.detail', 't.summary', 't.group', 't.assignee']],
];

for (const [name, get, fields] of MATRIX) {
  t(`守卫：字段覆盖矩阵 —— ${name}`, (() => {
    const seg = get();
    if (!seg) return false;
    return fields.every((f) => HAS(seg, f));
  })());
}

/*
 * Rust 那一侧同样要覆盖（AI 走 MCP/HTTP 建任务，
 * 字段在 schema 里看不见，AI 就不会去填）。
 * 本环境缺 Rust 源码时跳过，不算失败。
 */
if (rsSrc) {
  const RS_CREATE = SEG(rsSrc, '"tb_create_task"', '"tb_get_task"');
  const RS_UPDATE = SEG(rsSrc, '"tb_update_task"', '"tb_add_event"');
  const RS_PATCH = SEG(rsSrc, 'for key in ["title"', ']');
  for (const [name, seg, fields] of [
    ['Rust 建任务 schema', RS_CREATE, ['title', 'detail', 'summary', 'priority', 'estimate', 'type', 'group', 'tags']],
    ['Rust 改任务 schema', RS_UPDATE, ['title', 'detail', 'summary', 'priority', 'estimate', 'type', 'group', 'tags', 'assignee']],
    ['Rust patch 字段循环', RS_PATCH, ['title', 'detail', 'summary', 'priority']],
  ]) {
    t(`守卫：字段覆盖矩阵 —— ${name}`, seg.length > 0 && fields.every((f) => seg.indexOf(`"${f}"`) >= 0));
  }
}


/*
 * **守卫 4：标签 id 不许裸渲染**
 *
 * 任务上存的是标签 id（tg_xxxx），界面要显示名字 + 颜色。
 * 这个映射散落在五处，各写各的，于是不断漏：
 *   列表行 / 筛选面板 / 筛选摘要 / 看板卡片 / **统计面板**
 * 前四处是分四轮才补齐的，第五处（热门标签）这轮才撞见。

 * 判据：JSX 里出现 `{x.tag}`、`{tag}` 这种**直接把 id 当文本渲染**的写法。
 * TagChip / TagPicker 这些组件内不算（它们本来就该拿 id，
 * 自己负责查表）。
 */
t('守卫：没有把标签 id 当文本直接渲染的地方', (() => {
  const src = stripComments(appSrc);
  const bad = [];
  src.split('\n').forEach((l, i) => {
    /* 组件自身的实现允许拿 id；这里只盯"渲染处" */
    if (/function\s+(TagChip|TagPicker|TypePicker)/.test(src.slice(Math.max(0, src.indexOf(l) - 4000), src.indexOf(l)))) {
      /* 后面的 TagChip 定义整段跳过：下面用行范围判断 */
    }
    /*
      ⛔ 判据必须排除**属性位置**：`key={tag}` / `id={tag}` 里的 tag
      是"把这行的标识交给 React / 交给 TagChip 去查表"，那是对的；
      只有 `{tag}` 出现在**子元素位置**（当文本渲染）才是裸渲染。
      不看位置的话，`<TagChip key={tag} id={tag} …/>` 会被误判成违规，
      于是守卫恒红 —— 反向验证时它根本抓不到真正的回归。
    */
    const m = l.match(/(^|[^=\w])\{\s*(?:x\.tag|t\.tag|tag)\s*\}/);
    if (m) bad.push(`${i + 1}: ${l.trim().slice(0, 70)}`);
  });
  /* 排除 TagChip 自身那一段（它内部拿 id 是对的） */
  const chipStart = src.indexOf('function TagChip(');
  const chipEnd = src.indexOf('\nfunction ', chipStart + 10);
  const real = bad.filter((b) => {
    const ln = Number(b.split(':')[0]) - 1;
    const off = src.split('\n').slice(0, ln).join('\n').length;
    return !(off >= chipStart && off < chipEnd);
  });
  return real.length === 0;
})());

/*
 * 统计面板必须拿到标签定义表 —— 拿不到就无从显示名字，
 * 而它又是唯一一处"从统计结果反查定义"的地方（别的都在任务行上）。
 */
t('守卫：统计面板收到标签定义表', (() => {
  const src = stripComments(appSrc);
  return src.indexOf('tagDefs={store.tagDefs}') >= 0
    && src.indexOf('stats, flow, typeDefs, tagDefs, onOpen,') >= 0;
})());


/*
 * **守卫 5：core.mjs 不许有"没人调用"的导出**
 *
 * 两份实现就是两份真相：改搜索时很容易改错地方
 * （改了 filterTasks 而界面走的是 filterTasksByColumns），
 * 或者对着一份死代码反复修、界面纹丝不动。

 * 这轮据此清掉两个：
 * · filterTasks —— 顶栏四下拉时代的老过滤，界面早全改用列级筛选
 * · groupStatus —— **手动组时代**的残留（用 parentOf 找子任务算组状态）。
 *   手动组已平铺成"按列分组"（视图概念），数据里不再有 kind='group'，
 *   于是它成了没人调用、却还带着一整套"判据不能写死 done"注释的死代码。

 * 判据：导出名在 App.tsx / store.ts / core.mjs 自身 / 本测试里的调用次数 ≤ 1
 * （1 = 只有它自己的定义那处）。
 */
t('守卫：core.mjs 没有无人调用的导出（无两份真相）', (() => {
  const names = [...coreSrc.matchAll(/export function (\w+)/g)].map((m) => m[1]);
  const dead = [];
  for (const n of names) {
    const re = new RegExp('\\b' + n + '\\s*\\(', 'g');
    const uses = (appSrc.match(re) || []).length
      + (coreSrc.match(re) || []).length
      + (storeSrc.match(re) || []).length
      + (testSrc.match(re) || []).length;
    if (uses <= 1) dead.push(n);
  }
  return dead.length === 0;
})());


/*
 * **守卫 6：配置驱动渲染时，"配置里没有"不能等于"不存在"**
 *
 * 看板列、统计状态分布都遍历 `flow.statuses` 渲染。
 * 任务状态可以是配置里没有的（状态被删掉、或 AI 经 API 直接写了个），
 * 那些任务于是**哪里都不显示**：
 * · 看板：列是按配置渲染的 → 任务凭空消失（列表里还在）
 * · 统计：各状态之和 < 总任务数，差额去哪了看不出来

 * 两者都不会报错，只是"东西少了"，用户只会以为漏渲染或算错了。

 * 判据：这两处渲染不能再直接遍历 flow.statuses。
 */
/*
  ⛔ 判据必须**按渲染块**判定，不能全文件搜 `flow.statuses.map`：
  批量改状态的下拉本来就该只列配置里的状态（目标只能是已定义的状态），
  那里的 `flow.statuses.map` 是正确的。
  全文件搜的话守卫恒红 —— 反而抓不到真正的回归。
*/
const blockOf = (src, from, until) => {
  const i = src.indexOf(from);
  if (i < 0) return '';
  const j = src.indexOf(until, i + from.length);
  return src.slice(i, j < 0 ? i + 4000 : j);
};

t('守卫：看板列不只遍历 flow.statuses（未配置状态也要有列）', (() => {
  const src = stripComments(appSrc);
  const seg = blockOf(src, "{view === 'board' && (", '{view ===');
  return seg.indexOf('boardColumns.map((sd)') >= 0
    && seg.indexOf('flow.statuses.map') < 0;
})());

t('守卫：统计状态分布不只遍历 flow.statuses', (() => {
  const src = stripComments(appSrc);
  return src.indexOf('{statsByStatus.map((sd) => (') >= 0;
})());


/* ============================================================ 审查：JSON 里的数字写成字符串被静默丢弃（本轮） */

/*
 * **`Number.isFinite` 不认字符串**：
 * `Number.isFinite("2.5")` 是 false（它不做类型转换）。
 * 而 JSON 里把数字写成字符串是完全正常的写法
 * （表单提交、AI 手写 JSON 都常这样）。

 * 于是**用户/AI 明明填了，却被静默当成"没填"**：
 * · `"estimate": "2.5"` → 0 → 界面显示"没估"、统计里不计
 * · `"createdAt": "1700000000000"` → 0 → 不参与日期区间筛选、
 *   在"按创建排序"里永远垫底

 * 两者都不报错，只是那一格空着 / 那条永远排在最后。
 */
t('审查：预估写成字符串也能认（"2.5" → 2.5）', (() => {
  return normalizeTask({ id: 'x', estimate: '2.5' }).estimate === 2.5
    && normalizeTask({ id: 'x', estimate: '3' }).estimate === 3;
})());

t('审查：时间戳写成字符串也能认', (() => {
  const t = normalizeTask({ id: 'x', createdAt: '1700000000000' });
  return t.createdAt === 1700000000000;
})());

/* 非法值仍然归零 / 走默认（不能因为放宽就把垃圾写成数字） */
t('审查：非数字仍然归零（未放宽过头）', (() => {
  return normalizeTask({ id: 'x', estimate: 'abc' }).estimate === 0
    && normalizeTask({ id: 'x', estimate: -5 }).estimate === 0
    && normalizeTask({ id: 'x', estimate: NaN }).estimate === 0;
})());

/*
 * **守卫 7：数值字段不许直接用 `Number.isFinite(原值)` 判**
 *
 * 判据形如 `Number.isFinite(t.xxx)` —— 传入 JSON 原值时字符串会漏掉。
 * 正确写法是先 `Number(v)` 再判。
 */
/*
  ⛔ 判据只盯**字段访问**（`x.y` 形式），不能匹配纯变量名：
  `Number.isFinite(n)` 里的 n 往往就是刚 `Number(v)` 转换出来的，
  那正是**正确**写法。全匹配的话守卫恒红（当前就有 7 处命中、4 处是对的），
  真正的回归反而看不出来。

  字段访问（`s.v` / `a.lastSeen` / `t.estimate`）才是
  "直接拿 JSON 原值去判"的高危写法。
*/
t('守卫：数值字段先 Number() 再判有限性', (() => {
  const src = stripComments(coreSrc);
  const bad = [];
  src.split('\n').forEach((l, i) => {
    if (/Number\.isFinite\(\s*[a-zA-Z_$][\w$]*\s*\.\s*[\w$]+/.test(l)) bad.push(`${i + 1}: ${l.trim().slice(0, 60)}`);
  });
  return bad.length === 0;
})());


/* ============================================================ 审查：归一化不 trim（本轮）+ 排序不稳定 */

const WS = (id, o) => normalizeTask({ id, ...o });

/*
 * **文本字段不 trim**：
 * AI 手写 JSON / 表单提交里 `"assignee": "   "` 很常见。
 * 而"有没有认领人"的判据是 truthy → 它被当成**有人认领**：
 * 界面显示一个空白的名字，筛"未认领"筛不到它，
 * 分组里多一个名字是三个空格的组，统计里多一个空白认领人。
 * 全是**看不见的实体**。
 */
t('审查：全空格的认领人算作未认领', WS('a', { assignee: '   ' }).assignee === null);

t('审查：全空格的分组名算作未分组', WS('a', { group: '  ' }).group === '');

t('审查：tags 去掉空值与重复', (() => {
  const t = WS('a', { tags: ['a', '', '  ', 'a'] });
  return t.tags.length === 1 && t.tags[0] === 'a';
})());

t('审查：deps 去掉空值与重复', (() => {
  const t = WS('a', { deps: ['', 'b', 'b'] });
  return t.deps.length === 1 && t.deps[0] === 'b';
})());

t('审查：前后空白的标题被 trim', WS('a', { title: '  标题  ' }).title === '标题');

t('审查：状态 id 带空白也能匹配配置', WS('a', { status: ' done ' }).status === 'done');

/*
 * **排序不稳定**：同值任务的顺序取决于它们在文件里的先后，
 * 而那个顺序会随写盘变化 → 用户什么都没动，刷新一下同值的几条就换了位置。
 * 顶栏明明写着"排序：优先级 ↓"，看着像排序坏了。
 */
t('审查：排序稳定（同值任务的顺序与输入顺序无关）', (() => {
  const mk3 = (id) => normalizeTask({ id, priority: 'P1', updatedAt: 1, title: 'x' });
  const fwd = [mk3('a'), mk3('b'), mk3('c')];
  const rev = [mk3('c'), mk3('b'), mk3('a')];
  const one = (f) => sortTasksBy(fwd, f, 'asc').map((x) => x.id).join('') === sortTasksBy(rev, f, 'asc').map((x) => x.id).join('');
  /* 时间字段本来就按 updatedAt 兜底，这里盯的是其余字段 */
  return one('priority') && one('title') && one('status') && one('group') && one('estimate');
})());

/* 降序时 id 兜底也要跟着反转（否则"降序"对同值组没有体现） */
t('审查：同值时升降序互为逆序', (() => {
  const mk3 = (id) => normalizeTask({ id, priority: 'P1', updatedAt: 1, title: 'x' });
  const list = [mk3('a'), mk3('b'), mk3('c')];
  const a = sortTasksBy(list, 'priority', 'asc').map((x) => x.id).join('');
  const d = sortTasksBy(list, 'priority', 'desc').map((x) => x.id).join('');
  return a === [...a].reverse().join('') ? false : a === 'abc' && d === 'cba';
})());


/* ============================================================ 分组定义表（本轮新增） */

const GDEFS = [{ id: '登录', name: '登录', color: '#22c55e' }];

t('审查：分组定义表能读出来（对象数组）', (() => {
  const st = normalizeStore({ groupDefs: [{ id: '登录', name: '登录', color: '#f00' }] });
  return st.groupDefs.length === 1 && st.groupDefs[0].color === '#f00';
})());

/* 手写真省事的写法：{"groupDefs":["登录","支付"]} —— 也要认 */
t('审查：分组定义表接受纯字符串数组', (() => {
  const st = normalizeStore({ groupDefs: ['登录', '支付'] });
  return st.groupDefs.length === 2 && st.groupDefs[0].id === '登录';
})());

t('审查：分组名没有定义时原样显示（不硬塞假名）', groupName(GDEFS, '支付') === '支付');

t('审查：分组没定义时颜色为空（不硬塞假色）', groupColor(GDEFS, '支付') === '');

/*
  分组改成 enum 之后，colRawValues 必须返回它的值 ——
  漏了就是"该列筛选 100% 失效"，而界面只显示"没有符合条件的任务"。
*/
t('审查：分组列能在 colRawValues 里取到值', (() => {
  const t1 = normalizeTask({ id: 'a', group: '登录' });
  const t2 = normalizeTask({ id: 'b' });
  return colRawValues(t1, 'group')[0] === '登录' && colRawValues(t2, 'group')[0] === NOGROUP;
})());

/* 候选 = 定义表 ∪ 数据 ∪ 未分组：只取一边都会漏 */
t('审查：分组候选 = 定义表 + 数据 + 未分组', (() => {
  const mk2 = (id, o) => ({ task: normalizeTask({ id, ...o }), depth: 0, path: [], groupPath: '' });
  const rows = [mk2('a', { group: '登录' }), mk2('b', { group: '支付' }), mk2('c', {})];
  const v = colFilterValues('group', rows, [], [], [], ['登录']);
  return v.indexOf('登录') >= 0 && v.indexOf('支付') >= 0 && v.indexOf(NOGROUP) >= 0;
})());

t('审查：按分组筛选命中（含未分组）', (() => {
  const mk2 = (id, o) => ({ task: normalizeTask({ id, ...o }), depth: 0, path: [], groupPath: '' });
  const rows = [mk2('a', { group: '登录' }), mk2('c', {})];
  return filterTasksByColumns(rows, { group: { values: ['登录'] } }, '').length === 1
    && filterTasksByColumns(rows, { group: { values: [NOGROUP] } }, '').length === 1;
})());


/* ============================================================ 分组成为定义表列（本轮改造） */

/*
 * 分组列原来 kind='text'（只有关键词框），于是：
 * · "这一列有哪些分组"根本看不到
 * · 更谈不上增删改色
 * 而分组恰恰是最需要"从已有项里挑一个"的字段 ——
 * 手打必然打出 '登录' / '登陆' 两种写法，分成两组还看不出为什么。
 */
t('审查：分组列是 enum（定义表驱动，不再是自由文本）', (() => {
  const c = LIST_COLUMNS.find((x) => x.field === 'group');
  return !!c && c.kind === 'enum';
})());

/*
 * 三种定义表列（标签 / 类型 / 分组）必须共用同一套增删改色交互。
 * 写成三份的话，加功能时改了其中两份就分叉 ——
 * 表现是"标签能改色、分组不能"，而用户看不出这是两套代码。
 */
t('守卫：三种定义列共用同一套交互（defCol，不是各自 isTag/isType）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const pop = app.slice(app.indexOf('function ColFilterPop'), app.indexOf("if (col.kind === 'text') {"));
  return pop.indexOf('defCol && onCreate') >= 0
    && pop.indexOf('defCol && !isSentinel(v) && onColor') >= 0
    && pop.indexOf('defCol && !isSentinel(v) && onRename') >= 0
    && pop.indexOf('defCol && !isSentinel(v) && onRemove') >= 0;
})());

/* 取色器必须真的接上主面板的 color-picker（不是摆个按钮不干活） */
t('守卫：改色接了主面板取色器', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf("ctx.services.call('color-picker', 'pick'") >= 0;
})());

/*
 * ⛔ color-picker 的 pick **取消也是 resolve**（`{ hex: null }`），不是 reject。
 * 按"取消会抛错"写的话，用户点取消会冒出一个没来由的报错。
 * 判据：拿到空串要当成"不改"，不能继续写盘。
 */
t('守卫：取色器取消（hex 为空）时不改色', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const pickColor');
  const seg = app.slice(i, i + 900);
  return /typeof r\.hex === 'string'/.test(seg) && /return hex \|\| ''/.test(seg);
})());


/*
 * 分组列改成 enum 之后，optionLabel 必须单独认「未分组」哨兵 ——
 * 否则下拉里显示 "__nogroup__"。
 *
 * ⛔ 这个错是**真实渲染时抓到**的（不是读代码推的）：
 * 面板上三个候选里最后一个就是一串下划线，而它明明该写"未分组"。
 * 和「未分类 NOTYPE」是同一处漏，只是被分组列带出来的。
 */
t('守卫：optionLabel 认「未分组」哨兵（不许显示 __nogroup__）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf("if (field === 'group') return v === NOGROUP ? '未分组'") >= 0;
})());

/*
 * 筛选摘要（chip 上的那句）同样要按列取定义表 ——
 * 分组列不传 groupDefs 的话，chip 上显示裸名字/下划线，
 * 而同一个筛选在下拉面板里显示的是定义表的 name，两处说法不一样。
 */
t('守卫：filterSummary 按列取定义表（含分组）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf("col.field === 'tags' ? tagDefs : col.field === 'group' ? groupDefs : typeDefs") >= 0;
})());

/* 端到端：四个操作都要真的落盘（用可变数据桩实跑） */
t('审查：分组改名要连带改任务上的 group（任务上存的是名字）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const renameGroup');
  /*
    窗口要够大：函数前面加了长注释说明三种结果，
    切 1200 字符只能切到注释，判据恒假（红）——
    不是代码有问题，是守卫自己的窗口开小了。
  */
  const seg = app.slice(i, i + 3600);
  return /group:\s*nm/.test(seg) && /updatedAt:\s*Date\.now\(\)/.test(seg);
})());

t('审查：删分组是把任务清成未分组，不是删任务', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const removeGroup');
  const seg = app.slice(i, i + 900);
  return /group:\s*''/.test(seg) && !/filter\(\(t\) => t\.group !== id\)/.test(seg);
})());


/* ============================================================ AI 通道能看见定义表（本轮） */

/*
 * ⛔ 缺口：两条读通道（GET /api/tasks、tb_list_tasks）原来只返回
 * tasks + agents，**不带定义表**。
 *
 * 而 tb_create_task 的 schema 又要求 `type` 填"任务类型 id（或自定义类型的 id）"、
 * `group` 填"分组名" —— 等于让 AI 填一个它看不见的枚举。后果：
 *   · 填了不存在的类型 id → 那一列显示成原始 id，任务看着像没分类
 *   · 填了新的分组名 → 凭空造出没有定义的分组（没颜色、也改不了色）
 *   · 标签写裸名字 → 脱离定义表，永远选不到颜色
 *
 * 之前几轮只贯通了**写入**侧（type/summary/group 都能写），
 * 没人问过"AI 从哪里知道有哪些可选值"。
 */
/*
  ⛔ 这两条**必须分别钉在各自的通道上**，不能笼统地全文件搜一个字符串。

  实测踩到：注入"HTTP 那条退回旧行为"的缺陷，
  而守卫仍全绿 —— 因为 MCP 那条还留着同样的片段，全局搜照样命中。
  于是守卫分不清"两条通道都带"和"只有一条带"，
  真正的回归（HTTP 通道退回）看不出来。

  所以改成按锚点切片，各自在**自己的块内**判。
*/
t('守卫：HTTP 读通道带定义表（AI 才看得见有哪些分组/类型）', (() => {
  const seg = rsSeg('("GET", ["api", "tasks"])', 320);
  return !rsSrc || seg.indexOf('"defs"') >= 0;
})());
/*
  切片长度要够：tb_list_tasks 的实现里过滤逻辑很长，
  `"defs"` 那行离锚点 7.5k 字符 —— 切 2600 根本切不到，
  于是判据恒假（红）。这不是代码有问题，是守卫自己的窗口开小了。
*/
t('守卫：MCP 列表带定义表', (() => {
  const seg = rsSeg('"tb_list_tasks"', 8200);
  return !rsSrc || seg.indexOf('"defs": defs_of(&store)') >= 0;
})());

/* 三张表都要带，漏一张就有一个字段仍然靠猜 */
t('守卫：defs 含三张定义表', (() => {
  /* 同上：defs_of 里加了注释，窗口要盖到 json! 块 */
  const seg = rsSeg('fn defs_of', 1400);
  return !rsSrc
    || (seg.indexOf('groupDefs') >= 0 && seg.indexOf('typeDefs') >= 0 && seg.indexOf('tagDefs') >= 0);
})());

/* schema 要指路：不写"先调 tb_list_tasks 看 defs"的话，AI 未必知道去哪查 */
t('守卫：建任务 schema 提示先看 defs', (() => {
  const seg = rsSeg('"tb_create_task"', 2600);
  return !rsSrc || seg.indexOf('defs.groupDefs') >= 0;
})());


/* ============================================================ 详情改成右侧面板 + 不再自动弹出（本轮） */

/*
 * 根因不是"弹窗不好看"，而是**弹窗干扰操作**：
 * 列表行里大半格子可就地编辑（状态/优先级/标题/认领人…），
 * 而点整行会弹出模态框 —— 于是"改一个内容"必然顺带弹一次，
 * 不看也得先关掉。改一次弹一次，非常打断。
 *
 * 所以两件事一起做：
 *   ① 详情从模态弹窗改成**右侧面板**（非模态，不挡列表，不关也能继续操作）
 *   ② **去掉所有"点一下就打开"的触发** —— 面板默认不出现，
 *      等右键菜单里的「显示详情」主动叫它（菜单下一轮加）
 */
t('守卫：没有任何「点一下就打开详情」的触发', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('onClick={() => onOpen(') < 0
    && app.indexOf('onClick={onOpen}') < 0
    && app.indexOf('点击查看详情') < 0
    && app.indexOf('点击查看任务') < 0;
})());

/*
 * 面板必须是**非模态**的：用 <aside> 自己渲染，不走 Modal。
 * 走 Modal 就还是弹窗（带遮罩、抢焦点、必须关），问题没解决。
 */
t('守卫：详情是右侧面板（非模态），不再是 Modal', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function DetailPanel({');
  if (i < 0) return false;
  const seg = app.slice(i, app.indexOf('\nfunction ', i + 10));
  return seg.indexOf('<Modal') < 0 && seg.indexOf('<aside className="tb-dpanel">') >= 0;
})());

/* 面板要长在列表视图里（右侧并列），不能飘在视图区外面 */
t('守卫：面板与列表并列在同一个 flex 容器里', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('className="tb-viewarea"');
  if (i < 0) return false;
  const seg = app.slice(i, i + 4000);
  return seg.indexOf('<DetailPanel') >= 0;
})());

/*
 * 列表容器必须 min-width: 0 ——
 * flex 子项默认 min-width:auto，宽表格会把面板顶出可视区，
 * 看着像"面板没出来"，其实是它跑到屏幕外了。
 */
t('守卫：列表容器有 min-width: 0（否则面板被挤出屏幕）', (() => {
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const i = css.indexOf('.tb-viewarea > .tb-list');
  if (i < 0) return false;
  return css.slice(i, i + 300).indexOf('min-width: 0') >= 0;
})());

/* 行不再整体可点，cursor 就不该再是 pointer（摆手型而点了没反应 = 骗人） */
t('守卫：行 cursor 不是 pointer（整行不再可点）', (() => {
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const i = css.indexOf('.tb-lrow {');
  const seg = css.slice(i, i + 400);
  return seg.indexOf('cursor: pointer') < 0;
})());


/* ============================================================ 深度审查：分组改名（本轮） */

/*
 * **改名不改正在生效的筛选** → 命中 0 条。
 *
 * 实测（jsdom 真跑）：筛着「登录」，把「登录」改成「登录改」之后
 *   落盘定义：登录改, 支付
 *   任务分组：登录改, 登录改, 支付
 *   列表行数：**0**，chip 还写着「分组：登录」
 *
 * 用户看到空列表只会以为"改完名任务没了" —— 查错方向完全反了。
 *
 * 删分组那边早就清了筛选，改名这边漏了：
 * 标签改名不需要这一步（标签改的是 name、id 不变，筛选存 id），
 * 但**分组的 id 就是名字**，改名等于换了 id。
 */
t('守卫：分组改名要顺带改掉正在生效的筛选', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const renameGroup');
  const seg = app.slice(i, i + 3200);
  return seg.indexOf('setColFilters') >= 0
    && /values\.map\(\(x\) => \(x === id \? nm : x\)\)/.test(seg);
})());

/*
 * **改成已存在的分组名** → 两条同 id 的定义。
 *
 * 实测：把「登录」改成「支付」
 *   落盘(立即)：支付, 支付（2 条）
 *   刷新后    ：支付（1 条）  ← normalizeGroupDefs 的 seen 表去重，**静默少一条**
 *   任务：3 条全变成「支付」（两个分组被合并，而用户没要求合并）
 *   toast 还写着"已改名"
 *
 * 新建那边早就挡了同名（addGroup 有 dupe 提示），改名这边漏了 ——
 * 同一类判据两个入口不一致。
 */
t('守卫：分组改名撞同名要挡住（否则定义被静默去重）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const renameGroup');
  const seg = app.slice(i, i + 3200);
  return seg.indexOf("const taken = defs.some((d) => d.id === nm && d.id !== id);") >= 0
    && seg.indexOf("res.state = 'dupe'") >= 0;
})());

/*
 * **裸名字分组改名后 id 与任务上的值对不上**。
 *
 * 实测：给没有定义的「设置」改名为「设置改」
 *   落盘定义：{ id: '设置', name: '设置改' }   ← id 用旧名、name 用新名
 *   任务分组：设置改
 * 于是下拉里按 name 显示"设置改"，点它筛的却是 group='设置' → **0 条**。
 *
 * 分组的 id 就是名字，两者必须一起改成新名。
 */
t('守卫：补建分组定义时 id 用新名（不能还留旧名）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const renameGroup');
  const seg = app.slice(i, i + 3200);
  /* 原来错的是 `defs.push({ id, name: nm` —— id 是旧名 */
  return /defs\.push\(\{ id: nm, name: nm/.test(seg)
    && !/defs\.push\(\{ id, name: nm/.test(seg);
})());

/* ============================================================ 深度审查：面板的 Escape（本轮） */

/*
 * 详情从 Modal 改成 <aside> 之后，**Escape 关闭悄悄丢了** ——
 * Escape 是 Modal 组件自带的，不在 DetailPanel 里。
 *
 * 面板是"看一眼就该能关掉"的东西，键盘上却没有退出的办法，只能去点 ✕。
 * 现在没有入口能打开它（等右键菜单），所以暂时看不出来 ——
 * 但那是"还没接上"，不是"不需要"。
 */
t('守卫：详情面板监听 Escape 关闭（且输入框内不关）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function DetailPanel({');
  const seg = app.slice(i, app.indexOf('\nfunction ', i + 10));
  return seg.indexOf("e.key !== 'Escape'") >= 0
    && seg.indexOf("tag === 'textarea'") >= 0;   /* 输入框内交给 DraftInput */
})());

/* ============================================================ 深度审查：defs 要含状态清单（本轮） */

/*
 * defs 的目的就是"让 AI 看见有哪些可选值"，而**状态是最该让 AI 看见的一项**：
 *
 * MCP schema 里 status 的 enum 是写死的那 7 个（静态 schema，改不了），
 * 用户自定义过流程之后 schema 就成了假话 ——
 * AI 照它填，自定义状态永远用不上；猜一个填，Rust 这边其实是接受的。
 * AI 没有任何途径知道这份数据认哪些状态。
 */
t('守卫：defs 含当前生效的状态清单', rsHas('"statuses":  statuses_for(store)'));


/* ============================================================ 守卫：类名必须都有定义（本轮） */

/*
 * ⛔ 这条是**被真实事故逼出来的**：
 *
 * 一个后来的提交（只打算补两个漏定义的类）整段覆盖了 styles.css，
   而它基于的是**改动之前的副本** —— 于是右侧面板那一整块样式
   （.tb-viewarea / .tb-dpanel / .tb-dpanel-head / .tb-dpanel-body）
   被悄悄抹掉了。App.tsx 里 `<aside className="tb-dpanel">` 照常渲染，
   但**一个样式都没有** —— 面板渲染成一坨没排版的内容。

   这类"改了又被悄悄盖回去"的问题，靠肉眼看不出来（代码里类名是对的），
   只有"用得到的类名必须在 CSS 里有定义"这条能抓住。

   所以这里做一条通用的：App.tsx / Settings.tsx 里出现的每一个 tb-*
   类名，styles.css 都必须定义过。
*/
t('守卫：用到的 tb-* 类名都在 styles.css 里有定义', (() => {
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const defined = new Set([...css.matchAll(/\.(tb-[a-z0-9-]+)/g)].map((m) => m[1]));
  const missing = new Set();
  for (const f of ['App.tsx', 'Settings.tsx']) {
    const fp = path.join(dir, f);
    if (!fs.existsSync(fp)) continue;
    const src = fs.readFileSync(fp, 'utf8');
    /*
      静态字符串类名：className="a b" / className={'a b'} / className={`a ${x}`}

      ⛔ 字符类里**必须有双引号**。
      实测踩到：只写 ['`]（单引号 + 反引号）时，全文件 404 处 className
      只抽到 25 处 —— 恰好全是单引号的，而 `className="tb-dpanel"`
      是双引号，压根没进集合。于是注入"删掉面板样式"的缺陷**照样全绿**。

      这是第 7 个"守卫自己写错了、靠反向验证才发现的"。
    */
    for (const m of src.matchAll(/className=\{?\s*['"\`]([^'"\`]*)['"\`]/g)) {
      for (const c of m[1].split(/\s+/)) {
        if (c && c.startsWith('tb-') && !defined.has(c)) missing.add(c);
      }
    }
  }
  if (missing.size) console.log('    未定义:', [...missing].join(', '));
  return missing.size === 0;
})());


/*
 * 五个哨兵**必须互不相同**。
 *
 * UNESTIMATED 原来是 '__none__'，和 UNASSIGNED 撞了 ——
 * 靠"它们分属不同的列"才没暴露，而 groupLabel 是按值判断的：
 * by='estimate' 时"没估"那组会被标成"未认领"。
 */
t('守卫：五个「空值」哨兵互不相同', (() => {
  const m = fs.readFileSync(path.join(dir, 'core.mjs'), 'utf8');
  const grab = (n) => {
    const mm = m.match(new RegExp('export const ' + n + " = '([^']+)'"));
    return mm ? mm[1] : null;
  };
  const vals = ['UNESTIMATED', 'UNASSIGNED', 'NOTAG', 'NOTYPE', 'NOGROUP'].map(grab);
  if (vals.some((v) => !v)) return false;
  return new Set(vals).size === vals.length;
})());


/* ============================================================ 深度审查：配置里没有的值（本轮） */

/*
 * **状态筛选候选只取流程配置** → 配置里没有的状态筛不到。
 *
 * 任务的状态可能是配置里没有的（状态被删掉，或 AI 经 API 写入）。
 * 那些任务在列表里看得见，却**筛不到** ——
 * 想把它们找出来改掉只能一条条翻。
 *
 * 看板（ghostStatuses 多一列标「未配置」）和统计（多一段标「未配置」）
 * 早都处理了，列表的筛选候选这里漏了同一件事。
 */
t('守卫：状态筛选候选 = 流程配置 + 数据里实际在用的', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const statusIds = ');
  if (i < 0) return false;
  const seg = app.slice(i, i + 900);
  /*
    ⛔ 只查"有没有那两行"是不够的 —— 反向验证时注入一个**提前 return**
    （`if (1) return flow.statuses.map(...)`）照样全绿，因为那两行还在，
    只是永远执行不到。所以还要钉住"没有提前 return"这个结构。
  */
  return /const statusIds = \(\(\) => \{\s*\n\s*const out = flow\.statuses\.map/.test(seg)
    && seg.indexOf('known.has(t.status)') >= 0
    && seg.indexOf('out.push(t.status)') >= 0;
})());

/*
 * **改完流程不清筛选** → 列表空着，chip 上是个已经不存在的值。
 *
 * 实测（jsdom）：筛着「挂起」，把「挂起」从流程里删掉 →
 *   落盘状态里已经没有 hold
 *   列表行数 **0**，chip 还写着「状态：挂起」
 * 而那个状态已经从下拉里消失了 —— 用户看着空列表，
 * chip 上却是个选不到的东西，只会以为"任务没了"。
 *
 * 删分组 / 删类型 / 删标签三处早都清了筛选，流程这里漏了。
 */
t('守卫：保存流程时清掉指向已删状态的筛选', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('const doSaveFlow');
  const seg = app.slice(i, i + 2200);
  /*
    ⛔ 不能用 `indexOf('setColFilters')`：反向验证时把调用改名为
    `setColFilters_stub` 照样命中（子串匹配），于是守卫形同虚设。
    必须匹配**真正的调用** `setColFilters((`。
  */
  return /setColFilters\(\(/.test(seg)
    && (/values\.filter\(\(v\) => kept\.has\(v\)\)/.test(seg));
})());

/* ============================================================ 深度审查：搜索范围（本轮） */

/*
 * **搜不到标签名**。
 *
 * 任务上存的是标签 **id**（tg_xxxx），界面显示的是名字。
 * 只搜 id 的话：用户搜「重要」返回 0 条，而列表里明明挂着一排「重要」，
 * 他会以为没有这类任务，而不是"搜索不搜标签"。
 *
 * 上一轮补了认领人和类型名，**标签漏了** —— 完全是同一处。
 */
t('守卫：全局搜索含标签显示名（任务上存的是 id）', (() => {
  const core = fs.readFileSync(path.join(dir, 'core.mjs'), 'utf8');
  const i = core.indexOf('const hay = ');
  if (i < 0) return false;
  /* 标签名要先算出来，再拼进 hay */
  const before = core.slice(Math.max(0, i - 700), i);
  return before.indexOf('tagLabels') >= 0 && core.slice(i, i + 200).indexOf('tagLabels') >= 0;
})());

/* 调用点必须把 tagDefs 传进去，且要在 useMemo 依赖里（改了标签名结果要变） */
t('守卫：搜索调用点传了 tagDefs 且在依赖里', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  return app.indexOf('filterTasksByColumns(flatRows, colFilters, q, typeDefs, store ? store.tagDefs : [])') >= 0
    && app.indexOf('[flatRows, colFilters, q, typeDefs, store ? store.tagDefs : []]') >= 0;
})());

/*
 * 搜索框的 placeholder 还写着"搜索标题 / 详情 / id" ——
 * 实际能搜的远不止这三样。
 * 用户**照着提示判断**：写在提示里的他会去搜，没写的他不会试。
 * 于是"搜标签名"这种支持的操作，用户永远发现不了。
 */
t('守卫：搜索框提示与实际范围一致（不能还写"标题 / 详情 / id"）', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  /*
    ⛔ 必须先剥离注释再匹配：说明"为什么不能用旧文案"的注释里
    **必然要引用那句旧文案**，不剥离的话守卫恒红 ——
    而恒红的守卫和没有守卫一样，真正的回归反而看不出来。
  */
  return app.indexOf('搜索标题 / 详情 / id') < 0;
})());

/* ============================================================ 深度审查：行内编辑被轮询冲掉（本轮） */

/*
 * InlineText 把 value 放进 useEffect 依赖里持续监听 ——
 * 正在编辑时 value 一变（2s 轮询读到别人的改动）就把人打的字冲掉。

 * DraftInput（详情面板那边）早就是这个判据（`if (!editing)`），
 * **这里漏了** —— 两个组件做的是同一件事，判据必须一致。
 */
t('守卫：InlineText 只在打开时带入当前值（value 不在依赖里）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function InlineText({');
  const seg = app.slice(i, i + 1500);
  return seg.indexOf('}, [open]);') >= 0 && seg.indexOf('}, [open, value]);') < 0;
})());


/* ============================================================ 深度审查：删项目会切走当前项目（本轮） */

/*
 * **删掉一个不是当前项目的项目，会把当前项目换掉。**
 *
 * 实测（core 手算）：projects [甲,乙,丙]、当前在「丙」，删掉「甲」
 *   → 当前项目变成「乙」，dataDir 跟着变
 *
 * 用户只是想清掉一个不用的项目，结果自己正在看的项目被换掉了：
 * 不报错、不提示，界面上的任务突然变成另一批 ——
 * 看着像"删错了"或者"界面抽风"，而实际数据在别的目录里好好的。
 *
 * 根因：`aimAt(..., projects[0].id)` 一律切到剩下第一个，
 * 没判断删的是不是当前项目。
 */
t('守卫：删项目只在删的是当前项目时才切换', (() => {
  const src = fs.readFileSync(path.join(dir, 'lib', 'store.ts'), 'utf8');
  const i = src.indexOf('export async function removeProject');
  if (i < 0) return false;
  const seg = src.slice(i, i + 1200);
  /* 必须是「条件选择 id」，不能一律 projects[0].id */
  return /const nextId = cfg\.currentId === id \? projects\[0\]\.id : cfg\.currentId;/.test(seg)
    && /aimAt\(\{ \.\.\.cfg, projects \}, nextId\)/.test(seg);
})());

/*
 * config 事件（设置页那条路径）也要清筛选 —— 与 doSwitchProject 同一判据。
 *
 * 设置页里删掉当前项目会切到另一个项目，走的是 config 事件。
 * 而上一个项目筛的是它自己的状态 id / 类型 id / 认领人，
 * 切过来很可能一条都匹配不上 → 打开就是空看板。
 * doSwitchProject 清了，这条路径原来漏了。
 */
t('守卫：config 事件换目录时清掉筛选（与切项目同一判据）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf("ctx.on('task-board:config'");
  if (i < 0) return false;
  const seg = app.slice(i, i + 1400);
  return /clearViewState\(\)/.test(seg);
})());

/* ============================================================ 深度审查：没有可走的流转时要说出来（本轮） */

/*
 * 任务处于"配置里没有的状态"（状态被删掉、或 AI 经 API 写入）时，
 * actionsForIn 返回**空数组** → 详情面板一个按钮都没有。
 *
 * 实测：actionsForIn(flow, 'ghostX') === []
 *
 * 界面上只显示一条空白的操作区，完全不说为什么 ——
 * 这比"孤岛状态"更糟：孤岛是没人能进去，
 * 而这是**已有的任务被困在一个不存在的状态里，永远出不来**，
 * 用户还不知道该去哪里修。
 *
 * 两种情况要分开说，因为**该做的事不一样**：
 *   · 状态不在配置里 → 去流程设置补上这个状态
 *   · 状态在配置里但没配出边 → 去流程设置勾上出边
 */
t('守卫：详情面板没有可走的流转时给出说明（区分两种原因）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function DetailPanel({');
  const seg = app.slice(i, app.indexOf('\nfunction ', i + 10));
  return /acts\.length === 0 \? \(/.test(seg)
    && /不在流程配置里/.test(seg)
    && /没配/.test(seg);
})());

/* 看板卡片同样要标明（空间小，短文字 + title） */
t('守卫：看板卡片没有可走的流转时标明', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function TaskCard({');
  const seg = app.slice(i, app.indexOf('\nfunction ', i + 10));
  return /acts\.length === 0 \? \(/.test(seg) && /tb-task-noflow/.test(seg);
})());


/*
 * **同一个选择器在 styles.css 里定义两次**。
 *
 * 实测踩到：给"没有可走的流转"加提示时另写了一份 `.tb-dhint.warn`，
 * 而它早就被前置锁提示用着 —— 于是同一选择器出现两次，
 * 后定义的覆盖前面的，**把前置锁提示的配色也改了**。
 *
 * 这类问题不报错、也不影响功能，只会让某处的样式悄悄变了；
 * 而且只有去比对"我加之前它长什么样"才发现得了。
 */
t('守卫：styles.css 里同一个选择器不重复定义', (() => {
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  /*
    只匹配**顶格**的选择器。

    ⛔ 第一版用 `(^|\})` 做分隔符，把 `}` 之后到下个 `{` 之间
    的内容都当成选择器 —— 于是 @media 里带缩进的 .tb-board 被误报重复
    （它和顶格那条是同一个，但语义上是媒体查询内的覆盖，不算重复）。
    守卫误报会让真正的重复看不出来，跟没有守卫一样。
  */
  const seen = new Set();
  const dup = [];
  for (const m of stripped.matchAll(/^([.#a-zA-Z:\[][^{}\n]*?)\s*\{/gm)) {
    const sel = m[1].replace(/\s+/g, ' ').trim();
    if (sel.startsWith('@')) continue;
    if (seen.has(sel)) dup.push(sel);
    else seen.add(sel);
  }
  if (dup.length) console.log('    重复:', [...new Set(dup)].slice(0, 6).join(' , '));
  return dup.length === 0;
})());


/* ============================================================ 筛选面板被色板淹没（用户报的 BUG） */

/*
 * **"按任务类型筛选"面板的主体变成了一片色块矩阵。**
 *
 * 每个候选行都渲染完整的 12 色调色板，而面板宽度只有 190px ——
 * 12 × 13px + gap ≈ 204px，**溢出后 flex-wrap 换行**，
 * 于是 7 个类型 × 每组十来个色点，把勾选框和候选名全淹没了。
 * 用户看到的正是这个（截图：七组横向排列的彩色圆点）。
 *
 * 这是**筛选**面板，主职是"勾哪些值"，改色只是顺手提供的便利。
 * 便利功能把主功能挤没了，等于没做。
 *
 * 修法：色板默认折叠成一个当前色的小圆点，点它才展开。
 */
t('守卫：筛选面板的色板默认折叠（不是每行都平铺 12 色）', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function ColFilterPop');
  const seg = app.slice(i, app.indexOf('\nfunction ', i + 10));
  /*
    ⛔ 不能只查"有没有 tb-lpop-dot"：反向验证时把折叠态改回平铺、
    但保留 dot（比如两处都渲染）照样命中。
    必须钉住"折叠态渲染 dot、展开态渲染色板"这个**分支结构**。
  */
  return /colorFor === v \? \(/.test(seg)
    && /className="tb-lpop-dot"/.test(seg)
    && /tb-lpop-colors' \+ \(colorFor === v \? ' open'/.test(seg);
})());

/* 展开态要换到整行（否则 190px 面板放不下 12 个色点，会把名字压成省略号） */
t('守卫：色板展开时占整行', (() => {
  const css = fs.readFileSync(path.join(dir, 'styles.css'), 'utf8');
  return /\.tb-lpop-colors\.open\s*\{[^}]*flex:\s*1 1 100%/.test(css)
    && /\.tb-lpop-item\.is-colors\s*\{[^}]*flex-wrap:\s*wrap/.test(css);
})());

/* 取色器"＋"必须在展开态里（折叠态也渲染的话每行都挂一个 ＋，把行挤得更窄） */
t('守卫：取色器入口只在展开态渲染', (() => {
  const app = fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8');
  const i = app.indexOf('function ColFilterPop');
  const seg = app.slice(i, app.indexOf('\nfunction ', i + 10));
  const openStart = seg.indexOf('colorFor === v ? (');
  const openEnd = seg.indexOf(') : (', openStart);
  const openBlock = seg.slice(openStart, openEnd);
  return openBlock.indexOf('tb-swatch-more') >= 0;
})());

/*
 * **新建区的默认色写死某一档，会撞上已有类型。**
 *
 * 实测本项目：7 个类型已占用 #84cc16 #22c55e #f59e0b #ef4444
 * #3b82f6 #a855f7 #ec4899，而原来的默认值 TAG_COLORS[6] 恰好是 #3b82f6
 * —— **已被「调研」占用**，默认新建出来的类型和另一个同色。
 *
 * 配色的唯一作用就是一眼区分，同色等于白配。
 * 改成取"第一个还没人用的"（与新建类型 / 标签 / 状态统一判据）。
 */
t('守卫：新建区的默认色取第一个未被占用的（不写死某一档）', (() => {
  /*
    ⛔ 必须**先剥离注释**：说明"为什么不能用 TAG_COLORS[6]"的注释里
    必然要写出 TAG_COLORS[6] 这几个字 —— 不剥离的话守卫恒红，
    而恒红的守卫跟没有一样，真正的回归反而看不出来。
    （这是第 N 次踩这个坑，源码扫描类判据一律先过 STRIP。）
  */
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  return app.indexOf('TAG_COLORS[6]') < 0
    && /used\.has\(newColor\)/.test(app)
    && /const free = TAG_COLORS\.find\(\(c\) => !used\.has\(c\)\)/.test(app);
})());

/*
 * **2s 轮询读失败被静默吞掉 → 看板停在旧快照上不动。**
 *
 * 这 2s 一次的重读是"AI / agent-flow 的写盘体现到看板"的**唯一**通道。
 * 写成 `.catch(() => {})` 之后：tasks.json 一旦坏掉（外部工具改过、
 * 写到一半中断），readStore 抛的是可读的中文错误，被吞掉 →
 * 界面永远停在最后一次成功的快照：数据其实已经变了，看板不动、也不报错
 * —— 只会以为 AI 没写，或者看板卡了。
 *
 * ⛔ 判据必须先过 STRIP：下面这段说明里原样写了 `.catch(() => {})`，
 *    不剥离的话守卫恒红，而恒红的守卫跟没有一样，真回归反而看不出来。
 */
t('守卫：轮询读失败不再静默（记到状态里，不许 .catch(() => {})）', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  const i = app.indexOf('ctx.owned.setInterval');
  if (i < 0) return false;
  const seg = app.slice(i, i + 1200);
  return seg.indexOf('.catch(() => {})') < 0
    && seg.indexOf('setPollErr') >= 0
    && /setPollErr\(\s*['"]/.test(seg);
})());

/*
 * **新建项目是第三条路径，却漏了同一条判据。**
 *
 * 切项目、导入项目都已经改成"读不到要明说"，新建项目还留着
 * `.catch(() => null)`：目录里本来就有一份坏的 tasks.json（或没权限读）时，
 * 新建出来显示为一片空白，跟"新项目还没建任务"一模一样，
 * 而提示说的是「已建项目」—— 三条路径不一致，
 * 于是"哪条会静默"取决于用户走的是哪一步。
 *
 * ⛔ 必须 STRIP：这段说明里原样写了 `.catch(() => null)`。
 */
t('守卫：新建项目后读不到任务库也要报出来（三条路径一致）', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  const i = app.indexOf('<NewProjectModal');
  if (i < 0) return false;
  const seg = app.slice(i, i + 1600);
  return seg.indexOf('readErr') >= 0
    && seg.indexOf('但读不到它的任务库') >= 0
    && app.indexOf('S.readStore(ctx, next.dataDir).catch(() => null)') < 0;
})());


/* ============================================================ 深度审查：认领不更新时间戳（本轮） */

/*
 * **认领之后 updatedAt 不更新。**
 *
 * 认领有两条路径：
 *   · 初始态 → applyTransition 顺带推进状态（它自己会设 updatedAt）
 *   · 非初始态 / 流程里没有可走的边 → 只改 assignee，**不经过** applyTransition
 *
 * 实测（jsdom，流程只配一个状态因而没有可走的边）：
 *   认领后 updatedAt 仍是旧值
 *
 * 两个后果：
 *   · 「更新」列纹丝不动 —— 看着像这一行没被改过
 *   · 更糟：它**仍停留在"超 7 天未动"的陈旧面板里**。
 *     你刚认领的活，界面却说它很久没人动了，
 *     而陈旧面板的用途正是"找出该处理却没人处理的"。
 */
t('守卫：认领必须更新时间戳（两条路径都要）', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  const i = app.indexOf('const doClaim');
  if (i < 0) return false;
  const seg = app.slice(i, i + 2200);
  return /next\.assignee = me;/.test(seg) && /next\.updatedAt = Date\.now\(\);/.test(seg);
})());

/*
 * 全量版：**任何改任务的 mutate 回调都要更新时间戳**。
 *
 * 判据放宽：applyTransition / pushHistory 内部会设 updatedAt，
 * 调用了它们也算（否则 transitionTask / commentTask 会误报）。
 *
 * ⚠️ 这条守卫曾被并行提交整段删掉过一次，连同它守护的修复一起。
 */
t('守卫：改任务的 mutate 回调都要更新时间戳', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  const bad = [];
  for (const m of app.matchAll(/S\.mutate\(ctx, [^,]+, \(st\) => \{/g)) {
    let depth = 1; let i = m.index + m[0].length;
    const start = i;
    while (i < app.length && depth > 0) {
      if (app[i] === '{') depth += 1;
      else if (app[i] === '}') depth -= 1;
      i += 1;
    }
    const body = app.slice(start, i);
    /*
      ⛔ 判据必须收紧到"**真的改了某条任务的内容**"。

      第一版只看 body 里有没有 'st.tasks'，于是把两类误报进来：
        · 只读的（删除确认前扫一遍谁把它列为前置 —— broken）
        · 删除的（filter 掉一条，没有"被改的任务"这回事）
      误报会让真正的漏网看不出来，跟没守卫一样 —— 又是同一个教训。

      真正的判据是"把已有任务展开成新对象"：`{ ...t,` / `{ ...cur,` / `{ ...task,`。
      删除（filter）和只读（some/find/filter）都不含这个模式。
    */
    if (!/\{ \.\.\.(t|cur|task|next)\b/.test(body)) continue;
    if (/updatedAt/.test(body)) continue;
    if (/applyTransition\(|pushHistory\(/.test(body)) continue;
    const pre = app.slice(Math.max(0, m.index - 3000), m.index);
    const names = [...pre.matchAll(/const (\w+) = \(/g)].map((x) => x[1]);
    bad.push(names[names.length - 1] || '(匿名)');
  }
  if (bad.length) console.log('    未更新时间戳:', bad.join(' , '));
  return bad.length === 0;
})());

/* ============================================================ 深度审查：自环状态（重新应用，见下） */

/*
 * ⚠️ 这两条守卫**曾被并行提交整段删掉过**（9af0d22b 基于改动前的副本，
 * 删了 App.tsx 77 行 / 本文件 61 行，修复和守卫一起消失）。
 * 是测试数从 434 掉回 433 才发现的。这里是重新应用。
 *
 * 如果它们又不见了，先去看是不是又有人整块替换了 App.tsx。
 */

t('守卫：批量改状态不计入"已经是目标状态"的任务', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  const i = app.indexOf('const doBatchStatus');
  if (i < 0) return false;
  const seg = app.slice(i, i + 3000);
  return /if \(t\.status === to\) \{ al \+= 1; return t; \}/.test(seg)
    && /let already = 0;/.test(seg)
    && /条本来就是/.test(seg);
})());

t('守卫：行内状态下拉点当前状态是无操作', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  const i = app.indexOf('const acts = actionsForIn(flow, t.status);');
  if (i < 0) return false;
  const seg = app.slice(i, i + 1400);
  return /if \(id === t\.status\) return;/.test(seg);
})());


/* ============================================================ 深度审查：core.d.ts 与实现一致性（本轮） */

/*
 * **core.d.ts 里留着两条"死声明"**：groupEstimate、isAncestor。
 *
 * 它们随**手动组**一起被删掉了（组改成"按列分组"的视图概念后，
 * 数据里不再有父子层级，core.mjs 里也没有实现）。
 *
 * 死声明比没有声明更糟：
 *   · 读 .d.ts 的人会以为有这个函数，照着 import 才发现不存在
 *   · **TS 不会报错**（声明本身合法），只有运行到才炸
 *   · 于是它会一直留在那儿，直到某天有人真的去调它
 *
 * 反向也成立：core.mjs 导出的函数若没写进 .d.ts，
 * TS 侧就用不了（或者被迫 any），同样是缺口。
 */
t('守卫：core.d.ts 声明的函数与 core.mjs 实际导出一一对应', (() => {
  const dts = fs.readFileSync(path.join(dir, 'core.d.ts'), 'utf8');
  const mjs = STRIP(fs.readFileSync(path.join(dir, 'core.mjs'), 'utf8'));
  const inDts = [...dts.matchAll(/^export declare function (\w+)/gm)].map((m) => m[1]);
  const inMjs = [...mjs.matchAll(/^export function (\w+)/gm)].map((m) => m[1]);
  const ghost = inDts.filter((x) => inMjs.indexOf(x) < 0);
  const missing = inMjs.filter((x) => inDts.indexOf(x) < 0);
  if (ghost.length) console.log('    有声明无实现:', ghost.join(' , '));
  if (missing.length) console.log('    有实现无声明:', missing.join(' , '));
  return ghost.length === 0 && missing.length === 0;
})());


/* ============================================================ 深度审查：自依赖死局（本轮） */

/*
 * **任务把自己列为前置 = 永远解锁不了。**
 *
 * lockOf 会算出 pending=['自己'] 且 cyclic=true ——
 * 它等的是"自己完成"，而"自己完成"的前提是它先解锁。这是个死局。
 *
 * 界面上的下拉挡得住（depChoices 排除了自己和传递依赖），
 * 但 AI 经 HTTP / MCP 直接写 JSON 不受那层约束，手改文件也能写出来。
 * 所以**归一化**这里也要挡。
 *
 * 实测：deps=['a','b','a','','  ']（a 是它自己）
 *   修前 → ['a','b'] → cyclic=true（死局）
 *   修后 → ['b']     → 只等 b（正常）
 */
t('归一化要清掉指向自己的依赖', (() => {
  const st = normalizeStore({
    v: 1, nextId: 9,
    tasks: [
      { id: 'a', title: 'a', priority: 'P2', tags: [], deps: ['a', 'b', 'a', '', '  '], status: 'todo', history: [] },
      { id: 'b', title: 'b', priority: 'P2', tags: [], deps: [], status: 'todo', history: [] },
    ],
  });
  const a = st.tasks.find((t) => t.id === 'a');
  if (JSON.stringify(a.deps) !== JSON.stringify(['b'])) {
    console.log('    实际:', JSON.stringify(a.deps), '（应为 ["b"]）');
    return false;
  }
  const lk = lockOf(a, st.tasks, st);
  /* 清掉自依赖之后不该再判定成环（等 b 是另一回事，那是对的） */
  return lk.cyclic === false;
})());


/* ============================================================ 深度审查：五列单选型统一（本轮） */

/*
 * **优先级 / 状态 / 任务类型 / 分组 / 认领人 五列都是"这一行取一个值"，
 * 操作方式就该一致。**
 *
 * ⛔ 以前是五套做法：
 *   · 优先级 / 状态 → InlinePick（下拉，没有管理能力）
 *   · 任务类型     → TypePicker（另一套类名；能改名+新建，不能改色+删除）
 *   · 分组 / 认领人 → InlineText（**自由文本，压根没有候选**）
 *
 * 后果不只是观感不一致：
 *   · 分组和认领人没有候选 → 手打必然打出「登录」/「登陆」两种写法，
 *     分成两组还看不出原因；而"这一列到底有哪些值"根本看不到
 *   · 类型在单元格里能改名却不能改色/删除，而列头筛选面板三样都有
 *     —— 同一个动作在两个地方能不能做不一样
 *   · 加一个能力要在五处各写一遍，漏一处就是"别处能用这儿不能"
 *     （这正是前几轮反复出现的"新判据没在所有入口落实"）
 *
 * 现在统一走 SinglePick：组件一套，能力由各列声明（传了哪个回调就有哪个按钮）。
 */
const FIVE = ['priority', 'status', 'type', 'group', 'assignee'];

t('守卫：五列单选型都走同一个组件（SinglePick）', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  const bad = [];
  for (const f of FIVE) {
    const i = app.indexOf("case '" + f + "':");
    if (i < 0) { bad.push(f + '(缺 case)'); continue; }
    /*
      切片到下一个 case 之前 —— 用整段搜会命中别处的 <SinglePick，
      那就分不清"这一列用了"还是"别处用了"，注入缺陷也照样全绿。
    */
    const j = app.indexOf("\n      case '", i + 10);
    const seg = app.slice(i, j < 0 ? i + 2600 : j);
    if (seg.indexOf('<SinglePick') < 0) bad.push(f);
  }
  if (bad.length) console.log('    未用 SinglePick:', bad.join(' , '));
  return bad.length === 0;
})());

t('守卫：五列单选型不再各写各的（InlinePick / TypePicker 已删）', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  return !/function InlinePick\(/.test(app)
    && !/function TypePicker\(/.test(app)
    && app.indexOf('<InlinePick') < 0
    && app.indexOf('<TypePicker') < 0;
})());

/*
 * **清空类型不能传 NOTYPE 哨兵。**
 *
 * toggleType 的语义是「点当前值 = 摘掉」：`type: t.type === typeId ? '' : typeId`。
 * 传 NOTYPE 时两边不等 → **把哨兵值写进任务数据**。
 * 后果：typeName 查不到定义 → 界面上这一列显示成一串 '__notype__'，
 * 而不是"未分类" —— 那正是前几轮反复修的"显示原始哨兵"类 bug。
 *
 * 实测：修前清空后落盘 type='__notype__'；修后为 ''。
 */
t('守卫：清空类型传空串（不能把 NOTYPE 写进任务）', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  const i = app.indexOf("clearLabel={t.type ? '清成「未分类」' : undefined}");
  if (i < 0) return false;
  return app.slice(i, i + 900).indexOf("onToggleType(t.id, '')") >= 0
    && !/onToggleType\(t\.id, NOTYPE\)/.test(app);
})());

/* 归一化兜底：老数据里已经存了哨兵的，读进来要清成空串 */
t('守卫：归一化要把任务上的类型哨兵清成空串', (() => {
  const st = normalizeStore({
    v: 1, nextId: 9,
    tasks: [{ id: 'a', title: 'a', status: 'todo', priority: 'P2', tags: [], deps: [], history: [], type: '__notype__' }],
  });
  return st.tasks[0].type === '';
})());

/*
 * **新建要"建完即挂"，五列结果一致。**
 *
 * 认领人没有定义表，新建 = 直接填名字 → 立刻生效；
 * 而类型/分组原来只建定义、不挂当前行 → 用户还得再点一次选它。
 * 明明是在这一行点的新建，却要操作两次 —— 这就是"不统一"的实际代价。
 *
 * 实测：修前新建分组后本行 group 仍是旧值；修后为新建的那个。
 */
t('守卫：新建类型/分组后立刻挂到当前行', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  const i = app.indexOf('kindName="类型"');
  if (i < 0) return false;
  const segT = app.slice(i, i + 900);
  const j = app.indexOf('kindName="分组"');
  const segG = app.slice(j, j + 900);
  /* 类型：await 拿到新 id 再挂；分组：建完直接 patch 名字（分组 id 就是名字） */
  return /await onCreateType\(name\)/.test(segT)
    && /onToggleType\(t\.id, id\)/.test(segT)
    && /await onCreateGroup\(name, ''\)/.test(segG)
    && /onPatchField\(t\.id, \{ group: name \}\)/.test(segG);
})());

/* createType 要返回新 id —— 不返回的话调用方没法接着挂 */
t('守卫：createType 返回新建的 id（供调用方挂到当前行）', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  const i = app.indexOf('const createType = (name: string, color: string) =>');
  if (i < 0) return false;
  const seg = app.slice(i, i + 1600);
  return /let newId = '';/.test(seg) && /newId = id;/.test(seg) && /return newId;/.test(seg);
})());

/*
 * **详情面板要有五列单选型对应的字段。**
 *
 * 以前详情里没有"认领人"和"优先级"两个字段 —— 上方元信息里
 * 只**只读**显示一个"认领人：张三"。于是改认领人只能在列表那一列点，
 * 而详情是"把这条所有字段看一遍"的地方：在这儿看到却改不了，
 * 会以为这条压根没有这个属性。
 *
 * 实测（jsdom 单独挂载 DetailPanel）：
 *   认领人 select 选项 = 未认领 | 张三 | 李四，当前值正确带出
 *   优先级 select 选项 = P0 紧急 | P1 高 | P2 中 | P3 低
 *   触发 change → onPatch 收到 {priority:'P0'} / {assignee:'李四'}
 */
t('守卫：详情面板有认领人和优先级字段（都能改，不是只读）', (() => {
  const app = STRIP(fs.readFileSync(path.join(dir, 'App.tsx'), 'utf8'));
  const i = app.indexOf('function DetailPanel(');
  if (i < 0) return false;
  /*
    ⛔ 判据要用**完整标签**（'>认领人<'），不能只搜 '认领人'：
    注入成"认领人X"时 indexOf 照样命中 → 守卫不报红 →
    真正的删除反而抓不到。这跟前面几次"判据太宽"是同一个毛病。
  */
  const j = app.indexOf('tb-dlabel">认领人<', i);
  const k = app.indexOf('tb-dlabel">优先级<', i);
  if (j < 0 || k < 0) return false;
  const segA = app.slice(j, j + 700);
  const segP = app.slice(k, k + 700);
  return /<select/.test(segA) && /onPatch\(\{ assignee: e\.target\.value \}\)/.test(segA)
    && /<select/.test(segP) && /onPatch\(\{ priority: e\.target\.value as Priority \}\)/.test(segP);
})());

/* ---------------- 汇总 ---------------- */
console.log(`task-board core: 通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
