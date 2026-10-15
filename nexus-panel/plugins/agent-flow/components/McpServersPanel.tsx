import { useState } from 'react';
import {
  type GlobalMcpServer, type McpTransport,
  newServer, validateServers, transportOf, isRunnable, mcpStateOf, secretEnvNames,
} from '../engine/mcpServers';

/**
 * MCP 服务管理 —— 放在连接管理器里，作为全局库。
 *
 * ================= 为什么分「本地 / 云端」两个标签 =================
 *
 * 它们其实是**两种传输方式**，必填项不同：
 *   本地 = command，起一个本地子进程走 stdio
 *   云端 = url，连一个远端 HTTP 服务
 * 混在一个列表里的话，"这个该填命令还是地址"要每次自己想。
 *
 * ================= 状态：不假装 =================
 *
 * 协议还没接上（`fetchTools` 是空接口），真实状态拿不到。
 * 所以状态位显示明确的「未接入协议」，而不是给一个假的绿勾 ——
 * 假绿勾会让用户以为服务已经在跑了。
 */

type Props = {
  servers: GlobalMcpServer[];
  onChange: (next: GlobalMcpServer[]) => void;
  /** 协议是否已接入。false 时状态位明说"未接入"，不假装 */
  /** 每个服务已生成的节点数，按服务名索引 */
  toolCount?: Record<string, number>;
  onRefresh?: () => void;
  refreshing?: boolean;
};

const TABS: { key: McpTransport; label: string; hint: string }[] = [
  {
    key: 'local',
    label: '本地',
    hint: '起一个本地进程走 stdio。填启动命令，如 npx -y @modelcontextprotocol/server-filesystem /tmp',
  },
  {
    key: 'remote',
    label: '云端',
    hint: '连一个远端服务。填 HTTP 地址（SSE / streamable）',
  },
];

/** 首字标：给每个服务一个稳定的颜色，便于在列表里一眼分辨 */
function dotColor(name: string): string {
  const palette = ['#7c9cf5', '#f0a35e', '#6fc48a', '#c68cf0', '#e87c7c', '#5ec4c4'];
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

export default function McpServersPanel({
  servers, onChange, toolCount, onRefresh, refreshing,
}: Props) {
  const [tab, setTab] = useState<McpTransport>('local');
  const [editing, setEditing] = useState<GlobalMcpServer | null>(null);

  const issues = validateServers(servers);
  const issueOf = (name: string): string | null => {
    const hit = issues.find((i) => i.field === name);
    return hit ? hit.message : null;
  };

  const list = servers.filter((s) => transportOf(s) === tab);

  const commit = (next: GlobalMcpServer[]) => onChange(next);

  const patch = (id: string, p: Partial<GlobalMcpServer>) => {
    commit(servers.map((s) => (s.id === id ? { ...s, ...p } : s)));
  };

  const startNew = () => {
    setEditing({ ...newServer(''), command: tab === 'local' ? '' : undefined });
  };

  /*
   * 保存缺什么 —— 与按钮的 disabled 同一份判据，且与 engine 侧的
   * isRunnable / transportOf 同源（都是"命令或地址至少填一个"）。
   * 各写一份的话，按钮放行了、列表却按另一套判据把它划到别的页签，
   * 就是"保存完凭空消失"。
   */
  const saveBlocker = !editing
    ? ''
    : !String(editing.name ?? '').trim()
      ? '服务名称'
      : !isRunnable(editing)
        ? (tab === 'local' ? '启动命令' : '地址')
        : '';

  const saveEdit = () => {
    if (!editing) return;
    const name = String(editing.name ?? '').trim();
    if (!name) return;
    /* 与按钮同一判据：两个都空的服务存进去也起不来，还会在列表里失踪 */
    if (!isRunnable(editing)) return;
    const next = servers.some((s) => s.id === editing.id)
      ? servers.map((s) => (s.id === editing.id ? editing : s))
      : [...servers, editing];
    commit(next);
    setEditing(null);
  };

  return (
    <div className="mcp-mgr">
      <div className="mcp-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={'mcp-tab' + (tab === t.key ? ' on' : '')}
            onClick={() => { setTab(t.key); setEditing(null); }}
          >
            {t.label}
            <span className="mcp-tab-count">
              {servers.filter((s) => transportOf(s) === t.key).length}
            </span>
          </button>
        ))}
        <span className="mcp-tabs-fill" />
        {onRefresh ? (
          <button type="button" className="mini" onClick={onRefresh} disabled={refreshing}>
            {refreshing ? '刷新中…' : '刷新'}
          </button>
        ) : null}
        <button type="button" className="mini af-add" onClick={startNew}>+ 添加</button>
      </div>

      <div className="cred-tip">{TABS.find((t) => t.key === tab)?.hint}</div>

      {/*
       * 以前这里写的是"MCP 协议还没接上，状态位不代表服务有问题"。
       * 那是**假话**：HTTP 传输早就接上了，只是没人回来改这句话 ——
       * 而它正是"所有服务恒显示未接入协议"这个 bug 的思想来源。
       *
       * 现在说的是真正没接上的那一种：stdio。按服务判定，不再一刀切。
       */}
      {servers.some((s) => mcpStateOf(s).label === 'stdio 未接入') ? (
        <div className="cred-note">
          有服务用的是 stdio 传输（command 方式），还没接上 ——
          状态位会写成「stdio 未接入」。改用 HTTP 地址即可。
        </div>
      ) : null}

      {editing ? (
        <div className="cred-edit">
          <label className="p-row">
            <span className="p-muted" style={{ width: 76, flex: 'none' }}>名称</span>
            <input
              className="p-input"
              value={editing.name ?? ''}
              onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              placeholder="节点里按这个名字引用，如 xmind"
            />
          </label>
          {tab === 'local' ? (
            <label className="p-row">
              <span className="p-muted" style={{ width: 76, flex: 'none' }}>启动命令</span>
              <input
                className="p-input"
                value={editing.command ?? ''}
                onChange={(e) => setEditing({ ...editing, command: e.target.value })}
                placeholder="npx -y @modelcontextprotocol/server-filesystem /tmp"
              />
            </label>
          ) : (
            <label className="p-row">
              <span className="p-muted" style={{ width: 76, flex: 'none' }}>地址</span>
              <input
                className="p-input"
                value={editing.url ?? ''}
                onChange={(e) => setEditing({ ...editing, url: e.target.value })}
                placeholder="https://mcp.example.com/sse"
              />
            </label>
          )}
          <label className="p-row">
            <span className="p-muted" style={{ width: 76, flex: 'none' }}>备注</span>
            <input
              className="p-input"
              value={editing.note ?? ''}
              onChange={(e) => setEditing({ ...editing, note: e.target.value })}
              placeholder="选填，给自己看的"
            />
          </label>
          <div className="p-muted" style={{ fontSize: 'var(--fs-body, 12px)' }}>
            环境变量在展开后填写 —— 名字像密钥的（含 token / secret / password 等）
            导出时会脱敏，不会随画布带出去。
          </div>
          <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)', gap: 'var(--sp-4, 8px)' }}>
            {/*
             * 置灰必须配一句说明：只置灰不说原因，用户知道点不动，
             * 却不知道该填哪个。
             *
             * 为什么连"传输方式"也要拦（以前只拦名称）：
             * 在「云端」页签只填名字保存 → 命令和地址都是空的 →
             * transportOf 兜底判成 local → 这条服务**不在当前页签的列表里**，
             * 保存完就凭空消失。用户只会以为没存上，然后一遍遍重新添加。
             * 这样的服务存进去也起不来（isRunnable 为 false，列表里同样会
             * 标"这个服务起不来"），不如当场拦住。
             */}
            {saveBlocker ? (
              <span className="p-muted" style={{ fontSize: 'var(--fs-body, 12px)' }}>
                还差：{saveBlocker}
              </span>
            ) : null}
            <button
              className="p-btn primary"
              onClick={saveEdit}
              disabled={!!saveBlocker}
              title={saveBlocker ? `还差：${saveBlocker}` : undefined}
            >
              保存
            </button>
            <button className="p-btn" onClick={() => setEditing(null)}>取消</button>
          </div>
        </div>
      ) : null}

      <div className="cred-list">
        {list.length === 0 ? (
          <div className="p-muted">
            还没有{tab === 'local' ? '本地' : '云端'}服务。点右上角「+ 添加」。
          </div>
        ) : (
          list.map((s) => {
            const name = String(s.name ?? '');
            const bad = issueOf(name);
            const secrets = secretEnvNames(s);
            const tools = toolCount?.[name] ?? 0;
            return (
              <div key={s.id} className="mcp-item">
                <span className="mcp-dot" style={{ background: dotColor(name) }} />
                <div className="mcp-item-main">
                  <div className="mcp-item-head">
                    <strong>{name || '（未命名）'}</strong>
                    {/*
                     * 不启用时整行变淡 + 明确写"已停用"。
                     * 只靠开关状态区分的话，扫列表时很容易看漏。
                     */}
                    {s.disabled ? <span className="mcp-off">已停用</span> : null}
                  </div>
                  <div className="mcp-item-sub">
                    {tab === 'local'
                      ? (s.command ? String(s.command) : '（没填启动命令）')
                      : (s.url ? String(s.url) : '（没填地址）')}
                  </div>
                  <div className="mcp-item-meta">
                    {/*
                     * 由 mcpStateOf 一次算出来，不再靠那个全局布尔 prop 分三支。
                     *
                     * protocolReady 此前 App **从来没传**，于是恒为 undefined ——
                     * 结果连上了也永远显示「未接入协议」，和旁边的「N 个工具」自相矛盾。
                     * 见 engine/mcpServers 里 mcpStateOf 的说明。
                     */}
                    {(() => {
                      const st = mcpStateOf(s);
                      return (
                        <span className={'mcp-state ' + (st.on ? 'on' : 'off')} title={st.hint}>
                          {st.label}
                        </span>
                      );
                    })()}
                    {tools > 0 ? <span className="mcp-tools">{tools} 个工具</span> : null}
                    {secrets.length > 0 ? (
                      <span className="mcp-secret" title={`含密钥环境变量：${secrets.join('、')}（导出时脱敏）`}>
                        {secrets.length} 个密钥变量
                      </span>
                    ) : null}
                  </div>
                  {bad ? <div className="cred-err">{bad}</div> : null}
                </div>
                <div className="mcp-item-ops">
                  <button
                    type="button"
                    className={'mcp-switch' + (s.disabled ? '' : ' on')}
                    title={s.disabled ? '启用这个服务' : '停用（配置保留，但不参与生成节点）'}
                    onClick={() => patch(s.id, { disabled: !s.disabled })}
                  >
                    <span className="mcp-knob" />
                  </button>
                  <button type="button" className="mini" onClick={() => setEditing({ ...s })}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="mini danger"
                    onClick={() => commit(servers.filter((x) => x.id !== s.id))}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
