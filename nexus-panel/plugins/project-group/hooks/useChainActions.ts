import { useCallback, useEffect, useRef } from 'react';
import type { PluginContext } from '../../../js/plugin-sdk.js';
import { errText } from '../api';
import { needConfirm } from '../utils/confirmOnce';
import { chainShortcutWinners } from '../utils/hotkeys';
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
  /**
   * 内置键位的覆盖表（`config.hotkeys`）。
   *
   * 判断连锁动作的键有没有和内置键位撞车**必须**看它：用户把「改名」改成
   * Ctrl+R 之后，默认的 F2 就已经让出来了 —— 不看覆盖表会把一个**合法**的
   * 键位判成冲突，等于凭空砍掉用户刚设好的快捷键。
   */
  hotkeyOverrides?: Record<string, string> | null;
  /** 待确认发送（#43）：预览成功后挂起，由 App 渲染确认框 */
  /*
   * `client` 由预览从后端带回（动作专属 → 全局默认 → opencode）。
   * 这一份类型此前漏了它，而 `DialogsHub` 的 `PendingSend` 有 ——
   * 同一件事两份声明，照着这份改的人会以为 PendingSend 没有 client 字段。
   */
  setPendingSend: (p: {
    actionId: string; kind: CardKind; path: string; text: string; client: string; skip: boolean;
  } | null) => void;
}

/** #207 同一目标 + 同一动作的重复触发间隔（毫秒） */
const SEND_DEBOUNCE_MS = 400;

export function useChainActions({
  ctx, s, chainActions, bootReady, hotkeyOverrides = null, setPendingSend,
}: UseChainActionsArgs) {
  /** #207 上一次真正发出去的时间戳，键为「动作 id + 目标路径」 */
  const lastSentAt = useRef<Map<string, number>>(new Map());

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

  /*
   * 覆盖表按**值**进依赖，不按对象身份。
   *
   * `config.hotkeys` 每次快照都是新对象（boot 是新对象，它的字段也是），
   * 直接进依赖的话，任何一次写操作都会让整批快捷键与侧边栏拆了重装 ——
   * 侧边栏闪烁、焦点丢失，且用户完全不知道自己触发了什么。
   * 序列化成字符串后比较的是内容，内容没变就不重跑。
   */
  const overrideKey = JSON.stringify(hotkeyOverrides ?? {});

  useEffect(() => {
    if (!bootReady) return;
    const unsubs: Array<() => void> = [];
    const registered: string[] = [];
    const sidebarIds: string[] = [];

    /*
     * 同一个键只注册**一个**（清单里靠前的那个）。
     *
     * 外壳那张 accel→event 表是一键一值：两个动作设成同一个键时，
     * 后注册的覆盖先注册的，**先那个动作的快捷键就此失效**，
     * 而侧边栏与右键菜单上**两个都照样显示键位**。
     * 用户按下去没反应，界面上却明明白白写着这个键 ——
     * 他只会以为"快捷键这个功能坏了"。
     *
     * 这里不"都注册、让外壳挑一个"：那样谁生效取决于注册顺序，
     * 而顺序在别处（清单来自后端，用户可能刚拖过顺序），
     * 于是同一个配置在不同时候表现不同。
     *
     * 与内置键位撞车的也一并跳过：外壳层与插件层谁先抢到不确定，
     * 表现是"按 F2 有时改名、有时拉起一个 AI 进程"——那比失效更糟。
     * 两种跳过都要**说出来**（见下面的日志），不能静默。
     */
    const { winners } = chainShortcutWinners(chainActions, hotkeyOverrides);
    for (const a of chainActions) {
      if (a.shortcut && a.shortcut.trim()) {
        if (winners.has(a.id)) {
          ctx.registerShortcut(a.shortcut.trim(), shortcutEvent(a.id), a.name);
          registered.push(a.shortcut.trim());
        }
      }
      if (a.showSidebar) {
        ctx.addSidebarItem({
          id: a.id, label: a.name, icon: a.icon || '▶', event: sidebarEvent(a.id),
        });
        sidebarIds.push(a.id);
      }
    }

    /*
     * 被跳过的键位必须**说出来**，而且要一次性说完。
     *
     * 不说的话，被砍掉的那个动作在界面上仍显示着键位、按下去毫无反应 ——
     * 用户没有任何线索能把它归到"键位撞车"，只会以为快捷键坏了。
     *
     * 用日志而不是 toast：注册副作用在每次清单变化后都会重跑，
     * 弹 toast 会在用户改一个无关字段时反复跳出来，反而变成噪音。
     */
    const skipped = chainActions.filter((a) => a.shortcut && a.shortcut.trim() && !winners.has(a.id));
    if (skipped.length > 0) {
      const detail = skipped
        .map((a) => `「${a.name}」${a.shortcut!.trim()}`)
        .join('、');
      s.pushLog(`以下连锁动作的快捷键未注册（键位冲突或重复）：${detail}。请在「连锁动作」里改一个键。`, true);
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
  }, [bootReady, chainActions, ctx, overrideKey]);

  /**
   * 直接按动作发送（右键菜单用），失败记日志 + toast
   *
   * #207 同一「动作 + 目标」400ms 内的重复触发会被丢弃。
   * 为什么要它：
   *   · 右键菜单连点、快捷键按住不放都会连发 —— 一次发送就可能拉起
   *     一个外部 AI 进程，连发几个就是几个进程一起跑；
   *   · 更常见的是双击：菜单项点两下在界面上毫无区别（没有计数反馈），
   *     用户不知道自己发重了，事后看到两份结果只会以为软件有问题。
   *
   * 只按「动作 + 目标」去重，不按动作：对 A 发完立刻对 B 发是正常操作，
   * 不能拦。
   */
  const sendAction = async (
    actionId: string, kind: CardKind, path: string,
    /** 确认框里编辑后的最终文本；不给就用后端模板原文 */
    prompt?: string | null,
  ) => {
    const key = `${actionId}\u0000${kind}\u0000${path}`;
    const now = Date.now();
    const prev = lastSentAt.current.get(key);
    if (prev !== undefined && now - prev < SEND_DEBOUNCE_MS) {
      /* 丢弃而不是排队：用户想的是"发一次"，不是"待会儿再发一次" */
      return;
    }
    lastSentAt.current.set(key, now);
    try {
      const r = await s.api.chainSendAction(actionId, kind, path, prompt ?? null);
      s.pushLog(r.message, !r.ok);
      ctx.toast(r.message, r.ok ? 'ok' : 'err');
      /*
       * `ok: false` 同样是失败，也必须清掉时间戳（理由见下面 catch）。
       *
       * 只清 catch 那一支是不够的——**这正是用户会看到失败提示、
       * 最可能立刻重试的那一支**：命令正常返回了，只是没发出去，
       * 于是他再点一次，被 400ms 防抖**静默丢弃**，
       * 表现为"重试毫无反应"（比连发更让人困惑，见下）。
       */
      if (!r.ok) lastSentAt.current.delete(key);
    } catch (e) {
      const msg = `发送失败：${String((e as Error)?.message ?? e)}`;
      s.pushLog(msg, true);
      ctx.toast(msg, 'err');
      /* 失败要**清掉**时间戳：用户看到失败后多半立刻重试，
         若被防抖拦掉，表现为"再点一次什么都没发生" ——
         那比连发更让人困惑（他会以为重试没生效、继续点，最后干脆放弃）。 */
      lastSentAt.current.delete(key);
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
      const r = await s.api.chainPreview(actionId, kind, path);
      /*
       * `r.client` 是后端按「动作专属 → 全局默认 → opencode」解析出来的
       * **实际会用的**客户端。
       *
       * 不能在这里自己算（此前弹窗里写的就是 `config.chainClient || 'opencode'`）：
       * 少算「动作专属」那层的话，给动作配了自己的客户端时，
       * 弹窗显示全局默认、发出去的却是动作专属的另一个进程 ——
       * 用户会以为软件串了。
       */
      setPendingSend({ actionId, kind, path, text: r.text, client: r.client, skip: false });
    } catch (e) {
      /*
       * 预览失败 → **不发**，把原因原样告诉用户。
       *
       * 此前这里是"预览失败就直接发送"，理由是"这两个入口没有别的编辑途径，
       * 卡住就没法用了"。但把失败原因逐条对一遍就知道，那个理由不成立：
       * 预览会失败的原因（数据目录取不到、动作不存在、路径不在允许范围内、
       * 模板为空）**在发送侧同样会失败** —— `sendAction` 只是把同一个错误
       * 再报一遍。也就是说"直接发送"救不了任何一场，它唯一的实际效果是
       * **跳过了确认**，外加多一条「指令预览失败，直接发送」的日志。
       *
       * 而确认恰恰是这两个入口存在的理由（见本函数的文档注释）：
       * 失败时跳过确认，等于把唯一会拦住误发的那道门开在**最容易误触**的入口上。
       */
      const msg = `指令预览失败，已取消发送：${errText(e)}`;
      s.pushLog(msg, true);
      ctx.toast(msg, 'err');
    }
  }, [s]);
  return { runActionOnSelection, sendAction, requestSendAction };
}
