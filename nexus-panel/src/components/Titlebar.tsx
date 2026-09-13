type WinAction = 'minimize' | 'maximize' | 'close' | 'topmost';

export default function Titlebar({
  title,
  onWin,
  themeName,
  onCycleTheme,
}: {
  title: string;
  onWin: (a: WinAction) => void;
  /** 当前主题名（可选：老调用方不传时就不显示） */
  themeName?: string;
  /** 点击主题名切换主题（可选） */
  onCycleTheme?: () => void;
}) {
  return (
    <header id="titlebar" data-tauri-drag-region>
      <div className="tb-brand" data-tauri-drag-region>
        <div className="tb-logo">◈</div>
        <span>Nexus Panel</span>
      </div>
      <span className="tb-title">{title}</span>
      {themeName && onCycleTheme ? (
        <button className="tb-theme" onClick={onCycleTheme} title="切换主题">
          {themeName}
        </button>
      ) : null}
      <div className="tb-spacer" data-tauri-drag-region />
      <div className="tb-btns">
        <button className="tb-btn" title="窗口置顶" onClick={() => onWin('topmost')}>⇱</button>
        <button className="tb-btn" title="最小化" onClick={() => onWin('minimize')}>─</button>
        <button className="tb-btn" title="最大化" onClick={() => onWin('maximize')}>□</button>
        <button className="tb-btn danger" title="关闭" onClick={() => onWin('close')}>✕</button>
      </div>
    </header>
  );
}
