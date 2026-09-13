import { forwardRef } from 'react';

/**
 * 插件舞台
 * ------------------------------------------------------------
 * 内部这个 div 由插件宿主引擎接管（iframe 插件会插入 <iframe>，
 * 同页插件会插入挂载容器），所以这里不用 React 渲染它的子节点。
 */
const Stage = forwardRef<HTMLDivElement, {
  title: string;
  subtitle: string;
  /** 可选：老调用方可能还没接上插件设置面板 */
  hasSettings?: boolean;
  onOpenSettings?: () => void;
  onReload: () => void;
}>(({ title, subtitle, hasSettings, onOpenSettings, onReload }, ref) => (
  <main id="main">
    <div id="main-inner">
      <div id="plugin-bar">
        <h1>{title}</h1>
        <span className="sub">{subtitle}</span>
        <div className="bar-actions">
          {hasSettings ? (
            <button className="bar-btn" onClick={onOpenSettings} title="插件设置（⌘/Ctrl + ,）">
              ⚙ 设置
            </button>
          ) : null}
          <button className="bar-btn" onClick={onReload} title="重新加载插件">↻ 重载</button>
        </div>
      </div>
      <div id="stage">
        <div id="stage-scroll" ref={ref} />
      </div>
    </div>
  </main>
));

Stage.displayName = 'Stage';
export default Stage;
