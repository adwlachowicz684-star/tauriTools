/**
 * 拖拽排序的**共享内核**
 * ------------------------------------------------------------------
 * 为什么要有它：工具里多处都要「上下拖动改顺序」，各自写一遍的结果是
 * **手感各不相同** —— 死区一大一小、自动滚动一快一慢、
 * 有的点了没反应（阈值吃掉 click）、有的抖两下就乱跳。
 *
 * 用户能说出的往往只是「这里拖着别扭」，说不出是死区还是阈值 ——
 * 所以把这套数值与判定集中到一处，各处才可能对得上。
 *
 * ==================================================================
 * 出处与依据（不是凭手感拍的）
 * ==================================================================
 *
 * 1) WPF 原版 `fenpei-xiangmuzu-qianyi`
 *    · `src/App/MainWindow.Partial.cs`
 *      阈值取 `SystemParameters.MinimumHorizontalDragDistance`（≈4px）；
 *      贴边自动滚动 16ms 一跳、触发区 56px、速度 4→18 随侵入深度递增；
 *      实时换位后立刻 `UpdateLayout()` 取新布局，保证视觉连续不跳。
 *    · `src/ViewModels/MainViewModel.Drag.cs`
 *      索引「先移除再插入」要纠偏（from < to 时 to-1）；
 *      `ObservableCollection.Move` 而非 Remove+Insert，
 *      为的是**保留容器实例**好让让位动画能追踪旧位置。
 *    · `src/Views/SettingsPanel.xaml`
 *      落点指示用**独立的 Canvas 覆盖层**且 `IsHitTestVisible="False"`
 *      —— 指示器绝不能吃掉指针事件，否则拖到它上面就断了。
 *
 * 2) 本项目已验证的 `plugins/project-group/utils/dragSort.ts`
 *    那套纯逻辑（阈值 / 死区 / 贴边滚动）在真实使用中调过参，
 *    这里沿用它的**数值**，与 WPF 的量级也吻合（WPF 56px 触发区 / 4~18px
 *    每跳；本内核 48px / 14px，同数量级，Web 上更稳一点）。
 *
 * 语义说明：本内核是**实时让位换位**（live swap）—— 拖过时其余项让开空位，
 * 与 WPF 集群的行为一致。另一种「插入缝隙 + 落点线」语义见
 * `resolveMoveIndex`（保留来自 dragSort.ts），跨组/需精确落点的场景用它。
 *
 * 纯逻辑部分**零依赖**，可直接被测试与 TS 项目引用；
 * React hook 在同文件末尾，额外依赖 react。
 */

/* ================================ 常量 ================================ */

/**
 * 拖拽起始阈值（像素）。
 *
 * HTML5 的 `draggable` 由浏览器自行决定何时开始拖（Chrome 约 4~5px），
 * 我们**无法直接设定**，但可以在 `dragstart` 里**取消**它。
 *
 * 为什么必须拦：**点击时手抖 2~3px 会被判定成拖拽**，而一旦开始拖，
 * `click` 就不会再触发 —— 用户点一项想选中它，结果既没选中、
 * 项还被拖走一点。这种「点了没反应又不是完全没反应」
 * 正是「用起来别扭但说不出哪别扭」的典型。
 *
 * 取消 dragstart 后因为没有拖拽发生，mouseup 会正常触发 click，一切回到预期。
 *
 * 取 5：略高于浏览器自带阈值（WPF 取系统值 ≈4），只拦真实抖动，不干扰刻意拖拽。
 */
export const DRAG_THRESHOLD = 5;

/** 死区：越过邻项中心还不够，还要超出死区才换位。 */
export const DEAD_ZONE_FIXED = 8;
export const DEAD_ZONE_RATIO = 0.2;

/** 贴边自动滚动：触发区厚度与最大速度（像素/帧）。 */
export const EDGE_ZONE = 48;
export const EDGE_MAX_SPEED = 14;

/* ============================== 纯逻辑 ============================== */

/** 按下点位移够不够大——不够就判定为点击，取消这次拖拽。 */
export function movedEnough(pressAt, clientX, clientY, threshold = DRAG_THRESHOLD) {
  // 没有按下点（键盘发起的拖拽等）→ 不拦，交给浏览器
  if (!pressAt) return true;
  return Math.hypot(clientX - pressAt.x, clientY - pressAt.y) >= threshold;
}

/** 把下标夹进 [0, max]（max 为 -1 时返回 -1，用于空列表）。 */
export function clampIndex(v, max) {
  if (max < 0) return -1;
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(max, Math.trunc(v)));
}

/**
 * 死区取「固定像素」与「邻项尺寸 20%」的**较小值**。
 *
 * 为什么取较小值而不是较大值：若取较大值，矮项的 20% 可能比相邻的高项还大，
 * 换位的触发点就被推到了高项内部 —— 怎么拖都换不动。
 * 小元素也能精确操作，才是这里要的。
 */
export function deadZone(neighborSize, fixed = DEAD_ZONE_FIXED, ratio = DEAD_ZONE_RATIO) {
  return Math.min(fixed, neighborSize * ratio);
}

/**
 * 换到哪个下标——带死区滞后，且支持一次跨多项。
 *
 * 为什么要有死区：手抖一两个像素就让列表疯狂跳动，看着像界面坏了。
 * 死区内保持原索引，用户的操作意图才不会被抖动淹没。
 *
 * @param pos     指针位置（与 centers 同轴）
 * @param centers 各项中心位置（按序）
 * @param sizes   各项尺寸（按序，用于算死区）
 * @param from    被拖项当前下标
 */
export function swapIndexWithDeadZone(pos, centers, sizes, from) {
  if (from < 0 || from >= centers.length) return from;
  let target = from;

  // 向上：越过上一个的中心 + 死区
  for (let i = from - 1; i >= 0; i--) {
    const dz = deadZone(sizes[i] ?? 0);
    if (pos < centers[i] - dz) target = i; else break;
  }
  if (target !== from) return target;

  // 向下：越过下一个的中心 + 死区
  for (let j = from + 1; j < centers.length; j++) {
    const dz = deadZone(sizes[j] ?? 0);
    if (pos > centers[j] + dz) target = j; else break;
  }
  return target;
}

/**
 * 侵入深度 → 滚动速度（像素/帧）。
 *
 * **为什么按深度加速**：贴边滚动的常见场景是「把项拖到列表另一头」，
 * 那边可能有几十项。恒定速度的话近处慢、远处也只有那么快，
 * 拖到末尾要按着不动好几秒 —— 用户会以为卡住了而松手，前功尽弃。
 * 越贴边越快，想快就再贴紧一点，控制权在用户手上。
 *
 * 死区内不滚：否则指针刚碰到边缘就开始滚，手抖一下列表就飘。
 *
 * @returns 本帧应滚动的像素，负数=向上/左滚；0=不滚
 */
export function edgeScrollSpeed(
  pointer, top, bottom,
  zone = EDGE_ZONE, maxSpeed = EDGE_MAX_SPEED,
) {
  if (bottom <= top) return 0;

  /*
   * 上下触发区不能重叠：列表很矮时（比如只有 60px），
   * 若两边各取 48px，一个指针位置会同时落在两个区里 ——
   * 那就会一直来回滚，是最难查的一类表现。
   * 各区厚度取「设定值」与「半高」的较小值。
   */
  const half = (bottom - top) / 2;
  const z = Math.min(zone, half);
  if (z <= 0) return 0;

  const depthUp = pointer - top;
  const depthDown = bottom - pointer;

  if (depthUp < z) return -depthToSpeed(z - depthUp, z, maxSpeed);
  if (depthDown < z) return depthToSpeed(z - depthDown, z, maxSpeed);
  return 0;
}

/** 深度 → 速度：贴得越紧越快，且**至少有一档**，否则贴到最边上反而滚不动。 */
function depthToSpeed(depth, zone, maxSpeed) {
  if (zone <= 0) return 0;
  const t = Math.max(0, Math.min(1, depth / zone));
  return Math.round(t * maxSpeed);
}

/**
 * 「先移除再插入」的索引纠偏 —— **最容易写错的一处**（来自 WPF 同款注释）。
 *
 * 落点 k 是在**还含被拖项**的数组里算出的，而移动是「先摘掉再插入」，
 * 两者差一位：被拖项原本在 k 之前（from < k），它一走后面的都前移一位，
 * 所以 k 要减 1。不减的话，往上拖会稳定「落点偏后一格」——
 * 表现为「明明插在 A 前面，结果跑到 A 后面」。
 *
 * @param from 被拖项当前下标（-1 表示不在列表里）
 * @param k    在含被拖项的数组里算出的缝隙位置
 * @param n    列表长度
 */
export function resolveMoveIndex(from, k, n) {
  if (from < 0 || from >= n) return clampIndex(k, n);
  const r = from < k ? k - 1 : k;
  return clampIndex(r, n - 1);
}

/**
 * 专用 MIME。
 *
 * 为什么每种拖拽都要有**专用** MIME，不能图省事用 `text/plain`：
 *   1. `text/plain` 是通用类型，从别的应用拖进来的文本也匹配它；
 *      靠「组件内状态是否为 -1」守卫是脆弱的（状态会因重渲染丢失，MIME 不会）。
 *   2. 更实际的坑：行内若有 `<input>`（比如重命名框），
 *      拖着 `text/plain` 经过它松手，浏览器默认行为是**把文本插进去** ——
 *      用户只是想调个顺序，结果名字被塞进了输入框。
 */
export function dragMime(key) {
  return `application/x-nexus-${key}`;
}

/** 校验拖拽载荷（dataTransfer 里可以是**任意文本**，必须兜住）。 */
export function parseDragIndex(raw) {
  if (!raw) return -1;
  try {
    const v = JSON.parse(raw);
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
    if (v && typeof v === 'object' && Number.isInteger(v.index) && v.index >= 0) return v.index;
  } catch { /* 忽略：不是我们写的载荷 */ }
  return -1;
}
