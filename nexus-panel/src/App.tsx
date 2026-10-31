import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createHost, loadRegistry, filterByRuntime, visiblePlugins, saveCustomPlugins, getCustomPlugins, isInsideTauri,
  takeCustomPluginWriteError, customPluginWriteFailMsg,
  /* 两个壳共用的存储键：必须来自 host.js 的常量，不能各写裸字面量 ——
     两个壳跑在同一份 localStorage 上，谁改了一侧拼写，
     另一侧就开始读另一个键，"在 A 壳设的状态 B 壳不认"且不报错。 */
  KEY_LAST_PLUGIN, KEY_SIDEBAR_OPEN,
  type Host, type PluginManifest,
} from '../js/host.js';
import * as extPolicy from '../js/external-policy.js';
import { confirm } from '../js/dialog.js';
import * as pluginCfg from '../js/plugin-config.js';
import * as themeApi from '../js/theme-manager.js';
import { getCloseAction, onCloseActionChange } from '../js/host.js';
// 主题切换统一由 js/theme-picker.js 的弹出层处理（标题栏按钮 + 设置页共用），
// 外壳不再自己维护"当前主题名"状态，避免两处各存一份、切完不同步。
import Titlebar, { type WinAction } from './components/Titlebar';
import Sidebar from './components/Sidebar';
import Stage from './components/Stage';
import Toasts, { type ToastItem } from './components/Toasts';
import AddPluginDialog from './components/AddPluginDialog';
import PluginSettingsDrawer from './components/PluginSettingsDrawer';
import { installTooltip, refreshTooltip } from '../js/tooltip.js';
import { installInspector, isInspectorOn, escInspector } from '../js/inspector.js';

/**
 * 全局唯一 ID（toast / 自定义插件共用）
 * ------------------------------------------------------------
 * 原来是 `Date.now() + Math.random()`：两个数字浮点相加，
 * 连点两次时时间戳相同、随机尾数极小，既不可读也有碰撞风险。
 * 优先用 crypto.randomUUID；非安全上下文（http 调试、老 WebView）降级。
 */
function nextId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/*
 * 「从 CSP 指令反推外链类型」这一环**不再在本文件出现**：
 * 此前它和 js/shell.js 的 kindOf() 是同一段逻辑抄了两遍（本文件的注释
 * 还写着"与 shell.js 保持一致"——靠人记得同步，等于必然会漂）。
 * 现在由 external-policy 的 handleViolation 内部调用 kindOfDirective，
 * 两个壳都只调 handleViolation，判据与文案都只有一份。
 */

/** CSP 违规上报的两种形状：宿主转发的是 blockedURI，watchViolations 给的是 host + sample */
interface ViolationInfo {
  blockedURI?: string;
  sample?: string;
  host?: string;
  directive?: string;
  kind?: string;
  view?: string;
}

export default function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<Host | null>(null);
  /** 所有延时回调登记在此，卸载时统一清理，避免对已卸载组件 setState */
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const aliveRef = useRef(true);
  /** 设置页外链卡片注册的刷新回调（外链变化时通知它重绘） */
  const refreshExternalUIRef = useRef<(() => void) | null>(null);

  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [injected, setInjected] = useState<
    { id: string; pluginId: string; label: string; icon?: string; event: string }[]
  >([]);
  const [title, setTitle] = useState('未选择插件');
  const [subtitle, setSubtitle] = useState('');
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  /** 当前插件是否提供了自己的设置面板（决定「⚙ 设置」按钮显隐） */
  const [hasSettings, setHasSettings] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /** 延时版 setTimeout：自动登记，组件卸载后不再触发 */
  const setTimer = useCallback((fn: () => void, ms: number) => {
    const t = setTimeout(() => {
      timersRef.current.delete(t);
      if (aliveRef.current) fn();
    }, ms);
    timersRef.current.add(t);
    return t;
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      timersRef.current.forEach((t) => clearTimeout(t));
      timersRef.current.clear();
    };
  }, []);

  const pushToast = useCallback((msg: string, type: string = 'info') => {
    const id = nextId();
    // 对外接受任意字符串（外壳的 ctx.toast 也传字符串），
    // 落到 ToastItem 前收窄到它认的四种，避免把未知值塞进样式类名。
    // 'warn' 必须保留：设置页「做成了但没能记住（落盘失败）」那类
    // 提示靠它区分于普通 info —— 收窄成 info 的话两壳告警色阶不一致，
    // 而 .toast.warn（css/controls.css）在 React 壳永远用不上。
    const kind: ToastItem['type'] =
      type === 'ok' || type === 'err' || type === 'warn' ? type : 'info';
    setToasts((t) => [...t, { id, msg, type: kind }]);
    setTimer(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
  }, [setTimer]);

  /* ---------- 标题栏窗口按钮 ---------- */
  /* ✕ 的行为由设置决定（默认藏到托盘）。用 state 存是为了让按钮文案跟着变；
     订阅宿主的变化通知，设置页改完立即生效，不用重启。 */
  const [closeAction, setCloseAction] = useState<'hide' | 'close'>(() => getCloseAction());
  useEffect(() => onCloseActionChange((v) => setCloseAction(v)), []);

  const handleWin = useCallback((a: WinAction) => {
    void hostRef.current?.win(a);
    /* 藏起来之后没有任何入口能唤回（窗口收不到键盘事件），
       必须明确告诉用户点托盘 —— 否则窗口凭空消失，只会以为程序崩了。 */
    if (a === 'hide') pushToast('已隐藏到托盘 · 点击托盘图标可唤回', 'info');
  }, [pushToast]);

  /* 工具栏插件要切插件 / 发事件时走这两个（MCP 状态用它打开凭据中心） */
  const handleNavigate = useCallback((id: string) => {
    void hostRef.current?.mount(id);
  }, []);
  const handleEmit = useCallback((ev: string, payload?: unknown) => {
    hostRef.current?.bus?.emit?.(ev, payload);
  }, []);

  /* ---------- 外链：被 CSP 拦下的请求统一登记 ---------- */
  /*
   * 判据与提示文案都在 external-policy 的 handleViolation 里 ——
   * 本文件此前有一份自己的实现，与原生壳（js/shell.js）那份是
   * **同一段逻辑抄了两遍**。React 这份是"对的那一半"（两种上报形状都兜），
   * 但两份并存就意味着迟早有人只改一边。
   * 只把 toast 这一步留在这里 —— 两个壳的提示机制本来就不是同一个。
   */
  const handleCspViolation = useCallback((d: ViolationInfo, manifest?: PluginManifest) => {
    const r = extPolicy.handleViolation(d, {
      pluginId: manifest?.id,
      pluginName: manifest?.name,
      notify: (msg: string, kind: string) => pushToast(msg, kind as never),
    });
    if (r) refreshExternalUIRef.current?.();
  }, [pushToast]);

  /** 安装 / 更新插件时扫一遍外链（用户要求：每次导入与更新都检查） */
  const scanPluginExternal = useCallback(async (p: { entry?: string; id?: string; name?: string }) => {
    if (!p?.entry) return { ok: false, hosts: [] };
    const r = await extPolicy.scanEntry(p.entry, p.id);
    if (r.externalEntry) {
      pushToast(`⚠ 插件「${p.name}」的入口是外域地址，代码将来自网络`, 'err');
    } else if (r.hosts?.length && extPolicy.loadPolicy().mode === 'smart') {
      const names = r.hosts.map((x) => x.host).join('、');
      pushToast(`「${p.name}」检测到 ${r.hosts.length} 个外链：${names}`, 'err');
    }
    refreshExternalUIRef.current?.();
    return r;
  }, [pushToast]);

  /** 全量重扫（设置页「重新检查」按钮） */
  const rescanAllPlugins = useCallback(async () => {
    const list = hostRef.current?.getPlugins() ?? [];
    let total = 0;
    for (const p of list) {
      const r = await extPolicy.scanEntry(p.entry, p.id).catch(() => ({ hosts: [] as { host: string }[] }));
      total += r.hosts?.length || 0;
    }
    pushToast(`已检查 ${list.length} 个插件，登记 ${total} 个外链`, 'ok');
    refreshExternalUIRef.current?.();
  }, [pushToast]);

  /* 悬浮提示：接管原生 title（原生有约 1 秒延迟，无法调整）。
     与无构建模式共用 js/tooltip.js，行为一致。
     放在最前面，保证插件挂载前就已生效。 */
  useEffect(() => installTooltip(), []);

  /* 开发者模式 · 元素检查器：与无构建模式共用 js/inspector.js。
     快捷键在模块内部注册（Ctrl/Cmd + Shift + D）。 */
  /*
   * 只装快捷键与状态恢复。按钮已抽成工具栏插件（toolbar-inspector），
   * 高亮态由它自己监听 nexus:inspector-toggle 同步 ——
   * 这里再留一个 inspecting state 就是同一份状态的第二个真相源。
   */
  useEffect(() => installInspector(), []);

  /* ---------- 初始化宿主（仅一次） ---------- */
  useEffect(() => {
    const host = createHost({
      getStage: () => stageRef.current,
      hooks: {
        toast: pushToast,
        onTitle: setTitle,
        onSubtitle: setSubtitle,
        onBadges: setBadges,
        onOpen: (id) => setActiveId(id),
        onSidebarItems: (items) => setInjected(items),
        // 插件声明了 settings 才显示「⚙ 设置」按钮；切插件 / 插件没设置时自动收起
        onSettingsAvailable: (has) => {
          setHasSettings(!!has);
          if (!has) setSettingsOpen(false);
        },
        onCspViolation: (info, manifest) => handleCspViolation(info, manifest),
        /*
         * 焦点在 iframe 插件里时，外壳收不到键盘事件（不跨文档冒泡），
         * 靠插件转发回来。
         *
         * 这里只接 ESC：检查器开着时鼠标扫过插件里的控件会把焦点带进去，
         * 于是 ESC 彻底失效、检查器关不掉。
         * 只在检查器开着时消费 —— 否则会抢走插件自己的 ESC（它用来关弹窗）。
         *
         * UI 状态不用手动同步：escInspector 会派发 nexus:inspector-toggle，
         * 工具栏里的检查器插件（toolbar-inspector）监听它更新自己的高亮态。
         */
        onShellShortcut: (combo) => {
          if (String(combo).toLowerCase() !== 'esc') return false;
          if (!isInspectorOn()) return false;
          escInspector();
          return true;
        },
      },
    });
    hostRef.current = host;

    (async () => {
      const list = filterByRuntime(await loadRegistry());
      host.state.plugins = list;          // 宿主持有完整列表（服务插件也要挂）
      setPlugins(visiblePlugins(list));   // 侧边栏只显示非服务插件

      const saved = localStorage.getItem(KEY_SIDEBAR_OPEN);
      setSidebarOpen(saved === null ? true : saved === '1');
      const accent = themeApi.getAccent();
      if (accent) document.documentElement.style.setProperty('--accent', accent);

      const last = localStorage.getItem(KEY_LAST_PLUGIN);
      const initial = last && list.some((p) => p.id === last) ? last : list[0]?.id ?? null;
      setActiveId(initial);
    })();

    // 观测主文档自己的 CSP 违规（插件内部的由 SDK 转发到 onCspViolation）
    const stopWatch = extPolicy.watchViolations((v) =>
      handleCspViolation(v, host.state.plugins.find((p) => p.id === host.state.activeId)));

    return () => { stopWatch?.(); host.unmount(); };
  }, [pushToast, handleCspViolation]);

  /* ---------- 切换 / 重载插件 ---------- */
  useEffect(() => {
    if (!activeId) return;
    localStorage.setItem(KEY_LAST_PLUGIN, activeId);
    setSettingsOpen(false);          // 切插件就收起上一个插件的设置抽屉
    hostRef.current?.mount(activeId);
  }, [activeId, reloadKey]);

  /**
   * 点击插件注入的侧边栏条目：把事件发到总线，由插件自己响应。
   * 若插件尚未挂载，先切过去再补发一次——否则用户点了没有任何反应。
   */
  const handleInjected = async (it: { id: string; pluginId: string; event: string }) => {
    const host = hostRef.current;
    if (!host) return;
    if (host.state.activeId !== it.pluginId) {
      setActiveId(it.pluginId);
      await new Promise((r) => setTimer(() => r(null), 150));   // 等插件挂载并订阅事件
    }
    host.bus.emit(it.event, { id: it.id });
  };

  /* ---------- 供插件与调试使用 ---------- */
  useEffect(() => {
    if (!isInsideTauri()) pushToast('浏览器调试模式：Rust 命令不可用（⌘/Ctrl+R 可重载插件）', 'err');
  }, [pushToast]);


  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  const addPlugin = useCallback(async (p: Omit<PluginManifest, 'id'>) => {
    /*
     * A3：外域代码不该被当成本地插件装进来 —— 与原生壳（js/shell.js
     * 的添加对话框）同一条规矩。React 壳此前没有这道确认：粘贴 CDN
     * 入口直接装上，无警告、外链不登记，CSP 不触发观测就全程无提示。
     */
    if (extPolicy.isExternal(p.entry)) {
      const host = extPolicy.hostOf(p.entry);
      const go = await confirm({
        title: '安装外域插件',
        message: `⚠ 这个插件的入口是外域地址：\n\n${host}\n\n`
          + `它的代码会由 ${host} 提供，并能访问本面板的数据。\n`
          + `确定要安装吗？（建议只在完全信任该来源时继续）`,
        okText: '仍然安装',
        danger: true,
      });
      if (!go) return;
    }
    const item: PluginManifest = { ...p, id: `custom-${nextId()}`, custom: true };
    /* 存不下时也要把对话框收掉：留着它界面就停在这一屏，
       而下面的「已添加」又不弹 —— 点了没反应、还退不出去。 */
    if (!saveCustomPlugins([...getCustomPlugins(), item])) {
      pushToast(customPluginWriteFailMsg('添加', item.name, takeCustomPluginWriteError()), 'err');
      setDialogOpen(false);
      return;
    }
    pushToast(`已添加「${item.name}」`, 'ok');
    setDialogOpen(false);
    /* 导入即扫外链（与原生壳同）：不扫的话，外链要等 CSP 违规才
       被发现，而用户装完插件根本不会再去看一眼设置页。 */
    try {
      await extPolicy.scanEntry(item.entry, item.id);
    } catch { /* 扫描失败不挡安装：入口都装上了，拦这个没意义 */ }
    (async () => {
      hostRef.current!.state.plugins = filterByRuntime(await loadRegistry());
      setPlugins(visiblePlugins(hostRef.current!.state.plugins));
      setActiveId(item.id);
    })();
  }, [pushToast]);

  const removePlugin = useCallback(async (id: string) => {
    /*
     * host.removePlugin 是 **async** 且返回 { ok, mcp }（卸载残留
     * 总收口）。此前这里写 `=== false` —— Promise 永远不等于 false，
     * 于是存储不可用时也照弹「已移除插件」：谎报成功，且 MCP 注销
     * 结果（可能失败待手动清理）被彻底丢掉。
     */
    const r = await hostRef.current?.removePlugin(id);
    if (!r) {
      pushToast('移除失败：未连接到外壳，请用侧栏的插件管理操作', 'err');
      return;
    }
    if (!r.ok) {
      pushToast(customPluginWriteFailMsg('移除', '', takeCustomPluginWriteError()), 'err');
      return;
    }
    pushToast('已移除插件', 'ok');
    /* MCP 网关协作结果：chokepoint 已注销（或失败），这里把结局说清 */
    if (r.mcp?.status === 'cleaned') {
      pushToast(`其 MCP 网关服务「${id}」已一并注销`, 'ok');
    } else if (r.mcp?.status === 'failed') {
      pushToast(`MCP 服务「${id}」注销失败：${r.mcp.error ?? ''}。可去「设置 → MCP 网关」手动移除`, 'warn');
    }
    (async () => {
      hostRef.current!.state.plugins = filterByRuntime(await loadRegistry());
      setPlugins(visiblePlugins(hostRef.current!.state.plugins));
      setActiveId('home');
    })();
  }, [pushToast]);

  /* ---------- 插件设置抽屉 ---------- */
  const closePluginSettings = useCallback(() => setSettingsOpen(false), []);

  /* 「⚙ 设置」对每个插件都显示，不再要求插件自带设置面板 ——
     抽屉里除了插件自定义设置，还有外壳固定提供的沙箱 / 插件主题，
     对任何插件都有意义，所以点开永远有内容。
     插件没有自定义设置时，抽屉只显示那段外壳区块 + 占位提示。 */
  const openPluginSettings = useCallback(() => {
    setSettingsOpen(true);
  }, []);

  /** 键盘快捷键里要用最新实现，但不必因此重挂监听（同 shell.js 的 runShellShortcutRef） */
  const openPluginSettingsRef = useRef(openPluginSettings);
  useEffect(() => { openPluginSettingsRef.current = openPluginSettings; }, [openPluginSettings]);

  /** 稳定的引用：抽屉的 useEffect 依赖它，每次渲染新建会让面板被反复重新挂载 */
  const mountSettings = useCallback(
    (container: HTMLElement, manifest: PluginManifest) =>
      hostRef.current!.mountSettings(container, manifest),
    [],
  );

  /* ---------- 快捷键 ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      const k = e.key.toLowerCase();
      if (k === 'b') {
        e.preventDefault();
        setSidebarOpen((v) => {
          localStorage.setItem(KEY_SIDEBAR_OPEN, !v ? '1' : '0');
          return !v;
        });
      }
      if (k === 'r' && activeId) {
        e.preventDefault();
        setReloadKey((n) => n + 1);
      }
      // ⌘/Ctrl + , —— 打开当前插件的设置面板（与原生外壳一致）
      if (e.key === ',') {
        e.preventDefault();
        openPluginSettingsRef.current?.();
      }
      /* ⌘/Ctrl + ~ —— 藏到托盘。
         只能"藏"不能"唤"：窗口隐藏后收不到键盘事件（那要全局快捷键插件）。
         所以必须明确提示怎么回来，否则窗口凭空消失、任务栏里也没有它，
         用户只会以为程序崩了。 */
      if (e.key === '`' || e.key === '~') {
        e.preventDefault();
        void hostRef.current?.win('hide');
        pushToast('已隐藏到托盘 · 点击托盘图标可唤回', 'info');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeId, pushToast]);

  /* 侧边栏展开后，正挂着的 nav-item 提示要收掉：名字已由 .nav-label 显示。
     必须在 DOM 更新之后跑 —— 这里读的是 #body 的 class，
     在 setSidebarOpen 的回调里调会读到旧值。 */
  useEffect(() => { refreshTooltip(); }, [sidebarOpen]);

  /* ---------- 供插件调用的全局接口 ---------- */
  useEffect(() => {
    window.__NEXUS__ = {
      state: hostRef.current?.state,
      bus: hostRef.current?.bus,
      toast: pushToast,
      navigate: (id: string) => setActiveId(id),
      removePlugin,
      getPlugins: () => plugins,
      /* 已注册的**全局**快捷键（accel → { pluginId, event, label }）。
         设置页的「快捷键」页要靠它列出插件注册的键并做撞车判断 ——
         拿不到就显示"未连接外壳"，而不是假装没有插件注册过。 */
      getShortcuts: () => hostRef.current?.getShortcuts?.() ?? {},
      mountPlugin: (id: string) => hostRef.current?.mount(id) ?? Promise.resolve(),
      getInstance: () => hostRef.current?.state.instance,
      openPluginSettings,
      closePluginSettings,
      pluginCfg,
      external: {
        ...extPolicy,
        setRefreshHandler: (fn: (() => void) | null) => { refreshExternalUIRef.current = fn; },
        rescanAll: rescanAllPlugins,
        scanPlugin: scanPluginExternal,
      },
      theme: { ...themeApi },
    };
  }, [
    plugins, pushToast, removePlugin, openPluginSettings, closePluginSettings,
    scanPluginExternal, rescanAllPlugins,
  ]);

  const activePlugin = useMemo(
    () => plugins.find((p) => p.id === activeId) ?? null,
    [plugins, activeId],
  );

  return (
    <div id="app">
      <Titlebar
        title={title}
        onWin={handleWin}
        onToast={pushToast}
        onNavigate={handleNavigate}
        onEmit={handleEmit}
        closeAction={closeAction}
      />
      <div id="body" className={sidebarOpen ? 'open' : ''}>
        <Sidebar
          open={sidebarOpen}
          plugins={plugins}
          activeId={activeId}
          badges={badges}
          onToggle={() =>
            setSidebarOpen((v) => {
              localStorage.setItem(KEY_SIDEBAR_OPEN, !v ? '1' : '0');
              return !v;
            })
          }
          onSelect={setActiveId}
          onAdd={() => setDialogOpen(true)}
          injected={injected}
          onInjected={handleInjected}
        />
        <Stage
          ref={stageRef}
          /* 标题 / 副标题**只认宿主上报的那一份**（onTitle / onSubtitle）。
             不要在这里拿 activePlugin 重算 —— 那是同一件事的第二个真相源：
             插件用 ctx.shell.title('…') 改名后，宿主会上报新值，
             而重算出来的永远是 manifest.name，插件栏**不会跟着变**
             （原生版 shell.js 的 onTitle 同时写 #bar-title 与 #tb-title，
             两处同源；React 版此前只有标题栏同源，插件栏是另算的）。
             subtitle 更彻底：上报的值此前根本没被读过（第二真相源把它顶掉了）。 */
          title={title}
          subtitle={subtitle}
          hasPlugin={!!activePlugin}
          onOpenSettings={openPluginSettings}
          onReload={reload}
        />
      </div>
      <Toasts items={toasts} />
      {settingsOpen && activePlugin ? (
        <PluginSettingsDrawer
          manifest={activePlugin}
          onClose={closePluginSettings}
          mountSettings={mountSettings}
          onReload={reload}
          /* 插件是否提供了自己的设置面板。没有就**不能**调 mountSettings：
             SDK 的 settingsFn 缺省会回退 mainFn，抽屉里会显示插件主界面。 */
          hasPluginSettings={hasSettings}
        />
      ) : null}
      {/* plugins 传完整列表（含服务插件）—— 服务不进侧边栏，
          只能在这个面板里看到与管理，所以不能传过滤后的 setPlugins。 */}
      {dialogOpen && (
        <AddPluginDialog
          onClose={() => setDialogOpen(false)}
          onSubmit={addPlugin}
          plugins={hostRef.current?.state.plugins ?? []}
          onRemove={(id) => { removePlugin(id); setDialogOpen(false); }}
        />
      )}
    </div>
  );
}
