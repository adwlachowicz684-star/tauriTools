import { useEffect, useMemo, useState } from 'react';
import { confirm } from '../../../js/dialog.js';
import { isComposing } from '../../../js/ime.js';
import {
  type TaskBoard, type BoardStatus, type BoardTask,
  isGroup, isTask, lockOf, statusOf, tallyOf, leafTaskIds,
  setTaskStatus, claimTask, renameNode,
} from '../engine/taskBoard';
import { type BoardMeta, statusName, statusColor } from '../engine/boardMeta';

/**
 * 任务板详情（中间栏）。
 *
 * ================= 为什么领取/标记要弹确认 =================
 *
 * 被前置任务卡住时**不硬挡**，但必须让人（或 AI 的调用方）看见：
 * 硬挡会逼人去改依赖、改完还得改回来；完全不提示则会让 AI
 * 领走一个上游还没定稿的任务，做完才发现要返工。
 *
 * 所以引擎返回 warnings，这里在有 warning 时弹一次确认 ——
 * 看得见、能继续，但不会在不知情的情况下做下去。
 *
 * ================= 为什么标题不在按键时写盘 =================
 *
 * 每改动一次就写一次文件，打字会导致每秒好几次磁盘写。
 * 所以文本类字段在**失焦或回车**时才提交，结构类操作（状态、依赖）即时提交。
 */

const STATUS_FLOW: BoardStatus[] = ['todo', 'doing', 'done', 'cancelled'];

/** 同色描边：与 BoardTable 的 tintStyle 同一口径 */
function tint(color: string): CSSProperties | undefined {
  return color ? { color, borderColor: color } : undefined;
}

export function TaskBoardDetail({
  board, selectedId, onApply, canWrite, sessionId = '',
}: {
  board: TaskBoard;
  meta: BoardMeta;
  selectedId: string | null;
  /** 传一个纯函数进来，由外层负责写盘 */
  onApply: (next: (b: TaskBoard) => TaskBoard) => void;
  canWrite: boolean;
  /** 本窗口的 sessionID。认领时写进任务，用于"认出自己"与接手留痕 */
  sessionId?: string;
}) {
  const node = selectedId ? board.nodes[selectedId] : undefined;
  const [titleDraft, setTitleDraft] = useState('');
  const [noteDraft, setNoteDraft] = useState('');
  const [whoDraft, setWhoDraft] = useState('');

  useEffect(() => { setTitleDraft(node?.title ?? ''); }, [selectedId, node?.title]);
  useEffect(() => { setNoteDraft(isTask(node) ? node.note : ''); }, [selectedId, node]);
  useEffect(() => { setWhoDraft(isTask(node) ? node.assignee : ''); }, [selectedId, node]);

  /** 全部可选作前置的节点（任务与组都行；指向组 = 等它下面全部完成） */
  const depChoices = useMemo(() => {
    if (!selectedId) return [];
    const skip = new Set([selectedId, ...leafTaskIds(board, selectedId), ...ancestors(board, selectedId)]);
    return Object.keys(board.nodes)
      .filter((id) => !skip.has(id))
      .map((id) => ({ id, title: board.nodes[id].title, group: isGroup(board.nodes[id]) }));
  }, [board, selectedId]);

  if (!selectedId || !node) {
    return (
      <div className="task-detail">
        <div className="nx-empty task-empty">在左侧任务板里选一项。</div>
      </div>
    );
  }

  const group = isGroup(node);
  const lock = group ? null : lockOf(board, selectedId, meta);
  const tally = group ? tallyOf(board, selectedId, meta) : null;
  /*
   * 状态按钮列**流程里配的那些**，不是写死的四个。
   *
   * 自定义流程里根本没有 'done' 这个 id —— 写死的话点一下就把任务
   * 设成一个流程里不存在的状态，界面上显示成 id，而用户以为自己点了"完成"。
   */
  const flow = meta && meta.statuses.length > 0 ? meta.statuses.map((s) => s.id) : STATUS_FLOW;

  const guard = async (warnings: string[], run: () => void) => {
    if (warnings.length === 0) { run(); return; }
    const ok = await confirm({
      title: '确认继续',
      message: warnings.join('\n'),
      okText: '仍然继续',
      danger: true,
      width: 480,
    });
    if (ok) run();
  };

  const doStatus = (st: BoardStatus) => {
    if (!isTask(node)) return;
    void guard(warnOf(() => setTaskStatus(board, selectedId, st)), () => {
      onApply((b) => setTaskStatus(b, selectedId, st).board);
    });
  };

  const doClaim = () => {
    if (!isTask(node)) return;
    const who = whoDraft.trim();
    if (!who) return;
    void guard(warnOf(() => claimTask(board, selectedId, who, sessionId)), () => {
      onApply((b) => claimTask(b, selectedId, who, sessionId).board);
    });
  };

  const commitTitle = () => {
    const t = titleDraft.trim();
    if (!t || t === node.title) { setTitleDraft(node.title); return; }
    onApply((b) => renameNode(b, selectedId, t));
  };

  const commitNote = () => {
    if (!isTask(node)) return;
    if (noteDraft === node.note) return;
    const v = noteDraft;
    onApply((b) => withTask(b, selectedId, (t) => ({ ...t, note: v })));
  };

  return (
    <div className="task-detail">
      <div className="bdd-head">
        <input
          className="p-input bdd-title"
          value={titleDraft}
          disabled={!canWrite}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={commitTitle}
          /* 组合期的回车是「把候选词上屏」，不是提交：中文标题打到一半按回车
             选词，会被 commitTitle 落盘成拼音串（见 js/ime.js 第 1、2 条）。
             React 合成事件不转发 isComposing，必须传 nativeEvent。 */
          onKeyDown={(e) => { if (isComposing(e.nativeEvent)) return; if (e.key === 'Enter') commitTitle(); }}
        />
        {group ? (
          <span className="bdd-kind">任务组</span>
        ) : (
          <span className={`bdt-pill st-${statusOf(board, selectedId, meta)}`} style={tint(statusColor(meta, statusOf(board, selectedId, meta)))}>
            {statusName(meta, statusOf(board, selectedId, meta))}
          </span>
        )}
      </div>

      {group ? (
        <div className="bdd-body">
          <div className="bdd-note">
            任务组只作为显示与归类，本身不能被领取或标记完成。
            它的状态由下面的 {tally?.total ?? 0} 个任务聚合而来。
          </div>
          <div className="bdd-stats">
            <span>共 {tally?.total ?? 0} 个任务</span>
            <span className="bdt-done">完成 {tally?.done ?? 0}</span>
            <span className="bdt-doing">进行中 {tally?.doing ?? 0}</span>
            {tally && tally.locked > 0 ? <span className="bdt-lock">未解锁 {tally.locked}</span> : null}
          </div>
        </div>
      ) : (
        <div className="bdd-body">
          {lock?.locked ? (
            <div className="bdd-warn">
              {lock.cyclic ? '⚠ 前置任务互相依赖成环，这条永远等不到解锁。'
                : lock.missing.length > 0 ? `⚠ 前置任务不存在：${lock.missing.join('、')}`
                : `⚠ 等待 ${lock.pending.length} 个前置任务完成。`}
            </div>
          ) : (
            <div className="bdd-ok">前置条件已满足，可以开始。</div>
          )}

          <div className="bdd-row">
            <span className="bdd-k">状态</span>
            <div className="bdd-actions">
              {flow.map((st) => (
                <button
                  key={st}
                  type="button"
                  className={`mini ${statusOf(board, selectedId, meta) === st ? 'is-on' : ''}`}
                  disabled={!canWrite}
                  onClick={() => doStatus(st)}
                >
                  {statusName(meta, st)}
                </button>
              ))}
            </div>
          </div>

          <div className="bdd-row">
            <span className="bdd-k">领取</span>
            <input
              className="p-input bdd-who"
              value={whoDraft}
              disabled={!canWrite}
              placeholder="谁来做（人名或 ai）"
              onChange={(e) => setWhoDraft(e.target.value)}
            />
            <button type="button" className="mini" disabled={!canWrite || !whoDraft.trim()} onClick={doClaim}>
              领取
            </button>
          </div>

          <div className="bdd-row">
            <span className="bdd-k">前置</span>
            <div className="bdd-deps">
              {node.deps.length === 0 ? (
                <span className="bdd-mute">无</span>
              ) : node.deps.map((d) => (
                <span key={d} className="bdd-dep">
                  {board.nodes[d]?.title ?? d}
                  {isGroup(board.nodes[d]) ? <span className="bdd-dep-g">组</span> : null}
                  <button
                    type="button"
                    className="bdd-dep-x"
                    disabled={!canWrite}
                    onClick={() => onApply((b) => withTask(b, selectedId, (t) => ({ ...t, deps: t.deps.filter((x) => x !== d) })))}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>
          <div className="bdd-row">
            <span className="bdd-k" />
            <select
              className="p-input bdd-dep-add"
              value=""
              disabled={!canWrite}
              onChange={(e) => {
                const d = e.target.value;
                if (!d) return;
                onApply((b) => withTask(b, selectedId, (t) => (
                  t.deps.indexOf(d) >= 0 ? t : { ...t, deps: [...t.deps, d] }
                )));
              }}
            >
              <option value="">+ 添加前置…</option>
              {depChoices.map((c) => (
                <option key={c.id} value={c.id}>{c.title}{c.group ? '（组）' : ''}</option>
              ))}
            </select>
          </div>

          <div className="bdd-row">
            <span className="bdd-k">备注</span>
            <textarea
              className="p-input bdd-note-input"
              value={noteDraft}
              disabled={!canWrite}
              placeholder="补充信息"
              onChange={(e) => setNoteDraft(e.target.value)}
              onBlur={commitNote}
            />
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 对某条任务做修改。组直接原样返回（组没有这些字段） */
function withTask(
  board: TaskBoard,
  id: string,
  fn: (t: BoardTask) => BoardTask,
): TaskBoard {
  const n = board.nodes[id];
  if (!isTask(n)) return board;
  return {
    ...board,
    nodes: { ...board.nodes, [id]: fn(n) },
    updatedAt: Date.now(),
  };
}

function ancestors(board: TaskBoard, id: string): string[] {
  const out: string[] = [];
  let cur: string | null = id;
  const guard = new Set<string>();
  while (cur && !guard.has(cur)) {
    guard.add(cur);
    const p = parentOf(board, cur);
    if (!p) break;
    out.push(p);
    cur = p;
  }
  return out;
}

function parentOf(board: TaskBoard, id: string): string | null {
  for (const p of Object.keys(board.nodes)) {
    const n = board.nodes[p];
    if (isGroup(n) && n.children.indexOf(id) >= 0) return p;
  }
  return null;
}

/** 先跑一次引擎拿到 warnings（不落盘），用于弹确认 */
function warnOf(run: () => { warnings: string[] }): string[] {
  try { return run().warnings; } catch { return []; }
}
