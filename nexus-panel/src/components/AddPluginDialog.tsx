import { useState } from 'react';
import type { PluginManifest } from '../../js/host.js';

export default function AddPluginDialog({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (p: Omit<PluginManifest, 'id'>) => void;
}) {
  const [name, setName] = useState('');
  const [entry, setEntry] = useState('');
  const [icon, setIcon] = useState('');
  const [type, setType] = useState<'iframe' | 'module'>('iframe');

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(20,22,27,.55)',
        display: 'grid', placeItems: 'center', zIndex: 900,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="p-card" style={{ width: 440 }}>
        <h2 style={{ marginBottom: 18 }}>安装插件</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="p-muted" style={{ marginBottom: 6 }}>插件名称</div>
            <input className="p-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：日志查看器" autoFocus />
          </div>
          <div>
            <div className="p-muted" style={{ marginBottom: 6 }}>入口文件（相对项目根目录）</div>
            <input className="p-input" value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="./plugins/my-plugin/index.html" />
          </div>
          <div>
            <div className="p-muted" style={{ marginBottom: 6 }}>图标（可选，单字符）</div>
            <input className="p-input" value={icon} onChange={(e) => setIcon(e.target.value)} placeholder="◆" maxLength={2} />
          </div>
          <div>
            <div className="p-muted" style={{ marginBottom: 6 }}>挂载模式</div>
            <select className="p-input" value={type} onChange={(e) => setType(e.target.value as any)}>
              <option value="iframe">沙箱 iframe（默认·推荐）</option>
              <option value="module">同页模块（可直调 Rust）</option>
            </select>
          </div>
        </div>
        <div className="p-row" style={{ marginTop: 20, justifyContent: 'flex-end' }}>
          <button className="p-btn" onClick={onClose}>取消</button>
          <button
            className="p-btn primary"
            onClick={() => {
              if (!name.trim() || !entry.trim()) return;
              onSubmit({ name: name.trim(), entry: entry.trim(), type, icon: icon.trim() || '◌' });
            }}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}
