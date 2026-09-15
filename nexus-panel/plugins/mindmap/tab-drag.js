/**
 * 页签拖拽排序（A53–A57）
 * ============================================================
 * 对应 WPF `WireSheetDragOnce` 那套指针状态机
 * （`MindMapPanel.xaml.cs:1394-1700`）：
 *   A53 跟随动画 · A54 死区与实时换位 · A55 边缘自动滚动
 *   A56 插入位置竖条 · A57 拖拽取消回弹
 *
 * ## 为什么不用 HTML5 Drag & Drop
 *
 * 原实现用的是 `draggable=true` + dragstart/dragover/drop，它有三个硬伤：
 *
 * 1. **拖影由浏览器绘制，无法自定义** —— A53 的悬浮跟随做不到；
 * 2. **`dragstart` 无死区**，手指一抖就进入拖拽，单击切换、双击重命名会被吞
 *    （WPF 专门用 `MinimumHorizontalDragDistance` 做了阈值）；
 * 3. **`dragover` 触发频率不足以驱动流畅的实时换位**。
 *
 * 故改用 Pointer Events 自建状态机，行为对齐 WPF。
 *
 * ## 事件委托
 *
 * `pointerdown` 挂在容器上、靠 `[data-tab-id]` 找目标，因此 `renderTabs()`
 * 重建 DOM 后**无需重新绑定**，也不会累积监听器。
 */

/** 拖拽启动阈值（px）。WPF 用 SystemParameters.MinimumHorizontalDragDistance */
const DRAG_THRESHOLD = 5;

/** 换位死区（px）。WPF `SheetSwapHysteresis` */
const SWAP_HYSTERESIS = 16;

/** 贴边自动滚动：边缘区宽度与速度区间（对齐 WPF OnSheetAutoScrollTick） */
const SCROLL_ZONE = 56;
const SCROLL_MIN_SPEED = 4;
const SCROLL_MAX_SPEED = 18;

/** 回弹动画时长（ms） */
const SPRING_MS = 180;

/**
 * @param {HTMLElement} container 页签容器（需可横向滚动）
 * @param {object} opts
 *   - {() => string[]} getOrder   当前的画布 id 顺序
 *   - {(order:string[]) => void} onReorder  应用新顺序
 *   - {(msg:string, warn?:boolean) => void} onStatus
 *   - {() => boolean} canDrag     是否允许拖拽（如只有一张画布时不需要）
 * @returns {{ destroy: () => void, isDragging: () => boolean }}
 */
export function attachTabDrag(container, opts = {}) {
  const { getOrder, onReorder, onStatus, canDrag } = opts;

  /** @type {null | object} 拖拽状态；null = 空闲 */
  let st = null;
  let rafId = 0;
  let lastDragEndAt = 0;

  /* ---------------- 生命周期 ---------------- */

  function cleanup() {
    stopAutoScroll();
    if (st?.follow) { st.follow.remove(); }
    if (st?.el) st.el.classList.remove('dragging', 'drop-target');
    st = null;
  }

  /** 结束拖拽：DOM 已在目标位置，按新顺序回写数据 */
  function finish(commit) {
    if (!st) return;
    const el = st.el;
    const order = [];
    for (const c of container.children) {
      const id = c.getAttribute?.('data-tab-id');
      if (id) order.push(id);
    }
    const before = getOrder ? getOrder() : [];
    const changed = order.length === before.length && order.some((id, i) => id !== before[i]);

    if (!commit || !changed) {
      // A57：没真的换位就回弹 —— WPF 的 SpringBack 分支
      springBack(el);
      lastDragEndAt = Date.now();
      return;
    }
    cleanup();
    lastDragEndAt = Date.now();
    try { onReorder?.(order); } catch (e) { onStatus?.('调整顺序失败：' + (e?.message || e), true); }
  }

  /** 取消：恢复 DOM 顺序并回弹 */
  function cancel() {
    if (!st) return;
    const { el, anchor } = st;
    // 放回原位：anchor 是拖拽前它的下一个兄弟节点（可能是 null = 末尾）
    try { container.insertBefore(el, anchor || null); } catch (e) { /* DOM 已变，忽略 */ }
    springBack(el);
    lastDragEndAt = Date.now();
  }

  /** A57 回弹：跟随元素动画飞回原标签位置再清理 */
  function springBack(el) {
    if (!st) return;
    const follow = st.follow;
    const r = el.getBoundingClientRect();
    cleanup();
    if (!follow) return;
    follow.style.transition = `left ${SPRING_MS}ms cubic-bezier(.2,.8,.3,1), top ${SPRING_MS}ms cubic-bezier(.2,.8,.3,1), opacity ${SPRING_MS}ms`;
    follow.style.left = r.left + 'px';
    follow.style.top = r.top + 'px';
    follow.style.opacity = '0';
    setTimeout(() => follow.remove(), SPRING_MS + 40);
  }

  /* ---------------- pointerdown：只记候选 ---------------- */

  function onPointerDown(e) {
    if (e.button != null && e.button !== 0) return;      // 只响应左键
    if (st) cancel();                                     // 残留状态先清（对齐 WPF）
    const el = e.target.closest?.('[data-tab-id]');
    if (!el || !container.contains(el)) return;
    if (canDrag && !canDrag()) return;
    // 点关闭/复制按钮时不启动拖拽
    if (e.target.closest?.('.x')) return;
    st = {
      id: el.getAttribute('data-tab-id'),
      el,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      dragging: false,
      anchor: el.nextElementSibling,     // 原位锚点，用于取消时插回
      follow: null,
      grabDx: 0,
      grabDy: 0,
    };
  }

  /* ---------------- pointermove：阈值 → 拖拽 ---------------- */

  function onPointerMove(e) {
    if (!st) return;
    st.lastX = e.clientX;
    st.lastY = e.clientY;

    if (!st.dragging) {
      const dx = e.clientX - st.startX;
      const dy = e.clientY - st.startY;
      if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;   // 死区内不启动
      beginDrag(e);
      return;
    }
    e.preventDefault();
    updateFollow();
    tryLiveSwap();
    updateBar();
  }

  function beginDrag(e) {
    st.dragging = true;
    const el = st.el;
    const r = el.getBoundingClientRect();
    st.grabDx = st.startX - r.left;      // 抓取点在标签内的偏移，保持手感
    st.grabDy = st.startY - r.top;

    el.classList.add('dragging');

    // A53 跟随元素：fixed 定位的克隆，跟着指针走。
    // 用 cloneNode 而不是移动原节点 —— 原节点要继续占位做「让位」。
    const follow = el.cloneNode(true);
    follow.classList.add('mm-tab-follow');
    follow.classList.remove('dragging');
    follow.removeAttribute('data-tab-id');   // 不参与顺序计算
    follow.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;` +
      'z-index:9999;pointer-events:none;margin:0;opacity:.92;';
    document.body.appendChild(follow);
    st.follow = follow;

    // A56 插入竖条
    const bar = document.createElement('div');
    bar.className = 'mm-tab-insertbar';
    document.body.appendChild(bar);
    st.bar = bar;

    try { el.setPointerCapture?.(e.pointerId); } catch (err) { /* 不支持捕获也能拖 */ }
    startAutoScroll();
    updateFollow();
    updateBar();
  }

  /** 跟随元素贴合指针（并夹在容器可视范围内，对齐 WPF UpdateSheetFollow） */
  function updateFollow() {
    if (!st?.follow) return;
    let x = st.lastX - st.grabDx;
    let y = st.lastY - st.grabDy;
    const r = container.getBoundingClientRect();
    const w = st.follow.offsetWidth || 0;
    const lo = r.left;
    const hi = Math.max(lo, r.right - w);
    x = Math.min(Math.max(x, lo), hi);
    st.follow.style.left = x + 'px';
    st.follow.style.top = y + 'px';
  }

  /**
   * A54 实时换位：按**跟随元素中心**判定目标索引，直接改 DOM 顺序。
   * 改 DOM 而非等 drop 时才动 —— 其他页签实时让开，落点才看得见。
   */
  function tryLiveSwap() {
    if (!st?.dragging) return;
    const tabs = [...container.children].filter((c) => c.getAttribute?.('data-tab-id'));
    const cur = tabs.indexOf(st.el);
    if (cur < 0) return;
    // 被拖元素自身不参与「邻框」判定 —— 它的 rect 就是占位，会自我干扰
    const rects = tabs.map((t) => (t === st.el ? null : t.getBoundingClientRect()));
    const probe = st.follow
      ? st.follow.getBoundingClientRect().left + st.follow.offsetWidth / 2
      : st.lastX;
    const to = swapIndex(probe, cur, rects, SWAP_HYSTERESIS);
    if (to === cur) return;
    const ref = tabs[to];
    try {
      container.insertBefore(st.el, to > cur ? (ref?.nextElementSibling || null) : (ref || null));
    } catch (e) { /* 并发重建，忽略 */ }
  }

  /**
   * A56 插入竖条：画在被拖元素（占位）的左边缘。
   * 它同时是落点指示 —— 松手后标签就落在这里。
   */
  function updateBar() {
    if (!st?.bar) return;
    const r = st.el.getBoundingClientRect();
    st.bar.style.cssText =
      `position:fixed;left:${r.left - 1}px;top:${r.top}px;width:2px;height:${r.height}px;` +
      'z-index:9998;pointer-events:none;border-radius:1px;';
  }

  /**
   * A55 贴边自动滚动。用 rAF 而不是 setInterval：
   * 与刷新率同步更顺滑，且页面隐藏时浏览器自动暂停，不空转。
   */
  function startAutoScroll() {
    if (rafId) return;
    const tick = () => {
      if (!st?.dragging) { rafId = 0; return; }
      const r = container.getBoundingClientRect();
      let delta = 0;
      if (st.lastX > r.right - SCROLL_ZONE) {
        delta = SCROLL_MIN_SPEED + (SCROLL_MAX_SPEED - SCROLL_MIN_SPEED) *
          Math.min(1, (st.lastX - (r.right - SCROLL_ZONE)) / SCROLL_ZONE);
      } else if (st.lastX < r.left + SCROLL_ZONE) {
        delta = -(SCROLL_MIN_SPEED + (SCROLL_MAX_SPEED - SCROLL_MIN_SPEED) *
          Math.min(1, ((r.left + SCROLL_ZONE) - st.lastX) / SCROLL_ZONE));
      }
      if (delta) {
        const before = container.scrollLeft;
        const max = Math.max(0, container.scrollWidth - container.clientWidth);
        container.scrollLeft = Math.min(Math.max(0, before + delta), max);
        // 滚动不产生 pointermove，必须主动重算，否则标签脱手
        if (Math.abs(container.scrollLeft - before) > 0.5) {
          updateFollow();
          tryLiveSwap();
          updateFollow();
          updateBar();
        }
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function stopAutoScroll() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  /* ---------------- 结束 ---------------- */

  function onPointerUp() {
    if (!st) return;
    if (st.dragging) finish(true);
    else cleanup();               // 没进入拖拽态：就是一次点击，交给 click
  }

  /** 捕获丢失（移出窗口 / DOM 重组）时安全收尾 —— 对齐 WPF 的兜底分支 */
  function onLostCapture() {
    if (st?.dragging) finish(true);
    else cleanup();
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && st?.dragging) { e.preventDefault(); cancel(); }
  }

  /** 拖拽刚结束时吞掉这一次 click，避免顺带触发「切换画布」 */
  function onClickCapture(e) {
    if (Date.now() - lastDragEndAt < 220) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  container.addEventListener('pointerdown', onPointerDown);
  // move/up 挂 document：指针可能移出容器（尤其边缘自动滚动时）
  document.addEventListener('pointermove', onPointerMove, { passive: false });
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onLostCapture);
  document.addEventListener('keydown', onKeyDown);
  container.addEventListener('click', onClickCapture, true);

  return {
    destroy() {
      cleanup();
      container.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onLostCapture);
      document.removeEventListener('keydown', onKeyDown);
      container.removeEventListener('click', onClickCapture, true);
    },
    isDragging: () => !!st?.dragging,
  };
}

/**
 * A54 带死区的换位索引（对齐 WPF `GetSheetSwapIndex`）。
 *
 * 基准是**被拖标签的视觉中心**：要越过邻框中心、再多出一个死区才换一步。
 * 没有死区的话，指针在两框边界抖动会导致顺序反复横跳。
 * 循环推进让快速甩动也能追上（一次 move 跨好几格）。
 *
 * @param {number} probeX  探测点（跟随元素中心 X）
 * @param {number} from    当前索引
 * @param {(DOMRect|null)[]} rects  各页签 rect，被拖的那个传 null
 */
export function swapIndex(probeX, from, rects, hysteresis = SWAP_HYSTERESIS) {
  const n = rects.length;
  if (n === 0 || from < 0) return 0;
  let idx = Math.min(Math.max(from, 0), n - 1);
  for (let guard = 0; guard < n; guard++) {
    let next = idx;
    const below = rects[idx + 1];
    if (below) {
      // 死区：小页签自动缩小死区，否则窄页签几乎换不动
      const margin = Math.min(hysteresis, below.width * 0.2);
      if (probeX > below.left + below.width / 2 + margin) next = idx + 1;
    }
    if (next === idx) {
      const above = rects[idx - 1];
      if (above) {
        const margin = Math.min(hysteresis, above.width * 0.2);
        if (probeX < above.left + above.width / 2 - margin) next = idx - 1;
      }
    }
    if (next === idx) break;
    idx = next;
  }
  return idx;
}
