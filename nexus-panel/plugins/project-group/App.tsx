import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContentPanel } from './components/ContentPanel';
import { Dialogs, type Dialog, type PendingSend } from './components/DialogsHub';
import { CardGrid, TabBar, type DragPayload } from './components/CardGrid';
import { SideRail, type RailMode } from './components/SideRail';
import { StackedGroups } from './components/StackedGroups';
import { ContextMenu, MenuLayerContext, type MenuItem } from './components/ui';
import { normalizeKey, errText } from './api';
import { useFpx } from './hooks/useFpx';
import type { FpxStoreReady } from './hooks/useFpx';
import { useCardHotkeys } from './hooks/useCardHotkeys';
import { useChainActions } from './hooks/useChainActions';
import { useLayoutMemory } from './hooks/useLayoutMemory';
import { IS_MAC, type HotkeyId } from './utils/hotkeys';
import { toolbarHint } from './utils/hint';
import { copyText as copyTextImpl } from './utils/clipboard';
import { clampLogMax } from './utils/log';
import { skipDropToTab } from './utils/tabs';



import { Splitter } from './components/Splitter';
import { useIconThumbs } from './hooks/useIconThumbs';
import type {
  CardInfo, CardKind, ChainAction, ContentItem,
} from './types';



export default function App() {
  const s = useFpx();
  const { ctx, boot } = s;
  const [dialog, setDialog] = useState<Dialog>({ type: 'none' });
  const [iconFiles, setIconFiles] = useState<string[]>([]);
  /** 图标选择器打开代号，见 openIconPicker 的说明：连按 F6 时用它丢弃过期响应 */
  const iconPickerSeq = useRef(0);

  useEffect(() => { ctx.setTitle('项目组分配'); }, [ctx]);
  useEffect(() => { ctx.setBadge(boot?.links.length ?? 0); }, [ctx, boot?.links.length]);

  /**
   * 监听告警只能轮询拉取。
   * 本插件跑在 iframe 沙箱，宿主明确禁用了 listenTauri（见 js/host.js），
   * Rust 侧 app.emit 的事件到不了这里，所以后端把变化堆在队列里，前端定时取。
   */
  const [watchOn, setWatchOn] = useState(false);

  useEffect(() => {
    if (!watchOn) return;
    const secs = Math.max(5, boot?.config.watchIntervalSecs || 30);
    let alive = true;
    const tick = async () => {
      if (!alive) return;
      try {
        const evs = await s.api.watchPoll();
        for (const ev of evs) {
          /* #177 overflow 必须先判并 continue：落进下面的 else 会被显示成
             「受保护目录发生改动：xxx」—— 把"我们漏报了"伪装成"发生了改动"，
             比不显示更糟：用户会据此以为自己看清了全部改动。 */
          if (ev.kind === 'overflow') {
            s.pushLog(`监控事件过多，部分记录已截断（${ev.path} 附近）`, true);
            continue;
          }
          const what = ev.kind === 'added' ? '新增' : ev.kind === 'removed' ? '被删除' : '发生改动';
          s.pushLog(`受保护目录${what}：${ev.path}`, ev.kind === 'removed');
        }
      } catch {
        /* 后端未启动监听时会失败，静默跳过，避免刷屏 */
      }
    };
    void tick();
    const timer = window.setInterval(tick, secs * 1000);
    return () => { alive = false; window.clearInterval(timer); };
    // 依赖里不能放 `s` 整体：useFpx 每次渲染都返回新对象，放进去会让
    // 本 effect 反复重建 —— setInterval 每次都被清掉重来，界面只要持续
    // 重渲染（比如 busy 态切换），轮询就永远等不到触发。
    // 这里只依赖真正稳定的成员：api（useMemo）、pushLog（useCallback）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchOn, boot?.config.watchIntervalSecs, s.api, s.pushLog]);

  // 上次勾选过监听则进插件时自动恢复
  const watchBooted = useRef(false);
  useEffect(() => {
    if (watchBooted.current || !boot?.config.watchEnabled) return;
    watchBooted.current = true;
    s.api.watchStart(boot.config.watchIntervalSecs)
      .then((ok) => {
        setWatchOn(ok);
        /* `ok` 是 bool（线程真起来了吗），不是抛异常。返回 false 时原来
           照样记"已恢复"，与 ToolsPanel 那处同一个 bug：配置写着启用、
           按钮显示"停止监听"，而线程没起来 → 一条告警都没有。
           说清配置仍是"启用"：下次进入还会重试。 */
        if (!ok) {
          s.pushLog('恢复监听失败：线程未能启动（配置仍是"启用"，下次进入会重试）', true);
          return;
        }
        s.pushLog('已按上次设置恢复受保护目录监听');
      })
      .catch((e) => s.pushLog(`恢复监听失败：${String(e)}`, true));
    // 同上：不放 `s` 整体。watchBooted 已保证只跑一次，这里只求引用稳定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot?.config.watchEnabled, boot?.config.watchIntervalSecs, s.api, s.pushLog]);

  const [help, setHelp] = useState(false);

  /**
   * 菜单图层的宿主节点。
   * 必须是 state 而不是 ref：ref 在首次渲染时还是 null，
   * 用 state 才能在挂载完成后触发一次重渲染，把节点交给 ContextMenu。
   * 位置不能往下挪：下面有 `if (s.loading)` / `if (!boot)` 两个提前 return，
   * hook 一旦落在它们之后，首帧（loading）就调不到、次帧调得到，
   * React 会直接抛 "Rendered more hooks than during the previous render"
   * —— 整个组件树崩掉、插件白屏。所有 hook 必须在这两个分支之前。
   */
  const [menuLayer, setMenuLayer] = useState<HTMLDivElement | null>(null);

  /** 日志行右键菜单：复制这一条（原版日志区有复制单项的操作）。 */
  const [logMenu, setLogMenu] = useState<{ text: string; x: number; y: number } | null>(null);

  /** 删页签的确认（页签里还有卡片时先问一次）。 */
  const [confirmRemoveTab, setConfirmRemoveTab] =
    useState<{ kind: CardKind; index: number; message: string } | null>(null);

  /* 键盘焦点栏：卡片快捷键作用在哪一栏。不存 store（只是本次会话落点） */
  const [focus, setFocus] = useState<CardKind>('project');

  /* #58 #225 左栏收起。只动本插件那一栏，不动外壳侧边栏（归主窗口） */
  const [railCollapsed, setRailCollapsed] = useState(false);
  /* #58 左栏模式；只存会话态不进 config */
  const [railMode, setRailMode] = useState<RailMode>('persistent');


  /**
   * 内容区当前选中的条目（受控于本组件）。
   * 提升到这一层是为了给 mod+D（原版 OpenMarkdown）：快捷键注册在 App 层，
   * 而选中项原本是 ContentPanel 的内部 state，拿不到。
   */
  const [contentSel, setContentSel] = useState<ContentItem | null>(null);
  /* 稳定引用**已不是必须**：ContentPanel 内部走 ref 通知，
     调用方传内联箭头函数也不会无限渲染。留着只为少一次子组件更新。 */
  const onContentSelect = useCallback((it: ContentItem | null) => setContentSel(it), []);

  /** F7 一键备份：直接开备份对话框（与工具栏按钮同一个入口） */
  const openBackup = useCallback(() => setDialog({ type: 'backup' }), []);

  /**
   * 日志保留条数（#32）。
   * 显示与"复制全部"都按它截断 —— 所见即所得，复制到的就是看到的那些。
   */
  const logMax = clampLogMax(boot?.config.logMaxLines);

  /* ---------------- 布局记忆（#54 #55 #56 #193）----------------
   * 三栏宽度 / 日志高度 / 浮层高度都收在 `hooks/useLayoutMemory`。
   * 它们原本被别的逻辑隔开（tipsHeight 与三栏相距 70 行），
   * 改一处容易漏看另一处。 */
  const {
    colStars, logHeight, tipsHeight,
    colsRef, saveLayout,
    onColResize, onColResizeEnd, onLogResize, onLogResizeEnd,
  } = useLayoutMemory({ s, config: boot?.config });

  /** 侧边栏/快捷键入口的待确认发送（#43） */
  /* 类型从 Dialogs 引入：抄一份的话漏改的那边"永远 undefined"，不报错最难查 */
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
    /** #19 跳转定位：序号保证连跳同一张卡也能触发 */
  const [reveal, setReveal] = useState<{ path: string; seq: number } | null>(null);
  const revealSeq = useRef(0);

  /* #50 键位从 HOTKEYS 动态取：手抄的话改了键位按钮上还是旧值 */
  const showHints = boot?.config.showShortcuts ?? true;
  /* #50 键位一律走 utils/hint.ts，不在这里内联第二份 —— 此前正是
     内联了一份，hint.ts 整份没人 import，改语义必然只改一边。
     按**动作 id**取（不按按钮文案）：文案改了会静默丢提示。 */
  const hotkeyOverrides = boot?.config.hotkeys ?? null;
  /** 已格式化、可直接显示的键位串；没键位（或被取消绑定）返回空串 */
  const comboHint = useCallback(
    (id: string) => toolbarHint(id, hotkeyOverrides, IS_MAC, showHints),
    [showHints, hotkeyOverrides],
  );


  /**
   * Ctrl/⌘ + M 启停 MCP server（#221 ToggleMcp）。
   * 这里走"先查状态再反向操作"而不是本地记一个布尔：MCP 也可能被
   * `--mcp` 独立进程或上一次会话留着，本地布尔会与实际状态脱节。
   * `mcpStop` 返回的是 **bool**（真的停了吗），不是抛异常 —— 与
   * `watchStop` 同一类。此前这里 `await` 了却不用返回值，于是停止失败时
   * 照样记「已停止」+ 绿色 toast，而端口实际还占着：
   * 用户接着点启动 → 撞端口占用，报错还指不到"其实一直没停"。
   */
  const toggleMcp = useCallback(async () => {
    try {
      const st = await s.api.mcpStatus();
      if (st.running) {
        const stopped = await s.api.mcpStop();
        if (!stopped) {
          const m = 'MCP server 停止失败（端口可能仍在监听）';
          s.pushLog(m, true);
          ctx.toast(m, 'err');
          return;
        }
        s.pushLog('MCP server 已停止');
        ctx.toast('MCP server 已停止', 'ok');
      } else {
        const a = await s.api.mcpStart(0);
        s.pushLog(`MCP server 已启动：${a}/mcp`);
        ctx.toast(`MCP server 已启动：${a}/mcp`, 'ok');
      }
    } catch (e) {
      const m = `MCP 操作失败：${errText(e)}`;
      s.pushLog(m, true);
      ctx.toast(m, 'err');
    }
  }, [ctx, s]);

  /**
   * Ctrl/⌘ + D 编辑内容区选中的文件（#223），走内置 Markdown 编辑器（#33）：
   * 读文本 → 编辑 → 写回，全程不出本工具。
   * **取消的两种形态都要认**：服务约定 resolve(null)，但三个内置服务都
   * reject('已取消')。只认一种会变成 unhandled rejection —— 用户点个取消，
   * 控制台一片红。
   * 内置编辑器没返回结果时**退回外部编辑器**：此时分不清"取消"与"真出错"
   * （同一个 reject 通道），所以不报红，只记日志。
   */
  const openMarkdown = useCallback(async () => {
    if (!contentSel) {
      ctx.toast('请先在内容浏览里选中一个条目', 'err');
      return;
    }
    const fail = (where: string, e: unknown) => {
      const m = `${where}：${errText(e)}`;
      s.pushLog(m, true);
      ctx.toast(m, 'err');
    };
    let text: string;
    try {
      text = await s.api.readText(contentSel.path);
    } catch (e) {
      fail('读取文件失败', e);
      return;
    }
    let edited: string | null = null;
    try {
      edited = await ctx.services.md.edit(text, contentSel.name);
    } catch (e) {
      s.pushLog(`内置编辑器未返回结果（${errText(e)}），改用外部编辑器`);
    }
    /* null/undefined = 取消 → 退回外部编辑器（用户可能就是想用外部的）；
       等于原文 = 没改 → 不写盘也不必再开外部编辑器。 */
    if (edited === text) {
      s.pushLog('内容未变，未写盘');
      return;
    }
    if (edited === null || edited === undefined) {
      s.api.editFile(contentSel.path).catch((e) => fail('打开编辑器失败', e));
      return;
    }
    try {
      await s.api.writeText(contentSel.path, edited);
      s.pushLog(`已保存：${contentSel.path}`);
      ctx.toast('已保存', 'ok');
      s.refresh();
    } catch (e) {
      fail('写回失败', e);
    }
  }, [contentSel, ctx, s]);

  const projectCards = useMemo(
    () => boot?.projectTabs[s.activeTab.project]?.items ?? [],
    [boot, s.activeTab.project],
  );
  /**
   * 项目组栏改成纵向堆叠后，所有分类的卡片同时在界面上，
   * 所以"当前项目组卡片"的概念从「当前页签」变成「全部分类」。
   * 不铺平的话：选中第 2 个分类里的卡片时，focusedCard 会在第 1 个分类里找不到它，
   * 于是左栏操作和快捷键一律报"先选中一个项目组"。
   */
  const groupCards = useMemo(
    () => boot?.groupTabs.flatMap((t) => t.items) ?? [],
    [boot],
  );

  /**
   * 项目组栏改成纵向堆叠后，每个分类都要能取到自己的卡片。
   * 原先只有一个「当前页签」的 groupCards，堆叠布局下要按索引取。
   */
  const groupCardsOf = useCallback(
    (i: number) => boot?.groupTabs[i]?.items ?? [],
    [boot],
  );

  /**
   * 某个项目组卡片属于第几个分类。
   * 堆叠布局下 activeTab.group 不再代表"看得见的那个分类"，
   * 移除卡片时必须知道它究竟登记在哪个分类里，否则点移除毫无反应
   * （更糟的是日志还显示"已移除"）。
   */
  const groupTabIndexOf = useCallback((path: string) => {
    if (!boot) return undefined;
    // 快照里的 items 是 CardInfo（含 exists / 链接状态等后端补齐的字段），
    // 不是配置里的裸路径字符串 —— 要按 .path 比。
    const i = boot.groupTabs.findIndex((t) => t.items.some((c) => c.path === path));
    return i === -1 ? undefined : i;
  }, [boot]);

  // 卡片图标是本地路径，沙箱内需后端转 data URI 才能显示
  const iconPaths = useMemo(
    () => [...projectCards, ...groupCards]
      .map((c) => c.icon)
      .filter((v): v is string => !!v),
    [projectCards, groupCards],
  );
  const iconThumbs = useIconThumbs(s.api, iconPaths);

  const openPath = (p: string, mode: 'auto' | 'dir' | 'containing' | 'editor' = 'auto') =>
    s.api.openPath(p, mode).catch((e) => s.pushLog(String((e as Error)?.message ?? e), true));

  /*
   * 复制文本：三档兜底（后端 → Clipboard API → execCommand）。
   * 整段在 `utils/clipboard.ts`，不在这里 —— App 已顶到结构护栏上限，
   * 且这段与界面无关，放进来只会挤占行数。
   */
  const copyText = useCallback((text: string) =>
    copyTextImpl({ api: s.api, toast: ctx.toast, log: s.pushLog }, text),
  [s.api, s.pushLog, ctx.toast]);

  /* ---------------- 卡片右键菜单 ---------------- */
  const menus = (kind: CardKind) => (card: CardInfo): MenuItem[] => {
    const base: MenuItem[] = [
      { label: '打开文件夹', onClick: () => openPath(card.path, 'dir') },
      {
        // 走后端复制：iframe 沙箱没有 allow-clipboard-write，
        // navigator.clipboard 会静默失败（点了完全没反应）。
        label: '复制完整路径',
        onClick: () => copyText(card.path),
      },
      { label: '改名…（F2）', onClick: () => setDialog({ type: 'rename', card, kind }) },
      /*
       * #419：保护弹窗要显示"项目 / 项目组"徽章，Dialog 的 lock 成员因此
       * 加了必填的 kind。同一组菜单里 rename / chain 都带了 kind，
       * 只有这一处漏了 —— 类型上直接不匹配，编译不过。
       */
      { label: '保护（ACL）…', onClick: () => setDialog({ type: 'lock', card, kind }) },
      { label: '图标与标签…', onClick: () => setDialog({ type: 'style', card }) },
      { label: '发送到 AI…', onClick: () => setDialog({ type: 'chain', target: card.path, kind }) },
    ];
    // 勾选了「加入右键菜单」的动作直接列出来，省一次进面板再选的点击
    for (const a of chainActions) {
      if (!a.showContextMenu) continue;
      base.push({
        label: `${a.icon} ${a.name}`,
        onClick: () => void sendAction(a.id, kind, card.path),
      });
    }
    if (kind === 'project') {
      base.push({
        label: card.hasLink ? '撤销链接' : '（未建链接）',
        disabled: !card.hasLink,
        onClick: () => s.removeLink(card.path),
      });
    }
    base.push({
      label: kind === 'project' ? '转为项目组（换栏）' : '转为项目（换栏）',
      // 落到目标栏当前正在看的页签，而不是默认第一个
      onClick: () => void s.moveCardAcross(
        kind, card.path, kind === 'project' ? s.activeTab.group : s.activeTab.project,
      ),
    });
    base.push({
      label: '从页签移除',
      danger: true,
      onClick: () => setDialog({ type: 'remove', card, kind }),
    });
    return base;
  };

  /** 「快速链接」关闭时，跨栏拖放先弹确认：待建链的项目 / 项目组 */
  const [confirmLink, setConfirmLink] = useState<{ project: string; group: string } | null>(null);

  /**
   * 活动页签的**实时镜像**（#708）。
   * 拖拽过程中若发生自动切页签（悬停切页签），`onMove` 里闭包捕获的
   * `s.activeTab.project` 可能是**切换前的旧值**——用户眼前看到的是新页签的卡片，
   * 落点却算到旧页签去，卡片被移到完全不是他瞄准的那个页签里。
   * 这类"移动成功但位置不对"比报错更难发现，因为它不会失败、只是东西不见了。
   * ref 每次渲染同步，读取时永远是当前值。所有**在拖拽回调里读页签索引**的地方
   * 都必须走这个 ref，不能直接用 state。
   */
  const activeTabRef = useRef(s.activeTab);
  activeTabRef.current = s.activeTab;

  /** 连锁动作清单：右键菜单按需渲染，工具栏「发送到 AI」也用同一份 */
  const [chainActions, setChainActions] = useState<ChainAction[]>([]);
  /**
   * 拉取动作的代次号。
   * 依赖不能放 `boot` 本身：applySnapshot 每次都造一个新 boot 对象，
   * 于是加一张卡片、拖一次排序都会重新拉一次动作清单；而后端返回的永远是
   * 一个新数组，引用一变就触发下面那个注册副作用——侧边栏被整体拆掉重建、
   * 快捷键反复注销再注册（那正是这段注释本来想避免的闪烁与丢焦点）。
   * 改成「首次加载 + 显式代次号」驱动：只在真的可能变了的时候才拉。
   */
  const [chainVersion, setChainVersion] = useState(0);
  const refreshChainActions = useCallback(() => {
    setChainVersion((v) => v + 1);
  }, []);

  /**
   * 点项目卡片上的「→ 项目组名」跳过去选中它（对照 WPF 的 SelectLinkedGroupCommand）。
   *
   * CardInfo 里只有组**名**（linkedGroup），定位却要**路径**。
   * 首选链接记录（最可靠）；记录缺失时退回卡片明细里那条 `group` ——
   * 那是后端扫磁盘上的真实链接反查出来的（#181 #215）。
   *
   * 为什么必须补这条退回：磁盘兜底让卡片**显示**出了组名，
   * 若跳转仍只认账本，就会出现"名字看得见、点了却报错"——
   * 比干脆不显示更让人困惑。
   *
   * 两处都没有才明说，而不是静默不动：那意味着链接确实断了或指向已不存在的目录。
   */
  const jumpToGroup = useCallback((card: CardInfo) => {
    const ci = boot?.platform === 'windows';
    const key = normalizeKey(card.path, ci);
    const row = boot?.links.find((l) => normalizeKey(l.project, ci) === key);
    const group = row?.group
      || card.linkDetails?.find((d) => d.state === 'valid' && d.group)?.group
      || '';
    if (!group) {
      ctx.toast(`找不到「${card.linkedGroup}」的路径：链接记录里没有这一条`, 'err');
      return;
    }
    setFocus('group');
    s.setSelGroup(group);
    /* 光选中不够：项目组栏是所有分类纵向堆叠，目标常在折叠的分类里或屏幕外，
       高亮了也看不见，用户会以为"跳转没反应"。交给 StackedGroups 展开 + 滚动（#19）。
       带一个自增序号：连着跳**同一张**卡时，若只存路径，值没变 → useEffect 不重跑
       → 第二次跳转不滚动。这是"看似多余的字段"，缺了就是一个难查的偶发 bug。 */
    setReveal({ path: group, seq: ++revealSeq.current });
  }, [boot, ctx, s, setFocus]);

  /**
   * 设置页改完配置后要刷新主视图。
   *
   * 设置面板跑在另一个 iframe（view='settings'），与主视图不共享内存：
   * 它改的是同一份磁盘配置，但主视图内存里的 boot 还是旧的，
   * 不刷新就会出现"设置里改了、这边没反应"。
   * 连锁动作清单也要重拉——设置页里能增删改动作。
   */
  useEffect(() => ctx.on('project-group:config-changed', () => {
    refreshChainActions();
    void s.refresh();
  }), [ctx, refreshChainActions, s.refresh]);

  const bootReady = !!boot;
  useEffect(() => {
    if (!bootReady) return;
    let cancelled = false;
    s.api.chainActions()
      .then((l) => { if (!cancelled) setChainActions(l); })
      /* 拉取失败必须说出来：此前 catch 里只 setChainActions([])，
         把界面清空成"没有任何动作"（侧栏空、快捷键没反应、右键菜单空），
         全程无提示 —— 用户会以为自己没配过，甚至去重建、覆盖正常数据。
         清空仍要做（否则停在旧清单上），但要说明"是没拉到"而非"没有"。 */
      .catch((e: unknown) => {
        if (cancelled) return;
        setChainActions([]);
        s.pushLog(`读取连锁动作失败：${errText(e)}（界面已显示为"无动作"，配置本身未改动）`, true);
      });
    return () => { cancelled = true; };
  }, [bootReady, s.api, chainVersion]);

  /* ---------------- 连锁动作：快捷键 + 侧边栏 ----------------
   * 接线（注册 + 事件订阅 + 三个发送入口）收在 `hooks/useChainActions`。
   * 它与卡片、布局、日志都无关，只是"把动作清单接到外壳上"这一件事。 */
  const { runActionOnSelection, sendAction, requestSendAction } = useChainActions({
    ctx, s, chainActions, bootReady, setPendingSend,
  });

  /*
   * #14 拖进来的东西不是文件夹时，说清楚**为什么**没接上。
   *
   * 三种情形要分开说，混成一句会让用户不知道自己错在哪：
   *   · 拖了单个文件  → 要的是文件夹，他要加的是这一个文件
   *   · 拖了一段文字  → 根本不是文件系统的东西（比如从网页上选的词）
   *
   * 都不弹选目录框：拖文字弹框是纯粹的误导。但也不能静默 ——
   * "拖了、松手了、毫无变化"正是 #14 要修的原痛点，
   * 静默等于把这个功能又退回去。
   */
  /*
   * #14 拖入文件夹 → 直接导入到这一栏。
   *
   * 拿到绝对路径就落库，不再弹对话框：那次重选是浏览器沙箱不给路径时
   * 被迫加的，不是本意。拿不到路径才退回对话框 —— 否则"拖了、松手了、
   * 毫无变化"这个原痛点又会回来。
   *
   * 按 kind 生成而不是两处各写一个：两处逻辑必须一致，
   * 写两遍就会出现"项目栏直接导入、项目组栏却弹框"这类不一致。
   */
  const externalDrop = (kind: CardKind) => (
    target: string, direct: boolean, tabIndex?: number,
  ) => {
    if (direct) {
      /*
       * 成功**不额外 toast**：addCard 内部已经 pushLog、自动选中，
       * 且重复时会自己提示"该文件夹已在当前页签中"。
       * 这里再加一句"已添加"就会出现"已添加"与"已存在"同时弹出的矛盾，
       * 反而让人不知道到底成没成。与「＋ 添加」那条路保持一致即可。
       */
      void s.addCard(kind, target, tabIndex)
        .catch((e: unknown) => ctx.toast(`添加失败：${String(e)}`, 'err'));
      return;
    }
    setDialog({ type: 'pickDir', kind, tabIndex, droppedName: target });
  };

  const externalNotice = (kind: 'file' | 'empty', _name: string) => {
    /*
     * 一句话，不解释原理。
     *
     * 用户此刻只想知道"我该怎么做"，不是浏览器为什么不给路径。
     * 拖的是文件还是文字，对他来说下一步都一样：换个文件夹拖进来。
     */
    ctx.toast('请拖入文件夹即可', 'err');
  };

  const onCrossDrop = (drag: DragPayload, target: CardInfo | null) => {
    // 跨栏拖到卡片区**空白** = 换栏移动（项目 ⇄ 项目组），不是错误。
    //
    // 对应原版 ResolveLinkDrop 的语义：命中具体卡片 → 建链；没命中 → 跨列移动。
    // 此前这里一律 toast 拒绝，等于把这条通路堵死了。
    // 落点栏是当前显示的那一个（项目栏 activeTab.project / 项目组栏 activeTab.group），
    // 与"拖过去时看到的界面"一致，不会莫名其妙跑到别的分类里。
    if (!target) {
      const dst: CardKind = drag.kind === 'project' ? 'group' : 'project';
      void s.moveCardAcross(drag.kind, drag.path, activeTabRef.current[dst] ?? 0);
      return;
    }
    // 拖放方向决定谁是项目、谁是项目组
    const project = drag.kind === 'project' ? drag.path : target.path;
    const group = drag.kind === 'project' ? target.path : drag.path;

    // 快速链接开着就直接建；关着则先确认——跨栏拖放比点点按钮更容易误触，
    // 误建链接会在项目目录里凭空多出若干 junction。
    if (boot?.config.quickLink) {
      void s.createLink(project, group);
      return;
    }
    setConfirmLink({ project, group });
  };

  /**
   * 删页签前的两道闸（原版 DeleteTabCommand 的语义）：
   * 含受保护项直接拒绝；含其它卡片先确认——页签看着只是个"分类"，
   * 很多人不会意识到删它会把里面登记的东西一起清掉。
   */
  const requestRemoveTab = (kind: CardKind, index: number) => {
    const chk = s.tabRemoveCheck(kind, index);
    if (chk.blocked) {
      ctx.toast(chk.blocked, 'err');
      return;
    }
    if (chk.confirm) {
      setConfirmRemoveTab({ kind, index, message: chk.confirm });
      return;
    }
    void s.removeTab(kind, index);
  };

  const openIconPicker = async (card: CardInfo) => {
    /* 本次打开的代号，回来时对不上就丢弃。
       没有它的场景：在 A 上按 F6（读盘慢），没等弹窗出来又切到 B 按 F6（快）→
       弹窗先按 B 打开、随后被 A 那次改成 A。
       后果不是"显示错"，而是**改错东西**：弹窗写着 A，用户挑的图标被设到 A 上，
       而他要改的是 B —— 没有任何报错，往往很久以后才发现 A 的图标不对。 */
    const seq = ++iconPickerSeq.current;
    try {
      const files = await s.api.listIcons();
      if (iconPickerSeq.current !== seq) return;
      setIconFiles(files);
      setDialog({ type: 'icons', card });
    } catch (e) {
      if (iconPickerSeq.current !== seq) return;
      /* 只记日志的话 F6 按下去界面毫无变化，用户只会以为按钮坏了。
         这是打开弹窗的唯一入口，失败必须让他看见。 */
      const m = `读取图标目录失败：${errText(e)}`;
      s.pushLog(m, true);
      ctx.toast(m, 'err');
    }
  };

  /* ---------------- 键盘操作 ----------------
   * 键位见 hooks/useCardHotkeys.ts。作用对象是「焦点栏里当前选中的卡片」，
   * 没选中就提示——静默失败比报错更让人困惑。
   */
  const focusedCard: CardInfo | null = useMemo(() => {
    const p = focus === 'project' ? s.selProject : s.selGroup;
    if (!p) return null;
    return (focus === 'project' ? projectCards : groupCards).find((c) => c.path === p) ?? null;
  }, [focus, s.selProject, s.selGroup, projectCards, groupCards]);

  const needCard = (fn: (c: CardInfo) => void) => () => {
    const c = focusedCard;
    if (!c) {
      ctx.toast(`先选中一个${focus === 'project' ? '项目' : '项目组'}`, 'err');
      return;
    }
    fn(c);
  };

  /** 搬家：选好目标父目录后调用后端，物理移动 + 同步所有登记 */
  const doMove = useCallback(async (card: CardInfo, kind: CardKind, dest: string) => {
    const r = await s.run('搬家', () => s.api.moveFolder(kind, card.path, dest));
    if (!r) return;
    s.applySnapshot(r.snapshot);
    if (kind === 'project') s.setSelProject(r.newPath);
    else s.setSelGroup(r.newPath);
    s.pushLog(`已搬家：${card.path} → ${r.newPath}（同步 ${r.tabHits} 条登记）`);
    // 项目组搬家会重建指向它的 junction；失败的必须说出来，
    // 否则用户以为链接还在，实际全断了却毫不知情。
    if (r.relinked) s.pushLog(`已重建 ${r.relinked} 条链接`);
    for (const e of r.relinkErrors ?? []) s.pushLog(`链接重建失败：${e}`, true);
  }, [s]);

  /* 内容区条目改名：改完重扫一遍目录。
     必须把成败返回调用方：此前是 void + 内部静默 return，弹窗那侧只能
     无条件 return true —— 失败时弹窗照常关闭（像成功了），名字其实没变，
     而弹窗里那句「改名未成功」从此成了死代码。 */
  const doRenameContent = useCallback(async (path: string, name: string): Promise<boolean> => {
    const r = await s.run('改名', () => s.api.renameContentItem(path, name));
    if (!r) return false;
    s.pushLog(`已改名为「${name}」`);
    await s.scan(s.focusDir);
    return true;
  }, [s]);

  /**
   * 上下键在**当前栏**的卡片间移动选中（对齐原版 `NavigateAdjacent`）。
   *
   * 此前完全没有：换栏（Ctrl/⌘+←/→）只能落到目标栏的第一张，
   * 到不了中间的卡 —— 键盘用户只能靠鼠标点，否则选不中第 3 张之后的卡。
   *
   * 三个必须做对的点：
   *   1. **越界不动**（不循环）：最后一张再按 ↓ 若绕回第一张，
   *      用户按过头时会以为选中跳到了别处，且看不出那是"绕回来了"。
   *   2. 没选中任何卡片时，↑/↓ 都落到**第一张**（原版 idx<0→0），
   *      而不是什么都不做 —— 否则第一次按键永远没反应。
   *   3. **选完要滚动到可视区**：选中的卡在滚动区外时，界面上
   *      没有任何变化，用户以为按键没生效（原版 BringIntoView 正是为此）。
   */
  const navigate = (delta: number) => {
    const list = focus === 'project' ? projectCards : groupCards;
    if (list.length === 0) return;
    const cur = focus === 'project' ? s.selProject : s.selGroup;
    const idx = cur ? list.findIndex((c) => c.path === cur) : -1;
    const next = idx < 0 ? 0 : idx + delta;
    if (next < 0 || next >= list.length) return;
    const target = list[next];
    if (focus === 'project') s.setSelProject(target.path);
    else s.setSelGroup(target.path);
    /*
     * 必须等渲染完：选中是 state 变更，同一帧里 DOM 还没更新，
     * 立刻查会拿到旧的那张（甚至 null），滚动静默失效。
     * `block: 'nearest'` —— 已经可见时不要动，避免无谓地整页跳动。
     */
    requestAnimationFrame(() => {
      const key = window.CSS && CSS.escape ? CSS.escape(target.path) : target.path;
      const el = document.querySelector<HTMLElement>(`[data-card-path="${key}"]`);
      el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  };

  /**
   * 页签前后翻页，到头回环。索引先 clamp：activeTab 与当前快照可能不同步。
   * 项目组栏改成纵向堆叠后所有分类同时在屏幕上，再切「当前页签」没有可见
   * 效果 —— 所以改成把选中项移到下一个分类的第一张卡片：既保留了"在分类间
   * 前后跳"的语义，又真的看得见（还会把焦点带过去）。
   */
  const cycleTab = (kind: CardKind, delta: number) => {
    const n = (kind === 'project' ? boot?.projectTabs.length : boot?.groupTabs.length) ?? 0;
    if (n <= 1) return;
    const cur = Math.min(Math.max(0, s.activeTab[kind]), n - 1);
    const next = ((cur + delta) % n + n) % n;
    s.setActiveTab((prev) => ({ ...prev, [kind]: next }));
    if (kind !== 'group') return;
    const first = boot?.groupTabs[next]?.items[0]?.path;
    if (first) { setFocus('group'); s.setSelGroup(first); }
  };

  /* ---------------- 左栏操作 ----------------
   * 分组与顺序沿用 WPF 原版侧边栏：全局 → 选中项 → 连锁动作 → 危险操作置底。
   * 每项都要求先选中卡片（needCard 会提示），与原版一致。
   */
  const railGroups = useMemo(() => [
    {
      key: 'global',
      actions: [
        {
          icon: '⟳', label: '刷新',
          hotkeyId: 'refresh' as HotkeyId,
          title: '刷新全部（F5）',
          onClick: () => { refreshChainActions(); s.refresh(); },
        },
        {
          icon: '🗄', label: '备份',
          title: '一键备份：把项目 / 项目组增量同步到备份目录',
          onClick: () => setDialog({ type: 'backup' }),
        },
        {
          icon: '🧹', label: '清无效',
          hotkeyId: 'clearInvalid' as HotkeyId,
          title: '清除无效项（F8）：摘掉页签里已不存在的路径',
          onClick: () => void s.clearInvalid(),
        },
      ],
    },
    {
      key: 'selected',
      actions: [
        {
          icon: '📂', label: '打开',
          hotkeyId: 'open' as HotkeyId,
          title: '打开选中文件夹（Ctrl/⌘+O）',
          onClick: needCard((c) => openPath(c.path, 'dir')),
        },
        {
          icon: '🔒', label: '保护',
          hotkeyId: 'lock' as HotkeyId,
          title: 'ACL 保护（Ctrl/⌘+L）',
          /* 同组快捷键里 rename / move / remove 都传 kind: focus
             （focus 是当前焦点栏），这里同样漏了 */
          onClick: needCard((c) => setDialog({ type: 'lock', card: c, kind: focus })),
        },
        {
          icon: '✎', label: '改名',
          hotkeyId: 'rename' as HotkeyId,
          title: '改名（F2）',
          onClick: needCard((c) => setDialog({ type: 'rename', card: c, kind: focus })),
        },
        {
          icon: '🚚', label: '搬家',
          title: '把选中的文件夹移到别的目录',
          onClick: needCard((c) => setDialog({ type: 'move', card: c, kind: focus })),
        },
        {
          icon: '🎨', label: '改色',
          hotkeyId: 'color' as HotkeyId,
          title: '图标与标签色（F4）',
          onClick: needCard((c) => setDialog({ type: 'style', card: c })),
        },
        {
          icon: '🖼', label: '改图标',
          hotkeyId: 'icon' as HotkeyId,
          title: '改图标（F6）',
          onClick: needCard((c) => void openIconPicker(c)),
        },
      ],
    },
    {
      key: 'danger',
      actions: [
        {
          icon: '🗑', label: '移除',
          hotkeyId: 'remove' as HotkeyId,
          title: '从当前分类 / 页签移除（Delete）',
          danger: true,
          onClick: needCard((c) => setDialog({ type: 'remove', card: c, kind: focus })),
        },
      ],
    },
  ], [focus, groupTabIndexOf, needCard, openIconPicker, openPath, refreshChainActions, s]);

  useCardHotkeys(ctx, {
    open: needCard((c) => openPath(c.path, 'dir')),
    /* 同上：#419 之后 lock 必须带 kind，紧邻的 rename 就带了 focus */
    /* 同上：#419 之后 lock 必须带 kind，紧邻的 rename 就带了 focus */
    lock: needCard((c) => setDialog({ type: 'lock', card: c, kind: focus })),
    rename: needCard((c) => setDialog({ type: 'rename', card: c, kind: focus })),
    move: needCard((c) => void s.moveCardAcross(
      focus, c.path, focus === 'project' ? s.activeTab.group : s.activeTab.project,
    )),
    color: needCard((c) => setDialog({ type: 'style', card: c })),
    icon: needCard((c) => void openIconPicker(c)),
    remove: needCard((c) => setDialog({ type: 'remove', card: c, kind: focus })),
    refresh: () => { refreshChainActions(); s.refresh(); },
    clearInvalid: () => void s.clearInvalid(),
    cycleTab,
    navigate,
    focus: setFocus,
    // 补齐的 5 条（原版 ShortcutCatalog）
    toggleTips: () => setHelp((v) => !v),
    backupNow: openBackup,
    toggleMcp: () => void toggleMcp(),
    toggleSidebar: () => setRailCollapsed((v) => !v),
    openMarkdown,
    // 有弹窗打开时整组让路：否则在对话框里按 Delete 会改到看不见的卡片
    // （开关类的三条不受此限，见 useCardHotkeys 的 ALWAYS_ON）
  }, !!boot && dialog.type === 'none' && !help && !confirmLink, boot?.config.hotkeys);

  if (s.loading) {
    return <div className="p-card"><div className="p-muted">正在加载项目组数据…</div></div>;
  }
  if (!boot) {
    return (
      <div className="p-card">
        <h2>加载失败</h2>
        <div className="p-muted">后端命令不可用。请确认在 Nexus Panel（Tauri 环境）中运行，且已重新编译 Rust 端。</div>
        <button className="p-btn sm primary" style={{ marginTop: 'var(--sp-6, 12px)' }} onClick={() => s.refresh()}>重试</button>
      </div>
    );
  }

  /*
   * 过了 `if (!boot)` 这一关，boot 就必然非 null。这里**一次性**收窄成
   * FpxStoreReady 再往下传，而不是在弹窗内部写 19 处 `boot!`：
   * 收窄点只有这一处，将来谁动了上面的提前 return，编译器会在**这里**
   * 报错；而 `boot!` 会把同一个判断复制 19 份，改坏时 19 处一起沉默。
   * （这是普通常量不是 hook，放在提前 return 之后是安全的 —— 那句
   *   "hook 不能落在提前 return 之后"的约束只针对 hook。）
   */
  const sReady: FpxStoreReady = { ...s, boot };

  return (
    <MenuLayerContext.Provider value={menuLayer}>
    <div className="fpx-root">
      {/* ---------------- 工具栏 ---------------- */}
      <div className="p-card">
        <div className="p-row" style={{ justifyContent: 'space-between' }}>
          <div className="p-row">
            <button className="p-btn sm primary" onClick={() => setDialog({ type: 'create', kind: 'project' })}>＋ 新建项目</button>
            <button className="p-btn sm primary" onClick={() => setDialog({ type: 'create', kind: 'group' })}>＋ 新建项目组</button>
            <button
              className="p-btn sm"
              disabled={!s.selProject && !s.selGroup}
              title={s.selProject || s.selGroup ? '把指令发给 AI 客户端' : '先选中一个项目或项目组'}
              onClick={() => setDialog({
                type: 'chain',
                target: s.selProject ?? s.selGroup ?? '',
                kind: s.selProject ? 'project' : 'group',
              })}
            >
              发送到 AI
            </button>
            <button className="p-btn sm" onClick={() => setDialog({ type: 'backup' })}>
              备份{comboHint('backupNow') && <span className="fpx-key">{comboHint('backupNow')}</span>}
            </button>
            <button
              className="p-btn sm"
              title="基础设置 / 链接名 / 服务已移到外壳右上角的「⚙ 设置」"
              onClick={() => s.pushLog('设置入口在外壳右上角的「⚙ 设置」（重载按钮左侧）')}
            >
              设置在哪？
            </button>
            <button
              className="p-btn sm"
              title="F5"
              onClick={() => {
                // 刷新要连动作清单一起拉：外部（MCP / 旧版本配置迁移）也可能改过它
                refreshChainActions();
                s.refresh();
              }}
            >
              刷新{comboHint('refresh') && <span className="fpx-key">{comboHint('refresh')}</span>}
            </button>
            <button
              className="p-btn sm"
              title="摘掉页签里已不存在的路径（F8）"
              onClick={() => void s.clearInvalid()}
            >
              清除无效项{comboHint('clearInvalid') && <span className="fpx-key">{comboHint('clearInvalid')}</span>}
            </button>
            <button className="p-btn sm" onClick={() => setHelp(true)}>
              使用说明{comboHint('toggleTips') && <span className="fpx-key">{comboHint('toggleTips')}</span>}
            </button>
            {/* 页签管理（#23）：两栏页签集中一处增删改序。
                页签条上的 ⋮ 菜单仍在（就地改更顺手），这里给的是"整理"入口 */}
            <button
              className="p-btn sm"
              title="统一管理项目 / 项目组页签：改名、排序、删除"
              onClick={() => setDialog({ type: 'tabManager' })}
            >
              页签管理
            </button>
          </div>
          <div className="p-row">
            <span className="p-mono p-muted" title={boot.dataDir}>数据：{boot.dataDir}</span>
            <button className="p-btn sm" onClick={() => s.api.openDataDir().catch((e) => s.pushLog(String(e), true))}>
              打开数据目录
            </button>
          </div>
        </div>
      </div>

      {/* ---------------- 左侧操作栏 + 三栏 + 日志 ----------------
        对照 WPF 原版：SidebarControl 纵跨整个内容区（含日志行），
        主区则是「三栏行 + 日志行」两行。 */}
      <div className="fpx-body">
        <SideRail
          groups={railGroups}
          chainActions={chainActions.filter((a) => a.showSidebar)}
          onChainAction={runActionOnSelection}
          hotkeys={boot.config.hotkeys}
          collapsed={railCollapsed}
          onToggleCollapsed={() => setRailCollapsed((v) => !v)}
          mode={railMode}
          onModeChange={() => setRailMode((v) => (v === 'hover' ? 'persistent' : 'hover'))}
        />

        <div className="fpx-main">
          {/* 三栏宽度可调（#54）：grid 改 flex —— 分隔条要夹在栏与栏之间，
              用 grid 的话它会去占一个单元格，把布局挤歪。
              star 值走 flexGrow，与 grid 的 fr 效果一致。 */}
          <div className="fpx-cols" ref={colsRef}>
            <div className="fpx-colwrap" style={{ flexGrow: colStars[0] ?? 1 }}>
            <Column
              title="项目"
              kind="project"
              onEditLink={(p, g) => setConfirmLink({ project: p, group: g })}
              onExternalDrop={externalDrop('project')}
              onExternalNotice={externalNotice}
              tabs={boot.projectTabs}
              cards={projectCards}
              selected={s.selProject}
              onSelect={(p) => { setFocus('project'); s.setSelProject(p); }}
              onOpen={(p) => openPath(p, 'dir')}
              /* fromTab 显式传：拖的是当前这一页里的卡，源就是当前页签。
                 不传的话 moveCard 会退回"找第一个含它的页签"，
                 同路径登记在多个页签时会摘错一个。 */
              onMove={(path, i) => s.moveCard('project', path, activeTabRef.current.project, i,
                activeTabRef.current.project)}
              onMoveToTab={(path, tabIndex) => {
                /* #103 拖回自己所在的页签 = 取消，不做任何事。
                   不守卫的话会被 moveCard 移到该页签末尾 ——
                   用户以为取消了，实际改了顺序，且没有任何提示。 */
                if (skipDropToTab(boot.projectTabs, tabIndex, path)) return;
                const n = boot.projectTabs[tabIndex]?.items.length ?? 0;
                s.moveCard('project', path, tabIndex, n, activeTabRef.current.project);
              }}
              onCrossDrop={onCrossDrop}
              thumbs={iconThumbs}
              menus={menus('project')}
              onAdd={() => setDialog({ type: 'pickDir', kind: 'project' })}
          onAddTab={() => s.addTab('project', `页签${(boot.projectTabs.length) + 1}`)}
              onRenameTab={(i, n) => s.renameTab('project', i, n)}
              onRemoveTab={(i) => requestRemoveTab('project', i)}
              onMoveTab={(from, to) => void s.moveTab('project', from, to)}
              active={s.activeTab.project}
              /*
               * 切页签要清掉这一栏的选中（对齐原版 SwitchProjectTab）。
               *
               * 不清的后果：选中的卡不在新页签里，界面上**看不见它**，
               * 但左栏操作（改名 / 改色 / 打开）与快捷键仍作用于它 ——
               * 用户以为"没选中任何东西"，按 F2 却改了另一页签里的卡。
               * 这是"改了不该改的东西"里最典型的一种，且没有任何提示。
               *
               * 只清 project 这一栏：项目组栏所有分类同时在界面上，不存在
               * "选中的卡不在视野里"，清它只会平白丢掉另一栏的选择。
               */
              onTab={(i) => {
                s.setActiveTab((prev) => ({ ...prev, project: i }));
                s.setSelProject(null);
              }}
              focused={focus === 'project'}
              onJumpToGroup={jumpToGroup}
            />
            </div>

            <Splitter
              dir="horizontal"
              ariaLabel="调整「项目」与「项目组」两栏的宽度比例"
              onDelta={onColResize(0)}
              onEnd={onColResizeEnd}
            />

            <div className="fpx-colwrap" style={{ flexGrow: colStars[1] ?? 1 }}>
            {/*
              项目组栏：所有分类纵向堆叠、各自可折叠（对照 WPF 原版 groupBoxes 与截图形态）。
              项目栏仍用页签切换 —— 原版就是这样：项目组是分区框，项目是横向页签条。
            */}
        <div className={`p-card fpx-col${focus === 'group' ? ' focus' : ''}`}>
              <div className="p-row fpx-col-head">
                <h2 style={{ margin: 0 }}>
                  项目组
                  <span className="p-muted" style={{ fontWeight: 400 }}>
                    （{boot.groupTabs.reduce((n, t) => n + t.items.length, 0)}）
                  </span>
                  {focus === 'group' && (
                    <span className="fpx-badge dim fpx-focus-tag" title="键盘快捷键作用于此栏（Ctrl/⌘+←/→ 切换）">
                      ⌨
                    </span>
                  )}
                </h2>
                <div className="p-row fpx-col-head-ops">
                  <button
                    className="p-btn sm"
                    title="新增分类"
                onClick={() => s.addTab('group', `页签${(boot.groupTabs.length) + 1}`)}
                  >
                    ＋ 分类
                  </button>
                </div>
              </div>

              <StackedGroups
                tabs={boot.groupTabs}
                cardsOf={(i) => groupCardsOf(i)}
                selected={s.selGroup}
                thumbs={iconThumbs}
                onSelect={(p) => { setFocus('group'); s.setSelGroup(p); }}
                onOpen={(p) => openPath(p, 'dir')}
                /* 项目组是纵向堆叠：卡片就在 tabIndex 这个分类框里，
                   源与目标都是它。 */
                onMove={(tabIndex, path, index) => s.moveCard('group', path, tabIndex, index, tabIndex)}
                onCrossDrop={onCrossDrop}
                menus={menus('group')}
                onRename={(i, n) => s.renameTab('group', i, n)}
                onRemove={(i) => requestRemoveTab('group', i)}
                onAdd={(i) => setDialog({ type: 'pickDir', kind: 'group', tabIndex: i })}
                onMoveTab={(from, to) => void s.moveTab('group', from, to)}
                onExternalDrop={externalDrop('group')}
                onExternalNotice={externalNotice}
                reveal={reveal}
                emptyHint="还没有项目组，点分类右侧的 ＋ 添加"
              />
            </div>
            </div>

            <Splitter
              dir="horizontal"
              ariaLabel="调整「项目组」与「内容浏览」两栏的宽度比例"
              onDelta={onColResize(1)}
              onEnd={onColResizeEnd}
            />

            <div className="fpx-colwrap" style={{ flexGrow: colStars[2] ?? 1.4 }}>
            <div className="p-card fpx-col fpx-col-content">
              {/*
                与左右两栏用同一套头部结构（.fpx-col-head）：
                原先这里是个裸 <h2>，带着浏览器默认的 margin-top，
                标题比另两栏低一截；外壳的 .p-card h2 只重置了 margin-bottom，没管 margin-top。
              */}
              <div className="p-row fpx-col-head">
                <h2 style={{ margin: 0 }}>内容浏览</h2>
              </div>
              <ContentPanel
                api={s.api}
                root={s.focusDir}
                items={s.content}
                kind={s.contentKind}
                onKind={s.setContentKind}
                onLog={s.pushLog}
                onRename={(it) => setDialog({ type: 'renameContent', path: it.path, name: it.name })}
                onRenameSegment={(req) => setDialog({ type: 'renameSegment', ...req })}
                onRefresh={() => void s.scan(s.focusDir)}
                selected={contentSel}
                onSelect={onContentSelect}
              />
            </div>
            </div>
          </div>

          {/* 日志区高度可调（#55）：拖这条分隔条改高度，松手才写配置 */}
          <Splitter
            dir="vertical"
            ariaLabel="调整日志区高度"
            onDelta={onLogResize}
            onEnd={onLogResizeEnd}
          />

          {/* ---------------- 日志（对照 WPF 底部的 140px 日志行）---------------- */}
          <div className="p-card fpx-logcard">
            <div className="p-row fpx-col-head">
              <h2>
                日志
                {/* 显示"当前/上限"：条数满了之后新日志会挤掉最旧的，
                    不给这个数的话，用户只会觉得"日志怎么自己变短了" */}
                <span className="p-muted" style={{ fontWeight: 400, fontSize: 'var(--fs-11, 11px)', marginLeft: 6 }}>
                  {s.log.length}/{logMax}
                </span>
              </h2>
              <div className="p-row fpx-col-head-ops">
                <button
                  className="p-btn sm"
                  title="复制全部日志（含时间戳）"
                  disabled={s.log.length === 0}
                  onClick={() => copyText(
                    s.log.slice(0, logMax).map((l) => `[${l.at}] ${l.text}`).join('\n'))}
                >
                  复制全部
                </button>
                <button
                  className="p-btn sm"
                  title="清空日志（只清界面上的流水，不影响任何登记）"
                  disabled={s.log.length === 0}
                  onClick={s.clearLog}
                >
                  清空
                </button>
              </div>
            </div>
            {/* 高度来自布局记忆（#55）。原先 CSS 里写死 132px，这里覆盖它 */}
            <div className="fpx-log" style={{ height: logHeight }}>
              {s.log.length === 0 && <div className="p-muted">（暂无）</div>}
              {s.log.slice(0, logMax).map((l, i) => (
                <div
                  key={i}
                  className={l.isError ? 'fpx-log-line err' : 'fpx-log-line'}
                  title="右键可复制这一条"
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setLogMenu({ text: `[${l.at}] ${l.text}`, x: e.clientX, y: e.clientY });
                  }}
                >
                  <span className="p-muted">[{l.at}]</span> {l.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- 弹窗 ----------------
          全部形态集中在 `components/DialogsHub.tsx`（约 200 行）。
          App 是组装层，不该再塞这么多彼此无关的条件渲染。 */}
      <Dialogs
        s={sReady}
        dialog={dialog}
        setDialog={setDialog}
        doMove={doMove}
        doRenameContent={doRenameContent}
        chainActions={chainActions}
        pendingSend={pendingSend}
        setPendingSend={setPendingSend}
        sendAction={sendAction}
        confirmLink={confirmLink}
        setConfirmLink={setConfirmLink}
        confirmRemoveTab={confirmRemoveTab}
        setConfirmRemoveTab={setConfirmRemoveTab}
        help={help}
        setHelp={setHelp}
        tipsHeight={tipsHeight}
        saveLayout={saveLayout}
        openIconPicker={openIconPicker}
        iconFiles={iconFiles}
        setIconFiles={setIconFiles}
      />

      {/* 日志行右键：复制这一条（原版日志区支持复制单项） */}
      {logMenu && (
        <ContextMenu
          x={logMenu.x}
          y={logMenu.y}
          items={[{ label: '复制这一条', onClick: () => copyText(logMenu.text) }]}
          onClose={() => setLogMenu(null)}
        />
      )}

      {/* 菜单统一渲染到这里（原因见 ui.tsx 的注释）：脱离 .p-card 的层叠上下文 */}
      <div className="fpx-menu-layer" ref={setMenuLayer} />
    </div>
    </MenuLayerContext.Provider>
  );
}

/** 一列（项目 / 项目组） */
function Column({
  title, kind, tabs, cards, selected, onSelect, onOpen, onMove, onMoveToTab, onCrossDrop,
  thumbs, menus, onAdd, onAddTab, onRenameTab, onRemoveTab, onMoveTab, active, onTab, focused,
  onJumpToGroup, onEditLink, onExternalDrop, onExternalNotice,
}: {
  title: string;
  kind: CardKind;
  tabs: { name: string; items: CardInfo[] }[];
  cards: CardInfo[];
  selected: string | null;
  onSelect: (p: string) => void;
  onOpen: (p: string) => void;
  onMove: (path: string, index: number) => void;
  /** 卡片拖到某个页签上：移动到该页签末尾 */
  onMoveToTab: (path: string, tabIndex: number) => void;
  onCrossDrop: (drag: DragPayload, target: CardInfo | null) => void;
  /** 图标路径 → data URI（自定义图标在沙箱里显示不了，需后端转） */
  thumbs: Record<string, string>;
  menus: (card: CardInfo) => MenuItem[];
  onAdd: () => void;
  onAddTab: () => void;
  onRenameTab: (i: number, n: string) => void;
  onRemoveTab: (i: number) => void;
  /** 页签拖动重排 */
  onMoveTab: (from: number, to: number) => void;
  active: number;
  onTab: (i: number) => void;
  /** 键盘焦点栏：卡片快捷键作用于此栏 */
  focused: boolean;
  /** 点卡片上的项目组名 → 在项目组栏里选中它（仅项目栏用得到） */
  onJumpToGroup?: (card: CardInfo) => void;
  /* #82 必须外层传入（Column 里没有 App 的 setter） */
  onEditLink?: (project: string, group: string) => void;
  /**
   * #14 从文件管理器拖入文件夹。
   * @param target 绝对路径（direct=true）或名字（direct=false，拿不到路径时兜底）
   * @param direct true = 直接导入，不要再弹对话框
   */
  /* #360 tabIndex：拖到**页签**上时指定落到哪个页签，卡片区触发时为
     undefined（落到当前活动页签）。后端早就支持，缺的一直是入口没接上。 */
  onExternalDrop?: (target: string, direct: boolean, tabIndex?: number) => void;
  /**
   * #14 拖进来的东西**不是文件夹**时告知用户。
   *
   * 为什么不能省：拖一段文字或单个文件也会命中"外部拖入"的判定
   * （它们 types 里一个内部 MIME 都没有），若一律弹选目录框，
   * 用户拖文字却弹框，只会觉得这个功能莫名其妙。
   * 但也不能静默 —— 静默正是 #14 要修的原痛点。
   */
  onExternalNotice?: (kind: 'file' | 'empty', name: string) => void;
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // 由「⋯」菜单触发的内联重命名：-1 表示不在编辑
  const [editingTab, setEditingTab] = useState(-1);

  return (
    <div className={`p-card fpx-col${focused ? ' focus' : ''}`}>
      <div className="p-row fpx-col-head">
        <h2 style={{ margin: 0 }}>
          {title}
          <span className="p-muted" style={{ fontWeight: 400 }}>（{cards.length}）</span>
          {focused && (
            // 用 ⌨ 而不是「焦点」二字：栏宽下限 240px，多两个汉字会把头部挤到换行，
            // 页签条整体下移 —— 三栏上边缘看着就不齐了。含义靠 title 与使用说明补。
            <span className="fpx-badge dim fpx-focus-tag" title="键盘快捷键作用于此栏（Ctrl/⌘+←/→ 切换）">
              ⌨
            </span>
          )}
        </h2>
        <div className="p-row fpx-col-head-ops">
          <button className="p-btn sm" onClick={onAdd}>＋ 添加</button>
          <button
            className="p-btn sm"
            onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}
          >
            ⋯
          </button>
        </div>
      </div>

      <TabBar
        kind={kind}
        tabs={tabs}
        active={active}
        onSelect={onTab}
        onAdd={onAddTab}
        onRename={onRenameTab}
        onRemove={onRemoveTab}
        editing={editingTab}
        onEditingDone={() => setEditingTab(-1)}
        onDropCard={(path, tabIndex) => onMoveToTab(path, tabIndex)}
        onMoveTab={onMoveTab}
        /* #360 拖文件夹到页签上 → 落到**那个**页签。
           此前这里没传：TabBar 的 onDrop 里根本没有外部分支，
           拖到页签上直接回弹、界面毫无变化。 */
        onExternalDrop={onExternalDrop}
        onExternalNotice={onExternalNotice}
      />

      <CardGrid
        kind={kind}
        cards={cards}
        selected={selected}
        onSelect={onSelect}
        onOpen={onOpen}
        onMove={onMove}
        onCrossDrop={onCrossDrop}
        menus={menus}
                /* 加末尾虚线添加框（#287）之后这句提示才名副其实 */
        emptyHint={`还没有${title}，点下面的「＋ 添加${title}」选一个文件夹`}
        onJumpToGroup={onJumpToGroup}
                /* #82：用行里的 group，不用卡片汇总的 linkedGroup */
        onEditLink={onEditLink}
        onExternalDrop={onExternalDrop}
        onExternalNotice={onExternalNotice}
        onAdd={onAdd}
        addHint={`添加${title}`}
      />

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            { label: '新增页签', onClick: onAddTab },
            // 走 TabBar 的内联输入框，不用浏览器 prompt()（沙箱里样式割裂且体验差）
            { label: '重命名当前页签', onClick: () => setEditingTab(active) },
            { label: '删除当前页签', danger: true, onClick: () => onRemoveTab(active) },
          ]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
