import { useEffect, useState } from 'react';
import type { PluginManifest } from '../../js/host.js';
import { getPluginConfig, setPluginConfig } from '../../js/plugin-config.js';
import * as extPolicy from '../../js/external-policy.js';

/**
 * 抽屉里的外壳固定区块：沙箱隔离 / 主题适配 两个独立开关 + 本插件外链。
 * 对应 shell.js 里的 renderShellSection()，两边行为保持一致。
 */
export default function SandboxSection({ manifest }: { manifest: PluginManifest }) {
  const [cfg, setCfg] = useState(() => getPluginConfig(manifest.id));
  const [, bump] = useState(0);

  useEffect(() => { setCfg(getPluginConfig(manifest.id)); }, [manifest.id]);

  const toggle = (key: 'isolated' | 'adaptTheme') => {
    const next = setPluginConfig(manifest.id, { [key]: !cfg[key] });
    setCfg(next);
    bump((n) => n + 1);
  };

  const rows: [string, 'isolated' | 'adaptTheme', { on: string; off: string }][] = [
    ['严格沙箱', 'isolated', {
      on: '切断插件直连主平台的通道，同时彻底阻断插件之间互访；ctx.invoke / store / 事件 / 主题 等能力通过桥接完整保留。',
      off: '插件与主平台同源，可直连访问（parent / localStorage / Tauri IPC）；代价是插件之间理论上也能互访。',
    }],
    ['主题适配', 'adaptTheme', {
      on: '基调与面板不一致时自动反转统一（隔离时由插件自报基调）。',
      off: '完全不动插件外观，保持它自己的配色。',
    }],
  ];

  const mine = extPolicy.listHosts().filter((x) => x.pluginId === manifest.id);

  return (
    <>
      <div className="p-card">
        <h2>沙箱与主题</h2>
        <div className="p-muted" style={{ lineHeight: 1.9, marginBottom: 4 }}>
          两个开关互相独立。改动在下次加载该插件时生效。
        </div>
        {rows.map(([label, key, texts]) => (
          <div
            key={key}
            className="p-row"
            style={{
              padding: '12px 14px', marginTop: 10, borderRadius: 'var(--r)',
              background: 'var(--surface-sunk)',
              boxShadow: 'inset 3px 3px 6px var(--sh-dark), inset -3px -3px 6px var(--sh-light)',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13 }}>{label}</div>
              <div className="p-muted" style={{ fontSize: 11, marginTop: 2, lineHeight: 1.7 }}>
                {cfg[key] ? texts.on : texts.off}
              </div>
            </div>
            <button
              className={'p-btn' + (cfg[key] ? ' primary' : '')}
              style={{ height: 30, padding: '0 12px', fontSize: 12, flex: 'none' }}
              onClick={() => toggle(key)}
            >
              {cfg[key] ? '已开启' : '已关闭'}
            </button>
          </div>
        ))}
        {manifest.type !== 'iframe' ? (
          <div className="p-muted" style={{ marginTop: 10, fontSize: 11 }}>
            同页插件不受影响 —— 它本来就跑在主页面里。
          </div>
        ) : null}
        <div
          className="p-muted"
          style={{
            marginTop: 12, paddingTop: 10, fontSize: 10.5, lineHeight: 1.8,
            borderTop: '1px solid var(--hairline)',
          }}
        >
          注意：「严格沙箱」切断的是直连通道，不是能力。以下能力<b>无论开关如何都照常可用</b>
          （它们在主平台侧执行）：ctx.invoke 调 Rust、ctx.store 持久化、ctx.on/emit 跨插件事件、
          ctx.setTitle/setBadge/toast、主题同步。
        </div>
      </div>

      {mine.length ? (
        <div className="p-card">
          <h2>外链 · {mine.length}</h2>
          <div className="p-muted" style={{ marginBottom: 10, fontSize: 11 }}>
            扫描插件入口得到。全局策略与逐条放行在「设置 → 外链」里改。
          </div>
          {mine.map((x) => (
            <div
              key={x.host}
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
                  {(extPolicy.KIND_LABELS as Record<string, string>)[x.kind] || x.kind} · {
                    x.status === 'trusted' ? '已信任' : x.status === 'blocked' ? '已禁止' : '待决定'
                  }
                </div>
              </div>
              <span className={'p-tag' + (x.status === 'trusted' ? ' ok' : x.status === 'blocked' ? ' danger' : '')}>
                {x.status === 'trusted' ? '已信任' : x.status === 'blocked' ? '已禁止' : '待决定'}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}
