/**
 * 插件宿主引擎（与 UI 框架无关）
 * ------------------------------------------------------------
 * 原生外壳（js/shell.js）与 React 外壳（src/App.tsx）共用这一份引擎，
 * 保证两种技术栈下插件行为完全一致。
 */

import { getTauri, isInsideTauri } from './tauri-core.js';
import { createModuleContext, BRIDGE_CHANNEL } from './plugin-sdk.js';
import { installAdapter } from './theme-normalizer.js';
import { getPluginConfig } from './plugin-config.js';
import * as pluginConfig from './plugin-config.js';
import * as extPolicy from './external-policy.js';
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
    const mod = await import(/* @vite-ignore */ new URL('../plugins/registry.js', import.meta.url).href);
    list = mod.plugins || [];
  } catch (e) {
    console.warn('[registry] registry.js 加载失败', e);
  }
  if (!list.length) {
    // 这里原本有一段 registry.json 的兜底：fetch 一个 json 再读 plugins。
    // 但仓库里从来没有 registry.json（只有 registry.js），所以那条路径
    // 从未成功过 —— 平时是死代码，真出问题时又必然一起失败，
    // 还会让构建多一条 "doesn't exist at build time" 的警告。
    // 删掉它，改由下面的控制台输出把失败暴露出来。
    console.error('[registry] registry.js 未能提供插件列表，面板将没有插件可显示');
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
    shortcutsPaused: false,   // 模态（如插件设置抽屉）打开时暂停插件快捷键
  };

  /** 同页插件快捷键的激活判定：必须是当前插件，且没有被模态遮挡 */
  const isPluginActive = (id) => () =>
    state.activeId === id && !state.shortcutsPaused;

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
        ? await mountIframeView(stage, manifest, token, 'main')
        : await mountModule(stage, manifest, token);

      if (state.mounting !== token) { await safeTeardown(instance); return; }
      state.instance = instance;

      // 主题适配：基调不一致的插件自动反转，与面板统一。
      // 插件设置里关掉「主题适配」则完全不动它的外观。
      if (instance && getPluginConfig(manifest.id).adaptTheme) {
        instance.adaptInput = {
          manifest, wrap: instance.wrap, target: instance.target,
          root: instance.root, isIframe: manifest.type === 'iframe',
        };
        await reAdapt(instance);
      } else if (instance) {
        hooks.onAdaptInfo?.({ adapted: false, reason: 'adapt-disabled' });
      }

      // 告诉外壳：这个插件有没有自己的设置面板（决定要不要显示「⚙ 设置」）
      hooks.onSettingsAvailable?.(instance ? hasSettings(instance) : false);
    } catch (err) {
      if (state.mounting === token) showError(stage, manifest, err);
      hooks.onSettingsAvailable?.(false);
    } finally {
      clearTimeout(timer);
    }
  }

  /** 暂停/恢复插件快捷键，返回恢复函数 */
  function pauseShortcuts(v) {
    const prev = state.shortcutsPaused;
    state.shortcutsPaused = v;
    return () => { state.shortcutsPaused = prev; };
  }

  /** 插件是否声明了设置面板 */
  function hasSettings(inst) {
    if (!inst) return false;
    return inst.manifest?.type === 'iframe'
      ? !!inst.hasSettings
      : typeof inst.def?.settings === 'function';
  }

  async function unmount() {
    if (!state.instance) return;
    const inst = state.instance;
    state.instance = null;
    hooks.onSettingsAvailable?.(false);
    await safeTeardown(inst);
  }

  /* ---- 插件自己的设置面板 ----
     给定一个容器，把插件的 settings 视图挂进去，返回 teardown。
     两种模式都支持：
       · module —— 新开一个 ctx（共享事件总线 / store / 外壳能力），调用 def.settings(ctx)
       · iframe —— 新开一个 iframe，init 时带 view='settings'，SDK 自动走 settingsFn
     容器与抽屉 DOM 由外壳负责创建销毁，引擎只管挂载。 */
  async function mountSettings(container, manifestArg) {
    const manifest = manifestArg || state.plugins.find((p) => p.id === state.activeId);
    if (!manifest) throw new Error('当前没有正在运行的插件');
    if (!container) throw new Error('缺少设置面板容器');

    if (manifest.type === 'iframe') {
      const inst = await mountIframeView(container, manifest, null, 'settings');
      inst.adaptInput = {
        manifest, wrap: inst.wrap, target: inst.target,
        root: null, isIframe: true,
      };
      await reAdapt(inst);
      // 焦点在这个沙箱里，天然隔离；主视图（另一个 iframe 或主文档）收不到事件
      try { inst.iframe?.contentWindow?.focus(); } catch {}
      return async () => {
        try {
          if (typeof inst.adaptTeardown === 'function') await inst.adaptTeardown();
          await inst.ctx?.__destroy?.();
          inst.wrap?.remove();
        } catch (e) { console.error('[settings teardown]', e); }
      };
    }

    // module：动态 import 命中浏览器缓存，拿到的是同一个模块对象
    const mod = await import(/* @vite-ignore */ resolveEntry(manifest.entry));
    const def = mod.default || mod.plugin;
    if (typeof def?.settings !== 'function') {
      throw new Error(`插件「${manifest.name}」没有提供设置面板`);
    }

    const el = document.createElement('div');
    el.className = 'plugin-root';
    el.dataset.pluginId = manifest.id;
    container.appendChild(el);

    // 设置面板打开期间：主视图快捷键暂停，面板自己的快捷键生效
    const pause = pauseShortcuts(true);
    const ctx = createModuleContext({
      manifest, container: el, bus,
      theme: readTheme(),
      shellHooks: makeShellHooks(manifest),
      isActive: () => state.shortcutsPaused === true,
    });

    const result = await def.settings(ctx);
    return async () => {
      try {
        pause();                       // 恢复主视图快捷键
        await ctx.__destroy?.();
        if (typeof result === 'function') result();
        el.remove();
      } catch (e) { console.error('[settings teardown]', e); }
    };
  }

  async function safeTeardown(inst) {
    if (!inst) return;
    // 清掉该插件注册的应用级快捷键与注入的侧边栏条目，避免残留
    try { clearAppShortcuts(inst.manifest?.id); clearSidebarItems(inst.manifest?.id); } catch {}
    try { await inst.ctx?.__destroy?.(); } catch (e) { console.error(e); }
    try { await inst.unmount?.(); } catch (e) { console.error('[unmount]', e); }
    if (inst.iframe) {
      try { window.removeEventListener('message', inst.bridgeHandler); } catch {}
      inst.iframe.remove();
    }
    try { inst.wrap?.remove(); } catch {}
    inst.cleanupFns?.forEach((fn) => { try { fn(); } catch {} });
  }

  /* ---- 主题适配：可重复执行（切换主题后要重算） ----
     注意 installAdapter 内部有 sleep 采样（约几百毫秒），期间用户可能又切了主题或插件。
     没有并发保护的话，两次 installAdapter 会各自往 wrap 里塞一张色调覆盖层，
     而 adaptTeardown 只留最后一张 → 前面的永远清不掉、滤镜层层叠加。
     用 generation 令牌保证：只有最后一次调用的结果会被采纳。 */
  async function reAdapt(inst) {
    if (!inst?.adaptInput) return;
    const gen = (inst.adaptGen || 0) + 1;
    inst.adaptGen = gen;

    if (typeof inst.adaptTeardown === 'function') {
      try { await inst.adaptTeardown(); } catch (e) { console.error('[reAdapt]', e); }
      inst.adaptTeardown = null;
    }

    const td = await installAdapter(inst.adaptInput);

    // 期间又被触发过（或实例已被卸载/换掉）→ 丢弃这次的结果
    if (inst.adaptGen !== gen) {
      try { td?.(); } catch { /* 忽略 */ }
      return;
    }
    // 容器已经不在文档里（插件被切走了）→ 同样丢弃
    if (inst.wrap && !inst.wrap.isConnected) {
      try { td?.(); } catch { /* 忽略 */ }
      return;
    }
    inst.adaptTeardown = td;
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
      mod = await import(/* @vite-ignore */ resolveEntry(manifest.entry));
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
      isActive: isPluginActive(manifest.id),   // 快捷键只在自己激活时生效
    });

    stage.innerHTML = '';
    stage.appendChild(wrap);

    const result = await def.mount(ctx);
    return { manifest, def, ctx, wrap, target: container, root: container,
             unmount: typeof result === 'function' ? result : null, iframe: null };
  }

  /* ---- 模式 B：沙箱 iframe 插件（默认） ----
     view='main' 主视图；view='settings' 渲染插件自己的设置面板
     （设置面板复用同一个入口页面，只是 init 时告知 SDK 走 settings 分支） */
  async function mountIframeView(hostEl, manifest, token, view = 'main') {
    const wrap = document.createElement('div');
    wrap.className = 'plugin-wrap plugin-wrap-frame';
    const iframe = document.createElement('iframe');
    iframe.src = resolveEntry(manifest.entry);

    /* 沙箱属性由插件设置里的「功能隔离」决定：
         关闭（默认）—— 带 allow-same-origin，插件与外壳同源，可直连，无需桥接
         开启      —— 去掉它，插件碰不到 parent/localStorage/Tauri IPC，全走桥接
       两种模式下 ctx.* API 完全一致，插件代码不用改。 */
    const { isolated, adaptTheme } = getPluginConfig(manifest.id);
    iframe.setAttribute(
      'sandbox',
      isolated
        ? 'allow-scripts allow-forms allow-modals'
        : 'allow-scripts allow-same-origin allow-forms allow-modals',
    );
    iframe.dataset.isolated = isolated ? '1' : '0';
    iframe.className = 'plugin-frame';
    iframe.dataset.pluginId = manifest.id;
    wrap.appendChild(iframe);

    const cleanupFns = [];
    let bridgeHandler = null;
    let hasSettings = false;
    // 握手阶段就要写 reportedBase，此时完整实例还没构造出来，先放一个可变壳
    const inst0 = {};

    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('iframe 插件握手超时（10s）')), 10000);

      bridgeHandler = (e) => {
        const d = e.data;
        if (!d || d.channel !== BRIDGE_CHANNEL) return;
        if (e.source !== iframe.contentWindow) return;

        switch (d.type) {
          case 'ready':
            hasSettings = !!d.hasSettings;      // 插件上报：是否提供了设置面板
            send(iframe, {
              type: 'init', manifest, theme: exportVars(), view,
              isolated,                         // 插件据此决定能力探测方式
              reportBase: isolated && adaptTheme,  // 隔离且要适配 → 让插件自报基调
            });
            break;
          // 隔离插件无法被外壳穿透采样，由它自己采样后上报基调
          case 'base-report':
            inst0.reportedBase = d.base;
            if (inst0.adaptInput) { inst0.adaptInput.reportedBase = d.base; reAdapt(inst0); }
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
          // 焦点在 iframe 内时，外壳全局快捷键收不到事件，由插件转发回来兜底
          case 'shell-shortcut':
            hooks.onShellShortcut?.(d.combo);
            break;
          // 插件内部被 CSP 拦下的外链，转发过来登记（外壳自己看不到跨文档事件）
          case 'csp-violation':
            hooks.onCspViolation?.(d, manifest);
            break;
        }
      };
      window.addEventListener('message', bridgeHandler);
      cleanupFns.push(() => window.removeEventListener('message', bridgeHandler));
    });

    hostEl.innerHTML = '';
    hostEl.appendChild(wrap);

    try {
      await ready;
    } catch (err) {
      cleanupFns.forEach((fn) => fn());
      wrap.remove();
      throw err;
    }
    // token 为 null 表示设置面板视图，不参与主挂载竞态
    if (token && state.mounting !== token) {
      cleanupFns.forEach((fn) => fn());
      wrap.remove();
      return null;
    }

    send(iframe, { type: 'mount' });
    await new Promise((r) => setTimeout(r, 60));   // 给插件渲染时间，便于主题采样

    /* 自动把焦点交给插件。
       不这么做的话，刚切换过来焦点还在主文档，插件的快捷键要等用户点一下才生效。
       用 preventScroll 避免页面跳动；contentWindow 可能因沙箱策略拿不到，失败即忽略。 */
    try {
      iframe.contentWindow?.focus();
      iframe.focus({ preventScroll: true });
    } catch { /* 沙箱限制，忽略 */ }

    return Object.assign(inst0, {
      manifest, wrap, target: iframe, root: null, iframe, bridgeHandler, cleanupFns, hasSettings,
      isolated, adaptTheme,
      ctx: { __destroy: async () => cleanupFns.forEach((fn) => fn()) },
      unmount: null,
    });
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
        /* 外壳能力桥接。
           关键：这些代码在**主平台侧**执行，所以即便插件处于隔离态
           （opaque origin，碰不到 parent、localStorage 不可用），
           照样能读写配置、管理外链 —— 隔离的是"直连通道"，不是"能力"。 */
        case 'shell.call': {
          const { ns, method, args } = payload || {};
          const mod = ns === 'pluginConfig' ? pluginConfig
            : ns === 'external' ? extPolicy : null;
          if (!mod) return reply(false, null, '未知外壳命名空间: ' + ns);
          const fn = mod[method];
          if (typeof fn !== 'function') return reply(false, null, `未知方法: ${ns}.${method}`);
          const data = await fn(...(args || []));
          // 函数 / Symbol 等无法结构化克隆，过滤掉
          return reply(true, JSON.parse(JSON.stringify(data ?? null, (k, v) => typeof v === 'function' ? undefined : v)));
        }
        /** 插件查询自己当前是否处于隔离态（用于插件内部能力探测） */
        case 'shell.isIsolated':
          return reply(true, !!state.instance?.isolated);
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
      /* 应用级快捷键：命中后往总线上发事件，插件用 ctx.on(event) 接收。
         与 ctx.shortcut()（插件内快捷键）不同 —— 这个由外壳统一持有，
         插件未激活时也照样触发，适合"全局唤起"类需求。 */
      'shortcut.register': ({ accel, event, label }) =>
        registerAppShortcut(manifest.id, accel, event, label),
      'shortcut.unregister': ({ accel }) => unregisterAppShortcut(manifest.id, accel),
      /* 往外壳侧边栏注入条目；插件卸载时自动清理 */
      'sidebar.add': ({ item }) => addSidebarItem(manifest.id, item),
      'sidebar.remove': ({ itemId }) => removeSidebarItem(manifest.id, itemId),
    };
  }
  const navigateHook = (id) => hooks.onNavigate?.(id);

  /* ---------------- 应用级快捷键 ---------------- */
  /** key: `${pluginId} ${accel}` */
  const appShortcuts = new Map();

  function accelMatches(e, accel) {
    // accel 形如 'Ctrl+Shift+1' / 'Alt+K' / 'Cmd+K'
    const parts = String(accel).toLowerCase().split('+').map((x) => x.trim());
    const key = parts.pop();
    const need = { ctrl: false, shift: false, alt: false, meta: false };
    for (const p of parts) {
      if (p === 'ctrl' || p === 'control') need.ctrl = true;
      else if (p === 'shift') need.shift = true;
      else if (p === 'alt' || p === 'option') need.alt = true;
      else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'mod') need.meta = true;
    }
    // 'mod' 在 macOS 映射 ⌘，其它平台映射 Ctrl
    if (parts.includes('mod')) {
      const mac = /mac|iphone|ipad/i.test(navigator.userAgent || '');
      need.meta = mac; need.ctrl = !mac;
    }
    if (need.ctrl !== e.ctrlKey) return false;
    if (need.shift !== e.shiftKey) return false;
    if (need.alt !== e.altKey) return false;
    if (need.meta !== e.metaKey) return false;
    // 数字键：同时兼容主键盘与数字小键盘
    const k = (e.key || '').toLowerCase();
    if (/^[0-9]$/.test(key)) return k === key || e.code === `Digit${key}` || e.code === `Numpad${key}`;
    return k === key;
  }

  function registerAppShortcut(pluginId, accel, event, label = '') {
    const k = `${pluginId} ${accel}`;
    if (appShortcuts.has(k)) window.removeEventListener('keydown', appShortcuts.get(k).fn);
    const fn = (e) => {
      if (!accelMatches(e, accel)) return;
      e.preventDefault();
      e.stopPropagation();
      bus.emit(event, { accel, label, pluginId });
    };
    window.addEventListener('keydown', fn);
    appShortcuts.set(k, { fn, event, label });
  }

  function unregisterAppShortcut(pluginId, accel) {
    const k = `${pluginId} ${accel}`;
    const rec = appShortcuts.get(k);
    if (!rec) return;
    window.removeEventListener('keydown', rec.fn);
    appShortcuts.delete(k);
  }

  /** 插件卸载时清掉它注册的全部应用级快捷键 */
  function clearAppShortcuts(pluginId) {
    for (const [k, rec] of [...appShortcuts]) {
      if (!k.startsWith(`${pluginId} `)) continue;
      window.removeEventListener('keydown', rec.fn);
      appShortcuts.delete(k);
    }
  }

  /* ---------------- 侧边栏注入条目 ---------------- */
  /** key: `${pluginId} ${itemId}` */
  const injectedItems = new Map();

  function addSidebarItem(pluginId, item) {
    if (!item?.id) return;
    const key = `${pluginId} ${item.id}`;
    injectedItems.set(key, { ...item, pluginId });
    publishInjected();
  }

  function removeSidebarItem(pluginId, itemId) {
    injectedItems.delete(`${pluginId} ${itemId}`);
    publishInjected();
  }

  function clearSidebarItems(pluginId) {
    let changed = false;
    for (const k of [...injectedItems.keys()]) {
      if (k.startsWith(`${pluginId} `)) { injectedItems.delete(k); changed = true; }
    }
    if (changed) publishInjected();
  }

  function publishInjected() {
    hooks.onSidebarItems?.([...injectedItems.values()]);
  }

  /* ---- 错误边界 ---- */
  function showError(stage, manifest, err) {
    const msg = String(err?.stack || err?.message || err);
    console.error(`[plugin:${manifest?.id}]`, err);
    // 插件名同样要转义：它和 msg 一样来自插件清单，
    // 而插件清单可以由用户导入/编辑 —— 只转义 msg 不转义 name，
    // 等于把门锁了却留着一扇窗（这处曾连续三轮漏修）。
    const title = escapeHtml(manifest?.name || manifest?.id || '未知插件');
    stage.innerHTML = `
      <div class="err-box">
        <h3>⚠ 插件「${title}」加载失败</h3>
        <pre>${escapeHtml(msg)}</pre>
        <div class="row">
          <button class="p-btn primary" id="err-retry">重试</button>
          <button class="p-btn" id="err-back">返回概览</button>
        </div>
      </div>`;
    stage.querySelector('#err-retry').onclick = () => mount(manifest?.id);
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
    if (inst.iframe) await pushTheme(inst.iframe);
    await reAdapt(inst);
  });

  /**
   * 把新主题推给 iframe 插件，并**等它确认已应用**再返回。
   *
   * 这一步不能省：postMessage 是异步的，如果推完立刻去采样插件颜色，
   * 读到的还是旧主题的颜色 → 基调误判 → 施加本不该有的反转。
   * SDK 应用完变量会回 theme-applied；老插件不回就靠超时兜底。
   */
  function pushTheme(iframe) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        try { window.removeEventListener('message', onAck); } catch { /* ignore */ }
        clearTimeout(timer);
        resolve();
      };
      const onAck = (e) => {
        const d = e.data;
        if (!d || d.channel !== BRIDGE_CHANNEL) return;
        if (d.type === 'theme-applied' && e.source === iframe.contentWindow) finish();
      };
      const timer = setTimeout(finish, 400);      // 兜底：不能无限等
      try {
        window.addEventListener('message', onAck);
        send(iframe, { type: 'theme', theme: exportVars() });
      } catch { finish(); }
    });
  }

  return {
    state, bus, mount, unmount, mountSettings, win, setBadge,
    hasSettings: () => hasSettings(state.instance),
    readTheme,
    getPlugins: () => state.plugins,
    /** 当前已注册的应用级快捷键（accel → { pluginId, event, label }） */
    getShortcuts: () => Object.fromEntries(
      [...appShortcuts].map(([k, v]) => [k.split('\u0000')[1], { pluginId: k.split('\u0000')[0], event: v.event, label: v.label }]),
    ),
    /** 插件注入到侧边栏的条目 */
    getSidebarItems: () => [...injectedItems.values()],
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
/**
 * HTML 转义。
 *
 * 五个字符都要转义：`&` `<` `>` 用于文本节点，`"` `'` 用于属性值。
 * 只覆盖前四个的话，把内容插进 `title="..."` 这类单引号属性时仍可被闭合。
 * 当前调用点都在文本节点里，但补齐单引号的成本为零，
 * 免得以后有人拿它去拼属性时踩坑。
 *
 * 注意：这个函数只能保证"不产生 HTML 结构"，
 * 不能用于 URL 上下文（href/src 里的 `javascript:` 需另行校验）。
 */
export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** 无构建模式下过滤掉需要编译器的插件（React/TSX） */
export function filterByRuntime(plugins) {
  return isNoBuild() ? plugins.filter((p) => !p.requiresBuild) : plugins;
}

export { isInsideTauri };
