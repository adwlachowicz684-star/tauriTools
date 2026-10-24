import { useMemo, useState, type CSSProperties } from 'react';
import { confirm, prompt } from '../../js/dialog.js';
import {
  type TaskBoard, type BoardRow,
  boardRows, visibleIds, lockOf, statusOf, tallyOf, isGroup,
  BOARD_STATUS_LABEL,
} from '../engine/taskBoard';

/**
 * 任务板（左栏）—— 计划态任务的树。
 *
 * ================= 为什么组标题不参与筛选 =================
 *
 * 组只是归类的标题，不是任务本身。
 * 参与筛选的话，搜"登录"会把**挂在登录组下**的所有任务全带出来，
 * 而那些任务的标题里根本没有"登录"—— 筛出来的东西和搜的对不上，
 * 那是最难信任的一类结果（看着像筛选坏了）。
 *
 * 实现上就是 matchesTask 对 group 直接返回 false，
 * 命中的任务再靠 visibleIds 把祖先链补回来，保证不显示孤行。
 *
 * ================= 为什么可以多层 =================
 *
 * 拆分是逐层往下进行的：一个大任务拆成若干子任务，
 * 子任务里某一块仍然太大就再拆。层数不设上限 ——
 * 限三层的话，第四层的拆分就只能"横向拉平"，那不是拆分。
 */

export function BoardTree({
  board,
  expanded,
  onToggle,
  selectedId,
  onSelect,
  checked,
  onCheck,
  kw,
  onKw,
  onAddTask,
  onAddGroup,
  onMerge,
  onSplit,
  onRemove,
  onReload,
  canWrite,
}: {
  board: TaskBoard;
  expanded: Set<string>;
  onToggle: (id: string) => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  checked: Set<string>;
  onCheck: (id: string, on: boolean) => void;
  kw: string;
  onKw: (v: string) => void;
  onAddTask: () => void;
  onAddGroup: () => void;
  onMerge: (ids: string[], title: string) => void;
  onSplit: (id: string, titles: string[]) => void;
  onRemove: (id: string) => void;
  onReload: () => void;
  canWrite: boolean;
}) {
  const [busy, setBusy] = useState(false);

  const keep = useMemo(() => visibleIds(board, kw), [board, kw]);
  const rows = useMemo(() => {
    const all = boardRows(board, expanded);
    return keep ? all.filter((r) => keep.has(r.id)) : all;
  }, [board, expanded, keep]);

  const nChecked = checked.size;

  const runMerge = async () => {
    const ids = [...checked];
    if (ids.length < 2) return;
    const title = await prompt({
      title: '合并为任务组',
      message: `把选中的 ${ids.length} 项放进一个新组，组标题只用于显示。`,
      label: '组标题',
      defaultValue: '新任务组',
      placeholder: '例如：登录模块',
    });
    if (!title) return;
    setBusy(true);
    try { onMerge(ids, title.trim() || '新任务组'); } finally { setBusy(false); }
  };

  const runSplit = async () => {
    if (!selectedId) return;
    const node = board.nodes[selectedId];
    if (!node) return;
    const raw = await prompt({
      title: '拆分为子任务',
      message: isGroup(node)
        ? '这项已经是任务组，输入的内容会作为**新子任务**加进去。'
        : '这项会变成任务组，原来的标题保留为组名。依赖它的任务会自动变成「等这些子任务全部完成」。',
      label: '子任务标题（用分号隔开）',
      placeholder: '设计表结构；写接口；补测试',
      // dialog.js 没有类型声明，回调参数会被推成 any —— 显式标出来
      validate: (v: string) => (
        v.split(/[；;]/).map((s: string) => s.trim()).filter(Boolean).length === 0 ? '至少填一个标题' : null
      ),
    });
    if (!raw) return;
    const titles = raw.split(/[；;]/).map((s: string) => s.trim()).filter(Boolean);
    setBusy(true);
    try { onSplit(selectedId, titles); } finally { setBusy(false); }
  };

  const runRemove = async () => {
    if (!selectedId) return;
    const node = board.nodes[selectedId];
    if (!node) return;
    const sub = isGroup(node) ? `（含组内 ${tallyOf(board, selectedId).total} 个任务）` : '';
    const ok = await confirm({
      title: '删除',
      message: `删除「${node.title}」${sub}？别处对它的前置依赖也会一并摘掉。`,
      okText: '删除',
      danger: true,
    });
    if (!ok) return;
    onRemove(selectedId);
  };

  return (
    <aside className="side-pane">
      <div className="side-head">
        <span>任务板</span>
        <span className="side-head-spacer" />
        <button type="button" className="side-head-btn" onClick={onReload} title="重新读一次文件">
          刷新
        </button>
      </div>

      <div className="bdt-bar">
        <button type="button" className="mini" onClick={onAddTask} disabled={!canWrite}>+ 任务</button>
        <button type="button" className="mini" onClick={onAddGroup} disabled={!canWrite}>+ 组</button>
        <span className="task-grow" />
        <button type="button" className="mini" onClick={() => void runMerge()} disabled={nChecked < 2 || busy}>
          合并
        </button>
        <button type="button" className="mini" onClick={() => void runSplit()} disabled={!selectedId || busy}>
          拆分
        </button>
        <button
          type="button"
          className="mini danger"
          onClick={() => void runRemove()}
          disabled={!selectedId || busy}
        >
          删除
        </button>
      </div>

      <div className="bdt-search">
        <input
          className="p-input"
          value={kw}
          onChange={(e) => onKw(e.target.value)}
          placeholder="搜任务（组标题不参与）"
        />
      </div>

      {!canWrite ? (
        <div className="nx-empty bdt-empty">
          需要设置导出目录才能读写任务板文件。
        </div>
      ) : rows.length === 0 ? (
        <div className="nx-empty bdt-empty">
          {Object.keys(board.nodes).length === 0
            ? '这个任务板还是空的。点「+ 任务」加第一条，AI 也可以直接改文件。'
            : '没有匹配的任务。组标题不参与搜索 —— 换个任务里的词试试。'}
        </div>
      ) : (
        <div className="bdt-scroll">
          {rows.map((row) => (
            <BoardRowView
              key={row.id}
              row={row}
              board={board}
              selected={selectedId === row.id}
              checked={checked.has(row.id)}
              onToggle={onToggle}
              onSelect={onSelect}
              onCheck={onCheck}
            />
          ))}
        </div>
      )}
    </aside>
  );
}

function BoardRowView({
  row, board, selected, checked, onToggle, onSelect, onCheck,
}: {
  row: BoardRow;
  board: TaskBoard;
  selected: boolean;
  checked: boolean;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onCheck: (id: string, on: boolean) => void;
}) {
  const { node, id, depth } = row;
  const group = isGroup(node);
  const st = statusOf(board, id);
  const lock = group ? null : lockOf(board, id);
  const tally = group ? tallyOf(board, id) : null;

  return (
    <div
      className={`bdt-row ${selected ? 'is-active' : ''}`}
      style={{ '--bdt-indent': `${depth * 14}px` } as CSSProperties}
      onClick={() => onSelect(id)}
    >
      <input
        type="checkbox"
        className="bdt-check"
        checked={checked}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => onCheck(id, e.target.checked)}
        title="勾选多项后可合并为任务组"
      />
      <span className="bdt-indent" />
      {row.hasChildren ? (
        <button
          type="button"
          className="bdt-caret"
          onClick={(e) => { e.stopPropagation(); onToggle(id); }}
          title={row.expanded ? '收起' : '展开'}
        >
          {row.expanded ? '▾' : '▸'}
        </button>
      ) : (
        <span className="bdt-caret is-leaf" />
      )}
      {group ? (
        <>
          <span className="bdt-group" title="任务组：只作为显示，不参与筛选">
            {node.title}
          </span>
          {tally ? (
            <span className="bdt-count">
              {tally.done}/{tally.total}
              {tally.locked > 0 ? <span className="bdt-lock"> 锁 {tally.locked}</span> : null}
            </span>
          ) : null}
        </>
      ) : (
        <>
          <span className={`bdt-pill st-${st}`}>{BOARD_STATUS_LABEL[st]}</span>
          <span className="bdt-title">{node.title}</span>
          {lock?.locked ? (
            <span
              className="bdt-badge lock"
              title={lock.cyclic
                ? '前置任务互相依赖成环，永远等不到解锁'
                : `等待 ${lock.pending.length} 个前置任务完成`}
            >
              未解锁
            </span>
          ) : null}
          {node.kind === 'task' && node.assignee ? (
            <span className="bdt-badge who">{node.assignee}</span>
          ) : null}
        </>
      )}
    </div>
  );
}
