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
import {
  NOTAG,
  UNASSIGNED,
  actionsFor,
  allTags,
  applyTransition,
  filterTasks,
  fmtTime,
  groupTasks,
  relTime,
  sortTasks,
  sortTasksBy,
  statsOf,
} from './core';
import type { GroupKey, SortField, TbStats } from './core';
/* 输入法守卫：中文 / 日文输入时回车是「把候选词上屏」，不是界面上的「提交」。
   备注框回车直接落盘 tasks.json，不挡的话打一半的拼音会被当成一条备注写进去。 */
import { isComposing } from '../../js/ime.js';

/**
 * 任务管理器 · 四视图
 * ------------------------------------------------------------
 * 数据只有一份：数据目录里的 tasks.json。
 *   · 人 → 这个面板（读-改-写全走 Rust 授权目录）
 *   · AI 窗口 → curl 打本地 HTTP API（设置里起服务）
 *   · agent-flow → generic-http 节点打同一个 API
 * 面板每 2s 静默重读一次文件，别人（AI/流程）的改动会自动出现。
 *
 * 视图：看板（按状态五列）/ 列表（平铺可排序）/ 分组（按一个字段聚合）/
 *      统计（分布 / 负载 / 动态）。四视图共用同一份筛选结果；
 *      视图偏好（当前视图、分组依据、排序）走 ctx.store 持久化。
 */
type TbView = 'board' | 'list' | 'group' | 'stats';

const VIEWS: { key: TbView; label: string; title: string }[] = [
  { key: 'board', label: '看板', title: '看板：按状态分五列' },
  { key: 'list', label: '列表', title: '列表：平铺排序，表头可点' },
  { key: 'group', label: '分组', title: '分组：按一个字段聚合' },
  { key: 'stats', label: '统计', title: '统计：分布 / 负载 / 最近动态' },
];

const GROUP_KEYS: GroupKey[] = ['status', 'priority', 'assignee', 'tag'];

const SORT_FIELDS: SortField[] = ['priority', 'status', 'assignee', 'updatedAt', 'createdAt', 'title', 'id'];

/** 分组 key → 展示名（label 只在这一处映射，core.mjs 不碰文案） */
function groupLabel(key: string, by: GroupKey): string {
  if (by === 'status') return STATUS_LABEL[key as TaskStatus] || key;
  if (by === 'priority') return `${key} ${PRIORITY_LABEL[key as Priority] || ''}`.trim();
  if (key === UNASSIGNED) return '未认领';
  if (key === NOTAG) return '无标签';
  return key;
}
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
  /* 视图偏好：当前视图 / 分组依据 / 排序。走 ctx.store（宿主侧持久化，
     重开插件、切窗口都不丢；比 iframe 自己的 localStorage 多一层跨源可用性）。 */
  const [view, setView] = useState<TbView>('board');
  const [groupBy, setGroupBy] = useState<GroupKey>('status');
  const [sort, setSort] = useState<{ field: SortField; dir: 'asc' | 'desc' }>({ field: 'priority', dir: 'asc' });
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
        /* 视图偏好：读不到/格式坏了都静默回默认 —— 丢的只是「上次看到哪」，
           不该让看板起不来。存储桥接最坏 15s 超时，故整体 try 兜住。 */
        try {
          const [v, g, s] = await Promise.all([
            ctx.store.get('view', 'board'),
            ctx.store.get('groupBy', 'status'),
            ctx.store.get('sort', { field: 'priority', dir: 'asc' }),
          ]);
          if (!alive) return;
          if (VIEWS.some((x) => x.key === v)) setView(v as TbView);
          if (GROUP_KEYS.includes(g as GroupKey)) setGroupBy(g as GroupKey);
          if (s && typeof s === 'object' && SORT_FIELDS.includes((s as { field: SortField }).field)) {
            setSort({ field: (s as { field: SortField }).field, dir: (s as { dir?: string }).dir === 'desc' ? 'desc' : 'asc' });
          }
        } catch {
          /* 偏好读取失败：保持默认视图 */
        }
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

  /*
   * 设置面板跑在另一个 view（独立 iframe），与主视图不共享内存：
   * 它改的是同一份磁盘配置，但主视图内存里的 cfg 只在挂载时读了一次，
   * 而 2s 轮询读的是 cfgRef.current.dataDir —— **旧目录**。
   *
   * 所以设置页改完 dataDir 保存后，看板会继续显示旧目录的任务，
   * 直到插件被重新打开才切换 —— 不报错，也没有任何提示，
   * 表现为「设置里改了、这边没反应」。
   *
   * Settings.tsx 早就 emit('task-board:config') 了（约定 <plugin-id>:config），
   * 但此前**没有任何一处订阅**，那句 emit 是空喊。
   */
  useEffect(() => ctx.on('task-board:config', (next?: unknown) => {
    const c = next as TbConfig | null | undefined;
    if (!c || typeof c.dataDir !== 'string') return;
    setCfg(c);
    S.readStore(ctx, c.dataDir)
      .then((st) => setStore(st))
      /* 读不到新目录的任务不弹错：2s 轮询下一拍还会再试，
         而这里正处在"设置刚改完"的时刻，弹错会盖掉"已保存"。 */
      .catch(() => {});
  }), [ctx]);

  /* ---------- 派生数据 ---------- */
  const tags = useMemo(() => (store ? allTags(store.tasks) : []), [store]);
  /* 四视图共用同一份筛选结果；统计视图例外（它看全量，语义是「账本」不是「查询」） */
  const filtered = useMemo(() => (store ? filterTasks(store.tasks, filter) : []), [store, filter]);
  const byColumn = useMemo(() => {
    const map: Record<TaskStatus, Task[]> = { todo: [], claimed: [], doing: [], review: [], done: [] };
    if (store) {
      const list = sortTasks(filtered);
      for (const t of list) map[t.status].push(t);
    }
    return map;
  }, [store, filtered]);
  const listRows = useMemo(() => sortTasksBy(filtered, sort.field, sort.dir), [filtered, sort]);
  const groups = useMemo(() => groupTasks(listRows, groupBy), [listRows, groupBy]);
  const stats = useMemo<TbStats | null>(() => (store ? statsOf(store) : null), [store]);

  /* 偏好落盘：store 是异步桥接，失败只意味着「下次不记得」，不该弹错打扰用户 */
  const persist = (k: string, v: unknown) => {
    try {
      const p = ctx.store.set(k, v) as unknown as Promise<unknown> | undefined;
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      /* 同上：静默 */
    }
  };
  const changeView = (v: TbView) => {
    setView(v);
    persist('view', v);
  };
  const changeGroupBy = (g: GroupKey) => {
    setGroupBy(g);
    persist('groupBy', g);
  };
  const changeSort = (field: SortField, dir?: 'asc' | 'desc') => {
    // 点同一列 = 翻转方向；换列 = 用该列默认方向（时间类「新的在前」，其余升序）
    const next =
      dir ?? (sort.field === field ? (sort.dir === 'asc' ? 'desc' : 'asc') : field === 'updatedAt' || field === 'createdAt' ? 'desc' : 'asc');
    setSort({ field, dir: next });
    persist('sort', { field, dir: next });
  };

  /* ---------- 动作 ---------- */
  const refresh = async () => {
    const c = cfgRef.current;
    if (!c) return;
    setStore(await S.readStore(ctx, c.dataDir));
  };

  /* 带参转发（...args）：新建任务那类「带草稿入参」的回调也要能走同一份
     报错判据，否则它就得自己写一份 try/catch，两边会各改各的。 */
  const withErr = (fn: (...args: any[]) => Promise<void>) => async (...args: any[]) => {
    try {
      setErr('');
      await fn(...args);
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

      {/* 视图切换条：左段四视图 tab，右段放各视图自己的参数 + 命中数 */}
      <div className="tb-views">
        <div className="tb-viewtabs">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              className={'tb-viewtab' + (view === v.key ? ' on' : '')}
              title={v.title}
              aria-pressed={view === v.key}
              onClick={() => changeView(v.key)}
            >
              {v.label}
            </button>
          ))}
        </div>
        <div className="tb-views-right">
          {view === 'group' && (
            <label className="tb-field">
              <span>分组依据</span>
              <select value={groupBy} onChange={(e) => changeGroupBy(e.target.value as GroupKey)}>
                <option value="status">状态</option>
                <option value="priority">优先级</option>
                <option value="assignee">认领人</option>
                <option value="tag">标签</option>
              </select>
            </label>
          )}
          {view === 'list' && (
            <>
              <label className="tb-field">
                <span>排序</span>
                <select value={sort.field} onChange={(e) => changeSort(e.target.value as SortField)}>
                  <option value="priority">优先级</option>
                  <option value="status">状态</option>
                  <option value="assignee">认领人</option>
                  <option value="updatedAt">更新时间</option>
                  <option value="createdAt">创建时间</option>
                  <option value="title">标题</option>
                  <option value="id">ID</option>
                </select>
              </label>
              <button className="tb-act sm" title="切换升序 / 降序" onClick={() => changeSort(sort.field)}>
                {sort.dir === 'asc' ? '↑ 升序' : '↓ 降序'}
              </button>
            </>
          )}
          <span className="tb-views-count" title="当前筛选命中 / 总任务">
            {filtered.length} / {store.tasks.length}
          </span>
        </div>
      </div>

      {/* 看板五列 */}
      {view === 'board' && (
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
      )}

      {/* 列表：平铺 + 表头排序 */}
      {view === 'list' && (
        <ListView rows={listRows} sort={sort} onSort={changeSort} onOpen={(id) => setDetailId(id)} />
      )}

      {/* 分组：按一个字段聚合，组内沿用当前排序 */}
      {view === 'group' && (
        <GroupView
          groups={groups}
          groupBy={groupBy}
          me={me}
          onOpen={(id) => setDetailId(id)}
          onAction={(id, to, needNote) => (needNote ? setRejectFor({ id }) : doTransition(id, to))}
          onClaim={(id) => doClaim(id)}
        />
      )}

      {/* 统计：看全量，不受顶部筛选影响 */}
      {view === 'stats' && stats && <StatsView stats={stats} onOpen={(id) => setDetailId(id)} />}

      {/* 新建任务 */}
      {newOpen && (
        <NewTaskModal
          agents={store.agents}
          me={me}
          onClose={() => setNewOpen(false)}
          onCreate={withErr(async (draft) => {
            await S.createTask(ctx, cfg.dataDir, me, draft);
            setNewOpen(false);
            await refresh();
            ctx.toast('任务已创建', 'ok');
          })}
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

/* ================================================================ 列表视图 */

const LIST_COLS: { field: SortField; label: string }[] = [
  { field: 'priority', label: '优先级' },
  { field: 'id', label: 'ID' },
  { field: 'title', label: '标题' },
  { field: 'status', label: '状态' },
  { field: 'assignee', label: '认领人' },
  { field: 'updatedAt', label: '更新' },
];

function ListView({
  rows,
  sort,
  onSort,
  onOpen,
}: {
  rows: Task[];
  sort: { field: SortField; dir: 'asc' | 'desc' };
  onSort: (field: SortField) => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="tb-list">
      <div className="tb-list-head tb-lgrid">
        {LIST_COLS.map((c) => (
          <button
            key={c.field}
            className={'tb-lh c-' + c.field + (sort.field === c.field ? ' on' : '')}
            title={`按${c.label}排序（再次点击切换方向）`}
            onClick={() => onSort(c.field)}
          >
            {c.label}
            <span className="tb-lh-dir">{sort.field === c.field ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
          </button>
        ))}
      </div>
      <div className="tb-list-body">
        {rows.length === 0 && <div className="tb-col-empty">没有符合条件的任务</div>}
        {rows.map((t) => (
          <div key={t.id} className="tb-lrow tb-lgrid" onClick={() => onOpen(t.id)} title="点击查看详情">
            <span className="tb-lc">
              <PriorityBadge p={t.priority} />
            </span>
            <span className="tb-lc c-id">{t.id}</span>
            <span className="tb-lc c-title">
              <span className="tb-ltitle">{t.title}</span>
              {t.tags.length > 0 && (
                <span className="tb-ltags">
                  {t.tags.map((tag) => (
                    <span key={tag} className="tb-tag">
                      {tag}
                    </span>
                  ))}
                </span>
              )}
            </span>
            <span className="tb-lc c-status">
              <span className={'tb-col-dot s-' + t.status} />
              {STATUS_LABEL[t.status]}
            </span>
            <span className="tb-lc c-assignee">{t.assignee ? '@' + t.assignee : '未认领'}</span>
            <span className="tb-lc c-updatedAt" title={fmtTime(t.updatedAt)}>
              {relTime(t.updatedAt)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================================================================ 分组视图 */

function GroupView({
  groups,
  groupBy,
  me,
  onOpen,
  onAction,
  onClaim,
}: {
  groups: { key: string; tasks: Task[] }[];
  groupBy: GroupKey;
  me: string;
  onOpen: (id: string) => void;
  onAction: (id: string, to: TaskStatus, needNote?: boolean) => void;
  onClaim: (id: string) => void;
}) {
  return (
    <div className="tb-groups">
      {groups.length === 0 && <div className="tb-col-empty">没有符合条件的任务</div>}
      {groups.map((g) => (
        <section key={g.key} className="tb-group">
          <header className="tb-group-head">
            {groupBy === 'status' && <span className={'tb-col-dot s-' + g.key} />}
            <span className="tb-group-name">{groupLabel(g.key, groupBy)}</span>
            <span className="tb-col-num">{g.tasks.length}</span>
          </header>
          <div className="tb-group-body">
            {g.tasks.map((t) => (
              <TaskCard
                key={t.id}
                task={t}
                me={me}
                onOpen={() => onOpen(t.id)}
                onAction={(to, needNote) => onAction(t.id, to, needNote)}
                onClaim={() => onClaim(t.id)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ================================================================ 统计视图 */

function BarRow({ label, count, max, dot }: { label: string; count: number; max: number; dot?: string }) {
  return (
    <div className="tb-bar-row">
      <span className="tb-bar-label">
        {dot && <span className={'tb-col-dot ' + dot} />}
        {label}
      </span>
      <span className="tb-bar-track">
        <span className="tb-bar-fill" style={{ width: `${max > 0 ? Math.round((count / max) * 100) : 0}%` }} />
      </span>
      <span className="tb-bar-num">{count}</span>
    </div>
  );
}

function StatsView({ stats, onOpen }: { stats: TbStats; onOpen: (id: string) => void }) {
  const maxStatus = Math.max(1, ...Object.values(stats.byStatus));
  const maxPrio = Math.max(1, ...Object.values(stats.byPriority));
  const maxWho = Math.max(1, ...stats.byAssignee.map((x) => x.count));
  const cards: { label: string; value: number; hint?: string; warn?: boolean }[] = [
    { label: '总任务', value: stats.total },
    { label: '未完成', value: stats.open },
    { label: '进行中', value: stats.active, hint: 'doing + review' },
    { label: '已完成', value: stats.done },
    { label: '超 7 天未动', value: stats.stale.length, warn: stats.stale.length > 0 },
  ];
  return (
    <div className="tb-stats">
      <div className="tb-stat-cards">
        {cards.map((c) => (
          <div key={c.label} className={'tb-stat-card' + (c.warn ? ' warn' : '')}>
            <span className="tb-stat-num">{c.value}</span>
            <span className="tb-stat-label">
              {c.label}
              {c.hint && <em className="tb-stat-hint">{c.hint}</em>}
            </span>
          </div>
        ))}
      </div>
      <div className="tb-stat-grid">
        <section className="tb-stat-panel">
          <header className="tb-stat-panel-head">状态分布</header>
          {STATUS_ORDER.map((s) => (
            <BarRow key={s} label={STATUS_LABEL[s]} count={stats.byStatus[s] || 0} max={maxStatus} dot={'s-' + s} />
          ))}
        </section>
        <section className="tb-stat-panel">
          <header className="tb-stat-panel-head">优先级分布</header>
          {PRIORITY_ORDER.map((p) => (
            <BarRow key={p} label={`${p} ${PRIORITY_LABEL[p]}`} count={stats.byPriority[p] || 0} max={maxPrio} />
          ))}
        </section>
        <section className="tb-stat-panel">
          <header className="tb-stat-panel-head">认领人负载</header>
          {stats.byAssignee.length === 0 && <div className="tb-col-empty">暂无数据</div>}
          {stats.byAssignee.map((a) => (
            <BarRow key={a.id} label={a.id === UNASSIGNED ? '未认领' : '@' + a.id} count={a.count} max={maxWho} />
          ))}
        </section>
        <section className="tb-stat-panel">
          <header className="tb-stat-panel-head">热门标签</header>
          {stats.topTags.length === 0 && <div className="tb-col-empty">暂无标签</div>}
          <div className="tb-stat-tags">
            {stats.topTags.map((x) => (
              <span key={x.tag} className="tb-tag">
                {x.tag} <em className="tb-stat-hint">×{x.count}</em>
              </span>
            ))}
          </div>
        </section>
        <section className="tb-stat-panel wide">
          <header className="tb-stat-panel-head">最近动态</header>
          {stats.recent.length === 0 && <div className="tb-col-empty">暂无记录</div>}
          {stats.recent.map((h, i) => (
            <div key={i} className="tb-hev tb-click" onClick={() => onOpen(h.taskId)} title="点击查看任务">
              <span className="tb-hev-at">{fmtTime(h.at)}</span>
              <span className="tb-hev-by">{h.by}</span>
              <span className="tb-hev-act">{h.taskId}</span>
              <span className="tb-hev-note">{h.note || h.action}</span>
            </div>
          ))}
        </section>
        <section className="tb-stat-panel wide">
          <header className="tb-stat-panel-head">超 7 天未动（{stats.stale.length}）</header>
          {stats.stale.length === 0 && <div className="tb-col-empty">没有陈旧任务</div>}
          {stats.stale.map((t) => (
            <div key={t.id} className="tb-load-row" onClick={() => onOpen(t.id)} title="点击查看任务">
              <PriorityBadge p={t.priority} />
              <span className="tb-load-id">{t.id}</span>
              <span className="tb-load-title">{t.title}</span>
              <span className="tb-load-time">{relTime(t.updatedAt)}</span>
            </div>
          ))}
        </section>
      </div>
      <p className="tb-stats-hint">统计基于全部任务，不受顶部筛选影响。</p>
    </div>
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
            if (isComposing(e.nativeEvent || e)) return;
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
