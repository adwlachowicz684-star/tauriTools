import { useState } from 'react';
import McpServersPanel from './McpServersPanel';
import type { GlobalMcpServer } from '../engine/mcpServers';
import { prompt } from '../../../js/dialog.js';
import {
  type Credential, type CredentialKind, type Capability,
  makeCredential, missingCapabilities, NODE_NEEDS, detectGithubCapabilities,
  scopeHintFor,
} from '../engine/credentials';
import { VAULT_MODE_META } from '../types';
import type { VaultMode } from '../engine/credentialStore';

/**
 * 凭据中心。
 *
 * 三件事：
 *  1. 保存前先校验 —— 手滑粘错一个字符，要等到节点运行时才报 401 就太晚了
 *  2. 校验出能力并展示 —— 用户能一眼看出这把密钥能干啥、不能干啥
 *  3. 按需跳转 —— 从节点面板点「去填写」过来时，自动选中对应类型并展开表单
 */

const KIND_META: Record<CredentialKind, { label: string; hint: string }> = {
  github: { label: 'GitHub 令牌', hint: '用于拉取 / 推送节点' },
  llm: { label: '大模型 API Key', hint: '用于图片识别 / 翻译节点' },
  generic: { label: '通用密钥', hint: '其它服务' },
};

const CAP_LABEL: Record<string, string> = {
  'github:read': '读仓库',
  'github:write': '推代码',
  'llm:chat': '对话',
  'llm:vision': '识图',
};

/** 哪些节点在用这条凭据 */
function usersOf(list: Credential[], id: string): string[] {
  const out: string[] = [];
  for (const kind of Object.keys(NODE_NEEDS)) {
    const need = NODE_NEEDS[kind];
    // 只按类型粗判：同类型的节点都可能用它，精确统计要遍历画布
    const wantGithub = need.some((n) => n.indexOf('github:') === 0);
    if (wantGithub && id) out.push(kind);
  }
  return out;
}

export type VerifyFn = (kind: CredentialKind, secret: string) => Promise<{
  ok: boolean;
  identity?: string;
  scopes?: string | null;
  message: string;
}>;

export function CredentialPanel({
  credentials, onChange, onClose, verify,
  locked, mode, onUnlock, onChangeMode, cryptoWarn, unlockError,
  mcpServers, onMcpChange, mcpProtocolReady, mcpToolCount, onMcpRefresh, mcpRefreshing,
  initialPage,
}: {
  credentials: Credential[];
  onChange: (next: Credential[]) => void;
  onClose: () => void;
  verify: VerifyFn;
  /** true 表示还没解锁，此时应展示解锁表单而不是列表 */
  locked?: boolean;
  mode?: VaultMode;
  onUnlock?: (pass: string) => void;
  onChangeMode?: (mode: VaultMode, pass: string) => void;
  /** 环境不支持加密时的提示 */
  cryptoWarn?: string;
  /** 上一次解锁失败的原因 */
  unlockError?: string;
  /* ---- MCP 服务（全局库，与凭据同一处管） ---- */
  mcpServers?: GlobalMcpServer[];
  onMcpChange?: (next: GlobalMcpServer[]) => void;
  /** MCP 协议是否已接入。未接入时状态位明说，不给假绿勾 */
  mcpProtocolReady?: boolean;
  /** 每个服务已生成的节点数，按服务名索引 */
  mcpToolCount?: Record<string, number>;
  onMcpRefresh?: () => void;
  mcpRefreshing?: boolean;
  /**
   * 打开时停在哪一页。由外部（工具栏 MCP 状态插件）指定 ——
   * 从 MCP 状态点进来就该直接看到 MCP 服务，而不是先看到凭据列表
   * 再让用户自己找标签页。
   */
  initialPage?: 'cred' | 'mcp';
}) {
  /*
   * 顶部分「凭据 / MCP 服务」两页。
   *
   * 两者性质一致：都是"这台机器上有什么外部能力"，
   * 都是全局的、都不随画布导出。分开两个入口的话，
   * 配 MCP 时要先想起来该去哪儿找。
   */
  /* 面板是条件渲染的（credOpen 时才挂载），所以初始值就够了，
     不需要再写 effect 同步 —— 每次打开都是一次新挂载。 */
  const [page, setPage] = useState<'cred' | 'mcp'>(initialPage ?? 'cred');
  const [editing, setEditing] = useState<Credential | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [unlockPass, setUnlockPass] = useState('');
  const [unlockErr, setUnlockErr] = useState('');

  const startNew = (kind: CredentialKind) => {
    setEditing(makeCredential({ kind, name: KIND_META[kind].label, secret: '' }));
    setMsg('');
    setErr('');
  };

  const save = async () => {
    if (!editing) return;
    if (!editing.secret.trim()) {
      setErr('密钥不能为空');
      return;
    }
    setBusy(true);
    setErr('');
    setMsg('');
    try {
      const r = await verify(editing.kind, editing.secret.trim());
      if (!r.ok) {
        setErr(`校验失败：${r.message}`);
        setBusy(false);
        return;
      }
      // GitHub 令牌从 scope 头推导能力；其它类型给该类型的全部能力
      let caps: Capability[] = [];
      let ambiguous = false;
      if (editing.kind === 'github') {
        const g = detectGithubCapabilities(r.scopes, true);
        caps = g.capabilities as Capability[];
        ambiguous = g.ambiguous;
      } else if (editing.kind === 'llm') {
        caps = ['llm:chat', 'llm:vision'];
      }
      const next: Credential = {
        ...editing,
        secret: editing.secret.trim(),
        capabilities: caps,
        ambiguous,
        identity: r.identity,
        verifiedAt: Date.now(),
      };
      onChange(credentials.filter((c) => c.id !== next.id).concat(next));
      setMsg(`已保存：${r.identity || r.message}`);
      setEditing(null);
    } catch (e) {
      setErr(`校验出错：${String(e)}`);
    }
    setBusy(false);
  };

  return (
    <div className="cred-mask" onClick={onClose}>
      <div className="cred-panel" onClick={(e) => e.stopPropagation()}>
        <div className="cred-head">
          <strong>凭据中心</strong>
          <span className="mcp-tabs" style={{ marginLeft: 'auto' }}>
            <button
              type="button"
              className={'mcp-tab' + (page === 'cred' ? ' on' : '')}
              onClick={() => setPage('cred')}
            >
              凭据
            </button>
            <button
              type="button"
              className={'mcp-tab' + (page === 'mcp' ? ' on' : '')}
              onClick={() => setPage('mcp')}
            >
              MCP 服务
              {mcpServers && mcpServers.length > 0 ? (
                <span className="mcp-tab-count">{mcpServers.length}</span>
              ) : null}
            </button>
          </span>
          <button className="mini" onClick={onClose}>关闭</button>
        </div>

        {page === 'mcp' ? (
          mcpServers && onMcpChange ? (
            <McpServersPanel
              servers={mcpServers}
              onChange={onMcpChange}
              protocolReady={mcpProtocolReady}
              toolCount={mcpToolCount}
              onRefresh={onMcpRefresh}
              refreshing={mcpRefreshing}
            />
          ) : (
            <div className="p-muted">MCP 服务库还没接上。</div>
          )
        ) : (
          <>
        <div className="cred-tip">
          密钥只存在本机，不会随画布导出 —— 导出的文件里只有凭据 ID。
        </div>

        {cryptoWarn ? <div className="cred-err">{cryptoWarn}</div> : null}

        <div className="cred-vault">
          <span className="p-muted">存储方式：</span>
          {/*
            三选一，而不是一个"切换"按钮。

            以前只有两种，一个按钮在两态间翻就够了；
            三种之后按钮只能循环，用户得连点才知道会到哪 ——
            而且循环按钮看不出"一共有几种"，第四种加进来还得改。
          */}
          <div className="mcp-tabs" style={{ marginLeft: 'var(--sp-4, 8px)' }}>
            {(Object.keys(VAULT_MODE_META) as VaultMode[]).map((m) => (
              <button
                key={m}
                className={'mcp-tab' + (m === mode ? ' on' : '')}
                title={VAULT_MODE_META[m].hint}
                onClick={async () => {
                  if (!onChangeMode || m === mode) return;
                  if (m === 'passphrase') {
                    const p = await prompt({
                      title: '设置解锁口令',
                      message: '之后每次打开凭据都要输入这个口令。忘了就只能重新填一遍所有凭据。',
                      placeholder: '解锁口令',
                      validate: (v) => (v ? null : '口令不能为空'),
                    });
                    if (p) onChangeMode('passphrase', p);
                    return;
                  }
                  onChangeMode(m, '');
                }}
              >
                {VAULT_MODE_META[m].label}
              </button>
            ))}
          </div>
        </div>
        <div className="p-muted" style={{ marginTop: 'var(--sp-2, 4px)', fontSize: 11 }}>
          {VAULT_MODE_META[mode ?? 'auto'].hint}
          {mode === 'passphrase' && !locked && onUnlock ? (
            <button className="mini" style={{ marginLeft: 'var(--sp-3, 6px)' }} onClick={() => onUnlock('')}>
              锁定
            </button>
          ) : null}
        </div>

        {locked ? (
          <div className="cred-edit">
            <div className="p-muted" style={{ fontSize: 'var(--fs-12, 12px)' }}>
              凭据已用口令加密。输入口令后才会解密到内存，磁盘上始终是密文。
            </div>
            <label className="p-row">
              <span className="p-muted" style={{ width: 64, flex: 'none' }}>口令</span>
              <input
                className="p-input"
                type="password"
                value={unlockPass}
                onChange={(e) => setUnlockPass(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && unlockPass && onUnlock) onUnlock(unlockPass);
                }}
                placeholder="解锁口令"
              />
            </label>
            <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)', gap: 'var(--sp-4, 8px)' }}>
              <button
                className="p-btn primary"
                onClick={() => onUnlock && onUnlock(unlockPass)}
                disabled={!unlockPass}
              >
                解锁
              </button>
            </div>
            {(unlockError || unlockErr) ? <div className="cred-err">{unlockError || unlockErr}</div> : null}
          </div>
        ) : null}

        {editing ? (
          <div className="cred-edit">
            <label className="p-row">
              <span className="p-muted" style={{ width: 64, flex: 'none' }}>名称</span>
              <input
                className="p-input"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="便于自己辨认，如「公司 GitHub」"
              />
            </label>
            <label className="p-row">
              <span className="p-muted" style={{ width: 64, flex: 'none' }}>类型</span>
              <select
                className="p-input"
                value={editing.kind}
                onChange={(e) => setEditing({ ...editing, kind: e.target.value as CredentialKind })}
              >
                {(Object.keys(KIND_META) as CredentialKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_META[k].label}</option>
                ))}
              </select>
            </label>
            <label className="p-row">
              <span className="p-muted" style={{ width: 64, flex: 'none' }}>密钥</span>
              <input
                className="p-input"
                type="password"
                value={editing.secret}
                onChange={(e) => setEditing({ ...editing, secret: e.target.value })}
                placeholder={editing.kind === 'github' ? 'ghp_… 或 github_pat_…' : 'sk-…'}
              />
            </label>
            <div className="p-muted" style={{ fontSize: 'var(--fs-12, 12px)' }}>
              {KIND_META[editing.kind].hint}
              {editing.kind === 'github' ? `。${scopeHintFor(['github:write'])}` : ''}
            </div>

            <div className="p-row" style={{ marginTop: 'var(--sp-4, 8px)', gap: 'var(--sp-4, 8px)' }}>
              <button className="p-btn primary" onClick={save} disabled={busy}>
                {busy ? '校验中…' : '校验并保存'}
              </button>
              <button className="p-btn" onClick={() => setEditing(null)} disabled={busy}>取消</button>
            </div>
            {err ? <div className="cred-err">{err}</div> : null}
            {msg ? <div className="cred-ok">{msg}</div> : null}
          </div>
        ) : (
          <div className="p-row" style={{ gap: 'var(--sp-4, 8px)', flexWrap: 'wrap' }}>
            {(Object.keys(KIND_META) as CredentialKind[]).map((k) => (
              <button key={k} className="p-btn" onClick={() => startNew(k)}>
                + {KIND_META[k].label}
              </button>
            ))}
          </div>
        )}

        <div className="cred-list" style={locked ? { display: 'none' } : undefined}>
          {credentials.length === 0 ? (
            <div className="p-muted">还没有凭据。上面选一种添加。</div>
          ) : (
            credentials.map((c) => (
              <div key={c.id} className="cred-item">
                <div className="cred-item-head">
                  <strong>{c.name}</strong>
                  <span className="cred-kind">{KIND_META[c.kind].label}</span>
                  {c.identity ? <span className="cred-id">@{c.identity}</span> : null}
                </div>
                <div className="cred-caps">
                  {c.capabilities.length === 0 ? (
                    <span className="cred-nocap">未校验</span>
                  ) : (
                    c.capabilities.map((cap) => (
                      <span key={cap} className="cred-cap">{CAP_LABEL[cap] || cap}</span>
                    ))
                  )}
                  {c.ambiguous ? (
                    <span className="cred-warn" title="响应头没带权限信息，无法自动判定写权限">
                      权限待确认
                    </span>
                  ) : null}
                </div>
                <div className="p-row" style={{ gap: 'var(--sp-3, 6px)' }}>
                  <button className="mini" onClick={() => { setEditing(c); setErr(''); setMsg(''); }}>
                    编辑
                  </button>
                  <button
                    className="mini danger"
                    onClick={() => onChange(credentials.filter((x) => x.id !== c.id))}
                  >
                    删除
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
          </>
        )}
      </div>
    </div>
  );
}

/** 供给节点面板用：判断某凭据能否给某节点用 */
export function canUse(cred: Credential, nodeKind: string): boolean {
  return missingCapabilities(cred.capabilities, NODE_NEEDS[nodeKind] || []).length === 0;
}
