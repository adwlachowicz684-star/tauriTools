/**
 * 插件宿主引擎（与 UI 框架无关）
 * ------------------------------------------------------------
 * 原生外壳（js/shell.js）与 React 外壳（src/App.tsx）共用这一份引擎，
 * 保证两种技术栈下插件行为完全一致。
 */

import { getTauri, isInsideTauri } from './tauri-core.js';
import { createModuleContext, BRIDGE_CHANNEL } from './plugin-sdk.js';
import { installAdapter } from './theme-normalizer.js';
import {
  initTheme, exportVars, onChange as onThemeChange,
} from './theme-manager.js';

export const THEME_VARS = [
  '--bg', '--surface', '--surface-sunk', '--sh-dark', '--sh-light',
  '--text', '--text-dim', '--text-mute', '--accent', '--accent-2',
  '--accent-glow', '--warn', '--danger', '--r-xl', '--r-lg', '--r', '--r-sm',
];

export function isNoBuild() {
  return globalThis.__NEXUS_NO_BUILD__ === true;
}

/* ---------------------------- 事件总线 ---------------------------- */
export function createBus() {
  const map = new Map();
  return {
    on(event, handler) {
      if (!map.has(event)) map.set(event, new Set());
      map.get(event).add(handler);
      return () => map.get(event)?.delete(handler);
    },
    emit(event, payload) {
      map.get(event)?.forEach((fn) => {
        try { fn(payload); } catch (e) { console.error('[bus]', event, e); }
      });
    },
  };
}

/* ---------------------------- 注册表 ---------------------------- */
export async function loadRegistry() {
  let list = [];
  try {
    const mod = await import(new URL('../plugins/registry.js', import.meta.url).href);
    list = mod.plugins || [];
  } catch (e) {
    console.warn('[registry] registry.js 加载失败', e);
  }
  if (!list.length) {
    try {
      const res = await fetch(new URL('../plugins/registry.json', import.meta.url) /* @vite-ignore */ .href);
      list = (await res.json()).plugins || [];
    } catch { /* ignore */ }
  }
  try {
    const custom = JSON.parse(localStorage.getItem('nexus:custom-plugins') || '[]');
    const ids = new Set(list.map((p) => p.id));
    list = list.concat(custom.filter((p) => !ids.has(p.id)));
  } catch { /* ignore */ }
  return list;
}

export function getCustomPlugins() {
  try { return JSON.parse(localStorage.getItem('nexus:custom-plugins') || '[]'); } catch { return []; }
}
export function saveCustomPlugins(list) {
  localStorage.setItem('nexus:custom-plugins', JSON.stringify(list));
}

/* ---------------------------- 宿主 ---------------------------- */
export function createHost(opts = {}) {
  /** @type {() => HTMLElement|null} */
  const getStage = opts.getStage || (() => null);
  const hooks = opts.hooks || {};

  const state = {
    plugins: [],
    activeId: null,
    instance: null,   // { manifest, ctx, unmount, iframe, bridgeHandler, cleanupFns }
    mounting: null,
    badges: {},
    /** accel → { pluginId, event, label }（插件注册的快捷键） */
    shortcuts: {},
    /** 插件注入的侧边栏条目 { id, pluginId, label, icon, event } */
    sidebarItems: [],
  };

  const bus = createBus();

  /* ---- 插件注册的快捷键 ---- *
   * 说明：这是「应用级」快捷键——窗口在前台时生效，不是操作系统全局热键。
   * 真正的全局热键需要额外的 Tauri 插件（tauri-plugin-global-shortcut），
   * 会引入新依赖；这里选择零依赖方案，代价是窗口失焦时不响应。
   */

  /** 把 'Ctrl+Shift+1' / 'Alt+K' 之类归一成统一比较键。 */
  function normalizeAccel(accel) {
    if (!accel) return '';
    const parts = String(accel).split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const mods = ['ctrl', 'shift', 'alt', 'meta'].filter((m) => parts.includes(m)).sort();
    const key = parts.find((p) => !['ctrl', 'shift', 'alt', 'meta'].includes(p)) || '';
    return [...mods, key].join('+');
  }

  /** 事件对象 → 统一比较键，用于与注册项比对。 */
  function accelFromEvent(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.shiftKey) mods.push('shift');
    if (e.altKey) mods.push('alt');
    if (e.metaKey) mods.push('meta');
    let key = e.key;
    // 单字符按键统一小写；功能键保留原名（如 F5、Escape）
    if (key.length === 1) key = key.toLowerCase();
    else key = key.toLowerCase();
    return [...mods.sort(), key].join('+');
  }

  function registerShortcut(pluginId, accel, event, label = '') {
    const key = normalizeAccel(accel);
    if (!key || !event) return false;
    state.shortcuts[key] = { pluginId, event, label };
    hooks.onShortcuts?.({ ...state.shortcuts });
    return true;
  }

  function unregisterShortcut(accel) {
    const key = normalizeAccel(accel);
    if (!key || !state.shortcuts[key]) return false;
    delete state.shortcuts[key];
    hooks.onShortcuts?.({ ...state.shortcuts });
    return true;
  }

  function addSidebarItem(pluginId, item) {
    if (!item || !item.id) return false;
    state.sidebarItems = state.sidebarItems.filter((x) => !(x.pluginId === pluginId && x.id === item.id));
    state.sidebarItems.push({ ...item, pluginId });
    hooks.onSidebarItems?.(state.sidebarItems.slice());
    return true;
  }

  function removeSidebarItem(pluginId, itemId) {
    const before = state.sidebarItems.length;
    state.sidebarItems = state.sidebarItems.filter((x) => !(x.pluginId === pluginId && x.id === itemId));
    if (state.sidebarItems.length !== before) {
      hooks.onSidebarItems?.(state.sidebarItems.slice());
      return true;
    }
    return false;
  }

  /** 插件卸载时清掉它注册的一切，避免留下点不动的幽灵条目。 */
  function releasePluginRegistrations(pluginId) {
    let changed = false;
    for (const [k, v] of Object.entries(state.shortcuts)) {
      if (v.pluginId === pluginId) { delete state.shortcuts[k]; changed = true; }
    }
    if (changed) hooks.onShortcuts?.({ ...state.shortcuts });
    const before = state.sidebarItems.length;
    state.sidebarItems = state.sidebarItems.filter((x) => x.pluginId !== pluginId);
    if (state.sidebarItems.length !== before) hooks.onSidebarItems?.(state.sidebarItems.slice());
  }

  // 全局 keydown：命中注册项就吃掉事件并发总线事件，插件侧用 ctx.on(event) 接
  const onHostKeydown = (e) => {
    const keys = Object.keys(state.shortcuts);
    if (keys.length === 0) return;
    const hit = state.shortcuts[accelFromEvent(e)];
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();
    bus.emit(hit.event, { accel: accelFromEvent(e), label: hit.label });
  };
  window.addEventListener('keydown', onHostKeydown);

  const setBadge = (id, n) => {
    state.badges[id] = n || 0;
    hooks.onBadges?.({ ...state.badges });
  };

  /* ---- 加载 / 卸载 ---- */
  async function mount(id) {
    const manifest = state.plugins.find((p) => p.id === id);
    await unmount();

    state.activeId = id;
    hooks.onTitle?.(manifest ? manifest.name : '未选择插件');
    hooks.onSubtitle?.(
      manifest
        ? `${manifest.type === 'iframe' ? '沙箱模式' : '同页模式'}${manifest.version ? ' · v' + manifest.version : ''}`
        : '',
    );
    hooks.onActive?.(id);

    const stage = getStage();
    if (!stage) return;

    if (!manifest) {
      stage.innerHTML = `<div class="empty"><div class="empty-mark">◈</div>
        <p>左侧选择一个插件，或点击 ＋ 安装新插件</p></div>`;
      return;
    }

    const token = Symbol(id);
    state.mounting = token;
    stage.innerHTML = `<div class="loader"><div class="spinner"></div>正在加载插件…</div>`;

    const timer = setTimeout(() => {
      if (state.mounting === token) showError(stage, manifest, new Error('插件加载超时（10s）。请检查入口路径是否正确。'));
    }, 10000);

    try {
      const instance = manifest.type === 'iframe'
        ? await mountIframe(stage, manifest, token)
        : await mountModule(stage, manifest, token);

      if (state.mounting !== token) { await safeTeardown(instance); return; }
      state.instance = instance;

      // 主题适配：基调不一致的插件自动反转，与面板统一
      if (instance) {
        instance.adaptInput = {
          manifest, wrap: instance.wrap, target: instance.target,
          root: instance.root, isIframe: manifest.type === 'iframe',
        };
        await reAdapt(instance);
      }
    } catch (err) {
      if (state.mounting === token) showError(stage, manifest, err);
    } finally {
      clearTimeout(timer);
    }
  }

  async function unmount() {
    if (!state.instance) return;
    const inst = state.instance;
    state.instance = null;
    // 先清掉该插件注册的快捷键 / 侧边栏项，否则会留下点了没反应的幽灵条目
    if (inst?.manifest?.id) releasePluginRegistrations(inst.manifest.id);
    await safeTeardown(inst);
  }

  async function safeTeardown(inst) {
    if (!inst) return;
    try { await inst.ctx?.__destroy?.(); } catch (e) { console.error(e); }
    try { await inst.unmount?.(); } catch (e) { console.error('[unmount]', e); }
    if (inst.iframe) {
      try { window.removeEventListener('message', inst.bridgeHandler); } catch {}
      clearBridgeSubs();
      inst.iframe.remove();
    }
    try { inst.wrap?.remove(); } catch {}
    inst.cleanupFns?.forEach((fn) => { try { fn(); } catch {} });
  }

  /* ---- 主题适配：可重复执行（切换主题后要重算） ---- */
  async function reAdapt(inst) {
    if (!inst?.adaptInput) return;
    if (typeof inst.adaptTeardown === 'function') {
      try { await inst.adaptTeardown(); } catch (e) { console.error('[reAdapt]', e); }
      inst.adaptTeardown = null;
    }
    inst.adaptTeardown = await installAdapter(inst.adaptInput);
  }

  /* ---- 模式 A：同页模块插件 ---- */
  async function mountModule(stage, manifest, token) {
    const wrap = document.createElement('div');
    wrap.className = 'plugin-wrap';
    const container = document.createElement('div');
    container.className = 'plugin-root';
    container.dataset.pluginId = manifest.id;
    wrap.appendChild(container);

    let mod;
    try {
      mod = await import(resolveEntry(manifest.entry));
    } catch (err) {
      throw new Error(`无法加载插件入口：${manifest.entry}\n${err?.message || err}`);
    }
    if (state.mounting !== token) return null;

    const def = mod.default || mod.plugin;
    if (!def || typeof def.mount !== 'function') {
      throw new Error(`插件 ${manifest.id} 需要 export default definePlugin({ mount(ctx){...} })`);
    }

    const ctx = createModuleContext({
      manifest, container, bus,
      theme: readTheme(),
      shellHooks: makeShellHooks(manifest),
    });

    stage.innerHTML = '';
    stage.appendChild(wrap);

    const result = await def.mount(ctx);
    return { manifest, ctx, wrap, target: container, root: container,
             unmount: typeof result === 'function' ? result : null, iframe: null };
  }

  /* ---- 模式 B：沙箱 iframe 插件（默认） ---- */
  async function mountIframe(stage, manifest, token) {
    const wrap = document.createElement('div');
    wrap.className = 'plugin-wrap plugin-wrap-frame';
    const iframe = document.createElement('iframe');
    iframe.src = resolveEntry(manifest.entry);
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-modals');
    iframe.style.cssText = 'width:100%;height:100%;border:0;background:transparent;display:block;';
    iframe.dataset.pluginId = manifest.id;
    wrap.appendChild(iframe);

    const cleanupFns = [];
    let bridgeHandler = null;

    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('iframe 插件握手超时（10s）')), 10000);

      bridgeHandler = (e) => {
        const d = e.data;
        if (!d || d.channel !== BRIDGE_CHANNEL) return;
        if (e.source !== iframe.contentWindow) return;

        switch (d.type) {
          case 'ready':
            send(iframe, { type: 'init', manifest, theme: exportVars() });
            break;
          case 'mounted':
            clearTimeout(timeout);
            d.ok ? resolve() : reject(new Error(d.error));
            break;
          case 'error':
            clearTimeout(timeout);
            reject(new Error(d.error));
            break;
          case 'req':
            handleBridgeRequest(manifest, iframe, d);
            break;
          case 'subscribe':
            subscribe(iframe, d.event);
            break;
          case 'unsubscribe':
            unsubscribe(d.event);
            break;
          case 'publish':
            bus.emit(d.event, d.payload);
            break;
          case 'notify':
            makeShellHooks(manifest)?.[d.notifyType]?.(d.payload);
            break;
        }
      };
      window.addEventListener('message', bridgeHandler);
      cleanupFns.push(() => window.removeEventListener('message', bridgeHandler));
    });

    stage.innerHTML = '';
    stage.appendChild(wrap);

    try {
      await ready;
    } catch (err) {
      cleanupFns.forEach((fn) => fn());
      wrap.remove();
      throw err;
    }
    if (state.mounting !== token) { cleanupFns.forEach((fn) => fn()); wrap.remove(); return null; }

    send(iframe, { type: 'mount' });
    await new Promise((r) => setTimeout(r, 60));   // 给插件渲染时间，便于主题采样

    return {
      manifest, wrap, target: iframe, root: null, iframe, bridgeHandler, cleanupFns,
      ctx: { __destroy: async () => cleanupFns.forEach((fn) => fn()) },
      unmount: null,
    };
  }

  function send(iframe, msg) {
    iframe.contentWindow?.postMessage({ channel: BRIDGE_CHANNEL, ...msg }, '*');
  }

  /* ---- 插件事件订阅登记表 ----
   * 必须可退订：插件每次重新订阅都会在宿主侧多留一个监听器，
   * 若退订无人处理，同一事件会被重复投递（表现为"按一次快捷键执行了两次"）。
   * 同一事件允许多个订阅，退订时按后进先出逐个移除。
   */
  const bridgeSubs = new Map();   // event → Array<() => void>

  function subscribe(iframe, event) {
    const off = bus.on(event, (payload) => send(iframe, { type: 'event', event, payload }));
    const arr = bridgeSubs.get(event) || [];
    arr.push(off);
    bridgeSubs.set(event, arr);
  }

  /** 插件卸载时清空登记表，避免残留指向已销毁 iframe 的监听器。 */
  function clearBridgeSubs() {
    for (const arr of bridgeSubs.values()) {
      for (const off of arr) { try { off(); } catch { /* 已失效 */ } }
    }
    bridgeSubs.clear();
  }

  function unsubscribe(event) {
    const arr = bridgeSubs.get(event);
    if (!arr || arr.length === 0) return;
    const off = arr.pop();
    try { off?.(); } catch { /* 已失效 */ }
    if (arr.length === 0) bridgeSubs.delete(event);
  }

  /** iframe 插件的桥接服务端：转发 invoke / store 等请求 */
  async function handleBridgeRequest(manifest, iframe, d) {
    const reply = (ok, data, error) => send(iframe, { type: 'res', id: d.id, ok, data, error });
    try {
      const { method, payload } = d;
      switch (method) {
        case 'invoke': {
          const tauri = await getTauri();
          if (!tauri) throw new Error('当前不在 Tauri 环境中');
          return reply(true, await tauri.invoke(payload.cmd, payload.args));
        }
        case 'listen':
          return reply(false, null, 'iframe 模式不支持 listenTauri，请使用 ctx.on / ctx.emit');
        case 'store.get': {
          const raw = localStorage.getItem(`nexus:${manifest.id}:${payload.k}`);
          return reply(true, raw == null ? payload.def : JSON.parse(raw));
        }
        case 'store.set':
          localStorage.setItem(`nexus:${manifest.id}:${payload.k}`, JSON.stringify(payload.v));
          return reply(true, true);
        case 'store.del':
          localStorage.removeItem(`nexus:${manifest.id}:${payload.k}`);
          return reply(true, true);
        case 'store.all': {
          const out = {}, pre = `nexus:${manifest.id}:`;
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith(pre)) out[k.slice(pre.length)] = JSON.parse(localStorage.getItem(k));
          }
          return reply(true, out);
        }
        default:
          return reply(false, null, '未知桥接方法: ' + method);
      }
    } catch (err) {
      reply(false, null, String(err?.message || err));
    }
  }

  /* ---- 插件可调用的外壳能力 ---- */
  function makeShellHooks(manifest) {
    return {
      title: ({ text }) => hooks.onTitle?.(text),
      badge: ({ n }) => setBadge(manifest.id, n),
      toast: ({ msg, type }) => hooks.toast?.(msg, type),
      reload: () => mount(manifest.id),
      open: ({ id }) => hooks.onOpen?.(id) ?? navigateHook(id),
      'shortcut.register': ({ accel, event, label }) =>
        registerShortcut(manifest.id, accel, event, label),
      'shortcut.unregister': ({ accel }) => unregisterShortcut(accel),
      'sidebar.add': ({ item }) => addSidebarItem(manifest.id, item),
      'sidebar.remove': ({ itemId }) => removeSidebarItem(manifest.id, itemId),
    };
  }
  const navigateHook = (id) => hooks.onNavigate?.(id);

  /* ---- 错误边界 ---- */
  function showError(stage, manifest, err) {
    const msg = String(err?.stack || err?.message || err);
    console.error(`[plugin:${manifest?.id}]`, err);
    stage.innerHTML = `
      <div class="err-box">
        <h3>⚠ 插件「${manifest?.name || manifest?.id}」加载失败</h3>
        <pre>${escapeHtml(msg)}</pre>
        <div class="row">
          <button class="p-btn primary" id="err-retry">重试</button>
          <button class="p-btn" id="err-back">返回概览</button>
        </div>
      </div>`;
    stage.querySelector('#err-retry').onclick = () => mount(manifest.id);
    stage.querySelector('#err-back').onclick = () => hooks.onOpen?.('home') ?? mount('home');
  }

  /* ---- 窗口控制 ---- */
  async function win(action) {
    const tauri = await getTauri();
    if (!tauri) { hooks.toast?.('浏览器调试模式：窗口控制不可用', 'err'); return; }
    try { await tauri.invoke('window_action', { action }); }
    catch (e) { hooks.toast?.('窗口控制失败：' + e, 'err'); }
  }

  // 主题：初始化并联动（iframe 推送新变量，无需重载；适配结果重算）
  initTheme();
  onThemeChange(async () => {
    const inst = state.instance;
    if (!inst) return;
    if (inst.iframe) {
      try {
        inst.iframe.contentWindow?.postMessage(
          { channel: BRIDGE_CHANNEL, type: 'theme', theme: exportVars() }, '*');
      } catch { /* 跨域时忽略 */ }
    }
    await reAdapt(inst);
  });

  return {
    state, bus, mount, unmount, win, setBadge,
    readTheme,
    registerShortcut, unregisterShortcut,
    addSidebarItem, removeSidebarItem, releasePluginRegistrations,
    getShortcuts: () => ({ ...state.shortcuts }),
    getSidebarItems: () => state.sidebarItems.slice(),
    getPlugins: () => state.plugins,
    async refresh() {
      state.plugins = filterByRuntime(await loadRegistry());
      return state.plugins;
    },
    removePlugin(id) {
      saveCustomPlugins(getCustomPlugins().filter((p) => p.id !== id));
    },
  };
}

/* ---------------------------- 工具 ---------------------------- */
export function resolveEntry(entry) {
  return new URL(entry, location.href).href;
}
export function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const out = {};
  for (const v of THEME_VARS) out[v] = cs.getPropertyValue(v).trim();
  return out;
}
export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 无构建模式下过滤掉需要编译器的插件（React/TSX） */
export function filterByRuntime(plugins) {
  return isNoBuild() ? plugins.filter((p) => !p.requiresBuild) : plugins;
}

export { isInsideTauri };
