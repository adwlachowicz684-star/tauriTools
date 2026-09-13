import { useEffect, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import type { PluginManifest } from '../../js/host.js';
import {
  listThemes, applyTheme, setAccent, getThemeId, getAccent,
  saveAsCustom, deleteCustomTheme, ACCENT_SWATCHES,
} from '../../js/theme-manager.js';
import {
  ADAPT_POLICIES, PLUGIN_THEMES,
  getPolicy, setPolicy, getPluginOverride, setPluginOverride,
} from '../../js/theme-normalizer.js';
import * as extPolicy from '../../js/external-policy.js';
import ExternalCard from './ExternalCard';

export default function Settings() {
  const ctx = useNexus();
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [version, setVersion] = useState('…');
  const [, force] = useState(0);          // 主题切换后重渲染预览
  const [policy, setPolicyState] = useState(getPolicy());

  useEffect(() => {
    setPlugins(window.__NEXUS__?.getPlugins?.() ?? []);
    ctx.invoke<string>('app_version').then(setVersion).catch(() => setVersion('浏览器模式'));
  }, [ctx]);

  const rerender = () => force((n) => n + 1);

  return (
    <>
      {/* ---------------- 主题 ---------------- */}
      <div className="p-card">
        <h2>主题</h2>
        {(() => {
          const all = listThemes();
          const groups: [string, typeof all][] = [
            ['深色', all.filter((t) => t.base === 'dark')],
            ['浅色', all.filter((t) => t.base === 'light')],
          ];
          return groups.filter(([, items]) => items.length).map(([label, items]) => (
            <div className="theme-group" key={label}>
              <div className="theme-group-title">{label} · {items.length}</div>
              <div className="theme-grid">
                {items.map((t) => {
                  const v = t.vars;
                  return (
                    <button
                      key={t.id}
                      className={'theme-card' + (t.id === getThemeId() ? ' active' : '')}
                      title={t.desc || t.name}
                      onClick={() => { applyTheme(t.id); ctx.toast(`已切换到「${t.name}」`, 'ok'); rerender(); }}
                    >
                      <div
                        className="theme-prev"
                        style={{
                          background: v['--bg'] || v['--surface'],
                          backgroundImage: v['--bg-image'] && v['--bg-image'] !== 'none' ? v['--bg-image'] : undefined,
                        }}
                      >
                        <i
                          className="sw"
                          style={{
                            background: v['--surface'],
                            boxShadow: `2px 2px 5px ${v['--sh-dark']}, -2px -2px 5px ${v['--sh-light']}`,
                            border: `1px solid ${v['--border'] || 'transparent'}`,
                            backdropFilter: v['--blur'] && v['--blur'] !== '0px'
                              ? `blur(${v['--blur']})` : undefined,
                          }}
                        />
                        <i className="bar" style={{ background: v['--accent'] }} />
                        <i className="bar s" style={{ background: v['--accent-2'] }} />
                      </div>
                      <div className="theme-name" style={{ color: v['--text'] }}>{t.name}</div>
                      <div className="theme-desc">{t.desc || (t.base === 'dark' ? '深色' : '浅色')}</div>
                      {t.custom ? (
                        <button
                          className="theme-del"
                          title="删除该自定义主题"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteCustomTheme(t.id);
                            if (getThemeId() === t.id) applyTheme(listThemes()[0].id);
                            ctx.toast('已删除自定义主题', 'ok');
                            rerender();
                          }}
                        >
                          ✕
                        </button>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </div>
          ));
        })()}

        <div className="p-muted" style={{ marginTop: 16 }}>
          强调色（叠加在当前主题之上）
        </div>
        <div className="p-row" style={{ marginTop: 8 }}>
          {ACCENT_SWATCHES.map(([c, label]) => {
            const cur = getAccent();
            return (
              <button
                key={c}
                className="p-btn"
                style={{
                  color: c,
                  boxShadow: '3px 3px 7px var(--sh-dark), -3px -3px 7px var(--sh-light)',
                  opacity: !cur || cur.toLowerCase() === c.toLowerCase() ? '1' : '.7',
                }}
                onClick={() => { setAccent(c); ctx.toast('强调色：' + label, 'ok'); rerender(); }}
              >
                ● {label}
              </button>
            );
          })}
        </div>

        <div className="p-row" style={{ marginTop: 14 }}>
          <button
            className="p-btn"
            onClick={() => {
              const name = window.prompt('给当前配色起个名字：', '我的主题');
              if (name === null) return;
              const t = saveAsCustom(name.trim() || '我的主题');
              applyTheme(t.id);
              ctx.toast('已保存并应用：' + t.name, 'ok');
              rerender();
            }}
          >
            ＋ 保存为自定义主题
          </button>
        </div>
      </div>

      {/* ---------------- 插件主题适配 ---------------- */}
      <div className="p-card">
        <h2>插件主题适配</h2>
        <div className="p-muted" style={{ marginBottom: 12, lineHeight: 1.9 }}>
          基调不一致的插件会自动反转并与面板统一：深色面板暗化浅色插件，浅色面板亮化深色插件。
          <br />
          图片/图表会二次反转还原，不会被误伤。
        </div>
        <div className="p-row">
          <span style={{ minWidth: 72 }}>全局策略</span>
          <select
            className="p-input"
            style={{ width: 220 }}
            value={policy}
            onChange={(e) => { setPolicy(e.target.value); setPolicyState(e.target.value); }}
          >
            {ADAPT_POLICIES.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </div>
        <div className="p-muted" style={{ marginTop: 8 }}>
          {ADAPT_POLICIES.find((p) => p.value === policy)?.desc}
        </div>
      </div>

      {/* ---------------- 插件管理 ---------------- */}
      <div className="p-card">
        <h2>插件管理</h2>
        <div className="p-muted" style={{ marginBottom: 6 }}>
          侧栏「＋」可安装新插件；右侧下拉为单个插件指定基调判定方式
        </div>
        {plugins.map((p) => (
          <div
            key={p.id}
            className="p-row"
            style={{
              padding: '12px 14px', marginTop: 10, borderRadius: 'var(--r)',
              background: 'var(--surface-sunk)',
              boxShadow: 'inset 3px 3px 6px var(--sh-dark), inset -3px -3px 6px var(--sh-light)',
            }}
          >
            <span style={{ fontSize: 16, width: 24, textAlign: 'center' }}>{p.icon ?? '◌'}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13 }}>{p.name}</div>
              <div className="p-mono p-muted" style={{ fontSize: 11 }}>{p.entry}</div>
            </div>
            <span className="p-tag">{p.type === 'iframe' ? '沙箱' : '同页'}</span>
            <select
              className="p-input"
              style={{ width: 130, height: 30, fontSize: 12, padding: '0 8px' }}
              value={getPluginOverride(p.id) ?? ''}
              onChange={(e) => {
                setPluginOverride(p.id, e.target.value || null);
                ctx.toast(`「${p.name}」适配策略已更新`, 'ok');
              }}
            >
              <option value="">跟随全局</option>
              {PLUGIN_THEMES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
            {p.builtin ? (
              <span className="p-tag">内置</span>
            ) : (
              <button
                className="p-btn danger"
                style={{ height: 30, padding: '0 10px', fontSize: 12 }}
                onClick={() => window.__NEXUS__?.removePlugin?.(p.id)}
              >
                移除
              </button>
            )}
          </div>
        ))}
      </div>

      {/* ---------------- 外链 ---------------- */}
      <ExternalCard />

      {/* ---------------- 关于 ---------------- */}
      <div className="p-card">
        <h2>关于</h2>
        <div className="p-grid">
          <div className="p-stat">
            <div className="k">应用</div>
            <div className="v" style={{ fontSize: 15 }}>Nexus Panel</div>
          </div>
          <div className="p-stat">
            <div className="k">版本</div>
            <div className="v" style={{ fontSize: 15 }}>{version}</div>
          </div>
          <div className="p-stat">
            <div className="k">外壳</div>
            <div className="v" style={{ fontSize: 15 }}>React + Vite + TS</div>
          </div>
          <div className="p-stat">
            <div className="k">框架</div>
            <div className="v" style={{ fontSize: 15 }}>Tauri 2.x</div>
          </div>
        </div>
        <div className="p-muted" style={{ marginTop: 14, lineHeight: 1.9 }}>
          快捷键：⌘/Ctrl + B 收起侧边栏 · ⌘/Ctrl + R 重载当前插件
        </div>
      </div>
    </>
  );
}
