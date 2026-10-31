import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
  currentProject,
  duplicateDataDirs,
  needsDocsDir,
  normalizeStore,
  normalizeTypeDefs,
  DEFAULT_FLOW,
  flattenTasks,
  flattenAllGroups,
  fmtTime,
  groupTasksBy,
  indexTasks,
  fmtEstimate,
  initialStatus,
  lockOf,
  newDefId,
  NOTYPE,
  NOGROUP,
  statusDone,
  dependsOn,
  normalizeFlow,
  relTime,
  sortRowsBy,
  sortTasksBy,
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
  { key: 'group', label: '分组', title: '分组：选一列（或几列）做分组依据，只改显示不改数据' },
  { key: 'stats', label: '统计', title: '统计：分布 / 负载 / 最近动态' },
];

const GROUP_KEYS: GroupKey[] = ['status', 'priority', 'assignee', 'type', 'tag', 'group'];

/** 分组依据的显示名（分组设置面板与面包屑共用） */
const GROUP_LABEL: Record<GroupKey, string> = {
  status: '状态',
  priority: '优先级',
  assignee: '认领人',
  type: '任务类型',
  tag: '标签',
  group: '分组',
};

/*
  流程配置的最小形状（组件只用到 statuses / transitions / edges）。
  typeDefs 挂在上面是为了少传一个参数：分组与状态显示都要它，
  而它和 flow 一样是"当前项目的配置"。
*/
type FlowLike = ReturnType<typeof normalizeFlow> & {
  typeDefs?: { id: string; name: string; color: string }[];
};

/*
 * 列宽。默认那套是从原写死的网格里抄来的，行为与改动前一致。
 *
 * ⚠️ 标题列默认 **minmax(0, 1fr)**（吃满剩余空间）：
 * 表格总宽比各列之和宽，没有一列吸收剩余的话右侧会空一大条；
 * 而一旦用户手动拖过它，就变成固定 px —— 显式拖了就该听用户的。
 */
const DEFAULT_COL_W: Record<string, string> = {
  priority: '56px',
  id: '70px',
  title: 'minmax(0, 1fr)',
  group: '100px',
  status: '88px',
  assignee: '96px',
  type: '84px',
  tags: '116px',
  summary: '132px',
  estimate: '62px',
  createdAt: '84px',
  updatedAt: '84px',
};
const PICK_COL_W = 26;
/** 拖动的下限：再窄列头文字都放不下，等于把这一列拖没了 */
const MIN_COL_W = 48;
/** 上限：防止误拖出一个占满屏幕的列（拖回来看似"表格坏了"） */
const MAX_COL_W = 1200;

const SORT_FIELDS: SortField[] = [
  'priority', 'status', 'assignee', 'type', 'tags', 'summary',
  'estimate', 'updatedAt', 'createdAt', 'title', 'id', 'group',
];

/** 分组 key → 展示名（label 只在这一处映射，core.mjs 不碰文案） */
function groupLabel(
  key: string,
  by: GroupKey,
  flow?: FlowLike,
  tagDefs?: TagDef[],
): string {
  /*
    空 key（**没选任何分组依据**时，所有任务落在同一个 key='' 的组里）。

    ⛔ 不能把空串透出去：组头会显示成一个**空名字**，
    用户看着一个没有标题的分组，不知道那是什么 ——
    而弹层里那句"还没选任何列"在关掉弹层后就看不到了。
  */
  if (key === '') return '全部任务';
  if (by === 'status') return statusName(flow, key);
  if (by === 'priority') return `${key} ${PRIORITY_LABEL[key as Priority] || ''}`.trim();
  if (by === 'type') return key === NOTYPE ? '未分类' : typeName(flow && flow.typeDefs, key);
  if (key === UNASSIGNED) return '未认领';
  if (key === NOTAG) return '无标签';
  if (key === NOGROUP) return '未分组';
  /*
    按标签分组时，key 是**标签 id**（tg_xxxx）。
    ⛔ 不查定义表的话组头显示一串没人看得懂的字符，
    而用户选"按标签分组"就是要按**名字**归拢 ——
    看着像分组功能坏了（"这些都是什么？"）。
  */
  if (by === 'tag') {
    const d = (tagDefs || []).find((x) => x.id === key);
    return d ? d.name : key;
  }
  return key;
}
/** 排序字段 → 展示名。与列头用的是同一套名字，两处说法必须一致 */
const SORT_LABEL: Record<SortField, string> = {
  priority: '优先级',
  id: 'ID',
  title: '标题',
  status: '状态',
  assignee: '认领人',
  tags: '标签',
  type: '类型',
  summary: '说明',
  estimate: '预估',
  createdAt: '创建',
  updatedAt: '更新',
  group: '分组',
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


  const [q, setQ] = useState('');
  const [colFilters, setColFilters] = useState<Partial<Record<SortField, ColFilter>>>({});
  const [newOpen, setNewOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  /*
    needNote 的边要填原因。
    ⛔ to 必须带着：原来这里写死成"打回 = 回到 doing"，
    但用户自定义流程后，任何一条边都可以要求填原因 ——
    写死的话那些边会集体跳回 doing，而界面上写的是另一个状态名。
  */
  const [rejectFor, setRejectFor] = useState<{ id: string; to: string } | null>(null);
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
  /*
    列显示与列宽。同样走 ctx.store 持久化。

    ⚠️ 这两个决定的是"表格长什么样"，和 sort 一样属于视图偏好 ——
    不跟任务数据走，也不该换个项目就被冲掉。
  */
  const [colHidden, setColHidden] = useState<string[]>([]);
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
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
        let st = await S.readStore(ctx, c.dataDir);
        if (!alive) return;
        /*
          一次性迁移：组从"数据结构"改成"视图概念"之后，
          文件里可能还留着以前手动建的 kind='group' 记录。
          留着就是两套并存的层级（数据一套、视图一套），所以平铺掉。

          只在真的有组时才写盘 —— 平铺完就没有组了，不会每开一次写一次。
        */
        if ((st.tasks || []).some((t) => t.kind === 'group')) {
          const r = flattenAllGroups(st.tasks);
          if (r.removed > 0) {
            st = await S.mutate(ctx, c.dataDir, () => ({ ...st, tasks: r.tasks }));
            ctx.toast(
              `已把 ${r.removed} 个手动任务组展开为平级任务`
              + (r.remapped > 0 ? `（${r.remapped} 条"依赖整个组"的已改指到具体任务）` : '')
              + '。以后分组请选一列作为依据',
              'ok',
            );
          }
        }
        setStore(st);
        /* 视图偏好：读不到/格式坏了都静默回默认 —— 丢的只是「上次看到哪」，
           不该让看板起不来。存储桥接最坏 15s 超时，故整体 try 兜住。 */
        try {
          const [v, g, s, hidden, widths] = await Promise.all([
            ctx.store.get('view', 'board'),
            ctx.store.get('groupKeys', ['status']),
            ctx.store.get('sort', { field: 'priority', dir: 'asc' }),
            ctx.store.get('colHidden', []),
            ctx.store.get('colWidths', {}),
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
          /*
            隐藏列与列宽：**只认已知的 field**。
            存的是配置、可能是旧版本写的（那时还有别的列），
            不过滤的话会带进来当前根本不存在的列，网格就多出一格。
          */
          if (Array.isArray(hidden)) {
            const known = new Set<string>(LIST_COLUMNS.map((c) => c.field));
            let hs = (hidden as unknown[]).filter(
              (x): x is SortField => typeof x === 'string' && known.has(x),
            );
            /*
              ⛔ 隐藏列不能**多于总数的 1 个**：
              界面上不让把最后一列也藏掉（那会得到一张空表格，
              而界面上看不出是"没数据"还是"列被藏了"），
              但从**存档里读回来**没有这道闸 ——
              存档可能是旧版本写的，那时列更少（藏掉 8 个只剩 1 个是合法的），
              升级到 13 列后还是只剩 1 个，而 13 列里藏 12 个在现在是禁止的。

              于是打开就是一张几乎空的表格，而列设置面板里
              所有列都显示"已显示"（因为数量刚好合法）—— 无从下手。
              多了就只保留前面若干个，至少留两列。
            */
            if (hs.length > LIST_COLUMNS.length - 2) hs = hs.slice(0, LIST_COLUMNS.length - 2);
            setColHidden(hs);
          }
          if (widths && typeof widths === 'object') {
            const w = widths as Record<string, unknown>;
            const ok: Record<string, number> = {};
            for (const [k, val] of Object.entries(w)) {
              if (typeof val === 'number' && val >= MIN_COL_W && val <= MAX_COL_W) ok[k] = val;
            }
            setColWidths(ok);
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
    /*
      ⛔ 读不到时**必须把显示清空**，不能留着旧 store：
      留着的话界面显示的是**上一个项目的任务**，
      而写入用的是新目录（cfgRef 已经换了）——
      于是"看着甲的任务、点删除删的是乙里同 id 的那条（很可能没有）"，
      静默失败，且没人会对上原因。

      这与下面 doSwitchProject 里那条"读不到要明说"是同一个判据，
      两条路径必须一致。
    */
    S.readStore(ctx, c.dataDir)
      .then((st) => setStore(st))
      .catch((e: unknown) => {
        setStore(normalizeStore(null));
        ctx.toast(`已切到新配置，但读不到它的任务库：${String((e as Error)?.message || e)}`, 'err');
      });
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
  /* 当前项目是否与别的项目共用数据目录（只报不改，见下面的提示条） */
  const sameDir = cfg ? duplicateDataDirs(cfg).filter((d) => d.ids.indexOf(cfg.currentId) >= 0) : [];
  const flow = store ? { ...store.flow, typeDefs: store.typeDefs } : { ...DEFAULT_FLOW, typeDefs: normalizeTypeDefs(null) };
  const statusIds = flow.statuses.map((s) => s.id);
  const typeDefs = store ? store.typeDefs : [];
  const typeIds = typeDefs.map((d) => d.id);
  /*
    标签 id → 显示名的映射。排序要用它：
    任务上存的是 id、界面显示的是名字，按 id 排出来的顺序看着像随机。
  */
  const tagDefs = store ? store.tagDefs : [];
  /*
    已有分组名（去重、排序）。新建弹窗的分组下拉用它做候选 ——
    分组是自由文本，但"复用已有分组"比"再敲一遍"常见得多，
    敲错一个字就变成两个分组，而界面上看不出它们本该是同一个。
  */
  const allGroupNames = useMemo(() => {
    const set = new Set<string>();
    for (const t of store ? store.tasks : []) {
      const g = (t.group || '').trim();
      if (g) set.add(g);
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  }, [store]);
  const tagNames = useMemo(() => {
    const m: Record<string, string> = {};
    for (const d of tagDefs) m[d.id] = d.name;
    return m;
  }, [tagDefs]);

  const flatRows = useMemo(() => flattenTasks(store ? store.tasks : []), [store]);
  /*
    typeDefs 要传进去：搜索要匹配**类型的显示名**（"开发"），
    而任务上存的是 id（'dev'）—— 不传就只能按 id 搜，用户搜不到。
    ⛔ 依赖里也要带上：改了类型名，同一个关键词的命中结果会变，
    漏了依赖就停在旧结果上（看着像搜索坏了）。
  */
  const filteredRows = useMemo(
    () => filterTasksByColumns(flatRows, colFilters, q, typeDefs),
    [flatRows, colFilters, q, typeDefs],
  );
  const filtered = useMemo(() => filteredRows.map((r) => r.task), [filteredRows]);
  /*
    看板的列 = 用户配了几个状态就有几列。
    写死五列的话，用户新增的状态在看板上根本没有落脚的地方 ——
    那些任务会"消失"（不在任何一列里）。
  */
  /*
    看板列 = 流程里的状态 **+ 数据里实际在用的、但配置里没有的状态**。

    ⛔ 只按配置渲染的话：任务状态在流程里被删掉（或 AI 经 API 直接写了个
    配置里没有的状态），那些任务在看板上**凭空消失** ——
    而它们在列表里还在。用户会以为看板漏渲染了任务，
    更糟的是"总数对不上"这种错没人会往"状态不在配置里"想。

    这里给它们单独一列，并在列头标明，让"为什么会有这一列"看得见：
    静默丢弃比多一列难查得多。
  */
  const ghostStatuses = useMemo(() => {
    const known = new Set(flow.statuses.map((s) => s.id));
    const seen: string[] = [];
    if (store) {
      for (const t of store.tasks) {
        if (known.has(t.status) || seen.indexOf(t.status) >= 0) continue;
        seen.push(t.status);
      }
    }
    return seen;
  }, [store, flow]);

  const boardColumns = useMemo(
    () => [
      ...flow.statuses,
      ...ghostStatuses.map((id) => ({ id, name: id, color: '#78716c' })),
    ],
    [flow, ghostStatuses],
  );

  const byColumn = useMemo(() => {
    const map: Record<string, Task[]> = {};
    for (const s of boardColumns) map[s.id] = [];
    if (store) {
      /*
        看板也跟随用户点的排序。
        原来这里用 sortTasks（写死"优先级 + 更新时间"）——
        于是列表里点了"按更新排"，切到看板顺序纹丝不动，
        而顶栏还写着"排序：更新 ↓"，看着像生效了，实际没有。
      */
      const list = sortTasksBy(filtered, sort.field, sort.dir, tagNames);
      for (const t of list) {
        if (!map[t.status]) map[t.status] = [];
        map[t.status].push(t);
      }
    }
    return map;
  }, [store, filtered, boardColumns, tagNames]);
  const listRows = useMemo(
    () => sortRowsBy(filteredRows, sort.field, sort.dir, tagNames),
    /*
      ⛔ tagNames 必须进依赖：改了标签名之后排序结果会变，
      不重算的话列表还停在旧顺序上 —— 而改名明明已经生效了。
    */
    [filteredRows, sort, tagNames],
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
    /*
      传 flow：按状态分组时，组顺序要按**流程里配置的先后**排。
      不传的话自定义流程的 id 在默认排名表里查不到 → 全部落到同一档 →
      顺序变成数据里的先后顺序，"待办/在做/已完成"的推进感全没了。
    */
    () => groupTasksBy(listRows.map((r) => r.task), groupKeys, flow),
    [listRows, groupKeys, flow],
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
  /*
    显示/隐藏一列。
    ⛔ 不允许把最后一列也藏掉 —— 全隐藏得到的是一张空表格，
    而界面上看不出是"没数据"还是"列被藏了"，那是个没救的死局。
  */
  const toggleCol = (field: string, show: boolean) => {
    setColHidden((prev) => {
      const next = prev.filter((x) => x !== field);
      if (!show) {
        /*
          藏掉之后一列都不剩 → 拒绝这次操作。
          摆着能点、点了没反应，比直接不让点更让人困惑，
          所以调用方会把这种情况下的勾选框置灰（不是点了才提示）。
        */
        if (LIST_COLUMNS.length - next.length <= 1) return prev;
        /*
          ⛔ 藏掉**正在排序的那一列**时，必须把排序挪走：
          排序只能点列头改，列头随列一起消失了 ——
          于是顶栏写着"排序：分组 ↓"，而列表里根本没有分组列，
          顺序看着像随机，且没有任何入口能改它（只能去点别的列头撞运气）。

          自动落到默认排序（更新 ↓）并说明，比留一个不可解释的顺序要好。
        */
        if (sort.field === field) {
          setSort({ field: 'updatedAt', dir: 'desc' });
          persist('sort', { field: 'updatedAt', dir: 'desc' });
          ctx.toast(`「${sortLabel(field as SortField)}」列已隐藏，排序改为「更新 ↓」`, 'ok');
        }
        next.push(field);
      }
      persist('colHidden', next);
      return next;
    });
  };

  const colWidthRef = useRef(colWidths);
  colWidthRef.current = colWidths;
  const setColWidth_ = (field: string, px: number) => {
    const w = Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.round(px)));
    setColWidths((prev) => {
      const next = { ...prev, [field]: w };
      colWidthRef.current = next;
      return next;
    });
  };

  /*
    行内挂/摘一个标签。
    与 toggleType 同构：任务上只存 id，改的是"这条属于哪个标签"，
    不是改标签本身的定义（那是 doSetTagColor / doAddTag 的事）。
  */
  const toggleTaskTag = (taskId: string, tagId: string) =>
    withErr(async () => {
      if (!cfg) return;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const idx = st.tasks.findIndex((t) => t.id === taskId);
        if (idx < 0) return null;
        const cur = st.tasks[idx].tags || [];
        const next = cur.indexOf(tagId) >= 0
          ? cur.filter((x) => x !== tagId)
          : [...cur, tagId];
        const tasks = [...st.tasks];
        tasks[idx] = { ...tasks[idx], tags: next, updatedAt: Date.now() };
        return { ...st, tasks };
      });
      await refresh();
    })();

  /* 列宽落盘（拖动结束时调一次，不是每帧） */
  const persistColWidths = () => {
    persist('colWidths', colWidthRef.current);
  };

  /* 重置列宽：把用户拖过的都清掉，回到默认的那一套 */
  const resetColWidths = () => {
    setColWidths({});
    persist('colWidths', {});
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
  /*
    类型改名 / 改色。
    ⛔ 必须立刻重读：原来这里没有 refresh，只靠 2s 轮询兜 ——
    改名之后下拉里、筛选摘要里、列表里全是旧名字，要等两秒才变，
    看着像点了没反应。（删类型、删标签、改标签那边都有 refresh，就这里漏了。）
  */
  const setTypeDef = (id: string, patch: { name?: string; color?: string }) =>
    withErr(async () => {
      if (!cfg) return;
      await S.mutate(ctx, cfg.dataDir, (st) => ({
        ...st,
        typeDefs: (st.typeDefs || []).map((d) => (d.id === id ? { ...d, ...patch } : d)),
      }));
      await refresh();
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
      /*
        同上：新建完必须立刻重读，否则下拉里要等两秒才出现这个类型，
        而这两秒里用户已经按了回车却什么都没看到，会以为没建成。
      */
      await refresh();
    })();

  /*
    删类型：先把挂在这个类型上的任务清空，再删定义。
    顺序不能反 —— 先删定义的话那些任务上留着不存在的 id，
    界面显示成原始 id（'t3'），而定义已经没了、改都没法改。
  */
  const removeType = (id: string) =>
    withErr(async () => {
      if (!cfg) return;
      /*
        计数用**整体赋值**（n = …）而不是累加：mutate 带乐观锁，
        写冲突时会重读再跑一次回调，累加会把条数报成两倍。
      */
      let n = 0;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        n = (st.tasks || []).filter((t) => t.type === id).length;
        return {
          ...st,
          /*
            清空类型是**改任务**，要推进 updatedAt ——
            不推进的话"更新"列不动，看着像这几条没被改过。
          */
          tasks: (st.tasks || []).map((t) => (
            t.type === id ? { ...t, type: '', updatedAt: Date.now() } : t
          )),
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
      /*
        ⛔ 必须立刻重读：原来这里没有 refresh，只靠 2s 轮询兜 ——
        于是点了"删"，界面要过两秒才变；而这两秒里列表、筛选下拉、
        chip 全都还是老样子，看着像点了没反应（删标签那边是有 refresh 的）。
      */
      await refresh();
      if (n > 0) ctx.toast(`已删类型，${n} 条任务变成「未分类」`, 'ok');
    })();

  /** 给某条任务挂/摘类型（列头下拉里点） */
  const toggleType = (taskId: string, typeId: string) =>
    withErr(async () => {
      if (!cfg) return;
      /*
        ⛔ 两点与 toggleTaskTag（挂/摘标签）对齐，它是同款操作：
        · 必须立刻重读 —— 原来这里没有 refresh，只靠 2s 轮询兜，
          点了类型要过两秒才变，看着像点了没反应
        · 必须推进 updatedAt —— 改的是任务，不推进的话"更新"列不动
      */
      await S.mutate(ctx, cfg.dataDir, (st) => ({
        ...st,
        tasks: (st.tasks || []).map((t) => (
          t.id === taskId
            ? { ...t, type: t.type === typeId ? '' : typeId, updatedAt: Date.now() }
            : t
        )),
      }));
      await refresh();
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
      /*
        通知的触发状态由配置决定，不写死 'review'：
        自定义流程里"审查"那一步可能叫别的，
        写死的话配了 notifyUrl 也**永远收不到通知**，而且没有提示。
      */
      if (to === (cfg.notifyStatus || 'review')) await S.notifyWebhook(cfg, task);
      /*
        ⛔ 状态名不能查写死的 STATUS_LABEL：
        那是**默认那五个**的名字表，自定义流程的 id（s2、'完工'…）在里面查不到，
        于是 toast 显示的是原始 id（"tb-0001 → s2"），
        而列表里同一条显示的是"开发中" —— 两处说法不一样。
        用 statusName(flow, to)：它认流程配置。
      */
      ctx.toast(`${id} → ${statusName(flow, to)}`, 'ok');
    })();

  const doClaim = (id: string) =>
    withErr(async () => {
      if (!cfg) return;
      let claimed = false;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const idx = st.tasks.findIndex((t) => t.id === id);
        if (idx < 0) return null;
        const cur = st.tasks[idx];
        /*
          认领推进到哪一步，**不能写死 'claimed'**。

          ⛔ 写死的后果（自定义流程下必现）：
          applyTransition 走流转校验，'claimed' 不在用户配的流程里 →
          返回 null → 这个回调返回 null → mutate **什么都不写** ——
          而下面照样弹「已认领」。那是**撒谎**：
          任务其实还是没人认领，别人可以同时认领它，
          而本人以为自己负责这条。（比直接报错糟得多。）

          改成从流程里取：只在**初始态**时推进（走第一条边），
          不在初始态就只署名、不改状态 ——
          认领的本质是署名，不该因为流程里没有那条边就整个失败。
        */
        const init = initialStatus(flow);
        let next = null;
        if (cur.status === init) {
          const acts = actionsForIn(flow, cur.status);
          if (acts.length > 0) next = applyTransition(cur, acts[0].to, me);
        }
        /* 流程里没有可走的边（终态、或只配了一个状态）：只署名 */
        if (!next) next = { ...cur };
        if (next.assignee === me && next.status === cur.status) return null;
        next.assignee = me;               // 认领必须署名
        const tasks = [...st.tasks];
        tasks[idx] = next;
        claimed = true;                   // 整体赋值：mutate 冲突重试不会重复计数
        return { ...st, tasks };
      });
      await refresh();
      /* 没认领成就不要报成功 —— 那是最难自查的一种错 */
      if (!claimed) {
        ctx.toast(`${id} 认领未生效（任务不存在，或它已经是你认领的）`, 'err');
        return;
      }
      ctx.toast(`${id} 已由 ${me} 认领`, 'ok');
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
  /*
    换项目 / 新建项目时清掉与"上一个项目"绑定的界面状态。

    ⛔ 文档提醒也必须重置：注释里写的是"换个项目会重新提醒，那是另一个项目的事"，
    但原来只有设置页那边（走 config 事件）重置了，主视图切换项目这条路径没重置 ——
    于是在甲关掉提醒后切到乙，乙的文档路径同样没设，却再也不提醒了。
    说好会重新提醒却不提醒，比一开始就没这个机制更让人不信任。
  */
  const clearViewState = () => {
    setColFilters({});
    setQ('');
    setChecked(new Set());
    setDetailId(null);
    setDocsHintClosed(false);
  };

  const doSwitchProject = (id: string) =>
    withErr(async () => {
      if (!cfg || id === cfg.currentId) return;
      const next = await S.switchProject(ctx, cfg, id);
      setCfg(next);
      clearViewState();
      /*
        ⛔ 读失败不能静默当"空项目"：
        目录没授权、路径写错、被删了 —— 这些都会走进 catch，
        而 .catch(() => null) 之后一律显示 0 条任务，
        和"这个项目确实是空的"长得一模一样。

        用户切过去看到一片空白，分不清是"新项目还没建任务"
        还是"读不到"，于是会以为切换没生效（又绕回上一个误解）。
        所以读不到要明说。
      */
      let st: TaskStore | null = null;
      let readErr = '';
      try {
        st = await S.readStore(ctx, next.dataDir);
      } catch (e: any) {
        readErr = String(e?.message || e);
      }
      setStore(st || normalizeStore(null));
      await restartServiceIfOn(cfg, next);
      if (readErr) {
        ctx.toast(`已切到「${currentProject(next).name}」，但读不到它的任务库：${readErr}`, 'err');
      } else {
        ctx.toast(`已切到「${currentProject(next).name}」`, 'ok');
      }
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

  /*
    批量操作。勾选框原来只服务于"合并成组"，组改成视图概念之后
    它就没了用途 —— 留着是个点了没反应的控件，所以换成批量改字段。

    ⛔ 改状态**逐条走流转校验**，不是一把赋值：
    自定义流程里从"待办"直接跳"已完成"可能是不允许的边。
    一把赋值会把流程规则绕过，事后没人知道这些任务是"正常做完"还是"被改成做完"。
    走不通的那几条跳过并报数，而不是整批失败 —— 报数才看得出是哪几条。
  */
  const doBatchStatus = (ids: string[], to: string) =>
    withErr(async () => {
      if (!cfg || ids.length === 0 || !to) return;
      /*
        ⛔ 计数与 skipped 都**不能累加**：mutate 带乐观锁，写冲突时会重读再跑回调，
        累加一遍就是两倍（toast 说"已改 8 条"而实际只有 4 条）。
        改成在回调内**整体算出来再整体赋值**，重试时以最后一次为准。
      */
      let done = 0;
      let skipped: string[] = [];
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const want = new Set(ids);
        let ok = 0;
        const skip: string[] = [];
        const tasks = st.tasks.map((t) => {
          if (!want.has(t.id)) return t;
          if (!canTransitionIn(st.flow, t.status, to)) { skip.push(t.id); return t; }
          const next = applyTransition(t, to, me);
          if (!next) { skip.push(t.id); return t; }
          ok += 1;
          return next;
        });
        done = ok;
        skipped = skip;
        return ok === 0 ? null : { ...st, tasks };
      });
      setChecked(new Set());
      await refresh();
      if (done === 0) ctx.toast(`没有一条能从当前状态走到「${statusName(flow, to as TaskStatus)}」`, 'err');
      else if (skipped.length > 0) ctx.toast(`已改 ${done} 条；${skipped.length} 条走不通被跳过（${skipped.slice(0, 3).join('、')}…）`, 'err');
      else ctx.toast(`已把 ${done} 条改为「${statusName(flow, to as TaskStatus)}」`, 'ok');
    })();

  /** 批量改类型。类型没有流转规则，直接赋值即可 */
  const doBatchType = (ids: string[], typeId: string) =>
    withErr(async () => {
      if (!cfg || ids.length === 0) return;
      /*
        ⛔ 报数要用**实际命中数**，不能用 ids.length：
        勾选到写盘之间任务可能已被别的通道删掉（AI 经 API 删、或另一窗口），
        那时 toast 说"已把 3 条改了"而实际只改了 1 条 ——
        这种报数撒谎比不报更糟，因为没人会去核对。
      */
      let hit = 0;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const want = new Set(ids);
        let k = 0;
        /* 改的是任务，要推进 updatedAt（否则"更新"列不动，看着像没改） */
        const tasks = st.tasks.map((t) => {
          if (!want.has(t.id)) return t;
          k += 1;
          return { ...t, type: typeId, updatedAt: Date.now() };
        });
        hit = k;
        return { ...st, tasks };
      });
      setChecked(new Set());
      await refresh();
      if (hit === 0) ctx.toast('没有一条改成功（它们可能已被删除）', 'err');
      else ctx.toast(`已把 ${hit} 条的类型改为「${typeId === NOTYPE ? '未分类' : typeName(typeDefs, typeId)}」`, 'ok');
    })();

  const doBatchPriority = (ids: string[], prio: string) =>
    withErr(async () => {
      if (!cfg || ids.length === 0 || !prio) return;
      /* 同上：报数用实际命中数，不用 ids.length */
      let hit = 0;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const want = new Set(ids);
        let k = 0;
        const tasks = st.tasks.map((t) => {
          if (!want.has(t.id)) return t;
          k += 1;
          return { ...t, priority: prio as Priority, updatedAt: Date.now() };
        });
        hit = k;
        return { ...st, tasks };
      });
      setChecked(new Set());
      await refresh();
      if (hit === 0) ctx.toast('没有一条改成功（它们可能已被删除）', 'err');
      else ctx.toast(`已把 ${hit} 条的优先级改为 ${prio}`, 'ok');
    })();

  /*
    批量删除。删之前要说清条数 ——
    批量操作里"勾多了自己没发现"是常见失误，而删除不可撤销。
  */
  const doBatchDelete = (ids: string[]) =>
    withErr(async () => {
      if (!cfg || ids.length === 0) return;
      /*
        删之前要说清两件事：**条数**，以及**有多少条任务在依赖它们**。

        ⛔ 依赖不说出来是坑：删掉之后那些任务的前置变成"已被删除"，
        永远解锁不了（而界面上只显示一把锁，不说清是哪个前置没了）。
        用户是在不知情的情况下制造了一批永远卡住的任务。
      */
      const want = new Set(ids);
      const broken = (store ? store.tasks : []).filter(
        (t) => !want.has(t.id) && (t.deps || []).some((d) => want.has(d)),
      );
      const msg = `删除选中的 ${ids.length} 条任务？\n\n不可撤销。`
        + (broken.length > 0
          ? `\n\n另有 ${broken.length} 条任务把它们列为前置，删除后那些任务会永远卡住：\n`
            + broken.slice(0, 5).map((t) => `· ${t.id}`).join('\n')
            + (broken.length > 5 ? `\n…等 ${broken.length} 条` : '')
          : '');
      if (!window.confirm(msg)) return;
      let hit = 0;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const before = st.tasks.length;
        const tasks = st.tasks.filter((t) => !want.has(t.id));
        hit = before - tasks.length;
        return { ...st, tasks };
      });
      setChecked(new Set());
      await refresh();
      ctx.toast(`已删除 ${hit} 条`, 'ok');
    })();

  /*
    标签定义落在 store.tagDefs（任务上只存 id）。
    颜色改一处、所有挂这个标签的行一起变 —— 这是"标签"该有的行为，
    逐行不同色就丢掉了"一眼分类"这个作用。
  */
  const doAddTag = (name: string, color: string) =>
    withErr(async () => {
      if (!cfg || !name.trim()) return;
      const nm = name.trim();
      /*
        ⛔ 同名时必须**说出来**：原来直接 return null（不写盘也不提示），
        用户敲完名字按回车，输入框清空了而下拉里什么都没多 ——
        看着就像"新建这个功能坏了"。同名是用户的输入问题，得让他知道。
      */
      let made = false;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const defs = Array.isArray(st.tagDefs) ? [...st.tagDefs] : [];
        made = false;
        if (defs.some((d) => d.name === nm)) return null;   // 同名不重复建
        /*
          颜色同样要去重（与新建类型同一判据）：
          传进来的色已被占用时取第一个没被占用的 ——
          连着建几个标签却拿到同一个颜色，颜色就失去了"一眼区分"的作用。
        */
        const used = new Set(defs.map((d) => d.color));
        const want = (color && !used.has(color))
          ? color
          : (TAG_COLORS.find((c) => !used.has(c)) || TAG_COLORS[defs.length % TAG_COLORS.length]);
        const id = `tg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        defs.push({ id, name: nm, color: want });
        made = true;
        return { ...st, tagDefs: defs };
      });
      await refresh();
      if (!made) ctx.toast(`已经有同名标签「${nm}」了`, 'err');
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
    标签改名。只改**定义**（任务上存的是 id），
    所以改一处、所有挂这个标签的行一起变。

    ⛔ 不能去改任务上的 id：那样等于换了个标签，
    原名和新名会同时存在，而界面上看不出它们原本是一个。
  */
  const doRenameTag = (id: string, name: string) =>
    withErr(async () => {
      if (!cfg || !id || !name.trim()) return;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const defs = Array.isArray(st.tagDefs) ? [...st.tagDefs] : [];
        const idx = defs.findIndex((d) => d.id === id);
        /*
          定义不存在（任务上写的是裸名字）→ 补一条，否则改名无处可落。
          ⛔ 颜色要**取第一个没被占用的**，不能固定一档：
          固定色很可能和已有标签撞色，而配色的唯一作用就是一眼区分，
          两个同色标签等于白配。
        */
        if (idx < 0) {
          const used = new Set(defs.map((d) => d.color));
          const free = TAG_COLORS.find((c) => !used.has(c));
          defs.push({ id, name: name.trim(), color: free || TAG_COLORS[0] });
        }
        else defs[idx] = { ...defs[idx], name: name.trim() };
        return { ...st, tagDefs: defs };
      });
      await refresh();
    })();

  /*
    删标签：删定义，并**从所有任务上摘掉**。

    ⛔ 只删定义不摘任务是最坏的一种：任务上还留着那个 id，
    而定义没了 → chip 显示成原始 id（tg_xxxx），
    筛选下拉里它还会从数据里冒出来（"删了又复活"），
    而且这时的标签既改不了名也改不了色（没有定义可改）。
  */
  const doRemoveTag = (id: string) =>
    withErr(async () => {
      if (!cfg || !id) return;
      const nm = (store ? store.tagDefs : []).find((d) => d.id === id)?.name || id;
      /*
        ⛔ 计数不能写成 `n += 1`：**mutate 带乐观锁，写冲突时会重读再试**，
        回调因此可能被跑多次 —— 累加就会把条数报成两倍、三倍。
        toast 里写"从 8 条任务上摘掉"而实际只有 4 条，
        这种数字对不上比不报更糟（没人会怀疑统计，只会以为自己记错了）。
        改成**整体赋值**，重试时以最后一次为准，天然正确。
      */
      let n = 0;
      await S.mutate(ctx, cfg.dataDir, (st) => {
        const defs = (Array.isArray(st.tagDefs) ? st.tagDefs : []).filter((d) => d.id !== id);
        let cnt = 0;
        const tasks = (st.tasks || []).map((t) => {
          if (!Array.isArray(t.tags) || t.tags.indexOf(id) < 0) return t;
          cnt += 1;
          /*
            摘标签是**改任务**，所以要推进 updatedAt ——
            不推进的话"更新"列纹丝不动，看着像这一行的标签没被摘掉。
          */
          return { ...t, tags: t.tags.filter((x) => x !== id), updatedAt: Date.now() };
        });
        n = cnt;
        return { ...st, tagDefs: defs, tasks };
      });
      /*
        正在用这个标签做筛选的话要一并清掉：
        留着就是"筛一个已经不存在的标签" ——
        命中数变成 0，而界面上分不清是"没有符合的任务"还是"筛的东西没了"。
      */
      setColFilters((prev) => {
        const f = prev.tags;
        if (!f || f.values.indexOf(id) < 0) return prev;
        const values = f.values.filter((x) => x !== id);
        if (values.length === 0) {
          const next: Partial<Record<SortField, ColFilter>> = { ...prev };
          delete next.tags;
          return next;
        }
        return { ...prev, tags: { ...f, values } };
      });
      await refresh();
      ctx.toast(`已删标签「${nm}」${n > 0 ? `，并从 ${n} 条任务上摘掉` : ''}`, 'ok');
    })();

  /*
    改字段（说明 / 前置）。

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
      /*
        与批量删除同一判据：**有几条任务把它列为前置**要说出来。
        删掉之后那些任务的前置变成"已被删除"，永远解锁不了 ——
        用户是在不知情的情况下制造了一批永远卡住的任务，
        而界面上只显示一把锁，不说清是哪个前置没了。
      */
      const dependents = (store ? store.tasks : []).filter(
        (t) => t.id !== id && (t.deps || []).indexOf(id) >= 0,
      );
      if (dependents.length > 0) {
        const ok = window.confirm(
          `删除 ${id}？\n\n有 ${dependents.length} 条任务把它列为前置，`
          + '删除后那些任务会永远卡住：\n'
          + dependents.slice(0, 5).map((t) => `· ${t.id}`).join('\n')
          + (dependents.length > 5 ? `\n…等 ${dependents.length} 条` : ''),
        );
        if (!ok) return;
      }
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
  /*
    未完成 = **不算完成**，判据要认流程配置。
    ⛔ 写死 `!== 'done'` 的话，自定义流程里的完成态（'完工'、's3'…）
    全被算成未完成 —— 顶栏那个数字虚高，
    而用户只会以为"还有这么多没做完"，不会想到是判据写死了。
  */
  const openCount = store.tasks.filter((t) => !statusDone(flow, t.status)).length;

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
          {/*
            项目切换器。项目 = 一份独立任务库，切了换一整套任务。

            ⛔ 必须带「项目」文字标签、且摆在右侧第一位：
            原来它是一个裸 <select>，挤在「导入…」「＋项目」几个按钮中间，
            没有任何标识说明它是切项目的 ——
            用户新建完第二个项目，顶栏多了个下拉却认不出那是切换器，
            于是"根本没有切换方式"。（身份表也是每个项目独立的，
            所以"项目"排在"身份"前面，符合上下文层级。）

            项目多于一个时加强调：这时"还能切到别处"是真实信息，
            只有一个项目时低调即可（切无可切，强调它只会误导）。
          */}
          <label className="tb-field">
            <span>项目</span>
            <select
              className={'tb-projsel' + (cfg.projects.length > 1 ? ' has-more' : '')}
              value={cfg.currentId}
              title={
                cfg.projects.length > 1
                  ? `切换项目（共 ${cfg.projects.length} 个，每个是独立的任务库与文档路径）`
                  : '当前项目（再建一个就能在这里切换）'
              }
              onChange={(e) => doSwitchProject(e.target.value)}
            >
              {cfg.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
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
                {c.label}：{filterSummary(c, f, typeDefs, store ? store.tagDefs : [], flow)}
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
          {boardColumns.map((sd) => (
            <section key={sd.id} className="tb-col">
              <header className="tb-col-head">
                <span className="tb-col-dot" style={{ background: sd.color }} />
                {sd.name}
                <span className="tb-col-num">{(byColumn[sd.id] || []).length}</span>
                {ghostStatuses.indexOf(sd.id) >= 0 ? (
                  <span
                    className="tb-col-ghost"
                    title={`有任务处于「${sd.id}」，但流程配置里没有这个状态——它可能是被删掉的状态，或由 AI 经 API 写入。请到流程设置里补上或改掉这些任务`}
                  >
                    未配置
                  </span>
                ) : null}
              </header>
              <div className="tb-col-body">
                {(byColumn[sd.id] || []).length === 0 && <div className="tb-col-empty">空</div>}
                {(byColumn[sd.id] || []).map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    me={me}
                    flow={flow}
                    tagDefs={tagDefs}
                    onOpen={() => setDetailId(t.id)}
                    onAction={(to, needNote) => (needNote ? setRejectFor({ id: t.id, to }) : doTransition(t.id, to))}
                    onClaim={() => doClaim(t.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {/*
        **当前项目与别的项目共用同一个数据目录** —— 必须摆在主界面上。

        这条比文档路径提醒更急：共用目录意味着在甲里改任何东西，
        乙"同时"变，而界面只显示项目名，完全看不出它们其实是一份数据。
        更关键的是——**切项目看起来"没生效"就是这个造成的**：
        切到乙，乙指向的却是甲的目录，于是看到的还是甲的任务。

        历史上有个 bug 会在切换时把旧项目的 dataDir 盖到新项目头上（已修），
        但**已经被写坏的配置留在磁盘上不会自己好**，所以这里要能查出来。

        只报不改：改成什么目录只有用户知道，猜一个就是把数据挪到错地方。
      */}
      {sameDir.length > 0 ? (
        <div className="tb-dochint warn">
          <span className="tb-dochint-ico">⚠</span>
          <span className="tb-dochint-text">
            项目「{currentProject(cfg).name}」和{' '}
            {sameDir[0].ids.filter((id) => id !== cfg.currentId).length} 个其他项目
            共用同一个数据目录（{sameDir[0].dir}）——
            在这里改任何东西，那些项目也会跟着变；切过去看起来"没生效"就是这个原因。
            请到设置 → 项目，给其中一个「改数据目录」。
          </span>
        </div>
      ) : null}

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
          taskStore={store}
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
          onRenameTag={doRenameTag}
          onRemoveTag={doRemoveTag}
          checked={checked}
          onCheck={(id, on) => setChecked((prev) => {
            const next = new Set(prev);
            if (on) next.add(id); else next.delete(id);
            return next;
          })}
          onBatchStatus={doBatchStatus}
          onBatchType={doBatchType}
          onBatchPriority={doBatchPriority}
          onBatchDelete={doBatchDelete}
          colHidden={colHidden}
          colWidths={colWidths}
          onSetStatus={(id, to, needNote) => (needNote ? setRejectFor({ id: id, to }) : doTransition(id, to as TaskStatus))}
          onPatchField={(id, patch) => doPatch(id, patch)}
          onToggleTag={toggleTaskTag}
          onToggleCol={toggleCol}
          onColWidth={setColWidth_}
          onColResizeEnd={persistColWidths}
          onResetWidths={resetColWidths}
          sort={sort}
          filters={colFilters}
          onSort={changeSort}
          onFilter={setColFilter}
          onClearFilter={clearColFilter}
          onOpen={(id) => setDetailId(id)}
        />
      )}

      {/*
        分组视图：选一列（或几列）作为分组依据，按那一列的值聚合显示。
        数据本身不变 —— 没有父子层级，也没有 kind='group' 的记录。
        想换种看法就换分组依据，不用去动数据。
      */}
      {view === 'group' && (
        <GroupView
          groups={groups}
          groupKeys={groupKeys}
          flow={flow}
          me={me}
          tagDefs={tagDefs}
          onOpen={(id) => setDetailId(id)}
          onAction={(id, to, needNote) => (needNote ? setRejectFor({ id, to }) : doTransition(id, to))}
          onClaim={(id) => doClaim(id)}
        />
      )}

      {/* 统计：看全量，不受顶部筛选影响 */}
      {view === 'stats' && stats && (
        <StatsView
          stats={stats}
          flow={flow}
          typeDefs={typeDefs}
          tagDefs={store.tagDefs}
          onOpen={(id) => setDetailId(id)}
        />
      )}

      {/* 新建任务 */}
      {newOpen && (
        <NewTaskModal
          typeDefs={typeDefs}
          groups={allGroupNames}
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
              let st: TaskStore | null = null;
              let readErr = '';
              try {
                st = await S.readStore(ctx, next.dataDir);
              } catch (e2: any) {
                readErr = String(e2?.message || e2);
              }
              setStore(st || normalizeStore(null));
              await restartServiceIfOn(cfg, next);
              ctx.toast(
                readErr
                  ? `已导入「${currentProject(next).name}」，但读不到它的任务库：${readErr}`
                  : `已导入项目「${currentProject(next).name}」`,
                readErr ? 'err' : 'ok',
              );
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

      {detail && (
        <DetailModal
          task={detail}
          me={me}
          tasks={store.tasks}
          taskStore={store}
          tagDefs={store.tagDefs}
          typeDefs={typeDefs}
          flow={flow}
          onClose={() => setDetailId(null)}
          onComment={(note) => doComment(detail.id, note)}
          onDelete={() => doDelete(detail.id)}
          onAction={(to, needNote) => (needNote ? setRejectFor({ id: detail.id, to }) : doTransition(detail.id, to))}
          onClaim={() => doClaim(detail.id)}
          onPatch={(patch) => doPatch(detail.id, patch)}
          onOpen={(id) => setDetailId(id)}
        />
      )}

      {/* 打回备注 */}
      {rejectFor && (
        <RejectModal
          to={rejectFor.to}
          label={statusName(flow, rejectFor.to)}
          onClose={() => setRejectFor(null)}
          onOk={async (note) => {
            const id = rejectFor.id;
            const to = rejectFor.to;
            setRejectFor(null);
            await doTransition(id, to as TaskStatus, note);
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
  tagDefs,
  onOpen,
  onAction,
  onClaim,
}: {
  task: Task;
  me: string;
  flow: FlowLike;
  /** 标签定义：卡片上的标签要显示名字而不是 id */
  tagDefs: TagDef[];
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
      {/*
        分组。判据与上面的类型**一样**：看板是主视图之一，
        列表里有分组列而看板看不到，会让人以为"这条没分组"
        （尤其是刚在列表里给一批任务填上分组、切到看板发现什么都没变）。
      */}
      {task.group ? (
        <div className="tb-task-tags">
          <span className="tb-tag tb-tag-group" title={`分组：${task.group}`}>
            {task.group}
          </span>
        </div>
      ) : null}
      {task.tags.length > 0 && (
        <div className="tb-task-tags">
          {/*
            ⛔ 标签**必须走 TagChip**：任务上存的是 id（tg_xxxx），
            原来这里直接渲染裸值，于是卡片上显示的是一串没人看得懂的字符，
            而且没有颜色（同一张卡片上的类型是有颜色的）——
            看板因此看不出这些标签是什么、也分不清彼此。
          */}
          {task.tags.map((tag) => (
            <TagChip key={tag} id={tag} defs={tagDefs} />
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
          {/* 同详情面板：认领按钮的判据是**初始态**，不写死 'todo' */}
          {task.status === initialStatus(flow) && (
            <button className="tb-act sm" onClick={onClaim} title={`以 ${me} 身份认领`}>
              认领
            </button>
          )}
          {acts
            /*
            过滤：从初始态直接"认领"这一步单独有按钮（上面那个），
            这里不再重复摆一次。

            ⛔ 不能写死 'todo' / 'claimed'：自定义流程里初始态可能叫别的，
            认领那一步也可能叫别的。用流程里的**初始态**判，
            而"认领"这一步的特征是"从初始态出发的第一步"，
            保留原语义即可（重复按钮只是看着乱，不阻断操作）。
          */
          .filter((a) => !(task.status === initialStatus(flow) && a.to === (flow.statuses[1] || {}).id))
            .map((a) => (
              <button
                key={a.to}
                /*
                主按钮（高亮）的判据是"这条边通向完成态"，
                ⓘ 不能写死 'done'：自定义流程下完成态可能叫 's3'、'完工'…
                写死的话**没有一个按钮会高亮**，
                而高亮正是用来暗示"这一步是往前推进"的。
              */
              className={'tb-act sm' + (statusDone(flow, a.to) ? ' primary' : '') + (a.needNote ? ' warn' : '')}
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
        /*
          ⛔ 必须 stopPropagation：整行 onClick 是"打开详情"，
          不拦的话点类型会顺带弹出详情窗 —— 改个字段弹出一个窗，
          等于行内编辑白做了。
        */
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
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
    /*
      ⛔ 取色不能按"已有数量取模"（这里原来就是这么写的）：
      取模恰好会落在**已被占用**的那一档上 ——
      于是新建的状态和某个已有状态同色，而配色的唯一作用就是一眼区分。

      与新建类型 / 新建标签统一判据：取第一个还没人用的颜色。
      三个入口必须一致，否则同一个"新建"动作在不同地方得到不同颜色，
      看着像三条互不相干的规则。
    */
    const used = new Set(draft.statuses.map((s2) => s2.color));
    const color = TAG_COLORS.find((c) => !used.has(c))
      || TAG_COLORS[draft.statuses.length % TAG_COLORS.length];
    /*
      新建状态**顺手接一条边**（从原来的最后一个状态指过来）。

      ⛔ 不接的话新状态是个**孤岛**：它出现在下拉里、也出现在看板列上，
      但没有任何路径能走到它 —— 所有任务上一个状态都点不到它，
      用户在流转矩阵里不一定反应得过来要去勾哪几格。
      （列表里点状态会看到它置灰 + tooltip 解释"走不过去"，
        但那是在**用**的时候才发现，不如建的时候就接上。）

      接哪条：追加在末尾 → 从原末尾状态过来，符合"流程里加一步"的直觉。
      不对的话用户在矩阵里取消即可，比自己找到该勾哪格容易。
    */
    const prevId = draft.statuses.length > 0 ? draft.statuses[draft.statuses.length - 1].id : '';
    setDraft((d) => ({
      ...d,
      statuses: [...d.statuses, {
        id, name, color, enter: `标为「${name}」`, done: false,
      }],
      transitions: prevId
        ? { ...d.transitions, [prevId]: [...(d.transitions[prevId] || []), id] }
        : d.transitions,
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

/* ================================================================ 行内编辑 */

/*
 * 行内编辑：**点一下就地改，不弹窗**（参考腾讯文档智能表的交互）。
 *
 * 之前改任何字段都要点开详情弹窗 —— 而实际使用里绝大多数改动是
 * "把这条标成进行中""改个优先级"，为一两个字段开关一次弹窗太重，
 * 而且弹窗盖住了列表，改完还得在几十行里找回刚才那一行在哪。
 *
 * ⛔ 停止冒泡是**必须的**：整行 onClick 是"打开详情"，
 * 单元格里点一下会顺带把详情弹窗也打开 —— 改个状态弹出一个窗，
 * 那就是弹窗没去掉，只是多了一步。
 */

/** 单选型（状态 / 优先级 / 认领人这类） */
function InlinePick({
  cur,
  options,
  onPick,
  title,
  dot,
}: {
  /** 当前显示的内容 */
  cur: React.ReactNode;
  options: {
    id: string;
    label: string;
    /** 圆点颜色（状态 / 类型这类有色字段） */
    color?: string;
    /** 当前值 */
    on?: boolean;
    /** 走不通的选项：置灰并说明原因，而不是点了没反应 */
    disabled?: boolean;
    why?: string;
  }[];
  onPick: (id: string) => void;
  title?: string;
  dot?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <span
      className={'tb-ic' + (open ? ' open' : '')}
      ref={ref}
      onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      title={title}
    >
      {dot ? <span className="tb-col-dot" style={{ background: dot }} /> : null}
      <span className="tb-ic-val">{cur}</span>
      {open ? (
        <span className="tb-ic-pop" onClick={(e) => e.stopPropagation()}>
          {options.map((o) => (
            <button
              key={o.id}
              type="button"
              className={'tb-ic-opt' + (o.on ? ' on' : '')}
              disabled={o.disabled}
              title={o.disabled ? o.why : o.label}
              onClick={() => {
                if (o.disabled) return;
                onPick(o.id);
                setOpen(false);
              }}
            >
              {o.color ? (
                <span className="tb-col-dot" style={{ background: o.color }} />
              ) : null}
              <span className="tb-ic-txt">{o.label}</span>
              {o.on ? <span className="tb-ic-ck">✓</span> : null}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** 文本 / 数字输入型（标题 / 说明 / 预估这类） */
function InlineText({
  value,
  onCommit,
  placeholder,
  num,
  title,
  display,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  /** 数字模式：只认数字（预估人日） */
  num?: boolean;
  title?: string;
  /** 不编辑时显示的内容（默认是 value） */
  display?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);

  /*
    打开时把当前值带进输入框。
    不带的话一点开就是空的，看着像"这行没内容"，
    而实际上只是输入框没初始化 —— 那种误会会让人以为数据丢了。
  */
  useEffect(() => { if (open) setDraft(value); }, [open, value]);

  const commit = () => {
    setOpen(false);
    const v = draft.trim();
    if (v === value.trim()) return;                 // 没改就不写盘
    if (num && v !== '' && !/^\d+(\.\d+)?$/.test(v)) return;   // 数字列不认别的
    onCommit(v);
  };

  return (
    <span className={'tb-ic' + (open ? ' open' : '')} title={title}>
      {open ? (
        <input
          className="tb-ic-input"
          autoFocus
          value={draft}
          placeholder={placeholder}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (isComposing(e.nativeEvent)) return;   // 中文输入法组词中不提交
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') { setDraft(value); setOpen(false); }
          }}
        />
      ) : (
        <span
          className="tb-ic-val"
          onClick={(e) => { e.stopPropagation(); setOpen(true); }}
        >
          {display !== undefined ? display : (value || <span className="tb-ldim">—</span>)}
        </span>
      )}
    </span>
  );
}

/** 多选型（标签：一条任务可以同时有多个） */
function InlineTags({
  cur,
  defs,
  onPick,
  title,
}: {
  cur: string[];
  defs: { id: string; name: string; color: string }[];
  onPick: (id: string) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <span
      className={'tb-ic' + (open ? ' open' : '')}
      ref={ref}
      onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      title={title}
    >
      <span className="tb-ic-val">
        {cur.length > 0 ? (
          <span className="tb-ltags">
            {cur.map((id) => <TagChip key={id} id={id} defs={defs} />)}
          </span>
        ) : (
          <span className="tb-ldim">—</span>
        )}
      </span>
      {open ? (
        /*
          ⛔ 选完**不关闭**：标签是多选，勾一个就关的话
          想勾三个就要点开三次，那还不如去详情里改。
        */
        <span className="tb-ic-pop" onClick={(e) => e.stopPropagation()}>
          {defs.length === 0 ? (
            <span className="tb-ic-hint">还没有标签，去列头的漏斗里新建</span>
          ) : defs.map((d) => {
            const on = cur.indexOf(d.id) >= 0;
            return (
              <button
                key={d.id}
                type="button"
                className={'tb-ic-opt' + (on ? ' on' : '')}
                onClick={() => onPick(d.id)}
              >
                <span className="tb-col-dot" style={{ background: d.color }} />
                <span className="tb-ic-txt">{d.name}</span>
                {on ? <span className="tb-ic-ck">✓</span> : null}
              </button>
            );
          })}
        </span>
      ) : null}
    </span>
  );
}

/* ================================================================ 列表视图 */

/**
 * 列显示设置。勾选决定哪些列显示。
 *
 * ⛔ 最后一个已显示的列**不允许取消**：
 * 全隐藏得到的是一张空表格，而界面上看不出是"没数据"还是"列被藏了"。
 * 所以那一个勾选框直接置灰 —— 摆着能点、点了没反应，比不让点更让人困惑。
 */
function ColSettingsPop({
  hidden,
  onToggle,
  onResetWidths,
}: {
  hidden: string[];
  onToggle: (field: string, show: boolean) => void;
  onResetWidths: () => void;
}) {
  const shown = LIST_COLUMNS.filter((c) => hidden.indexOf(c.field) < 0);
  return (
    <div className="tb-colset">
      <div className="tb-colset-title">显示的列</div>
      {LIST_COLUMNS.map((c) => {
        const show = hidden.indexOf(c.field) < 0;
        const isLast = show && shown.length === 1;
        return (
          <label
            key={c.field}
            className={'tb-colset-row' + (isLast ? ' locked' : '')}
            title={isLast ? '至少要留一列' : `显示「${c.label}」`}
          >
            <input
              type="checkbox"
              checked={show}
              disabled={isLast}
              onChange={(e) => onToggle(c.field, e.target.checked)}
            />
            <span>{c.label}</span>
            {isLast ? <span className="tb-colset-why">（至少留一列）</span> : null}
          </label>
        );
      })}
      <div className="tb-colset-foot">
        <button type="button" className="tb-act sm" onClick={onResetWidths}>
          重置列宽
        </button>
        <span className="tb-colset-hint">拖表头右缘可改列宽</span>
      </div>
    </div>
  );
}



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
  flow?: FlowLike,
): string {
  if (field === 'priority') return `${v} ${PRIORITY_LABEL[v as Priority] || ''}`.trim();
  /*
    状态名走 statusName(flow, v)，不查写死的 STATUS_LABEL：
    自定义流程的 id 在那张默认表里查不到，于是筛选面板里显示
    "s2"，而列表同一行显示"开发中" —— 同一个筛选两处说法不一样。
  */
  if (field === 'status') return statusName(flow, v as TaskStatus);
  /*
    未分类是哨兵值（不在定义表里），必须在这里单独认 ——
    否则 chip 上会显示 "__notype__"，没人看得懂那一串下划线是什么。
  */
  if (field === 'type') return v === NOTYPE ? '未分类' : (typeName(defs, v) || v);
  /* 老存档 / AI 手写的数据里可能是空串，两种哨兵都认 */
  if (field === 'assignee') return !v || v === UNASSIGNED ? '未认领' : v;
  /*
    标签同理：任务上存的是 **id**（tg_xxxx），直接显示没人看得懂。
    认不出来就退回 id —— 至少看得见这里挂了个东西（AI 直接写进 JSON 的裸标签就是这种）。
  */
  if (field === 'tags') return defs?.find((d) => d.id === v)?.name || v;
  return v;
}

/**
 * 已生效筛选的一句摘要，写在 chip 上。
 *
 * 传 typeDefs：类型列显示的是 id（'dev'），不查定义表的话
 * chip 上写 "dev" 而筛选面板里写 "开发" —— 同一个筛选两处说法不一样，
 * 会让人以为那是两个不同的东西。
 */
function filterSummary(
  col: ListColumn, f: ColFilter, typeDefs?: TagDef[], tagDefs?: TagDef[], flow?: FlowLike,
): string {
  if (col.kind === 'enum') {
    /*
      ⛔ 定义表要**按列取**：原来一律传 typeDefs，
      于是标签列的筛选摘要显示成原始 id（tg_xxxx）——
      而同一个筛选在下拉面板里显示的是名字，两处说法不一样。
    */
    const defs = col.field === 'tags' ? tagDefs : typeDefs;
    return f.values.map((v) => optionLabel(col.field, v, defs)).join('、');
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
  tagDefs, onCreateTag, onTagColor, onRenameTag, onRemoveTag,
  typeDefs, onCreateType, onTypeColor, onRemoveType, onRenameType,
  /** 流程配置：状态名要认自定义流程，不能查写死的默认表 */
  flow,
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
  /** 标签改名（改的是定义：所有挂它的行一起变） */
  onRenameTag?: (id: string, name: string) => void;
  /** 删标签：调用方负责把任务上的这个标签摘掉，这里只管问一句 */
  onRemoveTag?: (id: string) => void;
  /** 类型定义。只任务类型列用得到 —— 与标签同构，同样可增删改色 */
  typeDefs?: TagDef[];
  onCreateType?: (name: string, color: string) => void;
  onTypeColor?: (id: string, color: string) => void;
  /** 删类型。调用方负责先把挂着的任务清空，这里只管问一句 */
  onRemoveType?: (id: string) => void;
  /** 类型改名（与标签同构：改的是定义） */
  onRenameType?: (id: string, name: string) => void;
  /** 流程配置（状态名认自定义流程，不能查写死的默认表） */
  flow?: FlowLike;
}) {
  const set = (patch: Partial<ColFilter>) => onChange({ ...filter, ...patch });
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(TAG_COLORS[6]);
  const isTag = col.field === 'tags';
  const isType = col.field === 'type';
  /* 两种列共用同一套"定义表 + 改色 + 新建"的交互 */
  const defs = isType ? (typeDefs || []) : (tagDefs || []);
  const colorOf = (id: string) => defs.find((d) => d.id === id)?.color || '';
  /* 正在改名的那一条（'' = 没在改）。标签与类型共用同一套输入 */
  const [editing, setEditing] = useState('');
  /*
    「未分类」是哨兵值，不是定义表里的一条。
    给它摆上调色和删除按钮是骗人：改色改不到任何东西（没有定义可改），
    点了"删"会弹确认框然后什么都没发生 —— 而用户已经以为自己删掉了什么。
  */
  const isSentinel = (id: string) => isType && id === NOTYPE;

  /*
    下方空间不够时**向上翻**。

    为什么必须动态判断而不是写死往下：
    列表容器是滚动区，表头又 sticky 在顶部 ——
    写死往下，遇到矮画布（任务只有两三条时就会这样）
    面板落到可视区外面被裁掉，只露出上半截。
    那种截断看不出是"空间不够"，只会以为面板没画完整。

    上下都不够时**不翻**，交给 CSS 的 max-height 内部滚动 ——
    翻上去同样被裁的话，翻就是白翻，还多一次跳动。
  */
  const popRef = useRef<HTMLDivElement | null>(null);
  const [flip, setFlip] = useState(false);
  useLayoutEffect(() => {
    const el = popRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vh = window.innerHeight || 0;
    const below = vh - r.bottom;
    const above = r.top;
    if (below < 8 && above > below) setFlip(true);
  }, [col.field, options.length]);
  const cls = 'tb-lpop' + (anchorRight ? ' is-right' : '') + (flip ? ' is-up' : '');

  if (col.kind === 'enum') {
    return (
      <div ref={popRef} className={cls} onClick={(e) => e.stopPropagation()}>
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
                  <span>{optionLabel(col.field, v, defs, flow)}</span>
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
                        title={`把「${optionLabel(col.field, v, defs, flow)}」改成这个颜色`}
                        onClick={() => (isType ? onTypeColor!(v, c) : onTagColor!(v, c))}
                      />
                    ))}
                  </span>
                ) : null}
                {/*
                  改名 / 删除：标签与类型**同构**，共用一套。

                  摆在这儿而不是只放在行内单元格里 ——
                  行内那个下拉是"给这一条改"，而这里是"改这个标签本身"；
                  顺手能在这里做，就不用为了改个名字先去找某一行挂着它。
                */}
                {(isTag || isType) && !isSentinel(v) ? (
                  editing === v ? (
                    <input
                      className="tb-lpop-rename"
                      autoFocus
                      defaultValue={optionLabel(col.field, v, defs, flow)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        const nv = e.target.value.trim();
                        if (nv && nv !== optionLabel(col.field, v, defs, flow)) {
                          if (isType) onRenameType?.(v, nv);
                          else onRenameTag?.(v, nv);
                        }
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
                      className="tb-lpop-edit"
                      title={`给这个${isType ? '类型' : '标签'}改名`}
                      onClick={() => setEditing(v)}
                    >
                      ✎
                    </button>
                  )
                ) : null}
                {(isTag || isType) && !isSentinel(v)
                  && (isType ? onRemoveType : onRemoveTag) ? (
                  <button
                    type="button"
                    className="tb-act sm warn tb-lpop-del"
                    title={isType
                      ? '删除这个类型（挂在这个类型上的任务会变成「未分类」）'
                      : '删除这个标签（会从所有挂它的任务上摘掉）'}
                    onClick={() => {
                      const nm = optionLabel(col.field, v, defs, flow);
                      if (isType) {
                        if (window.confirm(`删除类型「${nm}」？\n\n挂在这个类型上的任务会变成「未分类」。`)) {
                          onRemoveType!(v);
                        }
                      } else if (window.confirm(
                        `删除标签「${nm}」？\n\n会从所有挂这个标签的任务上摘掉。`,
                      )) {
                        onRemoveTag!(v);
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
      <div ref={popRef} className={cls} onClick={(e) => e.stopPropagation()}>
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
      <div ref={popRef} className={cls} onClick={(e) => e.stopPropagation()}>
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
    <div ref={popRef} className={cls} onClick={(e) => e.stopPropagation()}>
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
      {/*
        起止填反了要明确说出来：那样命中数恒为 0，
        而界面上只显示"0 / 12" —— 分不清是"这段时间没有任务"
        还是"我把日期填反了"，后者根本不会有人往那个方向想。
      */}
      {filter.min && filter.max && filter.min > filter.max ? (
        <div className="tb-lpop-warn">起始晚于结束，这样一条都筛不到</div>
      ) : null}
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
  /** 完整 store（含 flow）。形参里的 store 是 Task[]，拿不到 flow */
  taskStore,
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
  onRenameTag,
  onRemoveTag,
  checked,
  onCheck,
  onBatchStatus,
  onBatchType,
  onBatchPriority,
  onBatchDelete,
  colHidden,
  colWidths,
  onSetStatus,
  onPatchField,
  onToggleTag,
  onToggleCol,
  onColWidth,
  onColResizeEnd,
  onResetWidths,
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
  /** 完整 store（含 flow）：算前置"是否已完成"要认自定义流程，不能写死 'done' */
  taskStore: TaskStore;
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
  /** 标签改名（改定义，所有挂它的行一起变） */
  onRenameTag: (id: string, name: string) => void;
  /** 删标签：连带把任务上的这个标签摘掉 */
  onRemoveTag: (id: string) => void;
  checked: Set<string>;
  onCheck: (id: string, on: boolean) => void;
  /** 批量改状态（走流转规则，走不通的跳过并报数） */
  onBatchStatus: (ids: string[], to: string) => void;
  onBatchType: (ids: string[], typeId: string) => void;
  onBatchPriority: (ids: string[], prio: string) => void;
  /** 批量删除（调用方负责先 confirm） */
  onBatchDelete: (ids: string[]) => void;
  /*
    行内改状态。

    ⛔ needNote 的边（比如"打回"）不能就地改完就算了 ——
    那条边要求写原因，写不进去的话事后没人知道为什么打回。
    由调用方弹一个小输入框，不在这里另起一套。
  */
  onSetStatus: (id: string, to: string, needNote: boolean) => void;
  /** 行内改普通字段（标题 / 说明 / 认领人 / 预估） */
  onPatchField: (id: string, patch: Partial<Task>) => void;
  /** 行内挂/摘一个标签 */
  onToggleTag: (id: string, tagId: string) => void;
  /** 被隐藏的列（field 列表） */
  colHidden: string[];
  /** 用户手动拖过的列宽（field → px）。没拖过的列用默认值 */
  colWidths: Record<string, number>;
  onToggleCol: (field: string, show: boolean) => void;
  onColWidth: (field: string, px: number) => void;
  /** 拖动结束：把内存里的列宽落盘（拖动中不写，太密） */
  onColResizeEnd: () => void;
  onResetWidths: () => void;

  sort: { field: SortField; dir: 'asc' | 'desc' };
  filters: Partial<Record<SortField, ColFilter>>;
  onSort: (field: SortField) => void;
  onFilter: (field: SortField, f: ColFilter) => void;
  onClearFilter: (field: SortField) => void;
  onOpen: (id: string) => void;
}) {
  const [openCol, setOpenCol] = useState<SortField | ''>('');
  const [colsOpen, setColsOpen] = useState(false);

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
    /*
      ⛔ 滚动与改变窗口尺寸时要**关掉面板**：
      面板是 absolute 定位在单元格上的，滚动时单元格动了而面板不跟着动
      （它挂在一个不随内容滚动的容器里），于是面板会飘在半空、
      和它所属的列头对不上 —— 看着像面板自己跑到了别的地方。

      点错了选项却毫不知情，比"面板自动关掉要重新点一次"糟得多，
      所以这里选关掉。
    */
    const close = () => setOpenCol('');
    window.addEventListener('resize', close);
    /* 捕获阶段：滚动可能发生在任意内层容器上，冒泡阶段收不全 */
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [openCol]);

  useEffect(() => {
    if (!colsOpen) return;
    const onDown = (e: MouseEvent) => {
      const el = document.getElementById('tb-cols-host');
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setColsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [colsOpen]);

  const picked = [...checked].filter((id) => rows.some((r) => r.task.id === id));

  /*
    ⚠️ 可见列是**唯一的真相来源**：列头、网格、行内单元格三处都由它驱动。

    之前三处各写各的（列头 11 个、网格 12 列、行 12 格），
    于是列头比内容少了一格勾选列的位置 —— 整行表头向左错开一列，
    "状态"的表头压在"优先级"的内容上。那种错 TypeScript 查不出、
    单测也照过，只有肉眼看得见。

    现在三处都遍历同一个 shown，**结构上不可能再错位**。
  */
  const shown = LIST_COLUMNS.filter((c) => colHidden.indexOf(c.field) < 0);

  /** 网格：1 列勾选 + N 列可见列。拖过的用固定 px，没拖过的用默认值 */
  const gridStyle = {
    gridTemplateColumns: [
      `${PICK_COL_W}px`,
      ...shown.map((c) => (colWidths[c.field] ? `${colWidths[c.field]}px` : (DEFAULT_COL_W[c.field] || '96px'))),
    ].join(' '),
  };

  /*
    拖动改列宽。把手在列头单元格右侧。

    ⛔ 用 document 上的监听而不是React 的 onMouseMove：
    拖动时鼠标会移出把手范围（甚至移出表格），
    挂在把手上会一离开就断，表现为"拖两下就停"。
  */
  const startResize = (field: SortField, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const host = (e.currentTarget as HTMLElement).parentElement;
    if (!host) return;
    const startX = e.clientX;
    const startW = host.getBoundingClientRect().width;
    const move = (ev: MouseEvent) => {
      onColWidth(field, startW + (ev.clientX - startX));
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('tb-col-resizing');
      /*
        松手时才落盘。拖动中每帧都写一次存储太密，
        而只在内存里改、从不落盘的话，拖完一刷新就回去了 ——
        那等于白拖，而且没人会想到是没存。
      */
      onColResizeEnd();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
    /* 拖动期间禁掉文本选中：否则拖一下会顺带把表头文字刷成蓝色 */
    document.body.classList.add('tb-col-resizing');
  };

  /** 行内单元格：按 field 分发，新增列只改这一处 */
  const cellFor = (field: SortField, t: Task) => {
    switch (field) {
      case 'priority':
        return (
          <span className="tb-lc c-priority" key={field}>
            <InlinePick
              cur={<PriorityBadge p={t.priority} />}
              title="点击改优先级"
              options={PRIORITY_ORDER.map((pr) => ({
                id: pr,
                label: `${pr} ${PRIORITY_LABEL[pr]}`,
                on: t.priority === pr,
              }))}
              onPick={(id) => onPatchField(t.id, { priority: id as Priority })}
            />
          </span>
        );
      case 'id':
        return <span className="tb-lc c-id" key={field}>{t.id}</span>;
      case 'group':
        /*
          分组列：点一下就地填/改分组名。

          这就是以前的"手动分组"，但它**只是一列值** ——
          归拢关系由"按列分组"机制表达（分组设置里选「分组」这一列即可），
          于是它能和任意其它列组合成多层级，而旧的手动组只能一层层嵌套。
        */
        return (
          <span className="tb-lc c-group" key={field}>
            <InlineText
              value={t.group || ''}
              display={t.group || <span className="tb-ldim">—</span>}
              placeholder="分组名（留空=不分组）"
              title={t.group || '点击设置分组'}
              onCommit={(v) => onPatchField(t.id, { group: v })}
            />
          </span>
        );
      case 'title': {
        /* 锁定只在标题列显示时才算 —— 标题列被隐藏就别白跑 */
        /* 传 store：isDone 要认自定义流程的完成态（不能写死 'done'） */
        const lk = lockOf(t, allRows.map((r) => r.task), taskStore);
        return (
          <span className="tb-lc c-title" key={field}>
            {lk.locked ? (
              <span className="tb-lock" title={lockTitle(lk)}>🔒</span>
            ) : null}
            <InlineText
              value={t.title}
              display={<span className="tb-ltitle">{t.title}</span>}
              placeholder="任务标题"
              title="点击改标题"
              onCommit={(v) => { if (v) onPatchField(t.id, { title: v }); }}
            />
          </span>
        );
      }
      case 'status': {
        /*
          候选是**全部状态**，但走不通的置灰并说明原因。

          为什么不给"能走的才列出来"：
          那样用户看到的列表里少了几项，只会以为"这个状态没了"
          （配置出错时会真的少，那时看不出区别）；
          置灰 + tooltip 才说清"存在，但现在走不过去"。
        */
        const acts = actionsForIn(flow, t.status);
        const opts = flow.statuses.map((sd) => {
          const isCur = sd.id === t.status;
          const a = acts.find((x) => x.to === sd.id);
          return {
            id: sd.id,
            label: a ? a.label : sd.name,
            color: sd.color,
            on: isCur,
            disabled: !isCur && !a,
            why: `「${statusName(flow, t.status)}」不能直接走到「${sd.name}」`,
          };
        });
        return (
          <span className="tb-lc c-status" key={field}>
            <InlinePick
              cur={statusName(flow, t.status)}
              dot={statusColor(flow, t.status)}
              title="点击改状态"
              options={opts}
              onPick={(id) => {
                const a = acts.find((x) => x.to === id);
                onSetStatus(t.id, id, a ? a.needNote === true : false);
              }}
            />
          </span>
        );
      }
      case 'assignee':
        return (
          <span className="tb-lc c-assignee" key={field}>
            <InlineText
              value={t.assignee || ''}
              display={t.assignee ? '@' + t.assignee : <span className="tb-ldim">未认领</span>}
              placeholder="认领人（留空 = 未认领）"
              title="点击改认领人"
              onCommit={(v) => onPatchField(t.id, { assignee: v })}
            />
          </span>
        );
      case 'type':
        /*
          类型单元格：点开就地改这一条的类型。
          摆在这儿而不是只在详情里 —— 归类是一次看一批、顺手改一批的动作，
          逐条点开详情改，二十条就得开关二十次。
        */
        return (
          <span className="tb-lc c-type" key={field}>
            <TypePicker
              value={t.type}
              defs={typeDefs}
              onPick={(id) => onToggleType(t.id, id)}
              onRename={(id, name) => onRenameType(id, name)}
              onCreate={onCreateType}
            />
          </span>
        );
      case 'tags':
        return (
          <span className="tb-lc c-tags" key={field}>
            <InlineTags
              cur={t.tags || []}
              defs={tagDefs}
              title="点击改标签（可多选）"
              onPick={(id) => onToggleTag(t.id, id)}
            />
          </span>
        );
      case 'summary':
        return (
          <span className="tb-lc c-summary" key={field}>
            <InlineText
              value={t.summary || ''}
              placeholder="任务说明"
              title={t.summary || '点击填写说明'}
              onCommit={(v) => onPatchField(t.id, { summary: v })}
            />
          </span>
        );
      case 'estimate':
        /*
          数字列：只认数字。填"三天"直接忽略而不是写成 0 ——
          写成 0 会把"没估"和"估了 0"混成一样，
          而这两个在排期时含义完全不同。
        */
        return (
          <span className="tb-lc c-estimate" key={field}>
            <InlineText
              value={t.estimate ? String(t.estimate) : ''}
              num
              placeholder="人日"
              title="点击填预估工作量（人日，可小数）"
              onCommit={(v) => onPatchField(t.id, { estimate: v === '' ? 0 : Number(v) })}
            />
          </span>
        );
      case 'createdAt':
        return (
          <span className="tb-lc c-createdAt" key={field} title={fmtTime(t.createdAt)}>
            {t.createdAt ? relTime(t.createdAt) : <span className="tb-ldim">—</span>}
          </span>
        );
      case 'updatedAt':
        return (
          <span className="tb-lc c-updatedAt" key={field} title={fmtTime(t.updatedAt)}>
            {relTime(t.updatedAt)}
          </span>
        );
      default:
        /* 认不出的 field 也要占一格 —— 少一格会让后面整行错位 */
        return <span className="tb-lc" key={field}>—</span>;
    }
  };

  return (
    <div className="tb-list">
      {/*
        批量操作。整条工具栏只在勾了东西时出现 ——
        没勾时摆着四个下拉，点下去全是无操作，比没有更让人困惑。

        ⛔ 改状态/改类型/改优先级都是**选完就执行**（onChange 里直接跑），
        不再配"应用"按钮：多一步确认在这种高频小操作上只会让人犹豫，
        而且它改的是勾中的这几条，范围在界面上看得见。
        删除例外 —— 不可撤销，所以走 confirm。
      */}
      <div className="tb-ltools">
        {picked.length > 0 ? (
          <>
            <span className="tb-ltools-hint">已选 {picked.length} 条</span>
            <select
              className="tb-lbatch"
              value=""
              title="把选中的任务改到这个状态（走流转规则，走不通的会跳过）"
              onChange={(e) => { if (e.target.value) onBatchStatus(picked, e.target.value); }}
            >
              <option value="">改状态…</option>
              {flow.statuses.map((sd) => (
                <option key={sd.id} value={sd.id}>{sd.name}</option>
              ))}
            </select>
            <select
              className="tb-lbatch"
              value=""
              onChange={(e) => { if (e.target.value) onBatchType(picked, e.target.value); }}
            >
              <option value="">改类型…</option>
              {(typeDefs || []).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
              <option value={NOTYPE}>未分类</option>
            </select>
            <select
              className="tb-lbatch"
              value=""
              onChange={(e) => { if (e.target.value) onBatchPriority(picked, e.target.value); }}
            >
              <option value="">改优先级…</option>
              {PRIORITY_ORDER.map((pr) => (
                <option key={pr} value={pr}>{pr} {PRIORITY_LABEL[pr]}</option>
              ))}
            </select>
            <button type="button" className="tb-act sm warn" onClick={() => onBatchDelete(picked)}>
              删除
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
          <span className="tb-ltools-hint">勾选几条后可批量改状态 / 类型 / 优先级，或删除</span>
        )}
        {/* 列设置常驻：改哪些列显示跟有没有勾选无关，藏进"勾了才出现"里就找不到了 */}
        <span className="tb-ltools-gap" />
        <div className="tb-cols-host" id="tb-cols-host">
          <button
            type="button"
            className={'tb-act sm' + (colsOpen ? ' primary' : '')}
            onClick={() => setColsOpen(!colsOpen)}
            title="选择显示哪些列"
          >
            ⚙ 列
          </button>
          {colsOpen ? (
            <ColSettingsPop
              hidden={colHidden}
              onToggle={onToggleCol}
              onResetWidths={onResetWidths}
            />
          ) : null}
        </div>
      </div>
      <div className="tb-list-head tb-lgrid" style={gridStyle}>
        {/*
          勾选列的表头占位。
          ⛔ 这一格**不能省**：网格第一列是勾选列，行里也有勾选格，
          表头少这一个就会整体向左挪一格 ——
          "状态"的表头压在"优先级"的内容上。这次的错位就出在这儿。
          顺手放全选，这一格就不只是占位了。
        */}
        <div className="tb-lhcell c-pick">
          <input
            type="checkbox"
            checked={rows.length > 0 && picked.length === rows.length}
            title="全选 / 取消全选（只作用于当前筛选出的行）"
            onChange={(e) => {
              for (const r of rows) onCheck(r.task.id, e.target.checked);
            }}
          />
        </div>
        {shown.map((c, ci) => {
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
                  flow={flow}
                  /*
                    typeIds 必须传：类型候选取的是**定义表**，不是数据去重。
                    不传的话会退回默认六个，用户自定义的类型在下拉里根本选不到 ——
                    那个类型等于建不出来（而它明明已经出现在列表里了）。
                  */
                  options={colFilterValues(
                    c.field, allRows, statusIds, typeIds,
                    tagDefs.map((d) => d.id),
                  )}
                  onChange={(nf) => onFilter(c.field, nf)}
                  onClear={() => onClearFilter(c.field)}
                  anchorRight={ci >= shown.length - 3}
                  tagDefs={tagDefs}
                  onCreateTag={onCreateTag}
                  onTagColor={onTagColor}
                  onRenameTag={onRenameTag}
                  onRemoveTag={onRemoveTag}
                  typeDefs={typeDefs}
                  onCreateType={onCreateType}
                  onTypeColor={onTypeColor}
                  onRemoveType={onRemoveType}
                  onRenameType={onRenameType}
                />
              ) : null}
              {/*
                拖宽把手。放在单元格右边缘，拖它改变这一列的宽度。
                宽度落到 colWidths 里持久化 —— 不然拖完一刷新就回去了。
              */}
              <span
                className="tb-lresize"
                title={`拖动调整「${c.label}」列宽`}
                onMouseDown={(e) => startResize(c.field, e)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          );
        })}
      </div>
      <div className="tb-list-body">
        {rows.length === 0 && <div className="tb-col-empty">没有符合条件的任务</div>}
        {rows.map((row) => {
          const t = row.task;
          return (
          /*
            行内单元格由 shown 驱动，和表头、网格是同一份 ——
            不再各写各的，也就不存在"少渲染一格导致整行错位"。
          */
          <div
            key={t.id}
            className="tb-lrow tb-lgrid"
            style={gridStyle}
            onClick={() => onOpen(t.id)}
            title="点击查看详情"
          >
            <label className="tb-lpick" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={checked.has(t.id)}
                onChange={(e) => onCheck(t.id, e.target.checked)}
              />
            </label>
            {shown.map((c) => cellFor(c.field, t))}
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
  tagDefs,
  onOpen,
  onAction,
  onClaim,
}: {
  flow: FlowLike;
  groups: GroupNode[];
  groupKeys: GroupKey[];
  me: string;
  tagDefs: TagDef[];
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
          tagDefs={tagDefs}
          onOpen={onOpen}
          onAction={onAction}
          onClaim={onClaim}
        />
      ))}
    </div>
  );
}

function GroupNodeView({
  node, flow, groupKeys, me, tagDefs, onOpen, onAction, onClaim,
}: {
  node: GroupNode;
  flow: FlowLike;
  groupKeys: GroupKey[];
  me: string;
  tagDefs: TagDef[];
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
        <span className="tb-group-name">{groupLabel(node.key, by, flow, tagDefs)}</span>
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
              tagDefs={tagDefs}
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
              tagDefs={tagDefs}
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
  stats, flow, typeDefs, tagDefs, onOpen,
}: {
  stats: TbStats;
  flow: { statuses: { id: string; name: string; color: string }[] };
  /** 类型定义表（显示类型名与颜色） */
  typeDefs: TagDef[];
  /** 标签定义表（热门标签面板要显示名字，不能显示 id） */
  tagDefs: TagDef[];
  onOpen: (id: string) => void;
}) {
  /*
    状态分布要显示的行 = 流程配置里的状态 + 数据里出现但配置里没有的。
    后者若漏掉，各状态之和会比总任务数少 —— 差额去哪了完全看不出来。
  */
  const statsByStatus = [
    ...flow.statuses,
    ...Object.keys(stats.byStatus || {})
      .filter((id) => !flow.statuses.some((s) => s.id === id))
      .map((id) => ({ id, name: `${id}（未配置）`, color: '#78716c' })),
  ];

  const typeRows = Object.entries(stats.byType || {}).sort((a, b) => b[1] - a[1]);
  const maxType = Math.max(1, ...typeRows.map(([, n2]) => n2));
  const maxStatus = Math.max(1, ...Object.values(stats.byStatus));
  const maxPrio = Math.max(1, ...Object.values(stats.byPriority));
  const maxWho = Math.max(1, ...stats.byAssignee.map((x) => x.count));
  const cards: { label: string; value: number; hint?: string; warn?: boolean }[] = [
    { label: '总任务', value: stats.total },
    { label: '未完成', value: stats.open },
    /* 提示不能写死状态 id：自定义流程下那句话是假话（见 statsOf 里的判据） */
    { label: '进行中', value: stats.active, hint: '已开工、未完成' },
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
          {/*
            和看板同一条规则：**数据里实际在用的、配置里没有的状态也要显示**。

            ⛔ 只遍历 flow.statuses 的话，处于"未配置状态"的任务
            哪里都不显示 —— 于是总任务数比各状态之和**多**，
            而用户只会以为是统计算错了，想不到是有一批任务被悄悄漏掉了。

            （这也正是看板刚修的那个问题的同一类：
             配置驱动渲染时，"配置里没有"不能等于"不存在"。）
          */}
          {statsByStatus.map((sd) => (
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
              /*
                ⛔ 标签必须走 TagChip：任务上存的是 id（tg_xxxx），
                裸渲染的话面板上是一串没人看得懂的字符，而且没有颜色 ——
                和列表、卡片里同一个标签的样子都不一样。

                这是"id → 显示名"映射散落的**第五处**
                （列表行、筛选面板、筛选摘要、看板卡片都修过了，
                 统计面板这一处一直漏着）。
              */
              <span key={x.tag} className="tb-stat-tagrow">
                <TagChip id={x.tag} defs={tagDefs} />
                <em className="tb-stat-hint">×{x.count}</em>
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
          {/*
            点一条就打开它的详情。

            ⛔ 不要"顺手把筛选设成只显示这一类"：
            统计看的是**全量**（刻意不受顶栏筛选影响），
            而列筛选没有"更新时间早于 7 天前"这个条件（区间是起止日期），
            硬凑的话会把筛选设成一个和面板口径不一致的东西 ——
            于是命中数和这里写的条数对不上，那才是真的说不清。

            打开详情就够了：看完要处理就在详情里改，
            不必在两种"筛选"之间来回对账。
          */}
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
  typeDefs,
  groups,
  onClose,
  onCreate,
}: {
  agents: { id: string }[];
  me: string;
  /** 类型定义表（可在这建完就直接选上） */
  typeDefs: TagDef[];
  /** 已有分组名（供下拉参考；分组是自由文本，也可以直接敲个新的） */
  groups: string[];
  onClose: () => void;
  onCreate: (draft: {
    title: string;
    detail: string;
    /** 任务说明（与详情分开：说明是"要做什么"，详情是复现/期望行为） */
    summary: string;
    priority: string;
    tags: string[];
    assignee: string;
    estimate: string;
    /** 任务类型（typeDefs 里的 id）。'' = 未分类 */
    type: string;
    /** 分组名。'' = 不分组 */
    group: string;
  }) => void;
}) {
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [summary, setSummary] = useState('');
  const [priority, setPriority] = useState<Priority>('P2');
  const [tagsText, setTagsText] = useState('');
  const [assignee, setAssignee] = useState('');
  const [estimate, setEstimate] = useState('');
  const [type, setType] = useState('');
  const [group, setGroup] = useState('');

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
      {/*
        任务说明。⛔ 这个字段后来才加，而新建弹窗一直没有它 ——
        于是从这儿建出来的任务永远没有说明，
        只能建完再进详情补（AI 那侧的通道也是同样情况，已一并补）。
        说明与详情分开：说明是"要做什么"（原始要求），
        详情是复现/期望行为 —— 混成一个字段的话，做完之后
        没人会去清理说明，最后两个都变成过程记录。
      */}
      <label className="tb-mfield">
        <span>任务说明（可选）</span>
        <input
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="要做什么（与详情分开：详情写复现/期望行为）"
        />
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
      {/*
        任务类型与分组。
        ⛔ 这两项是后来加的字段，但**新建弹窗一直没有** ——
        于是从这儿建出来的任务永远没有类型、也没有分组，
        只能建完再去列表行内或详情里补。
        而"新建时顺手选一下"正是用户最自然的时机。

        分组做成可输入的自由文本（不是纯下拉）：
        "建一个新分组"是最常见的操作，只能从已有列表里选的话
        第一次用就没有可选项，等于分组功能在这儿不可用。
      */}
      <div className="tb-mrow">
        <label className="tb-mfield">
          <span>任务类型</span>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">未分类</option>
            {(typeDefs || []).map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </label>
        <label className="tb-mfield">
          <span>分组（可选）</span>
          <input
            value={group}
            onChange={(e) => setGroup(e.target.value)}
            placeholder="留空 = 不分组"
            list="tb-group-options"
          />
          <datalist id="tb-group-options">
            {(groups || []).map((g) => <option key={g} value={g} />)}
          </datalist>
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
              summary,
              priority,
              tags: tagsText.split(/[,，]/).map((s2) => s2.trim()).filter(Boolean),
              assignee,
              estimate,
              type,
              group,
            })
          }
        >
          创建
        </button>
      </div>
    </Modal>
  );
}

/**
 * 详情面板里的自由文本字段：**本地草稿 + 失焦/回车才提交**。
 *
 * ⛔ 原来是受控的 `onChange → onPatch → 写盘` ——
 * 每敲一个字写一次 tasks.json，而每次写盘都是"读-改-写 + 乐观锁"，
 * 打字期间不断和 2s 轮询、AI 通道抢锁，冲突概率陡增。
 *
 * ⛔ 更要命的是中文输入法：受控组件在 composition 期间会拿到拼音中间态，
 * 且没有 isComposing 守卫 —— 打一半的拼音会被当成正式内容写进文件。
 * 备注框那边是有这个守卫的（见下方），这两个输入框恰好漏了。
 *
 * value 变化时以外部为准重置（切换任务 / 别处改了这条）。
 */
function DraftInput({
  value,
  placeholder,
  num,
  onCommit,
}: {
  value: string;
  placeholder?: string;
  /** 数字模式：只认数字（详情里的预估人日） */
  num?: boolean;
  onCommit: (v: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  /* 正在编辑时不接受外部值（否则轮询一刷新就把人打的字冲掉） */
  useEffect(() => {
    if (!editing) setDraft(value);
  }, [value, editing]);
  const commit = () => {
    setEditing(false);
    if (draft === value) return;
    /*
      数字列只认数字。填"三天"直接忽略而不是写成 0 ——
      写成 0 会把"没估"和"估了 0"混成一样，
      而这两个在排期时含义完全不同。
    */
    if (num && draft.trim() !== '' && !/^\d+(\.\d+)?$/.test(draft.trim())) return;
    onCommit(draft);
  };
  return (
    <input
      className="tb-dinput"
      value={draft}
      placeholder={placeholder}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (isComposing(e.nativeEvent)) return;
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        /*
          撤销草稿。⛔ 必须 stopPropagation：
          Modal 也监听 Escape（关闭弹窗），不挡的话这次按键会**同时**
          撤销草稿并关掉整个详情窗口 ——
          而用户按 Escape 的意图只是"撤掉我打的字"。
        */
        if (e.key === 'Escape') {
          e.stopPropagation();
          setDraft(value);
          setEditing(false);
        }
      }}
    />
  );
}

function DetailModal({
  task,
  me,
  tasks,
  /** 完整 store（lockOf 需要它才能拿到 flow，见下方 lock 处） */
  taskStore,
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
}: {
  task: Task;
  me: string;
  /** 全量任务：算前置锁定要用 */
  tasks: Task[];
  /** 完整 store（含 flow）：算前置"是否已完成"要认自定义流程 */
  taskStore: TaskStore;
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
  /** 打开另一条（点前置任务名跳过去） */
  onOpen: (id: string) => void;
    /** 改字段（说明 / 前置） */
  onPatch: (patch: Partial<Task>) => void;
}) {
  const [note, setNote] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  /*
    ⛔ 必须用 actionsForIn(flow, …)，不能用 actionsFor(…)：
    后者是**默认流程**写死的那一套（认领/开始/提交审查…）。
    自定义流程下它算出来的按钮，指向的状态在本项目里可能根本不存在
    → doTransition 走流转校验失败 → **按钮点了没反应**（只弹个错）。

    而且漏掉用户新加的状态：详情里看不到"标为完工"这种按钮，
    于是自定义的状态只能从列表那一列里点，详情这儿像是坏了。
  */
  const acts = actionsForIn(flow, task.status);
  const hist = [...task.history].reverse();

  const { byId } = indexTasks(tasks);
  /*
    传 store：isDone 要认自定义流程的完成态。
    不传的话 lockOf 拿不到 flow → 退回默认判据 →
    自定义流程下**没有一条前置会解锁**（前置做完了也还是锁着）。
  */
  const lock = lockOf(task, tasks, taskStore);
  /*
    可选的前置：排除自己，并**排除会成环的**。

    ⛔ 原来只排除了自己和 parent，注释却写着"排除已成环的" —— 注释和实现不符。
    于是可以把 A 的前置设成 B，而 B 已经（经过若干层）依赖 A：
    两条互相等，**永远解锁不了**。
    lockOf 事后能检出 cyclic 并在界面上说明，但那时已经成环了 ——
    而且用户看到的是两把锁，看不出是自己刚才这一个勾选造成的。

    所以在这里就把那些选项挡掉（传递依赖判定，不是只看直接前置）。
  */
  const depChoices = tasks.filter(
    (t) => t.id !== task.id && !dependsOn(tasks, t.id, task.id),
  );

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
        <DraftInput
          value={task.summary || ''}
          placeholder="一句话说清这条要做什么"
          onCommit={(v) => onPatch({ summary: v })}
        />

        {/*
          分组。**详情面板里也要有**：列表行内那处是"顺手改一下"，
          而详情是"把这条的所有字段看一遍"的地方 ——
          只有列表能改的话，从详情进来会以为这条压根没有分组这个属性。

          ⛔ 不要做成下拉枚举现有分组：分组名是自由文本，
          枚举会随着任务增删不断变化，而且"建一个新分组"正是最常见的操作 ——
          下拉里选不到就只能先去某条任务上填，绕一圈。
        */}
        <span className="tb-dlabel">分组</span>
        <DraftInput
          value={task.group || ''}
          placeholder="分组名（留空 = 不分组）"
          onCommit={(v) => onPatch({ group: v })}
        />

        {/*
          预估工作量。**详情面板里也要能改**：列表行内那处是"顺手改一下"，
          而详情是"把这条的所有字段看一遍再定"的地方 ——
          尤其估人日这种要斟酌的值，更适合在这儿改而不是在窄单元格里点。
          只有列表能改的话，从详情进来会以为这条压根不能估。
        */}
        <span className="tb-dlabel">预估工作量（人日）</span>
        <DraftInput
          value={task.estimate ? String(task.estimate) : ''}
          num
          placeholder="留空 = 没估（可填小数，0.5 = 半天）"
          onCommit={(v) => onPatch({ estimate: v === '' ? 0 : Number(v) })}
        />
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
                {t.title}
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
        {/*
          认领按钮只在**初始态**出现。
          ⛔ 判据不能写死 'todo'：自定义流程的初始态可能叫别的
          （'待办'/'新建'/'s1'…），写死的话自定义流程下
          这个按钮**永远不出现**，而"认领"是详情里最常用的动作 ——
          详情这儿像是少了功能。
        */}
        {task.status === initialStatus(flow) && (
          <button className="tb-act sm" onClick={onClaim}>
            认领（{me}）
          </button>
        )}
        {acts
          .filter((a) => !(task.status === initialStatus(flow) && a.to === (flow.statuses[1] || {}).id))
          .map((a) => (
            <button
              key={a.to}
              className={'tb-act sm' + (statusDone(flow, a.to) ? ' primary' : '') + (a.needNote ? ' warn' : '')}
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

function RejectModal({
  to, label, onClose, onOk,
}: {
  to: string;
  label: string;
  onClose: () => void;
  onOk: (note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    /*
      标题写"标为「X」"而不是写死"打回" ——
      自定义流程里要求填原因的边不一定是打回。
    */
    <Modal title={`标为「${label || to}」`} onClose={onClose}>
      <label className="tb-mfield">
        <span>原因 *</span>
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
  /*
    Escape 关闭。

    ⛔ 但**焦点在输入框里时不关**：详情面板里的自由文本字段
    用 Escape 表示"撤销我打的字"（DraftInput 就是这个语义），
    如果这里同时把整个弹窗关掉，那一次 Escape 会做两件事 ——
    用户想撤掉一个错字，结果整个详情窗口没了，刚才看的内容全得重新找。

    所以输入框里的 Escape 交给输入框自己（它会 stopPropagation），
    焦点不在输入框时才是"关闭弹窗"。
  */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = e.target as HTMLElement | null;
      const tag = (el?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

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
