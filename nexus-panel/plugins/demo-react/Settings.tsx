import { useEffect, useState } from 'react';
import { useNexus } from '../../src/nexus-react';

/**
 * React 插件的设置面板
 * ------------------------------------------------------------
 * 第二个参数传给 bootIframeReactPlugin 后，外壳会显示「⚙ 设置」。
 * 这个组件跑在另一个沙箱 iframe 里（view='settings'），
 * 但 useNexus() 拿到的 ctx 与主视图完全一致：同一个 store、同一条事件总线。
 */
export default function PluginSettings() {
  const ctx = useNexus();
  const [step, setStep] = useState(1);
  const [label, setLabel] = useState('计数');
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    (async () => {
      setStep(await ctx.store.get<number>('step', 1));
      setLabel(await ctx.store.get<string>('label', '计数'));
      setLoaded(true);
    })();
  }, [ctx]);

  const save = async () => {
    await ctx.store.set('step', step);
    await ctx.store.set('label', label);
    ctx.emit('demo-react:config', { step, label });   // 通知主视图
    ctx.toast('设置已保存', 'ok');
  };

  if (!loaded) return <div className="p-muted">载入中…</div>;

  return (
    <>
      <div className="p-card">
        <h2>React 插件设置</h2>
        <div className="p-muted" style={{ marginBottom: 12, lineHeight: 1.9 }}>
          改动保存后会广播给主视图。这个面板跑在独立的沙箱 iframe 里，
          与主视图隔离，但共享同一份持久化数据。
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="p-muted" style={{ marginBottom: 6 }}>计数器步长</div>
            <div className="p-row">
              {[1, 2, 5, 10].map((n) => (
                <button
                  key={n}
                  className={'p-btn' + (step === n ? ' primary' : '')}
                  style={{ height: 30, padding: '0 12px', fontSize: 12 }}
                  onClick={() => setStep(n)}
                >
                  +{n}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="p-muted" style={{ marginBottom: 6 }}>计数器名称</div>
            <input
              className="p-input"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="计数"
            />
          </div>
        </div>

        <div className="p-row" style={{ marginTop: 16 }}>
          <button className="p-btn primary" onClick={save}>保存</button>
          <button className="p-btn" onClick={() => ctx.reload()}>重载插件</button>
        </div>
      </div>

      <div className="p-card">
        <h2>关于这个面板</h2>
        <div className="p-muted" style={{ lineHeight: 1.9, fontSize: 12 }}>
          模式：{ctx.mode} · 视图：settings<br />
          插件 ID：{ctx.id} · 版本：{ctx.version}
        </div>
      </div>
    </>
  );
}
