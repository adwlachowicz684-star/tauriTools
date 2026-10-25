/**
 * 任务板表格 —— 任务管理器的表格视图：数据模型 + 筛选 + 排序。
 *
 * ================= 为什么单独一份，不复用运行记录表格 =================
 *
 * 运行记录表格（taskTable.ts）放的是"哪次跑怎么样"：耗时、进度、节点数。
 * 任务板放的是"要做什么"：说明、优先级、标签、谁认领的。
 *
 * 这两套数据的字段**几乎不重叠**。曾经把它们并进同一张表，
 * 结果是同一行里互相留空 —— 运行行在"说明"列空着、计划行在"耗时"列空着，
 * 一张表里一半格子是「—」。那不是功能更全，是两张表硬叠在一起。
 *
 * 所以这里另起一份。共用的只有"筛选与排序的机制"（ColumnFilter 那套），
 * 那部分从 taskTable.ts import，不重写。
 *
 * ================= 组不占行 =================
 *
 * 任务板是**树**（组可以递归嵌套），但表格是平的。
 * 组本身不占一行 —— 它的状态由下面的任务决定，单独成行会显示成"待办"，
 * 那是误导。组的层级通过「所属组」列显示成 `容器 › 登录` 这样的路径。
 */

import {
  type TaskBoard, type BoardTask, isGroup, childrenOf,
} from './taskBoard';
import {
  type ColumnFilter, emptyFilter as emptyFilterOf,
  type SortDir,
} from './taskTable';

/* ------------------------------------------------------------------ */
/* 行                                                                  */
/* ------------------------------------------------------------------ */

export type BoardRow = {
  /** 稳定 key。任务 id 本身唯一，不带前缀（这里只有一类数据） */
  key: string;
  id: string;
  task: BoardTask;
  /**
   * 所属**组**的标题链，如"容器 › 登录"。顶层为空串。
   *
   * 没有它的话，嵌套结构在表格里完全不可见 ——
   * 两条同名任务分不出谁在哪个组下。
   */
  groupPath: string;
  /** 嵌套深度。0 = 顶层 */
  depth: number;
};

/** 组路径的分隔符。用 › 而不是 / —— 后者与文件路径混淆 */
export const GROUP_SEP = ' › ';

/**
 * 把任务板摊平成行。
 *
 * 先序遍历：顺序即树上的上下顺序，与列表视图里看到的次序一致 ——
 * 两个视图对同一条任务不会各排各的。
 *
 * 祖先组的标题在遍历时**顺手带下来**，而不是事后对每个任务回溯 parent：
 * 一次遍历就有的东西，回溯会把这里变成 O(行 × 深度)，
 * 而深层嵌套时深度并不小。
 */
export function buildBoardRows(board: TaskBoard | null | undefined): BoardRow[] {
  const rows: BoardRow[] = [];
  if (!board) return rows;
  const walk = (parent: string | null, trail: string[], depth: number): void => {
    for (const id of childrenOf(board, parent)) {
      const n = board.nodes[id];
      if (!n) continue;
      if (isGroup(n)) { walk(id, [...trail, n.title], depth + 1); continue; }
      rows.push({
        key: id,
        id,
        task: n,
        groupPath: trail.join(GROUP_SEP),
        depth,
      });
    }
  };
  walk(null, [], 0);
  return rows;
}

/* ------------------------------------------------------------------ */
/* 列                                                                  */
/* ------------------------------------------------------------------ */

export type BoardColumnId =
  | 'name' | 'group' | 'status' | 'priority' | 'assignee' | 'session'
  | 'tags' | 'desc' | 'note' | 'created' | 'updated' | 'attach';

/**
 * 列的取值类型，决定它配什么样的筛选控件与排序方式：
 *   enum   → 多选（状态、优先级、认领、窗口、标签）
 *   text   → 关键词包含（任务名、所属组、说明、备注）
 *   number → 区间（附件数）
 *   time   → 起止日期（创建、更新）
 */
export type ColumnKind = 'enum' | 'text' | 'number' | 'time';

export type BoardColumn = {
  id: BoardColumnId;
  label: string;
  kind: ColumnKind;
  /** 列宽（px）。总宽大于栏宽时横向滚动 —— 塞进一条窄栏会把每列挤到看不清 */
  width: number;
  align?: 'right';
  /** enum 列的可选项。动态列不写死，由调用方现算 */
  options?: { v: string; label: string }[];
  /**
   * 选项来自动态源，不在 BOARD_COLUMNS 里写死：
   *   'status'   → 自定义状态流程（boardMeta）
   *   'tags'     → 标签定义（boardMeta）
   *   'assignee' → 当前这批任务里实际出现过的名字（由调用方去重传入）
   *   'session'  → 同上，窗口号
   *
   * ⛔ 为什么不把选项直接塞进 BOARD_COLUMNS：
   *    状态和标签是**用户可改**的，而 BOARD_COLUMNS 是模块级常量。
   *    塞进去就得在每次改配置时重建整个列数组，
   *    而"列顺序"与"选项"是两件事，绑一起会让改个标签名连带列的顺序重置。
   */
  dynamic?: 'status' | 'tags' | 'assignee' | 'session';
  /** enum 列的排序权重。不按字典序 —— "进行中"该排在"已完成"前面 */
  rank?: Record<string, number>;
  /** 数字列的单位提示 */
  unit?: string;
};

export const BOARD_COLUMNS: BoardColumn[] = [
  { id: 'name', label: '任务', kind: 'text', width: 160 },
  /*
    所属组。用 text（关键词包含）而不是 enum（下拉勾选）：
    组可以任意嵌套，路径组合数随深度增长，做成下拉会冒出几十个
    "登录 › 接口 › 鉴权"这类条目，选起来比打字慢得多。

    ⛔ 这一列与"组标题不参与筛选"那条规定**不冲突**：
    那条说的是搜**任务名**时不该把挂在组下的任务全带出来（name 列的行为）；
    而这里是用户显式地"按所属组找"，是有意为之。
  */
  { id: 'group', label: '所属组', kind: 'text', width: 140 },
  {
    id: 'status', label: '状态', kind: 'enum', width: 96,
    dynamic: 'status',
  },
  /*
    优先级用 enum（下拉选）而不是 number（区间填）：
    "高/中/低"是离散档位，没人会想筛"优先级在 2 到 3 之间"。
    ⛔ 但存的是数字 —— 字符串档位按字典序排会排出"低 < 高 < 中"，
    所以靠下面的 rank 排，不靠字典序。
  */
  {
    id: 'priority', label: '优先级', kind: 'enum', width: 88,
    options: [
      { v: '1', label: 'P1 最高' },
      { v: '2', label: 'P2 高' },
      { v: '3', label: 'P3 中' },
      { v: '4', label: 'P4 低' },
      { v: '0', label: '未设' },
    ],
    // 未设排最后：它是"还没定"，不该混在 P1 前面
    rank: { '1': 1, '2': 2, '3': 3, '4': 4, '0': 9 },
  },
  {
    id: 'assignee', label: '认领', kind: 'enum', width: 100,
    dynamic: 'assignee',
  },
  {
    id: 'session', label: '窗口', kind: 'enum', width: 100,
    dynamic: 'session',
  },
  { id: 'tags', label: '标签', kind: 'enum', width: 130, dynamic: 'tags' },
  { id: 'desc', label: '任务说明', kind: 'text', width: 170 },
  { id: 'note', label: '备注', kind: 'text', width: 150 },
  { id: 'created', label: '创建', kind: 'time', width: 116 },
  { id: 'updated', label: '更新', kind: 'time', width: 116 },
  { id: 'attach', label: '附件', kind: 'number', width: 62, align: 'right', unit: '个' },
];

export const BOARD_TOTAL_WIDTH = BOARD_COLUMNS.reduce((s, c) => s + c.width, 0);

export function boardColumnOf(id: BoardColumnId): BoardColumn {
  for (const c of BOARD_COLUMNS) if (c.id === id) return c;
  return BOARD_COLUMNS[0];
}

/** 优先级的显示名。数字 → 文案；0 与空都显示"—" */
export function priorityLabel(p: number): string {
  const hit = boardColumnOf('priority').options?.find((o) => o.v === String(p || 0));
  return hit ? hit.label : String(p);
}

/* ------------------------------------------------------------------ */
/* 取值                                                                */
/* ------------------------------------------------------------------ */

/** 单元格给**人看**的值 */
export function boardCellValue(
  row: BoardRow,
  id: BoardColumnId,
  attach: Record<string, number>,
): string | number {
  const t = row.task;
  switch (id) {
    case 'name': return t.title || '未命名任务';
    case 'group': return row.groupPath;
    case 'status': return t.status;
    case 'priority': return priorityLabel(t.priority);
    case 'assignee': return t.assignee || '未认领';
    case 'session': return t.session || '';
    case 'tags': return t.tags.join('、');
    case 'desc': return t.desc || '';
    case 'note': return t.note || '';
    case 'created': return t.createdAt;
    case 'updated': return t.updatedAt;
    case 'attach': return attach[row.id] ?? 0;
    default: return '';
  }
}

/**
 * 该列用于**筛选**的原始值（可能多个）。
 *
 * 为什么单独一份而不直接用 boardCellValue 的返回值：
 * boardCellValue 给的是给人看的文案（"进行中"、"P1 最高"），
 * 而筛选值必须按数据里的原始值比 —— 改一次显示文案不该让已存的筛选失效。
 *
 * 返回数组是因为标签是多值的：一条任务可以挂好几个。
 * 拼成串之后"选中 A 和 B"会变成要匹配 "A,B" 这个整体，
 * 而用户要的是"挂着 A 或 B 的都算"。
 */
export function boardRawValues(row: BoardRow, id: BoardColumnId): string[] {
  const t = row.task;
  switch (id) {
    case 'status': return [t.status];
    // 存的是数字，筛选用字符串比（选项的 v 也是字符串）
    case 'priority': return [String(t.priority || 0)];
    // 空串 = 没人领。它要能单独筛出来（"找没人认领的"是很常用的查询），
    // 所以不能返回空数组 —— 空数组表示"这行没有值，不匹配任何选项"。
    case 'assignee': return [t.assignee || ''];
    case 'session': return [t.session || ''];
    case 'tags': return t.tags;
    default: return [];
  }
}

/* ------------------------------------------------------------------ */
/* 筛选                                                                */
/* ------------------------------------------------------------------ */

export type BoardFilter = ColumnFilter;

export function emptyBoardFilter(): BoardFilter {
  return emptyFilterOf();
}

/** 这一列的筛选是否生效 */
export function boardFilterActive(col: BoardColumn, f: BoardFilter | undefined): boolean {
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

/** 'YYYY-MM-DD' → 当天 00:00:00。解析不出来返回 null（不当成 0 去卡死筛选） */
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
  row: BoardRow, col: BoardColumn, f: BoardFilter, attach: Record<string, number>,
): boolean {
  const v = boardCellValue(row, col.id, attach);
  switch (col.kind) {
    case 'enum': {
      // 按**值**比，不按显示文案比 —— 文案是给人看的，改一次文案筛选就失效
      const raws = boardRawValues(row, col.id);
      if (raws.length === 0) return false;   // 这行在该列上没有值 → 不匹配任何选项
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
        时间为 0（老数据没记）**不参与**区间筛选。
        "找 10 月以后创建的"不该带出一堆没时间戳的 ——
        它们根本没有创建时间，放进结果里只是一条永远排在最后的噪音。
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

export type BoardQuery = {
  filters: Partial<Record<BoardColumnId, BoardFilter>>;
  /** 空 = 不排序，保持树上的原始顺序 */
  sortKey: BoardColumnId | '';
  sortDir: SortDir;
};

export function emptyBoardQuery(): BoardQuery {
  return { filters: {}, sortKey: '', sortDir: 'desc' };
}

/** 生效的筛选列数 */
export function boardActiveFilters(q: BoardQuery): BoardColumnId[] {
  const out: BoardColumnId[] = [];
  for (const c of BOARD_COLUMNS) {
    if (boardFilterActive(c, q.filters[c.id])) out.push(c.id);
  }
  return out;
}

/**
 * 筛掉不匹配的行。
 *
 * 只判**生效**的列：某列 filter 对象存在但全空时，
 * 若照样拿去匹配，enum 列的 values 是空数组 → 全部不匹配 → 整表变空。
 * 那是最难自查的一类 bug：看起来"什么都没筛，却一条都没有"。
 */
export function filterBoardRows(
  rows: BoardRow[], q: BoardQuery, attach: Record<string, number>,
): BoardRow[] {
  const active = boardActiveFilters(q);
  if (active.length === 0) return rows;
  const cols = active.map(boardColumnOf);
  const fs = active.map((id) => q.filters[id] as BoardFilter);
  return rows.filter((r) => {
    for (let i = 0; i < cols.length; i += 1) {
      if (!matchesColumn(r, cols[i], fs[i], attach)) return false;
    }
    return true;
  });
}

/** 两行的先后。返回负数 = a 在前 */
function compareRows(
  a: BoardRow, b: BoardRow, id: BoardColumnId, dir: SortDir, attach: Record<string, number>,
): number {
  const col = boardColumnOf(id);
  const av = boardCellValue(a, id, attach);
  const bv = boardCellValue(b, id, attach);
  let d = 0;
  if (typeof av === 'number' && typeof bv === 'number') {
    d = av - bv;
  } else if (col.kind === 'enum' && col.rank) {
    /*
      按**原始值**查 rank，不能拿显示文案去查。

      rank 的键是数据里存的那个值（'1' / 'todo'），
      而 boardCellValue 给的是给人看的文案（"P1 最高" / "进行中"）。
      拿文案去查必然全部落空 → 都返回 99 → 这一列等于没法排序，
      而界面上看不出坏了（点了有反应，只是顺序不对）。
    */
    const ar = col.rank[boardRawValues(a, id)[0] ?? ''] ?? 99;
    const br = col.rank[boardRawValues(b, id)[0] ?? ''] ?? 99;
    d = ar - br;
  } else {
    d = String(av).localeCompare(String(bv), 'zh');
  }
  if (d === 0) return 0;
  return dir === 'asc' ? d : -d;
}

export function sortBoardRows(
  rows: BoardRow[], q: BoardQuery, attach: Record<string, number>,
): BoardRow[] {
  if (!q.sortKey) return rows;
  const id = q.sortKey;
  const dir = q.sortDir;
  return [...rows].sort((a, b) => {
    const d = compareRows(a, b, id, dir, attach);
    if (d !== 0) return d;
    // id 兜底：排序键相等时顺序完全确定，表不会自己抖
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** 筛选 + 排序。表格每次渲染走这一个入口，两件事的顺序就不会分叉 */
export function applyBoardQuery(
  rows: BoardRow[], q: BoardQuery, attach: Record<string, number>,
): BoardRow[] {
  return sortBoardRows(filterBoardRows(rows, q, attach), q, attach);
}

/**
 * 点列头的三态：无序 → 降序 → 升序 → 无序。
 *
 * 第三下回到无序而不是继续留在这一列 —— 表默认顺序（树上的上下顺序）
 * 本身有意义，不给回程的话，想恢复只能刷新页面。
 */
export function nextBoardSort(
  cur: { sortKey: BoardColumnId | ''; sortDir: SortDir },
  id: BoardColumnId,
): { sortKey: BoardColumnId | ''; sortDir: SortDir } {
  if (cur.sortKey !== id) return { sortKey: id, sortDir: 'desc' };
  if (cur.sortDir === 'desc') return { sortKey: id, sortDir: 'asc' };
  return { sortKey: '', sortDir: 'desc' };
}

/* ------------------------------------------------------------------ */
/* 动态选项                                                            */
/* ------------------------------------------------------------------ */

/**
 * 从一批行里算出某个动态列的选项。
 *
 * 认领人与窗口号都没有注册表可查 —— 名字是手填的（人写、AI 写都行），
 * 所以只能从现有数据里去重得到。
 *
 * ⛔ 为什么不在列定义里写死：写死就得先维护一份名单，
 * 而那份名单必然与实际数据脱节（漏掉有人、留着已不参与的）。
 */
export function distinctOptionsOf(
  rows: BoardRow[],
  field: 'assignee' | 'session',
): { v: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const r of rows) {
    const raw = field === 'assignee' ? (r.task.assignee || '') : (r.task.session || '');
    if (seen.has(raw)) continue;
    seen.set(raw, raw || (field === 'assignee' ? '未认领' : '未知'));
  }
  // 空值排最后 —— 它是"没人"，不该顶在名单前面
  return [...seen.entries()]
    .map(([v, label]) => ({ v, label }))
    .sort((a, b) => (a.v === '' ? 1 : b.v === '' ? -1 : a.label.localeCompare(b.label, 'zh')));
}
