type WinAction = 'minimize' | 'maximize' | 'close' | 'topmost';

export default function Titlebar({
  title,
  onWin,
}: {
  title: string;
  onWin: (a: WinAction) => void;
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
        <button className="tb-btn" title="窗口置顶" onClick={() => onWin('topmost')}>⇱</button>
        <button className="tb-btn" title="最小化" onClick={() => onWin('minimize')}>─</button>
        <button className="tb-btn" title="最大化" onClick={() => onWin('maximize')}>□</button>
        <button className="tb-btn danger" title="关闭" onClick={() => onWin('close')}>✕</button>
      </div>
    </header>
  );
}
