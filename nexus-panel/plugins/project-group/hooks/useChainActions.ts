import { useCallback, useEffect, useRef } from 'react';
import type { PluginContext } from '../../../js/plugin-sdk.js';
import { errText } from '../api';
import { needConfirm } from '../utils/confirmOnce';
import type { FpxStore } from './useFpx';
import type { CardKind, ChainAction } from '../types';

/**
 * 连锁动作的**外壳接线**——快捷键 + 侧边栏。
 *
 * 两者都属于外壳能力：插件只能「注册 + 监听事件」，不能直接画到外壳上。
 * 这段原本写在 App 里（约 93 行），但它与卡片、布局、日志都无关，
 * 只是"把动作清单注册到外壳、把事件转回发送"这一件事。
 * 抽出来之后 App 少一整块，而这段自己也不必再跟 400 行 JSX 挤在一起。
 *
 * 返回值里三个入口的区别（容易搞混，故在此写明）：
 *   · `runActionOnSelection` —— 作用于**当前选中的卡片**（快捷键 / 侧边栏用）
 *   · `sendAction`           —— 直接发给指定路径（右键菜单用，跳过确认）
 *   · `requestSendAction`    —— 先弹确认再发（侧边栏 / 快捷键用，#43）
 */

export interface UseChainActionsArgs {
  ctx: PluginContext;
  s: FpxStore;
  /** 动作清单。变化时先撤再注册，避免残留指向已删除动作的条目 */
  chainActions: ChainAction[];
  /** boot 是否就绪——未就绪时整个注册副作用都不跑 */
  bootReady: boolean;
  /** 待确认发送（#43）：预览成功后挂起，由 App 渲染确认框 */
  setPendingSend: (p: {
    actionId: string; kind: CardKind; path: string; text: string; skip: boolean;
  } | null) => void;
}

export function useChainActions({
  ctx, s, chainActions, bootReady, setPendingSend,
}: UseChainActionsArgs) {

  /** 事件名：动作 id → 事件名。两处必须一致，否则注册了却收不到。 */
  const shortcutEvent = (id: string) => `fpx:chain:${id}`;
  const sidebarEvent = (id: string) => `fpx:sidebar:${id}`;

  /**
   * 当前选中项用 ref 传给事件处理，而不是直接进 useEffect 依赖。
   * 否则每点一张卡片都会重跑注册副作用：侧边栏被整体重建（闪烁、丢焦点），
   * 快捷键也要反复注销再注册。
   */
  const selRef = useRef<{ path: string; kind: CardKind } | null>(null);
  selRef.current = s.selProject
    ? { path: s.selProject, kind: 'project' }
    : s.selGroup ? { path: s.selGroup, kind: 'group' } : null;

  /** 对当前选中的卡片执行连锁动作；没选中就提示 */
  const runActionOnSelection = (a: ChainAction) => {
    const sel = selRef.current;
    if (!sel) {
      ctx.toast(`「${a.name}」需要选中一个项目或项目组`, 'err');
      return;
    }
    void requestSendAction(a.id, sel.kind, sel.path);
  };

  useEffect(() => {
    if (!bootReady) return;
    const unsubs: Array<() => void> = [];
    const registered: string[] = [];
    const sidebarIds: string[] = [];

    for (const a of chainActions) {
      if (a.shortcut && a.shortcut.trim()) {
        ctx.registerShortcut(a.shortcut.trim(), shortcutEvent(a.id), a.name);
        registered.push(a.shortcut.trim());
      }
      if (a.showSidebar) {
        ctx.addSidebarItem({
          id: a.id, label: a.name, icon: a.icon || '▶', event: sidebarEvent(a.id),
        });
        sidebarIds.push(a.id);
      }
    }

    // 两类事件都指向同一个处理：对当前选中的卡片执行该动作
    for (const a of chainActions) {
      unsubs.push(ctx.on(shortcutEvent(a.id), () => runActionOnSelection(a)));
      unsubs.push(ctx.on(sidebarEvent(a.id), () => runActionOnSelection(a)));
    }

    return () => {
      for (const u of unsubs) { try { u(); } catch { /* 忽略已失效的订阅 */ } }
      for (const acc of registered) ctx.unregisterShortcut(acc);
      for (const id of sidebarIds) ctx.removeSidebarItem(id);
    };
    // 只在动作清单变化时重建；选中项走 selRef，不进依赖。
    // 这里同样不能放 boot：它每次快照都是新对象，会让侧边栏与快捷键
    // 在所有写操作后被反复拆装（见上面 refreshChainActions 的注释）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootReady, chainActions, ctx]);

  /** 直接按动作发送（右键菜单用），失败记日志 + toast */
  const sendAction = async (actionId: string, kind: CardKind, path: string) => {
    try {
      const r = await s.api.chainSendAction(actionId, kind, path);
      s.pushLog(r.message, !r.ok);
      ctx.toast(r.message, r.ok ? 'ok' : 'err');
    } catch (e) {
      const msg = `发送失败：${String((e as Error)?.message ?? e)}`;
      s.pushLog(msg, true);
      ctx.toast(msg, 'err');
    }
  };

  /**
   * 侧边栏 / 快捷键入口：先弹确认（#43）。
   *
   * 这两个入口比面板更"顺手"——一键就发出去了，也更容易误触，
   * 所以反而**更需要**确认。若只在面板里确认，用户从侧边栏发就完全绕过了。
   */
  const requestSendAction = useCallback(async (actionId: string, kind: CardKind, path: string) => {
    if (!needConfirm()) { void sendAction(actionId, kind, path); return; }
    try {
      const text = await s.api.chainPreview(actionId, kind, path);
      setPendingSend({ actionId, kind, path, text, skip: false });
    } catch (e) {
      // 预览失败不拦发送：这两个入口没有别的编辑途径，卡住就没法用了
      s.pushLog(`指令预览失败，直接发送：${errText(e)}`, true);
      void sendAction(actionId, kind, path);
    }
  }, [s]);
  return { runActionOnSelection, sendAction, requestSendAction };
}
