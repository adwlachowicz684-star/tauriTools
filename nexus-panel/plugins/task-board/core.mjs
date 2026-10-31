// task-board 纯逻辑层：不碰 DOM、不碰 ctx，浏览器与 node 单测共用。
// 与 Rust task_board.rs 的 STATUSES 保持一致（双端各自校验）。
// 有守卫盯着：regression-guard-test.mjs 第 22 节会逐项比对两侧清单与流转图
// （此前这条约定靠人记得同步 —— 实测 346 个测试里 0 个读 task_board.rs）。

export const STATUSES = ['todo', 'claimed', 'doing', 'hold', 'review', 'done', 'cancelled'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];

/* ============================================================ 流程配置
 *
 * 状态与流转**由用户在界面上定**，不再写死。默认这一套只是初始值。
 *
 * 存在 tasks.json 的 `flow` 字段里，与任务同库 ——
 * 单独一个配置文件的话，AI 或另一个窗口改了流程而这边没读到，
 * 就会出现"状态名改了但旧的还在用"的半新半旧状态。
 *
 * ⛔ `transitions` 是**双端都认**的（Rust 侧同样校验）；
 *    `edges`（按钮文案 / 要不要填原因）只影响界面，Rust 不读 ——
 *    它没有"两份真相"的问题，所以不放进双端契约里。
 */

export const DEFAULT_FLOW = {
  statuses: [
    { id: 'todo', name: '待办', color: '#78716c', enter: '退回', done: false },
    { id: 'claimed', name: '已认领', color: '#0ea5e9', enter: '认领', done: false },
    { id: 'doing', name: '进行中', color: '#3b82f6', enter: '开始', done: false },
    { id: 'hold', name: '挂起', color: '#f59e0b', enter: '挂起', done: false },
    { id: 'review', name: '待审查', color: '#a855f7', enter: '提交审查', done: false },
    { id: 'done', name: '已完成', color: '#22c55e', enter: '通过', done: true },
    { id: 'cancelled', name: '已取消', color: '#ef4444', enter: '取消', done: false },
  ],
  transitions: {
    todo: ['claimed', 'doing', 'hold', 'cancelled'],
    claimed: ['doing', 'todo', 'hold', 'cancelled'],
    doing: ['review', 'todo', 'hold', 'cancelled'],
    hold: ['doing', 'todo', 'cancelled'],
    review: ['done', 'doing', 'hold', 'cancelled'],
    done: ['review'],
    cancelled: ['todo'],
  },
  /*
    边的额外配置。默认是"进入那个状态"的动词，
    但有几条边用通用动词讲不通（review→doing 是"打回"不是"开始"），
    所以允许逐边覆盖。
  */
  edges: {
    'review>doing': { label: '打回', note: true },
    'done>review': { label: '重开' },
    'hold>doing': { label: '继续' },
  },
};

const FLOW_COLORS = Object.fromEntries(
  DEFAULT_FLOW.statuses.map((s) => [s.id, s.color]),
);

/**
 * 解析流程配置。
 *
 * 认两种写法：对象数组（界面写的）和纯字符串数组（手写文件图省事）。
 * 解析不出来就用默认那套 —— **不会因为配置坏了就整份任务打不开**。
 */
export function normalizeFlow(raw) {
  const f = raw && typeof raw === 'object' ? raw : null;
  const stRaw = f && Array.isArray(f.statuses) ? f.statuses : null;
  let statuses = null;
  if (stRaw && stRaw.length > 0) {
    const seen = new Set();
    const out = [];
    for (const one of stRaw) {
      const o = one && typeof one === 'object' ? one : {};
      const id = typeof o.id === 'string' && o.id.trim()
        ? o.id.trim()
        : (typeof one === 'string' && one.trim() ? one.trim() : '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const name = typeof o.name === 'string' && o.name ? o.name : id;
      out.push({
        id,
        name,
        color: typeof o.color === 'string' && o.color ? o.color : (FLOW_COLORS[id] || '#78716c'),
        enter: typeof o.enter === 'string' && o.enter ? o.enter : `标为「${name}」`,
        done: o.done === true,
      });
    }
    if (out.length > 0) statuses = out;
  }
  const list = statuses || DEFAULT_FLOW.statuses;
  const ids = new Set(list.map((s) => s.id));

  /*
    只配了状态、没配流转时，用默认流转**裁到还剩的那些状态**——
    直接照搬默认表的话，表里会留着已被删掉的状态，
    那些按钮点下去会走到一个不存在的地方。
  */
  const clip = (table) => {
    const out = {};
    for (const from of Object.keys(table)) {
      if (!ids.has(from)) continue;
      out[from] = (table[from] || []).filter((x) => ids.has(x));
    }
    return out;
  };

  const tr = {};
  const rawTr = f && f.transitions && typeof f.transitions === 'object' ? f.transitions : null;
  if (rawTr) {
    for (const from of Object.keys(rawTr)) {
      if (!ids.has(from)) continue;
      const arr = Array.isArray(rawTr[from]) ? rawTr[from] : [];
      tr[from] = arr.filter((x) => typeof x === 'string' && ids.has(x));
    }
  }
  const transitions = Object.keys(tr).length > 0
    ? tr
    : clip(DEFAULT_FLOW.transitions);

  const edges = {};
  if (f && f.edges && typeof f.edges === 'object') {
    for (const k of Object.keys(f.edges)) {
      const e = f.edges[k];
      if (!e || typeof e !== 'object') continue;
      edges[k] = {
        label: typeof e.label === 'string' ? e.label : '',
        note: e.note === true,
      };
    }
  }
  return { statuses: list, transitions, edges };
}

/**
 * 没给流程就用默认那套。
 *
 * ⛔ 不能简单地"`flow.statuses` 为空就算都没配" ——
 * 那样只传了 store 没传 flow 的调用（statsOf 就是）会把
 * "已完成"也判成未完成，陈旧列表里混进一堆早就做完的任务。
 */
function flowOf(flow) {
  return (flow && Array.isArray(flow.statuses) && flow.statuses.length)
    ? flow
    : DEFAULT_FLOW;
}

/** 状态 id → 显示名。没配过的状态（AI 手写出来的）原样显示，不假装认识 */
export function statusName(flow, id) {
  const s = flowOf(flow).statuses.find((x) => x.id === id);
  return s ? s.name : id;
}

export function statusColor(flow, id) {
  const s = flowOf(flow).statuses.find((x) => x.id === id);
  return (s && s.color) || FLOW_COLORS[id] || '#78716c';
}

/**
 * 这个状态算不算"完成"。
 *
 * 只有界面上标了「算完成」的那些才算 ——
 * **已取消刻意不算**：它被取消说明这事不做了，
 * 依赖它的任务应当继续卡住并提示人来处理，
 * 而不是悄悄解锁、让人以为上游已经交付。
 */
export function statusDone(flow, id) {
  const s = flowOf(flow).statuses.find((x) => x.id === id);
  return !!(s && s.done);
}

/** 初始状态 = 列表第一个 */
export function initialStatus(flow) {
  const f = flowOf(flow);
  return (f.statuses[0] && f.statuses[0].id) || 'todo';
}

/** 按**配置**判断能不能流转（默认流程走 canTransition） */
export function canTransitionIn(flow, from, to) {
  const f = flowOf(flow);
  if (from === to) return true;
  const ids = (f.statuses || []).map((s) => s.id);
  if (ids.indexOf(from) < 0 || ids.indexOf(to) < 0) return false;
  return ((f.transitions || {})[from] || []).indexOf(to) >= 0;
}

/**
 * 当前状态下界面上要显示的操作按钮（按配置推导）。
 *
 * 不再写死"认领/开始/提交审查"——那些是默认流程的动词，
 * 用户改了流程之后它们就不适用了。
 */
export function actionsForIn(flow, status) {
  const f = flowOf(flow);
  const byId = Object.fromEntries((f.statuses || []).map((s) => [s.id, s]));
  const outs = ((f.transitions || {})[status] || []).filter((to) => to !== status);
  return outs.map((to) => {
    const edge = (f.edges || {})[`${status}>${to}`] || {};
    const tgt = byId[to];
    return {
      to,
      label: edge.label || (tgt && tgt.enter) || `标为「${tgt ? tgt.name : to}」`,
      needNote: edge.note === true,
    };
  });
}

/** 允许的状态流转（不在表内的直接拒） */
export function canTransition(from, to) {
  if (!STATUSES.includes(from) || !STATUSES.includes(to)) return false;
  if (from === to) return true;
  const allowed = {
    todo: ['claimed', 'doing', 'hold', 'cancelled'],
    claimed: ['doing', 'todo', 'hold', 'cancelled'],
    doing: ['review', 'todo', 'hold', 'cancelled'],
    hold: ['doing', 'todo', 'cancelled'],
    review: ['done', 'doing', 'hold', 'cancelled'],
    done: ['review'],
    cancelled: ['todo'],
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
        { to: 'hold', label: '挂起' },
        { to: 'cancelled', label: '取消' },
      ];
    case 'review':
      return [
        { to: 'done', label: '通过' },
        { to: 'doing', label: '打回', needNote: true },
        { to: 'hold', label: '挂起' },
        { to: 'cancelled', label: '取消' },
      ];
    case 'done':
      return [{ to: 'review', label: '重开' }];
    case 'cancelled':
      return [{ to: 'todo', label: '重开' }];
    default:
      return [];
  }
}

export function normalizeTask(raw) {
  const t = raw && typeof raw === 'object' ? raw : {};
  const num = (v, d) => (Number.isFinite(v) ? v : d);
  /*
    parent / deps 指向的 id 可能已经不存在（任务被删了）。
    这里**不清理**引用：清了就无从知道"这里原本挂着什么"，
    而界面上显式标出"前置已被删除"比静默消失要好 ——
    后者会让人以为这条本来就没有前置。
  */
  return {
    id: typeof t.id === 'string' ? t.id : '',
    title: typeof t.title === 'string' ? t.title : '(无标题)',
    summary: typeof t.summary === 'string' ? t.summary : '',
    detail: typeof t.detail === 'string' ? t.detail : '',
    kind: t.kind === 'group' ? 'group' : 'task',
    parent: typeof t.parent === 'string' && t.parent ? t.parent : null,
    deps: Array.isArray(t.deps) ? t.deps.filter((x) => typeof x === 'string') : [],
    /*
      状态**不校验白名单**：自定义状态是用户自己起的 id，
      这里按固定清单过滤的话，用户新增的状态会被悄悄退回 todo。
      展示层查不到就原样显示 id —— 认不出来比认错要好。
    */
    status: typeof t.status === 'string' && t.status ? t.status : 'todo',
    priority: PRIORITIES.includes(t.priority) ? t.priority : 'P2',
    /*
      预估工作量，单位**人日**，允许小数（半天 = 0.5）。
      不设上限也不校验整数 —— 任务大到几十人日、小到 0.25 都有，
      强校验只会逼人去备注里偷偷记，那就没法汇总了。
      负数按 0 处理：负的工作量没有意义，且会把合计往回拉。
    */
    estimate: Number.isFinite(t.estimate) && t.estimate > 0 ? t.estimate : 0,
    /*
      任务类型存的是**定义表里的 id**（'dev'/'bug'…），不是显示名。
      存名字的话改个名就要回头改所有任务，而且改名后旧名变成没人认的孤值。
      ⛔ 同样不校验白名单：用户新增的类型要能活下来，
      这里按默认清单过滤会把新增类型悄悄清空。
    */
    type: typeof t.type === 'string' ? t.type : '',
    tags: Array.isArray(t.tags) ? t.tags.filter((x) => typeof x === 'string') : [],
    reporter: typeof t.reporter === 'string' ? t.reporter : 'manual',
    assignee: typeof t.assignee === 'string' && t.assignee ? t.assignee : null,
    createdAt: num(t.createdAt, 0),
    updatedAt: num(t.updatedAt, 0),
    history: Array.isArray(t.history) ? t.history.filter((h) => h && typeof h === 'object') : [],
  };
}

/** 归一化标签定义表。缺颜色给一档中性色，不让它变成"没定义" */
function normalizeTagDefs(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const d of raw) {
    if (!d || typeof d !== 'object') continue;
    const id = typeof d.id === 'string' ? d.id : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof d.name === 'string' && d.name ? d.name : id,
      color: typeof d.color === 'string' && d.color ? d.color : '#78716c',
    });
  }
  return out;
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
    tagDefs: normalizeTagDefs(s.tagDefs),
    typeDefs: normalizeTypeDefs(s.typeDefs),
    /*
      流程配置（自定义状态与流转）。
      没配过 → normalizeFlow 给默认那套，行为与以前完全一致 ——
      不能让"打开一份老文件"就因为缺这个字段而变了样。
    */
    flow: normalizeFlow(s.flow),
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

/* ============================================================ 列级筛选
 *
 * 每一列都能筛 —— "哪些任务该出现"由列上的筛选决定，不由顶栏那排
 * 下拉决定。顶栏摆四个下拉时，只有那四件事筛得了；而"创建于上周、
 * 没人认领的 P0"这种组合根本填不进去。
 *
 * 所以这里给每一列都配一份筛选条件，顶栏只留一个**全局搜索**
 * （跨 id / 标题 / 详情，那是一次性找某条东西的入口，不属于"按列筛"）。
 *
 * kind 决定这一列配什么控件：
 *   enum → 多选（优先级 / 状态 / 认领人 / 标签）
 *   text → 关键词包含（ID / 标题）
 *   time → 起止日期（创建 / 更新）
 */

/** 列表视图的列。顺序即界面上的列序 */
export const LIST_COLUMNS = [
  { field: 'priority', label: '优先级', kind: 'enum' },
  { field: 'id', label: 'ID', kind: 'text' },
  { field: 'title', label: '标题', kind: 'text' },
  /*
    所属组**只作显示与筛选**，组标题本身不参与标题搜索 ——
    搜"登录"不该把挂在登录组下的所有任务全带出来，
    那是"扩展范围"，而搜索是"收窄范围"。
  */
  { field: 'groupPath', label: '所属组', kind: 'text' },
  { field: 'status', label: '状态', kind: 'enum' },
  { field: 'assignee', label: '认领人', kind: 'enum' },
  { field: 'type', label: '任务类型', kind: 'enum' },
  { field: 'tags', label: '标签', kind: 'enum' },
  { field: 'summary', label: '说明', kind: 'text' },
  { field: 'estimate', label: '预估(人日)', kind: 'num' },
  { field: 'createdAt', label: '创建', kind: 'time' },
  { field: 'updatedAt', label: '更新', kind: 'time' },
];

/** 一列的筛选条件。四种字段全放在一个对象里 —— 换来的是一份判空、一份清空 */
export function emptyColFilter() {
  return { text: '', values: [], min: '', max: '' };
}

/** 'YYYY-MM-DD' → 当天 00:00:00。解析不出来返回 null（不当成 0 去卡死筛选） */
function dayStart(s) {
  const t = (s || '').trim();
  if (!t) return null;
  const ms = Date.parse(`${t}T00:00:00`);
  return Number.isNaN(ms) ? null : ms;
}

/** 'YYYY-MM-DD' → 当天 23:59:59.999。上界要含当天，否则选"到今天"会把今天排除掉 */
function dayEnd(s) {
  const t = (s || '').trim();
  if (!t) return null;
  const ms = Date.parse(`${t}T23:59:59.999`);
  return Number.isNaN(ms) ? null : ms;
}

/** 这一列的筛选是否生效。判空只写这一处，UI 与过滤共用 */
/** 数值列里代表「没估」的那个选项。它是"缺失"，不是 0 */
export const UNESTIMATED = '__none__';

/** 区间输入框里的东西是不是个数。空串**不算**数（那是"没填"） */
export function numOrNull(v) {
  const s2 = String(v ?? '').trim();
  if (!s2) return null;
  const n = Number(s2);
  return Number.isFinite(n) ? n : null;
}

/** 人日显示：去掉浮点尾巴（0.1+0.2 会算出 0.30000000000000004） */
export function fmtEstimate(n) {
  const v = Number(n) || 0;
  if (v <= 0) return '';
  return String(Math.round(v * 100) / 100);
}

export function colFilterActive(col, f) {
  if (!f) return false;
  if (col.kind === 'enum') return (f.values || []).length > 0;
  if (col.kind === 'text') return (f.text || '').trim() !== '';
  if (col.kind === 'time') return dayStart(f.min) !== null || dayEnd(f.max) !== null;
  if (col.kind === 'num') {
    return numOrNull(f.min) !== null || numOrNull(f.max) !== null
      || (f.values || []).length > 0;   // 「没估」是个勾选项，也算生效
  }
  return false;
}

/**
 * 该列用于**筛选**的原始值（可能多个）。
 *
 * 返回数组是因为标签是多值的：拼成串之后"选中 A 和 B"会变成要匹配
 * "A,B" 这个整体，而用户要的是"挂着 A 或 B 的都算"。
 *
 * 认领人用空串表示"未认领" —— 它得能单独被筛出来（"找没人认领的"
 * 是很常用的查询），所以不能返回空数组：空数组在这里表示
 * "这行在该列上没有值，不匹配任何选项"。
 */
/*
  任务在某个列上的**原始值**（多值列返回多个）。

  ⚠️ 加新列时必须同步这里。漏掉 → 该列返回 [] → enum 匹配直接判 false
  → **勾任何值结果都是空**，而界面上看不出"筛选坏了"，
    只显示"没有符合条件的任务"，用户会以为真的没有。
  （2026-10-28 自查第 3 轮：「任务类型」列就漏在这儿，筛选 100% 失效。）
*/
export function colRawValues(task, field) {
  switch (field) {
    case 'priority': return [task.priority];
    case 'status': return [task.status];
    case 'assignee': return [task.assignee || ''];
    /* 空类型落到 NOTYPE 哨兵，这样"未分类"才筛得到 */
    case 'type': return [task.type || NOTYPE];
    case 'tags': return task.tags || [];
    default: return [];
  }
}

/**
 * 一行在某个字段上的值。
 *
 * 接的是**摊平行**（{task, groupPath}）而不是裸 Task ——
 * 所属组是摊平时才有的派生值，Task 上没有这个字段。
 * 若在这里拿 Task，那一列就只能永远筛不到东西。
 */
export function rowValue(row, field) {
  if (field === 'groupPath') return row.groupPath || '';
  return row.task ? row.task[field] : undefined;
}

/** 单列匹配 */
function matchesCol(row, col, f) {
  const t = row.task;
  switch (col.kind) {
    case 'enum': {
      const raws = colRawValues(t, col.field);
      if (raws.length === 0) return false;
      // 多值列（标签）命中任一即可
      return raws.some((x) => f.values.indexOf(x) >= 0);
    }
    case 'text': {
      const kw = (f.text || '').trim().toLowerCase();
      if (!kw) return true;
      return String(rowValue(row, col.field) || '').toLowerCase().indexOf(kw) >= 0;
    }
    case 'time': {
      const n = t[col.field] || 0;
      /*
        时间为 0（老数据没记）**不参与**区间筛选 ——
        "找上周创建的"不该带出一堆没时间戳的，
        它们根本没有创建时间，放进结果里只是一条永远排在最后的噪音。
      */
      if (n <= 0) return false;
      const lo = dayStart(f.min);
      const hi = dayEnd(f.max);
      if (lo !== null && n < lo) return false;
      if (hi !== null && n > hi) return false;
      return true;
    }
    case 'num': {
      const lo = numOrNull(f.min);
      const hi = numOrNull(f.max);
      const n = Number(t[col.field]) || 0;
      const wantNone = (f.values || []).indexOf(UNESTIMATED) >= 0;
      /*
        ⛔ 没填预估（0）**不参与区间筛选** ——
        "找 3 人日以上的大活"不该带出一堆压根没估过的，
        它们不是"0 人日"，是"没估"。当成 0 混进结果里是假数据。

        所以要找没估的，走单独的勾选项（UNESTIMATED），
        并且**勾了它就只看没估的** —— 两个条件语义不同，
        混在一起会变成"要么没估、要么在区间内"，没人能预测出这个结果。
      */
      if (lo === null && hi === null) return n <= 0 ? wantNone : !wantNone;
      if (n <= 0) return false;
      if (lo !== null && n < lo) return false;
      if (hi !== null && n > hi) return false;
      return true;
    }
    default:
      return true;
  }
}

/**
 * 按列筛选。
 *
 * 只判**生效**的列：某列 filter 对象存在但全空时，若照样拿去匹配，
 * enum 列的 values 是空数组 → 全部不匹配 → 整表变空。
 * 那是最难自查的一类 bug：看起来"什么都没筛，却一条都没有"。
 *
 * @param q 全局关键词（跨 id / 标题 / 详情），可空
 */
/**
 * 按列筛选（作用在**摊平行**上）。
 *
 * 全局搜索也刻意**不搜组标题**：那会让"找一条任务"变成
 * "找出一整个组下面所有东西"，与搜索的语义相反。
 */
export function filterTasksByColumns(rows, filters, q) {
  const active = LIST_COLUMNS.filter((c) => colFilterActive(c, filters[c.field]));
  const kw = (q || '').trim().toLowerCase();
  if (active.length === 0 && !kw) return rows;
  return rows.filter((row) => {
    for (const c of active) {
      if (!matchesCol(row, c, filters[c.field])) return false;
    }
    if (kw) {
      const t = row.task;
      const hay = `${t.id} ${t.title} ${t.detail} ${t.summary || ''}`.toLowerCase();
      if (hay.indexOf(kw) < 0) return false;
    }
    return true;
  });
}

/** 生效的筛选列（按列序）。头部与摘要用 */
export function activeColFilters(filters) {
  return LIST_COLUMNS.filter((c) => colFilterActive(c, filters[c.field]));
}

/**
 * 某一列的候选值（原始值，不含显示文案）。
 *
 * ⛔ 这里**只给值不给 label** —— 状态名与优先级名的映射在 types.ts，
 * core.mjs 刻意不抄第二份（抄了就会漂移，见 core.mjs 顶部注释）。
 * 前端拿值去映射文案。
 *
 * 认领人从**当前这批任务**里去重，而不是取 agents 表：
 * 表里没有、但任务上写着的名字（外部 API 写的）照样要能筛；
 * 反过来表里有、但没人领过任务的名字，列出来选中就是零行。
 */
export function colFilterValues(field, rows, statusIds, typeIds) {
  const tasks = (rows || []).map((r) => (r && r.task ? r.task : r));
  switch (field) {
    case 'priority': return [...PRIORITIES];
    /*
      状态取**用户配的**那份（statusIds），不是写死的清单 ——
      否则用户在界面上新增了状态，筛选下拉里却选不到它，
      而列表里明明能看到那个状态的任务。
    */
    case 'status': return statusIds && statusIds.length ? [...statusIds] : [...STATUSES];
    case 'assignee': {
      const names = [...new Set(tasks.map((t) => t.assignee).filter(Boolean))];
      names.sort((a, b) => a.localeCompare(b));
      // 未认领（空串）排最后：它是"没人"，不该顶在名单前面
      return [...names, ''];
    }
    /*
      类型取**定义表**（用户增删改过）。从数据里去重的话，
      用户刚新建、还没挂到任何任务上的类型在下拉里就选不到，
      那个类型等于建不出来。
    */
    /*
      类型候选 = 定义表 + 「未分类」。
      未分类必须能筛：一堆任务没归类是常态，
      而"把它们找出来补上归类"是刚建完类型紧接着要做的事 ——
      筛不到它就得一条条翻。
    */
    /*
      ⛔ 判据是"有没有传这个数组"，不是"数组空不空"。
      用户把类型全删了时 typeIds 是 [] —— 那是合法状态，
      按"空就退回默认六个"处理的话，下拉里会冒出六个已经不存在的类型，
      勾了永远筛不到东西，而界面上看不出它们从哪来。
    */
    case 'type': return (Array.isArray(typeIds) ? [...typeIds] : TYPE_WORDS.slice()).concat([NOTYPE]);
    case 'tags': return allTags(tasks || []);
    /*
      数值列没有"候选值"可枚举，但**"没估"是个要能筛的选项** ——
      "找那些还没估工作量的"是排期前最常见的一次查询。
      它不是 0，是缺失，所以必须单列，不能混进区间里。
    */
    case 'estimate': return [UNESTIMATED];
    default: return [];
  }
}

/* ============================================================ 任务组嵌套
 *
 * 组就是一条 kind='group' 的记录，别的记录用 parent 指向它。
 * 组自己也可以有 parent —— 于是可以一直套下去。
 *
 * 为什么不让 group 单独成一个数组：那样"把两条任务并成一个组"
 * 就要在两种数据结构之间搬，而分组/拆组是高频操作。
 */

/**
 * id → 任务的索引。
 *
 * 顺带**认领**父子关系：一个 id 被两条记录同时指为 parent 时，
 * 只认第一个。不认的话同一个任务会在两处各显示一遍，
 * 状态还各自独立 —— 改了一处另一处不动。
 *
 * 顺带**截断环**：A 的父是 B、B 的父是 A 这种（AI 拼 JSON 时不校验全局唯一，
 * 很容易写出），不截断会让下面的路径构造永远退不出去。
 */
export function indexTasks(tasks) {
  const byId = Object.create(null);
  for (const t of tasks || []) byId[t.id] = t;
  const parentOf = Object.create(null);
  for (const t of tasks || []) {
    const p = t.parent;
    if (!p || !byId[p] || p === t.id) continue;
    if (parentOf[t.id] !== undefined) continue;   // 重复父级：先到先得
    parentOf[t.id] = p;
  }
  /* 断环：从每个节点往上走，一旦转回来就把这一条父指针拆掉 */
  for (const t of tasks || []) {
    const seen = new Set();
    let cur = t.id;
    while (parentOf[cur] !== undefined) {
      if (seen.has(cur)) { delete parentOf[cur]; break; }
      seen.add(cur);
      cur = parentOf[cur];
    }
  }
  return { byId, parentOf };
}

/** 从根到该节点的组链（不含自己）。是环也不会死循环 —— 构造时已断 */
export function ancestorChain(id, parentOf, limit = 32) {
  const out = [];
  const seen = new Set();
  let cur = parentOf[id];
  while (cur !== undefined && !seen.has(cur) && out.length < limit) {
    seen.add(cur);
    out.unshift(cur);
    cur = parentOf[cur];
  }
  return out;
}

/**
 * 摊平成表格行：组不占行（状态由下面决定，单独成行会显示成一个误导的值），
 * 层级显示在 path 上并按深度缩进。
 *
 * @returns {{task, depth, path, groupPath}[]}
 */
export function flattenTasks(tasks) {
  const { byId, parentOf } = indexTasks(tasks || []);
  const rows = [];
  const visit = (parentId, depth, names) => {
    for (const t of tasks || []) {
      const pid = parentOf[t.id] === undefined ? null : parentOf[t.id];
      if ((parentId || null) !== (pid || null)) continue;
      if (t.kind === 'group') {
        const next = [...names, t.title];
        visit(t.id, depth + 1, next);
        continue;
      }
      rows.push({
        task: t,
        depth,
        path: [...names],
        groupPath: names.join(' › '),
      });
    }
  };
  visit(null, 0, []);
  return rows;
}

/** 组的状态：由它下面所有任务**推导**，不存字段 */
export function groupStatus(groupId, tasks) {
  const { parentOf } = indexTasks(tasks || []);
  const kids = (tasks || []).filter((t) => {
    if (t.kind === 'group') return false;
    let cur = t.id;
    const seen = new Set();
    while (parentOf[cur] !== undefined && !seen.has(cur)) {
      seen.add(cur);
      if (parentOf[cur] === groupId) return true;
      cur = parentOf[cur];
    }
    return false;
  });
  if (kids.length === 0) return null;
  if (kids.every((t) => t.status === 'done')) return 'done';
  if (kids.some((t) => t.status === 'review')) return 'review';
  if (kids.some((t) => t.status === 'doing')) return 'doing';
  if (kids.some((t) => t.status === 'claimed')) return 'claimed';
  return 'todo';
}

/* ============================================================ 前置任务
 *
 * 锁定状态是**算出来的**，不存字段。
 *
 * 存的话就有两份真相：前置标成 done 之后，这条的 locked 字段
 * 若没人同步，界面永远显示"被卡住" —— 那种错查不出原因。
 */

/** 一条任务/组是否算"完成"。组 = 它下面全部完成 */
export function isDone(id, tasks, ctx) {
  const t = ctx.byId[id];
  if (!t) return false;                       // 已删除：算没完成
  if (t.kind === 'group') {
    const kids = (tasks || []).filter((x) => x.kind !== 'group' && parentChainHas(x.id, id, ctx.parentOf));
    return kids.length > 0 && kids.every((x) => x.status === 'done');
  }
  return t.status === 'done';
}

function parentChainHas(id, want, parentOf) {
  const seen = new Set();
  let cur = parentOf[id];
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    if (cur === want) return true;
    cur = parentOf[cur];
  }
  return false;
}

/**
 * 这条被哪些前置卡住。
 *
 * @returns {{locked:boolean, pending:string[], missing:string[], cyclic:boolean}}
 *   pending —— 存在但还没完成
 *   missing —— 引用了不存在的 id（前置被删了）
 *   cyclic  —— 互相依赖成环，永远等不到解锁
 */
export function lockOf(task, tasks) {
  const ctx = indexTasks(tasks || []);
  const deps = task?.deps || [];
  const pending = [];
  const missing = [];
  for (const d of deps) {
    if (!ctx.byId[d]) { missing.push(d); continue; }
    if (!isDone(d, tasks, ctx)) pending.push(d);
  }
  /* 成环检测：只在有前置时才跑 —— 没有依赖的任务不可能成环，
     几百条任务时这笔开销全白花 */
  let cyclic = false;
  if (deps.length > 0) {
    const seen = new Set();
    const walk = (id, depth) => {
      if (depth > 64) return true;
      if (seen.has(id)) return true;
      seen.add(id);
      const t = ctx.byId[id];
      if (!t) return false;
      for (const d of t.deps || []) {
        if (walk(d, depth + 1)) return true;
      }
      seen.delete(id);
      return false;
    };
    cyclic = walk(task.id, 0);
  }
  return {
    locked: pending.length > 0 || missing.length > 0 || cyclic,
    pending,
    missing,
    cyclic,
  };
}

/**
 * 按列排序（作用在**摊平行**上）。
 *
 * 与 sortTasksBy 的区别：它认 groupPath，且排序后同组的挨在一起
 * （groupPath 相同则按深度、再按 id），不会把同一个组下的任务打散。
 */
export function sortRowsBy(rows, field, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  const cmp = (ra, rb) => {
    let r = 0;
    switch (field) {
      case 'groupPath':
        r = String(ra.groupPath || '').localeCompare(String(rb.groupPath || ''), 'zh-Hans-CN');
        if (r === 0) r = ra.depth - rb.depth;
        break;
      case 'summary':
        r = String(ra.task.summary || '').localeCompare(String(rb.task.summary || ''), 'zh-Hans-CN');
        break;
      default:
        r = 0;
    }
    if (r !== 0) return r * sign;
    return cmpTask(ra.task, rb.task, field, sign);
  };
  return [...rows].sort(cmp);
}

/** 落到任务字段上的比较（sortTasksBy 与 sortRowsBy 共用，不写两遍） */
function cmpTask(a, b, field, sign) {
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
    case 'type':
      /*
        按默认清单的顺序排，不按字典序 ——
        按拼音排出来是"BUG/优化/开发/调研"，看着像随机。
        自定义类型不在表里，落 99 排最后（它们之间的先后没意义），
        未分类同理恒排最后：它是"还没归类"，不该混在中间。
      */
      r = (TYPE_RANK[a.type] ?? 99) - (TYPE_RANK[b.type] ?? 99)
        || (a.type ? 0 : 1) - (b.type ? 0 : 1);
      break;
    case 'estimate':
      r = (Number(a.estimate) || 0) - (Number(b.estimate) || 0);
      break;
    case 'title':
      r = a.title.localeCompare(b.title, 'zh-Hans-CN');
      break;
    case 'id':
      r = a.id.localeCompare(b.id);
      break;
    case 'tags': {
      const ta = (a.tags || []).slice().sort().join(',');
      const tb = (b.tags || []).slice().sort().join(',');
      r = ta.localeCompare(tb, 'zh-Hans-CN');
      break;
    }
    default:
      r = 0;
  }
  if (r !== 0) return r * sign;
  if (field === 'updatedAt' || field === 'createdAt') return a.id.localeCompare(b.id);
  return (b.updatedAt || 0) - (a.updatedAt || 0);
}

/* ============================================================ 合并成组 */

/**
 * 把若干任务并进一个新组。
 *
 * 组**新建**在给定的父组下（parentId 为空则建在顶层），
 * 被合并的任务改挂到它下面 —— 于是可以一层层套下去。
 *
 * ⛔ 跳过被合并任务里的**组**：把组塞进组会让"组里有组"和
 * "任务被归拢"两种语义混在一起，而合并通常指"这几条活归成一批"。
 *
 * ⛔ 跳过祖先：把 A 并进一个挂在 A 下面的组，等于让 A 成为自己的祖先，
 * 之后任何沿父链向上走的代码都会绕不出来。
 *
 * @returns {{tasks, groupId}}
 */
export function mergeIntoGroup(tasks, ids, title, parentId = null) {
  const list = tasks || [];
  const want = new Set(ids || []);
  const { byId, parentOf } = indexTasks(list);
  const groupId = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const group = normalizeTask({
    id: groupId,
    title: title || '新任务组',
    kind: 'group',
    parent: parentId || null,
    deps: [],
    status: 'todo',
    priority: 'P2',
    tags: [],
    reporter: 'manual',
    assignee: null,
    createdAt: now,
    updatedAt: now,
    history: [],
  });
  const out = [group];
  for (const t of list) {
    if (!want.has(t.id)) { out.push(t); continue; }
    if (t.kind === 'group') { out.push(t); continue; }                 // 不合并组
    if (isAncestor(groupId, t.id, parentOf, byId)) { out.push(t); continue; }
    out.push({ ...t, parent: groupId, updatedAt: now });
  }
  return { tasks: out, groupId };
}

/** a 是否是 b 的祖先（沿父链向上找） */
export function isAncestor(a, b, parentOf, byId) {
  const seen = new Set();
  let cur = parentOf[b];
  while (cur !== undefined && !seen.has(cur)) {
    seen.add(cur);
    if (cur === a) return true;
    cur = parentOf[cur];
  }
  return false;
}

/**
 * 新建一个空组（之后再把任务拖/指派进去）。
 *
 * ⛔ 不能建在自己下面 —— 那会当场成环。
 */
export function createGroup(tasks, title, parentId = null) {
  const list = tasks || [];
  const groupId = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const group = normalizeTask({
    id: groupId,
    title: title || '新任务组',
    kind: 'group',
    parent: parentId && parentId !== groupId ? parentId : null,
    deps: [],
    status: 'todo',
    priority: 'P2',
    tags: [],
    reporter: 'manual',
    assignee: null,
    createdAt: now,
    updatedAt: now,
    history: [],
  });
  return { tasks: [...list, group], groupId };
}

/**
 * 拆散一个组：组本身删掉，它下面的任务**上提一层**
 * （挂到这个组的父组下，没有父组就回到顶层）。
 *
 * 为什么不是连任务一起删：拆组是"不要这个归拢了"，
 * 不是"这些活也别干了"。删掉整棵子树是最难挽回的一种误操作。
 */
export function dissolveGroup(tasks, groupId) {
  const list = tasks || [];
  const { parentOf } = indexTasks(list);
  const g = list.find((t) => t.id === groupId);
  if (!g || g.kind !== 'group') return { tasks: list };
  const now = Date.now();
  const out = [];
  for (const t of list) {
    if (t.id === groupId) continue;
    if (parentOf[t.id] === groupId) {
      out.push({ ...t, parent: g.parent || null, updatedAt: now });
      continue;
    }
    out.push(t);
  }
  return { tasks: out };
}

/**
 * 把一个任务拆成若干子任务。
 *
 * 原任务**变成组**（保留它的 id —— 这样依赖它、引用它的地方不用改），
 * 子任务新建在它下面。于是可以一直拆下去：子任务本身也能再拆。
 *
 * 为什么不保留原任务为"活"、另建子任务：
 *   那样原任务与子任务会并存，两边都有进度，
 *   而"这条到底算做完了没有"要看哪一边就成了新的问题。
 *   变成组之后，组的状态由子任务推导，只有一个答案。
 *
 * @returns {{tasks, groupId, childIds}}
 */
export function splitTask(tasks, id, titles) {
  const list = tasks || [];
  const names = (titles || []).map((x) => String(x || '').trim()).filter(Boolean);
  const src = list.find((t) => t.id === id);
  if (!src || names.length === 0) return { tasks: list, groupId: '', childIds: [] };
  const now = Date.now();
  const childIds = [];
  const kids = names.map((title, i) => {
    const cid = `sub_${id}_${i + 1}_${Math.random().toString(36).slice(2, 6)}`;
    childIds.push(cid);
    /*
      子任务继承父任务的**上下文**（标签、优先级、认领人），
      但不继承状态、前置与预估 ——
      继承状态会让几条新子任务一出生就是"已完成"；
      继承前置会让它们全部卡在同一处；
      继承预估则更糟：父任务 5 人日拆成 3 条，
      三条各带 5 → 合计变 15，**工作量凭空翻了三倍**。

      ⛔ 子任务的预估必须留空让人重填 —— 拆分时没人知道那 5 人日该在三块之间怎么分。
      （父任务变成组后，组的预估由子任务累加得出，所以父那条也一并清零。）
    */
    return normalizeTask({
      ...src,
      id: cid,
      title,
      kind: 'task',
      parent: id,
      deps: [],
      summary: '',
      status: 'todo',
      estimate: 0,
      createdAt: now,
      updatedAt: now,
      history: [],
    });
  });
  /*
    父任务变成组：状态/前置/标签/认领人清空（组的这些由下面推导），
    预估也清零 —— 组的预估 = 子任务累加，留着原值会双计。
  */
  const out = list.map((t) => (t.id === id
    ? { ...t, kind: 'group', deps: [], tags: [], assignee: null, estimate: 0, updatedAt: now }
    : t));
  return { tasks: [...out, ...kids], groupId: id, childIds };
}

/**
 * 一个组的预估工作量 = 它下面**所有层**叶子任务的和。
 *
 * 组自己不存预估 —— 存了就有两个可改的地方，改了子任务组不变、
 * 改了组子任务不动，最后不知道该信哪个。组是容器，工作量永远从底下算。
 *
 * 逐层累加而不是只算直接子任务：拆分出来的嵌套组，
 * 只看一层会把下面几层的活全漏掉，合计偏小。
 */
export function groupEstimate(groupId, tasks) {
  const ctx = indexTasks(tasks || []);
  let sum = 0;
  for (const t of tasks || []) {
    if (t.kind === 'group') continue;
    if (parentChainHas(t.id, groupId, ctx.parentOf)) sum += Number(t.estimate) || 0;
  }
  return Math.round(sum * 100) / 100;
}

/** 全部任务的工作量合计（组不计 —— 会计双份） */
export function totalEstimate(tasks) {
  let sum = 0;
  for (const t of tasks || []) if (t.kind !== 'group') sum += Number(t.estimate) || 0;
  return Math.round(sum * 100) / 100;
}

/* ============================================================ 任务类型
 *
 * 类型**由用户在界面上增删改名调色**，默认这六个只是初始值。
 * 与标签同构（定义表 + 任务上只存 id），两处共用一套颜色 -- 改一处所有行一起变。
 */

export const DEFAULT_TYPES = [
  { id: 'dev', name: '开发', color: '#3b82f6' },
  { id: 'bug', name: 'BUG', color: '#ef4444' },
  { id: 'opt', name: '优化', color: '#22c55e' },
  { id: 'research', name: '调研', color: '#a855f7' },
  { id: 'review', name: '审查', color: '#f59e0b' },
  { id: 'plan', name: '规划', color: '#0ea5e9' },
];

const TYPE_COLORS = Object.fromEntries(DEFAULT_TYPES.map((t) => [t.id, t.color]));
/** 默认类型的 id 清单（顺序即排序权重；也是没配过定义表时的候选值） */
export const TYPE_WORDS = ['dev', 'bug', 'opt', 'research', 'review', 'plan'];

/**
 * 解析类型定义表。认两种写法：对象数组（界面写的）和纯字符串数组（手写省事）。
 * 解析不出来用默认六个 —— 不会因为配置坏了就整份任务打不开。
 */
export function normalizeTypeDefs(raw) {
  if (!Array.isArray(raw)) return DEFAULT_TYPES.map((t) => ({ ...t }));
  const seen = new Set();
  const out = [];
  for (const d of raw) {
    const o = d && typeof d === 'object' ? d : null;
    const id = o
      ? (typeof o.id === 'string' ? o.id : '')
      : (typeof d === 'string' ? d : '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: o && typeof o.name === 'string' && o.name ? o.name : id,
      color: o && typeof o.color === 'string' && o.color ? o.color : (TYPE_COLORS[id] || '#78716c'),
    });
  }
  /*
    ⛔ 空数组必须**认**，不能补回默认六个。

    "没有类型"是用户的合法选择（他就是不想分类），
    而"没有这个字段"是老存档 —— 只有后者该补默认值。
    混为一谈的结果是：用户把六个默认类型全删了，刷新一下它们又回来了，
    界面上表现为"删不掉"，而没人会想到是兜底逻辑在作怪。
    （标签那边 normalizeTagDefs 空数组就认，两边要一致。）
  */
  return out;
}

export function typeName(defs, id) {
  const d = (defs || []).find((x) => x.id === id);
  return d ? d.name : (id || '');
}

export function typeColor(defs, id) {
  const d = (defs || []).find((x) => x.id === id);
  return (d && d.color) || TYPE_COLORS[id] || '#78716c';
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
/** 未填类型的哨兵 key（仅 type 分组时使用） */
export const NOTYPE = '__notype__';

const STATUS_RANK = Object.fromEntries(STATUSES.map((s, i) => [s, i]));
/*
  类型排序按**默认清单**的顺序（开发→BUG→优化→…），不是字典序 ——
  按拼音排出来是"BUG/优化/开发/调研"，看着像随机。
  用户自定义的类型不在表里，落 99 排最后（它们的先后没意义）。
*/
const TYPE_RANK = Object.fromEntries(TYPE_WORDS.map((t, i) => [t, i]));

/**
 * 分组：status / priority / assignee / tag
 * - status / priority：按 STATUSES / PRIORITIES 固定顺序，只返回非空组
 * - assignee：未认领（__none__）恒置顶，其余按组内数量倒序
 * - tag：并集语义（一个任务带 N 个标签就同时进 N 个组），按数量倒序
 *
 * 只返回 key 不返回 label —— 标签文案由 UI 层映射 types.ts 的
 * STATUS_LABEL / PRIORITY_LABEL，避免同一份映射抄两处后漂移。
 */
/** 一条任务在某个分组依据下属于哪些组（标签是多值的，会同时进多个组） */
export function groupValuesOf(t, key) {
  if (key === 'status') return [t.status];
  if (key === 'priority') return [t.priority];
  if (key === 'assignee') return [t.assignee || UNASSIGNED];
  if (key === 'type') return [t.type || NOTYPE];
  if (key === 'tag') return t.tags.length > 0 ? t.tags : [NOTAG];
  return [''];
}

function sortGroups(groups, key) {
  if (key === 'status') {
    groups.sort((a, b) => (STATUS_RANK[a.key] ?? 9) - (STATUS_RANK[b.key] ?? 9));
  } else if (key === 'priority') {
    groups.sort((a, b) => PRIORITIES.indexOf(a.key) - PRIORITIES.indexOf(b.key));
  } else if (key === 'assignee') {
    groups.sort((a, b) => {
      if (a.key === UNASSIGNED) return -1;
      if (b.key === UNASSIGNED) return 1;
      return b.count - a.count || a.key.localeCompare(b.key);
    });
  } else if (key === 'type') {
    /* 未分类置尾：它是"没填"，不该顶在前面 */
    groups.sort((a, b) => {
      if (a.key === NOTYPE) return 1;
      if (b.key === NOTYPE) return -1;
      return (TYPE_RANK[a.key] ?? 99) - (TYPE_RANK[b.key] ?? 99) || b.count - a.count;
    });
  } else if (key === 'tag') {
    // __notag__ 是伪分组，显式置尾 —— 不能靠 '__' 碰 collation 运气
    groups.sort((a, b) => {
      if (a.key === NOTAG) return 1;
      if (b.key === NOTAG) return -1;
      return b.count - a.count || a.key.localeCompare(b.key);
    });
  } else {
    groups.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  }
}

/**
 * 按**多列**分组，列的顺序就是层级（第一个是最外层）。
 *
 * 为什么允许好几层：单层只能回答"按状态分"，而常见的问法是
 * "按类型分，每个类型里再按状态看" —— 只支持一层的话要点两次，
 * 而且第二次会丢掉第一次的选择。
 *
 * 返回树：中间层是 `children`，叶子是 `tasks`。
 * ⛔ 中间层的 `tasks` 会被清空并折算进 `count`：
 *    不清的话同一条任务会在父层与子层各渲染一次，
 *    而父层标题上的数字又是子层之和，看着像凭空多了一倍。
 *
 * 传单个字符串也认（等价于只分一层）—— 兼容老调用点。
 */
export function groupTasksBy(tasks, keys) {
  const ks = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  const list = tasks || [];
  if (ks.length === 0) {
    return [{ key: '', depth: 0, count: list.length, tasks: list.slice(), children: [] }];
  }

  const build = (rows, depth) => {
    const key = ks[depth];
    const groups = [];
    const index = new Map();
    for (const t of rows) {
      for (const v of groupValuesOf(t, key)) {
        let g = index.get(v);
        if (!g) {
          g = { key: v, depth, count: 0, tasks: [], children: [] };
          index.set(v, g);
          groups.push(g);
        }
        g.tasks.push(t);
        g.count += 1;
      }
    }
    sortGroups(groups, key);
    if (depth < ks.length - 1) {
      for (const g of groups) {
        g.children = build(g.tasks, depth + 1);
        g.tasks = [];   // 中间层不装任务（理由见上）
      }
    }
    return groups;
  };
  return build(list, 0);
}

/** 单列分组（老接口，等价于只给一列） */
export function groupTasks(tasks, key) {
  return groupTasksBy(tasks, [key]);
}

/**
 * 多字段排序（列表 / 分组视图的表头与组内排序共用）
 * 字段：priority / status / assignee / updatedAt / createdAt / title / id
 * 方向：'asc' | 'desc'（默认 asc）
 * - assignee：未认领恒排最后，与方向无关
 * - 同级兜底：更新时间倒序（新的在前）；排时间字段本身时按 id 升序保稳定
 */
/*
 * 按任意列排序（看板用）。
 *
 * ⚠️ 这里**复用 cmpTask**，不再自己写一份 switch。
 * 此前这里与 cmpTask 各有一份字段分支 —— 加「任务类型」时只改了其中一份，
 * 于是同一列在列表里能排、在看板里排不动，而界面上看不出差别。
 * 两份排序逻辑迟早要分叉，这是必然的，不是"小心点就行"。
 */
export function sortTasksBy(tasks, field, dir = 'asc') {
  const sign = dir === 'desc' ? -1 : 1;
  return [...tasks].sort((a, b) => {
    /*
      sign 直接交给 cmpTask，不在外面再乘一次。
      cmpTask 里"未认领恒排最后"是提前 return（刻意不带 sign）——
      外面再乘一次就会在降序时把它翻到最前面，那条保证就没了。
    */
    const r = cmpTask(a, b, field, sign);
    if (r !== 0) return r;
    /*
      兜底保持看板原有的手感：同分时更新时间新的在前，再同分按优先级。
      不加优先级的话，改完这一处会发现看板里同一列的任务
      顺序变得跟以前不一样，而没人动过排序设置。
    */
    const byTime = (b.updatedAt || 0) - (a.updatedAt || 0);
    if (byTime !== 0) return byTime;
    return (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
  });
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
  const estimateByStatus = {};
  const byType = {};
  const byPriority = {};
  for (const s of flowOf(store.flow).statuses) byStatus[s.id] = 0;
  for (const p of PRIORITIES) byPriority[p] = 0;
  const byAssignee = new Map();
  const tagCnt = new Map();
  const stale = [];
  for (const t of tasks) {
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    if (t.kind !== 'group') {
      estimateByStatus[t.status] = Math.round(
        ((estimateByStatus[t.status] || 0) + (Number(t.estimate) || 0)) * 100,
      ) / 100;
      /* 类型分布：未分类也单独计 —— 那是"还没归类的工作量"，排期时要看得见 */
      const tk = t.type || NOTYPE;
      byType[tk] = (byType[tk] || 0) + 1;
    }
    byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
    const who = t.assignee || UNASSIGNED;
    const ae = byAssignee.get(who) || { id: who, count: 0, est: 0 };
    ae.count += 1;
    /* 组不计 —— 组的工作量是子任务的和，算进来会双份 */
    if (t.kind !== 'group') ae.est = Math.round((ae.est + (Number(t.estimate) || 0)) * 100) / 100;
    byAssignee.set(who, ae);
    for (const tag of t.tags) tagCnt.set(tag, (tagCnt.get(tag) || 0) + 1);
    if (!statusDone(store.flow, t.status) && (now - (t.updatedAt || 0)) > STALE_MS) stale.push(t);
  }
  const assignees = [...byAssignee.entries()]
    .sort((a, b) => {
      if (a[0] === UNASSIGNED) return -1;
      if (b[0] === UNASSIGNED) return 1;
      return b[1].count - a[1].count || a[0].localeCompare(b[0]);
    })
    .map(([, v]) => ({ id: v.id, count: v.count, est: v.est }));
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
    estimateByStatus,
    byType,
    estimateTotal: totalEstimate(tasks),
    byPriority,
    byAssignee: assignees,
    topTags,
    recent: recent.slice(0, 8),
    stale,
    agents: store.agents || [],
  };
}

/* ============================================================ 项目（多任务库）
 *
 * 一个项目 = 一份**独立**的 tasks.json（自己的数据目录）+ 自己的文档路径。
 * 切项目就是换数据目录 —— 项目之间任务互不可见，各自的流程配置、标签、
 * 身份表也是独立的。
 *
 * 为什么不做成"一个库 + 一个 project 字段"：
 * 那样文档路径只能有一份，删项目时文档的归属没法处理；
 * 而且筛选稍一漏条件就会串出别的项目任务，且看不出是漏了条件。
 */

/** 新项目 id：p1 / p2… 取现有最大序号 +1（比随机串好认，AI 写配置时看得懂） */
export function newProjectId(seenIds) {
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
  let n = seen.size + 1;
  while (seen.has(`p${n}`)) n += 1;
  return `p${n}`;
}

/**
 * 归一化插件配置（含项目列表）。
 *
 * 两个必须在这里处理干净的事：
 *
 * ① **老配置迁移**：以前只有单个 dataDir，没有项目列表。
 *    读到没有 projects 的配置就把它当成"唯一那个项目"，
 *    老用户的任务不会凭空消失（否则升级后打开是空看板，
 *    而任务其实还在盘上，那种错最难自查）。
 *
 * ② **dataDir / docsDir 是派生字段，但要能反向写回**。
 *    设置页是直接 `setCfg({ ...cfg, dataDir: 新值 })` 改这两个字段的，
 *    若归一化只做单向派生，用户在设置里改目录就会"保存了没反应"。
 *    所以这里比对：传进来的值与当前项目的不一致，就认它是显式修改，写回去。
 */
export function normalizeConfig(raw) {
  const c = raw && typeof raw === 'object' ? raw : {};
  const seen = new Set();
  const projects = [];
  const list = Array.isArray(c.projects) ? c.projects : [];
  for (const one of list) {
    const p = one && typeof one === 'object' ? one : {};
    let id = typeof p.id === 'string' ? p.id.trim() : '';
    if (!id || seen.has(id)) id = newProjectId(seen);   // 缺 id 或重号都补一个
    seen.add(id);
    const name = typeof p.name === 'string' && p.name.trim()
      ? p.name.trim()
      : `项目 ${projects.length + 1}`;
    projects.push({
      id,
      name,
      dataDir: typeof p.dataDir === 'string' ? p.dataDir : '',
      docsDir: typeof p.docsDir === 'string' ? p.docsDir : '',
    });
  }
  if (projects.length === 0) {
    /* 迁移：老配置（或空的）→ 唯一一个项目。名字不叫"默认"以外的花活，
       因为这是老用户看到的第一眼，得能对上他原来的那堆任务。 */
    projects.push({
      id: 'p1',
      name: '默认项目',
      dataDir: typeof c.dataDir === 'string' ? c.dataDir : '',
      docsDir: typeof c.docsDir === 'string' ? c.docsDir : '',
    });
  }

  let currentId = typeof c.currentId === 'string' ? c.currentId : '';
  /* 选中的项目不存在（被删了 / 配置被手改过）→ 回落第一个。
     不回落的话切过去什么都读不到，而界面上看不出是"项目没了"还是"任务空了" */
  if (!projects.some((p) => p.id === currentId)) currentId = projects[0].id;
  const cur = projects.find((p) => p.id === currentId) || projects[0];

  if (typeof c.dataDir === 'string' && c.dataDir && c.dataDir !== cur.dataDir) {
    cur.dataDir = c.dataDir;
  }
  if (typeof c.docsDir === 'string' && c.docsDir !== cur.docsDir) {
    cur.docsDir = c.docsDir;   // 允许清空 —— 清空是"这个项目不挂文档"
  }

  const port = Number.isFinite(Number(c.port)) ? Number(c.port) : 9911;
  return {
    projects,
    currentId: cur.id,
    /* 派生：给既有调用点用（全仓都是 cfg.dataDir）。
       两份真相的代价由上面的反向写回兜住。 */
    dataDir: cur.dataDir,
    docsDir: cur.docsDir,
    port: port >= 1024 && port <= 65535 ? port : 9911,
    token: typeof c.token === 'string' ? c.token : '',
    autoStart: c.autoStart === true,
    notifyUrl: typeof c.notifyUrl === 'string' ? c.notifyUrl : '',
  };
}

/** 当前项目对象 */
export function currentProject(cfg) {
  const c = cfg && cfg.projects ? cfg : normalizeConfig(cfg);
  return c.projects.find((p) => p.id === c.currentId) || c.projects[0];
}

/**
 * 这个项目还没设文档路径吗。
 *
 * 提醒的判据就这一条 —— 新建项目时顺带给提示也好、建第一个任务时提醒也好，
 * 都用同一个判据，不会出现"新建时提醒了、建任务时又提醒一遍"的重复打扰。
 */
export function needsDocsDir(cfg) {
  const p = currentProject(cfg);
  return !!(p && !p.docsDir);
}

/** 给新建的定义项起个不撞号的 id（t1/t2…、s1/s2…） */
export function newDefId(prefix, seenIds) {
  const seen = seenIds instanceof Set ? seenIds : new Set(seenIds || []);
  let n = 1;
  while (seen.has(`${prefix}${n}`)) n += 1;
  return `${prefix}${n}`;
}
