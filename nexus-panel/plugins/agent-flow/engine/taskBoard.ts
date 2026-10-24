/**
 * 任务板 —— 计划态的任务树：任务组、多层拆分、前置依赖。
 *
 * ================= 与「运行记录」是两回事 =================
 *
 * engine/tasks.ts 里的 TaskRecord 是**已经跑过**的记录（运行态）；
 * 这里的是**打算做什么**（计划态）：
 *
 *   运行记录：跑一次产生一条，有进度、耗时、节点输出
 *   任务板：  人 / AI 预先编排的东西，有层级、有前置、可领取
 *
 * 两者刻意不合并 —— 合并的话"跑过一次"和"待办"要挤在同一套状态里，
 * 而跑到一半的待办与跑完的记录是两种完全不同的东西。
 *
 * ================= 为什么落文件，而不是 localStorage =================
 *
 * AI 要能**不打开工具**就改任务：新增、领取、标记状态，都是改文件完成的。
 * localStorage 在浏览器里、且只有这个插件自己能读 —— 那等于要求 AI
 * 必须先打开界面。文件则谁都能读改，diff 也看得见。
 *
 * 所以文件格式就是对外契约，**字段名的稳定性比省几个字节重要**。
 *
 * ================= 文件格式 =================
 *
 *   {
 *     "v": 1,
 *     "project": "p1",          项目（画布分组）id，空串 = 未分组
 *     "projectName": "项目甲",  冗余存一份：AI 只读文件也知道这是哪个项目
 *     "updatedAt": 1760000000000,
 *     "root": ["g1", "t5"],     顶层顺序
 *     "nodes": {
 *       "g1": { "kind": "group", "title": "登录模块", "children": ["t1", "t2"] },
 *       "t1": { "kind": "task", "title": "设计表结构", "status": "todo",
 *               "deps": [], "assignee": "", "note": "" }
 *     }
 *   }
 *
 * 为什么用 **children 数组**而不是给每个节点存 parent：
 * 顺序是树的一部分（谁先谁后），children 让它显式且稳定。
 * 存 parent 的话顺序只能靠对象键顺序 —— 那是"碰巧能用"，不是契约。
 *
 * ================= 依赖可以指向任务组 =================
 *
 * deps 里可以填任务 id，**也可以填任务组 id**，语义是"等这个组里所有任务完成"。
 *
 * 这是拆分能安全进行的前提：一个任务被拆成组之后，原来依赖它的那些任务
 * 仍指着同一个 id —— 不用回头改一堆引用，也不会出现"拆完以后依赖悬空"。
 *
 * ================= 状态与"锁定" =================
 *
 * status 只存 todo / doing / done / cancelled 四种**事实**。
 * 「被前置任务卡住」**不存** —— 它是从 deps 算出来的（见 lockOf）。
 *
 * 存下来的话就有两份真相：前置任务标成 done 之后，这条的 locked 字段
 * 若没人同步更新，界面就永远显示"被卡住"。那种错误查不出原因。
 */

export const BOARD_VERSION = 1;

/**
 * 计划状态。
 *
 * 现在是**自定义状态 id**（如 'todo' / 'review'），不再是写死的联合类型 ——
 * 状态集由用户在 boardMeta 里配（见 engine/boardMeta.ts）。
 *
 * ⛔ 别把它当成"运行结果"：跑成功了还是失败了是系统记的事实，
 * 这里存的是**人推到哪一步**。两者在表格里是独立的两列。
 */
export type BoardStatus = string;

/** 默认那套状态的 id。数据里没写、或写了不认识的 id 时退回它 */
export const DEFAULT_STATUS = 'todo';

/**
 * 内置状态的兜底显示名。
 *
 * 只在**拿不到项目元数据**时用（那时显示 id 会是一串英文）。
 * 正常路径一律走 boardMeta.statusName() —— 用户可能把"待办"改成"需求池"，
 * 那份名字才是准的。
 */
export const BOARD_STATUS_LABEL: Record<string, string> = {
  todo: '待办',
  doing: '进行中',
  held: '已挂起',
  done: '已完成',
  cancelled: '已取消',
};

export type BoardGroup = {
  kind: 'group';
  /** 只作为显示用 —— 不参与筛选（见 matchesTask） */
  title: string;
  children: string[];
};

export type BoardTask = {
  kind: 'task';
  title: string;
  status: BoardStatus;
  /** 前置任务 / 任务组的 id。指向组 = 等它下面全部完成 */
  deps: string[];
  /** 谁领了。空 = 没人领 */
  assignee: string;
  note: string;
  /**
   * 任务说明 —— 一句话说清这条要做什么。
   *
   * 与 note（备注）分开：说明是"要做什么"，备注是"过程中记的"。
   * 混成一个字段的话，做完之后没人去清理说明，
   * 下次看到这条分不清哪些是原始要求、哪些是后来的补充。
   */
  desc: string;
  /** 标签 id 列表。标签定义（名字 + 颜色）在 boardMeta 里 */
  tags: string[];
  /**
   * 创建时间。自动生成，不可改。
   *
   * 为什么必须存：任务板是给人排期的，"这条挂了多久没动"
   * 全靠它 —— 不存就只能看更新时间，而更新时间会被无关编辑顶掉。
   */
  createdAt: number;
  /** 最后更新时间。任何字段变动都推进它 */
  updatedAt: number;
  /**
   * 截止时间（时间戳）。0 = 没设。
   *
   * 用 0 而不是 null：JSON 里 null 与"没写"分不清，
   * 而 0 在排序时能明确落到"没有截止"这一档。
   */
  due: number;
  /**
   * 优先级。0 = 未设，1 = P1（最高）…数字越小越紧急。
   *
   * 用数字而不是字符串：排序要能比大小，
   * "高/中/低"按字典序排会排出"低 < 高 < 中"这种荒唐顺序。
   */
  priority: number;
};

export type BoardNode = BoardGroup | BoardTask;

export type TaskBoard = {
  v: number;
  project: string;
  projectName: string;
  updatedAt: number;
  root: string[];
  nodes: Record<string, BoardNode>;
};

export function emptyBoard(project = '', projectName = ''): TaskBoard {
  return {
    v: BOARD_VERSION,
    project,
    projectName,
    updatedAt: 0,
    root: [],
    nodes: {},
  };
}

/* ------------------------------------------------------------------ */
/* 解析 / 序列化                                                       */
/* ------------------------------------------------------------------ */

export function isGroup(n: BoardNode | undefined): n is BoardGroup {
  return !!n && n.kind === 'group';
}

export function isTask(n: BoardNode | undefined): n is BoardTask {
  return !!n && n.kind === 'task';
}

/*
  状态不再有一个"合法值清单" —— 状态集是用户在 boardMeta 里配的，
  这里无从知道有哪些。所以只要是非空字符串就认。

  ⛔ 不要在这里校验"这个状态在 meta 里存不存在"：
     解析发生在 meta 加载之前（两者是并行读的两个文件），
     此刻校验必然误判；且用户删了某个状态后，
     老任务上的旧 id 该**保留**（见 boardMeta.removeStatus 的说明），
     校验把它们清掉反而丢失了"这条用的是已删除状态"这个信息。
*/
function statusOfRaw(v: unknown): BoardStatus {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || DEFAULT_STATUS;
}

function asIdList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * 解析。手改过、缺字段、字段类型不对都要能兜住。
 *
 * 为什么不做严格校验后报错：AI 手改文件时漏一个字段是很常见的，
 * 而"整个任务板打不开"的代价远大于"那条备注丢了"。
 * 能修的修，修不了的（比如节点既不是组也不是任务）整个丢掉 ——
 * 留着一个不知道是什么的节点，后面每一步都要判它。
 */
export function parseBoard(raw: string | null, project = '', projectName = ''): TaskBoard {
  if (!raw) return emptyBoard(project, projectName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyBoard(project, projectName);
  }
  if (!parsed || typeof parsed !== 'object') return emptyBoard(project, projectName);
  const o = parsed as Record<string, unknown>;
  const nodes: Record<string, BoardNode> = {};
  const rawNodes = (o.nodes && typeof o.nodes === 'object') ? o.nodes as Record<string, unknown> : {};
  for (const k of Object.keys(rawNodes)) {
    const n = rawNodes[k] as Record<string, unknown>;
    if (!n || typeof n !== 'object') continue;
    const title = typeof n.title === 'string' ? n.title : k;
    if (n.kind === 'group') {
      nodes[k] = { kind: 'group', title, children: asIdList(n.children) };
      continue;
    }
    if (n.kind === 'task') {
      /*
        时间字段：写了就用，没写给 0。
        createdAt 给 0 而不是"现在" —— 给现在会让一条
        从别处迁移来的老任务显示成刚建的，历史就假了。
      */
      const createdAt = typeof n.createdAt === 'number' && isFinite(n.createdAt) ? n.createdAt : 0;
      const updatedAtRaw = typeof n.updatedAt === 'number' && isFinite(n.updatedAt) ? n.updatedAt : 0;
      nodes[k] = {
        kind: 'task',
        title,
        status: statusOfRaw(n.status),
        deps: asIdList(n.deps),
        assignee: typeof n.assignee === 'string' ? n.assignee : '',
        note: typeof n.note === 'string' ? n.note : '',
        desc: typeof n.desc === 'string' ? n.desc : '',
        tags: asIdList(n.tags),
        createdAt,
        // 没写过 updatedAt 时用 createdAt —— 至少不会显示成"从未更新"
        updatedAt: updatedAtRaw || createdAt,
        due: typeof n.due === 'number' && isFinite(n.due) ? n.due : 0,
        priority: typeof n.priority === 'number' && isFinite(n.priority) ? n.priority : 0,
      };
    }
  }
  const rootRaw = asIdList(o.root).filter((id) => nodes[id]);
  /*
    丢弃**指向不存在节点**的 children 与 deps。
    留着的话渲染时会撞上 undefined，而"树里挂着一个不存在的 id"
    在界面上表现为一行空白，看不出是数据坏了。
  */
  for (const id of Object.keys(nodes)) {
    const n = nodes[id];
    if (isGroup(n)) n.children = n.children.filter((c) => nodes[c] && c !== id);
    else n.deps = n.deps.filter((d) => nodes[d] && d !== id);
  }
  const root = normalizeTree(nodes, rootRaw);
  return {
    v: BOARD_VERSION,
    project: typeof o.project === 'string' ? o.project : project,
    projectName: typeof o.projectName === 'string' ? o.projectName : projectName,
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    root,
    nodes,
  };
}

/** 缩进 2 空格：AI 改完要能 diff，压成一行就没法看了 */
export function serializeBoard(b: TaskBoard): string {
  return JSON.stringify(b, null, 2);
}

/* ------------------------------------------------------------------ */
/* 树结构归一                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把任意（可能是手写的）父子关系整理成一棵**合法的树**。
 *
 * ================= 为什么必须有这一步 =================
 *
 * 这个文件的主要用途就是给 AI 直接改。而手写出的 JSON 完全可能是：
 *
 *   ① 互相嵌套：g1.children=[g2] 且 g2.children=[g1]
 *      → boardRows 递归下去**栈溢出**，整个面板白屏（实测 RangeError）
 *   ② 同一个节点被写进两个组
 *      → 同一条任务在界面上出现两次，状态还各自独立
 *
 * 两种情况都不是"数据有点脏"，是**打不开**。而它们恰恰最容易出现在
 * AI 批量写入的时候（它拼 JSON 时不会去校验全局唯一性）。
 *
 * ================= 做法：从 root 出发 BFS，每个节点只认第一个父 ==========
 *
 * 后出现的重复引用直接丢弃（不是报错）—— 报错会让整份文件打不开，
 * 而丢一条重复的引用只影响该节点挂在谁下面，数据本身还在。
 *
 * BFS 天然免疫环：访问过的节点不再进队，环在第二圈就被截断。
 *
 * 最后把**没被任何人引用**的节点挂到 root —— 不挂的话它根本不显示，
 * AI 会以为自己写入失败了。
 */
export function normalizeTree(nodes: Record<string, BoardNode>, rootRaw: string[]): string[] {
  const claimed = new Set<string>();
  const children: Record<string, string[]> = {};
  for (const id of Object.keys(nodes)) children[id] = [];

  const root: string[] = [];
  const queue: string[] = [];
  const pushRoot = (id: string) => {
    if (claimed.has(id)) return;
    claimed.add(id);
    root.push(id);
    queue.push(id);
  };
  for (const id of rootRaw) pushRoot(id);

  // BFS：一层层往下认领，先到先得
  while (queue.length > 0) {
    const id = queue.shift() as string;
    const n = nodes[id];
    if (!isGroup(n)) continue;
    for (const c of n.children) {
      if (claimed.has(c)) continue;      // 已经挂在别处了 —— 丢弃这次引用
      if (!nodes[c]) continue;
      claimed.add(c);
      children[id].push(c);
      queue.push(c);
    }
  }

  // 游离节点补进 root：手改文件漏挂时最常出现
  for (const id of Object.keys(nodes)) {
    if (claimed.has(id)) continue;
    claimed.add(id);
    root.push(id);
    children[id] = [];
  }

  for (const id of Object.keys(nodes)) {
    const n = nodes[id];
    if (isGroup(n)) n.children = children[id];
  }
  return root;
}

/* ------------------------------------------------------------------ */
/* id                                                                  */
/* ------------------------------------------------------------------ */

let seq = 0;

/**
 * 生成 id。
 *
 * 用短前缀 + 时间 + 自增，而不是随机串 —— AI 在文件里**看得懂** `t_1760...`
 * 是任务，也能自己照着格式加一条。随机 id 让手写变得不可能。
 */
export function newBoardId(kind: 'task' | 'group', now: number = Date.now()): string {
  seq += 1;
  return `${kind === 'group' ? 'g' : 't'}_${now.toString(36)}_${seq}`;
}

/** 文件里已存在某个 id 时换个新的（AI 手写的 id 可能与生成的撞） */
export function nextFreeId(board: TaskBoard, want: string): string {
  if (!board.nodes[want]) return want;
  let i = 2;
  while (board.nodes[`${want}_${i}`]) i += 1;
  return `${want}_${i}`;
}

/* ------------------------------------------------------------------ */
/* 树                                                                  */
/* ------------------------------------------------------------------ */

export function childrenOf(board: TaskBoard, id: string | null): string[] {
  return id === null ? board.root : (isGroup(board.nodes[id]) ? (board.nodes[id] as BoardGroup).children : []);
}

/** 父节点 id。顶层返回 null */
export function parentOf(board: TaskBoard, id: string): string | null {
  for (const p of Object.keys(board.nodes)) {
    const n = board.nodes[p];
    if (isGroup(n) && n.children.indexOf(id) >= 0) return p;
  }
  // 顶层节点没有父；被孤儿化的节点（既不在 root 也不在任何 children 里）
  // 同样返回 null —— parseBoard 已保证每个节点都挂在 root 上，不会有第二种
  return null;
}

/** 从根到该节点的 id 链（含自身） */
export function pathOf(board: TaskBoard, id: string): string[] {
  const out: string[] = [];
  let cur: string | null = id;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    out.unshift(cur);
    cur = parentOf(board, cur);
  }
  return out;
}

/** 子树里的全部 id（不含自身） */
export function descendantIds(board: TaskBoard, id: string): string[] {
  const out: string[] = [];
  const walk = (x: string) => {
    for (const c of childrenOf(board, x)) { out.push(c); walk(c); }
  };
  walk(id);
  return out;
}

/** 子树里的**任务** id。组没有状态，能"完成"的只有任务 */
export function leafTaskIds(board: TaskBoard, id: string): string[] {
  const n = board.nodes[id];
  if (!n) return [];
  if (isTask(n)) return [id];
  const out: string[] = [];
  const walk = (x: string) => {
    for (const c of childrenOf(board, x)) {
      const cn = board.nodes[c];
      if (isTask(cn)) out.push(c);
      else walk(c);
    }
  };
  walk(id);
  return out;
}

export function isAncestor(board: TaskBoard, ancestor: string, id: string): boolean {
  return descendantIds(board, ancestor).indexOf(id) >= 0;
}

/* ------------------------------------------------------------------ */
/* 依赖与解锁                                                          */
/* ------------------------------------------------------------------ */

export type LockInfo = {
  locked: boolean;
  /** 未完成的前置任务 id（只列任务，不列组 —— 组不能"完成"，列出来没法操作） */
  pending: string[];
  /** 依赖里指向了不存在的 id */
  missing: string[];
  /** 依赖成环。成环时永远解不开，必须显式报出来 */
  cyclic: boolean;
};

/**
 * 这条任务当前能不能动。
 *
 * 组**没有**锁定概念 —— 它只是个容器，能不能动看它下面的任务。
 * 界面上对组显示的是聚合出来的状态（见 statusOf）。
 */
export function lockOf(board: TaskBoard, taskId: string): LockInfo {
  const n = board.nodes[taskId];
  if (!isTask(n)) return { locked: false, pending: [], missing: [], cyclic: false };
  const pending: string[] = [];
  const missing: string[] = [];
  let cyclic = false;
  for (const d of n.deps) {
    if (!board.nodes[d]) { missing.push(d); continue; }
    for (const leaf of leafTaskIds(board, d)) {
      if (leaf === taskId) continue;
      const ln = board.nodes[leaf];
      if (isTask(ln) && ln.status !== 'done' && ln.status !== 'cancelled') pending.push(leaf);
    }
  }
  /*
    成环检测只在**真的有依赖**时才跑。

    绝大多数任务没有前置，而 hasDepCycle 要沿依赖边一路走下去；
    tallyOf 又会对每个叶子调一次 lockOf —— 几百条任务时这笔开销全白花。
    没有依赖就不可能成环，这里直接跳过。
  */
  cyclic = n.deps.length > 0 ? hasDepCycle(board, taskId) : false;
  return { locked: pending.length > 0 || missing.length > 0 || cyclic, pending: dedup(pending), missing: dedup(missing), cyclic };
}

function dedup(xs: string[]): string[] {
  return xs.filter((x, i) => xs.indexOf(x) === i);
}

/** 从 start 出发沿 deps 走，能不能绕回自己 */
function hasDepCycle(board: TaskBoard, start: string): boolean {
  const seen = new Set<string>();
  const walk = (id: string, depth: number): boolean => {
    if (depth > 64) return true;   // 防御：树再深也不会到 64 层
    const n = board.nodes[id];
    if (!isTask(n)) return false;
    for (const d of n.deps) {
      if (d === start) return true;
      if (seen.has(d)) continue;
      seen.add(d);
      for (const leaf of leafTaskIds(board, d)) {
        if (leaf === start) return true;
        if (walk(leaf, depth + 1)) return true;
      }
    }
    return false;
  };
  return walk(start, 0);
}

/**
 * 组的状态：由它下面的任务聚合出来。
 *
 * 全 done → done；有 doing 或 done（部分）→ doing；
 * 全 cancelled → cancelled；其余 todo。
 */
export function statusOf(board: TaskBoard, id: string): BoardStatus {
  const n = board.nodes[id];
  if (!n) return 'todo';
  if (isTask(n)) return n.status;
  const leaves = leafTaskIds(board, id);
  if (leaves.length === 0) return 'todo';
  let done = 0, doing = 0, cancelled = 0;
  for (const l of leaves) {
    const ln = board.nodes[l];
    if (!isTask(ln)) continue;
    if (ln.status === 'done') done += 1;
    else if (ln.status === 'doing') doing += 1;
    else if (ln.status === 'cancelled') cancelled += 1;
  }
  if (done + cancelled === leaves.length) return cancelled === leaves.length ? 'cancelled' : 'done';
  if (done > 0 || doing > 0) return 'doing';
  return 'todo';
}

/** 计数，给组头显示用 */
export function tallyOf(board: TaskBoard, id: string): { total: number; done: number; doing: number; locked: number } {
  const leaves = leafTaskIds(board, id);
  let done = 0, doing = 0, locked = 0;
  for (const l of leaves) {
    const ln = board.nodes[l];
    if (!isTask(ln)) continue;
    if (ln.status === 'done') done += 1;
    else if (ln.status === 'doing') doing += 1;
    else if (lockOf(board, l).locked) locked += 1;
  }
  return { total: leaves.length, done, doing, locked };
}

/* ------------------------------------------------------------------ */
/* 改：返回新板（不改原对象）                                            */
/* ------------------------------------------------------------------ */

function clone(b: TaskBoard): TaskBoard {
  const nodes: Record<string, BoardNode> = {};
  for (const k of Object.keys(b.nodes)) {
    const n = b.nodes[k];
    nodes[k] = isGroup(n) ? { ...n, children: [...n.children] } : { ...n, deps: [...n.deps] };
  }
  return { ...b, root: [...b.root], nodes };
}

function detach(board: TaskBoard, id: string): void {
  const p = parentOf(board, id);
  const list = p === null ? board.root : (board.nodes[p] as BoardGroup).children;
  const at = list.indexOf(id);
  if (at >= 0) list.splice(at, 1);
}

function insertAt(board: TaskBoard, parent: string | null, id: string, index: number): void {
  const list = parent === null ? board.root : (board.nodes[parent] as BoardGroup).children;
  const at = Math.min(Math.max(0, index), list.length);
  list.splice(at, 0, id);
}

export function addNode(
  board: TaskBoard,
  parent: string | null,
  node: BoardNode,
  id?: string,
  index?: number,
): { board: TaskBoard; id: string } {
  const b = clone(board);
  const nid = nextFreeId(b, id || newBoardId(node.kind));
  b.nodes[nid] = node;
  const at = index === undefined ? childrenOf(b, parent).length : index;
  insertAt(b, parent, nid, at);
  b.updatedAt = Date.now();
  return { board: b, id: nid };
}

/**
 * 删除节点（含子树），并把别处对它的依赖一并摘掉。
 *
 * 不摘依赖的话，删掉一个被依赖的任务会让依赖它的任务**永远锁着**，
 * 而界面只显示"被前置任务卡住" —— 那个前置已经不存在了，无从下手。
 */
export function removeNode(board: TaskBoard, id: string): TaskBoard {
  const b = clone(board);
  const gone = new Set([id, ...descendantIds(b, id)]);
  for (const g of gone) delete b.nodes[g];
  detach(b, id);
  // 子树内部互相依赖的引用也要清（它们随父一起没了）
  for (const k of Object.keys(b.nodes)) {
    const n = b.nodes[k];
    if (isGroup(n)) n.children = n.children.filter((c) => !gone.has(c));
    else n.deps = n.deps.filter((d) => !gone.has(d));
  }
  b.root = b.root.filter((c) => !gone.has(c));
  b.updatedAt = Date.now();
  return b;
}

export function renameNode(board: TaskBoard, id: string, title: string): TaskBoard {
  const b = clone(board);
  const n = b.nodes[id];
  if (!n) return board;
  b.nodes[id] = { ...n, title };
  b.updatedAt = Date.now();
  return b;
}

/** 移动：先摘后插。同一次操作里完成，避免中途出现"两边都挂着" */
export function moveNode(board: TaskBoard, id: string, parent: string | null, index?: number): TaskBoard {
  if (id === parent) return board;
  // 不能挪进自己的子树 —— 那会把这棵子树从树上摘下来，整块消失
  if (parent !== null && (parent === id || isAncestor(board, id, parent))) return board;
  const b = clone(board);
  detach(b, id);
  insertAt(b, parent, id, index === undefined ? childrenOf(b, parent).length : index);
  b.updatedAt = Date.now();
  return b;
}

/* ------------------------------------------------------------------ */
/* 合并与拆分                                                          */
/* ------------------------------------------------------------------ */

export type OpResult = { board: TaskBoard; id: string; warnings: string[] };

/**
 * 把若干节点合并成一个任务组。
 *
 * 组插在**第一个节点原来的位置**，其余按原来的相对顺序 append 进去。
 * 跨父节点也能合并（合并本来就是把它们搬到一起）—— 但会把被合并的节点
 * 从它原来的父节点下摘走，所以 warnings 里会说明有几次跨层搬动。
 *
 * 不能把祖先与后代一起合并：那会造出一棵自己套自己的树，
 * 而嵌套到自身时渲染会无限递归。这类节点直接跳过并给出警告。
 */
export function mergeIntoGroup(
  board: TaskBoard,
  ids: string[],
  title: string,
): OpResult {
  const warnings: string[] = [];
  const picked = dedup(ids).filter((id) => board.nodes[id]);
  if (picked.length === 0) return { board, id: '', warnings: ['没有可合并的节点'] };
  // 去掉"是别人祖先"的那些：留下后代就够了，组的层级由后代自己表达
  const kept = picked.filter((id) => !picked.some((other) => other !== id && isAncestor(board, id, other)));
  const dropped = picked.length - kept.length;
  if (dropped > 0) warnings.push(`跳过了 ${dropped} 个（它已经是另一个被合并节点的父级，合并会造成自己套自己）`);

  const first = kept[0];
  const parent = parentOf(board, first);
  const index = childrenOf(board, parent).indexOf(first);
  let b = board;
  const r = addNode(b, null, { kind: 'group', title, children: [] });
  b = r.board;
  const gid = r.id;
  // 新组先建在根上再搬到位：直接插到 parent 下会与下面 detach 的顺序打架
  for (const id of kept) {
    b = moveNode(b, id, gid);
  }
  b = moveNode(b, gid, parent, index < 0 ? undefined : index);
  if (kept.length > 1) {
    const parents = new Set(kept.map((id) => parentOf(board, id) ?? ''));
    if (parents.size > 1) warnings.push(`${kept.length} 个节点原本分散在不同层级，已一起搬进新组`);
  }
  return { board: b, id: gid, warnings };
}

/**
 * 把一个任务拆成多个子任务。
 *
 * 原 id **保留**，但 kind 从 task 变成 group ——
 * 这是能安全拆分的关键：别处已经写好的依赖（deps 里填着这个 id）
 * 不用改，它们会自动变成"等这个组里全部完成"。
 *
 * 子任务继承原任务的前置：拆出来的每一块都得等同样的东西。
 * 状态重置为 todo —— 原任务"进行中"不等于拆出来的每一块都在进行中。
 */
export function splitTask(board: TaskBoard, id: string, titles: string[]): OpResult {
  const warnings: string[] = [];
  const n = board.nodes[id];
  if (!n) return { board, id, warnings: ['节点不存在'] };
  const list = titles.map((t) => t.trim()).filter(Boolean);
  if (list.length === 0) return { board, id, warnings: ['没有填子任务标题'] };

  const now = Date.now();
  let b = board;
  if (isTask(n)) {
    const deps = n.deps;
    const assignee = n.assignee;
    b = clone(b);
    b.nodes[id] = { kind: 'group', title: n.title, children: [] };
    for (const t of list) {
      const r = addNode(b, id, {
        kind: 'task', title: t, status: DEFAULT_STATUS, deps: [...deps], assignee, note: '',
        desc: '', tags: [], createdAt: now, updatedAt: now, due: 0, priority: 0,
      });
      b = r.board;
    }
    if (n.status !== 'todo') {
      warnings.push(`原任务状态是「${BOARD_STATUS_LABEL[n.status]}」，拆分后子任务一律从「待办」开始`);
    }
  } else {
    // 已经是组：继续往里加就是"再拆一层"
    for (const t of list) {
      const r = addNode(b, id, {
        kind: 'task', title: t, status: DEFAULT_STATUS, deps: [], assignee: '', note: '',
        desc: '', tags: [], createdAt: now, updatedAt: now, due: 0, priority: 0,
      });
      b = r.board;
    }
  }
  b.updatedAt = Date.now();
  return { board: b, id, warnings };
}

/* ------------------------------------------------------------------ */
/* 领取与标记                                                          */
/* ------------------------------------------------------------------ */

/**
 * 领取。
 *
 * **不硬挡**被前置卡住的任务 —— 返回警告，由调用方决定要不要继续。
 *
 * 为什么不做成硬错误：前置关系是"最好等它"，不是"绝对不能碰"。
 * 真有正当理由要提前动手时（比如先探一下），硬挡会逼人去改依赖，
 * 改完还得改回来。给警告、让人自己确认，是这两者的折中。
 *
 * 但**必须**返回点什么 —— 静默让 AI 领走一个被卡住的任务，
 * 它会照着做下去，做完了才发现上游还没定稿。
 */
export function claimTask(board: TaskBoard, id: string, who: string): OpResult {
  const n = board.nodes[id];
  const warnings: string[] = [];
  if (!n) return { board, id, warnings: ['节点不存在'] };
  if (isGroup(n)) return { board, id, warnings: ['任务组不能领取 —— 要领就领它下面的具体任务'] };
  const lock = lockOf(board, id);
  if (lock.cyclic) warnings.push('⚠ 前置任务互相依赖成环，这条永远等不到解锁');
  if (lock.missing.length > 0) {
    warnings.push(`⚠ 前置任务不存在：${lock.missing.join('、')}（可能已被删除）`);
  }
  if (lock.pending.length > 0) {
    const names = lock.pending.map((p) => board.nodes[p]?.title || p);
    warnings.push(`⚠ 有 ${lock.pending.length} 个前置任务未完成：${names.join('、')}`);
  }
  if (n.assignee && n.assignee !== who) {
    warnings.push(`⚠ 已被「${n.assignee}」领取`);
  }
  const b = clone(board);
  b.nodes[id] = {
    ...n,
    assignee: who,
    status: n.status === 'todo' ? 'doing' : n.status,
    updatedAt: Date.now(),
  };
  b.updatedAt = Date.now();
  return { board: b, id, warnings };
}

/** 标记状态。与领取同理：被卡住只给警告，不硬挡 */
export function setTaskStatus(
  board: TaskBoard,
  id: string,
  status: BoardStatus,
  advance?: string[],
): OpResult {
  const n = board.nodes[id];
  const warnings: string[] = [];
  if (!n) return { board, id, warnings: ['节点不存在'] };
  if (isGroup(n)) {
    return { board, id, warnings: ['任务组的状态由它下面的任务决定，不能直接标记'] };
  }
  /*
    哪些目标状态算"推进"、需要检查前置 —— 状态可自定义之后这里没法写死。

    advance 由调用方传（从 boardMeta 里算出来：所有非终态且不是初始态的）。
    没传时退回内置那两个 id —— 老调用点不至于因为没传就完全不检查。
  */
  const adv = advance ?? ['doing', 'done'];
  if (adv.indexOf(status) >= 0) {
    const lock = lockOf(board, id);
    if (lock.cyclic) warnings.push('⚠ 前置任务成环，这条无法解锁');
    if (lock.pending.length > 0) {
      const names = lock.pending.map((p) => board.nodes[p]?.title || p);
      warnings.push(`⚠ 还有 ${lock.pending.length} 个前置任务未完成：${names.join('、')}`);
    }
    if (lock.missing.length > 0) warnings.push(`⚠ 前置任务不存在：${lock.missing.join('、')}`);
  }
  const b = clone(board);
  b.nodes[id] = { ...n, status, updatedAt: Date.now() };
  b.updatedAt = Date.now();
  return { board: b, id, warnings };
}

/**
 * 改任务的任意标量字段（说明 / 备注 / 负责人 / 截止 / 优先级）。
 *
 * 统一走这一个函数，是为了让 updatedAt **不可能被漏掉** ——
 * 分散在各处 `b.nodes[id] = {...n, xxx}` 的写法，加一个字段就多一处
 * 可能忘记推进更新时间的地方，而"最后更新于"显示成一周前会让人
 * 以为这条没人动过。
 */
export function patchTask(
  board: TaskBoard,
  id: string,
  patch: Partial<Pick<BoardTask, 'desc' | 'note' | 'assignee' | 'due' | 'priority' | 'title'>>,
): OpResult {
  const n = board.nodes[id];
  if (!isTask(n)) return { board, id, warnings: ['只有任务能改这些字段'] };
  const b = clone(board);
  b.nodes[id] = { ...n, ...patch, updatedAt: Date.now() };
  b.updatedAt = Date.now();
  return { board: b, id, warnings: [] };
}

/**
 * 挂 / 摘一个标签。
 *
 * ⛔ 只改任务上的引用，不动 boardMeta 里的标签定义 ——
 * 摘标签不等于删标签：别人任务上还挂着同一个标签。
 */
export function toggleTag(board: TaskBoard, id: string, tagId: string): OpResult {
  const n = board.nodes[id];
  if (!isTask(n)) return { board, id, warnings: ['只有任务能挂标签'] };
  const has = n.tags.indexOf(tagId) >= 0;
  const b = clone(board);
  b.nodes[id] = {
    ...n,
    tags: has ? n.tags.filter((x) => x !== tagId) : [...n.tags, tagId],
    updatedAt: Date.now(),
  };
  b.updatedAt = Date.now();
  return { board: b, id, warnings: [] };
}

export function setDeps(board: TaskBoard, id: string, deps: string[]): OpResult {
  const n = board.nodes[id];
  const warnings: string[] = [];
  if (!isTask(n)) return { board, id, warnings: ['只有任务能设前置'] };
  const clean = dedup(deps).filter((d) => d !== id && board.nodes[d]);
  const bad = deps.filter((d) => !board.nodes[d] || d === id);
  if (bad.length > 0) warnings.push(`忽略了 ${bad.length} 个无效前置（不存在或指向自己）`);
  const b = clone(board);
  b.nodes[id] = { ...n, deps: clean };
  b.updatedAt = Date.now();
  return { board: b, id, warnings };
}

/* ------------------------------------------------------------------ */
/* 展示                                                                */
/* ------------------------------------------------------------------ */

export type BoardRow = {
  id: string;
  depth: number;
  node: BoardNode;
  /** 组才有 */
  hasChildren: boolean;
  expanded: boolean;
};

/**
 * 拉平成可渲染的行。折叠的组不展开子级。
 *
 * 行里带 expanded 而不是让 UI 自己再查一次 Set ——
 * 渲染时每处都去查，迟早有一处查错，表现为"点开了但没展开"。
 */
export function boardRows(board: TaskBoard, expanded: Set<string>, parent: string | null = null, depth = 0): BoardRow[] {
  const out: BoardRow[] = [];
  for (const id of childrenOf(board, parent)) {
    const n = board.nodes[id];
    if (!n) continue;
    const hasChildren = isGroup(n) && n.children.length > 0;
    const open = expanded.has(id);
    out.push({ id, depth, node: n, hasChildren, expanded: open });
    if (hasChildren && open) out.push(...boardRows(board, expanded, id, depth + 1));
  }
  return out;
}

/** 默认展开：全展开。任务板条数有限（不是几百条运行记录），没必要默认收起 */
export function defaultExpanded(board: TaskBoard): Set<string> {
  const s = new Set<string>();
  for (const id of Object.keys(board.nodes)) if (isGroup(board.nodes[id])) s.add(id);
  return s;
}

/**
 * 关键词是否命中这条**任务**。
 *
 * 组的 title **不参与匹配** —— 它只是个分组标题，用来给下面的任务归类。
 *
 * 参与的话会变成"搜'登录'把所有挂在登录组下的任务全带出来"，
 * 而那些任务的标题里根本没有"登录"。筛出来的东西和自己搜的对不上，
 * 是最难信任的一类筛选结果。
 */
export function matchesTask(n: BoardNode, kw: string): boolean {
  if (!kw) return true;
  if (isGroup(n)) return false;
  const q = kw.toLowerCase();
  return n.title.toLowerCase().indexOf(q) >= 0
    || n.note.toLowerCase().indexOf(q) >= 0
    || n.assignee.toLowerCase().indexOf(q) >= 0;
}

/**
 * 过滤后仍然要显示的行。
 *
 * 命中的任务要带上它的**祖先链**：任务在三层深的组里，
 * 只显示它自己就成了一条不知道挂在哪个项目下的孤行。
 */
export function visibleIds(board: TaskBoard, kw: string): Set<string> | null {
  if (!kw.trim()) return null;
  const keep = new Set<string>();
  for (const id of Object.keys(board.nodes)) {
    if (!matchesTask(board.nodes[id], kw)) continue;
    keep.add(id);
    for (const a of pathOf(board, id)) keep.add(a);
  }
  return keep;
}

/* ------------------------------------------------------------------ */
/* 与外部改动合并                                                      */
/* ------------------------------------------------------------------ */

export type MergeOutcome = {
  board: TaskBoard;
  /** 被外部版本盖掉的节点 id —— 界面要提示，否则本地改动像凭空消失 */
  overwritten: string[];
  /** 外部新增的 id */
  added: string[];
};

/**
 * 三方合并：base（上次读到的文件）/ mine（本地改后）/ theirs（磁盘当前）。
 *
 * 判据（逐节点）：
 *   只有我改         → 用我的
 *   只有外部改       → 用外部的
 *   两边都改且不同   → **用外部的**，并记进 overwritten
 *   都没改           → 用 base
 *
 * 为什么冲突时外部优先：AI 改文件是**主路径**（它不打开界面），
 * 界面只是查看与辅助。两边同时改了同一条时，认界面的那份等于
 * 让 AI 的写入无声失效 —— 它不会收到任何提示，下次读又变回去了。
 * 反过来认文件，界面这边至少能显示"这条被外部改了"。
 *
 * 为什么不做字段级合并：一条任务就几个字段，字段级合并的收益
 * 远小于它带来的复杂度与误判（比如我改状态、它改标题，
 * 合出来的结果两边都不认得）。
 */
export function mergeBoards(base: TaskBoard, mine: TaskBoard, theirs: TaskBoard): MergeOutcome {
  const out = emptyBoard(mine.project, mine.projectName);
  const overwritten: string[] = [];
  const added: string[] = [];
  const ids = dedup([...Object.keys(base.nodes), ...Object.keys(mine.nodes), ...Object.keys(theirs.nodes)]);
  const sig = (b: TaskBoard, id: string) => JSON.stringify(b.nodes[id] ?? null);
  for (const id of ids) {
    const b = base.nodes[id];
    const m = mine.nodes[id];
    const t = theirs.nodes[id];
    const sb = sig(base, id);
    const sm = sig(mine, id);
    const st = sig(theirs, id);
    if (t === undefined && m === undefined) continue;
    if (b === undefined && t !== undefined) { out.nodes[id] = t; added.push(id); continue; }
    if (m !== undefined && t === undefined) { out.nodes[id] = m; continue; }   // 只有我改（或我新增）
    if (t !== undefined && m === undefined) { out.nodes[id] = t; continue; }   // 外部删了我没动的？按外部
    if (sm === st) { out.nodes[id] = m as BoardNode; continue; }               // 改成了同一份
    if (sm === sb) { out.nodes[id] = t as BoardNode; continue; }               // 只有外部改
    if (st === sb) { out.nodes[id] = m as BoardNode; continue; }               // 只有我改
    out.nodes[id] = t as BoardNode;                                            // 两边都改 → 外部赢
    overwritten.push(id);
  }
  /*
    root 顺序同样按"谁改了"来定，但顺序冲突没法逐项合并，
    所以整体取一边的：外部改过就听外部的，否则用我的。
    顺序错了最多是显示次序不对，不会丢数据。
  */
  const rootChanged = JSON.stringify(theirs.root) !== JSON.stringify(base.root);
  out.root = (rootChanged ? theirs.root : mine.root).filter((id) => out.nodes[id]);
  // 兜住"节点存在但没挂在任何地方"
  const seen = new Set<string>(out.root);
  const walk = (b: TaskBoard, id: string) => {
    for (const c of (isGroup(b.nodes[id]) ? (b.nodes[id] as BoardGroup).children : [])) { seen.add(c); walk(b, c); }
  };
  for (const id of out.root) walk(out, id);
  for (const id of Object.keys(out.nodes)) if (!seen.has(id)) out.root.push(id);
  out.updatedAt = Math.max(mine.updatedAt, theirs.updatedAt);
  /*
    root 顺序没做逐项合并（外部改过就整条听外部的）。
    顺序错了最多是显示次序不对，不丢数据，所以不计入 overwritten ——
    overwritten 的语义是"这一条被盖掉了"，把顺序也算进去会让人以为数据丢了。
  */
  return { board: out, overwritten, added };
}
