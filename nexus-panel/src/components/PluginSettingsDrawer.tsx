import { useEffect, useRef, useState } from 'react';
import type { PluginManifest } from '../../js/host.js';
import SandboxSection from './SandboxSection';

/**
 * 插件设置抽屉
 * ------------------------------------------------------------
 * 只负责 DOM 与交互；面板内容由插件宿主引擎挂载进来
 * （module 模式调 def.settings(ctx)，iframe 模式开一个 view='settings' 的沙箱）。
 */
export default function PluginSettingsDrawer({
  manifest,
  onClose,
  mountSettings,
}: {
  manifest: PluginManifest;
  onClose: () => void;
  mountSettings: (container: HTMLElement, manifest: PluginManifest) => Promise<() => void>;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame
      : (fn: FrameRequestCallback) => setTimeout(fn, 16) as unknown as number;
    raf(() => setShown(true));
    let teardown: (() => void) | null = null;
    let alive = true;

    (async () => {
      try {
        const fn = await mountSettings(bodyRef.current!, manifest);
        if (!alive) { fn(); return; }        // 挂载完成前就被关掉了
        teardown = fn;
      } catch (e: any) {
        if (alive) setErr(String(e?.message ?? e));
      }
    })();

    return () => {
      alive = false;
      try { teardown?.(); } catch (e) { console.error(e); }
    };
  }, [manifest, mountSettings]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      className={'mask drawer-mask' + (shown ? ' on' : '')}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <header className="drawer-head">
          <div className="drawer-title">
            <h2>⚙ {manifest.name}</h2>
            <span className="p-muted" style={{ fontSize: 11 }}>
              {manifest.type === 'iframe' ? '沙箱模式' : '同页模式'}
              {manifest.version ? ` · v${manifest.version}` : ''}
            </span>
          </div>
          <button className="tb-btn" title="关闭" onClick={onClose}>✕</button>
        </header>
        <div className="drawer-scroll">
          {/* 上半：插件自己写的设置内容（由引擎挂载进来） */}
          <div className="drawer-body" ref={bodyRef}>
            {err
              ? <div className="err-box"><h3>⚠ 设置面板加载失败</h3><pre>{err}</pre></div>
              : <div className="loader"><div className="spinner" />正在载入设置…</div>}
          </div>
          {/* 下半：外壳固定提供的开关区块 */}
          <SandboxSection manifest={manifest} />
        </div>
      </aside>
    </div>
  );
}
