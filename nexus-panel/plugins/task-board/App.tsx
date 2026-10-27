import { useEffect, useMemo, useRef, useState } from 'react';
import { useNexus } from '../../src/nexus-react';
import * as S from './lib/store';
import {
  STATUS_ORDER,
  STATUS_LABEL,
  PRIORITY_ORDER,
  PRIORITY_LABEL,
} from './types';
import { TAG_COLORS } from './types';
import type {
  TbConfig, Task, TaskStore, Priority, TaskStatus, TagDef, TaskFlow, StatusDef,
} from './types';
import {
  NOTAG,
  UNASSIGNED,
  LIST_COLUMNS,
  actionsFor,
  activeColFilters,
  applyTransition,
  colFilterActive,
  colFilterValues,
  emptyColFilter,
  filterTasksByColumns,
  actionsForIn,
  ancestorChain,
  canTransitionIn,
  createGroup,
  DEFAULT_FLOW,
  dissolveGroup,
  flattenTasks,
  mergeIntoGroup,
  fmtTime,
  groupStatus,
  groupTasks,
  indexTasks,
  initialStatus,
  lockOf,
  normalizeFlow,
  relTime,
  sortRowsBy,
  sortTasks,
  splitTask,
  statsOf,
  statusColor,
  statusName,
} from './core';
import type { ColFilter, FlatRow, GroupKey, ListColumn, SortField, TbStats } from './core';
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

/** 流程配置的最小形状（组件只用到 statuses / transitions / edges） */
type FlowLike = ReturnType<typeof normalizeFlow>;

const SORT_FIELDS: SortField[] = ['priority', 'status', 'assignee', 'tags', 'groupPath', 'summary', 'updatedAt', 'createdAt', 'title', 'id'];

/** 分组 key → 展示名（label 只在这一处映射，core.mjs 不碰文案） */
function groupLabel(key: string, by: GroupKey): string {
  if (by === 'status') return STATUS_LABEL[key as TaskStatus] || key;
  if (by === 'priority') return `${key} ${PRIORITY_LABEL[key as Priority] || ''}`.trim();
  if (key === UNASSIGNED) return '未认领';
  if (key === NOTAG) return '无标签';
  return key;
}
/** 排序字段 → 展示名。与列头用的是同一套名字，两处说法必须一致 */
const SORT_LABEL: Record<SortField, string> = {
  priority: '优先级',
  id: 'ID',
  title: '标题',
  groupPath: '所属组',
  status: '状态',
  assignee: '认领人',
  tags: '标签',
  summary: '说明',
  createdAt: '创建',
  updatedAt: '更新',
};
function sortLabel(f: SortField): string {
  return SORT_LABEL[f] || f;
}

export default function App() {
  const ctx = useNexus();
  const [cfg, setCfg] = useState<TbConfig | null>(null);
  const [store, setStore] = useState<TaskStore | null>(null);
  const [me, setMe] = useState('manual');
  /*
    筛选**按列存**，不再是一排顶栏下拉。

    顶栏摆四个下拉时只有那四件事筛得了，"创建于上周 + 没人认领 + P0"
    这种组合根本填不进去。改成每列一份条件之后，任何列的组合都能表达。

    q 是全局搜索（跨 id / 标题 / 详情）—— 它是"找某一条东西"的入口，
    不属于"按列筛"，所以单独留着。

    ⛔ 筛选不持久化：它是"这一眼想看什么"，不是偏好。
    存下来下次打开还生效会让人以为任务少了。
  */
  /*
    列表里勾选的任务 —— 只有"合并成组"用得上。
    不持久化：勾选是"这一手要动哪几条"，不是偏好。
  */
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  /** 流程设置面板 */
  const [flowOpen, setFlowOpen] = useState(false);
  /** 新建/合并组的弹窗。null = 关着 */
  const [groupDraft, setGroupDraft] = useState<{ mode: 'merge' | 'new' } | null>(null);

  const [q, setQ] = useState('');
  const [colFilters, setColFilters] = useState<Partial<Record<SortField, ColFilter>>>({});
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
  /* 四视图共用同一份筛选结果；统计视图例外（它看全量，语义是「账本」不是「查询」） */
  /*
    摊平 → 筛选 → 排序。三步都作用在**行**上（行 = 任务 + 所属组路径），
    因为"所属组"是摊平时才有的派生值，光拿 Task 筛不到它。

    其它三个视图要的是 Task[]，从行上取回（filteredTasks）——
    它们不显示层级，用行反而多一层。
  */
  /*
    流程配置（自定义状态与流转）。store.flow 由 normalizeStore 保证存在 ——
    缺字段的老文件给的是默认那套，行为与以前完全一致。
  */
  const flow = store ? store.flow : DEFAULT_FLOW;
  const statusIds = flow.statuses.map((s) => s.id);

  const flatRows = useMemo(() => flattenTasks(store ? store.tasks : []), [store]);
  const filteredRows = useMemo(
    () => filterTasksByColumns(flatRows, colFilters, q),
    [flatRows, colFilters, q],
  );
  const filtered = useMemo(() => filteredRows.map((r) => r.task), [filteredRows]);
  /*
    看板的列 = 用户配了几个状态就有几列。
    写死五列的话，用户新增的状态在看板上根本没有落脚的地方 ——
    那些任务会"消失"（不在任何一列里）。
  */
  const byColumn = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const s of flow.statuses) map[s.id] = [];
    if (store) {
      const list = sortTasks(filtered);
      for (const t of list) {
        if (!map[t.status]) map[t.status] = [];   // 配置里没有的状态也要有地方放
        map[t.status].push(t);
      }
    }
    return map;
  }, [store, filtered, flow]);
  const listRows = useMemo(
    () => sortRowsBy(filteredRows, sort.field, sort.dir),
    [filteredRows, sort],
  );

  /* ---------- 列级筛选的操作 ---------- */
  const activeCols = useMemo(() => activeColFilters(colFilters), [colFilters]);

  const setColFilter = (field: SortField, f: ColFilter) => {
    setColFilters((prev) => ({ ...prev, [field]: f }));
  };
  const clearColFilter = (field: SortField) => {
    setColFilters((prev) => {
      const next: Partial<Record<SortField, ColFilter>> = { ...prev };
      delete next[field];
      return next;
    });
  };
  const clearAllFilters = () => {
    setColFilters({});
    setQ('');
  };
  const filteredOn = activeCols.length > 0 || q.trim() !== '';
  /* 分组视图要的是 Task[]（它自己按字段聚合，不看层级） */
  const groups = useMemo(
    () => groupTasks(listRows.map((r) => r.task), groupBy),
    [listRows, groupBy],
  );
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

  const doMergeGroup = (ids: string[], title: string) =>
    withErr(async () => {
      if (!cfg || ids.length === 0) return;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const r = mergeIntoGroup(st.tasks, ids, title || '新任务组');
        return { ...st, tasks: r.tasks };
      });
      setChecked(new Set());
      await refresh();
      ctx.toast(`已把 ${ids.length} 条合并成「${title}」`, 'ok');
    })();

  const doNewGroup = (title: string) =>
    withErr(async () => {
      if (!cfg) return;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const r = createGroup(st.tasks, title || '新任务组');
        return { ...st, tasks: r.tasks };
      });
      await refresh();
      ctx.toast(`已新建组「${title}」`, 'ok');
    })();

  const doDissolveGroup = (groupId: string) =>
    withErr(async () => {
      if (!cfg) return;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const r = dissolveGroup(st.tasks, groupId);
        return { ...st, tasks: r.tasks };
      });
      await refresh();
    })();

  /*
    存流程配置。整份覆盖（不像任务那样逐条合并）——
    配置是"当前应该是什么样"，不是"谁改了哪一条"，
    逐条合并反而会把"删掉一个状态"合并回成"还在"。
  */
  const doSaveFlow = (next: TaskFlow) =>
    withErr(async () => {
      if (!cfg) return;
      await S.mutate(ctx, cfg.dataDir, (st) => ({ ...st, flow: normalizeFlow(next) }));
      await refresh();
      ctx.toast('流程已保存', 'ok');
    })();

  const doSplit = (id: string, titles: string[]) =>
    withErr(async () => {
      if (!cfg || titles.length === 0) return;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const r = splitTask(st.tasks, id, titles);
        return { ...st, tasks: r.tasks };
      });
      await refresh();
      ctx.toast(`已拆成 ${titles.length} 条子任务`, 'ok');
    })();

  /*
    标签定义落在 store.tagDefs（任务上只存 id）。
    颜色改一处、所有挂这个标签的行一起变 —— 这是"标签"该有的行为，
    逐行不同色就丢掉了"一眼分类"这个作用。
  */
  const doAddTag = (name: string, color: string) =>
    withErr(async () => {
      if (!cfg || !name.trim()) return;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const defs = Array.isArray(st.tagDefs) ? [...st.tagDefs] : [];
        if (defs.some((d) => d.name === name.trim())) return null;   // 同名不重复建
        const id = `tg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        defs.push({ id, name: name.trim(), color });
        return { ...st, tagDefs: defs };
      });
      await refresh();
    })();

  const doSetTagColor = (id: string, color: string) =>
    withErr(async () => {
      if (!cfg || !id) return;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const defs = Array.isArray(st.tagDefs) ? [...st.tagDefs] : [];
        /* 标签还没建过（任务上直接写了个裸名字）→ 补一条定义 */
        const idx = defs.findIndex((d) => d.id === id);
        if (idx < 0) defs.push({ id, name: id, color });
        else defs[idx] = { ...defs[idx], color };
        return { ...st, tagDefs: defs };
      });
      await refresh();
    })();

  /*
    改字段（说明 / 所属组 / 前置）。

    与流转分开：流转走 applyTransition（有状态机校验、要写历史），
    这几个字段是纯编辑 —— 走状态机会把"改一句话说明"也记成一次状态变更，
    历史里全是噪音，反而看不出真正的流转。
  */
  const doPatch = (id: string, patch: Partial<Task>) =>
    withErr(async () => {
      if (!cfg) return;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const idx = st.tasks.findIndex((t) => t.id === id);
        if (idx < 0) return null;
        const tasks = [...st.tasks];
        tasks[idx] = { ...tasks[idx], ...patch, updatedAt: Date.now() };
        return { ...st, tasks };
      });
      await refresh();
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
          {/*
            顶栏**只留身份与全局搜索**。
            优先级 / 标签 / 认领那三个下拉移到各自列头上了 ——
            留在这儿的话，"筛哪件事"取决于顶栏摆了哪几个框，
            而没摆上去的列（创建时间、ID）就永远筛不了。
          */}
          <input
            className="tb-search"
            placeholder="搜索标题 / 详情 / id"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button
            className={'tb-svc' + (serviceOn ? ' on' : '')}
            title={serviceOn ? `API 在线 127.0.0.1:${cfg.port}（点击停止）` : 'API 未启动（点击启动）'}
            onClick={toggleService}
          >
            ●
          </button>
          <button
            className="tb-act"
            onClick={() => setFlowOpen(true)}
            title="自定义状态、流转与按钮文案"
          >
            流程设置
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
          {/*
            排序**不在顶栏摆下拉** —— 列表每一列的表头都能点排序，
            顶栏再放一个只会让人以为"只能在这儿选那七个"。
            这里只把当前排序**显示**出来（分组视图也吃同一个排序状态，
            不显示的话切过去顺序变了却看不出为什么）。
          */}
          <span className="tb-views-sort" title="点列表表头可改排序">
            排序：{sortLabel(sort.field)} {sort.dir === 'asc' ? '↑' : '↓'}
          </span>
          <span className="tb-views-count" title="当前筛选命中 / 总任务">
            {filtered.length} / {store.tasks.length}
          </span>
          <button className="tb-act sm" onClick={clearAllFilters} disabled={!filteredOn} title="清除所有列上的筛选与搜索">
            重置
          </button>
        </div>
      </div>

      {/*
        已生效的筛选列成 chip。
        筛选一旦分散到各列，就没人知道"现在到底筛了什么" ——
        列头漏斗只能一个一个点开看。集中显示在这里，
        且每个 chip 能单独摘掉。
      */}
      {activeCols.length > 0 ? (
        <div className="tb-chips">
          {activeCols.map((c) => {
            const f = colFilters[c.field] as ColFilter;
            return (
              <span key={c.field} className="tb-chip">
                {c.label}：{filterSummary(c, f)}
                <button
                  type="button"
                  className="tb-chip-x"
                  onClick={() => clearColFilter(c.field)}
                  title={`清除「${c.label}」的筛选`}
                >
                  ✕
                </button>
              </span>
            );
          })}
          {view !== 'list' ? (
            /*
              筛选入口在列表的列头上，但四视图**共用同一份筛选结果**。
              所以在别的视图里看到"3/20"却找不到地方改 —— 给一个跳转，
              否则用户只能干瞪着命中数，以为筛选坏了。
            */
            <button
              type="button"
              className="tb-act sm"
              onClick={() => changeView('list')}
              title="按列筛选（在列表视图的列头上）"
            >
              去列表筛选
            </button>
          ) : null}
        </div>
      ) : null}

      {/* 看板：一列一个状态（列是用户配的，不是写死五列） */}
      {view === 'board' && (
        <div className="tb-board">
          {flow.statuses.map((sd) => (
            <section key={sd.id} className="tb-col">
              <header className="tb-col-head">
                <span className="tb-col-dot" style={{ background: sd.color }} />
                {sd.name}
                <span className="tb-col-num">{(byColumn[sd.id] || []).length}</span>
              </header>
              <div className="tb-col-body">
                {(byColumn[sd.id] || []).length === 0 && <div className="tb-col-empty">空</div>}
                {(byColumn[sd.id] || []).map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    me={me}
                    flow={flow}
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
        <ListView
          rows={listRows}
          allRows={flatRows}
          store={store.tasks}
          flow={flow}
          statusIds={statusIds}
          tagDefs={store.tagDefs}
          onCreateTag={doAddTag}
          onTagColor={doSetTagColor}
          checked={checked}
          onCheck={(id, on) => setChecked((prev) => {
            const next = new Set(prev);
            if (on) next.add(id); else next.delete(id);
            return next;
          })}
          onNewGroup={() => setGroupDraft({ mode: 'new' })}
          onMerge={() => setGroupDraft({ mode: 'merge' })}
          sort={sort}
          filters={colFilters}
          onSort={changeSort}
          onFilter={setColFilter}
          onClearFilter={clearColFilter}
          onOpen={(id) => setDetailId(id)}
        />
      )}

      {/* 分组：按一个字段聚合，组内沿用当前排序 */}
      {view === 'group' && (
        <GroupView
          groups={groups}
          groupBy={groupBy}
          flow={flow}
          me={me}
          onOpen={(id) => setDetailId(id)}
          onAction={(id, to, needNote) => (needNote ? setRejectFor({ id }) : doTransition(id, to))}
          onClaim={(id) => doClaim(id)}
        />
      )}

      {/* 统计：看全量，不受顶部筛选影响 */}
      {view === 'stats' && stats && (
        <StatsView stats={stats} flow={flow} onOpen={(id) => setDetailId(id)} />
      )}

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
      {flowOpen && store ? (
        <FlowSettingsModal
          flow={flow}
          tasks={store.tasks}
          onClose={() => setFlowOpen(false)}
          onSave={(next) => {
            setFlowOpen(false);
            doSaveFlow(next);
          }}
        />
      ) : null}

      {groupDraft ? (
        <GroupNameModal
          mode={groupDraft.mode}
          count={checked.size}
          onClose={() => setGroupDraft(null)}
          onOk={(title) => {
            const mode = groupDraft.mode;
            setGroupDraft(null);
            if (mode === 'merge') doMergeGroup([...checked], title);
            else doNewGroup(title);
          }}
        />
      ) : null}

      {detail && (
        <DetailModal
          task={detail}
          me={me}
          tasks={store.tasks}
          tagDefs={store.tagDefs}
          flow={flow}
          onClose={() => setDetailId(null)}
          onComment={(note) => doComment(detail.id, note)}
          onDelete={() => doDelete(detail.id)}
          onAction={(to, needNote) => (needNote ? setRejectFor({ id: detail.id }) : doTransition(detail.id, to))}
          onClaim={() => doClaim(detail.id)}
          onPatch={(patch) => doPatch(detail.id, patch)}
          onOpen={(id) => setDetailId(id)}
          onDissolve={(id) => {
            doDissolveGroup(id);
            setDetailId(null);
          }}
          onSplit={(id, titles) => doSplit(id, titles)}
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
  flow,
  onOpen,
  onAction,
  onClaim,
}: {
  task: Task;
  me: string;
  flow: FlowLike;
  onOpen: () => void;
  onAction: (to: TaskStatus, needNote?: boolean) => void;
  onClaim: () => void;
}) {
  const acts = actionsForIn(flow, task.status);
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

/* ================================================================ 展示件 */

/** 由同一个色相算出浅底/深字/描边 —— 不另存一套浅色版 */
function tintOf(hex: string): { bg: string; fg: string; bd: string } {
  return {
    bg: `color-mix(in srgb, ${hex} 16%, transparent)`,
    fg: `color-mix(in srgb, ${hex} 78%, var(--text))`,
    bd: `color-mix(in srgb, ${hex} 42%, transparent)`,
  };
}

/**
 * 标签。
 *
 * 样式参考腾讯文档智能表：小圆角（不是全圆胶囊 —— 全圆在窄列里会挤掉
 * 两个字的空间）、浅底深字 + 同色描边。一眼能分类，
 * 又不像实心块那样糊成一片。
 */
function TagChip({ id, defs }: { id: string; defs: TagDef[] }) {
  const d = defs.find((x) => x.id === id);
  const name = d ? d.name : id;
  const color = d ? d.color : '#78716c';
  const t = tintOf(color);
  return (
    <span
      className="tb-tag"
      style={{ background: t.bg, color: t.fg, borderColor: t.bd }}
      title={name}
    >
      {name}
    </span>
  );
}

/** 被卡住的原因要说得清，否则用户只能看到一把锁，不知道在等谁 */
function lockTitle(lock: { pending: string[]; missing: string[]; cyclic: boolean }): string {
  const parts: string[] = [];
  if (lock.cyclic) parts.push('前置互相依赖成环，永远等不到解锁');
  if (lock.missing.length > 0) parts.push(`前置不存在（可能已被删除）：${lock.missing.join('、')}`);
  if (lock.pending.length > 0) parts.push(`等 ${lock.pending.length} 个前置完成：${lock.pending.join('、')}`);
  return parts.join('；') || '被前置任务卡住';
}

/* ================================================================ 流程设置 */

/**
 * 流程设置：增删改状态、调色、设流转、改按钮文案。
 *
 * 状态是**用户自己的**，不是这份工具预设的五个 ——
 * 不同团队的流程差得很远（有的要评审、有的要验收、有的有"挂起"），
 * 写死就只能靠标签和备注去凑，凑出来的东西筛不了也统计不了。
 */
function FlowSettingsModal({
  flow, tasks, onClose, onSave,
}: {
  flow: TaskFlow;
  /** 全量任务：判断某个状态里还有没有任务（有就不能删） */
  tasks: Task[];
  onClose: () => void;
  onSave: (next: TaskFlow) => void;
}) {
  const [draft, setDraft] = useState<TaskFlow>(() => ({
    statuses: flow.statuses.map((s) => ({ ...s })),
    transitions: Object.fromEntries(
      Object.keys(flow.transitions).map((k) => [k, [...flow.transitions[k]]]),
    ),
    edges: Object.fromEntries(
      Object.keys(flow.edges).map((k) => [k, { ...flow.edges[k] }]),
    ),
  }));
  const [newName, setNewName] = useState('');

  const ids = draft.statuses.map((s) => s.id);
  const usedCount = (id: string) => tasks.filter((t) => t.status === id).length;

  const patchStatus = (id: string, patch: Partial<StatusDef>) => {
    setDraft((d) => ({
      ...d,
      statuses: d.statuses.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    }));
  };

  const toggleEdge = (from: string, to: string) => {
    setDraft((d) => {
      const cur = d.transitions[from] || [];
      const next = cur.includes(to) ? cur.filter((x) => x !== to) : [...cur, to];
      return { ...d, transitions: { ...d.transitions, [from]: next } };
    });
  };

  const moveStatus = (i: number, delta: number) => {
    setDraft((d) => {
      const j = i + delta;
      if (j < 0 || j >= d.statuses.length) return d;
      const list = [...d.statuses];
      const [one] = list.splice(i, 1);
      list.splice(j, 0, one);
      return { ...d, statuses: list };
    });
  };

  const addStatus = () => {
    const name = newName.trim();
    if (!name) return;
    /* id 用名字的拼音不行（没那个库），用稳定后缀 + 序号，用户可在下面改名 */
    let id = `s${draft.statuses.length + 1}`;
    while (ids.includes(id)) id += '_';
    setDraft((d) => ({
      ...d,
      statuses: [...d.statuses, {
        id, name, color: TAG_COLORS[d.statuses.length % TAG_COLORS.length], enter: `标为「${name}」`, done: false,
      }],
    }));
    setNewName('');
  };

  const removeStatus = (id: string) => {
    if (usedCount(id) > 0) return;   // 按钮已禁用，这里是双保险
    setDraft((d) => ({
      statuses: d.statuses.filter((s) => s.id !== id),
      transitions: Object.fromEntries(
        Object.keys(d.transitions)
          .filter((k) => k !== id)
          .map((k) => [k, (d.transitions[k] || []).filter((x) => x !== id)]),
      ),
      edges: Object.fromEntries(
        Object.keys(d.edges).filter((k) => !k.startsWith(`${id}>`) && !k.endsWith(`>${id}`))
          .map((k) => [k, d.edges[k]]),
      ),
    }));
  };

  /* 所有已开启的边 —— 按钮文案与"要不要填原因"在这里逐条设 */
  const liveEdges: { from: string; to: string }[] = [];
  for (const from of ids) {
    for (const to of draft.transitions[from] || []) {
      if (from !== to && ids.includes(to)) liveEdges.push({ from, to });
    }
  }

  const nameOf = (id: string) => (draft.statuses.find((s) => s.id === id) || { name: id }).name;

  return (
    <Modal title="流程设置" onClose={onClose} wide>
      <section className="tb-flow-sec">
        <header className="tb-flow-head">状态（顺序 = 看板列顺序，第一个是新建任务的初始态）</header>
        {draft.statuses.map((st, i) => {
          const used = usedCount(st.id);
          return (
            <div key={st.id} className="tb-flow-row">
              <span className="tb-flow-swatches">
                {TAG_COLORS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    className={'tb-swatch' + (st.color === c ? ' on' : '')}
                    style={{ background: c }}
                    title={`把「${st.name}」改成这个颜色`}
                    onClick={() => patchStatus(st.id, { color: c })}
                  />
                ))}
              </span>
              <input
                className="tb-flow-name"
                value={st.name}
                onChange={(e) => patchStatus(st.id, { name: e.target.value })}
              />
              <input
                className="tb-flow-enter"
                value={st.enter}
                title="进入这个状态时按钮上写什么"
                onChange={(e) => patchStatus(st.id, { enter: e.target.value })}
              />
              <label className="tb-flow-done" title="依赖它的任务在这个状态下算解锁">
                <input
                  type="checkbox"
                  checked={st.done}
                  onChange={(e) => patchStatus(st.id, { done: e.target.checked })}
                />
                算完成
              </label>
              <span className="tb-flow-ops">
                <button type="button" className="tb-act sm" disabled={i === 0} onClick={() => moveStatus(i, -1)}>↑</button>
                <button type="button" className="tb-act sm" disabled={i === draft.statuses.length - 1} onClick={() => moveStatus(i, 1)}>↓</button>
                <button
                  type="button"
                  className="tb-act sm warn"
                  disabled={used > 0}
                  title={used > 0 ? `还有 ${used} 条任务处于此状态，先转走才能删` : '删除这个状态'}
                  onClick={() => removeStatus(st.id)}
                >
                  删除
                </button>
              </span>
              {used > 0 ? <span className="tb-flow-used">{used} 条在用</span> : null}
            </div>
          );
        })}
        <div className="tb-flow-row">
          <input
            className="tb-flow-name"
            value={newName}
            placeholder="新状态名…"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (!isComposing(e.nativeEvent) && e.key === 'Enter') addStatus();
            }}
          />
          <button type="button" className="tb-act sm" onClick={addStatus}>＋ 加状态</button>
        </div>
      </section>

      <section className="tb-flow-sec">
        <header className="tb-flow-head">流转（每行 = 从这个状态能走到哪）</header>
        <div className="tb-flow-matrix">
          <div className="tb-flow-mrow">
            <span className="tb-flow-mcorner" />
            {ids.map((id) => (
              <span key={id} className="tb-flow-mhead" title={nameOf(id)}>{nameOf(id)}</span>
            ))}
          </div>
          {ids.map((from) => (
            <div key={from} className="tb-flow-mrow">
              <span className="tb-flow-mrowhead" title={nameOf(from)}>{nameOf(from)}</span>
              {ids.map((to) => (
                <span key={to} className="tb-flow-mcell">
                  {from === to ? (
                    <span className="tb-flow-mself">—</span>
                  ) : (
                    <input
                      type="checkbox"
                      checked={(draft.transitions[from] || []).includes(to)}
                      onChange={() => toggleEdge(from, to)}
                      title={`${nameOf(from)} → ${nameOf(to)}`}
                    />
                  )}
                </span>
              ))}
            </div>
          ))}
        </div>
      </section>

      <section className="tb-flow-sec">
        <header className="tb-flow-head">按钮文案（默认用「进入那个状态」的动词，特殊的边在这里改）</header>
        <div className="tb-flow-edges">
          {liveEdges.length === 0 ? (
            <span className="tb-flow-hint">还没开任何流转 —— 上面矩阵里勾选后这里才有东西</span>
          ) : liveEdges.map(({ from, to }) => {
            const key = `${from}>${to}`;
            const e = draft.edges[key] || { label: '', note: false };
            const fallback = (draft.statuses.find((s) => s.id === to) || { enter: '' }).enter;
            return (
              <div key={key} className="tb-flow-erow">
                <span className="tb-flow-ename">{nameOf(from)} → {nameOf(to)}</span>
                <input
                  className="tb-flow-elabel"
                  value={e.label}
                  placeholder={fallback}
                  onChange={(ev) => setDraft((d) => ({
                    ...d, edges: { ...d.edges, [key]: { ...e, label: ev.target.value } },
                  }))}
                />
                <label className="tb-flow-enote" title="勾选后走这条边必须填原因">
                  <input
                    type="checkbox"
                    checked={e.note}
                    onChange={(ev) => setDraft((d) => ({
                      ...d, edges: { ...d.edges, [key]: { ...e, note: ev.target.checked } },
                    }))}
                  />
                  需填原因
                </label>
              </div>
            );
          })}
        </div>
      </section>

      <div className="tb-macts">
        <span className="tb-flex" />
        <button className="tb-act sm" onClick={onClose}>取消</button>
        <button
          className="tb-act sm primary"
          disabled={draft.statuses.length === 0 || draft.statuses.some((x) => !x.name.trim())}
          onClick={() => onSave(draft)}
        >
          保存
        </button>
      </div>
      <p className="tb-hint">
        已取消默认**不算**完成 —— 依赖它的任务会继续卡住并提示人来处理，
        而不是悄悄解锁让人以为上游已经交付。想让它算完成就勾上「算完成」。
      </p>
    </Modal>
  );
}

/**
 * 组名弹窗。新建组与合并成组共用 ——
 * 两件事的差别只是"要不要带上已勾选的任务"，界面完全一样。
 */
function GroupNameModal({
  mode, count, onClose, onOk,
}: {
  mode: 'merge' | 'new';
  count: number;
  onClose: () => void;
  onOk: (title: string) => void;
}) {
  const [title, setTitle] = useState('');
  return (
    <Modal title={mode === 'merge' ? `合并 ${count} 条为一个任务组` : '新建任务组'} onClose={onClose}>
      <div className="tb-mfield">
        <span>组名</span>
        <input
          autoFocus
          value={title}
          placeholder="例如：账户体系"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            /* 输入法守卫：中文输入时回车是上屏，不是提交 */
            if (!isComposing(e.nativeEvent) && e.key === 'Enter' && title.trim()) onOk(title.trim());
          }}
        />
      </div>
      <div className="tb-macts">
        <span className="tb-flex" />
        <button className="tb-act sm" onClick={onClose}>取消</button>
        <button
          className="tb-act sm primary"
          disabled={!title.trim()}
          onClick={() => onOk(title.trim())}
        >
          {mode === 'merge' ? '合并' : '新建'}
        </button>
      </div>
      {mode === 'merge' ? (
        <p className="tb-hint">
          组里还能再建组 —— 合并出来的这个组可以再挂到别的组下面。
        </p>
      ) : null}
    </Modal>
  );
}

/* ================================================================ 列表视图 */

/**
 * 筛选项的显示文案。
 *
 * core.mjs 只给**值**（它刻意不抄 STATUS_LABEL / PRIORITY_LABEL），
 * 映射在这一处完成 —— 列头的下拉、已生效筛选的摘要都用同一份，
 * 否则同一个值在两个地方说法不一样。
 */
function optionLabel(field: SortField, v: string): string {
  if (field === 'priority') return `${v} ${PRIORITY_LABEL[v as Priority] || ''}`.trim();
  if (field === 'status') return STATUS_LABEL[v as TaskStatus] || v;
  if (field === 'assignee') return v || '未认领';
  return v;
}

/** 已生效筛选的一句摘要，写在 chip 上 */
function filterSummary(col: ListColumn, f: ColFilter): string {
  if (col.kind === 'enum') {
    return f.values.map((v) => optionLabel(col.field, v)).join('、');
  }
  if (col.kind === 'text') return f.text.trim();
  const lo = f.min.trim();
  const hi = f.max.trim();
  if (lo && hi) return `${lo} ~ ${hi}`;
  if (lo) return `${lo} 起`;
  return `至 ${hi}`;
}

/**
 * 列头的筛选面板。
 *
 * 开在**单元格里**而不是弹到别处：弹到设置页或顶栏的话，
 * 改完要回来找刚才那一列在哪；而这里是"点哪列筛哪列"，位置自解释。
 *
 * 末尾几列贴右边展开 —— 表比容器宽（要横向滚动），
 * 从左边展开的话大半会落到可视区外面。
 */
function ColFilterPop({
  col, filter, options, onChange, onClear, anchorRight, tagDefs, onCreateTag, onTagColor,
}: {
  col: ListColumn;
  filter: ColFilter;
  options: string[];
  onChange: (f: ColFilter) => void;
  onClear: () => void;
  anchorRight?: boolean;
  /** 标签定义。只标签列用得到 */
  tagDefs?: TagDef[];
  /** 新建标签（名字 + 颜色）。返回后由调用方把它挂到当前行 */
  onCreateTag?: (name: string, color: string) => void;
  /** 改某个标签的颜色 */
  onTagColor?: (id: string, color: string) => void;
}) {
  const set = (patch: Partial<ColFilter>) => onChange({ ...filter, ...patch });
  const cls = 'tb-lpop' + (anchorRight ? ' is-right' : '');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[6]);
  const colorOf = (id: string) => (tagDefs || []).find((d) => d.id === id)?.color || '';

  if (col.kind === 'enum') {
    const isTag = col.field === 'tags';
    return (
      <div className={cls} onClick={(e) => e.stopPropagation()}>
        <div className="tb-lpop-title">按{col.label}筛选</div>
        {options.length === 0 ? (
          <div className="tb-lpop-hint">这一列当前没有可选的值</div>
        ) : (
          options.map((v) => {
            const on = filter.values.indexOf(v) >= 0;
            return (
              <div key={v || '__none__'} className="tb-lpop-item">
                <label className="tb-lpop-pick">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={() => set({
                      values: on ? filter.values.filter((x) => x !== v) : [...filter.values, v],
                    })}
                  />
                  <span>{optionLabel(col.field, v)}</span>
                </label>
                {/*
                  标签列才给调色。
                  颜色是标签**定义**的一部分（不是这一行的事），
                  所以改一处、所有挂这个标签的行一起变 ——
                  做成逐行改色的结果就是同一个标签在不同行颜色不同，
                  那就丢掉了"一眼分类"这个作用。
                */}
                {isTag && onTagColor ? (
                  <span className="tb-lpop-swatches">
                    {TAG_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={'tb-swatch' + (colorOf(v) === c ? ' on' : '')}
                        style={{ background: c }}
                        title={`把「${optionLabel(col.field, v)}」改成这个颜色`}
                        onClick={() => onTagColor(v, c)}
                      />
                    ))}
                  </span>
                ) : null}
              </div>
            );
          })
        )}
        {isTag && onCreateTag ? (
          <div className="tb-lpop-new">
            <input
              className="tb-lpop-input"
              value={newName}
              placeholder="新建标签…"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (!isComposing(e.nativeEvent) && e.key === 'Enter' && newName.trim()) {
                  onCreateTag(newName.trim(), newColor);
                  setNewName('');
                }
              }}
            />
            <div className="tb-lpop-swatches">
              {TAG_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={'tb-swatch' + (newColor === c ? ' on' : '')}
                  style={{ background: c }}
                  title={`新标签用这个颜色`}
                  onClick={() => setNewColor(c)}
                />
              ))}
            </div>
          </div>
        ) : null}
        <div className="tb-lpop-foot">
          <span className="tb-lpop-hint">不选 = 不限</span>
          <button type="button" className="tb-act sm" onClick={onClear}>清除</button>
        </div>
      </div>
    );
  }

  if (col.kind === 'text') {
    return (
      <div className={cls} onClick={(e) => e.stopPropagation()}>
        <div className="tb-lpop-title">按{col.label}筛选</div>
        <input
          className="tb-lpop-input"
          value={filter.text}
          placeholder="包含关键词"
          onChange={(e) => set({ text: e.target.value })}
        />
        <div className="tb-lpop-foot">
          <span className="tb-lpop-hint">不区分大小写</span>
          <button type="button" className="tb-act sm" onClick={onClear}>清除</button>
        </div>
      </div>
    );
  }

  return (
    <div className={cls} onClick={(e) => e.stopPropagation()}>
      <div className="tb-lpop-title">按{col.label}筛选</div>
      <div className="tb-lpop-row">
        <input
          className="tb-lpop-date"
          type="date"
          value={filter.min}
          onChange={(e) => set({ min: e.target.value })}
        />
        <span className="tb-lpop-hint">~</span>
        <input
          className="tb-lpop-date"
          type="date"
          value={filter.max}
          onChange={(e) => set({ max: e.target.value })}
        />
      </div>
      <div className="tb-lpop-foot">
        <span className="tb-lpop-hint">只填一边也行</span>
        <button type="button" className="tb-act sm" onClick={onClear}>清除</button>
      </div>
    </div>
  );
}

function ListView({
  rows,
  allRows,
  store,
  flow,
  statusIds,
  tagDefs,
  onCreateTag,
  onTagColor,
  checked,
  onCheck,
  onNewGroup,
  onMerge,
  sort,
  filters,
  onSort,
  onFilter,
  onClearFilter,
  onOpen,
}: {
  rows: FlatRow[];
  /** 全量（未筛）的行。筛选项从它去重 —— 用过滤后的会漏掉已被筛掉的值 */
  allRows: FlatRow[];
  /** 全量任务，用于算前置锁定 */
  store: Task[];
  flow: FlowLike;
  /** 状态筛选的候选值（用户配了哪些状态） */
  statusIds: string[];
  /** 标签定义（名字 + 颜色） */
  tagDefs: TagDef[];
  onCreateTag: (name: string, color: string) => void;
  onTagColor: (id: string, color: string) => void;
  checked: Set<string>;
  onCheck: (id: string, on: boolean) => void;
  onNewGroup: () => void;
  onMerge: () => void;
  sort: { field: SortField; dir: 'asc' | 'desc' };
  filters: Partial<Record<SortField, ColFilter>>;
  onSort: (field: SortField) => void;
  onFilter: (field: SortField, f: ColFilter) => void;
  onClearFilter: (field: SortField) => void;
  onOpen: (id: string) => void;
}) {
  const [openCol, setOpenCol] = useState<SortField | ''>('');

  /*
    点面板外关闭。
    面板开在表头单元格里，所以点那个单元格（含漏斗按钮自身）不算"外面" ——
    否则点一下关、再点一下又开，看起来像按钮坏了。
  */
  useEffect(() => {
    if (!openCol) return;
    const onDown = (e: MouseEvent) => {
      const el = document.getElementById('tb-lpop-host-' + openCol);
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setOpenCol('');
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [openCol]);

  const picked = [...checked].filter((id) => rows.some((r) => r.task.id === id));

  return (
    <div className="tb-list">
      {/*
        组的两个入口。
        「新建组」常驻（先建好再把任务指派进去，是常见路径）；
        「合并为组」只在勾了东西时出现 —— 没勾还摆着，
        点下去只会得到一个空组，那是个没用的按钮。
      */}
      <div className="tb-ltools">
        <button type="button" className="tb-act sm" onClick={onNewGroup}>
          ＋ 新建组
        </button>
        {picked.length > 0 ? (
          <>
            <button type="button" className="tb-act sm primary" onClick={onMerge}>
              合并 {picked.length} 条为组
            </button>
            <button
              type="button"
              className="tb-act sm"
              onClick={() => { for (const id of picked) onCheck(id, false); }}
            >
              取消勾选
            </button>
          </>
        ) : (
          <span className="tb-ltools-hint">勾选几条后可合并为一个任务组</span>
        )}
      </div>
      <div className="tb-list-head tb-lgrid">
        {LIST_COLUMNS.map((c, ci) => {
          const f = filters[c.field];
          const on = colFilterActive(c, f);
          const isOpen = openCol === c.field;
          return (
            <div
              key={c.field}
              id={'tb-lpop-host-' + c.field}
              className={'tb-lhcell c-' + c.field}
            >
              <button
                className={'tb-lh' + (sort.field === c.field ? ' on' : '')}
                title={`按${c.label}排序（再次点击切换方向）`}
                onClick={() => onSort(c.field)}
              >
                {c.label}
                <span className="tb-lh-dir">{sort.field === c.field ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}</span>
              </button>
              <button
                className={'tb-lfunnel' + (on ? ' on' : '') + (isOpen ? ' open' : '')}
                title={`按${c.label}筛选`}
                onClick={() => setOpenCol(isOpen ? '' : c.field)}
              >
                ⛏
              </button>
              {isOpen ? (
                <ColFilterPop
                  col={c}
                  filter={f || emptyColFilter()}
                  options={colFilterValues(c.field, allRows, statusIds)}
                  onChange={(nf) => onFilter(c.field, nf)}
                  onClear={() => onClearFilter(c.field)}
                  anchorRight={ci >= LIST_COLUMNS.length - 3}
                  tagDefs={tagDefs}
                  onCreateTag={onCreateTag}
                  onTagColor={onTagColor}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <div className="tb-list-body">
        {rows.length === 0 && <div className="tb-col-empty">没有符合条件的任务</div>}
        {rows.map((row) => {
          const t = row.task;
          const lock = lockOf(t, store);
          return (
          <div key={t.id} className="tb-lrow tb-lgrid" onClick={() => onOpen(t.id)} title="点击查看详情">
            <label className="tb-lpick" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={checked.has(t.id)}
                onChange={(e) => onCheck(t.id, e.target.checked)}
              />
            </label>
            <span className="tb-lc c-priority">
              <PriorityBadge p={t.priority} />
            </span>
            <span className="tb-lc c-id">{t.id}</span>
            <span className="tb-lc c-title">
              {lock.locked ? (
                <span
                  className="tb-lock"
                  title={lockTitle(lock)}
                >
                  🔒
                </span>
              ) : null}
              <span className="tb-ltitle">{t.title}</span>
              {t.tags.length > 0 && (
                <span className="tb-ltags">
                  {t.tags.map((tag) => (
                    <TagChip key={tag} id={tag} defs={tagDefs} />
                  ))}
                </span>
              )}
            </span>
            <span className="tb-lc c-groupPath" title={row.groupPath}>
              {row.groupPath ? (
                <span style={{ paddingInlineStart: row.depth * 8 }}>{row.groupPath}</span>
              ) : (
                <span className="tb-ldim">—</span>
              )}
            </span>
            <span className="tb-lc c-status">
              <span className="tb-col-dot" style={{ background: statusColor(flow, t.status) }} />
              {statusName(flow, t.status)}
            </span>
            <span className="tb-lc c-assignee">{t.assignee ? '@' + t.assignee : '未认领'}</span>
            <span className="tb-lc c-tags">
              {t.tags.length > 0 ? (
                <span className="tb-ltags">
                  {t.tags.map((tag) => (
                    <TagChip key={tag} id={tag} defs={tagDefs} />
                  ))}
                </span>
              ) : (
                <span className="tb-ldim">—</span>
              )}
            </span>
            <span className="tb-lc c-summary" title={t.summary}>
              {t.summary || <span className="tb-ldim">—</span>}
            </span>
            <span className="tb-lc c-createdAt" title={fmtTime(t.createdAt)}>
              {t.createdAt ? relTime(t.createdAt) : <span className="tb-ldim">—</span>}
            </span>
            <span className="tb-lc c-updatedAt" title={fmtTime(t.updatedAt)}>
              {relTime(t.updatedAt)}
            </span>
          </div>
          );
        })}
      </div>
    </div>
  );
}

/* ================================================================ 分组视图 */

function GroupView({
  flow,
  groups,
  groupBy,
  me,
  onOpen,
  onAction,
  onClaim,
}: {
  flow: FlowLike;
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
                flow={flow}
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

function BarRow({
  label, count, max, dot, color,
}: {
  label: string;
  count: number;
  max: number;
  dot?: string;
  color?: string;
}) {
  return (
    <div className="tb-bar-row">
      <span className="tb-bar-label">
        {(dot || color) && (
          <span className="tb-col-dot" style={color ? { background: color } : undefined}>
            {!color && dot ? null : null}
          </span>
        )}
        {label}
      </span>
      <span className="tb-bar-track">
        <span
          className="tb-bar-fill"
          style={{
            width: `${max > 0 ? Math.round((count / max) * 100) : 0}%`,
            background: color || undefined,
          }}
        />
      </span>
      <span className="tb-bar-num">{count}</span>
    </div>
  );
}

function StatsView({
  stats, flow, onOpen,
}: {
  stats: TbStats;
  flow: { statuses: { id: string; name: string; color: string }[] };
  onOpen: (id: string) => void;
}) {
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
          {flow.statuses.map((sd) => (
            <BarRow
              key={sd.id}
              label={sd.name}
              count={stats.byStatus[sd.id] || 0}
              max={maxStatus}
              color={sd.color}
            />
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
  tasks,
  tagDefs,
  flow,
  onClose,
  onComment,
  onDelete,
  onAction,
  onClaim,
  onPatch,
  onOpen,
  onDissolve,
  onSplit,
}: {
  task: Task;
  me: string;
  /** 全量任务：算所属组路径与前置锁定要用 */
  tasks: Task[];
  tagDefs: TagDef[];
  /** 流程配置（状态名/颜色/可用操作都由它决定） */
  flow: FlowLike;
  onClose: () => void;
  onComment: (note: string) => void;
  onDelete: () => void;
  onAction: (to: TaskStatus, needNote?: boolean) => void;
  onClaim: () => void;
  /** 打开另一条（点所属组名跳过去） */
  onOpen: (id: string) => void;
  /** 拆散这个组：组删掉，下面的任务上提一层 */
  onDissolve: (groupId: string) => void;
  /** 拆成子任务：原任务变成组，子任务挂在它下面 */
  onSplit: (id: string, titles: string[]) => void;
  /** 改字段（说明 / 所属组 / 前置） */
  onPatch: (patch: Partial<Task>) => void;
}) {
  const [note, setNote] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  /** 拆分输入框。null = 收起 */
  const [splitText, setSplitText] = useState<string | null>(null);
  const acts = actionsFor(task.status);
  const hist = [...task.history].reverse();

  const { byId, parentOf } = indexTasks(tasks);
  const chain = ancestorChain(task.id, parentOf);
  const groupPath = chain.map((id) => byId[id]?.title || id).join(' › ');
  const lock = lockOf(task, tasks);
  /* 可选的前置：排除自己、排除已成环的（选了就永远解锁不了） */
  const depChoices = tasks.filter((t) => t.id !== task.id && t.id !== task.parent);

  return (
    <Modal title={`${task.id} · ${task.title}`} onClose={onClose} wide>
      <div className="tb-dmeta">
        <PriorityBadge p={task.priority} />
        <span className="tb-dtag">状态：{statusName(flow, task.status)}</span>
        <span className="tb-dtag">报告人：{task.reporter}</span>
        <span className="tb-dtag">认领人：{task.assignee || '未认领'}</span>
        <span className="tb-dtag">更新：{fmtTime(task.updatedAt)}</span>
        <span className="tb-dtag">创建：{task.createdAt ? fmtTime(task.createdAt) : '—'}</span>
        {task.tags.map((tag) => (
          <TagChip key={tag} id={tag} defs={tagDefs} />
        ))}
      </div>

      {task.kind === 'group' ? (
        <div className="tb-dgroup">
          <span className="tb-dtag">
            组内有 {tasks.filter((t) => t.parent === task.id).length} 条直接成员
          </span>
          <span className="tb-dhint">
            状态由下面的任务推导：
            {groupStatus(task.id, tasks)
              ? statusName(flow, groupStatus(task.id, tasks) as string)
              : '（空组，没有状态）'}
          </span>
          <button
            type="button"
            className="tb-act sm warn"
            onClick={() => onDissolve(task.id)}
            title="删掉这个组，下面的任务上提一层（不会删任务）"
          >
            拆散组
          </button>
        </div>
      ) : (
        <div className="tb-dgroup">
          {splitText === null ? (
            <button
              type="button"
              className="tb-act sm"
              onClick={() => setSplitText('')}
              title="原任务变成组，下面挂你写的这几条子任务"
            >
              拆为子任务…
            </button>
          ) : (
            <>
              <input
                autoFocus
                className="tb-dinput"
                value={splitText}
                placeholder="子任务名，逗号分隔（如：表单,校验,跳转）"
                onChange={(e) => setSplitText(e.target.value)}
                onKeyDown={(e) => {
                  if (isComposing(e.nativeEvent)) return;
                  if (e.key === 'Escape') { setSplitText(null); return; }
                  if (e.key !== 'Enter') return;
                  const names = splitText.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
                  if (names.length === 0) return;
                  onSplit(task.id, names);
                  setSplitText(null);
                }}
              />
              <button
                type="button"
                className="tb-act sm primary"
                disabled={splitText.split(/[,，]/).map((x) => x.trim()).filter(Boolean).length === 0}
                onClick={() => {
                  const names = splitText.split(/[,，]/).map((x) => x.trim()).filter(Boolean);
                  if (names.length === 0) return;
                  onSplit(task.id, names);
                  setSplitText(null);
                }}
              >
                拆分
              </button>
              <button type="button" className="tb-act sm" onClick={() => setSplitText(null)}>
                取消
              </button>
            </>
          )}
          <span className="tb-dhint">
            拆完这条变成组，组的状态由子任务推导。子任务还能再拆。
          </span>
        </div>
      )}

      {/*
        任务说明与备注分开两栏：
        说明是"要做什么"（原始要求），备注是"过程中记的"。
        混一起的话做完没人清理说明，下次分不清哪些是原始要求。
      */}
      <div className="tb-dfield">
        <span className="tb-dlabel">任务说明</span>
        <input
          className="tb-dinput"
          value={task.summary || ''}
          placeholder="一句话说清这条要做什么"
          onChange={(e) => onPatch({ summary: e.target.value })}
        />
      </div>

      <div className="tb-dfield">
        <span className="tb-dlabel">所属组</span>
        <select
          className="tb-dinput"
          value={task.parent || ''}
          onChange={(e) => onPatch({ parent: e.target.value || null })}
        >
          <option value="">（不在任何组里）</option>
          {tasks.filter((t) => t.kind === 'group' && t.id !== task.id).map((g) => (
            <option key={g.id} value={g.id}>
              {g.title}
            </option>
          ))}
        </select>
        {task.parent ? (
          <button
            type="button"
            className="tb-act sm"
            onClick={() => onOpen(task.parent as string)}
          >
            打开「{byId[task.parent]?.title || task.parent}」
          </button>
        ) : null}
        {groupPath ? <span className="tb-dhint">路径：{groupPath}</span> : null}
      </div>

      <div className="tb-dfield">
        <span className="tb-dlabel">前置任务</span>
        <div className="tb-ddep-wrap">
          {(task.deps || []).map((d) => (
            <span key={d} className="tb-ddep">
              {byId[d]?.title || d}
              {!byId[d] ? <span className="tb-ddep-gone">（已删除）</span> : null}
              <button
                type="button"
                className="tb-ddep-x"
                onClick={() => onPatch({ deps: (task.deps || []).filter((x) => x !== d) })}
                title="移除这个前置"
              >
                ✕
              </button>
            </span>
          ))}
          <select
            className="tb-dinput"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (!v) return;
              if ((task.deps || []).indexOf(v) >= 0) return;
              onPatch({ deps: [...(task.deps || []), v] });
            }}
          >
            <option value="">＋ 添加前置…</option>
            {depChoices.map((t) => (
              <option key={t.id} value={t.id}>
                {(t.kind === 'group' ? '［组］' : '') + t.title}
              </option>
            ))}
          </select>
        </div>
        {lock.locked ? (
          <span className="tb-dhint warn">🔒 {lockTitle(lock)}</span>
        ) : (
          <span className="tb-dhint">未被前置卡住</span>
        )}
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
