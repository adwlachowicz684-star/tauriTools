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
import type { GroupNode } from './core';
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
  currentProject,
  needsDocsDir,
  normalizeStore,
  normalizeTypeDefs,
  DEFAULT_FLOW,
  dissolveGroup,
  flattenTasks,
  mergeIntoGroup,
  fmtTime,
  groupEstimate,
  groupStatus,
  groupTasksBy,
  indexTasks,
  fmtEstimate,
  initialStatus,
  lockOf,
  newDefId,
  NOTYPE,
  normalizeFlow,
  relTime,
  sortRowsBy,
  sortTasksBy,
  splitTask,
  statsOf,
  typeColor,
  typeName,
  UNESTIMATED,
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

const GROUP_KEYS: GroupKey[] = ['status', 'priority', 'assignee', 'type', 'tag'];

/** 分组依据的显示名（分组设置面板与面包屑共用） */
const GROUP_LABEL: Record<GroupKey, string> = {
  status: '状态',
  priority: '优先级',
  assignee: '认领人',
  type: '任务类型',
  tag: '标签',
};

/*
  流程配置的最小形状（组件只用到 statuses / transitions / edges）。
  typeDefs 挂在上面是为了少传一个参数：分组与状态显示都要它，
  而它和 flow 一样是"当前项目的配置"。
*/
type FlowLike = ReturnType<typeof normalizeFlow> & {
  typeDefs?: { id: string; name: string; color: string }[];
};

const SORT_FIELDS: SortField[] = [
  'priority', 'status', 'assignee', 'type', 'tags', 'groupPath', 'summary',
  'estimate', 'updatedAt', 'createdAt', 'title', 'id',
];

/** 分组 key → 展示名（label 只在这一处映射，core.mjs 不碰文案） */
function groupLabel(key: string, by: GroupKey, flow?: FlowLike): string {
  if (by === 'status') return statusName(flow, key);
  if (by === 'priority') return `${key} ${PRIORITY_LABEL[key as Priority] || ''}`.trim();
  if (by === 'type') return key === NOTYPE ? '未分类' : typeName(flow && flow.typeDefs, key);
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
  type: '类型',
  summary: '说明',
  estimate: '预估',
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
  /** 「还没设文档路径」的提醒条被手动关掉（仅本次会话） */
  const [docsHintClosed, setDocsHintClosed] = useState(false);
  /** 新建项目弹窗 */
  const [newProjOpen, setNewProjOpen] = useState(false);
  /** 导入项目弹窗 */
  const [importOpen, setImportOpen] = useState(false);
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
  /*
    分组依据：**有序多列**。数组顺序就是层级（第一个最外层）。
    原来是单选一列 —— 那样"按类型分、每个类型里再按状态看"要分两次做，
    而且第二次会把第一次的选择冲掉。
  */
  const [groupKeys, setGroupKeys] = useState<GroupKey[]>(['status']);
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
            ctx.store.get('groupKeys', ['status']),
            ctx.store.get('sort', { field: 'priority', dir: 'asc' }),
          ]);
          if (!alive) return;
          if (VIEWS.some((x) => x.key === v)) setView(v as TbView);
          /*
            存的是数组。老存档是单个字符串（'status'）→ 包成数组，
            否则升级后分组依据整个丢失、界面上说的是另一回事。
          */
          const arr = Array.isArray(g) ? g : [g];
          const ok = arr.filter((x) => GROUP_KEYS.includes(x as GroupKey)) as GroupKey[];
          if (ok.length > 0) setGroupKeys(ok);
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
    setDocsHintClosed(false);   // 换了项目/配置 → 提醒重新开始（那是另一件事）
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
  const flow = store ? { ...store.flow, typeDefs: store.typeDefs } : { ...DEFAULT_FLOW, typeDefs: normalizeTypeDefs(null) };
  const statusIds = flow.statuses.map((s) => s.id);
  const typeDefs = store ? store.typeDefs : [];
  const typeIds = typeDefs.map((d) => d.id);

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
      /*
        看板也跟随用户点的排序。
        原来这里用 sortTasks（写死"优先级 + 更新时间"）——
        于是列表里点了"按更新排"，切到看板顺序纹丝不动，
        而顶栏还写着"排序：更新 ↓"，看着像生效了，实际没有。
      */
      const list = sortTasksBy(filtered, sort.field, sort.dir);
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
    () => groupTasksBy(listRows.map((r) => r.task), groupKeys),
    [listRows, groupKeys],
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
  const changeGroupBy = (g: GroupKey[]) => {
    /*
      去重：同一列分两层没有意义（第二层每个组里只有一种值），
      而界面上会多出一堆只有一个子组的层级，看着像坏了。
    */
    const uniq: GroupKey[] = [];
    for (const k of g) if (!uniq.includes(k)) uniq.push(k);
    setGroupKeys(uniq);
    persist('groupKeys', uniq);
  };

  /** 类型定义表改名/调色/增删（与标签同构：改一处，所有行一起变） */
  const setTypeDef = (id: string, patch: { name?: string; color?: string }) =>
    withErr(async () => {
      if (!cfg) return;
      await S.mutate(ctx, cfg.dataDir, (st) => ({
        ...st,
        typeDefs: (st.typeDefs || []).map((d) => (d.id === id ? { ...d, ...patch } : d)),
      }));
    })();

  const createType = (name: string, color: string) =>
    withErr(async () => {
      if (!cfg) return;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const defs = st.typeDefs || [];
        const id = newDefId('t', defs.map((d) => d.id));
        /*
          传进来的色为空、或已被占用时，取**第一个还没人用的颜色**。
          连着建几个类型却拿到同一个颜色的话，颜色就失去了"一眼区分"的作用 ——
          而那正是给它配色的唯一原因。
          （按"已有数量取模"是不行的：默认六个里第 7 个色已被占用，
            取模恰好又落在它身上，第一个新建的类型会和"开发"同色。）
        */
        const used = new Set(defs.map((d) => d.color));
        const want = (color && !used.has(color))
          ? color
          : (TAG_COLORS.find((c) => !used.has(c)) || TAG_COLORS[defs.length % TAG_COLORS.length]);
        return { ...st, typeDefs: [...defs, { id, name, color: want }] };
      });
    })();

  /*
    删类型：先把挂在这个类型上的任务清空，再删定义。
    顺序不能反 —— 先删定义的话那些任务上留着不存在的 id，
    界面显示成原始 id（'t3'），而定义已经没了、改都没法改。
  */
  const removeType = (id: string) =>
    withErr(async () => {
      if (!cfg) return;
      let n = 0;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        n = (st.tasks || []).filter((t) => t.type === id).length;
        return {
          ...st,
          tasks: (st.tasks || []).map((t) => (t.type === id ? { ...t, type: '' } : t)),
          typeDefs: (st.typeDefs || []).filter((d) => d.id !== id),
        };
      });
      /*
        顺手把筛选里对它的引用摘掉。
        不摘的话筛选条件里留着一个已不存在的 id ——
        chip 上还写着那个类型名，而结果永远为空，
        界面看上去是"有筛选、但一条都没有"，没人会对上原因。
      */
      setColFilters((prev) => {
        const f = prev.type;
        if (!f || !(f.values || []).includes(id)) return prev;
        const values = f.values.filter((x) => x !== id);
        if (values.length === 0) {
          const next = { ...prev };
          delete next.type;
          return next;
        }
        return { ...prev, type: { ...f, values } };
      });
      if (n > 0) ctx.toast(`已删类型，${n} 条任务变成「未分类」`, 'ok');
    })();

  /** 给某条任务挂/摘类型（列头下拉里点） */
  const toggleType = (taskId: string, typeId: string) =>
    withErr(async () => {
      if (!cfg) return;
      await S.mutate(ctx, cfg.dataDir, (st) => ({
        ...st,
        tasks: (st.tasks || []).map((t) => (
          t.id === taskId ? { ...t, type: t.type === typeId ? '' : typeId } : t
        )),
      }));
    })();
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

  /*
    切项目：保存配置 → 换掉内存里的 cfg → 重载任务 → **重启 HTTP 服务**。

    最后一步不能省：服务启动时把数据目录绑进去了，切了项目不重启的话，
    AI 的 curl 通道继续读写**旧项目**的 tasks.json，
    而界面已经是新项目 —— 两边静默分叉，且状态灯还显示在线。
  */
  /*
    换项目后**清空列上的筛选与搜索**。
    不清的话：上一个项目筛的是它自己的状态 id / 类型 id / 认领人，
    切过来很可能一条都匹配不上 —— 打开就是个空看板，
    而界面上只显示"0 / 12"，看不出是没任务还是筛掉了。
    那种"这个项目是空的"错觉比多一次重新筛选麻烦得多。
  */
  const clearViewState = () => {
    setColFilters({});
    setQ('');
    setChecked(new Set());
    setDetailId(null);
  };

  const doSwitchProject = (id: string) =>
    withErr(async () => {
      if (!cfg || id === cfg.currentId) return;
      const next = await S.switchProject(ctx, cfg, id);
      setCfg(next);
      clearViewState();
      const st = await S.readStore(ctx, next.dataDir).catch(() => null);
      setStore(st || normalizeStore(null));
      await restartServiceIfOn(cfg, next);
      ctx.toast(`已切到「${currentProject(next).name}」`, 'ok');
    })();

  /** 服务在跑的话重启它，让新数据目录生效。重启失败要说出来，不能假装还在服务。 */
  const restartServiceIfOn = async (prev: TbConfig, next: TbConfig) => {
    let on = false;
    try {
      on = await S.apiHealth(prev);
    } catch {
      return;   // 探不通就是没在服务，不用管
    }
    if (!on) return;
    try {
      await S.apiStop(ctx, prev);
      await S.apiStart(ctx, next);
    } catch (e: any) {
      ctx.toast(`HTTP 服务重启失败，AI 通道可能还连着旧项目：${String(e?.message || e)}`, 'err');
    }
  };

  /*
    给当前项目选文档目录。
    已经设过时询问要不要把旧位置的文档整体搬过去 ——
    默认"搬"是因为用户改路径的意图就是"以后放这儿"，
    留在旧位置等于下次打开找不到，得靠人记着两边都有。
  */
  const setDocsFor = (c: TbConfig) =>
    withErr(async () => {
      const cur = currentProject(c);
      const r = await ctx.services.call('folder-picker', 'pick', {});
      const dir = r?.path ? String(r.path) : '';
      if (!dir) return;
      const move = cur.docsDir && cur.docsDir !== dir
        ? window.confirm(
          `把「${cur.name}」的文档从
${cur.docsDir}
整体搬到
${dir}
吗？

`
          + '旧位置不再保留（不是复制）。选"取消"则只改路径、不动文件。',
        )
        : false;
      const res = await S.setDocsDir(ctx, c, dir, move);
      setCfg(res.cfg);
      setDocsHintClosed(false);
      if (res.warning) ctx.toast(res.warning, 'err');
      else if (move) ctx.toast(`文档已搬到新位置（${res.moved} 项）`, 'ok');
      else ctx.toast('文档路径已设置', 'ok');
    })();

  const doSplit = (id: string, titles: string[]) =>
    withErr(async () => {
      if (!cfg || titles.length === 0) return;
      /*
        拆之前先看原任务估了多少 —— 子任务不会继承预估（那会让总工作量翻 N 倍），
        所以原预估会在拆分后"消失"。不吭声的话，用户看着合计从 5 变成 0，
        只会以为统计坏了，而不是"需要重新分配"。
      */
      const before = (store?.tasks || []).find((t) => t.id === id);
      const had = Number(before?.estimate) || 0;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const r = splitTask(st.tasks, id, titles);
        return { ...st, tasks: r.tasks };
      });
      await refresh();
      ctx.toast(
        had > 0
          ? `已拆成 ${titles.length} 条子任务；原预估 ${fmtEstimate(had)} 人日需重新分配到各条`
          : `已拆成 ${titles.length} 条子任务`,
        'ok',
      );
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
          {/*
            项目切换器。项目 = 一份独立任务库，切了就换一整套任务。
            放在顶栏而不是设置页：切项目是高频动作，
            埋在设置里的话每次都要"打开设置→找→切→回来"，
            而且切完还得确认当前看的是哪个项目。
          */}
          <select
            className="tb-act tb-projsel"
            value={cfg.currentId}
            title="切换项目（每个项目是独立的任务库与文档路径）"
            onChange={(e) => doSwitchProject(e.target.value)}
          >
            {cfg.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            className="tb-act"
            onClick={() => setImportOpen(true)}
            title="选一个文件夹，验证后接成一个项目"
          >
            导入…
          </button>
          <button
            className="tb-act"
            onClick={() => setNewProjOpen(true)}
            title="新建一个项目（独立的任务库 + 文档路径）"
          >
            ＋ 项目
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
            <GroupByPop
              keys={groupKeys}
              onChange={changeGroupBy}
              label={groupKeys.map((k) => GROUP_LABEL[k]).join(' › ') || '（未分组）'}
            />
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
                {c.label}：{filterSummary(c, f, typeDefs)}
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
      {/*
        项目还没设文档路径 → 提醒。
        判据统一用 needsDocsDir（新建项目时和建任务时是同一条），
        不会出现"建项目提醒一次、建任务又提醒一次"的重复打扰。
        关掉后本次会话不再出现 —— 但换个项目会重新提醒，那是另一个项目的事。
      */}
      {!docsHintClosed && needsDocsDir(cfg) ? (
        <div className="tb-dochint">
          <span className="tb-dochint-ico">!</span>
          <span className="tb-dochint-text">
            项目「{currentProject(cfg).name}」还没设文档路径 ——
            设好之后 AI 和你都知道这个项目的文档在哪，换机器也能接着读。
          </span>
          <button className="tb-act sm" onClick={() => setDocsFor(cfg)}>
            选文档目录…
          </button>
          <button
            className="tb-act sm ghost"
            title="本次不再提醒（换项目后会重新提醒）"
            onClick={() => setDocsHintClosed(true)}
          >
            知道了
          </button>
        </div>
      ) : null}

      {view === 'list' && (
        <ListView
          rows={listRows}
          allRows={flatRows}
          store={store.tasks}
          flow={flow}
          statusIds={statusIds}
          typeDefs={typeDefs}
          typeIds={typeIds}
          onToggleType={toggleType}
          onRenameType={(id, name) => setTypeDef(id, { name })}
          /*
            默认色与列头筛选面板里的新建保持一致（都取调色板的第 7 个）。
            两处不同的话，同一个"新建类型"动作在不同入口得到不同颜色，
            看着像两条互不相干的规则。
          */
          onCreateType={(name) => createType(name, TAG_COLORS[6])}
          onTypeColor={(id, color) => setTypeDef(id, { color })}
          onRemoveType={removeType}
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
          groupKeys={groupKeys}
          flow={flow}
          me={me}
          onOpen={(id) => setDetailId(id)}
          onAction={(id, to, needNote) => (needNote ? setRejectFor({ id }) : doTransition(id, to))}
          onClaim={(id) => doClaim(id)}
        />
      )}

      {/* 统计：看全量，不受顶部筛选影响 */}
      {view === 'stats' && stats && (
        <StatsView
          stats={stats}
          flow={flow}
          typeDefs={typeDefs}
          onOpen={(id) => setDetailId(id)}
        />
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
      {importOpen && cfg ? (
        <ImportProjectModal
          currentDataDir={cfg.dataDir}
          onClose={() => setImportOpen(false)}
          onImport={async (name, dataDir, docsDir) => {
            setImportOpen(false);
            await withErr(async () => {
              const next = await S.importProject(ctx, cfg, name, dataDir, docsDir);
              setCfg(next);
              clearViewState();
              const st = await S.readStore(ctx, next.dataDir).catch(() => null);
              setStore(st || normalizeStore(null));
              await restartServiceIfOn(cfg, next);
              ctx.toast(`已导入项目「${currentProject(next).name}」`, 'ok');
            })();
          }}
        />
      ) : null}

      {newProjOpen && cfg ? (
        <NewProjectModal
          onClose={() => setNewProjOpen(false)}
          onCreate={async (name, dataDir, docsDir) => {
            setNewProjOpen(false);
            await withErr(async () => {
              const next = await S.addProject(ctx, cfg, name, dataDir, docsDir);
              setCfg(next);
              clearViewState();
              const st = await S.readStore(ctx, next.dataDir).catch(() => null);
              setStore(st || normalizeStore(null));
              await restartServiceIfOn(cfg, next);
              ctx.toast(`已建项目「${currentProject(next).name}」，记得设文档路径`, 'ok');
            })();
          }}
        />
      ) : null}

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
          typeDefs={typeDefs}
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
      {/*
        看板卡片上也显示类型：看板是主视图之一，
        列表有类型列而看板看不到，会让人以为"这条没归类"。
      */}
      {typeName(flow.typeDefs, task.type) ? (
        <div className="tb-task-tags">
          <span
            className="tb-tag"
            style={{
              background: typeColor(flow.typeDefs, task.type) + '22',
              color: typeColor(flow.typeDefs, task.type),
              borderColor: typeColor(flow.typeDefs, task.type) + '55',
            }}
          >
            {typeName(flow.typeDefs, task.type)}
          </span>
        </div>
      ) : null}
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

/**
 * 类型单元格：显示当前类型，点开可换一个、改名、或清成未分类。
 *
 * 改名**就地编辑**而不是弹窗 —— 归类是顺手的事，
 * 弹个窗再确认一次，二十条任务就变成二十次开关。
 */
function TypePicker({
  value, defs, onPick, onRename, onCreate,
}: {
  value: string;
  defs: { id: string; name: string; color: string }[];
  onPick: (id: string) => void;
  onRename: (id: string, name: string) => void;
  /**
   * 就地新建类型。
   * 只在列头筛选面板里建是不够的 —— 那时要"先去列头建、再回来点这一行"，
   * 而"需要一个新分类"这个念头恰恰是在看某一行时才冒出来的。
   */
  onCreate?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState('');
  const [draft, setDraft] = useState('');
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setEditing('');
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const cur = defs.find((d) => d.id === value);

  return (
    <span className="tb-typepick" ref={ref}>
      <button
        type="button"
        className={'tb-typechip' + (cur ? '' : ' empty')}
        style={cur ? { background: cur.color + '22', color: cur.color, borderColor: cur.color + '55' } : undefined}
        onClick={() => setOpen(!open)}
        title={cur ? cur.name : '未分类（点击设置）'}
      >
        {cur ? cur.name : '—'}
      </button>
      {open ? (
        <span className="tb-typepop">
          {defs.map((d) => (
            <span key={d.id} className="tb-typerow">
              <button
                type="button"
                className={'tb-typeopt' + (value === d.id ? ' on' : '')}
                style={{ color: d.color }}
                onClick={() => {
                  onPick(d.id);
                  setOpen(false);
                }}
              >
                {value === d.id ? '● ' : '○ '}{d.name}
              </button>
              {editing === d.id ? (
                <input
                  className="tb-typerename"
                  autoFocus
                  defaultValue={d.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== d.name) onRename(d.id, v);
                    setEditing('');
                  }}
                  onKeyDown={(e) => {
                    if (isComposing(e.nativeEvent)) return;
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setEditing('');
                  }}
                />
              ) : (
                <button
                  type="button"
                  className="tb-act sm ghost"
                  title="改名"
                  onClick={() => setEditing(d.id)}
                >
                  ✎
                </button>
              )}
            </span>
          ))}
          {value ? (
            <button
              type="button"
              className="tb-typeopt"
              onClick={() => {
                onPick(value);   // 再点一次当前值 = 摘掉
                setOpen(false);
              }}
            >
              清成「未分类」
            </button>
          ) : null}
          {onCreate ? (
            <span className="tb-typerow">
              <input
                className="tb-typerename"
                value={draft}
                placeholder="＋ 新类型…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (isComposing(e.nativeEvent)) return;
                  if (e.key !== 'Enter') return;
                  const nm = draft.trim();
                  if (nm) {
                    onCreate(nm);
                    setDraft('');
                  }
                }}
              />
            </span>
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

/* ================================================================ 导入项目 */

/**
 * 导入：选一个文件夹，验证它里面有什么，再接成一个项目。
 *
 * ⛔ 验证这一步不能省。用户选的文件夹常常不是他以为的那个 ——
 * 上级目录、空目录、或者完全无关的文件夹。不验证就直接建项目，
 * 得到的是一个"名字对、但里面什么都没有"的项目，
 * 而界面上看不出错在哪：项目名是他自己起的，看着挺正常。
 */
function ImportProjectModal({
  onClose,
  onImport,
  currentDataDir,
}: {
  onClose: () => void;
  onImport: (name: string, dataDir: string, docsDir: string) => void;
  /** 当前项目的数据目录。降级探测时要临时改授权、用完还原，不能把它弄丢 */
  currentDataDir: string;
}) {
  const ctx = useNexus();
  const [dir, setDir] = useState('');
  const [scan, setScan] = useState<null | {
    dir: string; tasksJson: boolean; mdCount: number;
    dirCount: number; otherCount: number; sample: string[]; degraded?: boolean;
  }>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [name, setName] = useState('');
  const [useAsData, setUseAsData] = useState(true);
  const [useAsDocs, setUseAsDocs] = useState(true);

  const pick = async () => {
    const r = await ctx.services.call('folder-picker', 'pick', {});
    const p = r?.path ? String(r.path) : '';
    if (!p) return;
    setDir(p);
    setName((prev) => prev || p.split(/[/\\]/).filter(Boolean).pop() || '');
    await verify(p);
  };

  const verify = async (target: string) => {
    setBusy(true);
    setMsg('');
    try {
      setScan(await S.scanDir(ctx, target, currentDataDir));
    } catch (e: any) {
      setScan(null);
      setMsg('验证失败：' + String(e?.message || e));
    } finally {
      setBusy(false);
    }
  };

  /* 验证结论：把扫描结果翻成人能判断的话 */
  const verdict = (() => {
    if (!scan) return null;
    const bits: string[] = [];
    if (scan.tasksJson) bits.push('发现 tasks.json → 可以接成任务库');
    if (scan.mdCount > 0) bits.push(`有 ${scan.mdCount} 个 md 文档`);
    if (scan.dirCount > 0) bits.push(`${scan.dirCount} 个子目录`);
    if (bits.length === 0) bits.push('这个目录是空的 —— 可以当新项目的位置，但里面暂时没东西');
    const warn = scan.dirCount > 0 && !scan.tasksJson && scan.mdCount === 0
      ? '里面只有子目录、没有任务库也没有文档 —— 是不是选到了上级目录？'
      : '';
    return { bits, warn };
  })();

  return (
    <Modal title="导入项目" onClose={onClose} wide>
      <label className="tb-mfield">
        <span>选一个文件夹 *</span>
        <div className="tb-mrow">
          <input value={dir} onChange={(e) => setDir(e.target.value)} placeholder="这个项目的文档 / 任务库所在目录" />
          <button type="button" className="tb-act sm" onClick={pick}>
            浏览…
          </button>
          <button type="button" className="tb-act sm" onClick={() => dir && verify(dir)} disabled={!dir || busy}>
            重新验证
          </button>
        </div>
      </label>

      {busy ? <div className="tb-hint">正在验证…</div> : null}
      {msg ? <div className="tb-hint">{msg}</div> : null}

      {scan && verdict ? (
        <section className="tb-scan">
          <header className="tb-scan-head">验证结果</header>
          {verdict.bits.map((b) => (
            <div key={b} className="tb-scan-row">· {b}</div>
          ))}
          {verdict.warn ? <div className="tb-scan-warn">⚠ {verdict.warn}</div> : null}
          {scan.degraded ? (
            <div className="tb-scan-warn">
              ⚠ 后端扫描不可用，只验证了有没有 tasks.json（文档数量没能统计）
            </div>
          ) : null}
          {scan.sample.length > 0 ? (
            <div className="tb-scan-sample">
              里面有：{scan.sample.join('、')}
              {scan.sample.length >= 12 ? ' …' : ''}
            </div>
          ) : null}
        </section>
      ) : null}

      {scan ? (
        <>
          <label className="tb-mfield">
            <span>项目名 *</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="给这个项目起个名" />
          </label>
          <label className="tb-sfield check">
            <input type="checkbox" checked={useAsData} onChange={(e) => setUseAsData(e.target.checked)} />
            <span>用它作为任务库目录（tasks.json 放这里）</span>
          </label>
          <label className="tb-sfield check">
            <input type="checkbox" checked={useAsDocs} onChange={(e) => setUseAsDocs(e.target.checked)} />
            <span>用它作为这个项目的文档路径</span>
          </label>
          {/*
            ⛔ 两个都不勾必须**禁用导入**，不能静默兜底。
            都不勾时两个路径都是空 → 建项目会落到默认目录去，
            得到一个"名字取自刚才那个文件夹、但跟它毫无关系"的空项目。
            用户会以为导入成功了，然后在里面找不到自己刚看到的那些文档 ——
            而且界面上看不出项目实际指向哪里。
          */}
          {!useAsData && !useAsDocs ? (
            <div className="tb-scan-warn">
              ⚠ 至少勾一个用途，否则这个项目不会指向刚才那个文件夹
            </div>
          ) : null}
          <div className="tb-macts">
            <button className="tb-act" onClick={onClose}>
              取消
            </button>
            <button
              className="tb-act primary"
              disabled={!name.trim() || (!useAsData && !useAsDocs)}
              onClick={() => onImport(name, useAsData ? scan.dir : '', useAsDocs ? scan.dir : '')}
            >
              导入
            </button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}

/* ================================================================ 分组设置 */

/**
 * 分组依据：**多列 + 可调优先级**（顺序就是层级，越靠前越外层）。
 *
 * 腾讯文档的智能表是这个交互，因为它同时满足两种用法：
 * 只想按状态分 → 就留一列；想"按类型分、里面再按状态" → 加一列。
 * 单选一列的话后者做不到，得先分一次记结果、再分一次。
 */
function GroupByPop({
  keys, onChange, label,
}: {
  keys: GroupKey[];
  onChange: (next: GroupKey[]) => void;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= keys.length) return;
    const next = [...keys];
    const [one] = next.splice(i, 1);
    next.splice(j, 0, one);
    onChange(next);
  };

  const addable = GROUP_KEYS.filter((k) => !keys.includes(k));

  return (
    <div className="tb-gby" ref={ref}>
      <button
        className={'tb-act sm' + (open ? ' on' : '')}
        onClick={() => setOpen(!open)}
        title="分组依据（可多列，顺序即层级）"
      >
        分组：{label} ▾
      </button>
      {open ? (
        <div className="tb-gby-pop">
          <div className="tb-gby-title">分组层级（越靠上越外层）</div>
          {keys.length === 0 ? (
            <div className="tb-gby-hint">还没选任何列 —— 所有任务会堆在一组里</div>
          ) : null}
          {keys.map((k, i) => (
            <div key={k} className="tb-gby-row">
              <span className="tb-gby-name">{GROUP_LABEL[k]}</span>
              <span className="tb-gby-ops">
                <button type="button" className="tb-act sm" disabled={i === 0} onClick={() => move(i, -1)} title="上移一层">↑</button>
                <button type="button" className="tb-act sm" disabled={i === keys.length - 1} onClick={() => move(i, 1)} title="下移一层">↓</button>
                <button
                  type="button"
                  className="tb-act sm warn"
                  onClick={() => onChange(keys.filter((x) => x !== k))}
                  title="去掉这一层"
                >
                  ✕
                </button>
              </span>
            </div>
          ))}
          {addable.length > 0 ? (
            <div className="tb-gby-add">
              <span className="tb-gby-title">加一层</span>
              {addable.map((k) => (
                <button
                  key={k}
                  type="button"
                  className="tb-act sm"
                  onClick={() => onChange([...keys, k])}
                >
                  ＋ {GROUP_LABEL[k]}
                </button>
              ))}
            </div>
          ) : null}
          <div className="tb-gby-foot">
            <span className="tb-gby-hint">同一列不会重复加 —— 分两层没有意义</span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ================================================================ 新建项目 */

/**
 * 新建项目：名字 + 数据目录 + 文档路径。
 *
 * 文档路径**不强制**，但空着会留一条提醒 ——
 * 强制的话点"新建"前还得先去建个目录，人会选择随便填一个敷衍过去，
 * 那个路径比空着更糟（下次打开指向一个空目录，看着像有、其实是空的）。
 */
function NewProjectModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (name: string, dataDir: string, docsDir: string) => void;
}) {
  const ctx = useNexus();
  const [name, setName] = useState('');
  const [dataDir, setDataDir] = useState('');
  const [docsDir, setDocsDir] = useState('');
  const [msg, setMsg] = useState('');

  const pick = async (which: 'data' | 'docs') => {
    try {
      const r = await ctx.services.call('folder-picker', 'pick', {});
      // pick resolve 的是 { path, action } 对象，不是裸字符串
      const p = r?.path ? String(r.path) : '';
      if (!p) return;
      if (which === 'data') setDataDir(p);
      else setDocsDir(p);
    } catch (e: any) {
      setMsg('选择目录失败：' + String(e?.message || e));
    }
  };

  return (
    <Modal title="新建项目" onClose={onClose}>
      <label className="tb-mfield">
        <span>项目名 *</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：登录改版"
        />
      </label>
      <label className="tb-mfield">
        <span>数据目录 *（这个项目的 tasks.json 放哪）</span>
        <div className="tb-mrow">
          <input
            value={dataDir}
            onChange={(e) => setDataDir(e.target.value)}
            placeholder="留空则用默认目录下的同名子目录"
          />
          <button type="button" className="tb-act sm" onClick={() => pick('data')}>
            浏览…
          </button>
        </div>
        <em>每个项目一份独立任务库：任务、流程、标签、身份表全都是各自的。</em>
      </label>
      <label className="tb-mfield">
        <span>文档路径（这个项目的文档放哪）</span>
        <div className="tb-mrow">
          <input
            value={docsDir}
            onChange={(e) => setDocsDir(e.target.value)}
            placeholder="选一个目录（可稍后设）"
          />
          <button type="button" className="tb-act sm" onClick={() => pick('docs')}>
            浏览…
          </button>
        </div>
        <em>
          设好之后 AI 和你都知道这个项目的文档在哪。以后改这个路径时，
          会把文档<strong>整体搬过去</strong>（旧位置不留），不是复制。
        </em>
      </label>
      <div className="tb-macts">
        <button className="tb-act" onClick={onClose}>
          取消
        </button>
        <button
          className="tb-act primary"
          disabled={!name.trim()}
          onClick={() => onCreate(name, dataDir.trim(), docsDir.trim())}
        >
          创建
        </button>
      </div>
      {msg && <div className="tb-hint">{msg}</div>}
    </Modal>
  );
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
function optionLabel(
  field: SortField,
  v: string,
  defs?: { id: string; name: string }[],
): string {
  if (field === 'priority') return `${v} ${PRIORITY_LABEL[v as Priority] || ''}`.trim();
  if (field === 'status') return STATUS_LABEL[v as TaskStatus] || v;
  /*
    未分类是哨兵值（不在定义表里），必须在这里单独认 ——
    否则 chip 上会显示 "__notype__"，没人看得懂那一串下划线是什么。
  */
  if (field === 'type') return v === NOTYPE ? '未分类' : (typeName(defs, v) || v);
  if (field === 'assignee') return v || '未认领';
  return v;
}

/**
 * 已生效筛选的一句摘要，写在 chip 上。
 *
 * 传 typeDefs：类型列显示的是 id（'dev'），不查定义表的话
 * chip 上写 "dev" 而筛选面板里写 "开发" —— 同一个筛选两处说法不一样，
 * 会让人以为那是两个不同的东西。
 */
function filterSummary(col: ListColumn, f: ColFilter, typeDefs?: TagDef[]): string {
  if (col.kind === 'enum') {
    return f.values.map((v) => optionLabel(col.field, v, typeDefs)).join('、');
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
  col, filter, options, onChange, onClear, anchorRight,
  tagDefs, onCreateTag, onTagColor,
  typeDefs, onCreateType, onTypeColor, onRemoveType,
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
  /** 类型定义。只任务类型列用得到 —— 与标签同构，同样可增删改色 */
  typeDefs?: TagDef[];
  onCreateType?: (name: string, color: string) => void;
  onTypeColor?: (id: string, color: string) => void;
  /** 删类型。调用方负责先把挂着的任务清空，这里只管问一句 */
  onRemoveType?: (id: string) => void;
}) {
  const set = (patch: Partial<ColFilter>) => onChange({ ...filter, ...patch });
  const cls = 'tb-lpop' + (anchorRight ? ' is-right' : '');
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[6]);
  const isTag = col.field === 'tags';
  const isType = col.field === 'type';
  /* 两种列共用同一套"定义表 + 改色 + 新建"的交互 */
  const defs = isType ? (typeDefs || []) : (tagDefs || []);
  const colorOf = (id: string) => defs.find((d) => d.id === id)?.color || '';
  /*
    「未分类」是哨兵值，不是定义表里的一条。
    给它摆上调色和删除按钮是骗人：改色改不到任何东西（没有定义可改），
    点了"删"会弹确认框然后什么都没发生 —— 而用户已经以为自己删掉了什么。
  */
  const isSentinel = (id: string) => isType && id === NOTYPE;

  if (col.kind === 'enum') {
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
                  <span>{optionLabel(col.field, v, defs)}</span>
                </label>
                {/*
                  标签列与类型列都能直接调色。
                  颜色是**定义**的一部分（不是这一行的事），
                  所以改一处、所有挂它的行一起变 ——
                  做成逐行改色的话同一个标签在不同行颜色不同，
                  那就丢掉了"一眼分类"这个作用。
                */}
                {(isTag || isType) && !isSentinel(v) && (isType ? onTypeColor : onTagColor) ? (
                  <span className="tb-lpop-swatches">
                    {TAG_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        className={'tb-swatch' + (colorOf(v) === c ? ' on' : '')}
                        style={{ background: c }}
                        title={`把「${optionLabel(col.field, v, defs)}」改成这个颜色`}
                        onClick={() => (isType ? onTypeColor!(v, c) : onTagColor!(v, c))}
                      />
                    ))}
                  </span>
                ) : null}
                {isType && onRemoveType && !isSentinel(v) ? (
                  <button
                    type="button"
                    className="tb-act sm warn tb-lpop-del"
                    title="删除这个类型（挂在这个类型上的任务会变成「未分类」）"
                    onClick={() => {
                      const nm = optionLabel(col.field, v, defs);
                      if (window.confirm(`删除类型「${nm}」？\n\n挂在这个类型上的任务会变成「未分类」。`)) {
                        onRemoveType(v);
                      }
                    }}
                  >
                    删
                  </button>
                ) : null}
              </div>
            );
          })
        )}
        {(isTag || isType) && (isType ? onCreateType : onCreateTag) ? (
          <div className="tb-lpop-new">
            <input
              className="tb-lpop-input"
              value={newName}
              placeholder={isType ? '新建类型…' : '新建标签…'}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (!isComposing(e.nativeEvent) && e.key === 'Enter' && newName.trim()) {
                  if (isType) onCreateType!(newName.trim(), newColor);
                  else onCreateTag!(newName.trim(), newColor);
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
                  title={isType ? '新类型用这个颜色' : '新标签用这个颜色'}
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

  if (col.kind === 'num') {
    const none = (filter.values || []).indexOf(UNESTIMATED) >= 0;
    return (
      <div className={cls} onClick={(e) => e.stopPropagation()}>
        <div className="tb-lpop-title">按{col.label}筛选</div>
        <div className="tb-lpop-row">
          <input
            className="tb-lpop-num"
            type="number"
            step="0.5"
            min="0"
            placeholder="最小"
            value={filter.min}
            onChange={(e) => set({ min: e.target.value })}
          />
          <span className="tb-lpop-hint">~</span>
          <input
            className="tb-lpop-num"
            type="number"
            step="0.5"
            min="0"
            placeholder="最大"
            value={filter.max}
            onChange={(e) => set({ max: e.target.value })}
          />
        </div>
        {/*
          「没估」单列一个勾选项，不混进区间 ——
          没估是"缺失"，不是 0。混在一起会变成
          "要么没估、要么在区间内"，没人能预测出这个结果。
        */}
        <label className="tb-lpop-item">
          <span className="tb-lpop-pick">
            <input
              type="checkbox"
              checked={none}
              onChange={() => set({
                values: none
                  ? (filter.values || []).filter((x) => x !== UNESTIMATED)
                  : [...(filter.values || []), UNESTIMATED],
              })}
            />
            <span>只要没估的</span>
          </span>
        </label>
        <div className="tb-lpop-foot">
          <span className="tb-lpop-hint">只填一边也行</span>
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
  typeDefs,
  typeIds,
  onToggleType,
  onRenameType,
  onCreateType,
  onTypeColor,
  onRemoveType,
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
  /** 任务类型定义表（列头下拉里可增删改色） */
  typeDefs: TagDef[];
  /** 类型筛选的候选值（用户定义了哪些类型） */
  typeIds: string[];
  /** 给某条任务挂/摘类型 */
  onToggleType: (taskId: string, typeId: string) => void;
  /** 改某个类型的显示名 */
  onRenameType: (id: string, name: string) => void;
  /** 就地新建类型（只要名字，颜色用默认灰） */
  onCreateType: (name: string) => void;
  /** 改某个类型的颜色 */
  onTypeColor: (id: string, color: string) => void;
  /** 删某个类型（调用方负责先把任务清成未分类） */
  onRemoveType: (id: string) => void;
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
                  /*
                    typeIds 必须传：类型候选取的是**定义表**，不是数据去重。
                    不传的话会退回默认六个，用户自定义的类型在下拉里根本选不到 ——
                    那个类型等于建不出来（而它明明已经出现在列表里了）。
                  */
                  options={colFilterValues(c.field, allRows, statusIds, typeIds)}
                  onChange={(nf) => onFilter(c.field, nf)}
                  onClear={() => onClearFilter(c.field)}
                  anchorRight={ci >= LIST_COLUMNS.length - 3}
                  tagDefs={tagDefs}
                  onCreateTag={onCreateTag}
                  onTagColor={onTagColor}
                  typeDefs={typeDefs}
                  onCreateType={onCreateType}
                  onTypeColor={onTypeColor}
                  onRemoveType={onRemoveType}
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
            {/*
              类型单元格：点开就地改这一条的类型。
              摆在这儿而不是只在详情里 —— 归类是一次看一批、顺手改一批的动作，
              逐条点开详情改，二十条就得开关二十次。

              ⚠️ 这个单元格不能漏：网格是「1 勾选 + 12 列」，
              少渲染一个格子，后面所有列都会整体错位一格（最后一列还会溢出）。
            */}
            <span className="tb-lc c-type">
              <TypePicker
                value={t.type}
                defs={typeDefs}
                onPick={(id) => onToggleType(t.id, id)}
                onRename={(id, name) => onRenameType(id, name)}
                onCreate={onCreateType}
              />
            </span>
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
            <span className="tb-lc c-estimate">
              {fmtEstimate(t.estimate) || <span className="tb-ldim">—</span>}
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

/*
 * 分组视图：**递归**渲染（多列分组时一层套一层）。
 *
 * 中间层只显示子组，不重复渲染任务 —— 任务都挂在叶子上
 * （核心层把中间层的 tasks 清空了，理由见 groupTasksBy）。
 */
function GroupView({
  flow,
  groups,
  groupKeys,
  me,
  onOpen,
  onAction,
  onClaim,
}: {
  flow: FlowLike;
  groups: GroupNode[];
  groupKeys: GroupKey[];
  me: string;
  onOpen: (id: string) => void;
  onAction: (id: string, to: TaskStatus, needNote?: boolean) => void;
  onClaim: (id: string) => void;
}) {
  return (
    <div className="tb-groups">
      {groups.length === 0 && <div className="tb-col-empty">没有符合条件的任务</div>}
      {groups.map((g) => (
        <GroupNodeView
          key={g.key}
          node={g}
          groupKeys={groupKeys}
          flow={flow}
          me={me}
          onOpen={onOpen}
          onAction={onAction}
          onClaim={onClaim}
        />
      ))}
    </div>
  );
}

function GroupNodeView({
  node, flow, groupKeys, me, onOpen, onAction, onClaim,
}: {
  node: GroupNode;
  flow: FlowLike;
  groupKeys: GroupKey[];
  me: string;
  onOpen: (id: string) => void;
  onAction: (id: string, to: TaskStatus, needNote?: boolean) => void;
  onClaim: (id: string) => void;
}) {
  const by = groupKeys[node.depth] || 'status';
  const isLeaf = node.children.length === 0;
  /*
    缩进**靠嵌套本身**：子组渲染在父组的 body 里，而 body 有竖线 + 内边距。
    这里不再按 depth 叠 marginInlineStart —— 嵌套已经提供了一层缩进，
    再算一次会**翻倍累加**（3 层时 margin 36 + 累计 padding，整块被推出屏幕）。
    树形结构天然由容器表达层级，不需要额外再算。
  */
  return (
    <section className={'tb-group' + (isLeaf ? '' : ' tb-group-branch')}>
      <header className="tb-group-head">
        {by === 'status' ? (
          <span className="tb-col-dot" style={{ background: statusColor(flow, node.key) }} />
        ) : null}
        {by === 'type' && node.key !== NOTYPE ? (
          <span className="tb-col-dot" style={{ background: typeColor(flow.typeDefs, node.key) }} />
        ) : null}
        <span className="tb-group-name">{groupLabel(node.key, by, flow)}</span>
        <span className="tb-col-num">{isLeaf ? node.tasks.length : node.count}</span>
      </header>
      <div className="tb-group-body">
        {isLeaf ? (
          node.tasks.map((t) => (
            <TaskCard
              key={t.id}
              task={t}
              me={me}
              flow={flow}
              onOpen={() => onOpen(t.id)}
              onAction={(to, needNote) => onAction(t.id, to, needNote)}
              onClaim={() => onClaim(t.id)}
            />
          ))
        ) : (
          node.children.map((c) => (
            <GroupNodeView
              key={c.key}
              node={c}
              groupKeys={groupKeys}
              flow={flow}
              me={me}
              onOpen={onOpen}
              onAction={onAction}
              onClaim={onClaim}
            />
          ))
        )}
      </div>
    </section>
  );
}
/* ================================================================ 统计视图 */

function BarRow({
  label, count, max, dot, color, note,
}: {
  label: string;
  count: number;
  max: number;
  dot?: string;
  color?: string;
  /** 条右侧的补充量（这里显示人日）。0/空就不显示 —— 没有就别占位置 */
  note?: string;
}) {
  return (
    <div className="tb-bar-row">
      <span className="tb-bar-label">
        {(dot || color) && (
          <span className="tb-col-dot" style={color ? { background: color } : undefined} />
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
      {note ? <span className="tb-bar-note">{note} 人日</span> : null}
    </div>
  );
}

function StatsView({
  stats, flow, typeDefs, onOpen,
}: {
  stats: TbStats;
  flow: { statuses: { id: string; name: string; color: string }[] };
  /** 类型定义表（显示类型名与颜色） */
  typeDefs: TagDef[];
  onOpen: (id: string) => void;
}) {
  const typeRows = Object.entries(stats.byType || {}).sort((a, b) => b[1] - a[1]);
  const maxType = Math.max(1, ...typeRows.map(([, n2]) => n2));
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
        {/*
          类型分布。加了「任务类型」这个维度却不统计它，等于只做了一半 ——
          而"这一类压了多少活"正是分类这件事的用处。
        */}
        {typeRows.length > 0 ? (
          <section className="tb-stat-panel">
            <header className="tb-stat-panel-head">任务类型</header>
            {typeRows.map(([id, cnt]) => (
              <BarRow
                key={id}
                label={id === NOTYPE ? '未分类' : typeName(typeDefs, id)}
                count={cnt}
                max={maxType}
                color={id === NOTYPE ? undefined : typeColor(typeDefs, id)}
              />
            ))}
          </section>
        ) : null}
        <section className="tb-stat-panel">
          <header className="tb-stat-panel-head">认领人负载</header>
          {stats.byAssignee.length === 0 && <div className="tb-col-empty">暂无数据</div>}
          {stats.byAssignee.map((a) => (
            <BarRow
              key={a.id}
              label={a.id === UNASSIGNED ? '未认领' : '@' + a.id}
              count={a.count}
              max={maxWho}
              note={fmtEstimate(a.est)}
            />
          ))}
          <div className="tb-stat-total">
            已估 {fmtEstimate(stats.byAssignee.reduce((n, a) => n + (a.est || 0), 0))} 人日
          </div>
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
  onCreate: (draft: {
    title: string;
    detail: string;
    priority: string;
    tags: string[];
    assignee: string;
    estimate: string;
  }) => void;
}) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [tagsText, setTagsText] = useState('');
  const [assignee, setAssignee] = useState('');
  const [estimate, setEstimate] = useState('');

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
        <span>预估工作量（人日，可选）</span>
        <input
          type="number"
          step="0.5"
          min="0"
          value={estimate}
          onChange={(e) => setEstimate(e.target.value)}
          placeholder="例如 2.5（0.5 = 半天）"
        />
      </label>
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
              tags: tagsText.split(/[,，]/).map((s2) => s2.trim()).filter(Boolean),
              assignee,
              estimate,
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
  typeDefs,
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
  /** 类型定义表（详情里可改这条的类型） */
  typeDefs: TagDef[];
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
        <span className="tb-dlabel">任务类型</span>
        <select
          className="tb-dinput tb-dsel"
          value={task.type || ''}
          onChange={(e) => onPatch({ type: e.target.value })}
        >
          <option value="">未分类</option>
          {(typeDefs || []).map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
          {/* 值不在定义表里（AI 手写的 id）也要显示出来 —— 否则下拉会静默显示成"未分类" */}
          {task.type && !(typeDefs || []).some((d) => d.id === task.type) ? (
            <option value={task.type}>{task.type}（未在定义表）</option>
          ) : null}
        </select>

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
