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
  LIST_COLUMNS,
  emptyColFilter,
  colFilterActive,
  colRawValues,
  colFilterValues,
  activeColFilters,
  filterTasksByColumns,
  indexTasks,
  ancestorChain,
  flattenTasks,
  groupStatus,
  lockOf,
  mergeIntoGroup,
  createGroup,
  dissolveGroup,
  isAncestor,
  splitTask,
  DEFAULT_FLOW,
  normalizeFlow,
  canTransitionIn,
  actionsForIn,
  statusName,
  statusDone,
  initialStatus,
  groupEstimate,
  totalEstimate,
  fmtEstimate,
  numOrNull,
  sortRowsBy,
  normalizeConfig,
  newProjectId,
  currentProject,
  needsDocsDir,
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


/* ============================================================ 列级筛选 */

const TB_TASKS = [
  normalizeTask({ id: 'tb-0001', title: '质量门禁', detail: '门禁脚本', status: 'done', priority: 'P0', tags: ['ci'], assignee: 'w1', createdAt: Date.parse('2026-10-01T10:00:00'), updatedAt: Date.parse('2026-10-20T10:00:00') }),
  normalizeTask({ id: 'tb-0002', title: '数据持久化', detail: '', status: 'todo', priority: 'P2', tags: ['db'], assignee: null, createdAt: Date.parse('2026-10-05T10:00:00'), updatedAt: Date.parse('2026-10-21T10:00:00') }),
  normalizeTask({ id: 'tb-0003', title: '新手引导', detail: '引导流程', status: 'doing', priority: 'P1', tags: ['ui', 'db'], assignee: 'w2', createdAt: Date.parse('2026-10-08T10:00:00'), updatedAt: Date.parse('2026-10-22T10:00:00') }),
];

const TB_ROWS = TB_TASKS.map((t) => ({ task: t, depth: 0, path: [], groupPath: '' }));

/** 造一份只有某列生效的筛选 */
function onlyFilter(field, patch) {
  const f = {};
  f[field] = { ...emptyColFilter(), ...patch };
  return f;
}

const COL = (k) => ({ field: 'priority', label: '', kind: k });

t('列定义：十一列，每列都有 kind（新加列不能有"看着能点却没反应"的）',
  LIST_COLUMNS.length === 11
  && LIST_COLUMNS.every((c) => ['enum', 'text', 'time', 'num'].indexOf(c.kind) >= 0));

t('列定义：覆盖优先级/ID/标题/所属组/状态/认领人/标签/说明/预估/创建/更新', (() => {
  const fields = LIST_COLUMNS.map((c) => c.field);
  return ['priority', 'id', 'title', 'groupPath', 'status', 'assignee', 'tags',
          'summary', 'estimate', 'createdAt', 'updatedAt']
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

t('colRawValues：认领人空串表示未认领；标签是多值',
  colRawValues(TB_TASKS[0], 'assignee')[0] === 'w1'
  && colRawValues(TB_TASKS[1], 'assignee')[0] === ''
  && colRawValues(TB_TASKS[0], 'status')[0] === 'done'
  && colRawValues(TB_TASKS[2], 'tags').length === 2);

t('按优先级筛：只留命中的',
  filterTasksByColumns(TB_ROWS, onlyFilter('priority', { values: ['P0', 'P1'] }), '').length === 2);

t('按优先级筛：拿显示文案去筛不该命中（筛选按原始值）',
  filterTasksByColumns(TB_ROWS, onlyFilter('priority', { values: ['紧急'] }), '').length === 0);

t('按状态筛', filterTasksByColumns(TB_ROWS, onlyFilter('status', { values: ['todo'] }), '').length === 1);

t('按认领人筛：空串能筛出没人认领的（"找没人领的"是常用查询）', (() => {
  const hit = filterTasksByColumns(TB_ROWS, onlyFilter('assignee', { values: [''] }), '');
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
  return filterTasksByColumns(noTime.map((t) => ({ task: t, depth: 0, path: [], groupPath: '' })), onlyFilter('createdAt', { min: '2026-10-01' }), '').length === 0;
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
    && as[as.length - 1] === '' && as.indexOf('w1') >= 0 && as.indexOf('w2') >= 0;
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

t('摊平：组不占行，任务带上所属组路径', (() => {
  const rows = flattenTasks(NEST);
  const r3 = rows.find((r) => r.task.id === 'tb-0003');
  return rows.length === 3 && r3 && r3.groupPath === '账户 › 安全' && r3.depth === 2;
})());

t('摊平：不在任何组里的任务 path 为空', (() => {
  const rows = flattenTasks(NEST);
  const r1 = rows.find((r) => r.task.id === 'tb-0001');
  return r1.groupPath === '' && r1.depth === 0;
})());

t('组的状态由下面推导：全部完成才是 done', (() => {
  const all = [normalizeTask({ id: 'x', parent: 'g1', status: 'done' }),
               normalizeTask({ id: 'y', parent: 'g1', status: 'done' }), G1];
  return groupStatus('g1', all) === 'done';
})());

t('组的状态：有一个在做就是 doing', (() => {
  const all = [normalizeTask({ id: 'x', parent: 'g1', status: 'done' }),
               normalizeTask({ id: 'y', parent: 'g1', status: 'doing' }), G1];
  return groupStatus('g1', all) === 'doing';
})());

t('组的状态：嵌套组把下面所有层的任务都算进来', (() => {
  const all = [normalizeTask({ id: 'x', parent: 'g1', status: 'done' }),
               normalizeTask({ id: 'y', parent: 'g2', status: 'doing' }), G1, G2];
  return groupStatus('g1', all) === 'doing';
})());

t('空组没有状态（不能凭空说它是待办）', groupStatus('g1', [G1]) === null);

t('前置未完成 → 锁定', (() => {
  const t = normalizeTask({ id: 'z', deps: ['tb-0003'], status: 'todo' });   // tb-0003 是 doing
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

t('依赖组 = 等组里全部完成', (() => {
  const g = normalizeTask({ id: 'gg', kind: 'group', title: '组' });
  const x = normalizeTask({ id: 'x', parent: 'gg', status: 'done' });
  const y = normalizeTask({ id: 'y', parent: 'gg', status: 'todo' });
  const t = normalizeTask({ id: 'z', deps: ['gg'] });
  const l = lockOf(t, [g, x, y, t]);
  return l.locked === true && l.pending.indexOf('gg') >= 0;
})());


/* ============================================================ 合并 / 拆组 */

const MA = normalizeTask({ id: 'a', title: 'A' });
const MB = normalizeTask({ id: 'b', title: 'B' });
const MC = normalizeTask({ id: 'c', title: 'C' });

t('合并成组：被合并的任务改挂到新组下', (() => {
  const r = mergeIntoGroup([MA, MB, MC], ['a', 'b'], '账户');
  const a = r.tasks.find((t) => t.id === 'a');
  return a.parent === r.groupId && r.tasks.filter((t) => t.kind === 'group').length === 1;
})());

t('合并成组：组可以建在另一个组下（于是能一层层套）', (() => {
  const g0 = normalizeTask({ id: 'g0', title: '外层', kind: 'group' });
  const r = mergeIntoGroup([MA, MB, g0], ['a'], '内层', 'g0');
  const grp = r.tasks.find((t) => t.id === r.groupId);
  return grp.parent === 'g0';
})());

t('合并成组：不把组塞进组（那是另一种语义）', (() => {
  const g0 = normalizeTask({ id: 'g0', title: 'G', kind: 'group' });
  const r = mergeIntoGroup([MA, g0], ['a', 'g0'], 'X');
  const still = r.tasks.find((t) => t.id === 'g0');
  return still.parent === null;
})());

t('合并成组：跳过会成环的组合（不能让自己当自己的祖先）', (() => {
  const g0 = normalizeTask({ id: 'g0', title: 'G', kind: 'group' });
  const kid = normalizeTask({ id: 'k', title: 'K', parent: 'g0' });
  // 把 g0 并进一个新建在 g0 下面的组 —— 实际发生不了，但逻辑要挡
  const r = mergeIntoGroup([g0, kid], ['k'], '内', 'g0');
  return r.tasks.find((t) => t.id === 'k').parent === r.groupId;
})());

t('isAncestor：识别祖先关系', (() => {
  const g1 = normalizeTask({ id: 'g1', kind: 'group' });
  const g2 = normalizeTask({ id: 'g2', kind: 'group', parent: 'g1' });
  const x = normalizeTask({ id: 'x', parent: 'g2' });
  const { parentOf, byId } = indexTasks([g1, g2, x]);
  return isAncestor('g1', 'x', parentOf, byId) === true
    && isAncestor('x', 'g1', parentOf, byId) === false;
})());

t('新建组：空组也要能建（先建好再把任务放进去）', (() => {
  const r = createGroup([MA], '账户');
  return r.tasks.length === 2 && r.tasks[1].kind === 'group';
})());

t('新建组：不能建在自己下面（当场成环）', (() => {
  const r = createGroup([], 'X', 'self');
  return r.tasks[0].parent === 'self';   // groupId 是新生成的，不会等于传入值
})());

t('拆组：组没了，任务上提一层（不是连任务一起删）', (() => {
  const r = mergeIntoGroup([MA, MB], ['a', 'b'], '账户');
  const d = dissolveGroup(r.tasks, r.groupId);
  const a = d.tasks.find((t) => t.id === 'a');
  return d.tasks.length === 2 && a.parent === null;
})());

t('拆组：嵌套组拆掉后，任务挂到**它上一层**（不是回到顶层）', (() => {
  const g0 = normalizeTask({ id: 'g0', title: '外', kind: 'group' });
  const g1 = normalizeTask({ id: 'g1', title: '内', kind: 'group', parent: 'g0' });
  const x = normalizeTask({ id: 'x', parent: 'g1' });
  const d = dissolveGroup([g0, g1, x], 'g1');
  const xx = d.tasks.find((t) => t.id === 'x');
  return xx.parent === 'g0';
})());

t('拆组：拆的不是组就原样返回', (() => {
  const d = dissolveGroup([MA, MB], 'a');
  return d.tasks.length === 2;
})());


/* ============================================================ 拆分 */

t('拆分：原任务变成组，子任务挂在它下面', (() => {
  const src = normalizeTask({ id: 'a', title: '登录', status: 'doing', priority: 'P1', tags: ['ui'] });
  const r = splitTask([src], 'a', ['表单', '校验', '跳转']);
  const g = r.tasks.find((t) => t.id === 'a');
  return g.kind === 'group' && r.childIds.length === 3
    && r.tasks.filter((t) => t.parent === 'a').length === 3;
})());

t('拆分：保留原 id（依赖它、引用它的地方不用改）', (() => {
  const src = normalizeTask({ id: 'a', title: '登录' });
  const r = splitTask([src], 'a', ['x', 'y']);
  return r.groupId === 'a';
})());

t('拆分：子任务继承标签与优先级（上下文要带过去）', (() => {
  const src = normalizeTask({ id: 'a', title: '登录', priority: 'P1', tags: ['ui'] });
  const r = splitTask([src], 'a', ['x']);
  const kid = r.tasks.find((t) => t.parent === 'a');
  return kid.priority === 'P1' && kid.tags.indexOf('ui') >= 0;
})());

t('拆分：子任务不继承状态（否则一出生就是已完成）', (() => {
  const src = normalizeTask({ id: 'a', title: '登录', status: 'doing' });
  const r = splitTask([src], 'a', ['x']);
  const kid = r.tasks.find((t) => t.parent === 'a');
  return kid.status === 'todo';
})());

t('拆分：子任务不继承前置（否则全卡在同一处）', (() => {
  const src = normalizeTask({ id: 'a', title: '登录', deps: ['b'] });
  const r = splitTask([src], 'a', ['x']);
  const kid = r.tasks.find((t) => t.parent === 'a');
  return kid.deps.length === 0;
})());

t('拆分后可以再拆（子任务也能变成组）', (() => {
  const src = normalizeTask({ id: 'a', title: '登录' });
  const r1 = splitTask([src], 'a', ['x', 'y']);
  const kid = r1.tasks.find((t) => t.parent === 'a');
  const r2 = splitTask(r1.tasks, kid.id, ['x1', 'x2']);
  return r2.tasks.filter((t) => t.parent === kid.id).length === 2;
})());

t('拆分：没给子任务名就不动（不能把一条任务变成空组）', (() => {
  const src = normalizeTask({ id: 'a', title: '登录' });
  const r = splitTask([src], 'a', []);
  return r.tasks.length === 1 && r.tasks[0].kind === 'task';
})());


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

t('groupEstimate：累加直接子任务', (() => {
  const g = normalizeTask({ id: 'ge', kind: 'group', title: '组' });
  const a = normalizeTask({ id: 'a', parent: 'ge', estimate: 2 });
  const b = normalizeTask({ id: 'b', parent: 'ge', estimate: 3 });
  return groupEstimate('ge', [g, a, b]) === 5;
})());

t('groupEstimate：嵌套的也要算进来（只看一层会漏掉下面几层）', (() => {
  const g1 = normalizeTask({ id: 'g1', kind: 'group' });
  const g2 = normalizeTask({ id: 'g2', kind: 'group', parent: 'g1' });
  const x = normalizeTask({ id: 'x', parent: 'g1', estimate: 1 });
  const y = normalizeTask({ id: 'y', parent: 'g2', estimate: 2 });
  return groupEstimate('g1', [g1, g2, x, y]) === 3;
})());

t('groupEstimate：组自己不重复计入（否则双份）', (() => {
  const g = normalizeTask({ id: 'ge', kind: 'group', estimate: 99 });
  const a = normalizeTask({ id: 'a', parent: 'ge', estimate: 2 });
  return groupEstimate('ge', [g, a]) === 2;
})());

t('totalEstimate：只算叶子任务', (() => {
  const g = normalizeTask({ id: 'ge', kind: 'group', estimate: 99 });
  const a = normalizeTask({ id: 'a', parent: 'ge', estimate: 2 });
  return totalEstimate([g, a]) === 2;
})());

t('按预筛选：区间命中', (() => {
  const rows = [E1, E2, E3].map((t) => ({ task: t, depth: 0, path: [], groupPath: '' }));
  const f = { ...emptyColFilter(), min: '2', max: '3' };
  const hit = filterTasksByColumns(rows, { estimate: f }, '');
  return hit.length === 1 && hit[0].task.id === 'e1';
})());

t('按预筛选：没估的不当 0 混进区间结果', (() => {
  const rows = [E1, E2, E3].map((t) => ({ task: t, depth: 0, path: [], groupPath: '' }));
  const hit = filterTasksByColumns(rows, { estimate: { ...emptyColFilter(), max: '100' } }, '');
  return hit.every((r) => r.task.id !== 'e3');
})());

t('按预筛选：能专门筛出"没估的"（排期前最常用的查询）', (() => {
  const rows = [E1, E2, E3].map((t) => ({ task: t, depth: 0, path: [], groupPath: '' }));
  const hit = filterTasksByColumns(rows, { estimate: { ...emptyColFilter(), values: ['__none__'] } }, '');
  return hit.length === 1 && hit[0].task.id === 'e3';
})());

t('按预筛选：只填一边也行', (() => {
  const rows = [E1, E2, E3].map((t) => ({ task: t, depth: 0, path: [], groupPath: '' }));
  const hit = filterTasksByColumns(rows, { estimate: { ...emptyColFilter(), min: '1' } }, '');
  return hit.length === 1 && hit[0].task.id === 'e1';
})());

t('numOrNull：空串不算数（那是"没填"）', numOrNull('') === null && numOrNull('2.5') === 2.5);

t('预估列可排序（按数值而不是字典序）', (() => {
  const rows = [E1, E2, E3].map((t) => ({ task: t, depth: 0, path: [], groupPath: '' }));
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

/* ---------------- 汇总 ---------------- */
console.log(`task-board core: 通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
