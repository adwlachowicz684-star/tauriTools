import { useState } from 'react';
import {
  type GlobalMcpServer, type McpTransport,
  newServer, validateServers, transportOf, isRunnable, secretEnvNames,
} from '../engine/mcpServers';

/**
 * MCP 服务管理 —— 放在凭据中心里，作为全局库。
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
  protocolReady?: boolean;
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
  servers, onChange, protocolReady, toolCount, onRefresh, refreshing,
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

  const saveEdit = () => {
    if (!editing) return;
    const name = String(editing.name ?? '').trim();
    if (!name) return;
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

      {!protocolReady ? (
        <div className="cred-note">
          MCP 协议还没接上 —— 下面每个服务的状态显示「未接入协议」，
          意思是**还没去连过**，不代表服务有问题。接上后这里会变成真实状态。
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
          <div className="p-muted" style={{ fontSize: 'var(--fs-12, 12px)' }}>
            环境变量在展开后填写 —— 名字像密钥的（含 token / secret / password 等）
            导出时会脱敏，不会随画布带出去。
          </div>
          <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)', gap: 'var(--sp-4, 8px)' }}>
            <button
              className="p-btn primary"
              onClick={saveEdit}
              disabled={!String(editing.name ?? '').trim()}
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
                    {!protocolReady ? (
                      <span className="mcp-state off" title="还没去连过，不代表服务有问题">
                        未接入协议
                      </span>
                    ) : !isRunnable(s) ? (
                      <span className="mcp-state off">配置不全</span>
                    ) : (
                      <span className="mcp-state on">已就绪</span>
                    )}
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
