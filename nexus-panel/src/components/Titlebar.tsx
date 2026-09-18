import { useRef } from 'react';
import { openThemePicker } from '../../js/theme-picker.js';

export type WinAction = 'minimize' | 'maximize' | 'close' | 'topmost' | 'hide';

export default function Titlebar({
  title,
  onWin,
  onToast,
  closeAction = 'hide',
}: {
  title: string;
  onWin: (a: WinAction) => void;
  /** 切换主题后弹提示（可选） */
  onToast?: (msg: string, type?: string) => void;
  /** ✕ 的行为：'hide' 藏到托盘 / 'close' 真正退出。由设置决定，默认藏 */
  closeAction?: 'hide' | 'close';
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

  /*
   * 标题栏拖拽 —— 与 index.html（原生外壳）**必须保持一致**。
   *
   * ="deep"：整个子树都能拖。裸属性只有点击目标本身才拖，
   * 点在 logo / 品牌文字 / 标题这些子元素上会失效。
   * 按钮不用额外标 ="false"：drag.js 自动跳过可点击元素。
   *
   * 两个外壳同一套写法，改一处就要改另一处 —— 否则会出现
   * "这个外壳能拖、那个不能"，很难往这方面想。
   */
  return (
    <header id="titlebar" data-tauri-drag-region="deep">
      <div className="tb-brand">
        <div className="tb-logo">◈</div>
        <span>Nexus Panel</span>
      </div>
      <span className="tb-title">{title}</span>
      <div className="tb-spacer" />
      <div className="tb-btns">
        <button
          ref={themeBtn}
          className="tb-btn"
          title="切换主题（缩略图选择）"
          onClick={openPicker}
        >◐</button>
        <button className="tb-btn" title="窗口置顶" onClick={() => onWin('topmost')}>⇱</button>
        {/* 隐藏到托盘：与 Ctrl+~ 同一个动作。放在置顶与最小化之间，
            ✕ 单独留最右 —— 它是"可能退出"的那个，不该和常规操作混在一起。 */}
        <button
          className="tb-btn"
          title="隐藏到托盘（点托盘图标唤回）"
          onClick={() => onWin('hide')}
        >⇲</button>
        <button className="tb-btn" title="最小化" onClick={() => onWin('minimize')}>─</button>
        <button className="tb-btn" title="最大化" onClick={() => onWin('maximize')}>□</button>
        {/* ✕ 的文案跟着设置走：用户得能从按钮本身看出点下去会发生什么，
            不能让"关闭"既可能是隐藏也可能是退出。 */}
        <button
          className="tb-btn danger"
          title={closeAction === 'hide' ? '隐藏到托盘' : '退出'}
          onClick={() => onWin(closeAction === 'hide' ? 'hide' : 'close')}
        >✕</button>
      </div>
    </header>
  );
}
