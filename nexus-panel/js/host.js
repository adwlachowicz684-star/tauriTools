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
  };

  const bus = createBus();

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
    await safeTeardown(inst);
  }

  async function safeTeardown(inst) {
    if (!inst) return;
    try { await inst.ctx?.__destroy?.(); } catch (e) { console.error(e); }
    try { await inst.unmount?.(); } catch (e) { console.error('[unmount]', e); }
    if (inst.iframe) {
      try { window.removeEventListener('message', inst.bridgeHandler); } catch {}
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
            // 主动回发 init（含 manifest/主题），再发 mount。
            // postMessage 按序送达：iframe 先处理 init（ctx 就绪），随后 mount 才能挂载。
            send(iframe, { type: 'init', manifest, theme: exportVars() });
            send(iframe, { type: 'mount' });
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
            cleanupFns.push(bus.on(d.event, (payload) => send(iframe, { type: 'event', event: d.event, payload })));
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
