type WinAction = 'minimize' | 'maximize' | 'close' | 'topmost';

export default function Titlebar({
  title,
  themeName,
  onWin,
  onCycleTheme,
}: {
  title: string;
  /** 当前主题名，显示在按钮提示里 */
  themeName?: string;
  onWin: (a: WinAction) => void;
  /** 点击循环切换到下一个主题 */
  onCycleTheme?: () => void;
}) {
  return (
    <header id="titlebar" data-tauri-drag-region>
      <div className="tb-brand" data-tauri-drag-region>
        <div className="tb-logo">◈</div>
        <span>Nexus Panel</span>
      </div>
      <span className="tb-title">{title}</span>
      <div className="tb-spacer" data-tauri-drag-region />
      <div className="tb-btns">
        <button
          className="tb-btn"
          title={`切换主题（当前：${themeName || '默认' }）`}
          onClick={onCycleTheme}
        >◐</button>
        <button className="tb-btn" title="窗口置顶" onClick={() => onWin('topmost')}>⇱</button>
        <button className="tb-btn" title="最小化" onClick={() => onWin('minimize')}>─</button>
        <button className="tb-btn" title="最大化" onClick={() => onWin('maximize')}>□</button>
        <button className="tb-btn danger" title="关闭" onClick={() => onWin('close')}>✕</button>
      </div>
    </header>
  );
}
