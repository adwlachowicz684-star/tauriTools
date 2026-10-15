import { useEffect, useMemo, useRef, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import * as S from './lib/store';
import {
  STATUS_ORDER,
  STATUS_LABEL,
  PRIORITY_ORDER,
  PRIORITY_LABEL,
} from './types';
import type { TbConfig, Task, TaskStore, Priority, TaskStatus } from './types';
import { actionsFor, allTags, applyTransition, filterTasks, fmtTime, relTime, sortTasks } from './core';

/**
 * 任务管理器 · 看板
 * ------------------------------------------------------------
 * 数据只有一份：数据目录里的 tasks.json。
 *   · 人 → 这个看板（读-改-写全走 Rust 授权目录）
 *   · AI 窗口 → curl 打本地 HTTP API（设置里起服务）
 *   · agent-flow → generic-http 节点打同一个 API
 * 看板每 2s 静默重读一次文件，别人（AI/流程）的改动会自动出现。
 */
export default function App() {
  const ctx = useNexus();
  const [cfg, setCfg] = useState<TbConfig | null>(null);
  const [store, setStore] = useState<TaskStore | null>(null);
  const [me, setMe] = useState('manual');
  const [filter, setFilter] = useState<{ priority: string; tag: string; assignee: string; q: string }>({
    priority: '',
    tag: '',
    assignee: '',
    q: '',
  });
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [rejectFor, setRejectFor] = useState<{ id: string } | null>(null);
  const [err, setErr] = useState('');
  const [serviceOn, setServiceOn] = useState(false);
  const cfgRef = useRef<TbConfig | null>(null);
  cfgRef.current = cfg;

  /* ---------- 初始化 + 轮询 ---------- */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const c = await S.loadConfig(ctx);
        if (!alive) return;
        setCfg(c);
        const st = await S.readStore(ctx, c.dataDir);
        if (!alive) return;
        setStore(st);
        if (c.autoStart) {
          try {
            await S.apiStart(ctx, c);
            if (alive) setServiceOn(true);
          } catch {
            /* 自动起服务失败不阻塞看板 */
          }
        }
      } catch (e: any) {
        if (alive) setErr(String(e?.message || e));
      }
    })();
    // 2s 静默轮询：AI / 流程的写盘在这里体现。
    // 走 ctx.owned 登记的定时器（宿主 dispose 时统一清；SDK 已给 iframe 发 owned）。
    const timerId = ctx.owned.setInterval(() => {
      const c = cfgRef.current;
      if (!c) return;
      S.readStore(ctx, c.dataDir).then((st) => alive && setStore(st)).catch(() => {});
    }, 2000);
    return () => {
      alive = false;
      clearInterval(timerId); // React 侧再兜一层：组件卸载 ≠ 插件卸载
    };
  }, [ctx]);

  /* ---------- 派生数据 ---------- */
  const tags = useMemo(() => (store ? allTags(store.tasks) : []), [store]);
  const byColumn = useMemo(() => {
    const map: Record<TaskStatus, Task[]> = { todo: [], claimed: [], doing: [], review: [], done: [] };
    if (store) {
      const list = sortTasks(filterTasks(store.tasks, filter));
      for (const t of list) map[t.status].push(t);
    }
    return map;
  }, [store, filter]);

  /* ---------- 动作 ---------- */
  const refresh = async () => {
    const c = cfgRef.current;
    if (!c) return;
    setStore(await S.readStore(ctx, c.dataDir));
  };

  const withErr = (fn: () => Promise<void>) => async () => {
    try {
      setErr('');
      await fn();
    } catch (e: any) {
      setErr(String(e?.message || e));
      ctx.toast(String(e?.message || e), 'err');
    }
  };

  const doTransition = (id: string, to: TaskStatus, note = '') =>
    withErr(async () => {
      if (!cfg) return;
      const task = await S.transitionTask(ctx, cfg.dataDir, me, id, to, note);
      await refresh();
      if (to === 'review') await S.notifyWebhook(cfg, task);
      ctx.toast(`${id} → ${STATUS_LABEL[to]}`, 'ok');
    })();

  const doClaim = (id: string) =>
    withErr(async () => {
      if (!cfg) return;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const idx = st.tasks.findIndex((t) => t.id === id);
        if (idx < 0) return null;
        const next = applyTransition(st.tasks[idx], 'claimed', me);
        if (!next) return null;
        next.assignee = me; // 认领必须署名
        const tasks = [...st.tasks];
        tasks[idx] = next;
        return { ...st, tasks };
      });
      await refresh();
      ctx.toast(`${id} 已由 ${me} 认领`, 'ok');
    })();

  const doComment = (id: string, note: string) =>
    withErr(async () => {
      if (!cfg || !note.trim()) return;
      await S.commentTask(ctx, cfg.dataDir, me, id, note.trim());
      await refresh();
    })();

  const doDelete = (id: string) =>
    withErr(async () => {
      if (!cfg) return;
      await S.deleteTask(ctx, cfg.dataDir, id);
      setDetailId(null);
      await refresh();
      ctx.toast(`${id} 已删除`, 'ok');
    })();

  const switchMe = (id: string) =>
    withErr(async () => {
      setMe(id);
      if (cfg && id !== 'manual') {
        await S.registerAgent(ctx, cfg.dataDir, { id, name: id, role: 'dev', lastSeen: Date.now() });
        await refresh();
      }
    })();

  const toggleService = withErr(async () => {
    if (!cfg) return;
    if (serviceOn) {
      await S.apiStop(ctx, cfg);
      setServiceOn(false);
      ctx.toast('HTTP 服务已停止', 'ok');
    } else {
      await S.apiStart(ctx, cfg);
      setServiceOn(true);
      ctx.toast(`HTTP 服务已启动：127.0.0.1:${cfg.port}`, 'ok');
    }
  });

  /* ---------- 渲染 ---------- */
  if (err && !store) {
    return (
      <div className="tb-wrap">
        <div className="tb-empty">
          <p>初始化失败：{err}</p>
          <p className="tb-hint">请在「⚙ 设置」里确认数据目录后重试。</p>
        </div>
      </div>
    );
  }
  if (!store || !cfg) {
    return (
      <div className="tb-wrap">
        <div className="tb-empty">加载中…</div>
      </div>
    );
  }

  const detail = detailId ? store.tasks.find((t) => t.id === detailId) : null;
  const openCount = store.tasks.filter((t) => t.status !== 'done').length;

  return (
    <div className="tb-wrap">
      {/* 顶栏 */}
      <header className="tb-bar">
        <div className="tb-bar-left">
          <span className="tb-mark">▦</span>
          <span className="tb-head">任务管理器</span>
          <span className="tb-count" title="未完成任务数">{openCount}</span>
        </div>
        <div className="tb-bar-right">
          <label className="tb-field">
            <span>身份</span>
            <select value={me} onChange={(e) => switchMe(e.target.value)}>
              <option value="manual">manual（人工）</option>
              {me !== 'manual' && !store.agents.some((a) => a.id === me) && (
                <option value={me}>{me}（不在当前身份表）</option>
              )}
              {store.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}（{a.role}）
                </option>
              ))}
            </select>
          </label>
          <label className="tb-field">
            <span>优先级</span>
            <select value={filter.priority} onChange={(e) => setFilter({ ...filter, priority: e.target.value })}>
              <option value="">全部</option>
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {p} {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="tb-field">
            <span>标签</span>
            <select value={filter.tag} onChange={(e) => setFilter({ ...filter, tag: e.target.value })}>
              <option value="">全部</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  {tag}
                </option>
              ))}
            </select>
          </label>
          <label className="tb-field">
            <span>认领</span>
            <select value={filter.assignee} onChange={(e) => setFilter({ ...filter, assignee: e.target.value })}>
              <option value="">全部</option>
              <option value="__none__">未认领</option>
              {store.agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.id}
                </option>
              ))}
            </select>
          </label>
          <input
            className="tb-search"
            placeholder="搜索标题 / 详情 / id"
            value={filter.q}
            onChange={(e) => setFilter({ ...filter, q: e.target.value })}
          />
          <button
            className={'tb-svc' + (serviceOn ? ' on' : '')}
            title={serviceOn ? `API 在线 127.0.0.1:${cfg.port}（点击停止）` : 'API 未启动（点击启动）'}
            onClick={toggleService}
          >
            ●
          </button>
          <button className="tb-act primary" onClick={() => setNewOpen(true)}>
            ＋ 新建
          </button>
        </div>
      </header>

      {err && <div className="tb-err">{err}</div>}

      {/* 看板五列 */}
      <div className="tb-board">
        {STATUS_ORDER.map((st) => (
          <section key={st} className="tb-col">
            <header className="tb-col-head">
              <span className={'tb-col-dot s-' + st} />
              {STATUS_LABEL[st]}
              <span className="tb-col-num">{byColumn[st].length}</span>
            </header>
            <div className="tb-col-body">
              {byColumn[st].length === 0 && <div className="tb-col-empty">空</div>}
              {byColumn[st].map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  me={me}
                  onOpen={() => setDetailId(t.id)}
                  onAction={(to, needNote) => (needNote ? setRejectFor({ id: t.id }) : doTransition(t.id, to))}
                  onClaim={() => doClaim(t.id)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* 新建任务 */}
      {newOpen && (
        <NewTaskModal
          agents={store.agents}
          me={me}
          onClose={() => setNewOpen(false)}
          onCreate={async (draft) => {
            await S.createTask(ctx, cfg.dataDir, me, draft);
            setNewOpen(false);
            await refresh();
            ctx.toast('任务已创建', 'ok');
          }}
        />
      )}

      {/* 任务详情 */}
      {detail && (
        <DetailModal
          task={detail}
          me={me}
          onClose={() => setDetailId(null)}
          onComment={(note) => doComment(detail.id, note)}
          onDelete={() => doDelete(detail.id)}
          onAction={(to, needNote) => (needNote ? setRejectFor({ id: detail.id }) : doTransition(detail.id, to))}
          onClaim={() => doClaim(detail.id)}
        />
      )}

      {/* 打回备注 */}
      {rejectFor && (
        <RejectModal
          onClose={() => setRejectFor(null)}
          onOk={async (note) => {
            const id = rejectFor.id;
            setRejectFor(null);
            await doTransition(id, 'doing', note);
          }}
        />
      )}
    </div>
  );
}

/* ================================================================ 子组件 */

function PriorityBadge({ p }: { p: Priority }) {
  return <span className={'tb-pri p-' + p}>{p}</span>;
}

function TaskCard({
  task,
  me,
  onOpen,
  onAction,
  onClaim,
}: {
  task: Task;
  me: string;
  onOpen: () => void;
  onAction: (to: TaskStatus, needNote?: boolean) => void;
  onClaim: () => void;
}) {
  const acts = actionsFor(task.status);
  return (
    <article className="tb-task">
      <div className="tb-task-top" onClick={onOpen}>
        <PriorityBadge p={task.priority} />
        <span className="tb-task-id">{task.id}</span>
        <span className="tb-task-time" title={fmtTime(task.updatedAt)}>
          {relTime(task.updatedAt)}
        </span>
      </div>
      <div className="tb-task-title" onClick={onOpen}>
        {task.title}
      </div>
      {task.tags.length > 0 && (
        <div className="tb-task-tags">
          {task.tags.map((tag) => (
            <span key={tag} className="tb-tag">
              {tag}
            </span>
          ))}
        </div>
      )}
      <div className="tb-task-foot">
        {task.assignee ? (
          <span className="tb-who" title={`认领人：${task.assignee}`}>
            @{task.assignee}
          </span>
        ) : (
          <span className="tb-who none">未认领</span>
        )}
        <div className="tb-task-acts">
          {task.status === 'todo' && (
            <button className="tb-act sm" onClick={onClaim} title={`以 ${me} 身份认领`}>
              认领
            </button>
          )}
          {acts
            .filter((a) => !(task.status === 'todo' && a.to === 'claimed'))
            .map((a) => (
              <button
                key={a.to}
                className={'tb-act sm' + (a.to === 'done' ? ' primary' : '') + (a.needNote ? ' warn' : '')}
                onClick={() => onAction(a.to as TaskStatus, a.needNote)}
              >
                {a.label}
              </button>
            ))}
        </div>
      </div>
    </article>
  );
}

function NewTaskModal({
  agents,
  me,
  onClose,
  onCreate,
}: {
  agents: { id: string }[];
  me: string;
  onClose: () => void;
  onCreate: (draft: { title: string; detail: string; priority: string; tags: string[]; assignee: string }) => void;
}) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [tagsText, setTagsText] = useState('');
  const [assignee, setAssignee] = useState('');

  return (
    <Modal title="新建任务" onClose={onClose}>
      <label className="tb-mfield">
        <span>标题 *</span>
        <input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="一句话说清问题" />
      </label>
      <label className="tb-mfield">
        <span>详情</span>
        <textarea rows={4} value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="复现步骤 / 期望行为（可选）" />
      </label>
      <div className="tb-mrow">
        <label className="tb-mfield">
          <span>优先级</span>
          <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
            {PRIORITY_ORDER.map((p) => (
              <option key={p} value={p}>
                {p} {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="tb-mfield">
          <span>标签（逗号分隔）</span>
          <input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="bug, ui" />
        </label>
      </div>
      <label className="tb-mfield">
        <span>指派给（可选）</span>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">不指派</option>
          {me !== 'manual' && <option value={me}>{me}（我）</option>}
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.id}
            </option>
          ))}
        </select>
      </label>
      <div className="tb-macts">
        <button className="tb-act" onClick={onClose}>
          取消
        </button>
        <button
          className="tb-act primary"
          disabled={!title.trim()}
          onClick={() =>
            onCreate({
              title,
              detail,
              priority,
              tags: tagsText.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
              assignee,
            })
          }
        >
          创建
        </button>
      </div>
    </Modal>
  );
}

function DetailModal({
  task,
  me,
  onClose,
  onComment,
  onDelete,
  onAction,
  onClaim,
}: {
  task: Task;
  me: string;
  onClose: () => void;
  onComment: (note: string) => void;
  onDelete: () => void;
  onAction: (to: TaskStatus, needNote?: boolean) => void;
  onClaim: () => void;
}) {
  const [note, setNote] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const acts = actionsFor(task.status);
  const hist = [...task.history].reverse();

  return (
    <Modal title={`${task.id} · ${task.title}`} onClose={onClose} wide>
      <div className="tb-dmeta">
        <PriorityBadge p={task.priority} />
        <span className="tb-dtag">状态：{STATUS_LABEL[task.status]}</span>
        <span className="tb-dtag">报告人：{task.reporter}</span>
        <span className="tb-dtag">认领人：{task.assignee || '未认领'}</span>
        <span className="tb-dtag">更新：{fmtTime(task.updatedAt)}</span>
        {task.tags.map((tag) => (
          <span key={tag} className="tb-tag">
            {tag}
          </span>
        ))}
      </div>
      {task.detail && <div className="tb-ddetail">{task.detail}</div>}

      <div className="tb-dacts">
        {task.status === 'todo' && (
          <button className="tb-act sm" onClick={onClaim}>
            认领（{me}）
          </button>
        )}
        {acts
          .filter((a) => !(task.status === 'todo' && a.to === 'claimed'))
          .map((a) => (
            <button
              key={a.to}
              className={'tb-act sm' + (a.to === 'done' ? ' primary' : '') + (a.needNote ? ' warn' : '')}
              onClick={() => onAction(a.to as TaskStatus, a.needNote)}
            >
              {a.label}
            </button>
          ))}
        <span className="tb-flex" />
        {confirmDel ? (
          <>
            <button className="tb-act sm warn" onClick={onDelete}>
              确认删除？
            </button>
            <button className="tb-act sm" onClick={() => setConfirmDel(false)}>
              再想想
            </button>
          </>
        ) : (
          <button className="tb-act sm ghost" onClick={() => setConfirmDel(true)}>
            删除
          </button>
        )}
      </div>

      <div className="tb-dhist">
        <div className="tb-dhist-head">历史（{hist.length}）</div>
        {hist.length === 0 && <div className="tb-col-empty">暂无记录</div>}
        {hist.map((h, i) => (
          <div key={i} className="tb-hev">
            <span className="tb-hev-at">{fmtTime(h.at)}</span>
            <span className="tb-hev-by">{h.by}</span>
            <span className="tb-hev-act">{h.action}</span>
            {h.note && <span className="tb-hev-note">{h.note}</span>}
          </div>
        ))}
      </div>

      <div className="tb-dcomment">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="写条备注 / 进展，回车提交"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && note.trim()) {
              onComment(note);
              setNote('');
            }
          }}
        />
        <button
          className="tb-act sm"
          disabled={!note.trim()}
          onClick={() => {
            onComment(note);
            setNote('');
          }}
        >
          备注
        </button>
      </div>
    </Modal>
  );
}

function RejectModal({ onClose, onOk }: { onClose: () => void; onOk: (note: string) => void }) {
  const [note, setNote] = useState('');
  return (
    <Modal title="打回重修" onClose={onClose}>
      <label className="tb-mfield">
        <span>打回原因 *</span>
        <textarea
          autoFocus
          rows={4}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="哪里不过关，要改成什么"
        />
      </label>
      <div className="tb-macts">
        <button className="tb-act" onClick={onClose}>
          取消
        </button>
        <button className="tb-act warn" disabled={!note.trim()} onClick={() => onOk(note.trim())}>
          打回
        </button>
      </div>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="tb-mask" onClick={onClose}>
      <div className={'tb-modal' + (wide ? ' wide' : '')} onClick={(e) => e.stopPropagation()}>
        <header className="tb-modal-head">
          <span>{title}</span>
          <button className="tb-x" onClick={onClose}>
            ✕
          </button>
        </header>
        <div className="tb-modal-body">{children}</div>
      </div>
    </div>
  );
}
