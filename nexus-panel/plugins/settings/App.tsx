import { useEffect, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import type { PluginManifest } from '../../js/host.js';
import {
  listThemes, applyTheme, setAccent, setEnvColor, resetColors,
  getThemeId, getAccent, getEnvColor, getBase,
  getHueShift, getLightShift, setThemeShift,
  saveAsCustom, deleteCustomTheme,
  onChange as onThemeChange,
} from '../../js/theme-manager.js';
import { swatchFor, styleLabel } from '../../js/themes.js';
import {
  ADAPT_POLICIES, PLUGIN_THEMES,
  getPolicy, setPolicy, getPluginOverride, setPluginOverride,
} from '../../js/theme-normalizer.js';
import ExternalCard from './ExternalCard';
import FilesCard from './FilesCard';

type TabKey = 'theme' | 'plugins' | 'external' | 'files' | 'about';

/**
 * 取外壳全局单例：本设置页是 iframe 插件，开启严格沙箱后 window.__NEXUS__
 * 取不到，要降级读宿主的 parent（同文件外链管理、ExternalCard.tsx 都是这个写法）。
 * 隔离态（opaque origin）下连 parent 也访问不了，会抛 SecurityError，必须 try/catch。
 */
function shellGlobal(): any {
  try {
    return (window as any).__NEXUS__
      ?? (window.parent !== window ? (window.parent as any)?.__NEXUS__ : null)
      ?? null;
  } catch {
    return null; // 跨源 / 隔离态下访问 parent 抛 SecurityError
  }
}

const TABS: [TabKey, string][] = [
  ['theme', '主题'],
  ['plugins', '插件'],
  ['external', '外链'],
  ['files', '文件'],
  ['about', '关于'],
];

export default function Settings() {
  const ctx = useNexus();
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [pluginsUnknown, setPluginsUnknown] = useState(false);
  const [version, setVersion] = useState('…');
  const [, force] = useState(0);          // 主题切换后重渲染预览
  const [policy, setPolicyState] = useState(getPolicy());
  const [tab, setTab] = useState<TabKey>('theme');

  useEffect(() => {
    const list = shellGlobal()?.getPlugins?.();
    setPlugins(Array.isArray(list) ? list : []);
    // 拿不到外壳时不要静默显示成「0 个插件」，后面会渲染一条显式提示
    setPluginsUnknown(!Array.isArray(list));
    ctx.invoke<string>('app_version').then(setVersion).catch(() => setVersion('浏览器模式'));
  }, [ctx]);

  /* 订阅主题变更：从标题栏的主题按钮切换时，
     本页面当前主题的高亮与色板选中态要跟着刷新。
     不订阅的话，只有用户点了本页某个元素触发重渲染才会更新，
     看起来就像"切了但没生效"。
     （这段曾在 53013446 的全量覆盖中丢失，现补回） */
  useEffect(() => {
    // 包一层：force() 返回 boolean，而 useEffect 的清理函数要求返回 void，
    // 直接透传会被 TS 判为类型不匹配（Destructor 不接受 boolean）。
    const off = onThemeChange(() => { force((n) => n + 1); });
    return () => { off(); };
  }, []);

  const rerender = () => force((n) => n + 1);

  /**
   * 移除插件。
   *
   * 原来直接 `window.__NEXUS__?.removePlugin?.(p.id)`：沙箱下取不到方法，
   * `?.` 静默跳过 —— 用户点了「移除」却什么都没发生、也没有任何提示。
   * 这里改成：先降级到 parent 找外壳；确实拿不到就显式报错，不再静默。
   */
  const removePlugin = (p: PluginManifest) => {
    const shell = shellGlobal();
    if (typeof shell?.removePlugin !== 'function') {
      ctx.toast('移除失败：未连接到外壳，请用侧栏的插件管理操作', 'err');
      return;
    }
    try {
      shell.removePlugin(p.id);
      const list = shell.getPlugins?.();
      setPlugins(Array.isArray(list) ? list : []);
      setPluginsUnknown(!Array.isArray(list));
      ctx.toast(`已移除「${p.name}」`, 'ok');
    } catch (e: any) {
      ctx.toast('移除失败：' + String(e?.message ?? e), 'err');
    }
  };

  /**
   * 把当前主题状态同步给主平台侧（外壳）。
   *
   * 为什么需要：本设置页是 iframe 插件，有自己的 document。本地这份
   * theme-manager 的 applyTheme 只改 iframe 内的 :root —— 结果是"设置页
   * 自己变了、主面板没变"。而标题栏右上角的切换跑在主平台侧，改主文档
   * :root，主面板变、再经 pushTheme 推给 iframe，所以两边都变。
   *
   * 这里把写操作经 ctx.shell.theme 桥接给主平台侧再执行一次：
   * 主面板立刻变 → 它的 onChange 触发 pushTheme → 把新变量推回 iframe。
   * 单向流动不会来回触发 —— iframe 收到的是"应用变量"，不会再回写。
   *
   * 本地已经先执行过了，所以本函数失败也不影响设置页自身；
   * 桥接拿不到时（module 模式、旧版外壳）只是主面板不联动，属降级。
   */
  const syncThemeToShell = async () => {
    const shellTheme = (ctx as any)?.shell?.theme;
    if (!shellTheme) return;
    try {
      // 色相 / 明暗是独立存储的两档，先同步再应用主题，否则会被覆盖回去
      await shellTheme.setThemeShift?.(getHueShift(), getLightShift());
      await shellTheme.applyTheme?.(getThemeId(), getAccent(), getEnvColor());
    } catch { /* 桥接不可用：保持本地结果 */ }
  };

  /**
   * 把适配策略同步给主平台侧并**触发重算**。
   *
   * 与主题同一类问题：策略存 localStorage，iframe 隔离态下本地写不进
   * 主平台侧。更关键的是——适配滤镜是 installAdapter 时按策略算一次就
   * 固化的，策略改了不重算，当前插件看起来就是"改了没反应"。
   * 宿主侧的写方法会在写完后重跑 reAdapt，所以这一步不只是"存对"。
   */
  const syncPolicyToShell = async (fn: (() => Promise<unknown>) | undefined) => {
    if (!fn) return;
    try { await fn(); } catch { /* 桥接不可用：保持本地结果 */ }
  };

  return (
    <>
      {/* ---------------- 分页导航 ---------------- */}
      <div className="set-tabs">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            className={'set-tab' + (tab === key ? ' active' : '')}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'theme' ? (
        /* ---------------- 主题 ---------------- */
        <div className="p-card">
          <h2>主题</h2>
          <div className="p-muted" style={{ marginBottom: 12, fontSize: 12 }}>
            点缩略图即切换。标题栏右上角的 ◐ 按钮也能快速切换，两处是同一套数据。
          </div>
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
                        onClick={() => { applyTheme(t.id); ctx.toast(`已切换到「${t.name}」`, 'ok'); rerender(); void syncThemeToShell(); }}
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
                          {/* 右半做成一小块「界面」：两条正文线 + 一条强调色条，
                              与标题栏弹出层里的缩略图共用 .tp-* 样式。
                              这两条是主题的装饰配色，不是状态色 ——
                              状态色（成功/错误/运行中）语义固定，不随环境色变化，
                              故不在此预览中展示，避免误导。 */}
                          <div className="tp-mid">
                            <i className="tp-line" style={{ background: v['--text'] }} />
                            <i
                              className="tp-line dim"
                              style={{ background: v['--text-dim'] || v['--text'] }}
                            />
                            <div className="tp-row">
                              <i
                                className="bar"
                                title="强调色：按钮 / 选中态"
                                style={{ background: v['--accent'] }}
                              />
                              <i
                                className="bar s"
                                title="环境色：次要点缀（非状态色）"
                                style={{ background: v['--env-color'] }}
                              />
                            </div>
                          </div>
                          {/* 当前主题打勾：缩略图很小，光靠描边看不出来 */}
                          {t.id === getThemeId() ? <span className="theme-check">✓</span> : null}
                        </div>
                        <div className="theme-foot">
                          {/* 名字用当前主题的正文色（.theme-name 已定义），
                              不能取 v['--text'] —— 那是被预览主题的颜色，
                              深色面板下预览浅色主题会变成深色字压深色底 */}
                          <div className="theme-name">{t.name}</div>
                          <span className="theme-badge">{styleLabel(t.style)}</span>
                        </div>
                        <div className="theme-desc">{t.desc || (t.base === 'dark' ? '深色' : '浅色')}</div>
                        {t.custom ? (
                          <button
                            className="theme-del"
                            title="删除该自定义主题"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteCustomTheme(t.id);
                              if (getThemeId() === t.id) applyTheme(listThemes()[0].id);
                              void syncThemeToShell();
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
            强调色（叠加在当前主题之上 · 按钮 / 选中态 / 链接）
          </div>
          <div className="p-row" style={{ marginTop: 8 }}>
            {swatchFor(getBase()).map(([c, label]) => {
              const cur = getAccent();
              return (
                <button
                  key={c}
                  className="p-btn"
                  style={{
                    color: c,
                    boxShadow: '3px 3px 7px var(--sh-dark), -3px -3px 7px var(--sh-light)',
                    opacity: !cur || cur.toLowerCase() === c.toLowerCase() ? '1' : '.8',
                  }}
                  onClick={() => { setAccent(c); ctx.toast('强调色：' + label, 'ok'); rerender(); void syncThemeToShell(); }}
                >
                  ● {label}
                </button>
              );
            })}
          </div>

          <div className="p-muted" style={{ marginTop: 14 }}>
            环境色（第二个主色 · 仅用于次要点缀）
          </div>
          <div className="p-muted" style={{ fontSize: 12, marginTop: 2 }}>
            成功 / 错误 / 运行中 / 警告 为固定语义色，不随这里变化
          </div>
          <div className="p-row" style={{ marginTop: 8 }}>
            {swatchFor(getBase()).map(([c, label]) => {
              const cur = getEnvColor();
              return (
                <button
                  key={c}
                  className="p-btn"
                  style={{
                    color: c,
                    boxShadow: '3px 3px 7px var(--sh-dark), -3px -3px 7px var(--sh-light)',
                    opacity: !cur || cur.toLowerCase() === c.toLowerCase() ? '1' : '.8',
                  }}
                  onClick={() => { setEnvColor(c); ctx.toast('环境色：' + label, 'ok'); rerender(); void syncThemeToShell(); }}
                >
                  ● {label}
                </button>
              );
            })}
          </div>

          <div className="p-muted" style={{ marginTop: 14 }}>
            主题色调整（在主题自身配色上做整体偏移）
          </div>
          <div className="p-muted" style={{ fontSize: 12, marginTop: 2 }}>
            {`每套主题各记一份（当前：${getCurrent().name}）；只偏移主题配色，强调色、环境色与状态色不参与`}
          </div>
          <div className="p-row" style={{ marginTop: 8, gap: 8 }}>
            <span className="p-muted" style={{ width: 30, flex: 'none' }}>色相</span>
            <input
              className="p-range"
              type="range" min={-180} max={180} step={1}
              value={getHueShift()}
              onChange={(e) => { setThemeShift(Number(e.target.value), getLightShift()); rerender(); void syncThemeToShell(); }}
            />
            <span className="p-mono p-muted" style={{ width: 46, flex: 'none', textAlign: 'right' }}>
              {getHueShift() > 0 ? '+' : ''}{getHueShift()}°
            </span>
          </div>
          <div className="p-row" style={{ marginTop: 6, gap: 8 }}>
            <span className="p-muted" style={{ width: 30, flex: 'none' }}>明暗</span>
            <input
              className="p-range"
              type="range" min={-50} max={50} step={1}
              value={getLightShift()}
              onChange={(e) => { setThemeShift(getHueShift(), Number(e.target.value)); rerender(); void syncThemeToShell(); }}
            />
            <span className="p-mono p-muted" style={{ width: 46, flex: 'none', textAlign: 'right' }}>
              {getLightShift() > 0 ? '+' : ''}{getLightShift()}%
            </span>
          </div>

          {(getAccent() || getEnvColor() || getHueShift() || getLightShift()) ? (
            <div className="p-row" style={{ marginTop: 10 }}>
              <button
                className="p-btn"
                onClick={() => { resetColors(); ctx.toast('已恢复主题自带配色', 'ok'); rerender(); void syncThemeToShell(); }}
              >
                ↺ 恢复主题自带配色
              </button>
              <span className="p-muted">
                当前：强调色 {getAccent() || '（默认）'} · 环境色 {getEnvColor() || '（默认）'}
                {(getHueShift() || getLightShift())
                  ? ` · 偏移 ${getHueShift() > 0 ? '+' : ''}${getHueShift()}° / ${getLightShift() > 0 ? '+' : ''}${getLightShift()}%`
                  : ''}
              </span>
            </div>
          ) : null}

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
                void syncThemeToShell();
              }}
            >
              ＋ 保存为自定义主题
            </button>
          </div>
        </div>
      ) : null}

      {tab === 'plugins' ? (
        <>
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
                onChange={(e) => {
                  setPolicy(e.target.value);
                  setPolicyState(e.target.value);
                  void syncPolicyToShell(() => (ctx as any)?.shell?.normalizer?.setPolicy(e.target.value));
                }}
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
                    void syncPolicyToShell(() => (ctx as any)?.shell?.normalizer
                      ?.setPluginOverride(p.id, e.target.value || null));
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
                    onClick={() => removePlugin(p)}
                  >
                    移除
                  </button>
                )}
              </div>
            ))}
            {plugins.length ? null : (
              <div className="p-muted" style={{ marginTop: 10 }}>
                {pluginsUnknown
                  ? '未连接到外壳（沙箱隔离态），读不到插件列表，移除功能不可用'
                  : '暂无可管理的插件'}
              </div>
            )}
          </div>
        </>
      ) : null}

      {/* ---------------- 外链 ---------------- */}
      {tab === 'external' ? <ExternalCard /> : null}
      {tab === 'files' ? <FilesCard /> : null}

      {/* ---------------- 关于 ---------------- */}
      {tab === 'about' ? (
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
      ) : null}
    </>
  );
}
