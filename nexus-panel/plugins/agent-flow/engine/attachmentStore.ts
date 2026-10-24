/**
 * 附属文件 —— 挂在某条任务上的 md / 图片 / 视频。
 *
 * ================= 与任务板同构 =================
 *
 * 这份清单也要**落盘**，理由和任务板完全一样：AI 要能不打开工具就改。
 * 所以形状照抄任务板那一套（v / project / projectName / updatedAt +
 * 顺序数组 + id 字典），AI 学会一种就会另一种，不用记两套写法。
 *
 * ================= 只存路径，不存内容 =================
 *
 * 文件本体留在磁盘原处，这里只记**在哪**。
 *
 * 把内容复制进清单（base64 内联）的话：一个 200MB 的视频会让这个
 * JSON 变得没法读也没法 diff —— 而"AI 读文件"正是它存在的理由。
 * 本体仍归原作者管，这里只是一份索引。
 *
 * ================= 为什么是扁平列表而不是树 =================
 *
 * 任务板是树（要表达"拆成几块"），附件不需要：它没有层级语义，
 * 挂在哪条任务上就是那条任务的。硬套一棵树只会让 AI 写的时候
 * 还要先想清楚挂载点，没有任何收益。
 *
 * ================= 合并判据必须与任务板一致 =================
 *
 * 两边都动过同一条时**外部优先**。理由见 taskBoard.mergeBoards，
 * 这里不重复论证。⛔ 改一边就要改另一边 —— 同样一次冲突在两个
 * 面板里一个认文件、一个认界面，是最难自查的那类不一致。
 */

export const ATTACH_VERSION = 1;

/** 附带一个文件时的归类。决定面板上显示什么、能不能预览 */
export type AttachKind = 'md' | 'image' | 'video' | 'audio' | 'other';

export type AttachmentItem = {
  id: string;
  /** 所属任务的 id（任务板条目 / 运行记录），空串 = 不挂在任何任务上 */
  owner: string;
  /** 所属任务的标题。冗余存一份：AI 只读文件也知道这是挂在哪条上的 */
  ownerTitle: string;
  /**
   * 文件路径。绝对路径直接用；相对路径拼到导出目录上。
   *
   * 允许相对是因为 AI 写清单时未必知道导出目录在哪，
   * 而"因为路径写错了所以文件打不开"完全可以靠拼接救回来。
   */
  path: string;
  /**
   * 文件名。**必须存**，不能靠从 path 里切。
   * 文件被移走或删掉时 path 就失效了，而那时正是最需要知道
   * "这里原本挂的是什么"的时候 —— 只剩一个路径的话什么都看不出来。
   */
  name: string;
  note: string;
  /** 谁加的。人加的写人名，AI 加的写 ai —— 出问题时先问谁 */
  addedBy: string;
  addedAt: number;
};

export type AttachmentFile = {
  v: number;
  project: string;
  projectName: string;
  updatedAt: number;
  /** 显示顺序 */
  order: string[];
  items: Record<string, AttachmentItem>;
};

export function emptyAttachments(project = '', projectName = ''): AttachmentFile {
  return {
    v: ATTACH_VERSION,
    project,
    projectName,
    updatedAt: 0,
    order: [],
    items: {},
  };
}

/* ------------------------------------------------------------------ */
/* 归类                                                                */
/* ------------------------------------------------------------------ */

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'avif', 'ico']);
const VID_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'm3u8']);
const AUD_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus']);
const MD_EXT = new Set(['md', 'markdown', 'mdown', 'mkd']);

/** 取扩展名（不含点，小写）。没有则空串 */
export function extOf(name: string): string {
  const s = String(name ?? '').trim().toLowerCase();
  const at = s.lastIndexOf('.');
  if (at < 0 || at === s.length - 1) return '';
  return s.slice(at + 1);
}

/**
 * 按扩展名归类。
 *
 * 只看扩展名，不看 MIME —— 清单是手写的，里面没有 MIME；
 * 而扩展名是 AI 和人都能一眼写对的东西。
 */
export function kindOf(name: string): AttachKind {
  const e = extOf(name);
  if (MD_EXT.has(e)) return 'md';
  if (IMG_EXT.has(e)) return 'image';
  if (VID_EXT.has(e)) return 'video';
  if (AUD_EXT.has(e)) return 'audio';
  return 'other';
}

export const ATTACH_KIND_LABEL: Record<AttachKind, string> = {
  md: '文档',
  image: '图片',
  video: '视频',
  audio: '音频',
  other: '文件',
};

/* ------------------------------------------------------------------ */
/* 解析 / 序列化                                                       */
/* ------------------------------------------------------------------ */

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * 解析。与任务板同一套兜底原则：手改漏字段能补就补，
 * 补不了的（连 path 和 name 都没有）整条丢掉并说明 ——
 * 留一条不知道指向哪的附件，面板上就是一行点不开的东西。
 */
export function parseAttachments(
  raw: string | null,
  project = '',
  projectName = '',
): AttachmentFile {
  if (!raw) return emptyAttachments(project, projectName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyAttachments(project, projectName);
  }
  if (!parsed || typeof parsed !== 'object') return emptyAttachments(project, projectName);
  const o = parsed as Record<string, unknown>;

  const items: Record<string, AttachmentItem> = {};
  const rawItems = o.items && typeof o.items === 'object'
    ? o.items as Record<string, unknown>
    : {};

  for (const id of Object.keys(rawItems)) {
    const it = rawItems[id] as Record<string, unknown>;
    if (!it || typeof it !== 'object') continue;
    const path = str(it.path).trim();
    const name = str(it.name).trim() || baseNameOf(path);
    // 既没路径也没名字 —— 无从下手，丢弃
    if (!path && !name) continue;
    items[id] = {
      id,
      owner: str(it.owner),
      ownerTitle: str(it.ownerTitle),
      path,
      name: name || id,
      note: str(it.note),
      addedBy: str(it.addedBy),
      addedAt: typeof it.addedAt === 'number' ? it.addedAt : 0,
    };
  }

  const order = Array.isArray(o.order)
    ? o.order.filter((x): x is string => typeof x === 'string' && !!items[x])
    : [];
  // 漏写进 order 的补到末尾：不补的话它根本不显示，AI 会以为写入失败了
  for (const id of Object.keys(items)) {
    if (order.indexOf(id) < 0) order.push(id);
  }

  return {
    v: ATTACH_VERSION,
    project: str(o.project, project),
    projectName: str(o.projectName, projectName),
    updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : 0,
    order,
    items,
  };
}

export function serializeAttachments(a: AttachmentFile): string {
  return JSON.stringify(a, null, 2);
}

/** 从路径里切文件名。统一用 / —— Windows 的 \ 也认 */
export function baseNameOf(path: string): string {
  const s = String(path ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const at = s.lastIndexOf('/');
  return at >= 0 ? s.slice(at + 1) : s;
}

/* ------------------------------------------------------------------ */
/* 改（返回新对象）                                                     */
/* ------------------------------------------------------------------ */

function clone(a: AttachmentFile): AttachmentFile {
  const items: Record<string, AttachmentItem> = {};
  for (const k of Object.keys(a.items)) items[k] = { ...a.items[k] };
  return { ...a, order: [...a.order], items };
}

export function newAttachId(now: number = Date.now()): string {
  return `att_${now.toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`;
}

/** id 撞了就换一个（AI 手写的 id 可能与生成的撞） */
export function nextFreeAttachId(a: AttachmentFile, want: string): string {
  if (!a.items[want]) return want;
  let i = 2;
  while (a.items[`${want}_${i}`]) i += 1;
  return `${want}_${i}`;
}

export function addAttachment(
  a: AttachmentFile,
  item: AttachmentItem,
): { file: AttachmentFile; id: string } {
  const b = clone(a);
  const id = nextFreeAttachId(b, item.id || newAttachId());
  b.items[id] = { ...item, id };
  b.order.push(id);
  b.updatedAt = Date.now();
  return { file: b, id };
}

export function removeAttachment(a: AttachmentFile, id: string): AttachmentFile {
  const b = clone(a);
  delete b.items[id];
  b.order = b.order.filter((x) => x !== id);
  b.updatedAt = Date.now();
  return b;
}

export function updateAttachment(
  a: AttachmentFile,
  id: string,
  patch: Partial<AttachmentItem>,
): AttachmentFile {
  const b = clone(a);
  if (!b.items[id]) return a;
  b.items[id] = { ...b.items[id], ...patch, id };
  b.updatedAt = Date.now();
  return b;
}

/** 某条任务下的附件，按清单顺序 */
export function attachmentsOf(a: AttachmentFile, owner: string): AttachmentItem[] {
  return a.order
    .map((id) => a.items[id])
    .filter((it) => !!it && it.owner === owner);
}

/** 没有挂在任何任务上的附件（owner 为空） */
export function looseAttachments(a: AttachmentFile): AttachmentItem[] {
  return a.order.map((id) => a.items[id]).filter((it) => !!it && !it.owner);
}

/* ------------------------------------------------------------------ */
/* 与外部改动合并                                                      */
/* ------------------------------------------------------------------ */

export type AttachMerge = {
  file: AttachmentFile;
  /** 被文件里的新版本盖掉的条目 —— 必须提示，否则改动像凭空消失 */
  overwritten: string[];
  added: string[];
};

/**
 * 三方合并：base（上次读到的）/ mine（本地改后）/ theirs（磁盘当前）。
 *
 * 判据与 taskBoard.mergeBoards **完全相同**（逐条比，外部优先），
 * 改一边必须改另一边 —— 见文件头的说明。
 */
export function mergeAttachments(
  base: AttachmentFile,
  mine: AttachmentFile,
  theirs: AttachmentFile,
): AttachMerge {
  const out = emptyAttachments(mine.project, mine.projectName);
  const overwritten: string[] = [];
  const added: string[] = [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const id of [...Object.keys(base.items), ...Object.keys(mine.items), ...Object.keys(theirs.items)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  const sig = (f: AttachmentFile, id: string) => JSON.stringify(f.items[id] ?? null);

  for (const id of ids) {
    const b = base.items[id];
    const m = mine.items[id];
    const t = theirs.items[id];
    if (t === undefined && m === undefined) continue;
    if (b === undefined && t !== undefined) { out.items[id] = t; added.push(id); continue; }
    if (m !== undefined && t === undefined) { out.items[id] = m; continue; }
    if (t !== undefined && m === undefined) { out.items[id] = t; continue; }
    if (sig(mine, id) === sig(theirs, id)) { out.items[id] = m as AttachmentItem; continue; }
    if (sig(mine, id) === sig(base, id)) { out.items[id] = t as AttachmentItem; continue; }
    if (sig(theirs, id) === sig(base, id)) { out.items[id] = m as AttachmentItem; continue; }
    out.items[id] = t as AttachmentItem;      // 两边都改 → 外部赢
    overwritten.push(id);
  }

  const theirsChanged = JSON.stringify(theirs.order) !== JSON.stringify(base.order);
  out.order = (theirsChanged ? theirs.order : mine.order).filter((id) => out.items[id]);
  for (const id of Object.keys(out.items)) {
    if (out.order.indexOf(id) < 0) out.order.push(id);
  }
  out.updatedAt = Math.max(mine.updatedAt, theirs.updatedAt);
  return { file: out, overwritten, added };
}
