import type { PluginManifest } from '../../js/host.js';

export default function Sidebar({
  open,
  plugins,
  activeId,
  badges,
  onToggle,
  onSelect,
  onAdd,
  injected = [],
  onInjected,
}: {
  open: boolean;
  plugins: PluginManifest[];
  activeId: string | null;
  badges: Record<string, number>;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onAdd: () => void;
  /** 插件注入的侧边栏条目 */
  injected?: { id: string; pluginId: string; label: string; icon?: string; event: string }[];
  onInjected?: (it: { id: string; pluginId: string; event: string }) => void;
}) {
  return (
    <aside id="sidebar">
      {/* nx-touch：这是个 34px 的独立按钮，周围没有紧邻控件，
          加 44px 命中区不会与邻居重叠 —— 触屏上更好点。 */}
        <button className="side-toggle nx-touch" onClick={onToggle} title="展开/收起">
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

        {/* 插件注入的条目：点击后由外壳往总线发事件，插件自己响应 */}
        {injected.map((it) => (
          <button
            key={`${it.pluginId}:${it.id}`}
            className="nav-item nav-item-injected"
            title={`${it.label}（来自插件 ${it.pluginId}）`}
            onClick={() => onInjected?.({ id: it.id, pluginId: it.pluginId, event: it.event })}
          >
            <span className="nav-icon">{it.icon || '▶'}</span>
            <span className="nav-label">{it.label}</span>
          </button>
        ))}
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
        {/* 元素检查器已移到标题栏右上角（toolbar-inspector 插件） */}
      </div>
    </aside>
  );
}
