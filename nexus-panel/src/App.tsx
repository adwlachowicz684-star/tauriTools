import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createHost, loadRegistry, filterByRuntime, visiblePlugins, saveCustomPlugins, getCustomPlugins, isInsideTauri,
  type Host, type PluginManifest,
} from '../js/host.js';
import * as extPolicy from '../js/external-policy.js';
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
import { installInspector, toggleInspector, isInspectorOn } from '../js/inspector.js';

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

/** 从 CSP 指令反推外链类型，与 js/shell.js 的 kindOf() 保持一致 */
function kindOfDirective(directive?: string): string {
  const s = String(directive || '').toLowerCase();
  if (s.includes('script')) return 'script';
  if (s.includes('frame')) return 'frame';
  if (s.includes('media')) return 'media';
  if (s.includes('img')) return 'image';
  if (s.includes('connect')) return 'fetch';
  if (s.includes('style') || s.includes('font')) return 'style';
  return 'unknown';
}

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
    // 落到 ToastItem 前收窄到它认的三种，避免把未知值塞进样式类名
    const kind: ToastItem['type'] = type === 'ok' || type === 'err' ? type : 'info';
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

  /* ---------- 外链：被 CSP 拦下的请求统一登记 ---------- */
  const handleCspViolation = useCallback((d: ViolationInfo, manifest?: PluginManifest) => {
    const uri = d?.blockedURI || d?.sample || (d?.host ? `https://${d.host}` : '');
    const host = extPolicy.hostOf(uri);
    if (!host || extPolicy.LOCAL_HOSTS.has(host)) return;

    const policy = extPolicy.loadPolicy();
    const decision = extPolicy.decideHost(host, policy);
    if (decision === 'allow') return;               // 用户已信任（说明 CSP 还没配上）

    extPolicy.recordHosts([{
      host,
      kind: d?.kind || kindOfDirective(d?.directive),
      sample: uri,
    }], manifest?.id);

    if (decision === 'ask' && policy.mode === 'smart') {
      pushToast(`插件「${manifest?.name || ''}」想访问 ${host}，已拦下 · 设置里可放行`, 'err');
    } else if (decision === 'block') {
      console.warn('[external] 已拦截', host);
    }
    refreshExternalUIRef.current?.();
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
  const [inspecting, setInspecting] = useState(isInspectorOn());
  useEffect(() => {
    const un = installInspector();
    return un;
  }, []);
  useEffect(() => {
    const h = () => setInspecting(isInspectorOn());
    document.addEventListener('nexus:inspector-toggle', h);
    return () => document.removeEventListener('nexus:inspector-toggle', h);
  }, []);

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
      },
    });
    hostRef.current = host;

    (async () => {
      const list = filterByRuntime(await loadRegistry());
      host.state.plugins = list;          // 宿主持有完整列表（服务插件也要挂）
      setPlugins(visiblePlugins(list));   // 侧边栏只显示非服务插件

      const saved = localStorage.getItem('nexus:sidebar-open');
      setSidebarOpen(saved === null ? true : saved === '1');
      const accent = localStorage.getItem('nexus:accent');
      if (accent) document.documentElement.style.setProperty('--accent', accent);

      const last = localStorage.getItem('nexus:last-plugin');
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
    localStorage.setItem('nexus:last-plugin', activeId);
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

  const addPlugin = useCallback((p: Omit<PluginManifest, 'id'>) => {
    const item: PluginManifest = { ...p, id: `custom-${nextId()}`, custom: true };
    saveCustomPlugins([...getCustomPlugins(), item]);
    pushToast(`已添加「${item.name}」`, 'ok');
    setDialogOpen(false);
    (async () => {
      hostRef.current!.state.plugins = filterByRuntime(await loadRegistry());
      setPlugins(visiblePlugins(hostRef.current!.state.plugins));
      setActiveId(item.id);
    })();
  }, [pushToast]);

  const removePlugin = useCallback((id: string) => {
    hostRef.current?.removePlugin(id);
    pushToast('已移除插件', 'ok');
    (async () => {
      hostRef.current!.state.plugins = filterByRuntime(await loadRegistry());
      setPlugins(visiblePlugins(hostRef.current!.state.plugins));
      setActiveId('home');
    })();
  }, [pushToast]);

  /* ---------- 插件设置抽屉 ---------- */
  const closePluginSettings = useCallback(() => setSettingsOpen(false), []);

  /* 「⚙ 设置」对每个插件都显示，不再要求插件自带设置面板 ——
     抽屉里除了插件自定义设置，还有外壳固定提供的沙箱 / 主题适配开关，
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
          localStorage.setItem('nexus:sidebar-open', !v ? '1' : '0');
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
              localStorage.setItem('nexus:sidebar-open', !v ? '1' : '0');
              return !v;
            })
          }
          onSelect={setActiveId}
          onAdd={() => setDialogOpen(true)}
          onInspect={() => setInspecting(toggleInspector())}
          inspecting={inspecting}
          injected={injected}
          onInjected={handleInjected}
        />
        <Stage
          ref={stageRef}
          title={activePlugin?.name ?? '未选择插件'}
          subtitle={activePlugin
            ? `${activePlugin.type === 'iframe' ? '沙箱模式' : '同页模式'}${activePlugin.version ? ' · v' + activePlugin.version : ''}`
            : ''}
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
