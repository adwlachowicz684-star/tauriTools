import type { ChainAction } from '../types';

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
  title?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}

export interface RailGroup {
  /** 连锁动作分组的标识，用于空数组时不渲染 */
  key: string;
  actions: RailAction[];
}

export function SideRail({
  groups, chainActions, onChainAction,
}: {
  groups: RailGroup[];
  /** 连锁动作：每个一条，点击即对当前选中卡片执行 */
  chainActions: ChainAction[];
  onChainAction: (a: ChainAction) => void;
}) {
  return (
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
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
