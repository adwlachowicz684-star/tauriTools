import { useEffect, useRef, useState } from 'react';
import { useNexus } from '../../src/nexus-react';

/**
 * React + TSX 沙箱插件示例
 * ------------------------------------------------------------
 * 跑在 iframe 里，CSS/JS 与主页面完全隔离；
 * 通过桥接拿到的 ctx 与同页插件完全一致 —— 业务代码不用改。
 */
export default function Demo() {
  const ctx = useNexus();
  const [count, setCount] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [text, setText] = useState('');
  const loaded = useRef(false);

  const say = (s: string) =>
    setLog((l) => [`${new Date().toLocaleTimeString()} ${s}`, ...l].slice(0, 60));

  const [step, setStep] = useState(1);
  const [label, setLabel] = useState('计数');

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;
    ctx.store.get<number>('count', 0).then(setCount);
    ctx.store.get<number>('step', 1).then(setStep);
    ctx.store.get<string>('label', '计数').then(setLabel);
    const offs = [
      ctx.on('demo:counter', (n: number) => say(`收到广播 demo:counter → ${n}`)),
      ctx.on('demo:ping', (p: any) => say(`收到广播 demo:ping → ${JSON.stringify(p)}`)),
      // 设置面板保存后推过来的配置
      ctx.on('demo-react:config', (cfg: any) => {
        if (cfg?.step) setStep(cfg.step);
        if (cfg?.label != null) setLabel(cfg.label || '计数');
        say(`配置已更新：步长 ${cfg?.step}，名称「${cfg?.label}」`);
      }),
    ];
    say(`插件已挂载：mode=${ctx.mode}，id=${ctx.id}`);
    return () => offs.forEach((fn) => fn?.());
  }, [ctx]);

  const bump = async () => {
    const n = count + step;
    setCount(n);
    await ctx.store.set('count', n);
    ctx.setBadge(n);
    ctx.emit('demo:counter', n);
    say(`${label} = ${n}（步长 ${step}，已持久化）`);
  };

  const callRust = async () => {
    try {
      const r = await ctx.invoke<string>('rust_ping', { payload: text || '来自 React 沙箱' });
      say('rust_ping → ' + r);
      ctx.toast('调用成功', 'ok');
    } catch (e: any) {
      say('错误：' + (e?.message ?? e));
      ctx.toast(String(e?.message ?? e), 'err');
    }
  };

  return (
    <>
      <div className="p-card">
        <h2>计数器（持久化 + 跨插件广播）</h2>
        <div className="p-grid">
          <div className="p-stat">
            <div className="k">{label}（步长 {step}）</div>
            <div className="v">{count}</div>
          </div>
          <div className="p-stat">
            <div className="k">挂载模式</div>
            <div className="v" style={{ fontSize: 15 }}>{ctx.mode}</div>
          </div>
          <div className="p-stat">
            <div className="k">样式隔离</div>
            <div className="v" style={{ fontSize: 15 }}>iframe</div>
          </div>
        </div>
        <div className="p-row" style={{ marginTop: 16 }}>
          <button className="p-btn primary" onClick={bump}>＋ {step}</button>
          <button
            className="p-btn"
            onClick={async () => { setCount(0); await ctx.store.set('count', 0); ctx.setBadge(0); }}
          >
            重置
          </button>
          <button
            className="p-btn"
            onClick={() => { ctx.emit('demo:ping', { from: ctx.id, at: Date.now() }); say('已广播 demo:ping'); }}
          >
            广播 demo:ping
          </button>
        </div>
      </div>

      <div className="p-card">
        <h2>调用 Rust 后端</h2>
        <div className="p-row">
          <input
            className="p-input"
            style={{ maxWidth: 260 }}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="要发送的 payload"
          />
          <button className="p-btn primary" onClick={callRust}>invoke("rust_ping")</button>
          <button
            className="p-btn"
            onClick={async () => say('app_version → ' + await ctx.invoke('app_version').catch(String))}
          >
            invoke("app_version")
          </button>
        </div>
        <div className="p-muted" style={{ marginTop: 10 }}>
          沙箱里不能直接访问 Tauri API，SDK 会自动经 postMessage 桥接转发，用法不变。
        </div>
      </div>

      <div className="p-card">
        <h2>运行日志</h2>
        <div className="p-mono p-muted" style={{ maxHeight: 180, overflow: 'auto', lineHeight: 1.9 }}>
          {log.length ? log.map((l, i) => <div key={i}>{l}</div>) : <div>（暂无）</div>}
        </div>
        <div className="p-row" style={{ marginTop: 14 }}>
          <button className="p-btn" onClick={() => ctx.toast('来自沙箱的提示')}>toast</button>
          <button className="p-btn" onClick={() => ctx.openPlugin('home')}>跳到概览</button>
          <button className="p-btn" onClick={() => ctx.reload()}>重载自己</button>
        </div>
      </div>
    </>
  );
}
