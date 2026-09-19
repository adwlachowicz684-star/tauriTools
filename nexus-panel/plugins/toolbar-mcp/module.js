/**
 * 工具栏插件：MCP 状态
 *
 * 右上角那个 ⬡ —— 显示当前配了几个 MCP 服务，点开可以进凭据中心管它们。
 *
 * ================= 数据从哪来 =================
 *
 * MCP 服务的**全局库**存在 agent-flow 的凭据中心里（一处配置全图可用），
 * 存储 key 是 `agent-flow.mcpServers.v1`，形状 `{ version, servers: [] }`。
 * 这里**只读**它，不写 —— 写入归凭据中心，两边都写必然漂移。
 *
 * ⚠️ 隔离态下读不到
 * ------------------------------------------------------------
 * agent-flow 一旦被设为隔离（isolated），它的 iframe 是 opaque origin，
 * 宿主**进不去它的 localStorage**。这时读到的会是空，
 * 直接显示"—"而不是 0 —— 说 0 等于告诉用户"你没配服务"，
 * 那是**假的**，真实情况是"我看不见"。
 *
 * ================= 打开凭据中心 =================
 *
 * 凭据中心的开关在 agent-flow 组件内部（credOpen state），
 * 从外面调不到。所以走两步：
 *   1. navigate('agent-flow')   —— 先切过去（宿主能力）
 *   2. emit('nexus:open-credentials', { page: 'mcp' }) —— 让它把面板弹出来
 *
 * 第 2 步需要 agent-flow 订阅这个事件（它已在 main.tsx 里接上）。
 * 万一没接上，至少已经切到 Agent Flow 界面了，用户能自己找到入口 ——
 * 不会是"点了完全没反应"。
 */

const KEY = 'agent-flow.mcpServers.v1';

/**
 * @returns {{total:number, enabled:number, visible:boolean}}
 *   visible=false 表示读不到（没配过 / 隔离态 / 格式变了），别当 0 显示
 */
export function readMcpSummary() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { total: 0, enabled: 0, visible: false };
    const j = JSON.parse(raw);
    const list = Array.isArray(j?.servers) ? j.servers : Array.isArray(j) ? j : null;
    if (!list) return { total: 0, enabled: 0, visible: false };
    const usable = list.filter((s) => s && typeof s === 'object');
    const enabled = usable.filter((s) => !s.disabled).length;
    return { total: usable.length, enabled, visible: true };
  } catch {
    /* 存储坏了 / 被隔离：诚实说"看不见"，不要猜 */
    return { total: 0, enabled: 0, visible: false };
  }
}

/** 按钮上显示的那句话 */
export function mcpTip(s) {
  if (!s.visible) return 'MCP 服务 · 未知（读不到配置，可能在隔离态）';
  if (!s.total) return 'MCP 服务 · 还没配置';
  return `MCP 服务 · ${s.enabled}/${s.total} 启用`;
}

function refresh(api) {
  const s = readMcpSummary();
  api.setTip(mcpTip(s));
  return s;
}

export default {
  id: 'toolbar-mcp',
  label: '⬡',
  tip: 'MCP 服务',
  order: 40,

  onInit(api) {
    refresh(api);
  },

  async onClick(api) {
    const s = refresh(api);
    const pick = await api.menu([
      { label: mcpTip(s), value: '__status', disabled: true },
      { separator: true },
      { label: '打开凭据中心（MCP 服务）', value: 'creds' },
      { label: '刷新状态', value: 'refresh' },
    ]);

    if (pick === 'creds') {
      api.navigate('agent-flow');
      /*
       * 先切再发：反过来 agent-flow 还没挂载，事件没人接。
       * 导航本身是异步的，但事件走 bus，挂载后仍会收到 ——
       * 保险起见这里在下一轮事件循环再发。
       */
      setTimeout(() => api.emit('nexus:open-credentials', { page: 'mcp' }), 0);
    } else if (pick === 'refresh') {
      const s2 = refresh(api);
      api.toast(mcpTip(s2), 'info');
    }
  },
};
