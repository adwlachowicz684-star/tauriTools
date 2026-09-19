/**
 * 工具栏插件：元素检查器
 *
 * 原先是侧边栏底部的「⌖ 元素检查器」按钮（#btn-inspect），
 * 现在与其它右上角按钮一样抽成插件，位置统一由 kind:'toolbar' 决定。
 *
 * ================= 为什么按钮要跟着外部状态变 =================
 *
 * 检查器**不止这一个开关**：
 *   · Ctrl/Cmd + Shift + D  快捷键（installInspector 装的）
 *   · ESC                  退出（悬停态直接关，已锁定先解锁）
 *
 * 也就是说按钮的高亮态不能由"我点没点"决定，必须跟着 js/inspector.js
 * 里的真实状态走。做法：监听宿主派发的 `nexus:inspector-toggle`。
 *
 * 少了这条监听的表现：用快捷键开了检查器，按钮看着还是关着的，
 * 而用户想关掉它时，第一反应是再去点那个按钮 —— 那一下是"开启"。
 *
 * ================= 为什么 onInit 要返回清理函数 =================
 *
 * 这里往 document 上挂了监听。按钮随容器清空一起回收，
 * 但 document 上的监听不会。React 外壳每次依赖变化都会重跑 mountToolbar，
 * 不注销就每重跑一次多一个监听器。
 */

import { toggleInspector, isInspectorOn } from '../../js/inspector.js';

export const INSPECTOR_EVENT = 'nexus:inspector-toggle';

export default {
  id: 'toolbar-inspector',
  label: '⌖',
  tip: '元素检查器（Ctrl+Shift+D）',
  order: 50,

  onInit(api) {
    // 上次开着就自动恢复（installInspector 里已做），按钮也要跟着亮
    api.setActive(isInspectorOn());
    const sync = () => api.setActive(isInspectorOn());
    document.addEventListener(INSPECTOR_EVENT, sync);
    return () => document.removeEventListener(INSPECTOR_EVENT, sync);
  },

  onClick(api) {
    toggleInspector();
    /*
     * 点击后也显式同步一次：setInspector 只在状态**变化**时派发事件，
     * 而按钮与被点击元素可能重叠（检查器开启时点按钮本身也会被拦截），
     * 不写这一行就会出现"按钮和实际状态反着"的情况。
     */
    api.setActive(isInspectorOn());
  },
};
