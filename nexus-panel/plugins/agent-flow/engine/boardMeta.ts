/**
 * 项目元数据 —— 自定义状态流程 + 标签定义。
 *
 * ================= 为什么和任务板分两个文件 =================
 *
 * 任务板（tasks-<项目>.json）是**数据**，天天变；
 * 本文件（boardmeta-<项目>.json）是**配置**，几乎不动。
 *
 * 混在一个文件里，AI 每次要加一条任务都得先读完几百行状态与标签的
 * 定义才能找到该改的地方 —— 而它真正要动的只是 nodes 里那一条。
 * 分开之后它只需读自己关心的那份。
 *
 * ⛔ 但两者**按项目配套**：切换项目时两个文件一起换，
 * 否则会出现"这个项目的任务套着另一个项目的状态名"这种错乱。
 *
 * ================= 状态：为什么做成可配置 =================
 *
 * 写死 todo/doing/done 意味着所有人必须用同一套流程。
 * 而真实流程千差万别：有的要"待评审""测试中"，有的不需要。
 * 硬编码流程会逼团队迁就工具，而不是工具适应流程 ——
 * 这正是市面工具（Jira / Linear / Tower）都把工作流做成可配的原因。
 *
 * ================= 状态与运行结果是两回事 =================
 *
 * 本文件的状态是**计划态**（人推的：待办 → 进行中 → …）；
 * 任务跑出来的成功/失败是**运行结果**（系统记的事实，不可改）。
 *
 * ⛔ 绝不能把两者合并成一个字段：
 *    · 人把"失败"改成"成功"，历史就假了
 *    · 系统把"进行中"覆盖成"失败"，计划态就丢了
 * 表格里分成两列，各自独立。
 */

export const BOARD_META_VERSION = 1;

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

export type StatusDef = {
  /** 稳定 id。写进任务里的是它 —— 改名不丢数据 */
  id: string;
  name: string;
  /**
   * 显示色。标签化展示用（与标签同一套色板，视觉统一）。
   * 存 hex 而不是"第几个预设色"：预设改了不该让已有任务跟着变脸。
   */
  color: string;
  /**
   * 是否终态。
   *
   * 终态不能再流出（避免"已完成"被随手拖回"进行中"，统计口径就脏了）。
   * 真要重开，按市面工具的惯例是**建新任务**，不是把旧任务激活。
   */
  final: boolean;
  /**
   * 这个终态是不是「不做了」（取消 / 放弃 / 作废）。
   *
   * `final` 只说"不再流出"，**不区分**是做完了还是放弃了 —— 而这两者在
   * 复盘时天差地别：一个是产出、一个是沉没成本。所以单独用一个显式标记，
   * 由配置流程的人自己勾。
   *
   * ⛔ 不猜：按名字猜"取消 / 作废 / 放弃"这种词会猜错（"已废弃"是放弃，
   *    "已归档"却可能是完成），猜错的代价是把放弃记成产出。
   *    所以只有勾了才算，没勾一律按完成算。
   *
   * 只有 final 为 true 时才生效（非终态谈不上"不做了"）。
   */
  cancel?: boolean;
  /**
   * 允许流转到的状态 id。
   *
   * 留空 = 不能流出（配合 final 使用；非终态留空等于把任务钉死，
   * 所以解析时会兜底放开到全部非终态，见 normalizeMeta）。
   */
  next: string[];
};

/**
 * 默认状态流。
 *
 * 用户点名要的两条：**已挂起**（被打断、暂不推进）与**已取消**。
 *
 * 挂起与取消的区别是这次设计的重点：
 *   · 挂起 —— 还要接着做，只是现在推不动（等上游、等人）
 *   · 取消 —— 不做了
 * 两者混成一个"不推进"状态的话，复盘时无法区分
 * "暂时卡住"与"已经放弃"，僵尸任务就堆在列表里没人清。
 */
export const DEFAULT_STATUSES: StatusDef[] = [
  { id: 'todo', name: '待办', color: '#8b93a7', final: false, next: ['doing', 'held', 'cancelled'] },
  { id: 'doing', name: '进行中', color: '#3b82f6', final: false, next: ['held', 'done', 'cancelled'] },
  { id: 'held', name: '已挂起', color: '#f59e0b', final: false, next: ['doing', 'cancelled'] },
  { id: 'done', name: '已完成', color: '#22c55e', final: true, next: [] },
  { id: 'cancelled', name: '已取消', color: '#ef4444', final: true, next: [], cancel: true },
];

/* ------------------------------------------------------------------ */
/* 标签                                                                */
/* ------------------------------------------------------------------ */

export type TagDef = {
  id: string;
  name: string;
  /** hex 颜色。可自由设定 —— 这是标签最主要的用途（一眼分类） */
  color: string;
};

/**
 * 预设色板。
 *
 * 取自常见协作工具的标签色：色相分散、明暗适中，
 * 相邻两个标签不会糊成一片（这是纯随机取色最容易翻车的地方）。
 */
export const TAG_PALETTE = [
  '#3b82f6', '#22c55e', '#f59e0b', '#ef4444',
  '#8b5cf6', '#06b6d4', '#ec4899', '#84cc16',
  '#f97316', '#6366f1', '#14b8a6', '#a855f7',
];

/* ------------------------------------------------------------------ */
/* 元数据                                                              */
/* ------------------------------------------------------------------ */

export type BoardMeta = {
  v: number;
  project: string;
  projectName: string;
  updatedAt: number;
  /** 有序。顺序就是表格里状态列的排序权重 */
  statuses: StatusDef[];
  tags: TagDef[];
};

export function emptyMeta(project = '', projectName = ''): BoardMeta {
  return {
    v: BOARD_META_VERSION,
    project,
    projectName,
    updatedAt: 0,
    statuses: DEFAULT_STATUSES.map((s) => ({ ...s, next: [...s.next] })),
    tags: [],
  };
}

/* ------------------------------------------------------------------ */
/* 解析                                                                */
/* ------------------------------------------------------------------ */

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** 颜色要么不给（回退预设），要么是能认出来的 #rgb / #rrggbb */
function colorOf(v: unknown, fallback: string): string {
  const s = str(v).trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(s) ? s : fallback;
}

/**
 * 解析并**归一**。
 *
 * 归一这一步不能省：手改过的文件可能删掉某个状态、
 * 或让 next 指向已不存在的 id —— 留着那些悬空引用，
 * 界面上表现为"点了流转没反应"，而看不出是配置坏了。
 */
/**
 * 归一里那一半：**保证每个非终态都有去处**。
 *
 * 判据只此一份，`parseMeta`（读盘）与 `removeStatus`（删状态）都调它 ——
 * 两处各写一份的话，删完界面上是死局、存盘再读回来又活了，
 * 而用户只会以为自己记错了。
 *
 * 为什么"没有别的非终态可去"时要退一步允许终态：
 * 只剩自己一个非终态时按原规则算出来是空 —— 于是这条任务**永远推不动**，
 * 连"已完成 / 已取消"都到不了，比流程设错严重得多。
 *
 * ⛔ 只在这里兜底，`setNext` 不动：那里是用户**显式**勾出来的结果，
 *    勾空是他在表达"这个状态不该流出"，替他填回去等于跟他抢控件。
 */
function ensureReachable(statuses: StatusDef[]): void {
  if (statuses.length < 2) return;
  const ids = statuses.map((s) => s.id);
  const nonFinal = statuses.filter((s) => !s.final).map((s) => s.id);
  for (const s of statuses) {
    if (s.final) { s.next = []; continue; }
    s.next = s.next.filter((x) => ids.indexOf(x) >= 0 && x !== s.id);
    if (s.next.length > 0) continue;
    const others = nonFinal.filter((x) => x !== s.id);
    s.next = others.length > 0 ? others : ids.filter((x) => x !== s.id);
  }
}

export function parseMeta(raw: string | null, project = '', projectName = ''): BoardMeta {
  if (!raw) return emptyMeta(project, projectName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyMeta(project, projectName);
  }
  if (!parsed || typeof parsed !== 'object') return emptyMeta(project, projectName);
  const o = parsed as Record<string, unknown>;

  /* ---- 状态 ---- */
  const rawStatuses = Array.isArray(o.statuses) ? o.statuses : [];
  const statuses: StatusDef[] = [];
  const seen = new Set<string>();
  for (const s of rawStatuses) {
    const d = s as Record<string, unknown>;
    if (!d || typeof d !== 'object') continue;
    const id = str(d.id).trim();
    const name = str(d.name).trim();
    // 没 id 或没名字无从显示，丢弃
    if (!id || !name) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    statuses.push({
      id,
      name,
      color: colorOf(d.color, '#8b93a7'),
      final: d.final === true,
      next: Array.isArray(d.next) ? d.next.filter((x): x is string => typeof x === 'string') : [],
    });
  }
  // 一个状态都没有 = 配置被改坏；退回默认，否则整个面板没法用
  if (statuses.length === 0) {
    return { ...emptyMeta(project, projectName), updatedAt: num(o.updatedAt) };
  }

  /* 清掉指向不存在状态的流转，并保证没有状态被钉死（判据见 ensureReachable） */
  ensureReachable(statuses);

  /* ---- 标签 ---- */
  const rawTags = Array.isArray(o.tags) ? o.tags : [];
  const tags: TagDef[] = [];
  const tagSeen = new Set<string>();
  for (const t of rawTags) {
    const d = t as Record<string, unknown>;
    if (!d || typeof d !== 'object') continue;
    const id = str(d.id).trim();
    const name = str(d.name).trim();
    if (!id || !name) continue;
    if (tagSeen.has(id)) continue;
    tagSeen.add(id);
    tags.push({ id, name, color: colorOf(d.color, TAG_PALETTE[tags.length % TAG_PALETTE.length]) });
  }

  return {
    v: BOARD_META_VERSION,
    project: str(o.project, project),
    projectName: str(o.projectName, projectName),
    updatedAt: num(o.updatedAt),
    statuses,
    tags,
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

export function serializeMeta(m: BoardMeta): string {
  return JSON.stringify(m, null, 2);
}

/* ------------------------------------------------------------------ */
/* 查                                                                  */
/* ------------------------------------------------------------------ */

export function statusOf(m: BoardMeta, id: string): StatusDef | null {
  for (const s of m.statuses) if (s.id === id) return s;
  return null;
}

/** 状态显示名。id 查不到就显示 id 本身 —— 比显示"未知"有用（还能看出是哪个） */
/** 默认流里这个 id 叫什么（自定义流程里查不到时用它兜底） */
function defaultStatusName(id: string): string {
  for (const s of DEFAULT_STATUSES) if (s.id === id) return s.name;
  return '';
}

export function statusName(m: BoardMeta, id: string): string {
  return statusOf(m, id)?.name || defaultStatusName(id) || id || '—';
}

/**
 * 这个状态算不算「做完了」。
 *
 * ⛔ 不能写死 `id === 'done'`：
 * 状态集是**用户配的**（见 DEFAULT_STATUSES 上面的说明），自定义流程里
 * 完成态可能叫 's3'、'完工'… —— 写死的话
 *   · 前置依赖**永远解锁不了**（锁打不开，界面只说"被前置卡住"）
 *   · 组头永远显示"待办"、已完成数永远 0
 * 判据只有一条：状态的 `final`。
 *
 * 缺省时（老存档 / 没配流程 / id 查不到）退回默认那两个 id，行为不变。
 */
export function isFinalStatus(m: BoardMeta | null | undefined, id: string): boolean {
  const s = m ? statusOf(m, id) : null;
  if (s) return !!s.final;
  return id === 'done' || id === 'cancelled';
}

/**
 * 终态里「不做了」的那一种。
 *
 * 判据只有一条：状态上那个显式的 `cancel` 标记（见 StatusDef.cancel）。
 * 不按名字猜 —— 猜错会把放弃记成产出。没勾的一律按完成算。
 *
 * 缺省时（老存档 / 没配流程 / id 查不到）退回默认那个 'cancelled'，行为不变。
 * 只要 final 为 false 就不算（非终态谈不上"不做了"）。
 */
export function isCancelStatus(m: BoardMeta | null | undefined, id: string): boolean {
  const s = m ? statusOf(m, id) : null;
  if (s) return !!s.final && !!s.cancel;
  return id === 'cancelled';
}

/**
 * 状态显示色（hex）。
 *
 * ⛔ 不能靠 CSS 类名 `st-<id>` 上色 —— 那套类名是**写死的四个 id**，于是：
 *   · 默认流里的 'held'（已挂起）压根没有对应规则，显示成和「待办」一样的灰，
 *     而它是用户点名要的状态（见 DEFAULT_STATUSES 上面那段）
 *   · 自定义流程的 id（s2 / 完工…）一个都认不了
 *   两者的表现都是"文字对了、颜色没有"，而看不出是这个洞还是主题没配好。
 *
 * 判据只有一份：状态上那个 hex（StatusDef.color）。
 * 查不到时退回默认那套的颜色；再查不到返回 ''（交给 CSS 兜底）。
 */
export function statusColor(m: BoardMeta | null | undefined, id: string): string {
  const s = m ? statusOf(m, id) : null;
  if (s) return s.color;
  for (const d of DEFAULT_STATUSES) if (d.id === id) return d.color;
  return '';
}

/**
 * 状态列表里第一个 = 未开始。
 *
 * 默认流里就是 'todo'。自定义流程沿用这个约定：配流程时通常把待办放第一个。
 * 只用于"进行中"的计数 —— 判错只会让组头的数字偏一点，不会锁死任务。
 */
export function idleStatusId(m: BoardMeta | null | undefined): string {
  return m && m.statuses.length > 0 ? m.statuses[0].id : 'todo';
}

/**
 * 这个状态能不能流转到目标状态。
 *
 * 判据只有一条：目标在 next 里。
 * 不做"是否终态"的额外判断 —— final 的 next 已被归一成空数组，
 * 再判一次就是两处规则，改一处漏一处。
 */
export function canFlow(m: BoardMeta, from: string, to: string): boolean {
  if (from === to) return false;
  const s = statusOf(m, from);
  if (!s) return false;
  return s.next.indexOf(to) >= 0;
}

/** 从这个状态能去哪（表格里下拉只列这些，列不出来的就是不让走） */
export function nextStatuses(m: BoardMeta, from: string): StatusDef[] {
  const s = statusOf(m, from);
  if (!s) return [];
  return s.next.map((id) => statusOf(m, id)).filter((x): x is StatusDef => !!x);
}

export function tagOf(m: BoardMeta, id: string): TagDef | null {
  for (const t of m.tags) if (t.id === id) return t;
  return null;
}

/** 标签名。查不到显示 id —— 标签被删了不该让任务上凭空少一块 */
export function tagName(m: BoardMeta, id: string): string {
  return tagOf(m, id)?.name || id;
}

export function tagColor(m: BoardMeta, id: string): string {
  return tagOf(m, id)?.color || '#8b93a7';
}

/* ------------------------------------------------------------------ */
/* 改                                                                  */
/* ------------------------------------------------------------------ */

function clone(m: BoardMeta): BoardMeta {
  return {
    ...m,
    statuses: m.statuses.map((s) => ({ ...s, next: [...s.next] })),
    tags: m.tags.map((t) => ({ ...t })),
  };
}

export function newId(prefix: string, now: number = Date.now()): string {
  return `${prefix}_${now.toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** id 撞了换一个（AI 手写 id 可能与生成的撞） */
export function freeId(existing: { id: string }[], want: string): string {
  if (want && !existing.some((x) => x.id === want)) return want;
  let i = 2;
  while (existing.some((x) => x.id === `${want}_${i}`)) i += 1;
  return `${want}_${i}`;
}

export function addTag(m: BoardMeta, name: string, color?: string): { meta: BoardMeta; id: string } {
  const b = clone(m);
  const id = freeId(b.tags, newId('tag'));
  b.tags.push({
    id,
    name: name.trim() || '新标签',
    color: colorOf(color, TAG_PALETTE[b.tags.length % TAG_PALETTE.length]),
  });
  b.updatedAt = Date.now();
  return { meta: b, id };
}

/** 删标签。任务上挂着的引用**不清理** —— 见 removeTagRefs 的说明 */
export function removeTag(m: BoardMeta, id: string): BoardMeta {
  const b = clone(m);
  b.tags = b.tags.filter((t) => t.id !== id);
  b.updatedAt = Date.now();
  return b;
}

export function updateTag(m: BoardMeta, id: string, patch: Partial<TagDef>): BoardMeta {
  const b = clone(m);
  const t = b.tags.find((x) => x.id === id);
  if (!t) return m;
  if (patch.name !== undefined) t.name = patch.name.trim() || t.name;
  if (patch.color !== undefined) t.color = colorOf(patch.color, t.color);
  b.updatedAt = Date.now();
  return b;
}

export function addStatus(m: BoardMeta, name: string, color?: string): { meta: BoardMeta; id: string } {
  const b = clone(m);
  const id = freeId(b.statuses, newId('st'));
  const nonFinal = b.statuses.filter((s) => !s.final).map((s) => s.id);
  b.statuses.push({
    id,
    name: name.trim() || '新状态',
    color: colorOf(color, TAG_PALETTE[b.statuses.length % TAG_PALETTE.length]),
    final: false,
    // 新建的状态默认能走到所有非终态 —— 否则一建好就是个死局
    next: nonFinal,
  });
  b.updatedAt = Date.now();
  return { meta: b, id };
}

/**
 * 删状态。
 *
 * ⛔ 任务上正在用这个状态的**不会**被改：
 * 悄悄把它们改成"待办"会让人以为自己记错了，
 * 而留着旧 id 至少能看出"这条任务用的是一个已删除的状态"。
 * 界面上由 statusName 显示成 id，配合提示去修。
 */
export function removeStatus(m: BoardMeta, id: string): BoardMeta {
  const b = clone(m);
  b.statuses = b.statuses.filter((s) => s.id !== id);
  // 别的状态 next 里指向它的也要清掉，否则流转表里出现不存在的目标
  for (const s of b.statuses) s.next = s.next.filter((x) => x !== id);
  /*
   * ⛔ 清完之后必须再走一次"有没有被钉死"的归一。
   *
   *    删掉中间那个状态（待办 → 评审 → 完成 里的「评审」）之后，
   *    「待办」的 next 就被清空了 —— 它是非终态却无处可去，
   *    界面上表现为流转下拉是空的、点了没反应，而看不出是刚才删的那一下造成的。
   *
   *    判据与读盘归一同一份（ensureReachable），不在这里另写一遍。
   */
  ensureReachable(b.statuses);
  b.updatedAt = Date.now();
  return b;
}

export function updateStatus(m: BoardMeta, id: string, patch: Partial<StatusDef>): BoardMeta {
  const b = clone(m);
  const s = b.statuses.find((x) => x.id === id);
  if (!s) return m;
  if (patch.name !== undefined) s.name = patch.name.trim() || s.name;
  if (patch.color !== undefined) s.color = colorOf(patch.color, s.color);
  if (patch.final !== undefined) {
    s.final = patch.final;
    /*
     * 变成终态就不能再流出；变回非终态时若无处可去要补上 ——
     * 判据与读盘归一、删状态同一份（ensureReachable）。
     *
     * ⛔ 这里以前自己算"其它非终态"：只剩自己一个非终态时算出来是空，
     *    于是把「已完成」的终态勾掉之后，那条任务连"已完成 / 已取消"
     *    都到不了 —— 死局，且看不出是刚勾的那一下造成的。
     */
    ensureReachable(b.statuses);
  }
  if (patch.cancel !== undefined) s.cancel = patch.cancel;
  /*
   * 非终态谈不上"不做了" —— 勾掉终态时把这个标记一起清掉。
   * 不清的话它会潜伏着：将来重新勾上终态，这个状态突然又变成取消态，
   * 而用户早忘了自己当初勾过（界面上那一格当时是隐藏的）。
   */
  if (!s.final) s.cancel = false;
  b.updatedAt = Date.now();
  return b;
}

/** 设置某状态允许流转到哪些状态 */
export function setNext(m: BoardMeta, id: string, next: string[]): BoardMeta {
  const b = clone(m);
  const s = b.statuses.find((x) => x.id === id);
  if (!s) return m;
  const ids = new Set(b.statuses.map((x) => x.id));
  s.next = next.filter((x) => ids.has(x) && x !== id);
  b.updatedAt = Date.now();
  return b;
}

/** 颠倒两个状态的显示顺序（上移 / 下移） */
export function moveStatus(m: BoardMeta, id: string, delta: number): BoardMeta {
  const b = clone(m);
  const i = b.statuses.findIndex((x) => x.id === id);
  if (i < 0) return m;
  const j = i + delta;
  if (j < 0 || j >= b.statuses.length) return m;
  const tmp = b.statuses[i];
  b.statuses[i] = b.statuses[j];
  b.statuses[j] = tmp;
  b.updatedAt = Date.now();
  return b;
}
