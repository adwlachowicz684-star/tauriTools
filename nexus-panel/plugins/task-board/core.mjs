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
