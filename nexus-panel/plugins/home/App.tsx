import { useEffect, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import type { PluginManifest } from '../../js/host.js';

export default function Overview() {
  const ctx = useNexus();
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [rust, setRust] = useState('检测中…');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPlugins(window.__NEXUS__?.getPlugins?.() ?? []);
    ctx.invoke<string>('app_version').then(setRust).catch(() => setRust('未连接'));
  }, [ctx]);

  const ping = async () => {
    setBusy(true);
    try {
      const r = await ctx.invoke<string>('rust_ping', { payload: 'hello' });
      ctx.toast('Rust 返回：' + r, 'ok');
    } catch (e: any) {
      ctx.toast(String(e?.message ?? e), 'err');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="p-card">
        <h2>运行环境</h2>
        <div className="p-grid">
          <Stat k="挂载模式" v={ctx.mode === 'iframe' ? '沙箱 iframe' : '同页 module'} />
          <Stat k="插件总数" v={plugins.length} />
          <Stat k="Rust 后端" v={rust} />
          <Stat k="面板" v="Nexus Panel" />
        </div>
        <div className="p-row" style={{ marginTop: 16 }}>
          <button className="p-btn primary" onClick={ping} disabled={busy}>
            测试 Rust 通信 (rust_ping)
          </button>
          <span className="p-muted">点击后调用 src-tauri/src/main.rs 中的命令</span>
        </div>
      </div>

      <div className="p-card">
        <h2>已安装插件</h2>
        <div className="p-grid">
          {plugins.map((p) => (
            <div
              key={p.id}
              className="p-stat"
              style={{ cursor: 'pointer' }}
              onClick={() => ctx.openPlugin(p.id)}
              title="点击切换"
            >
              <div className="k">{p.icon ?? '◌'} {p.name}</div>
              <div className="v" style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-dim)' }}>
                {p.type === 'iframe' ? '沙箱挂载' : '同页挂载'}
              </div>
              <div className="p-row" style={{ marginTop: 10, gap: 6 }}>
                <span className="p-tag">{p.builtin ? '内置' : '自定义'}</span>
                {p.requiresBuild ? <span className="p-tag">React</span> : null}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="p-card">
        <h2>开发一个新插件</h2>
        <div className="p-muted" style={{ lineHeight: 2 }}>
          1. 在 <b>plugins/</b> 下建目录，写 <code>index.html</code> + <code>main.tsx</code><br />
          2. 在 <b>plugins/registry.js</b> 加一条 <code>{'{ type: "iframe" }'}</code><br />
          3. <b>vite.config.ts</b> 的 inputs 里登记该 HTML 入口<br />
          4. ⌘/Ctrl + R 热重载，无需重启应用
        </div>
        <div className="p-row" style={{ marginTop: 14 }}>
          <button className="p-btn" onClick={() => ctx.openPlugin('demo-react')}>看 React 沙箱示例</button>
          <button className="p-btn" onClick={() => ctx.openPlugin('demo-iframe')}>看原生沙箱示例</button>
          <button className="p-btn" onClick={() => ctx.reload()}>重载本插件</button>
        </div>
      </div>
    </>
  );
}

function Stat({ k, v }: { k: string; v: string | number }) {
  return (
    <div className="p-stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
