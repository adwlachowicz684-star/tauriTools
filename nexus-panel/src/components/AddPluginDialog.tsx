import { useEffect, useState } from 'react';
import type { PluginManifest } from '../../js/host.js';

/**
 * 插件面板（插件商店）
 * ------------------------------------------------------------
 * 原本只是一个"填表单装插件"的小对话框；现在扩成完整的插件面板：
 *   1. 已安装 —— 应用插件与服务插件分两区（服务区注明用途）
 *   2. 添加 —— 保留原来的手填入入口
 *   3. 联网商店 —— 位置已预留（见下方「在线目录」卡片）
 *
 * 为什么把它放在「＋」按钮后面而不是侧边栏单独一项：
 * 插件管理是低频操作，常驻侧边栏会一直占一个位置；而用户想装东西时
 * 第一反应就是点「＋」，入口本来就对。
 *
 * 服务插件（kind:'service'）单独一区列出，是因为它们**不显示在侧边栏** ——
 * 不在这里给个入口，用户根本不知道装了哪些、也无从管理。
 */

type Tab = 'installed' | 'add';

function Card({
  icon, name, meta, desc, onRemove,
}: {
  icon: string; name: string; meta: string; desc?: string; onRemove?: () => void;
}) {
  return (
    <div
      style={{
        display: 'flex', gap: 'var(--sp-5, 10px)', alignItems: 'flex-start',
        padding: '10px 12px', marginTop: 'var(--sp-4, 8px)', borderRadius: 'var(--r-sm)',
        background: 'var(--surface-sunk)',
        boxShadow: 'inset 2px 2px 5px var(--sh-dark), inset -2px -2px 5px var(--sh-light)',
      }}
    >
      <div style={{ fontSize: 'var(--fs-18, 18px)', lineHeight: 1.4, width: 24, textAlign: 'center', flex: '0 0 auto' }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 'var(--fs-13, 13px)', fontWeight: 600 }}>{name}</div>
        {meta ? <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-2, 2px)' }}>{meta}</div> : null}
        {desc ? (
          <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', marginTop: 'var(--sp-2, 4px)', lineHeight: 1.6 }}>{desc}</div>
        ) : null}
      </div>
      {onRemove ? (
        <button
          className="p-btn"
          style={{ height: 26, padding: '0 9px', fontSize: 'var(--fs-11, 11px)', color: 'var(--danger)', flex: '0 0 auto' }}
          onClick={onRemove}
        >
          移除
        </button>
      ) : null}
    </div>
  );
}

export default function AddPluginDialog({
  onClose,
  onSubmit,
  plugins,
  onRemove,
}: {
  onClose: () => void;
  onSubmit: (p: Omit<PluginManifest, 'id'>) => void;
  /** 完整插件列表（含服务插件 —— 服务不进侧边栏，只能在这里看到） */
  plugins: PluginManifest[];
  onRemove: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>('installed');
  const [name, setName] = useState('');
  const [entry, setEntry] = useState('');
  const [icon, setIcon] = useState('');
  const [type, setType] = useState<'iframe' | 'module'>('iframe');

  const apps = plugins.filter((p) => p.kind !== 'service');
  const svcs = plugins.filter((p) => p.kind === 'service');

  /* Esc 关闭：对话框是模态的，键盘用户没有别的退路。 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const meta = (p: PluginManifest) =>
    [
      p.version ? 'v' + p.version : null,
      p.builtin ? '内置' : null,
      p.custom ? '自定义' : null,
      p.kind === 'service' ? '服务插件' : (p.type === 'iframe' ? '沙箱' : '同页'),
      p.interactive ? '交互' : null,
    ].filter(Boolean).join(' · ');

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(20,22,27,.55)',
        display: 'grid', placeItems: 'center', zIndex: 900, padding: 'var(--sp-10, 20px)',
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="p-card"
        style={{ width: 'min(560px, 92vw)', maxHeight: '84vh', display: 'flex', flexDirection: 'column' }}
      >
        {/* 分页条固定在顶部，内容区自己滚 ——
            否则切到「已安装」后要换个页得先滚回顶部。 */}
        <div style={{ display: 'flex', gap: 'var(--sp-3, 6px)', marginBottom: 'var(--sp-6, 12px)', flex: '0 0 auto' }}>
          {([['installed', `已安装（${apps.length + svcs.length}）`], ['add', '添加']] as [Tab, string][])
            .map(([k, label]) => (
              <button
                key={k}
                className={'p-btn' + (tab === k ? ' primary' : '')}
                style={{ height: 28, padding: '0 12px', fontSize: 'var(--fs-12, 12px)' }}
                onClick={() => setTab(k)}
              >
                {label}
              </button>
            ))}
        </div>

        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {tab === 'installed' ? (
            <>
              <h3 style={{ fontSize: 'var(--fs-13, 13px)', margin: '4px 0 2px' }}>应用插件</h3>
              <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', lineHeight: 1.6 }}>
                显示在侧边栏，点开即用。
              </div>
              {apps.length
                ? apps.map((p) => (
                    <Card
                      key={p.id}
                      icon={p.icon || '◈'}
                      name={p.name}
                      meta={meta(p)}
                      desc={p.description}
                      onRemove={p.builtin ? undefined : () => onRemove(p.id)}
                    />
                  ))
                : <div className="p-muted" style={{ padding: '12px 0' }}>还没有安装应用插件。</div>}

              <h3 style={{ fontSize: 'var(--fs-13, 13px)', margin: '16px 0 2px' }}>服务插件</h3>
              <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', lineHeight: 1.6 }}>
                不显示在侧边栏，由其它插件通过 <code>ctx.services.call</code> 调用。
              </div>
              {svcs.length
                ? svcs.map((p) => (
                    <Card key={p.id} icon={p.icon || '⚙'} name={p.name} meta={meta(p)} desc={p.description} />
                  ))
                : <div className="p-muted" style={{ padding: '12px 0' }}>还没有服务插件。</div>}
            </>
          ) : (
            <>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-6, 12px)' }}>
                <div>
                  <div className="p-muted" style={{ marginBottom: 'var(--sp-3, 6px)' }}>插件名称</div>
                  <input className="p-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：日志查看器" autoFocus />
                </div>
                <div>
                  <div className="p-muted" style={{ marginBottom: 'var(--sp-3, 6px)' }}>入口文件（相对项目根目录）</div>
                  <input className="p-input" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="./plugins/my-plugin/index.html" />
                </div>
                <div>
                  <div className="p-muted" style={{ marginBottom: 'var(--sp-3, 6px)' }}>图标（可选，单字符）</div>
                  <input className="p-input" value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="◆" maxLength={2} />
                </div>
                <div>
                  <div className="p-muted" style={{ marginBottom: 'var(--sp-3, 6px)' }}>挂载模式</div>
                  <select className="p-input" value={type} onChange={(e) => setType(e.target.value as any)}>
                    <option value="iframe">沙箱 iframe（默认·推荐）</option>
                    <option value="module">同页模块（可直调 Rust）</option>
                  </select>
                </div>
              </div>

              {/* 联网商店的位置。先放占位，等后端目录与安装流程就绪再接。
                  现在就写出来，是为了让"这里将来会有"这件事可见，
                  而不是等有人问起来才发现没规划。 */}
              <div
                className="p-card"
                style={{ marginTop: 'var(--sp-8, 16px)', background: 'var(--surface-sunk)', boxShadow: 'none' }}
              >
                <div style={{ fontSize: 'var(--fs-13, 13px)', fontWeight: 600 }}>在线目录</div>
                <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)', lineHeight: 1.6, marginTop: 'var(--sp-3, 4px)' }}>
                  未来可从此浏览在线插件目录并直接安装、卸载。
                  当前版本仅支持手动添加本地插件。
                </div>
              </div>
            </>
          )}
        </div>

        <div className="p-row" style={{ marginTop: 'var(--sp-8, 16px)', justifyContent: 'flex-end', flex: '0 0 auto' }}>
          <button className="p-btn" onClick={onClose}>关闭</button>
          {tab === 'add' ? (
            <button
              className="p-btn primary"
              onClick={() => {
                if (!name.trim() || !entry.trim()) return;
                onSubmit({
                  name: name.trim(), entry: entry.trim(), type,
                  icon: icon.trim() || '◌', kind: 'app',
                });
              }}
            >
              添加
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
