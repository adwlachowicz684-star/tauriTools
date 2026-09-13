import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createHost, loadRegistry, filterByRuntime, saveCustomPlugins, getCustomPlugins, isInsideTauri,
  type Host, type PluginManifest, type SidebarItem,
} from '../js/host.js';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import Stage from './components/Stage';
import Toasts, { type ToastItem } from './components/Toasts';
import AddPluginDialog from './components/AddPluginDialog';
import PluginSettingsDrawer from './components/PluginSettingsDrawer';
import * as extPolicy from '../js/external-policy.js';
import * as pluginCfg from '../js/plugin-config.js';

export default function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<Host | null>(null);

  const [plugins, setPlugins] = useState<PluginManifest[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [badges, setBadges] = useState<Record<string, number>>({});
  const [injected, setInjected] = useState<SidebarItem[]>([]);
  const [title, setTitle] = useState('未选择插件');
  const [subtitle, setSubtitle] = useState('');
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [hasPluginSettings, setHasPluginSettings] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const pushToast = useCallback((msg: string, type: 'info' | 'ok' | 'err' = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, msg, type }]);
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
        onSidebarItems: (items: SidebarItem[]) => setInjected(items),
        onOpen: (id) => setActiveId(id),
        onSettingsAvailable: (has) => {
          setHasPluginSettings(has);
          if (!has) setSettingsOpen(false);
        },
        // 焦点在 iframe 插件里时，主窗口收不到按键，由插件转发回来
        onShellShortcut: (combo) => runShellCommand(combo),
        // 插件内部被 CSP 拦下的外链（跨文档事件外壳收不到）
        onCspViolation: (d: { blockedURI: string; directive: string }, manifest?: PluginManifest) => {
          const host = extPolicy.hostOf(d.blockedURI);
          if (!host) return;
          const decision = extPolicy.decideHost(host);
          if (decision === 'allow') return;
          extPolicy.recordHosts([{ host, kind: 'unknown', sample: d.blockedURI }], manifest?.id);
          if (decision === 'ask') {
            pushToast(`插件想访问 ${host}，已拦下 · 设置里可放行`, 'err');
          }
        },
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

  /* ---------- 快捷键 ----------
     命令表抽出来，好让 iframe 插件转发回来的按键走同一套逻辑
     （焦点在沙箱里时主窗口收不到 keydown）。 */
  const runShellCommand = useCallback((combo: string) => {
    switch (String(combo).toLowerCase()) {
      case 'mod+b':
        setSidebarOpen((v) => {
          localStorage.setItem('nexus:sidebar-open', !v ? '1' : '0');
          return !v;
        });
        break;
      case 'mod+r':
        setReloadKey((n) => n + 1);
        break;
      case 'mod+,':
        setSettingsOpen((v) => !v);
        break;
    }
  }, []);

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
        runShellCommand('mod+r');
      }
      if (e.key === ',' && hasPluginSettings) {
        e.preventDefault();
        runShellCommand('mod+,');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeId, hasPluginSettings, runShellCommand]);

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
      // 设置插件（沙箱）通过 parent.__NEXUS__.external 拿到外链能力
      external: {
        ...extPolicy,
        setRefreshHandler: () => {},
        rescanAll: async () => {
          let total = 0;
          for (const p of plugins) {
            const r = await extPolicy.scanEntry(p.entry, p.id).catch(() => ({ hosts: [] }));
            total += r.hosts?.length || 0;
          }
          pushToast(`已检查 ${plugins.length} 个插件，登记 ${total} 个外链`, 'ok');
        },
        scanPlugin: async (p: { entry: string; id: string; name?: string }) =>
          extPolicy.scanEntry(p.entry, p.id),
      },
      pluginCfg,
    };
  }, [plugins, pushToast, removePlugin]);

  const activePlugin = useMemo(
    () => plugins.find((p) => p.id === activeId) ?? null,
    [plugins, activeId],
  );

  /** 点击插件注入的侧边栏条目：插件没挂载就先切过去，再发事件 */
  const handleInjected = async (it: SidebarItem) => {
    const host = hostRef.current;
    if (!host) return;
    if (host.state.activeId !== it.pluginId) {
      setActiveId(it.pluginId);
      await new Promise((r) => setTimeout(r, 150));
    }
    host.bus.emit(it.event, { id: it.id });
  };

  return (
    <div id="app">
      <Titlebar
        title={title}
        onWin={(a) => hostRef.current?.win(a)}
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
          hasSettings={hasPluginSettings}
          onOpenSettings={() => setSettingsOpen(true)}
          onReload={reload}
        />
      </div>
      <Toasts items={toasts} />
      {dialogOpen && <AddPluginDialog onClose={() => setDialogOpen(false)} onSubmit={addPlugin} />}
      {settingsOpen && activePlugin && hostRef.current && (
        <PluginSettingsDrawer
          manifest={activePlugin}
          onClose={() => setSettingsOpen(false)}
          mountSettings={(c, m) => hostRef.current!.mountSettings(c, m)}
        />
      )}
    </div>
  );
}
