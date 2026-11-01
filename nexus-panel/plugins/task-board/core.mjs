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
  /*
    ⛔ 同样要先 Number() 再判（与 estimate 同一个坑）：
    时间戳在 JSON 里写成字符串（`"createdAt": "1700000000000"`）很常见，
    `Number.isFinite("1700000000000")` 是 false → 落到默认值 0。
    于是那条任务**没有创建时间**：不参与日期区间筛选、
    在"按创建排序"里永远垫底 —— 而用户明明填了。
  */
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  /*
    文本字段**一律 trim**。

    ⛔ 不 trim 的后果（AI 手写 JSON / 表单提交里很常见）：
    · `assignee: "   "` —— 全空格。而"有没有认领人"的判据是 truthy，
      于是它被当成**有人认领**：界面显示一个空白的名字，
      筛"未认领"筛不到它，分组里多出一个名字是三个空格的组，
      统计里多一个空白认领人。全都是看不见的实体。
    · `group: "  "` / `tags: ["", "  "]` 同理 —— 空白名字的分组、
      零宽度的标签 chip。

    这类值不报错，只在界面上表现为"有个东西但看不见它是什么"。
  */
  const str = (v, d) => (typeof v === 'string' ? v.trim() : d);
  /* id 列表：去空白 + 去空 + 去重（排序保持原顺序） */
  const ids = (v) => {
    if (!Array.isArray(v)) return [];
    const seen = new Set();
    const out = [];
    for (const x of v) {
      if (typeof x !== 'string') continue;
      const y = x.trim();
      if (!y || seen.has(y)) continue;
      seen.add(y);
      out.push(y);
    }
    return out;
  };
  /*
    parent / deps 指向的 id 可能已经不存在（任务被删了）。
    这里**不清理**引用：清了就无从知道"这里原本挂着什么"，
    而界面上显式标出"前置已被删除"比静默消失要好 ——
    后者会让人以为这条本来就没有前置。
  */
  return {
    id: typeof t.id === 'string' ? t.id : '',
    title: str(t.title, '') || '(无标题)',
    summary: str(t.summary, ''),
    detail: str(t.detail, ''),
    kind: t.kind === 'group' ? 'group' : 'task',
    parent: str(t.parent, '') || null,
    /*
      ⛔ 空 id 与重复 id 都要去掉：
      · 空 id 的依赖永远解锁不了（它指向 nothing）
      · 重复会让"有 N 条前置"的计数虚高
      （"清理不存在的引用"是另一回事 —— 那要保留，见上方注释）
    */
    deps: ids(t.deps),
    /*
      状态**不校验白名单**：自定义状态是用户自己起的 id，
      这里按固定清单过滤的话，用户新增的状态会被悄悄退回 todo。
      展示层查不到就原样显示 id —— 认不出来比认错要好。
    */
    /* 状态 id 也要 trim：`"status": " done"` 在配置里查不到，会显示成原始值 */
    status: str(t.status, '') || 'todo',
    priority: PRIORITIES.includes(t.priority) ? t.priority : 'P2',
    /*
      预估工作量，单位**人日**，允许小数（半天 = 0.5）。
      不设上限也不校验整数 —— 任务大到几十人日、小到 0.25 都有，
      强校验只会逼人去备注里偷偷记，那就没法汇总了。
      负数按 0 处理：负的工作量没有意义，且会把合计往回拉。

      ⛔ 必须**先 Number() 再判**：JSON 里写 `"estimate": "2.5"`
      （字符串）是完全正常的写法 —— 表单提交、AI 手写 JSON 都常这样。
      而 `Number.isFinite("2.5")` 是 **false**，于是它被静默当成 0（没估）。

      用户/AI 明明填了 2.5 人日，界面显示"没估"、统计里也不计 ——
      不报错，只是那一列空着，没人会想到是类型问题。
      （前端 store.createTask 那边一直用的是 Number(draft.estimate)，
       所以界面建的没问题；只有直接写 JSON 和读盘这两条路径中招。）
    */
    estimate: (() => {
      const n = Number(t.estimate);
      return Number.isFinite(n) && n > 0 ? n : 0;
    })(),
    /*
      任务类型存的是**定义表里的 id**（'dev'/'bug'…），不是显示名。
      存名字的话改个名就要回头改所有任务，而且改名后旧名变成没人认的孤值。
      ⛔ 同样不校验白名单：用户新增的类型要能活下来，
      这里按默认清单过滤会把新增类型悄悄清空。
    */
    type: str(t.type, ''),
    /*
      分组列。相当于以前的"手动分组"，但**只是一列值** ——
      不再有组记录、也不再有父子层级；归拢关系由通用的"按列分组"机制表达。
      这样更通用：它能和任意其它列一起组成多层级（先按分组、再按状态…），
      而旧的手动组只能一层层嵌套，且两种层级会并存打架。
    */
    group: str(t.group, ''),
    /* 同 deps：空标签会渲染成零宽度的 chip，重复标签会显示两个一样的 */
    tags: ids(t.tags),
    reporter: str(t.reporter, '') || 'manual',
    /*
      ⛔ 必须**先 trim 再判空**：`"   "` 是 truthy，
      不 trim 的话它会被当成"有人认领" —— 于是界面显示一个空白的名字，
      筛"未认领"筛不到它，分组和统计里各多一个空白认领人。
    */
    assignee: str(t.assignee, '') || null,
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

/*
  分组定义表。与标签/类型同构（id / name / color），但**id 就是名字**。

  ⛔ 为什么不用 tg_xxxx 那种独立 id：任务的 group 字段从一开始存的
  就是**名字**字符串（'登录'），历史数据里全是名字。换成独立 id 要迁移
  所有任务的 group —— 而迁移一旦半途中断，数据就一半 id 一半名字，
  那种混合态比现在难查得多。

  代价是"改名"要连带改任务上的字符串（而标签改名只改定义）。
  但分组名本来就短、数量也少，这个代价可以接受。
*/
/** 分组的显示名：定义表里的 name，没有定义就原样（裸名字照样能看） */
export function groupName(defs, id) {
  const d = (defs || []).find((x) => x.id === id);
  return d ? d.name : (id || '');
}

/** 分组的颜色：没定义就是空（渲染时退回中性色，不硬塞一个假色） */
export function groupColor(defs, id) {
  const d = (defs || []).find((x) => x.id === id);
  return d && d.color ? d.color : '';
}

export function normalizeGroupDefs(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const d of raw) {
    /* 纯字符串（手写真省事）：{"groupDefs":["登录","支付"]} */
    if (typeof d === 'string') {
      const nm = d.trim();
      if (!nm || seen.has(nm)) continue;
      seen.add(nm);
      out.push({ id: nm, name: nm, color: '#78716c' });
      continue;
    }
    if (!d || typeof d !== 'object') continue;
    const id = typeof d.id === 'string' ? d.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: typeof d.name === 'string' && d.name.trim() ? d.name.trim() : id,
      color: typeof d.color === 'string' && d.color ? d.color : '#78716c',
    });
  }
  return out;
}

export function normalizeStore(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  /*
    数值字段同样先 Number() 再判（理由见 normalizeTask 里的 estimate）：
    JSON 里把它们写成字符串很常见，而 Number.isFinite("3") 是 false
    → 静默落到默认值。

    ⛔ nextId 尤其不能静默回落：它决定下一条任务的 id。
    回落到 1 的话，新建任务的 id 会和已有任务**撞号** ——
    而 id 是依赖、历史、筛选的键，撞号之后改一条会动到另一条。
  */
  const numOr = (v, d) => {
    const x = Number(v);
    return Number.isFinite(x) ? x : d;
  };
  return {
    v: numOr(s.v, 1),
    nextId: numOr(s.nextId, 0) > 0 ? Math.floor(numOr(s.nextId, 0)) : 1,
    tasks: Array.isArray(s.tasks) ? s.tasks.map(normalizeTask) : [],
    agents: Array.isArray(s.agents)
      ? s.agents
          .filter((a) => a && typeof a.id === 'string' && a.id)
          .map((a) => ({
            id: a.id,
            name: typeof a.name === 'string' && a.name ? a.name : a.id,
            role: typeof a.role === 'string' && a.role ? a.role : 'dev',
            lastSeen: numOr(a.lastSeen, 0),
          }))
      : [],
    tagDefs: normalizeTagDefs(s.tagDefs),
    typeDefs: normalizeTypeDefs(s.typeDefs),
    groupDefs: normalizeGroupDefs(s.groupDefs),
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
    分组**定义表驱动**（'enum'），不再当自由文本。

    原来是 'text'：列头漏斗里只有一个关键词框，
    于是"这一列有哪些分组"根本看不到，更谈不上增删改色 ——
    而分组恰恰是最需要"从已有项里挑一个"的字段
    （同一批任务要归到同一个组，靠手打必然打出 '登录' / '登陆' 两种写法）。
  */
  { field: 'group', label: '分组', kind: 'enum' },
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
/*
  ⛔ 不能再用 '__none__'：那和 UNASSIGNED（未认领）是**同一个值**。

  两个不同的"空值"概念共用一个哨兵，现在是靠"它们分属不同的列"
  才没出事 —— 而 groupLabel 这类地方是**按值判断**的：
  `if (key === UNASSIGNED) return '未认领'` 在 by='estimate' 时
  会把"没估"那组标成"未认领"。
  目前 estimate 不在分组依据里所以还没触发，但这是个等着踩的坑。

  筛选不持久化，改值不会影响存档。
*/
export const UNESTIMATED = '__noestimate__';

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
    /*
      未认领统一用 **UNASSIGNED 哨兵**，不用空串。

      ⛔ 空串不行：分组那条路径上 `key === ''` 已经被
      "没选任何分组依据 → 全部任务"占用了（见 groupLabel），
      两个含义撞在同一个值上，分不清是"没人认领"还是"没分组依据"。

      而筛选这边原来用 ''、分组那边用 '__none__' ——
      同一件事两个哨兵，各改一处就会错（筛得到但分组分不出，或反之）。
    */
    case 'assignee': return [task.assignee || UNASSIGNED];
    /* 空类型落到 NOTYPE 哨兵，这样"未分类"才筛得到 */
    case 'type': return [task.type || NOTYPE];
    case 'tags': return task.tags || [];
    /*
      分组改成 enum 之后**必须**在这里返回值。
      漏掉的话该列筛选 100% 失效（候选为空、勾了也不命中），
      而界面只显示"没有符合条件的任务"——看着像真的没有。
      未分组落 NOGROUP 哨兵，这样"没归类的"能筛出来集中处理。
    */
    case 'group': return [task.group || NOGROUP];
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
export function filterTasksByColumns(rows, filters, q, typeDefs, tagDefs) {
  const active = LIST_COLUMNS.filter((c) => colFilterActive(c, filters[c.field]));
  const kw = (q || '').trim().toLowerCase();
  if (active.length === 0 && !kw) return rows;
  return rows.filter((row) => {
    for (const c of active) {
      if (!matchesCol(row, c, filters[c.field])) return false;
    }
    if (kw) {
      const t = row.task;
      /*
        ⛔ 分组名**必须在搜索范围里**：
        列表里明明有一列显示着"登录"，在上面敲"登录"却搜不到 ——
        那是最让人怀疑的一种"搜不到"（看得见的东西搜不着）。

        分组是自由文本，用户敲的就是那个词；
        而它这一列虽然能筛（列头漏斗），但顶栏这个框是更常用的入口。

        ⛔ 标签**不进**搜索：任务上存的是 id（tg_xxxx），
        搜 id 没有意义；要按标签找请用标签列上的筛选（那儿显示的是名字）。
      */
      /*
        ⛔ 认领人与**类型的显示名**必须进搜索：
        · 认领人：用户随手在搜索框打同事名字，返回 0 条 ——
          他会以为"没有这个人”，而不是"搜索不搜这个字段"。
          而认领人列上的筛选是**多选下拉**，得先知道有那一列才会用。
        · 类型：任务上存的是 id（'dev'），显示的是"开发"。
          搜 id 没意义（用户看不见 id），搜名字又搜不到 —— **两头不靠**，
          于是类型这列在搜索面前等于不存在。

        类型名要靠 typeDefs 查；没传就退回 id（至少老行为不变）。
      */
      const typeLabel = typeDefs
        ? typeName(typeDefs, t.type || '')
        : (t.type || '');
      /*
        标签名同样要进搜索串：任务上存的是 **id**（tg_xxxx），
        而界面上显示的是名字。只搜 id 的话 ——
        用户搜「重要」返回 0 条，而列表里明明有一排挂着「重要」的任务，
        他会以为没有这类任务，而不是"搜索不搜标签"。

        （这和上面 typeLabel 是完全同一个问题，
          上一轮补了认领人和类型，**标签漏了**。）
      */
      const tagLabels = (t.tags || [])
        .map((id) => (tagDefs ? (tagDefs.find((d) => d.id === id)?.name || id) : id))
        .join(' ');
      const hay = `${t.id} ${t.title} ${t.detail} ${t.summary || ''} ${t.group || ''} ${t.assignee || ''} ${typeLabel} ${tagLabels}`
        .toLowerCase();
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
export function colFilterValues(field, rows, statusIds, typeIds, tagIds, groupIds) {
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
      // 未认领置尾：它是"没人"，不该顶在名单前面。哨兵与 colRawValues 一致
      return [...names, UNASSIGNED];
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
    /*
      标签候选 = **定义表 + 数据里出现的**。

      ⛔ 只从数据里去重是不够的（原来是 allTasks）：
      用户刚新建、还没挂到任何任务上的标签在下拉里就选不到 ——
      那个标签等于建不出来（而它明明已经在定义表里了）。

      ⛔ 反过来也不能只取定义表：任务上的标签可能是个裸名字
      （老数据、或 AI 直接写进 JSON 的），没建过定义 ——
      只取定义表的话那些任务就永远筛不到，且无从看出漏了谁。
    */
    case 'tags': {
      const fromData = allTags(tasks || []);   // 不限量：筛选候选要完整
      const fromDefs = Array.isArray(tagIds) ? [...tagIds] : [];
      const out = [];
      const seen = new Set();
      for (const id of [...fromDefs, ...fromData]) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
      return out;
    }
    /*
      数值列没有"候选值"可枚举，但**"没估"是个要能筛的选项** ——
      "找那些还没估工作量的"是排期前最常见的一次查询。
      它不是 0，是缺失，所以必须单列，不能混进区间里。
    */
    /*
      分组候选 = **定义表 + 数据里出现的** + 「未分组」。

      与标签同规则：只取一边都会漏。
      · 只取数据 → 刚"添加一项"、还没任何任务归进去的分组选不到，
        那一项等于白加
      · 只取定义表 → 老数据里没建定义的裸分组名永远筛不到

      未分组必须能筛：把没归类的找出来集中处理，是建完分组紧接着要做的事。
    */
    case 'group': {
      const fromData = (tasks || []).map((t) => t.group).filter(Boolean);
      const fromDefs = Array.isArray(groupIds) ? [...groupIds] : [];
      const out = [];
      const seen = new Set();
      for (const id of [...fromDefs, ...fromData]) {
        if (!id || seen.has(id)) continue;
        seen.add(id);
        out.push(id);
      }
      return out.concat([NOGROUP]);
    }
    case 'estimate': return [UNESTIMATED];
    default: return [];
  }
}

/* ============================================================ 组（平铺迁移）
 *
 * 「任务组」从**数据结构**改成了**视图概念**：
 * 现在是"选一列作为分组依据，按那一列的值聚合显示"，
 * 数据里不再有 kind='group' 的记录，也不再有父子层级。
 *
 * 之前是手动建组（新建组 / 合并成组 / 拆分），那套东西的问题是：
 * 层级要人维护，而人维护的层级和"我现在想按状态看"这类临时视角
 * 是两件事 —— 前者改数据，后者只是换个看法。混在一起的结果是
 * 想换个看法时不得不去改数据，而改完数据又回不到原来的看法。
 */

/**
 * 把**所有手动组一次性平铺**：组记录删掉，下面的任务上提到顶层，
 * 依赖"整个组"的地方改指到组里的具体任务。
 *
 * ⛔ 依赖不能简单丢掉：deps 指向组 g 的语义是"等 g 里全部完成"，
 * 而 g 删掉之后那条依赖会变成指向一个不存在的 id ——
 * 界面上会显示成"前置已被删除"，任务永远解锁不了。
 * 所以把它展开成组内的**全部叶子任务**，语义完全等价
 * （原来"等 g 全部完成"，展开后"等 a、b、c 全部完成"）。
 *
 * @returns {{tasks, removed:number, remapped:number}}
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
/*
 * 组的状态由下面**所有层**的叶子任务推导。
 *
 * ⚠️ 必须传 flow：用户自定义流程时终态可以叫任何 id。
 * 不传的话只能按默认清单判断，自定义流程下会全部落空。
 */


export function flattenAllGroups(tasks) {
  const list = tasks || [];
  const groups = list.filter((t) => t.kind === 'group');
  if (groups.length === 0) return { tasks: list, removed: 0, remapped: 0 };
  const groupIds = new Set(groups.map((g) => g.id));
  const { parentOf } = indexTasks(list);

  /** 一个组下面的全部叶子任务（递归穿过多层组） */
  const leavesOf = (gid) => {
    const out = [];
    const seen = new Set();
    const walk = (id) => {
      if (seen.has(id)) return;          // 环：不该有，但文件是 AI 能改的
      seen.add(id);
      for (const t of list) {
        if ((parentOf[t.id] || null) !== id) continue;
        if (t.kind === 'group') walk(t.id);
        else out.push(t.id);
      }
    };
    walk(gid);
    return out;
  };
  const leafCache = new Map();
  for (const gid of groupIds) leafCache.set(gid, leavesOf(gid));

  let remapped = 0;
  const now = Date.now();
  const out = [];
  for (const t of list) {
    if (t.kind === 'group') continue;
    /*
      parent 一路往上走到第一个"不是组"的祖先。
      组全删了，所以结果必然是 null ——
      但按链走而不是直接置空，是为了文件里还有别的结构时不误判。
    */
    let p = parentOf[t.id];
    while (p !== undefined && p !== null && groupIds.has(p)) p = parentOf[p];
    const nextDeps = [];
    const seenD = new Set();
    for (const d of t.deps || []) {
      if (groupIds.has(d)) {
        remapped += 1;
        for (const leaf of (leafCache.get(d) || [])) {
          if (leaf === t.id || seenD.has(leaf)) continue;   // 不依赖自己
          seenD.add(leaf);
          nextDeps.push(leaf);
        }
        continue;
      }
      if (d === t.id || seenD.has(d)) continue;
      seenD.add(d);
      nextDeps.push(d);
    }
    const sameDeps = nextDeps.length === (t.deps || []).length
      && nextDeps.every((x, k) => x === (t.deps || [])[k]);
    const changed = (p || null) !== (t.parent || null) || !sameDeps;
    out.push(changed ? { ...t, parent: p || null, deps: nextDeps, updatedAt: now } : t);
  }
  return { tasks: out, removed: groups.length, remapped };
}

/* ============================================================ 前置任务
 *
 * 锁定状态是**算出来的**，不存字段。
 *
 * 存的话就有两份真相：前置标成 done 之后，这条的 locked 字段
 * 若没人同步，界面永远显示"被卡住" —— 那种错查不出原因。
 */

/** 一条任务/组是否算"完成"。组 = 它下面全部完成 */
export function isDone(id, tasks, ctx, flow) {
  const t = ctx.byId[id];
  if (!t) return false;                       // 已删除：算没完成
  if (t.kind === 'group') {
    const kids = (tasks || []).filter((x) => x.kind !== 'group' && parentChainHas(x.id, id, ctx.parentOf));
    return kids.length > 0 && kids.every((x) => statusDone(flow, x.status));
  }
  /*
    ⛔ 不能把完成判据写死成默认那个 done 的 id：
    自定义流程的完成态可能叫 's3'、'完工'…，
    写死的话**没有一条前置会解锁** ——
    依赖它的任务永远卡在"等前置"，而前置明明已经做完了。

    那是"锁永远打不开"这一档的错，比显示错名字严重得多：
    界面只说"被前置任务卡住"，不说清是哪个前置、为什么。

    flow 缺省时（老存档 / 未配置）退回默认判据，行为不变。
  */
  return statusDone(flow, t.status);
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
/**
 * `aId` 是否**传递地**依赖 `bId`（经过任意层前置）。
 *
 * 用它来挡住"选一个会成环的前置"：把 A 的前置设成 B，
 * 而 B 已经（经过若干层）依赖 A —— 那两条会互相等，永远解锁不了。
 */
export function dependsOn(tasks, aId, bId) {
  if (!aId || !bId || aId === bId) return false;
  const ctx = indexTasks(tasks || []);
  const seen = new Set();
  const walk = (id, depth) => {
    if (depth > 64) return false;      // 环里兜底退出，不无限递归
    if (id === bId) return true;
    if (seen.has(id)) return false;    // 已访问的分支不可能再通到 bId
    seen.add(id);
    const t = ctx.byId[id];
    if (!t) return false;
    for (const d of t.deps || []) {
      if (walk(d, depth + 1)) return true;
    }
    return false;
  };
  return walk(aId, 0);
}

export function lockOf(task, tasks, store) {
  const ctx = indexTasks(tasks || []);
  const deps = task?.deps || [];
  const pending = [];
  const missing = [];
  for (const d of deps) {
    if (!ctx.byId[d]) { missing.push(d); continue; }
    if (!isDone(d, tasks, ctx, flowOf(store && store.flow))) pending.push(d);
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
export function sortRowsBy(rows, field, dir = 'asc', tagNames = null) {
  const sign = dir === 'desc' ? -1 : 1;
  const cmp = (ra, rb) => {
    let r = 0;
    switch (field) {
      case 'summary':
        r = String(ra.task.summary || '').localeCompare(String(rb.task.summary || ''), 'zh-Hans-CN');
        break;
      default:
        r = 0;
    }
    if (r !== 0) return r * sign;
    return cmpTask(ra.task, rb.task, field, sign, tagNames);
  };
  return [...rows].sort(cmp);
}

/** 落到任务字段上的比较（sortTasksBy 与 sortRowsBy 共用，不写两遍） */
function cmpTask(a, b, field, sign, tagNames = null) {
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
    case 'group': {
      /*
        没分组的**恒排最后**（不随升降序翻转）：它是"还没归类"，不该混在中间。
        ⛔ 这一列必须有分支 —— 落到 default 就是 r=0，
        点列头排序会纹丝不动，而界面上写着"排序：分组 ↓"。
      */
      if (!a.group && !b.group) r = 0;
      else if (!a.group) return 1;
      else if (!b.group) return -1;
      else r = a.group.localeCompare(b.group, 'zh-Hans-CN');
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
      /*
        ⛔ 必须按**显示名**排，不能按 id 排：
        任务上存的是 id（tg_xxxx），界面上显示的是名字。
        按 id 排出来的顺序和眼睛看到的完全无关 ——
        点了列头排序，结果看着像随机，而界面上明明写着"排序：标签 ↓"。

        tagNames 没传时退回按原值排（至少仍稳定，不会变成乱序）。
      */
      const nm = (id) => (tagNames && tagNames[id]) || id;
      const ta = (a.tags || []).map(nm).sort().join(',');
      const tb = (b.tags || []).map(nm).sort().join(',');
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
/*
  标签去重，按**使用次数倒序**。

  `limit` 是要"热门前 N 个"时才用（如统计面板）。
  ⛔ **筛选候选不能带上限**：那会让第 N+1 个之后的标签在下拉里凭空消失 ——
  用户知道有这个标签、列表里也看得到，就是筛不到，
  而界面上不会说"只显示前 20 个"，只会以为它不存在。
*/
export function allTags(tasks, limit = 0) {
  const cnt = new Map();
  for (const t of tasks) for (const tag of t.tags) cnt.set(tag, (cnt.get(tag) || 0) + 1);
  const out = [...cnt.entries()].sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  return limit > 0 ? out.slice(0, limit) : out;
}

/** 下一个任务 id（与 Rust create_task 同规则：tb-%04d） */
export function nextTaskId(store) {
  const nRaw = Number(store.nextId);
  const n = Number.isFinite(nRaw) && nRaw > 0 ? Math.floor(nRaw) : 1;
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
export const NOGROUP = '__nogroup__';

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
  if (key === 'group') return [t.group || NOGROUP];
  if (key === 'tag') return t.tags.length > 0 ? t.tags : [NOTAG];
  return [''];
}

function sortGroups(groups, key, flow) {
  if (key === 'status') {
    /*
      ⛔ 不能查写死的 STATUS_RANK（默认那七个）：
      自定义流程的状态 id 在那张表里查不到 → 全部落到 9 → **顺序随机**。

      "按状态分组"其实是这些组唯一有意义的顺序（待办→在做→已完成），
      顺序乱了之后，看"还有多少没做完"就得从头扫一遍。
      改成按**流程里配置的先后**（statuses 数组的下标）排。
    */
    const order = (flow && Array.isArray(flow.statuses) && flow.statuses.length)
      ? flow.statuses.map((x) => x.id)
      : null;
    groups.sort((a, b) => {
      if (order) {
        const ia = order.indexOf(a.key);
        const ib = order.indexOf(b.key);
        const ra = ia < 0 ? 99 : ia;
        const rb = ib < 0 ? 99 : ib;
        if (ra !== rb) return ra - rb;
      }
      return (STATUS_RANK[a.key] ?? 9) - (STATUS_RANK[b.key] ?? 9);
    });
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
  } else if (key === 'group') {
    /* 未分组置尾：它是"还没归类"，不该混在中间 */
    groups.sort((a, b) => {
      if (a.key === NOGROUP) return 1;
      if (b.key === NOGROUP) return -1;
      return b.count - a.count || a.key.localeCompare(b.key, 'zh-Hans-CN');
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
export function groupTasksBy(tasks, keys, flow) {
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
    sortGroups(groups, key, flow);
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
export function sortTasksBy(tasks, field, dir = 'asc', tagNames = null) {
  const sign = dir === 'desc' ? -1 : 1;
  return [...tasks].sort((a, b) => {
    /*
      sign 直接交给 cmpTask，不在外面再乘一次。
      cmpTask 里"未认领恒排最后"是提前 return（刻意不带 sign）——
      外面再乘一次就会在降序时把它翻到最前面，那条保证就没了。
    */
    const r = cmpTask(a, b, field, sign, tagNames);
    if (r !== 0) return r;
    /*
      兜底保持看板原有的手感：同分时更新时间新的在前，再同分按优先级。
      不加优先级的话，改完这一处会发现看板里同一列的任务
      顺序变得跟以前不一样，而没人动过排序设置。
    */
    const byTime = (b.updatedAt || 0) - (a.updatedAt || 0);
    if (byTime !== 0) return byTime;
    const byPri = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
    if (byPri !== 0) return byPri;
    /*
      ⛔ 最后必须落到 **id** 上，否则排序**不稳定**。

      只靠上面两层兜底的话，更新时间与优先级都相同的任务，
      顺序取决于它们在文件里的先后 —— 而那个顺序会随写盘变化。
      于是用户什么都没动，刷新一下同值的几条就换了位置：
      看着像"排序乱了"，而顶栏明明写着"排序：优先级 ↓"。

      按 id 兜底后顺序完全确定：同样的数据永远得到同样的顺序。
    */
    return sign * (a.id || '').localeCompare(b.id || '');
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
    /*
      ⛔ 组**不计入**总数与各类分布。
      组是容器，不是活。把它算进 total，界面上会出现
      "总任务 3"而列表里只有 2 条 —— 数字和眼前的东西对不上，
      比没有数字更可疑。（byStatus / byType / byPriority 同理。）
    */
    if (t.kind === 'group') continue;
    byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    estimateByStatus[t.status] = Math.round(
      ((estimateByStatus[t.status] || 0) + (Number(t.estimate) || 0)) * 100,
    ) / 100;
    /* 类型分布：未分类也单独计 —— 那是"还没归类的工作量"，排期时要看得见 */
    const tk = t.type || NOTYPE;
    byType[tk] = (byType[tk] || 0) + 1;
    byPriority[t.priority] = (byPriority[t.priority] || 0) + 1;
    const who = t.assignee || UNASSIGNED;
    const ae = byAssignee.get(who) || { id: who, count: 0, est: 0 };
    ae.count += 1;
    ae.est = Math.round((ae.est + (Number(t.estimate) || 0)) * 100) / 100;
    byAssignee.set(who, ae);
    for (const tag of t.tags) tagCnt.set(tag, (tagCnt.get(tag) || 0) + 1);
    /*
      ⛔ 没有 updatedAt（老数据 / AI 直接写进 JSON 的）**不算"陈旧"**：
      `now - 0` 是个巨大的数，于是所有没时间戳的未完成任务
      会全部涌进"超 7 天未动"面板 —— 而它们可能刚建、正在做。
      那不是"很久没动"，是"不知道什么时候动的"，把它算进陈旧是假数据。
      （列上的时间区间筛选是同样判据：时间为 0 不参与。）
    */
    if (
      !statusDone(store.flow, t.status)
      && (t.updatedAt || 0) > 0
      && (now - t.updatedAt) > STALE_MS
    ) stale.push(t);
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
  /*
    统计口径统一为**叶子任务**：组是容器，不是活。
    把组算进来会出现"总任务 3"而列表只有 2 条 ——
    数字和眼前的东西对不上，比没有数字更可疑。
  */
  const leaves = tasks.filter((t) => t.kind !== 'group');
  /*
    「进行中」= 未完成、且不是初始态。

    ⛔ 原来写死成默认那两个中间态的 id（doing / review）：
    自定义流程里那个状态可能叫别的（"开发中"、"联调"…），
    也可能有更多中间态 —— 于是这一项**恒为 0**，
    而卡片上还写着"进行中 doing + review"，那条提示也就成了假话。

    判据改用"未完成 + 不是初始态"，与流程配置一致。
    （初始态单独排除：刚建还没开工的不算"进行中"，
      否则"未完成"和"进行中"两个数会挨得很近，看不出区别。）
  */
  const initId = initialStatus(store.flow);
  const active = leaves.filter(
    (t) => !statusDone(store.flow, t.status) && t.status !== initId,
  ).length;
  return {
    total: leaves.length,
    open: leaves.filter((t) => !statusDone(store.flow, t.status)).length,
    active,
    done: leaves.filter((t) => statusDone(store.flow, t.status)).length,
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
    /*
      触发通知的状态。缺省 'review'（老配置的语义不变）。
      自定义流程里"审查"那一步可能叫别的，写死就永远收不到通知。
    */
    notifyStatus: typeof c.notifyStatus === 'string' && c.notifyStatus ? c.notifyStatus : 'review',
  };
}

/**
 * 找出**指向同一个数据目录**的项目（按目录分组）。
 *
 * 为什么需要它：曾经有个 bug 会在切项目时把旧项目的 dataDir 盖到新项目头上
 * （见 store.ts 的 aimAt），配置一旦被那样写坏就留在磁盘上了。
 * 两个项目指向同一份 tasks.json 时，在其中一个里的改动会"同时"出现在另一个里，
 * 而界面只显示项目名 —— 完全看不出它们其实是一份数据。
 *
 * 这里**只报不改**：改成什么目录只有用户知道，猜一个就是把数据挪到错地方。
 */
export function duplicateDataDirs(cfg) {
  const list = (cfg && Array.isArray(cfg.projects) ? cfg.projects : [])
    .filter((p) => p && typeof p.dataDir === 'string' && p.dataDir.trim());
  const byDir = new Map();
  for (const p of list) {
    const k = p.dataDir.trim();
    if (!byDir.has(k)) byDir.set(k, []);
    byDir.get(k).push(p.id);
  }
  const out = [];
  for (const [dir, ids] of byDir) {
    if (ids.length > 1) out.push({ dir, ids });
  }
  return out;
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
