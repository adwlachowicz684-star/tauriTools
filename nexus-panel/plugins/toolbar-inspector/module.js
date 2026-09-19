/**
 * 工具栏插件：元素检查器
 *
 * 原先是侧边栏底部的「⌖ 元素检查器」按钮（#btn-inspect），
 * 现在与其它右上角按钮一样抽成插件，位置统一由 kind:'toolbar' 决定。
 *
 * ================= 状态从哪来：走 api，不 import =================
 *
 * **刻意不 import js/inspector.js**。
 *
 * inspector.js 的 on / locked 是模块级单例，而本插件由
 * import.meta.glob 动态 import → 生成独立 chunk。一旦 inspector.js
 * 被复制进那个 chunk，这里读到的就是**另一份 on**：
 * 按钮高亮永远同步不上，且代码不报错、类型检查也看不出来。
 *
 * 所以宿主把 { isOn, toggle } 注入 api（见 js/toolbar-plugin.js）。
 * 这是插件用宿主能力的正道 —— 只有宿主这一份状态。
 *
 * ================= 为什么按钮要跟着外部状态变 =================
 *
 * 检查器**不止这一个开关**：
 *   · Ctrl/Cmd + Shift + D  快捷键（installInspector 装的）
 *   · ESC                  退出（悬停态直接关，已锁定先解锁）
 *
 * 少了事件同步的表现：用快捷键开了检查器，按钮看着还是关着的，
 * 而用户想关掉它时第一反应是再去点那个按钮 —— 那一下是"开启"。
 *
 * ================= 为什么 onInit 要返回清理函数 =================
 *
 * 这里往 document 上挂了监听。按钮随容器清空一起回收，
 * 但 document 上的监听不会。React 外壳每次依赖变化都会重跑 mountToolbar，
 * 不注销就每重跑一次多一个监听器。
 */

export const INSPECTOR_EVENT = 'nexus:inspector-toggle';

export default {
  id: 'toolbar-inspector',
  label: '⌖',
  tip: '元素检查器（Ctrl+Shift+D）',
  order: 50,

  onInit(api) {
    // 上次开着就自动恢复（installInspector 里已做），按钮也要跟着亮
    api.setActive(api.inspector.isOn());
    const sync = () => api.setActive(api.inspector.isOn());
    document.addEventListener(INSPECTOR_EVENT, sync);
    return () => document.removeEventListener(INSPECTOR_EVENT, sync);
  },

  onClick(api) {
    api.inspector.toggle();
    /*
     * 点击后也显式同步一次：setInspector 只在状态**变化**时派发事件，
     * 而事件监听本身可能还没挂上（首次点击时 onInit 已跑过，这里主要是
     * 兜住"宿主注入的 toggle 不派发事件"的实现差异）。
     */
    api.setActive(api.inspector.isOn());
  },
};
