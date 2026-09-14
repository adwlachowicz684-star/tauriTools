import { useEffect, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import type { PluginManifest } from '../../js/host.js';

/**
 * 取外壳全局单例：同页模式挂在 window 上，沙箱（iframe）模式挂在宿主窗口上。
 *
 * 直接读 window.__NEXUS__ 在严格沙箱下取不到，`?.` 会静默返回 undefined，
 * 再被 `?? []` 兜成空数组 —— 界面显示「插件总数 0」却不报错，极难排查。
 * 这里降级读 parent（settings/index.js 外链管理、ExternalCard.tsx 都是这个写法）；
 * 隔离态（opaque origin）下连 parent 都访问不了，会抛 SecurityError，必须 try/catch。
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

export default function Overview() {
  const ctx = useNexus();
  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  // 拿不到外壳时显式标记为「未知」，别把失败显示成 0
  const [pluginsUnknown, setPluginsUnknown] = useState(false);
  const [rust, setRust] = useState('检测中…');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const list = shellGlobal()?.getPlugins?.();
    setPlugins(Array.isArray(list) ? list : []);
    setPluginsUnknown(!Array.isArray(list));
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
          <Stat
            k="插件总数"
            v={pluginsUnknown ? '—' : plugins.length}
            title={pluginsUnknown ? '未连接到外壳（沙箱隔离态），读不到插件列表' : undefined}
          />
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
        {plugins.length ? null : (
          <div className="p-muted" style={{ marginTop: 10 }}>
            {pluginsUnknown
              ? '未连接到外壳（沙箱隔离态），无法读取插件列表'
              : '暂无插件'}
          </div>
        )}
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

function Stat({ k, v, title }: { k: string; v: string | number; title?: string }) {
  return (
    <div className="p-stat" title={title}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
