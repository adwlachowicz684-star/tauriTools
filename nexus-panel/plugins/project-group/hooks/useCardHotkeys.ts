import { useEffect, useRef } from 'react';
import type { PluginContext } from '../../../js/plugin-sdk.js';
import type { CardKind } from '../types';
import { effectiveMap, type HotkeyId } from '../utils/hotkeys';

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
  /**
   * 上下键在**当前栏**的卡片间移动选中（原版 NavigateAdjacent）。
   * delta = -1 上一张 / +1 下一张。
   */
  navigate: (delta: number) => void;
  /** F5 刷新 */
  refresh: () => void;
  /** F8 清除无效项 */
  clearInvalid: () => void;
  /** 页签前后翻页：delta = +1 / -1 */
  cycleTab: (kind: CardKind, delta: number) => void;
  /** Ctrl/⌘ + ←/→ 切焦点栏 */
  focus: (kind: CardKind) => void;

  /* ---- 以下 5 条是照原版 ShortcutCatalog 补齐的（#221 #222 #223 #225 #226）---- */
  /** F1 打开/关闭使用说明（ToggleTips） */
  toggleTips: () => void;
  /** F7 一键备份（BackupNow） */
  backupNow: () => void;
  /** Ctrl/⌘ + M 启停 MCP server（ToggleMcp） */
  toggleMcp: () => void;
  /** Shift+~ 展开/收起左操作栏（ToggleSidebar） */
  toggleSidebar: () => void;
  /** Ctrl/⌘ + D 编辑内容区当前选中的文件（OpenMarkdown） */
  openMarkdown: () => void;
}

/**
 * 不受「有弹窗打开」限制的动作。
 *
 * 卡片类动作必须让路：对话框开着时按 Delete，删的是看不见的卡片。
 * 但这三个是**开关**——若也跟着让路，F1 打开说明后就再也关不掉
 * （help 一开，enabled 即 false，F1 自己把自己废了），收起左栏同理。
 * 所以它们只受 isTyping 约束，其余时候始终响应。
 *
 * F7（备份）与 mod+D（编辑）不在此列：前者会开新弹窗、后者要作用于选中项，
 * 都该在已有弹窗时让路，否则会出现弹窗叠弹窗。
 */
const ALWAYS_ON: ReadonlySet<HotkeyId> = new Set<HotkeyId>([
  'toggleTips', 'toggleMcp', 'toggleSidebar',
]);

/** 在输入框 / 文本域里打字时，整组快捷键让路 */
function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || !!el.isContentEditable;
}

/**
 * 焦点是否落在分隔条上（原版是 GridSplitter 独占鼠标，web 里得自己判）。
 *
 * 分隔条 `tabIndex=0`、方向键调宽度。若导航也响应，按一下方向键会
 * **同时**调宽度 + 把选中卡片移走 —— 用户在调布局，却看到选中莫名其妙
 * 跳到别的卡上，而这是他没要求过的改动。必须让路。
 */
function isOnSplitter(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.getAttribute !== 'function') return false;
  return el.getAttribute('role') === 'separator'
    || el.getAttribute('aria-orientation') != null;
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
  /** 自定义键位（动作 id → combo；未包含的走默认） */
  overrides?: Record<string, string> | null,
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
    const bind = (
      combo: string | string[],
      run: (e: KeyboardEvent) => void,
      opts?: { always?: boolean; yieldSplitter?: boolean },
    ) => {
      const off = sc.call(ctx, combo, (e: KeyboardEvent) => {
        // 打字优先：否则在改名框里按 Delete 会把卡片从页签里删掉
        if (isTyping(e.target)) return;
        /*
         * 分隔条聚焦时方向键归它：不排除会"调宽度 + 移动选中"双触发。
         *
         * 只有明确声明 `yieldSplitter` 的那几条才让路 ——
         * Delete / F2 这些在分隔条上按仍然该生效，
         * 让整组都让路会变成"焦点一落到分隔条，快捷键全失灵"。
         */
        if (opts?.yieldSplitter && isOnSplitter(e.target)) return;
        // 有弹窗打开时整组让路，避免半途改到看不见的卡片
        // （开关类动作例外，见 ALWAYS_ON 的说明）
        if (!enabledRef.current && !opts?.always) return;
        run(e);
      });
      if (typeof off === 'function') offs.push(off);
    };

    // 键位来自注册表（可被用户覆盖），动作仍在这里挨个写清楚
    const map = effectiveMap(overrides);
    /**
     * 允许 fn 是异步的（openMarkdown 要读文件、等服务、再写盘）。
     *
     * 返回值统一 void 掉，并**兜底 catch**：异步动作里只要有一处漏了
     * try/catch，rejection 就会变成 unhandled rejection ——
     * 控制台一片红，而用户只看到"按了没反应"。
     * 各函数内部已各自处理错误，这里是最后一道网。
     */
    const run = (id: HotkeyId, fn: () => void | Promise<void>) => {
      const combo = map[id];
      if (!combo) return;      // 空串 = 用户取消了这个绑定
      bind(combo, () => {
        try {
          const r = fn();
          if (r && typeof (r as Promise<void>).catch === 'function') {
            (r as Promise<void>).catch(() => {});
          }
        } catch { /* 内部已各自处理，这里只防漏网 */ }
      }, { always: ALWAYS_ON.has(id) });
    };

    run('open', () => ref.current.open());
    run('lock', () => ref.current.lock());
    run('rename', () => ref.current.rename());
    run('move', () => ref.current.move());
    run('color', () => ref.current.color());
    run('icon', () => ref.current.icon());
    run('remove', () => ref.current.remove());

    /* 上下键导航：裸方向键最容易撞车（分隔条、下拉框），
       所以这两条显式声明自己要让路给分隔条。 */
    bind(map.navUp, () => ref.current.navigate(-1), { yieldSplitter: true });
    bind(map.navDown, () => ref.current.navigate(1), { yieldSplitter: true });
    run('refresh', () => ref.current.refresh());
    run('clearInvalid', () => ref.current.clearInvalid());

    // Tab 组：shift 决定方向。两条分开注册——SDK 要求修饰键精确匹配，
    // 写 'mod+tab' 时 shift 必须没按下，反过来也一样。
    run('cycleGroup', () => ref.current.cycleTab('group', 1));
    run('cycleGroupBack', () => ref.current.cycleTab('group', -1));
    run('cycleProject', () => ref.current.cycleTab('project', 1));
    run('cycleProjectBack', () => ref.current.cycleTab('project', -1));

    // 左右列顺序与界面一致：项目在左，项目组在右
    run('focusProject', () => ref.current.focus('project'));
    run('focusGroup', () => ref.current.focus('group'));

    // 补齐的 5 条（原版 ToggleTips / BackupNow / ToggleMcp / ToggleSidebar / OpenMarkdown）
    run('toggleTips', () => ref.current.toggleTips());
    run('backupNow', () => ref.current.backupNow());
    run('toggleMcp', () => ref.current.toggleMcp());
    run('toggleSidebar', () => ref.current.toggleSidebar());
    run('openMarkdown', () => ref.current.openMarkdown());

    return () => {
      for (const off of offs) {
        try { off(); } catch { /* 已随插件卸载而失效，忽略 */ }
      }
    };
    // overrides 变了要重新注册 —— 否则改完键位得重启才生效
  }, [ctx, overrides]);
}
