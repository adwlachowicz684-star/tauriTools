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
  hasPluginSettings = true,
}: {
  manifest: PluginManifest;
  onClose: () => void;
  mountSettings: (container: HTMLElement, manifest: PluginManifest) => Promise<() => void>;
  /**
   * 插件是否提供了自己的设置面板。
   *
   * 「⚙ 设置」按钮对每个插件都显示，但插件不一定写了设置面板。
   * 这里必须显式区分：**不能**靠引擎去挂载兜底 —— SDK 的 settingsFn
   * 缺省时会回退 mainFn（js/plugin-sdk.js:641），结果抽屉里显示的是
   * 插件主界面而不是设置。所以拿不到就干脆不挂，只显示占位提示，
   * 外壳那段（沙箱 / 主题适配开关）照样可用。
   */
  hasPluginSettings?: boolean;
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

    if (hasPluginSettings) {
      (async () => {
        try {
          const fn = await mountSettings(bodyRef.current!, manifest);
          if (!alive) { fn(); return; }        // 挂载完成前就被关掉了
          teardown = fn;
        } catch (e: any) {
          if (alive) setErr(String(e?.message ?? e));
        }
      })();
    }

    return () => {
      alive = false;
      try { teardown?.(); } catch (e) { console.error(e); }
    };
  }, [manifest, mountSettings, hasPluginSettings]);

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
              : !hasPluginSettings
                ? <div className="drawer-empty">
                    「{manifest.name}」没有提供自己的设置面板。
                    <br />
                    下面的沙箱与主题适配由外壳提供，对所有插件都有效。
                  </div>
                : <div className="loader"><div className="spinner" />正在载入设置…</div>}
          </div>
          {/* 下半：外壳固定提供的开关区块 */}
          <SandboxSection manifest={manifest} />
        </div>
      </aside>
    </div>
  );
}
