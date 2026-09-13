import { useCallback, useEffect, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import {
  POLICY_MODES, KIND_LABELS,
  type Policy, type HostEntry,
} from '../../js/external-policy.js';

/**
 * 外链能力适配层
 * ------------------------------------------------------------
 * 把两种访问方式统一成同一套**异步**接口，组件不用关心自己跑在哪里：
 *
 *   bridge —— 走 ctx.shell 桥接，在主平台侧执行。
 *             本插件即便被设为隔离态（opaque origin）也照样可用。
 *   direct —— 直接拿 window/parent 上的 __NEXUS__.external（仅非隔离时可用）。
 *
 * 优先 bridge，失败才回退 direct。
 */
function useExternalApi() {
  const ctx = useNexus();
  const [channel, setChannel] = useState<'bridge' | 'direct' | null>(null);

  const bridge = (ctx as any)?.shell?.external;

  const call = useCallback(async (bridgeMethod: string, directMethod: string, args: any[] = []) => {
    // 先走桥接
    if (bridge && typeof bridge[bridgeMethod] === 'function') {
      try {
        const r = await bridge[bridgeMethod](...args);
        setChannel('bridge');
        return r;
      } catch { /* 落到直连 */ }
    }
    let ext: any = null;
    try { ext = (window as any).__NEXUS__?.external; } catch { /* ignore */ }
    if (!ext) { try { ext = (window.parent as any)?.__NEXUS__?.external; } catch { /* ignore */ } }
    if (!ext || typeof ext[directMethod] !== 'function') {
      throw new Error('外链能力不可用（未运行在 Nexus 外壳中）');
    }
    setChannel('direct');
    return ext[directMethod](...args);
  }, [bridge]);

  const load = useCallback(async () => {
    const policy: Policy = await call('load', 'loadPolicy');
    const hosts: HostEntry[] = await call('list', 'listHosts');
    return { policy, hosts: hosts || [] };
  }, [call]);

  return {
    channel,
    load,
    savePolicy: (p: Policy) => call('save', 'savePolicy', [p]),
    setStatus: (host: string, status: string) => call('setStatus', 'setHostStatus', [host, status]),
    removeHost: (host: string) => call('remove', 'removeHost', [host]),
    suggestCsp: (p: Policy) => call('suggestCsp', 'suggestCsp', [p]),
    rescan: () => call('rescan', 'rescanAll', []),
  };
}

/**
 * 外链管理
 * ------------------------------------------------------------
 * 三档全局策略 + 逐域名放行/禁止 + 重新扫描 + 建议 CSP。
 * 与原生设置页（plugins/settings/index.js）行为一致。
 */
export default function ExternalCard() {
  const ctx = useNexus();
  const api = useExternalApi();
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [hosts, setHosts] = useState<HostEntry[]>([]);
  const [csp, setCsp] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const { policy: p, hosts: hs } = await api.load();
      setPolicy(p);
      setHosts(hs);
      setErr(null);
      try { setCsp((await api.suggestCsp(p)) || ''); } catch { setCsp(''); }
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    }
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  if (err) {
    return (
      <div className="p-card">
        <h2>外链</h2>
        <div className="p-muted">{err}</div>
      </div>
    );
  }
  if (!policy) {
    return (
      <div className="p-card">
        <h2>外链</h2>
        <div className="p-muted">载入中…</div>
      </div>
    );
  }

  const pending = hosts.filter((x) => x.status === 'pending');

  const act = async (fn: () => Promise<any>, okMsg?: string) => {
    await fn();
    if (okMsg) ctx.toast(okMsg, 'ok');
    await refresh();
  };

  return (
    <div className="p-card">
      <h2>外链</h2>
      <div className="p-muted" style={{ marginBottom: 12, lineHeight: 1.9 }}>
        插件访问外部网络的分级管控。安装与更新时自动扫描入口文件，
        运行时被 CSP 拦下的请求也会登记到这里，可逐条放行或禁止。
        {api.channel === 'bridge' ? (
          <span className="p-tag ok" style={{ marginLeft: 6 }}>桥接通道</span>
        ) : api.channel === 'direct' ? (
          <span className="p-tag" style={{ marginLeft: 6 }}>直连通道</span>
        ) : null}
      </div>

      <div className="p-row" style={{ marginBottom: 10 }}>
        <span style={{ minWidth: 60, fontSize: 13 }}>全局策略</span>
        <select
          className="p-input"
          style={{ width: 160, height: 30, fontSize: 12, padding: '0 8px' }}
          value={policy.mode}
          onChange={(e) => act(() => api.savePolicy({ ...policy, mode: e.target.value as any }), '外链策略已更新')}
        >
          {POLICY_MODES.map((m) => (
            <option key={m.value} value={m.value}>{m.label}</option>
          ))}
        </select>
        <span className="p-muted" style={{ fontSize: 11, flex: 1 }}>
          {POLICY_MODES.find((m) => m.value === policy.mode)?.desc}
        </span>
        <button
          className="p-btn"
          style={{ height: 30, padding: '0 12px', fontSize: 12 }}
          onClick={() => act(() => api.rescan(), undefined)}
        >
          重新检查
        </button>
      </div>

      {pending.length ? (
        <div className="p-row" style={{ marginBottom: 12 }}>
          <span className="p-tag danger" style={{ margin: 0 }}>{pending.length} 个待决定</span>
          <span className="p-muted" style={{ fontSize: 11 }}>
            智能提醒模式下，这些域名会被拦下并提示
          </span>
        </div>
      ) : null}

      {!hosts.length ? (
        <div className="p-muted" style={{ padding: '14px 0' }}>
          还没有登记任何外链。安装插件时会扫描入口文件，运行时被 CSP 拦下的也会记到这里。
        </div>
      ) : hosts.map((x) => (
        <div key={x.host}>
          <div
            className="p-row"
            style={{
              padding: '10px 12px', marginTop: 8, borderRadius: 'var(--r-sm)',
              background: 'var(--surface-sunk)',
              boxShadow: 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="p-mono" style={{ fontSize: 12 }}>{x.host}</div>
              <div className="p-muted" style={{ fontSize: 10.5, marginTop: 2 }}>
                {(KIND_LABELS as Record<string, string>)[x.kind] || x.kind}
                {x.pluginId ? ` · ${x.pluginId}` : ''}
              </div>
            </div>
            {([['信任', 'trusted', 'primary'], ['禁止', 'blocked', 'danger']] as const).map(
              ([label, status, cls]) => (
                <button
                  key={status}
                  className={'p-btn' + (x.status === status ? ' ' + cls : '')}
                  style={{ height: 26, padding: '0 9px', fontSize: 11 }}
                  onClick={() => act(() => api.setStatus(x.host, status))}
                >
                  {label}
                </button>
              ))}
            <button
              className="p-btn"
              style={{ height: 26, padding: '0 8px', fontSize: 11 }}
              title="从清单移除"
              onClick={() => act(() => api.removeHost(x.host))}
            >
              ✕
            </button>
          </div>
          {x.sample ? (
            <div
              className="p-mono p-muted"
              style={{
                fontSize: 10, marginTop: 2, marginLeft: 12,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              title={x.sample}
            >
              {x.sample}
            </div>
          ) : null}
        </div>
      ))}

      {csp ? (
        <>
          <div className="p-muted" style={{ marginTop: 14, fontSize: 11 }}>
            已信任的域名需要写进 CSP 才真正放行：
          </div>
          <pre
            className="p-mono"
            style={{
              marginTop: 6, padding: 10, fontSize: 10.5, whiteSpace: 'pre-wrap',
              wordBreak: 'break-all', borderRadius: 'var(--r-sm)', background: 'var(--surface-sunk)',
              boxShadow: 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)',
            }}
          >
            {csp}
          </pre>
        </>
      ) : null}
    </div>
  );
}
