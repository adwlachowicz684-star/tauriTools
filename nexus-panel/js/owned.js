/**
 * Owned 通道 —— 把"卸载干净"从约定变成结构性保证
 * ============================================================
 * 背景
 * ------------------------------------------------------------
 * 卸载靠 `inst.cleanupFns.forEach(fn => fn())`，而 cleanupFns 是
 * **插件自己 push 的** —— 漏一个就漏一片。
 * 上一轮加的卸载校验（unmount-audit）能**发现**残留，但归因是弱的：
 * 多插件共存时只能看到"总量变了"，说不清是谁留的。
 *
 * 思路
 * ------------------------------------------------------------
 *  事后差分：发现残留 → 不知道谁的        ← 太晚
 *  当场记账：A 挂了监听 → 记到 A 名下     ← 正确
 *
 * 于是：宿主在 mount 时给每个插件发一个 owned 句柄，
 * 所有"会污染宿主文档"的动作**都走它**，它当场记下归属，
 * 卸载时只撤该插件名下的 —— 别的插件不受影响。
 *
 * 为什么它能让卸载"不可能漏"
 * ------------------------------------------------------------
 *   · 走了通道 → 一定被记下 → dispose 一定撤
 *   · 没走通道 → 由静态准入（AST 扫描）兜底
 * 两者叠加才完整，缺一层都不成立 —— 这一点不夸大。
 *
 * 适用范围
 * ------------------------------------------------------------
 * 主要给**同页（module）插件** —— 它们与宿主**同文档**，
 * 污染的是主文档，卸载不会自动带走。
 *
 * iframe 插件也发同一份 API（保持 ctx 形状一致），
 * 但它记的是 iframe **自己** window 上的东西，
 * 随 iframe.remove() 一起消失 —— 记不记都行，记了也无害。
 */

/**
 * 建一个归属句柄。
 *
 * @param {string} pluginId 归属插件（用于报告）
 * @param {{warn?: (msg: string, ...rest: any[]) => void}} [opts]
 */
export function createOwned(pluginId, opts = {}) {
  const warn = opts.warn || ((...a) => console.warn('[owned]', ...a));

  /** 撤销器栈。后加的先撤（LIFO）—— 依赖顺序通常如此。 */
  const undoers = [];
  /** 用到的能力标签，供将来与 manifest.capabilities 交叉校验 */
  const used = new Set();
  let disposed = false;

  const api = {
    pluginId,

    /** 通用：自己提供撤销函数。所有专用方法都是它的语法糖。 */
    addUndo(capability, undo) {
      if (typeof undo !== 'function') return undo;
      if (disposed) {
        /* 已经 dispose 了还往里加 —— 说明插件有异步代码在卸载后才跑。
           立刻撤销掉，别让它漏在外面。 */
        try { undo(); } catch { /* 撤销失败不抛出：正在卸载，不能影响流程 */ }
        return undo;
      }
      if (capability) used.add(capability);
      undoers.push(undo);
      return undo;
    },

    /**
     * 在宿主全局目标（window / document / body）上挂监听。
     * 只记**宿主侧**的 —— 插件自己容器内的监听随容器移除，不用管。
     */
    addListener(target, type, handler, options) {
      if (!target?.addEventListener) return () => {};
      try { target.addEventListener(type, handler, options); } catch { return () => {}; }
      return api.addUndo('global-listen', () => {
        try { target.removeEventListener(type, handler, options); } catch {}
      });
    },

    /** 往宿主文档挂节点（浮层 / portal / 弹窗） */
    addNode(parent, node) {
      if (!parent?.appendChild || !node) return () => {};
      try { parent.appendChild(node); } catch { return () => {}; }
      return api.addUndo('portal', () => {
        try { node.remove(); } catch {}
      });
    },

    /** 定时器 */
    addTimer(kind, id) {
      const clear = kind === 'raf'
        ? () => cancelAnimationFrame(id)
        : () => clearInterval(id);
      return api.addUndo('timer', clear);
    },

    /** setInterval 的便捷写法：直接传函数与间隔 */
    setInterval(fn, ms) {
      const id = setInterval(fn, ms);
      api.addUndo('timer', () => clearInterval(id));
      return id;
    },

    setTimeout(fn, ms) {
      const id = setTimeout(fn, ms);
      api.addUndo('timer', () => clearTimeout(id));
      return id;
    },

    /** 动态样式（style 元素或 CSSStyleSheet 规则） */
    addStyle(node) {
      return api.addNode(document.head, node);
    },

    /** 带 disconnect / close 的句柄：Observer、WebSocket、BroadcastChannel… */
    addHandle(capability, handle) {
      if (!handle) return () => {};
      return api.addUndo(capability, () => {
        try { handle.disconnect?.(); } catch {}
        try { handle.close?.(); } catch {}
      });
    },

    /**
     * 撤销全部。**幂等** —— 重复调用安全。
     *
     * 单项撤销失败不能中断其余清理：一个挂了就跳过后面的话，
     * 会比"漏一个"更严重（后面的全留着）。
     */
    dispose() {
      if (disposed) return { undone: 0, failed: 0 };
      disposed = true;
      let undone = 0;
      let failed = 0;
      while (undoers.length) {
        const fn = undoers.pop();      // LIFO
        try { fn(); undone += 1; }
        catch (e) { failed += 1; warn(`撤销失败（${pluginId}）:`, e); }
      }
      return { undone, failed };
    },

    /** 用到了哪些能力（供能力声明交叉校验） */
    capabilities() { return [...used].sort(); },

    /** 记了多少条 */
    size() { return undoers.length; },

    isDisposed() { return disposed; },
  };

  return api;
}
