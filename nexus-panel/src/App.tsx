import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createHost, loadRegistry, filterByRuntime, saveCustomPlugins, getCustomPlugins, isInsideTauri,
  type Host, type PluginManifest,
} from '../js/host.js';
// 主题切换统一由 js/theme-picker.js 的弹出层处理（标题栏按钮 + 设置页共用），
// 外壳不再自己维护"当前主题名"状态，避免两处各存一份、切完不同步。
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import Stage from './components/Stage';
import Toasts, { type ToastItem } from './components/Toasts';
import AddPluginDialog from './components/AddPluginDialog';

export default function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<Host | null>(null);

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

  const pushToast = useCallback((msg: string, type: string = 'info') => {
    const id = Date.now() + Math.random();
    // 对外接受任意字符串（外壳的 ctx.toast 也传字符串），
    // 落到 ToastItem 前收窄到它认的三种，避免把未知值塞进样式类名
    const kind: ToastItem['type'] = type === 'ok' || type === 'err' ? type : 'info';
    setToasts((t) => [...t, { id, msg, type: kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800);
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
      },
    });
    hostRef.current = host;

    (async () => {
      const list = filterByRuntime(await loadRegistry());
      host.state.plugins = list;
      setPlugins(list);

      const saved = localStorage.getItem('nexus:sidebar-open');
      setSidebarOpen(saved === null ? true : saved === '1');
      const accent = localStorage.getItem('nexus:accent');
      if (accent) document.documentElement.style.setProperty('--accent', accent);

      const last = localStorage.getItem('nexus:last-plugin');
      const initial = last && list.some((p) => p.id === last) ? last : list[0]?.id ?? null;
      setActiveId(initial);
    })();

    return () => { host.unmount(); };
  }, [pushToast]);

  /* ---------- 切换 / 重载插件 ---------- */
  useEffect(() => {
    if (!activeId) return;
    localStorage.setItem('nexus:last-plugin', activeId);
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
      await new Promise((r) => setTimeout(r, 150));   // 等插件挂载并订阅事件
    }
    host.bus.emit(it.event, { id: it.id });
  };

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
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeId]);

  /* ---------- 供插件与调试使用 ---------- */
  useEffect(() => {
    if (!isInsideTauri()) pushToast('浏览器调试模式：Rust 命令不可用（⌘/Ctrl+R 可重载插件）', 'err');
  }, [pushToast]);


  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  const addPlugin = useCallback((p: Omit<PluginManifest, 'id'>) => {
    const item: PluginManifest = { ...p, id: 'custom-' + Date.now().toString(36), custom: true };
    saveCustomPlugins([...getCustomPlugins(), item]);
    pushToast(`已添加「${item.name}」`, 'ok');
    setDialogOpen(false);
    (async () => {
      hostRef.current!.state.plugins = filterByRuntime(await loadRegistry());
      setPlugins([...hostRef.current!.state.plugins]);
      setActiveId(item.id);
    })();
  }, [pushToast]);

  const removePlugin = useCallback((id: string) => {
    hostRef.current?.removePlugin(id);
    pushToast('已移除插件', 'ok');
    (async () => {
      hostRef.current!.state.plugins = filterByRuntime(await loadRegistry());
      setPlugins([...hostRef.current!.state.plugins]);
      setActiveId('home');
    })();
  }, [pushToast]);

  /* ---------- 供插件调用的全局接口 ---------- */
  useEffect(() => {
    window.__NEXUS__ = {
      state: hostRef.current?.state,
      bus: hostRef.current?.bus,
      toast: pushToast,
      navigate: (id: string) => setActiveId(id),
      removePlugin,
      getPlugins: () => plugins,
    };
  }, [plugins, pushToast, removePlugin]);

  const activePlugin = useMemo(
    () => plugins.find((p) => p.id === activeId) ?? null,
    [plugins, activeId],
  );

  return (
    <div id="app">
      <Titlebar
        title={title}
        onWin={(a) => hostRef.current?.win(a)}
        onToast={pushToast}
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
          injected={injected}
          onInjected={handleInjected}
        />
        <Stage
          ref={stageRef}
          title={activePlugin?.name ?? '未选择插件'}
          subtitle={activePlugin
            ? `${activePlugin.type === 'iframe' ? '沙箱模式' : '同页模式'}${activePlugin.version ? ' · v' + activePlugin.version : ''}`
            : ''}
          onReload={reload}
        />
      </div>
      <Toasts items={toasts} />
      {dialogOpen && <AddPluginDialog onClose={() => setDialogOpen(false)} onSubmit={addPlugin} />}
    </div>
  );
}
