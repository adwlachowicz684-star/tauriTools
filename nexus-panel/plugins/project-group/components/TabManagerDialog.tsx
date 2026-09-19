import { useEffect, useRef, useState } from 'react';
import type { CardKind, TabInfo } from '../types';
import { canMove, canRemove } from '../utils/tabs';
import { ConfirmDialog, Modal } from './ui';

/**
 * 页签管理面板（#26 / 清单 #23）：两栏页签集中一处管理。
 *
 * 为什么需要它：此前新增/改名/删除分散在两栏各自的页签条上（⋮ 菜单 + 拖拽排序），
 * 三个问题绕不开 ——
 *   1. 一次只能看到一栏，想"把项目页签和项目组页签对齐整理"得来回切；
 *   2. 改名要双击页签进内联输入，页签窄（名字常溢出），改名时看不全；
 *   3. 拖拽排序在页签多、名字长的时候很难对准，落点全凭手感。
 * 集中到一处后，改名是整行编辑、排序是上移/下移按钮，都能看全、能对准。
 *
 * **本组件不自己实现增删改**：全部复用 useFpx 里已有的 addTab / renameTab /
 * removeTab / moveTab，以及 tabRemoveCheck 的两条保护（含锁定项拒绝、
 * 含卡片先确认）。这里只负责"把入口摆到一起"，避免同一套规则长出两份实现。
 */

const KIND_LABEL: Record<CardKind, string> = { project: '项目', group: '项目组' };

/** 编辑中的页签：哪一栏 + 第几个 */
type EditAt = { kind: CardKind; index: number } | null;

export function TabManagerDialog({
  projectTabs, groupTabs, onClose, onLog,
  onAdd, onRename, onRemove, onMove, onCheck,
}: {
  projectTabs: TabInfo[];
  groupTabs: TabInfo[];
  onClose: () => void;
  onLog: (m: string, isError?: boolean) => void;
  onAdd: (kind: CardKind, name: string) => Promise<void>;
  onRename: (kind: CardKind, index: number, name: string) => Promise<void>;
  onRemove: (kind: CardKind, index: number) => Promise<void>;
  onMove: (kind: CardKind, from: number, to: number) => Promise<void>;
  /** 删除前检查：返回 blocked（拒绝理由）/ confirm（确认文案）/ 空（可直接删） */
  onCheck: (kind: CardKind, index: number) =>
    { blocked?: string; confirm?: string };
}) {
  const [editing, setEditing] = useState<EditAt>(null);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  /** 待确认的删除：确认框要显示后端给的文案（里面带着会损失多少） */
  const [pending, setPending] = useState<{ kind: CardKind; index: number; msg: string } | null>(null);

  // 进入编辑就把焦点与光标交给输入框：否则用户还得再点一下才能打字
  useEffect(() => {
    if (!editing) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [editing]);

  const tabsOf = (kind: CardKind) => (kind === 'project' ? projectTabs : groupTabs);

  const startEdit = (kind: CardKind, index: number) => {
    setEditing({ kind, index });
    setDraft(tabsOf(kind)[index]?.name ?? '');
  };

  const commitEdit = async () => {
    if (!editing) return;
    const { kind, index } = editing;
    const tabs = tabsOf(kind);
    const name = draft.trim();
    setEditing(null);
    // 没改或改成空 → 不动。renameTab 内部也会拒绝空名，
    // 但这里先挡掉能省一次无谓的写盘（改名是整份 config 回写）
    if (!name || name === tabs[index]?.name) return;
    await onRename(kind, index, name);
  };

  const askRemove = (kind: CardKind, index: number) => {
    const r = onCheck(kind, index);
    if (r.blocked) {
      onLog(r.blocked, true);
      return;
    }
    if (r.confirm) {
      setPending({ kind, index, msg: r.confirm });
      return;
    }
    void onRemove(kind, index);
  };

  const section = (kind: CardKind) => {
    const tabs = tabsOf(kind);
    const label = KIND_LABEL[kind];
    return (
      <div className="fpx-tabmgr-sec">
        <div className="fpx-tabmgr-head">
          <h3>{label}页签</h3>
          <button
            className="p-btn"
            onClick={() => void onAdd(kind, `${label}页签${tabs.length + 1}`)}
          >
            ＋ 新增{label}页签
          </button>
        </div>

        {tabs.length === 0 && <div className="p-muted">（暂无）</div>}

        {tabs.map((t, i) => {
          const locked = (t.items ?? []).filter((c) => c.locked).length;
          const isEditing = editing?.kind === kind && editing.index === i;
          return (
            <div className={`fpx-tabmgr-row${isEditing ? ' editing' : ''}`} key={`${kind}-${i}-${t.name}`}>
              <span className="fpx-tabmgr-idx">{i + 1}</span>

              {isEditing ? (
                <input
                  ref={inputRef}
                  className="p-input fpx-tabmgr-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => void commitEdit()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void commitEdit(); }
                    if (e.key === 'Escape') { e.preventDefault(); setEditing(null); }
                  }}
                />
              ) : (
                /* 整行都是改名入口：页签条上那个"双击页签"的入口太窄，
                   名字一长就点不准，这里点哪都能改 */
                <button
                  className="fpx-tabmgr-name"
                  title="点击改名"
                  onClick={() => startEdit(kind, i)}
                >
                  {t.name || '（未命名）'}
                </button>
              )}

              {/* 数量不是装饰：删页签会连带移除这些登记，
                  不给数的话用户不知道这一下会损失什么 */}
              <span className="fpx-tabmgr-count" title={`${t.items?.length ?? 0} 个条目`}>
                {t.items?.length ?? 0} 项
              </span>
              {locked > 0 && (
                <span className="fpx-tabmgr-lock" title={`${locked} 个受保护项，需先解除保护才能删除本页签`}>
                  🔒 {locked}
                </span>
              )}

              <div className="fpx-tabmgr-ops">
                {/* 边界判断一律走 canMove / canRemove（utils/tabs.ts），
                    不在 JSX 里另写 `i === 0` 这类条件 —— 两套判断迟早漂移，
                    症状是"按钮能点、点了没反应"或"明明能移却灰着" */}
                <button
                  className="p-btn"
                  title="上移"
                  disabled={isEditing || !canMove(i, tabs.length, -1)}
                  onClick={() => void onMove(kind, i, i - 1)}
                >↑</button>
                <button
                  className="p-btn"
                  title="下移"
                  disabled={isEditing || !canMove(i, tabs.length, 1)}
                  onClick={() => void onMove(kind, i, i + 1)}
                >↓</button>
                <button
                  className="p-btn danger"
                  title={canRemove(tabs.length) ? '删除该页签' : '至少保留一个页签'}
                  disabled={isEditing || !canRemove(tabs.length)}
                  onClick={() => askRemove(kind, i)}
                >删除</button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <>
      <Modal
        title="页签管理"
        onClose={onClose}
        width={560}
        footer={(
          <div className="p-muted" style={{ fontSize: 'var(--fs-11, 11px)' }}>
            改名点名字即可；排序用 ↑↓，与页签条上的拖拽等价。
            有受保护项的页签需先解除保护才能删除。
          </div>
        )}
      >
        {section('project')}
        {section('group')}
      </Modal>

      {pending && (
        <ConfirmDialog
          title="删除页签"
          message={pending.msg}
          confirmText="删除"
          danger
          onConfirm={() => void onRemove(pending.kind, pending.index)}
          onClose={() => setPending(null)}
        />
      )}
    </>
  );
}
