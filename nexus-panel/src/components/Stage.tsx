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
  /**
   * 当前是否有激活插件。
   *
   * 「⚙ 设置」对**每个**插件都显示，不再要求插件自己提供设置面板 ——
   * 抽屉里除了插件自定义设置，还有外壳固定提供的那一段（沙箱隔离、
   * 主题适配开关），这两项对任何插件都有实际意义，所以点开永远有内容。
   */
  hasPlugin?: boolean;
  onOpenSettings?: () => void;
  onReload: () => void;
}>(({ title, subtitle, hasPlugin, onOpenSettings, onReload }, ref) => (
  <main id="main">
    <div id="main-inner">
      <div id="plugin-bar">
        <h1>{title}</h1>
        <span className="sub">{subtitle}</span>
        <div className="bar-actions">
          {hasPlugin ? (
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
