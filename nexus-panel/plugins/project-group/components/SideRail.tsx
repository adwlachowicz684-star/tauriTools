import type { ChainAction } from '../types';
import { effectiveCombo, formatCombo, type HotkeyId } from '../utils/hotkeys';

/**
 * 左侧操作栏：图标在上、文字在下，宽度固定（不随文字长度变化）。
 *
 * 对照 WPF 原版 SidebarControl —— 那里是窄图标条 + 悬停浮出名称浮层。
 * 这里按用户要求把文字直接放到图标下方：一眼看清全部操作，不用悬停试探，
 * 且栏宽固定 72px，不挤压三栏。
 *
 * 分组规则沿用原版：常规操作 → 选中项操作 → 连锁动作 → 危险操作（置底）。
 */
export interface RailAction {
  /** 图标（emoji 或字形） */
  icon: string;
  /** 图标下方文字，控制在 4 字内 */
  label: string;
  /**
   * 键位提示，直接显示在按钮上（对应原版 ShowShortcuts）。
   * 用 `mod` 代指 Ctrl / ⌘，渲染时按平台替换——写死任一个都会让另一半用户看错。
   * 只给"真的绑了键"的项，没有就不显示，不拿灰字占位。
   */
  hotkey?: string;
  /**
   * 键位对应的**动作 id**（优先于 `hotkey` 字面量）。
   * 走注册表解析，用户改了键位这里也跟着变；`hotkey` 只给没有对应动作的场景用。
   */
  hotkeyId?: string;
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

/** `mod` → ⌘（mac）或 Ctrl（其它平台）。 */
const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/** 左栏两种显示模式（#58）。 */
export type RailMode = 'persistent' | 'hover';

export interface RailGroup {
  /** 连锁动作分组的标识，用于空数组时不渲染 */
  key: string;
  actions: RailAction[];
}

export function SideRail({
  groups, chainActions, onChainAction, hotkeys, collapsed, onToggleCollapsed,
  mode, onModeChange,
}: {
  groups: RailGroup[];
  /** 连锁动作：每个一条，点击即对当前选中卡片执行 */
  chainActions: ChainAction[];
  onChainAction: (a: ChainAction) => void;
  /** 用户自定义键位（动作 id → combo） */
  hotkeys?: Record<string, string> | null;
  /** 收起态（#58 #225）：只留一条窄条与展开按钮 */
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  /**
   * #58 两种模式：
   *   · `persistent` 常驻 —— 文字一直显示（栏宽随内容）
   *   · `hover` 悬停浮出 —— **图标条始终窄宽**，悬停/聚焦时才浮出全宽面板
   *
   * 浮出必须**覆盖**而不是挤开：栏宽若跟着悬停变化，三栏会被推着左右跳，
   * 而且会和布局记忆（colStars）打架。所以外层 slot 固定窄宽，
   * 内层栏正常在流内（这样高度还是它自己的），悬停时宽度溢出到 slot 之外。
   */
  mode?: RailMode;
  onModeChange?: () => void;
}) {
  /** 动作 id → 生效键位；没绑（空串）就不显示 */
  const keyOf = (a: RailAction): string => {
    const raw = a.hotkeyId ? effectiveCombo(a.hotkeyId as HotkeyId, hotkeys) : a.hotkey;
    if (!raw) return '';
    return formatCombo(raw, IS_MAC);
  };

  /* 收起态：栏还在，只是窄成一条，并保留唯一的"展开"入口。
     不做成彻底隐藏 —— 那样 Shift+~ 收起之后就没有任何可见的回头路，
     用户只能靠记得这个快捷键才能找回来。 */
  if (collapsed) {
    return (
      /* slot 在收起态也要有：它是 flex 子项，宽度由它决定，
         直接让 rail 当 flex 子项会随内容变宽，与悬停态宽度不一致 */
      <div className="fpx-rail-slot">
        <div className="fpx-rail collapsed">
          <button
            className="fpx-rail-btn"
            title="展开左操作栏（Shift+~）"
            onClick={onToggleCollapsed}
          >
            <span className="fpx-rail-icon">»</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`fpx-rail-slot${mode === 'hover' ? ' hover-mode' : ''}`}>
      <div className="fpx-rail">
        {groups.map((g) => (
          <div className="fpx-rail-group" key={g.key}>
            {g.actions.map((a) => (
              <button
                key={a.label}
                className={`fpx-rail-btn${a.danger ? ' danger' : ''}`}
                title={a.title ?? a.label}
                disabled={a.disabled}
                onClick={a.onClick}
              >
                <span className="fpx-rail-icon">{a.icon}</span>
                <span className="fpx-rail-label">{a.label}</span>
                {keyOf(a) && (
                  <span className="fpx-rail-key">{keyOf(a)}</span>
                )}
              </button>
            ))}
          </div>
        ))}

        {chainActions.length > 0 && (
          <div className="fpx-rail-group">
            {chainActions.map((a) => (
              <button
                key={a.id}
                className="fpx-rail-btn"
                title={`${a.name}（对当前选中的卡片执行）`}
                onClick={() => onChainAction(a)}
              >
                <span className="fpx-rail-icon">{a.icon || '▶'}</span>
                <span className="fpx-rail-label">{a.name}</span>
                {a.shortcut && (
                  <span className="fpx-rail-key">{a.shortcut.replace('mod', MOD)}</span>
                )}
              </button>
            ))}
          </div>
        )}

        {/* 收起入口置底：与"展开"成对，避免收起后没有回头路 */}
        <div className="fpx-rail-group">
          <button
            className="fpx-rail-btn"
            title="收起左操作栏（Shift+~）"
            onClick={onToggleCollapsed}
          >
            <span className="fpx-rail-icon">«</span>
          </button>
          {/*
            模式切换（#58）。放在置底这一组、与「收起」并列：
            两个入口都管"左栏占多少地方"，分开找会很烦。

            必须给 title：悬停模式下文字是隐藏的，
            不给提示就只剩一个看不懂的图标，等于没有这个功能。
          */}
          {onModeChange && (
            <button
              className="fpx-rail-btn"
              title={mode === 'hover'
                ? '左栏改为常驻（文字一直显示）'
                : '左栏改为悬停浮出（图标条始终窄宽）'}
              onClick={onModeChange}
            >
              <span className="fpx-rail-icon">{mode === 'hover' ? '⇥' : '⇤'}</span>
              <span className="fpx-rail-label">{mode === 'hover' ? '常驻' : '悬停'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
