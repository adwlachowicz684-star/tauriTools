import type { PluginManifest } from '../../js/host.js';

export default function Sidebar({
  open,
  plugins,
  activeId,
  badges,
  onToggle,
  onSelect,
  onAdd,
}: {
  open: boolean;
  plugins: PluginManifest[];
  activeId: string | null;
  badges: Record<string, number>;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  return (
    <aside id="sidebar">
      <button className="side-toggle" onClick={onToggle} title="展开/收起">
        <b>☰</b>
        <span>插件面板</span>
      </button>

      <nav id="plugin-list">
        {plugins.map((p) => {
          const n = badges[p.id];
          return (
            <button
              key={p.id}
              className={'nav-item' + (p.id === activeId ? ' active' : '')}
              title={`${p.name}${p.type === 'iframe' ? '（沙箱）' : '（同页）'}`}
              onClick={() => onSelect(p.id)}
            >
              <span className="nav-icon">{p.icon || '◌'}</span>
              <span className="nav-label">{p.name}</span>
              {n ? (
                <span className="nav-badge" style={{ display: 'grid' }}>
                  {n > 99 ? '99+' : n}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div id="sidebar-foot">
        <button className="nav-item" onClick={onAdd} title="安装插件">
          <span className="nav-icon">＋</span>
          <span className="nav-label">安装插件</span>
        </button>
        <button className="nav-item" onClick={() => onSelect('settings')} title="设置">
          <span className="nav-icon">⚙</span>
          <span className="nav-label">设置</span>
        </button>
      </div>
    </aside>
  );
}
