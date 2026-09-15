import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ContentPanel } from './components/ContentPanel';
import { RenameDialog } from './components/RenameDialog';
import { RenameContentDialog } from './components/RenameContentDialog';
import { CardGrid, TabBar, type DragPayload } from './components/CardGrid';
import { CreateDialog, IconPickDialog, LockDialog, StyleDialog } from './components/dialogs';
import { DirDialog } from './components/DirDialog';
import { SideRail } from './components/SideRail';
import { StackedGroups } from './components/StackedGroups';
import {
  BackupDialog, ChainDialog, EditorDialog,
} from './components/ToolsPanel';
import { ConfirmDialog, ContextMenu, MenuLayerContext, type MenuItem } from './components/ui';
import { normalizeKey } from './api';
import { useFpx } from './hooks/useFpx';
import { useCardHotkeys } from './hooks/useCardHotkeys';
import { useIconThumbs } from './hooks/useIconThumbs';
import type { CardInfo, CardKind, ChainAction } from './types';

type Dialog =
  | { type: 'none' }
  /** 选目录加入页签；tabIndex 用于项目组栏堆叠后指定落到哪个分类 */
  | { type: 'pickDir'; kind: CardKind; tabIndex?: number }
  | { type: 'create'; kind: CardKind }
  | { type: 'lock'; card: CardInfo }
  | { type: 'style'; card: CardInfo }
  | { type: 'icons'; card: CardInfo }
  | { type: 'backup' }
  | { type: 'editor' }
  | { type: 'chain'; target: string; kind: CardKind }
  | { type: 'rename'; card: CardInfo; kind: CardKind }
  /** 搬家：选目标父目录 */
  | { type: 'move'; card: CardInfo; kind: CardKind }
  /** 内容区条目改名 */
  | { type: 'renameContent'; path: string; name: string };

export default function App() {
  const s = useFpx();
  const { ctx, boot } = s;
  const [dialog, setDialog] = useState<Dialog>({ type: 'none' });
  const [iconFiles, setIconFiles] = useState<string[]>([]);

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
   *
   * 位置不能往下挪：下面有 `if (s.loading)` / `if (!boot)` 两个提前 return，
   * hook 一旦落在它们之后，首帧（loading）就调不到、次帧调得到，
   * React 会直接抛 "Rendered more hooks than during the previous render"
   * —— 整个组件树崩掉、插件白屏。所有 hook 必须在这两个分支之前。
   */
  const [menuLayer, setMenuLayer] = useState<HTMLDivElement | null>(null);

  /**
   * 键盘焦点栏：卡片快捷键（Ctrl/⌘+O、F2、Delete…）作用在哪一栏。
   * 点哪一栏的卡片就把焦点带到哪一栏，也可由 Ctrl/⌘+←/→ 直接切换。
   * 不存 store —— 只是本次会话的落点，重进默认给「项目」。
   */
  const [focus, setFocus] = useState<CardKind>('project');

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
   *
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

  /**
   * 复制文本到剪贴板。
   * 主力走后端（不受 iframe 沙箱权限限制）；后端不可用时退回 Clipboard API，
   * 再不行用 execCommand 兜底 —— 三档都失败才提示，避免出现"点了没反应"。
   */
  const copyText = async (text: string) => {
    try {
      if (await s.api.copyText(text)) {
        ctx.toast('已复制', 'ok');
        return;
      }
      s.pushLog('复制失败：后端未能写入剪贴板', true);
    } catch {
      // 后端命令可能不存在（旧版本 Rust 未编译进来），静默降级到浏览器 API
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ctx.toast('已复制', 'ok');
        return;
      }
    } catch { /* 继续兜底 */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      ctx.toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'err');
    } catch {
      ctx.toast('复制失败', 'err');
    }
  };

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
      { label: '保护（ACL）…', onClick: () => setDialog({ type: 'lock', card }) },
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
      onClick: () => s.removeCard(kind, card.path),
    });
    return base;
  };

  /** 「快速链接」关闭时，跨栏拖放先弹确认：待建链的项目 / 项目组 */
  const [confirmLink, setConfirmLink] = useState<{ project: string; group: string } | null>(null);

  /** 连锁动作清单：右键菜单按需渲染，工具栏「发送到 AI」也用同一份 */
  const [chainActions, setChainActions] = useState<ChainAction[]>([]);
  /**
   * 拉取动作的代次号。
   *
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
   * CardInfo 里只有组**名**（linkedGroup），定位却要**路径**，
   * 所以从链接记录里按项目路径反查。
   *
   * 查不到就明说，而不是静默不动：那通常意味着链接记录缺失
   * （手改过 config、或从未在这台机器上登记过），此时组名仍在卡片上显示，
   * 但点它跳不过去 —— 说清楚比让人反复点要强。
   */
  const jumpToGroup = useCallback((card: CardInfo) => {
    const ci = boot?.platform === 'windows';
    const key = normalizeKey(card.path, ci);
    const row = boot?.links.find((l) => normalizeKey(l.project, ci) === key);
    if (!row?.group) {
      ctx.toast(`找不到「${card.linkedGroup}」的路径：链接记录里没有这一条`, 'err');
      return;
    }
    setFocus('group');
    s.setSelGroup(row.group);
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
      .catch(() => { if (!cancelled) setChainActions([]); });
    return () => { cancelled = true; };
  }, [bootReady, s.api, chainVersion]);

  /* ---------------- 连锁动作：快捷键 + 侧边栏 ----------------
   * 两者都属于外壳能力，插件只能「注册 + 监听事件」，不能直接画到外壳上。
   * 动作清单变化时先撤再注册，避免残留指向已删除动作的条目。
   */
  const shortcutEvent = (id: string) => `fpx:chain:${id}`;
  const sidebarEvent = (id: string) => `fpx:sidebar:${id}`;

  /**
   * 当前选中项用 ref 传给事件处理，而不是直接进 useEffect 依赖。
   * 否则每点一张卡片都会重跑注册副作用：侧边栏被整体重建（闪烁、丢焦点），
   * 快捷键也要反复注销再注册。
   */
  const selRef = useRef<{ path: string; kind: CardKind } | null>(null);
  selRef.current = s.selProject
    ? { path: s.selProject, kind: 'project' }
    : s.selGroup ? { path: s.selGroup, kind: 'group' } : null;

  /** 对当前选中的卡片执行连锁动作；没选中就提示 */
  const runActionOnSelection = (a: ChainAction) => {
    const sel = selRef.current;
    if (!sel) {
      ctx.toast(`「${a.name}」需要选中一个项目或项目组`, 'err');
      return;
    }
    void sendAction(a.id, sel.kind, sel.path);
  };

  useEffect(() => {
    if (!bootReady) return;
    const unsubs: Array<() => void> = [];
    const registered: string[] = [];
    const sidebarIds: string[] = [];

    for (const a of chainActions) {
      if (a.shortcut && a.shortcut.trim()) {
        ctx.registerShortcut(a.shortcut.trim(), shortcutEvent(a.id), a.name);
        registered.push(a.shortcut.trim());
      }
      if (a.showSidebar) {
        ctx.addSidebarItem({
          id: a.id, label: a.name, icon: a.icon || '▶', event: sidebarEvent(a.id),
        });
        sidebarIds.push(a.id);
      }
    }

    // 两类事件都指向同一个处理：对当前选中的卡片执行该动作
    for (const a of chainActions) {
      unsubs.push(ctx.on(shortcutEvent(a.id), () => runActionOnSelection(a)));
      unsubs.push(ctx.on(sidebarEvent(a.id), () => runActionOnSelection(a)));
    }

    return () => {
      for (const u of unsubs) { try { u(); } catch { /* 忽略已失效的订阅 */ } }
      for (const acc of registered) ctx.unregisterShortcut(acc);
      for (const id of sidebarIds) ctx.removeSidebarItem(id);
    };
    // 只在动作清单变化时重建；选中项走 selRef，不进依赖。
    // 这里同样不能放 boot：它每次快照都是新对象，会让侧边栏与快捷键
    // 在所有写操作后被反复拆装（见上面 refreshChainActions 的注释）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootReady, chainActions, ctx]);

  /** 直接按动作发送（右键菜单用），失败记日志 + toast */
  const sendAction = async (actionId: string, kind: CardKind, path: string) => {
    try {
      const r = await s.api.chainSendAction(actionId, kind, path);
      s.pushLog(r.message, !r.ok);
      ctx.toast(r.message, r.ok ? 'ok' : 'err');
    } catch (e) {
      const msg = `发送失败：${String((e as Error)?.message ?? e)}`;
      s.pushLog(msg, true);
      ctx.toast(msg, 'err');
    }
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
      void s.moveCardAcross(drag.kind, drag.path, s.activeTab[dst] ?? 0);
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

  const openIconPicker = async (card: CardInfo) => {
    try {
      const files = await s.api.listIcons();
      setIconFiles(files);
      setDialog({ type: 'icons', card });
    } catch (e) {
      s.pushLog(String((e as Error)?.message ?? e), true);
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

  /** 内容区条目改名：改完重扫一遍目录 */
  const doRenameContent = useCallback(async (path: string, name: string) => {
    const r = await s.run('改名', () => s.api.renameContentItem(path, name));
    if (!r) return;
    s.pushLog(`已改名为「${name}」`);
    await s.scan(s.focusDir);
  }, [s]);

  /**
   * 页签前后翻页，到头回环。索引先 clamp：activeTab 与当前快照可能不同步。
   *
   * 项目组栏改成纵向堆叠后，所有分类同时在屏幕上，
   * 再切「当前页签」没有任何可见效果 —— 所以这里改成把选中项移到下一个分类的
   * 第一张卡片：既保留了"在分类间前后跳"的语义，又真的看得见（还会把键盘焦点带过去）。
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
          title: '打开选中文件夹（Ctrl/⌘+O）',
          onClick: needCard((c) => openPath(c.path, 'dir')),
        },
        {
          icon: '🔒', label: '保护',
          title: 'ACL 保护（Ctrl/⌘+L）',
          onClick: needCard((c) => setDialog({ type: 'lock', card: c })),
        },
        {
          icon: '✎', label: '改名',
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
          title: '图标与标签色（F4）',
          onClick: needCard((c) => setDialog({ type: 'style', card: c })),
        },
        {
          icon: '🖼', label: '改图标',
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
          title: '从当前分类 / 页签移除（Delete）',
          danger: true,
          onClick: needCard((c) => void s.removeCard(
            focus, c.path, focus === 'group' ? groupTabIndexOf(c.path) : undefined,
          )),
        },
      ],
    },
  ], [focus, groupTabIndexOf, needCard, openIconPicker, openPath, refreshChainActions, s]);

  useCardHotkeys(ctx, {
    open: needCard((c) => openPath(c.path, 'dir')),
    lock: needCard((c) => setDialog({ type: 'lock', card: c })),
    rename: needCard((c) => setDialog({ type: 'rename', card: c, kind: focus })),
    move: needCard((c) => void s.moveCardAcross(
      focus, c.path, focus === 'project' ? s.activeTab.group : s.activeTab.project,
    )),
    color: needCard((c) => setDialog({ type: 'style', card: c })),
    icon: needCard((c) => void openIconPicker(c)),
    remove: needCard((c) => void s.removeCard(
      focus, c.path, focus === 'group' ? groupTabIndexOf(c.path) : undefined,
    )),
    refresh: () => { refreshChainActions(); s.refresh(); },
    clearInvalid: () => void s.clearInvalid(),
    cycleTab,
    focus: setFocus,
    // 有弹窗打开时整组让路：否则在对话框里按 Delete 会改到看不见的卡片
  }, !!boot && dialog.type === 'none' && !help && !confirmLink);

  if (s.loading) {
    return <div className="p-card"><div className="p-muted">正在加载项目组数据…</div></div>;
  }
  if (!boot) {
    return (
      <div className="p-card">
        <h2>加载失败</h2>
        <div className="p-muted">后端命令不可用。请确认在 Nexus Panel（Tauri 环境）中运行，且已重新编译 Rust 端。</div>
        <button className="p-btn primary" style={{ marginTop: 12 }} onClick={() => s.refresh()}>重试</button>
      </div>
    );
  }

  return (
    <MenuLayerContext.Provider value={menuLayer}>
    <div className="fpx-root">
      {/* ---------------- 工具栏 ---------------- */}
      <div className="p-card">
        <div className="p-row" style={{ justifyContent: 'space-between' }}>
          <div className="p-row">
            <button className="p-btn primary" onClick={() => setDialog({ type: 'create', kind: 'project' })}>＋ 新建项目</button>
            <button className="p-btn primary" onClick={() => setDialog({ type: 'create', kind: 'group' })}>＋ 新建项目组</button>
            <button
              className="p-btn"
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
            <button className="p-btn" onClick={() => setDialog({ type: 'backup' })}>备份</button>
            <button
              className="p-btn"
              title="基础设置 / 链接名 / 服务已移到外壳右上角的「⚙ 设置」"
              onClick={() => s.pushLog('设置入口在外壳右上角的「⚙ 设置」（重载按钮左侧）')}
            >
              设置在哪？
            </button>
            <button
              className="p-btn"
              title="F5"
              onClick={() => {
                // 刷新要连动作清单一起拉：外部（MCP / 旧版本配置迁移）也可能改过它
                refreshChainActions();
                s.refresh();
              }}
            >
              刷新
            </button>
            <button
              className="p-btn"
              title="摘掉页签里已不存在的路径（F8）"
              onClick={() => void s.clearInvalid()}
            >
              清除无效项
            </button>
            <button className="p-btn" onClick={() => setHelp(true)}>使用说明</button>
          </div>
          <div className="p-row">
            <span className="p-mono p-muted" title={boot.dataDir}>数据：{boot.dataDir}</span>
            <button className="p-btn" onClick={() => s.api.openDataDir().catch((e) => s.pushLog(String(e), true))}>
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
        />

        <div className="fpx-main">
          <div className="fpx-cols">
            <Column
              title="项目"
              kind="project"
              tabs={boot.projectTabs}
              cards={projectCards}
              selected={s.selProject}
              onSelect={(p) => { setFocus('project'); s.setSelProject(p); }}
              onOpen={(p) => openPath(p, 'dir')}
              onMove={(path, i) => s.moveCard('project', path, s.activeTab.project, i)}
              onMoveToTab={(path, tabIndex) => {
                const n = boot.projectTabs[tabIndex]?.items.length ?? 0;
                s.moveCard('project', path, tabIndex, n);
              }}
              onCrossDrop={onCrossDrop}
              thumbs={iconThumbs}
              menus={menus('project')}
              onAdd={() => setDialog({ type: 'pickDir', kind: 'project' })}
          onAddTab={() => s.addTab('project', `页签${(boot.projectTabs.length) + 1}`)}
              onRenameTab={(i, n) => s.renameTab('project', i, n)}
              onRemoveTab={(i) => s.removeTab('project', i)}
              active={s.activeTab.project}
              onTab={(i) => s.setActiveTab((prev) => ({ ...prev, project: i }))}
              focused={focus === 'project'}
              onJumpToGroup={jumpToGroup}
            />

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
                    className="p-btn"
                    style={{ height: 30, padding: '0 12px' }}
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
                onMove={(tabIndex, path, index) => s.moveCard('group', path, tabIndex, index)}
                onCrossDrop={onCrossDrop}
                menus={menus('group')}
                onRename={(i, n) => s.renameTab('group', i, n)}
                onRemove={(i) => s.removeTab('group', i)}
                onAdd={(i) => setDialog({ type: 'pickDir', kind: 'group', tabIndex: i })}
                emptyHint="还没有项目组，点分类右侧的 ＋ 添加"
              />
            </div>

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
                onRefresh={() => void s.scan(s.focusDir)}
              />
            </div>
          </div>

          {/* ---------------- 日志（对照 WPF 底部的 140px 日志行）---------------- */}
          <div className="p-card fpx-logcard">
            <h2 style={{ margin: 0 }}>日志</h2>
            <div className="fpx-log">
              {s.log.length === 0 && <div className="p-muted">（暂无）</div>}
              {s.log.slice(0, 40).map((l, i) => (
                <div key={i} className={l.isError ? 'fpx-log-line err' : 'fpx-log-line'}>
                  <span className="p-muted">[{l.at}]</span> {l.text}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ---------------- 弹窗 ---------------- */}
      {dialog.type === 'pickDir' && (
        <DirDialog
          api={s.api}
          title={dialog.kind === 'project' ? '添加项目文件夹' : '添加项目组文件夹'}
          allowCreate
          onClose={() => setDialog({ type: 'none' })}
          onPick={(p) => s.addCard(dialog.kind, p)}
        />
      )}

      {dialog.type === 'create' && (
        <CreateDialog
          api={s.api}
          kind={dialog.kind}
          defaultParent={dialog.kind === 'project' ? boot.config.createProjectDir : boot.config.createGroupDir}
          defaultTemplate={boot.config.createGroupTemplateDir}
          tabName={dialog.kind === 'project'
            ? (boot.projectTabs[s.activeTab.project]?.name ?? '默认')
            : (boot.groupTabs[s.activeTab.group]?.name ?? '默认')}
          hierarchyOn={boot.config.createPathCarriesHierarchy}
          onClose={() => setDialog({ type: 'none' })}
          onCreated={(p) => s.addCard(dialog.kind, p)}
          onLog={s.pushLog}
        />
      )}

      {dialog.type === 'lock' && (
        <LockDialog
          path={dialog.card.path}
          denyDelete={dialog.card.denyDelete}
          denyWrite={dialog.card.denyWrite}
          onClose={() => setDialog({ type: 'none' })}
          onApply={(dd, dw) => s.setLock(dialog.card.path, dd, dw)}
        />
      )}

      {dialog.type === 'rename' && (
        <RenameDialog
          card={dialog.card}
          kind={dialog.kind}
          onClose={() => setDialog({ type: 'none' })}
          onSubmit={async (newName) => {
            const r = await s.renameFolder(dialog.kind, dialog.card.path, newName);
            return !!r;
          }}
        />
      )}

      {dialog.type === 'move' && (
        <DirDialog
          api={s.api}
          title={`选择「${dialog.card.name}」的新位置（搬家）`}
          allowCreate
          onClose={() => setDialog({ type: 'none' })}
          onPick={(p) => {
            setDialog({ type: 'none' });
            void doMove(dialog.card, dialog.kind, p);
          }}
        />
      )}

      {dialog.type === 'renameContent' && (
        <RenameContentDialog
          name={dialog.name}
          onClose={() => setDialog({ type: 'none' })}
          onSubmit={async (n) => {
            await doRenameContent(dialog.path, n);
            return true;
          }}
        />
      )}

      {dialog.type === 'style' && (
        <StyleDialog
          api={s.api}
          path={dialog.card.path}
          icon={dialog.card.icon}
          color={dialog.card.tagColor}
          inherited={dialog.card.tagColorInherited}
          customColors={boot.config.customColors}
          onClose={() => setDialog({ type: 'none' })}
          onApply={(icon, color) => s.saveStyle(dialog.card.path, icon, color)}
          onSaveCustom={(colors) => s.saveCustomColors(colors)}
          onPickIconFile={() => openIconPicker(dialog.card)}
          onLog={s.pushLog}
        />
      )}

      {dialog.type === 'icons' && (
        <IconPickDialog
          api={s.api}
          files={iconFiles}
          groups={boot.config.iconGroups}
          onGroupsChange={(groups) => s.updateConfig((d) => { d.iconGroups = groups; })}
          onClose={() => setDialog({ type: 'none' })}
          onPick={(p) => s.setIcon(dialog.card.path, p)}
          onImported={setIconFiles}
          onLog={s.pushLog}
        />
      )}

      {dialog.type === 'backup' && (
        <BackupDialog
          api={s.api}
          config={boot.config}
          onClose={() => setDialog({ type: 'none' })}
          onLog={s.pushLog}
          // 备份要遍历整棵树，好几秒。这期间磁盘上的配置可能已被改过
          // （MCP server 直接写文件，不经前端），所以存之前重读一次再改。
          onSaved={(patch) => s.updateConfig((d) => Object.assign(d, patch), { fresh: true })}
        />
      )}

      {dialog.type === 'editor' && (
        <EditorDialog
          api={s.api}
          config={boot.config}
          onClose={() => setDialog({ type: 'none' })}
          onLog={s.pushLog}
          onSaved={(patch) => s.updateConfig((d) => Object.assign(d, patch))}
        />
      )}

      {dialog.type === 'chain' && (
        <ChainDialog
          api={s.api}
          config={boot.config}
          target={dialog.target}
          kind={dialog.kind}
          onClose={() => setDialog({ type: 'none' })}
          onLog={s.pushLog}
          onSaved={(patch) => s.updateConfig((d) => Object.assign(d, patch))}
        />
      )}

      {confirmLink && (
        <ConfirmDialog
          title="确认创建链接"
          message={`将为该项目建立指向项目组的链接：\n项目：${confirmLink.project}\n项目组：${confirmLink.group}\n\n可在「设置」里开启「快速链接」跳过此确认。`}
          confirmText="创建链接"
          onConfirm={() => void s.createLink(confirmLink.project, confirmLink.group)}
          onClose={() => setConfirmLink(null)}
        />
      )}

      {help && (
        <HelpDialog onClose={() => setHelp(false)} platform={boot.platform} />
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
  thumbs, menus, onAdd, onAddTab, onRenameTab, onRemoveTab, active, onTab, focused,
  onJumpToGroup,
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
  active: number;
  onTab: (i: number) => void;
  /** 键盘焦点栏：卡片快捷键作用于此栏 */
  focused: boolean;
  /** 点卡片上的项目组名 → 在项目组栏里选中它（仅项目栏用得到） */
  onJumpToGroup?: (card: CardInfo) => void;
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
          <button className="p-btn" style={{ height: 30, padding: '0 12px' }} onClick={onAdd}>＋ 添加</button>
          <button
            className="p-btn"
            style={{ height: 30, padding: '0 12px' }}
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
        emptyHint={`还没有${title}，点「＋ 添加」选一个文件夹`}
        onJumpToGroup={onJumpToGroup}
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

function HelpDialog({ onClose, platform }: { onClose: () => void; platform: string }) {
  return (
    <div className="mask" onMouseDown={onClose}>
      <div className="dialog p-card" style={{ width: 560 }} onMouseDown={(e) => e.stopPropagation()}>
        <h2>使用说明</h2>
        <ul className="fpx-help">
          <li><b>分配</b>：把「项目」卡片拖到「项目组」卡片上（或反向拖），
            会在项目目录下为每个启用的 agent 链接名建立指向项目组的链接。
            建链只有拖放这一条路，没有按钮。</li>
          <li><b>撤销链接</b>：在「项目」卡片上右键 →「撤销链接」。</li>
          <li><b>链接名 / 服务 / 基础设置</b>：都在外壳右上角的「⚙ 设置」里（重载按钮左侧）——
            链接名开关、MCP 与目录监听、备份与交互选项等。</li>
          <li><b>内容浏览</b>：选中项目组后，右栏列出其 agent / skill / rule（读 <span className="p-mono">agent(s)/ skill(s)/ rules</span> 目录），点条目看内容。</li>
          <li><b>新建</b>：直接创建文件夹并加入页签（项目组可带模板目录）。</li>
          <li><b>保护 / 图标</b>：卡片右键可设 ACL 保护、自定义图标与标签颜色。</li>
          <li><b>数据</b>：独立存于 {platform === 'windows' ? '%APPDATA%' : '应用数据目录'} 下的 <span className="p-mono">project-group/</span>，
            与原 C# 版数据目录互不干扰。</li>
          <li><b>快捷键</b>：栏目标题上标「焦点」的那栏就是键盘操作的对象（Ctrl/⌘+←/→ 切换，或点该栏卡片）。
            对其选中的卡片：Ctrl/⌘+O 打开、Ctrl/⌘+L 保护、F2 改名、F3 换栏、F4 改色、F6 改图标、Delete 移除；
            Ctrl/⌘+Tab 与 Ctrl/⌘+Shift+Tab 在项目组分类间跳（选中该分类第一张卡片），
            Ctrl/⌘+PageDown/PageUp 翻项目页签；
            F5 刷新、F8 清除无效项。打字时与弹窗打开时整组不触发。</li>
        </ul>
        <div className="p-row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="p-btn primary" onClick={onClose}>知道了</button>
        </div>
      </div>
    </div>
  );
}
