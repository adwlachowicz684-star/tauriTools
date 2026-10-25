/**
 * 任务表格 —— 「所有运行记录」的统一视图：数据模型 + 筛选 + 排序 + 虚拟滚动切片。
 *
 * ================= 为什么另起一套，而不是复用分组列表 =================
 *
 * 分组列表（tasks.ts 的 groupByCanvas / flattenRows）是**层级**结构：
 * 组头 + 任务行，行高两种，切片要按行高累加。
 * 表格是**平**的：一行一条记录，行高恒定。
 * 两者共用的只有"算进度/耗时"那几个纯函数（这里直接 import），
 * 硬塞进同一套行模型会让 flattenRows 多出一种 kind，
 * 而那边的虚拟滚动、默认展开逻辑全都得跟着判一次 —— 不划算。
 *
 * ================= 为什么"覆盖所有数据" =================
 *
 * 进行中（当前会话、不落盘）与已归档（跨会话、裁过内容）本是同一类东西
 * 的两段生命周期。分成两个窗口时，找一条刚跑完的记录要先想
 * "它算任务还是算历史"；而表格的价值恰恰是**一次看全**：
 * 哪些数据该出现，交给筛选决定，不由入口决定。
 *
 * 所以这里把两路数据并成一组行，用 origin 标注归属，
 * id 相同时也不会互相顶掉（key 带前缀）。
 */

import {
  type TaskRecord, type TaskSource, type TaskStatus,
  progressOf, elapsedOf, STATUS_LABEL, SOURCE_LABEL,
} from './tasks';
import { formatDateTime } from './history';
import { type TaskBoard, type BoardTask, isTask, isGroup, childrenOf } from './taskBoard';

/**
 * 一条记录来自哪。
 *
 * live / archived = 运行记录（跑出来的）；
 * board = 任务板条目（人排的计划）。
 *
 * 三类**合在同一张表里**而不是分成两张：
 * 说明、标签、附件这些字段只在任务条目上有，把条目单独放一张表的话，
 * "找上周那条挂起的任务"要切两次视图；合在一起一次筛选就能出结果。
 *
 * ⛔ 代价：运行记录行在"说明 / 标签"这些列上是空的。
 * 这是两种数据本来就不同的部分 —— 硬填一个值才是错（会让人以为
 * 那次运行也写了说明）。空着显示成"—"，语义清楚。
 */
export type TaskOrigin = 'live' | 'archived' | 'board';

export const ORIGIN_LABEL: Record<TaskOrigin, string> = {
  live: '进行中',
  archived: '已归档',
  board: '计划',
};

const ORIGIN_ORDER: Record<TaskOrigin, number> = { board: 0, live: 1, archived: 2 };

export type TableRow = {
  /** `live:xxx` / `archived:xxx` / `board:xxx` —— 三路数据的 id 可能相同，靠前缀区分 */
  key: string;
  origin: TaskOrigin;
  /** 运行记录。board 行没有 */
  record: TaskRecord | null;
  /** 任务条目。live / archived 行没有 */
  task: BoardTask | null;
  /**
   * 关联用的 id：任务条目取条目 id，运行记录取记录 id。
   * 附件这类"挂在某个东西上"的数据用它查，调用方不用再判 origin。
   */
  ownerId: string;
  /**
   * 所属**组**的标题链，如"登录 › 接口"。顶层任务为空串。
   *
   * 组本身不占行（它的状态由下面的任务决定，单独一行会显示成"待办"误导人），
   * 但没有这一列的话，嵌套结构在表格里**完全不可见** ——
   * 两条同名任务分不出谁在哪个组下。
   */
  groupPath: string;
  /** 嵌套深度。0 = 顶层。用于需要区分层级的地方 */
  depth: number;
};

export function buildTableRows(
  live: TaskRecord[],
  archived: TaskRecord[],
  board?: TaskBoard | null,
): TableRow[] {
  const rows: TableRow[] = [];
  if (board) {
    /*
      任务板是**树**（root + children），没有扁平的 order 数组。
      按先序遍历取任务节点 —— 顺序即树上的上下顺序，
      与列表视图里看到的次序一致，两个视图对同一条任务不会各排各的。

      遍历时把**祖先组的标题**带下来（而不是事后对每个任务回溯 parent）：
      一次遍历顺手就有的东西，回溯会把这里变成 O(行 × 深度)，
      而深层嵌套时深度并不小。
    */
    const walk = (parent: string | null, trail: string[], depth: number): void => {
      for (const id of childrenOf(board, parent)) {
        const n = board.nodes[id];
        if (!n) continue;
        if (isGroup(n)) { walk(id, [...trail, n.title], depth + 1); continue; }
        rows.push({
          key: `board:${id}`, origin: 'board', record: null, task: n, ownerId: id,
          groupPath: trail.join(GROUP_SEP),
          depth,
        });
      }
    };
    walk(null, [], 0);
  }
  for (const t of live) rows.push({
    key: `live:${t.id}`, origin: 'live', record: t, task: null, ownerId: t.id,
    groupPath: '', depth: 0,
  });
  for (const t of archived) rows.push({
    key: `archived:${t.id}`, origin: 'archived', record: t, task: null, ownerId: t.id,
    groupPath: '', depth: 0,
  });
  return rows;
}

/** 组路径的分隔符。用 › 而不是 / —— 后者与文件路径混淆 */
export const GROUP_SEP = ' › ';

/** 反解 key：详情面板要知道选中的那条该按"运行中"还是"归档"渲染 */
export function parseRowKey(key: string): { origin: TaskOrigin; id: string } | null {
  const at = key.indexOf(':');
  if (at < 0) return null;
  const prefix = key.slice(0, at);
  const id = key.slice(at + 1);
  if (prefix !== 'live' && prefix !== 'archived' && prefix !== 'board') return null;
  return { origin: prefix, id };
}

/* ------------------------------------------------------------------ */
/* 列                                                                  */
/* ------------------------------------------------------------------ */

export type TableColumnId =
  | 'origin' | 'name' | 'status' | 'source'
  | 'started' | 'ended' | 'elapsed' | 'progress' | 'nodes'
  /* 下面这些是**任务级**列：值在任务板条目上，运行记录行没有 */
  | 'planStatus' | 'desc' | 'note' | 'tags' | 'created' | 'updated' | 'attach'
  | 'priority' | 'assignee' | 'session' | 'group';

/**
 * 列的取值类型，决定它配什么样的筛选控件与排序方式：
 *   enum   → 多选（状态、来源、归属）
 *   text   → 关键词包含
 *   number → 区间（耗时、进度、节点数）
 *   time   → 起止日期
 */
export type ColumnKind = 'enum' | 'text' | 'number' | 'time';

export type TableColumn = {
  id: TableColumnId;
  label: string;
  kind: ColumnKind;
  /** 列宽（px）。总宽大于栏宽时横向滚动 —— 塞进一条窄栏会把每列挤到看不清 */
  width: number;
  align?: 'right';
  /** enum 列的可选项 */
  options?: { v: string; label: string }[];
  /**
   * 选项来自动态源，不在 TABLE_COLUMNS 里写死：
   *   'status'   → 自定义状态流程（boardMeta）
   *   'tags'     → 标签定义（boardMeta）
   *   'assignee' → 当前这批任务里实际出现过的负责人（由调用方去重传入）
   *
   * ⛔ 为什么不把选项直接塞进 TABLE_COLUMNS：
   *    状态和标签是**用户可改**的，而 TABLE_COLUMNS 是模块级常量。
   *    塞进去就得在每次改配置时重建整个列数组，
   *    而"列顺序"与"选项"是两件事，绑一起会让改个标签名连带列的顺序重置。
   */
  dynamic?: 'status' | 'tags' | 'assignee' | 'session';
  /** enum 列的排序权重。不按字典序 —— "运行中"该排在"成功"前面 */
  rank?: Record<string, number>;
  /** 数字列的单位提示，写在区间输入框的 placeholder 上 */
  unit?: string;
};

const STATUS_OPTIONS = (['running', 'success', 'failed', 'cancelled'] as TaskStatus[])
  .map((v) => ({ v, label: STATUS_LABEL[v] }));

const SOURCE_OPTIONS = (['manual', 'interval', 'cron', 'watch', 'webhook', 'chat', 'unknown'] as TaskSource[])
  .map((v) => ({ v, label: SOURCE_LABEL[v] }));

/**
 * 优先级档位。
 *
 * 任务里存的是数字（0 = 未设，1 = P1 最高 … 数字越小越紧急），
 * 这里给出显示名。筛选用的是数字字符串，不是这些名字 ——
 * 改一次显示名不该让已存的筛选失效。
 */
export const PRIORITY_OPTIONS = [
  { v: '1', label: 'P1 最高' },
  { v: '2', label: 'P2 高' },
  { v: '3', label: 'P3 中' },
  { v: '4', label: 'P4 低' },
  { v: '0', label: '未设' },
];

/** 优先级的显示名。数字 → 文案；0 与空都显示"—" */
export function priorityLabel(p: number): string {
  const hit = PRIORITY_OPTIONS.find((o) => o.v === String(p || 0));
  return hit ? hit.label : String(p);
}

export const TABLE_COLUMNS: TableColumn[] = [
  {
    id: 'origin', label: '归属', kind: 'enum', width: 78,
    options: [
      { v: 'board', label: ORIGIN_LABEL.board },
      { v: 'live', label: ORIGIN_LABEL.live },
      { v: 'archived', label: ORIGIN_LABEL.archived },
    ],
    rank: ORIGIN_ORDER,
  },
  { id: 'name', label: '流程', kind: 'text', width: 150 },
  /*
    所属组。用 text（关键词包含）而不是 enum（下拉勾选）：
    组可以任意嵌套，路径组合数随深度增长，做成下拉会冒出几十个
    "登录 › 接口 › 鉴权"这类条目，选起来比打字慢得多。

    ⛔ 这一列与"组标题不参与筛选"那条规定**不冲突**：
    那条说的是搜**任务名**时不该把挂在组下的任务全带出来（name 列的行为）；
    而这里是用户显式地"按所属组找"，是有意为之。
  */
  { id: 'group', label: '所属组', kind: 'text', width: 150 },
  {
    id: 'status', label: '状态', kind: 'enum', width: 84,
    options: STATUS_OPTIONS,
    // 运行中 > 失败 > 已取消 > 成功：出事的排前面，不是按拼音排
    rank: { running: 0, failed: 1, cancelled: 2, success: 3 },
  },
  { id: 'source', label: '来源', kind: 'enum', width: 84, options: SOURCE_OPTIONS },
  { id: 'started', label: '开始', kind: 'time', width: 116 },
  { id: 'ended', label: '结束', kind: 'time', width: 116 },
  { id: 'elapsed', label: '耗时', kind: 'number', width: 84, align: 'right', unit: '秒' },
  { id: 'progress', label: '进度', kind: 'number', width: 78, align: 'right', unit: '%' },
  { id: 'nodes', label: '节点', kind: 'number', width: 68, align: 'right' },
  /* ---- 任务级 ---- */
  {
    id: 'planStatus', label: '计划状态', kind: 'enum', width: 96,
    dynamic: 'status',
  },
  { id: 'desc', label: '任务说明', kind: 'text', width: 170 },
  { id: 'note', label: '备注', kind: 'text', width: 150 },
  { id: 'tags', label: '标签', kind: 'enum', width: 130, dynamic: 'tags' },
  { id: 'created', label: '创建', kind: 'time', width: 116 },
  { id: 'updated', label: '更新', kind: 'time', width: 116 },
  { id: 'attach', label: '附件', kind: 'number', width: 62, align: 'right', unit: '个' },
  /*
    优先级用 enum（下拉选）而不是 number（区间填）：
    "高/中/低"是离散档位，没人会想筛"优先级在 2 到 3 之间"。
    ⛔ 但存的是数字 —— 字符串档位按字典序排会排出"低 < 高 < 中"，
    所以靠下面的 rank 排，不靠字典序。
  */
  {
    id: 'priority', label: '优先级', kind: 'enum', width: 82,
    options: PRIORITY_OPTIONS,
    // 未设排最后：它是"还没定"，不该混在 P1 前面
    rank: { '1': 1, '2': 2, '3': 3, '4': 4, '0': 9 },
  },
  {
    id: 'assignee', label: '认领', kind: 'enum', width: 96,
    dynamic: 'assignee',
  },
  /*
    窗口号：既有任务上的（谁负责），也有运行记录上的（谁跑的）——
    同一列显示"这条归谁 / 谁跑的"，因为两种行不会同时有值。
  */
  {
    id: 'session', label: '窗口', kind: 'enum', width: 96,
    dynamic: 'session',
  },
];

export const TABLE_TOTAL_WIDTH = TABLE_COLUMNS.reduce((s, c) => s + c.width, 0);

export function columnOf(id: TableColumnId): TableColumn {
  for (const c of TABLE_COLUMNS) if (c.id === id) return c;
  return TABLE_COLUMNS[0];
}

/* ------------------------------------------------------------------ */
/* 取值                                                                */
/* ------------------------------------------------------------------ */

/**
 * 单元格的原始值。
 *
 * enum / text 返回字符串（排序走 rank 或字典序），
 * number / time 返回数字 —— 两者分开，避免"10" 与 "9" 按字符串比出 10 < 9。
 */
export function cellValue(
  row: TableRow,
  id: TableColumnId,
  now: number,
  counts?: Record<string, number>,
): string | number {
  const t = row.record;
  const k = row.task;
  switch (id) {
    case 'origin': return ORIGIN_LABEL[row.origin];
    // 任务条目行显示任务标题；运行行显示流程名
    case 'name': return k ? (k.title || '未命名任务') : (t ? (t.canvasName || '未命名流程') : '');
    case 'group': return row.groupPath;
    case 'status': return t ? t.status : '';
    case 'source': return t ? t.source : '';
    case 'started': return t ? t.startedAt : 0;
    /*
      未结束的记录没有 endedAt，这里给 0 而不是 now：
        给 now 的话，正在跑的那条会一直"最新"，排序每秒都在变位置 ——
        表会自己跳，没法点。0 表示"还没结束"，且稳定。
    */
    case 'ended': return t ? (t.endedAt ?? 0) : 0;
    case 'elapsed': return t ? elapsedOf(t, now) : 0;
    case 'progress': return t ? progressOf(t).percent : 0;
    case 'nodes': return t ? Math.max(t.total, t.order.length) : 0;
    /* ---- 任务级 ---- */
    case 'planStatus': return k ? k.status : '';
    case 'desc': return k ? k.desc : '';
    case 'note': return k ? k.note : '';
    // 多值拼成串只是为了能进比较；筛选时按 rawValues 拆开判（见下）
    case 'tags': return k ? k.tags.join(',') : '';
    case 'created': return k ? k.createdAt : 0;
    case 'updated': return k ? k.updatedAt : 0;
    case 'attach': return counts ? attachCountOf(row, counts) : 0;
    case 'priority': return k ? priorityLabel(k.priority) : '';
    case 'assignee': return k ? (k.assignee || '未认领') : '';
    // 任务行取"谁负责"，运行行取"谁跑的"
    case 'session': return k ? (k.session || '') : (t ? (t.session || '') : '');
    default: return '';
  }
}

/**
 * 该列用于**筛选**的原始值（可能多个）。
 *
 * 为什么单独一份而不直接用 cellValue 的返回值：
 * 标签是多值的（一条任务可以挂好几个），拼成串之后
 * "选中 A 和 B"就变成要匹配 "A,B" 这个整体 —— 只有同时挂着 A 和 B
 * 且顺序一致才命中，而用户要的是"挂着 A 或 B 的都算"。
 *
 * 返回数组，enum 匹配统一成"任一命中"，单值列就是长度 1 的数组。
 */
export function rawValues(row: TableRow, id: TableColumnId): string[] {
  switch (id) {
    case 'origin': return [row.origin];
    case 'status': return row.record ? [row.record.status] : [];
    case 'source': return row.record ? [row.record.source] : [];
    case 'planStatus': return row.task ? [row.task.status] : [];
    case 'tags': return row.task ? row.task.tags : [];
    // 存的是数字，筛选用字符串比（选项的 v 也是字符串）
    case 'priority': return row.task ? [String(row.task.priority || 0)] : [];
    // 空串 = 没人领。它要能单独筛出来（"找没人认领的"是很常用的查询），
    // 所以不能返回空数组 —— 空数组在 matchesColumn 里表示"这行没有值，不匹配任何选项"。
    case 'assignee': return row.task ? [row.task.assignee || ''] : [];
    case 'session': return row.task ? [row.task.session || '']
      : row.record ? [row.record.session || ''] : [];
    default: return [];
  }
}

/**
 * 从一批行里算出「窗口」列的选项。
 *
 * 与认领同理：窗口号没有注册表，只能从数据里去重。
 * 空串（没人认领 / 外部触发）单独作为"未知"一项 ——
 * 它占相当比例（外部 webhook、老数据），不能让它无处可选。
 */
export function sessionOptionsOf(rows: TableRow[]): { v: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    const raw = r.task ? (r.task.session || '') : r.record ? (r.record.session || '') : '';
    if (!seen.has(raw)) seen.set(raw, raw || '未知');
  }
  return [...seen.entries()]
    .map(([v, label]) => ({ v, label }))
    .sort((a, b) => (a.v === '' ? 1 : b.v === '' ? -1 : a.label.localeCompare(b.label, 'zh')));
}

/**
 * 从一批行里算出「认领」列的选项。
 *
 * 负责人没有一张"人员表"可查 —— 名字是**手填**的（人写、AI 写都行），
 * 所以只能从现有数据里去重得到。
 *
 * 为什么不在列定义里写死：写死就得先维护一份人员名单，
 * 而这份名单必然与实际数据脱节（漏掉有人、留着已不参与的）。
 */
export function assigneeOptionsOf(rows: TableRow[]): { v: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    const k = r.task;
    if (!k) continue;
    const v = k.assignee || '';
    if (!seen.has(v)) seen.set(v, v || '未认领');
  }
  return [...seen.entries()]
    .map(([v, label]) => ({ v, label }))
    // 未认领排最后 —— 它是"没人"，不该顶在名单前面
    .sort((a, b) => (a.v === '' ? 1 : b.v === '' ? -1 : a.label.localeCompare(b.label, 'zh')));
}

/**
 * 附件计数。
 *
 * 计数**不在 cellValue 里算**：附件清单是另一份数据（不在任务板上），
 * 表格模块拿不到它。由调用方算好传进来，保持本模块是纯函数。
 */
export function attachCountOf(row: TableRow, counts: Record<string, number>): number {
  return counts[row.ownerId] ?? 0;
}

/* ------------------------------------------------------------------ */
/* 筛选                                                                */
/* ------------------------------------------------------------------ */

/**
 * 一列的筛选条件。
 *
 * 六种字段全放在一个对象里，而不是按 kind 分出四个类型 ——
 * 分类型的话状态就是一个联合，UI 每读一个字段都要先窄化，
 * 而"这一列当前有没有筛选"要写四份判定（迟早漏一种）。
 * 代价是 text 列也带着用不到的 min/max，换来的是一份判定、一份清空。
 */
export type ColumnFilter = {
  /** text 列：关键词 */
  text: string;
  /** enum 列：选中的值。空数组 = 不限 */
  values: string[];
  /** number / time 列：下界 */
  min: string;
  /** number / time 列：上界 */
  max: string;
};

export function emptyFilter(): ColumnFilter {
  return { text: '', values: [], min: '', max: '' };
}

/** 这一列的筛选是否生效。判空必须在这一处，UI 与过滤共用 */
export function filterActive(col: TableColumn, f: ColumnFilter | undefined): boolean {
  if (!f) return false;
  switch (col.kind) {
    case 'enum': return f.values.length > 0;
    case 'text': return f.text.trim() !== '';
    case 'number': return numOrNull(f.min) !== null || numOrNull(f.max) !== null;
    case 'time': return dayStart(f.min) !== null || dayEnd(f.max) !== null;
    default: return false;
  }
}

function numOrNull(s: string): number | null {
  const t = (s || '').trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 'YYYY-MM-DD' → 当天 00:00:00 的时间戳。解析不出来返回 null（不当成 0 去卡死筛选） */
function dayStart(s: string): number | null {
  const t = (s || '').trim();
  if (!t) return null;
  const ms = Date.parse(`${t}T00:00:00`);
  return Number.isNaN(ms) ? null : ms;
}

/** 'YYYY-MM-DD' → 当天 23:59:59.999。上界要含当天，否则选"到今天"会把今天排除掉 */
function dayEnd(s: string): number | null {
  const t = (s || '').trim();
  if (!t) return null;
  const ms = Date.parse(`${t}T23:59:59.999`);
  return Number.isNaN(ms) ? null : ms;
}

/** 单列匹配 */
function matchesColumn(
  row: TableRow, col: TableColumn, f: ColumnFilter, now: number,
  counts?: Record<string, number>,
): boolean {
  const v = cellValue(row, col.id, now, counts);
  switch (col.kind) {
    case 'enum': {
      // 按**值**比，不按显示文案比 —— 文案是给人看的，改一次文案筛选就失效
      const raws = rawValues(row, col.id);
      if (raws.length === 0) return false;      // 这行在该列上没有值 → 不匹配任何选项
      // 多值列（标签）命中任一即可
      return raws.some((x) => f.values.indexOf(x) >= 0);
    }
    case 'text': {
      const kw = f.text.trim().toLowerCase();
      if (!kw) return true;
      return String(v).toLowerCase().indexOf(kw) >= 0;
    }
    case 'number': {
      const n = typeof v === 'number' ? v : Number(v);
      if (!Number.isFinite(n)) return false;
      const lo = numOrNull(f.min);
      const hi = numOrNull(f.max);
      if (lo !== null && n < lo) return false;
      if (hi !== null && n > hi) return false;
      return true;
    }
    case 'time': {
      const n = typeof v === 'number' ? v : 0;
      /*
        未结束的记录（endedAt 缺失 → 0）**不参与**时间区间筛选。

        "找 10 月以后结束的"不该带出一堆还没结束的 —— 它们根本没有结束时间，
        放进结果里只是一条永远排在最后的噪音。
        注意这只影响**筛选**：排序时 ended 用 0 是为了让表不抖（见 cellValue）。
      */
      if (n <= 0) return false;
      const lo = dayStart(f.min);
      const hi = dayEnd(f.max);
      if (lo !== null && n < lo) return false;
      if (hi !== null && n > hi) return false;
      return true;
    }
    default:
      return true;
  }
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

export type SortDir = 'asc' | 'desc';

export type TableQuery = {
  filters: Partial<Record<TableColumnId, ColumnFilter>>;
  /** 空 = 不排序，保持原始顺序（live 在前、各自按生成顺序） */
  sortKey: TableColumnId | '';
  sortDir: SortDir;
};

export function emptyQuery(): TableQuery {
  return { filters: {}, sortKey: '', sortDir: 'desc' };
}

/** 生效的筛选列数。头部要显示"已筛 N 列"，判空同样只写一份 */
export function activeFilterColumns(q: TableQuery): TableColumnId[] {
  const out: TableColumnId[] = [];
  for (const c of TABLE_COLUMNS) {
    if (filterActive(c, q.filters[c.id])) out.push(c.id);
  }
  return out;
}

/**
 * 筛掉不匹配的行。
 *
 * 只判**生效**的列：某列 filter 对象存在但全空时，
 * 若照样拿去匹配，text 列会拿空串去 includes（恒真，无害），
 * 但 enum 列的 values 是空数组 → 全部不匹配 → 整表变空。
 * 那是最难自查的一类 bug：看起来"什么都没筛，却一条都没有"。
 */
export function filterRows(
  rows: TableRow[], q: TableQuery, now: number, counts?: Record<string, number>,
): TableRow[] {
  const active = activeFilterColumns(q);
  if (active.length === 0) return rows;
  const cols = active.map(columnOf);
  const fs = active.map((id) => q.filters[id] as ColumnFilter);
  return rows.filter((r) => {
    for (let i = 0; i < cols.length; i += 1) {
      if (!matchesColumn(r, cols[i], fs[i], now, counts)) return false;
    }
    return true;
  });
}

/** 两行的先后。返回负数 = a 在前 */
function compareRows(
  a: TableRow, b: TableRow, id: TableColumnId, dir: SortDir, now: number,
  counts?: Record<string, number>,
): number {
  const col = columnOf(id);
  const av = cellValue(a, id, now, counts);
  const bv = cellValue(b, id, now, counts);
  let d = 0;
  if (typeof av === 'number' && typeof bv === 'number') {
    d = av - bv;
  } else if (col.kind === 'enum' && col.rank) {
    /*
      按**原始值**查 rank，不能拿显示文案去查。

      rank 的键是数据里存的那个值（'running' / '1' / 'live'），
      而 cellValue 给的是给人看的文案（"运行中" / "P1 最高" / "进行中"）。
      拿文案去查必然全部落空 → 都返回 99 → 这一列等于没法排序，
      而界面上看不出坏了（点了有反应，只是顺序不对）。

      顺带修掉的既有问题：归属列此前就是这么失效的。
    */
    const ar = col.rank[rawValues(a, id)[0] ?? ''] ?? 99;
    const br = col.rank[rawValues(b, id)[0] ?? ''] ?? 99;
    d = ar - br;
  } else {
    d = String(av).localeCompare(String(bv), 'zh');
  }
  if (d === 0) return 0;
  return dir === 'asc' ? d : -d;
}

/**
 * 排序。
 *
 * 末尾用 id 兜底：V8 的 sort 虽然稳定，但这里排序键会随时间变
 * （耗时、进度每秒都在动），只靠稳定性仍可能让相邻两行来回换位置。
 * id 是唯一的，兜底后顺序完全确定 —— 正在跑的表不会自己抖。
 */
export function sortRows(
  rows: TableRow[], q: TableQuery, now: number, counts?: Record<string, number>,
): TableRow[] {
  if (!q.sortKey) return rows;
  const id = q.sortKey;
  const dir = q.sortDir;
  return [...rows].sort((a, b) => {
    const d = compareRows(a, b, id, dir, now, counts);
    if (d !== 0) return d;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** 筛选 + 排序。表格每次渲染走这一个入口，两件事的顺序就不会分叉 */
export function applyTable(
  rows: TableRow[], q: TableQuery, now: number, counts?: Record<string, number>,
): TableRow[] {
  return sortRows(filterRows(rows, q, now, counts), q, now, counts);
}

/**
 * 点列头的三态：无序 → 降序 → 升序 → 无序。
 *
 * 第三下回到无序而不是继续留在这一列 —— 表默认顺序（live 在前）本身有意义，
 * 不给回程的话，想恢复只能刷新页面。
 */
export function nextSort(
  cur: { sortKey: TableColumnId | ''; sortDir: SortDir },
  id: TableColumnId,
): { sortKey: TableColumnId | ''; sortDir: SortDir } {
  if (cur.sortKey !== id) return { sortKey: id, sortDir: 'desc' };
  if (cur.sortDir === 'desc') return { sortKey: id, sortDir: 'asc' };
  return { sortKey: '', sortDir: 'desc' };
}

/* ------------------------------------------------------------------ */
/* 虚拟滚动                                                            */
/* ------------------------------------------------------------------ */

export const TABLE_ROW_HEIGHT = 28;
export const TABLE_OVERSCAN = 4;

export type TableSlice = {
  start: number;
  end: number;
  padTop: number;
  totalHeight: number;
};

/**
 * 固定行高的切片。
 *
 * 不用 tasks.ts 的 windowSlice：那个按行类型累加偏移（组头 40 / 任务 76），
 * 表格行高恒定，除以行高就能定位，没必要为它准备一份 offsets 数组。
 */
export function tableSlice(
  count: number,
  scrollTop: number,
  viewportH: number,
  rowH: number = TABLE_ROW_HEIGHT,
  overscan: number = TABLE_OVERSCAN,
): TableSlice {
  if (count <= 0) return { start: 0, end: 0, padTop: 0, totalHeight: 0 };
  const top = Math.max(0, scrollTop);
  /*
    起始行要夹到 count 以内。
    不夹的话，容器高度临时变大再变小（面板拖动、窗口缩放）会让 scrollTop
    短暂停在一个远超总高的值上，算出 start > count —— 于是 slice 出一段
    空区间，表**整块空白**，而滚动条还在，看着像数据丢了。
  */
  const start = Math.min(Math.max(0, Math.floor(top / rowH) - overscan), count - 1);
  const end = Math.min(count, Math.ceil((top + Math.max(0, viewportH)) / rowH) + overscan);
  return {
    start,
    end,
    padTop: start * rowH,
    totalHeight: count * rowH,
  };
}

/* ------------------------------------------------------------------ */
/* 显示                                                                */
/* ------------------------------------------------------------------ */

/** 结束时间：未结束显示"—"，不给一个假的时间戳 */
export function formatEndedAt(endedAt: number | undefined): string {
  return endedAt ? formatDateTime(endedAt) : '—';
}
