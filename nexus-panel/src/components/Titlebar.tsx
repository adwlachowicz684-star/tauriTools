import { useRef } from 'react';
import { openThemePicker } from '../../js/theme-picker.js';

type WinAction = 'minimize' | 'maximize' | 'close' | 'topmost';

export default function Titlebar({
  title,
  onWin,
  onToast,
}: {
  title: string;
  onWin: (a: WinAction) => void;
  /** 切换主题后弹提示（可选） */
  onToast?: (msg: string, type?: string) => void;
}) {
  const themeBtn = useRef<HTMLButtonElement>(null);

  // 右上角这个按钮只负责"打开选择器"，具体渲染在 js/theme-picker.js 里，
  // 与无构建模式共用同一份实现 —— 两边行为一致，不用维护两套。
  const openPicker = () => {
    const anchor = themeBtn.current;
    if (!anchor) return;
    openThemePicker({
      anchor,
      onPick: (t) => { if (t) onToast?.(`已切换到「${t.name}」`, 'ok'); },
    });
  };

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
          ref={themeBtn}
          className="tb-btn"
          title="切换主题（缩略图选择）"
          onClick={openPicker}
        >◐</button>
        <button className="tb-btn" title="窗口置顶" onClick={() => onWin('topmost')}>⇱</button>
        <button className="tb-btn" title="最小化" onClick={() => onWin('minimize')}>─</button>
        <button className="tb-btn" title="最大化" onClick={() => onWin('maximize')}>□</button>
        <button className="tb-btn danger" title="关闭" onClick={() => onWin('close')}>✕</button>
      </div>
    </header>
  );
}
