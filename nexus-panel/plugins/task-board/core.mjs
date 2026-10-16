// task-board 纯逻辑层：不碰 DOM、不碰 ctx，浏览器与 node 单测共用。
// 与 Rust task_board.rs 的 STATUSES 保持一致（双端各自校验）。
// 有守卫盯着：regression-guard-test.mjs 第 22 节会逐项比对两侧清单与流转图
// （此前这条约定靠人记得同步 —— 实测 346 个测试里 0 个读 task_board.rs）。

export const STATUSES = ['todo', 'claimed', 'doing', 'review', 'done'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

/** 允许的状态流转（不在表内的直接拒） */
export function canTransition(from, to) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false;
  if (from === to) return true;
  const allowed = {
    todo: ['claimed', 'doing'],
    claimed: ['doing', 'todo'],
    doing: ['review', 'todo'],
    review: ['done', 'doing'],
    done: ['review'],
  };
  return (allowed[from] || []).includes(to);
}

/** 当前状态下界面上要显示的操作按钮 */
export function actionsFor(status) {
  switch (status) {
    case 'todo':
      return [
        { to: 'claimed', label: '认领' },
        { to: 'doing', label: '开始' },
      ];
    case 'claimed':
      return [
        { to: 'doing', label: '开始' },
        { to: 'todo', label: '退回' },
      ];
    case 'doing':
      return [
        { to: 'review', label: '提交审查' },
        { to: 'todo', label: '退回' },
      ];
    case 'review':
      return [
        { to: 'done', label: '通过' },
        { to: 'doing', label: '打回', needNote: true },
      ];
    case 'done':
      return [{ to: 'review', label: '重开' }];
    default:
      return [];
  }
}

export function normalizeTask(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  return {
    id: typeof t.id === 'string' ? t.id : '',
    title: typeof t.title === 'string' ? t.title : '(无标题)',
    detail: typeof t.detail === 'string' ? t.detail : '',
    status: STATUSES.includes(t.status) ? t.status : 'todo',
    priority: PRIORITIES.includes(t.priority) ? t.priority : 'P2',
    tags: Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === 'string') : [],
    reporter: typeof t.reporter === 'string' ? t.reporter : 'manual',
    assignee: typeof t.assignee === 'string' && t.assignee ? t.assignee : null,
    createdAt: num(t.createdAt, 0),
    updatedAt: num(t.updatedAt, 0),
    history: Array.isArray(t.history) ? t.history.filter((h) => h && typeof h === 'object') : [],
  };
}

export function normalizeStore(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    v: Number.isFinite(s.v) ? s.v : 1,
    nextId: Number.isFinite(s.nextId) && s.nextId > 0 ? Math.floor(s.nextId) : 1,
    tasks: Array.isArray(s.tasks) ? s.tasks.map(normalizeTask) : [],
    agents: Array.isArray(s.agents)
      ? s.agents
          .filter((a) => a && typeof a.id === 'string' && a.id)
          .map((a) => ({
            id: a.id,
            name: typeof a.name === 'string' && a.name ? a.name : a.id,
            role: typeof a.role === 'string' && a.role ? a.role : 'dev',
            lastSeen: Number.isFinite(a.lastSeen) ? a.lastSeen : 0,
          }))
      : [],
  };
}

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** 排序：优先级升序（紧急在前），同级按更新时间倒序 */
export function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const pr = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
    if (pr !== 0) return pr;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });
}

/** 过滤：优先级 / 标签 / 认领人 / 关键词（标题+详情+id） */
export function filterTasks(tasks, f) {
  const q = (f.q || '').trim().toLowerCase();
  return tasks.filter((t) => {
    if (f.priority && t.priority !== f.priority) return false;
    if (f.tag && !t.tags.includes(f.tag)) return false;
    if (f.assignee === '__none__' && t.assignee) return false;
    if (f.assignee && f.assignee !== '__none__' && t.assignee !== f.assignee) return false;
    if (q) {
      const hay = `${t.id} ${t.title} ${t.detail}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** 全部标签（去重，按出现次数倒序，最多 20 个） */
export function allTags(tasks) {
  const cnt = new Map();
  for (const t of tasks) for (const tag of t.tags) cnt.set(tag, (cnt.get(tag) || 0) + 1);
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([tag]) => tag);
}

/** 下一个任务 id（与 Rust create_task 同规则：tb-%04d） */
export function nextTaskId(store) {
  const n = Number.isFinite(store.nextId) && store.nextId > 0 ? Math.floor(store.nextId) : 1;
  return `tb-${String(n).padStart(4, '0')}`;
}

/** 追加一条历史（前端写盘前调用；上限与 Rust 的 HISTORY_CAP 对齐） */
export function pushHistory(task, by, action, note, at) {
  const hist = Array.isArray(task.history) ? [...task.history] : [];
  hist.push({ at: at || Date.now(), by: by || 'manual', action: action || 'note', note: note || '' });
  if (hist.length > 100) hist.splice(0, hist.length - 100);
  return { ...task, history: hist, updatedAt: at || Date.now() };
}

/** 应用一次流转（含合法性校验），返回新任务；不合法返回 null */
export function applyTransition(task, to, by, note, at) {
  if (!canTransition(task.status, to)) return null;
  const stamp = at || Date.now();
  let next = { ...task, status: to, updatedAt: stamp };
  const suffix = note ? `（${note}）` : '';
  next = pushHistory(next, by, 'status', `${task.status} -> ${to}${suffix}`, stamp);
  return next;
}

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** 毫秒时间戳 -> 可读时间（今天 HH:MM / 本周 周X HH:MM / 更早 YYYY-MM-DD） */
export function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hhmm;
  const weekAgo = now.getTime() - 6 * 24 * 3600 * 1000;
  if (ms >= weekAgo) return `周${WEEK[d.getDay()]} ${hhmm}`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 相对时间（刚刚 / N 分钟前 / N 小时前 / N 天前） */
export function relTime(ms) {
  if (!ms) return '—';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 24 * 3600_000) return `${Math.floor(diff / 3600_000)} 小时前`;
  return `${Math.floor(diff / (24 * 3600_000))} 天前`;
}

/** 未认领任务的哨兵 key（与 filterTasks 的 '__none__' 约定一致） */
export const UNASSIGNED = '__none__';
/** 无标签任务的哨兵 key（仅 tag 分组时使用） */
export const NOTAG = '__notag__';

const STATUS_RANK = Object.fromEntries(STATUSES.map((s, i) => [s, i]));

/**
 * 分组：status / priority / assignee / tag
 * - status / priority：按 STATUSES / PRIORITIES 固定顺序，只返回非空组
 * - assignee：未认领（__none__）恒置顶，其余按组内数量倒序
 * - tag：并集语义（一个任务带 N 个标签就同时进 N 个组），按数量倒序
 *
 * 只返回 key 不返回 label —— 标签文案由 UI 层映射 types.ts 的
 * STATUS_LABEL / PRIORITY_LABEL，避免同一份映射抄两处后漂移。
 */
export function groupTasks(tasks, key) {
  const groups = [];
  const index = new Map();
  const push = (k, t) => {
    let g = index.get(k);
    if (!g) {
      g = { key: k, tasks: [] };
      index.set(k, g);
      groups.push(g);
    }
    g.tasks.push(t);
  };
  for (const t of tasks) {
    if (key === 'status') push(t.status, t);
    else if (key === 'priority') push(t.priority, t);
    else if (key === 'assignee') push(t.assignee || UNASSIGNED, t);
    else if (key === 'tag') {
      if (t.tags.length === 0) push(NOTAG, t);
      else for (const tag of t.tags) push(tag, t);
    }
  }
  if (key === 'status') groups.sort((a, b) => STATUS_RANK[a.key] - STATUS_RANK[b.key]);
  else if (key === 'priority') groups.sort((a, b) => PRIORITIES.indexOf(a.key) - PRIORITIES.indexOf(b.key));
  else if (key === 'assignee') {
    groups.sort((a, b) => {
      if (a.key === UNASSIGNED) return -1;
      if (b.key === UNASSIGNED) return 1;
      return b.tasks.length - a.tasks.length || a.key.localeCompare(b.key);
    });
  } else if (key === 'tag') {
    // __notag__ 是伪分组，显式置尾 —— 不能靠 '__' 碰 collation 运气
    groups.sort((a, b) => {
      if (a.key === NOTAG) return 1;
      if (b.key === NOTAG) return -1;
      return b.tasks.length - a.tasks.length || a.key.localeCompare(b.key);
    });
  } else {
    groups.sort((a, b) => b.tasks.length - a.tasks.length || a.key.localeCompare(b.key));
  }
  return groups;
}

/**
 * 多字段排序（列表 / 分组视图的表头与组内排序共用）
 * 字段：priority / status / assignee / updatedAt / createdAt / title / id
 * 方向：'asc' | 'desc'（默认 asc）
 * - assignee：未认领恒排最后，与方向无关
 * - 同级兜底：更新时间倒序（新的在前）；排时间字段本身时按 id 升序保稳定
 */
export function sortTasksBy(tasks, field, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  const cmp = (a, b) => {
    let r = 0;
    switch (field) {
      case 'priority':
        r = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
        break;
      case 'status':
        r = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
        break;
      case 'assignee': {
        if (!a.assignee && !b.assignee) r = 0;
        else if (!a.assignee) return 1;
        else if (!b.assignee) return -1;
        else r = a.assignee.localeCompare(b.assignee);
        break;
      }
      case 'updatedAt':
      case 'createdAt':
        r = (a[field] || 0) - (b[field] || 0);
        break;
      case 'title':
        r = a.title.localeCompare(b.title, 'zh-Hans-CN');
        break;
      case 'id':
        r = a.id.localeCompare(b.id);
        break;
      default:
        r = 0;
    }
    if (r !== 0) return r * sign;
    if (field === 'updatedAt' || field === 'createdAt') return a.id.localeCompare(b.id);
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  };
  return [...tasks].sort(cmp);
}

const STALE_MS = 7 * 24 * 3600 * 1000;

/**
 * 统计（「统计」视图数据源）。now 可注入，保证单测不依赖真实时钟。
 * - open = 未完成总数；active = doing + review（真正在流转的）
 * - stale = 未完成且超过 7 天没动过，按 updatedAt 升序（最僵硬的在前）
 * - recent = 跨任务合并 history，按时间倒序前 8 条（带 taskId/title 便于跳转）
 * - byAssignee 的 __none__ 置顶；topTags 取前 10
 */
export function statsOf(store, now = Date.now()) {
  const tasks = store.tasks || [];
  const byStatus = {};
  const byPriority = {};
  for (const s of STATUSES) byStatus[s] = 0;
  for (const p of PRIORITIES) byPriority[p] = 0;
  const byAssignee = new Map();
  const tagCnt = new Map();
  const stale = [];
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
    const who = t.assignee || UNASSIGNED;
    byAssignee.set(who, (byAssignee.get(who) || 0) + 1);
    for (const tag of t.tags) tagCnt.set(tag, (tagCnt.get(tag) || 0) + 1);
    if (t.status !== 'done' && (now - (t.updatedAt || 0)) > STALE_MS) stale.push(t);
  }
  const assignees = [...byAssignee.entries()]
    .sort((a, b) => {
      if (a[0] === UNASSIGNED) return -1;
      if (b[0] === UNASSIGNED) return 1;
      return b[1] - a[1] || a[0].localeCompare(b[0]);
    })
    .map(([id, count]) => ({ id, count }));
  const topTags = [...tagCnt.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([tag, count]) => ({ tag, count }));
  const recent = [];
  for (const t of tasks) {
    for (const h of t.history || []) recent.push({ ...h, taskId: t.id, title: t.title });
  }
  recent.sort((a, b) => (b.at || 0) - (a.at || 0));
  stale.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
  return {
    total: tasks.length,
    open: tasks.filter((t) => t.status !== 'done').length,
    active: tasks.filter((t) => t.status === 'doing' || t.status === 'review').length,
    done: byStatus.done,
    byStatus,
    byPriority,
    byAssignee: assignees,
    topTags,
    recent: recent.slice(0, 8),
    stale,
    agents: store.agents || [],
  };
}
