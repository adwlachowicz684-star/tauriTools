/**
 * 拖拽的共用内核（零依赖，纯逻辑）
 * ------------------------------------------------------------------
 * 本插件有四套拖拽，落点语义各不相同，但**骨架**完全一样：
 *
 * | 变体 | 落点语义 |
 * |---|---|
 * | 卡片排序 | 落在**缝隙**上，画竖条（上下半区决定插前还是插后） |
 * | 跨栏建链 | 落在**整张卡**上，整卡高亮 |
 * | 页签重排 | 落在页签上，直接就是它的下标 |
 * | 分框重排 | 落在标题栏上，直接就是它的下标 |
 *
 * 骨架相同、语义不同，正是最容易长出四份实现的地方 ——
 * 而**兜底逻辑**（阈值判定、载荷校验、取消时清状态）恰好四份都要有，
 * 又恰好是漏了最难查的：漏了不报错，只是偶尔"点了没反应"或"竖条残留"。
 *
 * 所以这里抽它们的**公共部分**，落点语义仍由各自实现。
 *
 * 只放纯逻辑，不碰 React：纯函数才好穷举测试，
 * 而这几处算术写错的表现恰好是"拖完停在别处"——界面上复现要点好几次。
 */

import type { CardKind } from '../types';

/* ---------------------------------- MIME ---------------------------------- */

/**
 * 为什么每种拖拽都要有**专用** MIME，不能图省事用 `text/plain`：
 *
 * 1. `text/plain` 是通用类型，从别的应用拖进来的文本也匹配它。
 *    靠"组件内状态是否为 -1"来守卫是**脆弱**的：状态会因重渲染丢失，
 *    而 MIME 不会。
 * 2. 更实际的坑：分框标题双击会进内联重命名（那里有 `<input>`），
 *    拖着 `text/plain` 经过输入框松手，浏览器默认行为是**把文本插进去** ——
 *    用户只是想调个顺序，结果页签名被塞进了输入框。
 *
 * 专用 MIME 下，`preventDefault()` 只在自己认识的类型时才调用，
 * 不会去抢浏览器对其它拖拽的默认处理。
 */
export const DRAG_MIME = 'application/x-fpx-card';
export const TAB_DRAG_MIME = 'application/x-fpx-tab';
export const BOX_DRAG_MIME = 'application/x-fpx-box';
/** #148 连锁动作页签重排。纵向列表，语义与卡片排序一致，故单列一种 MIME */
export const ACTION_DRAG_MIME = 'application/x-fpx-action';

/* ---------------------------------- 阈值 ---------------------------------- */

/**
 * 拖拽阈值（像素）—— #107 / #492。
 *
 * HTML5 的 `draggable` 由浏览器自行决定何时开始拖（Chrome 大约 4~5px），
 * 我们**无法直接设定**，但可以在 `dragstart` 里**取消**它。
 *
 * 为什么要这么做：**点击时手抖 2~3px 会被判定成拖拽**，
 * 而一旦开始拖，`click` 就不会再触发 —— 用户点卡片想选中它，
 * 结果既没选中、卡片还被拖走一点。这种"点了没反应又不是完全没反应"
 * 正是"用起来别扭但说不出哪别扭"的典型。
 *
 * 取消 dragstart 后因为没有拖拽发生，mouseup 会正常触发 click，一切回到预期。
 *
 * 阈值取 5：略高于浏览器自带阈值，只拦真实的抖动，不干扰刻意拖拽。
 */
export const DRAG_THRESHOLD = 5;

/** 按下点（拖拽阈值判定用）。 */
export interface PressPoint {
  x: number;
  y: number;
}

/** 按下点位移够不够大——不够就判定为点击，取消这次拖拽。 */
export function movedEnough(
  pressAt: PressPoint | null,
  clientX: number,
  clientY: number,
  threshold = DRAG_THRESHOLD,
): boolean {
  // 没有按下点（键盘发起的拖拽等）→ 不拦，交给浏览器
  if (!pressAt) return true;
  return Math.hypot(clientX - pressAt.x, clientY - pressAt.y) >= threshold;
}

/* ---------------------------------- 载荷 ---------------------------------- */

export interface DragPayload {
  kind: CardKind;
  path: string;
}

export interface TabDragPayload {
  kind: CardKind;
  index: number;
}

/** 分框重排：只带下标（分类框没有 path，用名字做键会与重名冲突） */
export interface BoxDragPayload {
  index: number;
}

function isCardKind(v: unknown): v is CardKind {
  return v === 'project' || v === 'group';
}

/** 解析 JSON 并兜住异常——dataTransfer 里的内容可以是**任意文本**。 */
function parseJson(raw: string | null | undefined): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * 解析卡片拖拽载荷，失败返回 null。
 *
 * `raw` 取自 dataTransfer，内容可以是**任意文本**（从别的应用拖进来，或人为伪造）：
 * 直接 `JSON.parse` 会抛异常中断拖拽处理；更隐蔽的是解析成功但结构不对
 * （没有 kind / path），后续 `drag.path` 为 undefined 会造成静默错乱。
 * 所以既要兜住解析异常，也要做结构校验。
 */
export function parseDragPayload(raw: string | null | undefined): DragPayload | null {
  const parsed = parseJson(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { kind, path } = parsed as Partial<DragPayload>;
  if (!isCardKind(kind)) return null;
  if (typeof path !== 'string' || path === '') return null;
  return { kind, path };
}

/** 解析页签拖拽载荷（同样任意来源，必须校验）。 */
export function parseTabDrag(raw: string | null | undefined): TabDragPayload | null {
  const parsed = parseJson(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { kind, index } = parsed as Partial<TabDragPayload>;
  if (!isCardKind(kind)) return null;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
  return { kind, index };
}

/** 解析分框重排载荷（同样任意来源，必须校验）。 */
/**
 * #148 解析连锁动作拖拽载荷。只认 id —— 列表项靠 id 定位，不靠下标。
 *
 * 这里**刻意不用括号内的类型断言**：testkit 的类型剥离器处理不了
 * "括号 + 类型断言 + 内联对象类型"那种写法，会原样留下关键字 →
 * 剥离产物语法错误 → **drag-sort-test 跟着一起挂掉**（已踩过一次）。
 * 用 typeof 守卫既避开它，也少一次断言。
 */
export function parseActionDrag(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    const rec: Record<string, unknown> = { ...v };
    const id = rec.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

export function parseBoxDrag(raw: string | null | undefined): BoxDragPayload | null {
  const parsed = parseJson(raw);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { index } = parsed as Partial<BoxDragPayload>;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return null;
  return { index };
}

/* ------------------------------- 索引纠偏 ------------------------------- */

/**
 * 「先移除再插入」的索引纠偏——**最容易写错的一处**。
 *
 * 后端的 moveCard / moveTab 都是「先把项从列表里摘掉，再插入到目标下标」。
 * 而前端算出的落点 k 是在**还含被拖项**的数组里得到的，两者差一位。
 *
 * 规则：被拖项原本在 k 之前（from < k），它一走后面的都前移一位，
 * 所以 k 要减 1。不减的话，往上拖会稳定"落点偏后一格" ——
 * 表现为"明明插在 A 前面，结果跑到 A 后面"。
 *
 * 为什么值得单独抽成纯函数：这个算术写错的表现是"拖完停在别处"，
 * 界面上要连点好几次、项数够多才复现得出，靠手测很难发现。
 * 抽成纯函数后可以用穷举不变量钉住（见 drag-sort-test 的第 4 节）。
 *
 * @param from 被拖项当前下标（-1 表示不在列表里）
 * @param k    在**含被拖项**的数组里算出的缝隙位置，取值 0..n
 * @param n    列表长度
 */
export function resolveMoveIndex(from: number, k: number, n: number): number {
  if (from < 0 || from >= n) return clampIndex(k, n);
  const r = from < k ? k - 1 : k;
  return clampIndex(r, n - 1);
}

/** 把下标夹进 [0, max]（max 为 -1 时返回 -1，用于空列表）。 */
export function clampIndex(v: number, max: number): number {
  if (max < 0) return -1;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(v)));
}

/* ------------------------------- 落点半区 ------------------------------- */

/**
 * 指针落在元素的上半还是下半——决定插到它前面还是后面。
 *
 * 为什么不用 `offsetY`：`offsetY` 是相对**事件目标**的，
 * 而卡片内部有链接明细等子元素，指针落在子元素上时 `offsetY` 会跳变。
 * 用 `getBoundingClientRect()` 始终相对**当前这张卡**，才稳定。
 */
/** 元素的几何信息（只需 top 与 height，不引 DOM 类型，纯逻辑才好测）。 */
export interface BoxRect {
  top: number;
  height: number;
}

/**
 * 指针落在元素的**前半还是后半**——决定插到它前面还是后面。
 *
 * 纵向（卡片）与横向（分组栏、页签条）是同一个判定，只是轴不同。
 * 分成两个包装函数而不是各写一份：各写一份的话，
 * 改了其中一个的半区规则（比如想改成"前 1/3"），另一个就会悄悄不一致。
 */
export function halfGap(start: number, size: number, pointer: number, i: number): number {
  return pointer < start + size / 2 ? i : i + 1;
}

export function gapIndexAt(
  rect: BoxRect,
  clientY: number,
  i: number,
): number {
  return halfGap(rect.top, rect.height, clientY, i);
}

/**
 * 横向版本（分组栏 / 页签条）：判定指针在元素**左半还是右半**。
 *
 * 为什么不用 `offsetX`：`offsetX` 是相对**事件目标**的，
 * 而分组按钮里有条目数的 `<span>`，指针落在它上面时 `offsetX` 会跳变
 * ——表现为"明明在左半边，却插到了右边"。
 * 用 `getBoundingClientRect()` 始终相对**当前这个按钮**，才稳定。
 */
export function gapIndexAtX(
  rect: { left: number; width: number },
  clientX: number,
  i: number,
): number {
  return halfGap(rect.left, rect.width, clientX, i);
}

/**
 * 死区：越过邻项中心还不够，还要超出死区才换位（#493 / #713）。
 *
 * **为什么要它**：手抖一两个像素就让分框疯狂跳动，看着像界面坏了。
 * 死区内保持原索引，用户的操作意图才不会被抖动淹没。
 *
 * 死区取「固定像素」与「邻项尺寸 20%」的**较小值**（#713）：
 * 小元素也能精确操作 —— 若取较大值，矮分框的 20% 可能比相邻的高分框还大，
 * 换位的触发点就被推到了高分框内部，怎么拖都换不动。
 */
export function deadZone(neighborSize: number, fixed = 8, ratio = 0.2): number {
  return Math.min(fixed, neighborSize * ratio);
}

/**
 * 换到哪个下标——带死区滞后，且支持一次跨多项（#494）。
 *
 * @param y        指针位置
 * @param centers  各项中心位置（按序，单位与 y 一致）
 * @param from     被拖项当前下标
 */
export function swapIndexWithDeadZone(
  y: number,
  centers: number[],
  sizes: number[],
  from: number,
): number {
  if (from < 0 || from >= centers.length) return from;
  // 被拖项自己在数组里，但它的中心不该参与比较（它跟着指针在动）
  let target = from;
  // 向上：越过上一个的中心 + 死区
  let i = from - 1;
  while (i >= 0) {
    const dz = deadZone(sizes[i] ?? 0);
    if (y < centers[i] - dz) { target = i; i--; } else break;
  }
  if (target !== from) return target;
  // 向下：越过下一个的中心 + 死区
  let j = from + 1;
  while (j < centers.length) {
    const dz = deadZone(sizes[j] ?? 0);
    if (y > centers[j] + dz) { target = j; j++; } else break;
  }
  return target;
}

/**
 * #14 判定这次拖拽是不是"从文件管理器拖进来的"。
 *
 * **判据是"一个内部类型都没有"，而不是"有 Files"**：
 * 浏览器在 dragover 阶段就屏蔽了 dataTransfer 的内容（只能读 types），
 * 而 `Files` 这个 type 只有在拖的是**文件**时才一定有；
 * 拖**文件夹**时部分平台只给 `text/uri-list`。
 * 用"有 Files"判的话，拖文件夹会被漏掉 —— 恰好是 #14 要支持的那种。
 *
 * 反过来，内部拖拽一定带自己的私有 MIME，所以"一个都没有"就是外部的。
 */
/** dataTransfer.types 的形态（别名是为了让类型可被静态剥离） */
export type DragTypes = readonly string[];

export function isExternalDrag(types: DragTypes | null): boolean {
  if (!types || types.length === 0) return false;
  const list = [...types];
  return !list.some(
    (t) => t === DRAG_MIME || t === TAB_DRAG_MIME || t === BOX_DRAG_MIME,
  );
}

/**
 * 拖进来的名字（用于"把这步接到正规流程上"时的提示）。
 *
 * 拿不到绝对路径 —— 见下面 `externalDropName` 的说明。
 */
/**
 * 带 `path` 的 File 形态。
 *
 * `path` 是 **Tauri 在开启 dragDropEnabled 后**附加到 File 对象上的磁盘绝对路径，
 * 标准浏览器里没有这个字段。有它，拖进来的文件夹才能**直接**加成卡片，
 * 不必再让用户去对话框里重选一次。
 */
export type DropNameFile = { name: string; path: string | null };
/** 别名包住 readonly 数组：内联写 `readonly X[]` 时类型剥离器处理不了 */
export type DropNameFiles = readonly DropNameFile[];

export function externalDropName(files: DropNameFiles | null): string {
  return files && files.length > 0 ? files[0].name : '';
}

/**
 * 拖进来的文件夹的**磁盘绝对路径**（拿不到则返回空串）。
 *
 * --------------------------------------------------------------------
 * 这是"拖入即导入"能不能成立的关键。
 *
 * 浏览器沙箱只给 File 对象、不给路径 —— 所以此前只能弹对话框让用户重选，
 * 那一步是**被迫**的，不是设计。宿主开启 `dragDropEnabled` 之后，
 * Tauri 会把绝对路径挂到 File 上，这一步就不需要了。
 *
 * 判据：
 *   · 明确是文件（isDirectory === false）→ 不给路径
 *   · 拿不到 entry 信息 → 仍按目录处理（与 classifyExternalDrop 同源），
 *     宁可多试一次，也不能把真正的文件夹误判成文件
 *
 * @returns 绝对路径；空串表示本次拿不到路径（调用方应退回对话框）
 */
export function dirPathOf(
  files: DropNameFiles | null,
  entries: DropEntriesArg,
): string {
  if (!files || files.length === 0) return '';
  const first = entries && entries.length > 0 ? entries[0] : null;
  if (first && first.isDirectory === false) return '';
  const p = String(files[0]?.path ?? '').trim();
  return p;
}

/**
 * 拖进来的到底是什么。
 *
 * --------------------------------------------------------------------
 * 为什么必须分得清：`isExternalDrag` 只看 **types**（dragover 阶段
 * 浏览器屏蔽了 dataTransfer 的内容，只能读 types），它分不出：
 *
 * | 拖进来 | types | files | 期望 |
 * |---|---|---|---|
 * | 文件夹 | `Files` | 有 | 接进选目录流程 |
 * | 单个文件 | `Files` | 有 | **不是文件夹**，不该弹选目录框 |
 * | 一段文字 | `text/plain` | **空** | 不该弹任何框 |
 *
 * 前两版只看 types，于是**拖一段选中的文字进来也会弹「选择目录」** ——
 * 用户拖的是文字，弹个选目录框完全莫名其妙。files 为空是最好判的一种，
 * 却因为判据里根本没检查 files 而漏掉了。
 *
 * 文件夹与文件的区分靠 `webkitGetAsEntry().isDirectory`：
 * 它是标准 API，且 **drop 阶段同步可读**（不必等异步 FileSystem 操作），
 * 所以能在这里给出确定答案。
 */
export type DropKind = 'dir' | 'file' | 'empty';

/**
 * 一个 FileSystemEntry 的最小形态（只需要 isDirectory）。
 *
 * ⚠️ 字段**不写 `?`**：源码要被静态剥离器转成 .mjs 才能跑测试，
 * 而 `?:` 它会处理坏 —— 残留的 `};` 让 node 直接 SyntaxError，
 * 且报错指向转换后的临时文件，很难看出是这里的写法导致的。
 * 需要表达"可能没有"时用 `| null` 或调用处的 `!!` 兜住。
 */
export type DropEntryLite = { isDirectory: boolean };

/** DataTransferItem 的最小形态 */
/** DataTransferItem 的最小形态（同样要写成**单行**：多行 type 也会让剥离器留下孤立的 `};`） */
export type DropItemLite = { webkitGetAsEntry: () => DropEntryLite | null };

export type DropItems = readonly DropItemLite[];

/*
 * 参数类型的别名 —— **不能**内联写 `entries?: readonly X[] | null`。
 *
 * 这段源码要被静态剥离器转成 .mjs 才能在 node 里跑测试（见 testkit.mjs），
 * 而 `?.` 式的可选参数标记剥离不掉，会原样留在 JS 里：
 * 那不是合法 JS（JS 里参数可选靠默认值，没有 `param?:` 语法），
 * 于是 node 直接 SyntaxError —— 而报错指向转换后的临时文件，
 * 很难一眼看出是这里的类型写法导致的。
 */
export type DropEntriesArg = readonly DropEntryLite[] | null;

/**
 * 从 dataTransfer.items 取出各条的"是不是目录"。
 *
 * 抽成函数是因为 `webkitGetAsEntry` 在部分环境（测试、个别平台）不存在，
 * 那种情况下**返回空数组**而不是抛错 —— 拿不到信息是"不知道"，
 * 不是"拖了个文件"，两者不能混。
 */
export function entriesOf(items: DropItems | null): DropEntryLite[] {
  if (!items || items.length === 0) return [];
  const out: DropEntryLite[] = [];
  for (const it of items) {
    const get = it?.webkitGetAsEntry;
    if (typeof get !== 'function') continue;
    try {
      const en = get.call(it);
      if (en) out.push({ isDirectory: !!en.isDirectory });
    } catch { /* 个别平台会抛，跳过这一条 */ }
  }
  return out;
}

/**
 * @param files  dataTransfer.files（只用来判"有没有真的拖了东西"）
 * @param entries dataTransfer.items 取出的 entry 信息（可空）
 */
export function classifyExternalDrop(
  files: DropNameFiles | null,
  entries: DropEntriesArg,
): DropKind {
  /* files 为空 = 拖的是纯文本 / 链接，不是文件系统的东西。
     这一条最确定，也最该拦 —— 弹选目录框在这种场景完全是误导。 */
  if (!files || files.length === 0) return 'empty';

  const first = entries && entries.length > 0 ? entries[0] : null;
  if (first && typeof first.isDirectory === 'boolean') {
    return first.isDirectory ? 'dir' : 'file';
  }
  /*
   * 拿不到 entry 信息（平台不支持 / 环境缺失）：**按目录处理**。
   *
   * 为什么不按文件：#14 要支持的正是拖文件夹，
   * "拿不到信息就拒绝"会让这个功能在那些平台上直接失效，
   * 而失效的表现是"拖了没反应" —— 恰好是本功能要修的那个痛点。
   * 宁可多弹一次框，也不能错杀。
   */
  return 'dir';
}

/* --------------------------- 贴边自动滚动（#104）--------------------------- */

/**
 * 侵入深度 → 滚动速度（像素/帧）。
 *
 * **为什么按深度加速**：贴边滚动的常见场景是"把卡片拖到列表另一头"，
 * 那边可能有几十项。恒定速度的话，近处慢但远处也只有那么快，
 * 拖到末尾要按着不动好几秒 —— 用户会以为卡住了而松手，前功尽弃。
 * 越贴边越快，想快就再贴紧一点，控制权在用户手上。
 *
 * 死区（zone）内不滚：否则指针刚碰到边缘就开始滚，
 * 手抖一两个像素列表就飘，看着像界面坏了。
 *
 * 纯函数（不碰 DOM），才能穷举测。
 *
 * @param pointer 指针位置（与 top/bottom 同轴）
 * @param top     可视区上边
 * @param bottom  可视区下边
 * @param zone    触发区厚度（像素）
 * @param maxSpeed 最大速度（像素/帧）
 * @returns 本帧应滚动的像素，负数=向上滚；0=不滚
 */
export function edgeScrollSpeed(
  pointer: number, top: number, bottom: number,
  zone = 48, maxSpeed = 14,
): number {
  if (bottom <= top) return 0;
  /* 上下触发区不能重叠：列表很矮时（比如只有 60px），
     若两边各取 48px，一个指针位置会同时落在两个区里 ——
     那就会一直来回滚，是最难查的一类表现。
     各区厚度取「设定值」与「半高」的较小值。 */
  const half = (bottom - top) / 2;
  const z = Math.min(zone, half);
  if (z <= 0) return 0;

  const depthUp = pointer - top;          // 距上边多远（越小越贴边）
  const depthDown = bottom - pointer;     // 距下边多远

  if (depthUp < z) return -ratio(z - depthUp, z, maxSpeed);
  if (depthDown < z) return ratio(z - depthDown, z, maxSpeed);
  return 0;
}

/** 深度 → 速度：贴得越紧越快，且**至少有一档**，否则贴到最边上反而滚不动。 */
function ratio(depth: number, zone: number, maxSpeed: number): number {
  if (zone <= 0) return 0;
  const t = Math.max(0, Math.min(1, depth / zone));
  return Math.round(t * maxSpeed);
}
