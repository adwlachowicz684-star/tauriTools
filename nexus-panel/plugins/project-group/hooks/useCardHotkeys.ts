import { useEffect, useRef } from 'react';
import type { PluginContext } from '../../../js/plugin-sdk.js';
import type { CardKind } from '../types';

/**
 * `ctx.shortcut` 没写进 `js/plugin-sdk.d.ts`（那份 d.ts 在插件目录之外，
 * 本轮不往外改），这里补一个最小签名，免得为调它去动宿主类型。
 * 签名与 `js/plugin-sdk.js` 的实现一致。
 *
 * 为什么用它而不是自己 `window.addEventListener('keydown')`：
 * iframe 模式下它把监听挂在插件自己的 window 上（浏览器按焦点隔离，
 * 切到别的插件自然收不到），且插件卸载时自动注销，不会残留。
 */
type ShortcutCapable = {
  shortcut?: (
    combo: string | string[],
    handler: (e: KeyboardEvent) => void,
    opts?: { preventDefault?: boolean },
  ) => () => void;
};

export interface HotkeyActions {
  /** Ctrl/⌘ + O 打开文件夹 */
  open: () => void;
  /** Ctrl/⌘ + L ACL 保护 */
  lock: () => void;
  /** F2 改名 */
  rename: () => void;
  /** F3 转为另一类别（换栏，可能物理搬家） */
  move: () => void;
  /** F4 图标与标签色 */
  color: () => void;
  /** F6 改图标 */
  icon: () => void;
  /** Delete 从当前页签移除 */
  remove: () => void;
  /** F5 刷新 */
  refresh: () => void;
  /** F8 清除无效项 */
  clearInvalid: () => void;
  /** 页签前后翻页：delta = +1 / -1 */
  cycleTab: (kind: CardKind, delta: number) => void;
  /** Ctrl/⌘ + ←/→ 切焦点栏 */
  focus: (kind: CardKind) => void;
}

/** 在输入框 / 文本域里打字时，整组快捷键让路 */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable;
}

/**
 * 卡片与页签的键盘操作。
 *
 * 键位与 README 的承诺一一对应：
 *   Ctrl/⌘+O 打开 · Ctrl/⌘+L 锁定 · F2 改名 · F3 搬家 · F4 改色 · F6 改图标 · Delete 移除
 *   Ctrl/⌘+Tab / +Shift+Tab 项目组页签 · Ctrl/⌘+PageDown/PageUp 项目页签 · Ctrl/⌘+←/→ 切焦点栏
 *   另加工具栏上标着的 F5 刷新、F8 清除无效项。
 *
 * `mod` 由 SDK 解析：macOS 是 ⌘，其它平台是 Ctrl。
 */
export function useCardHotkeys(
  ctx: PluginContext,
  actions: HotkeyActions,
  enabled: boolean,
) {
  // 动作与开关都走 ref：不让每次渲染重建的回调把注册副作用反复解绑重绑
  // （与连锁动作那边的 selRef 同一个道理）。
  const ref = useRef(actions);
  ref.current = actions;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    const sc = (ctx as unknown as ShortcutCapable).shortcut;
    if (typeof sc !== 'function') return;

    const offs: Array<() => void> = [];
    const bind = (combo: string | string[], run: (e: KeyboardEvent) => void) => {
      const off = sc.call(ctx, combo, (e: KeyboardEvent) => {
        // 打字优先：否则在改名框里按 Delete 会把卡片从页签里删掉
        if (isTyping(e.target)) return;
        // 有弹窗打开时整组让路，避免半途改到看不见的卡片
        if (!enabledRef.current) return;
        run(e);
      });
      if (typeof off === 'function') offs.push(off);
    };

    bind('mod+o', () => ref.current.open());
    bind('mod+l', () => ref.current.lock());
    bind('f2', () => ref.current.rename());
    bind('f3', () => ref.current.move());
    bind('f4', () => ref.current.color());
    bind('f6', () => ref.current.icon());
    bind('delete', () => ref.current.remove());
    bind('f5', () => ref.current.refresh());
    bind('f8', () => ref.current.clearInvalid());

    // Tab 组：shift 决定方向。两条分开注册——SDK 要求修饰键精确匹配，
    // 写 'mod+tab' 时 shift 必须没按下，反过来也一样。
    bind('mod+tab', () => ref.current.cycleTab('group', 1));
    bind('mod+shift+tab', () => ref.current.cycleTab('group', -1));
    bind('mod+pagedown', () => ref.current.cycleTab('project', 1));
    bind('mod+pageup', () => ref.current.cycleTab('project', -1));

    // 左右列顺序与界面一致：项目在左，项目组在右
    bind('mod+arrowleft', () => ref.current.focus('project'));
    bind('mod+arrowright', () => ref.current.focus('group'));

    return () => {
      for (const off of offs) {
        try { off(); } catch { /* 已随插件卸载而失效，忽略 */ }
      }
    };
  }, [ctx]);
}
