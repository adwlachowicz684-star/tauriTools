/**
 * Nexus Panel · 插件 SDK
 * ============================================================
 * 插件只依赖这一个文件，同一份代码在两种挂载模式下行为一致：
 *
 *   · module 模式：插件跑在主页面 JS 环境里，可直接调用 Rust 命令
 *   · iframe 模式：插件跑在沙箱 iframe 里，通过 postMessage 桥接调用
 *
 * 两种模式拿到的 ctx 接口完全相同，切换挂载方式无需改插件代码。
 * ------------------------------------------------------------
 */

import { getTauri } from './tauri-core.js';

export const BRIDGE_CHANNEL = 'nexus-bridge-v1';

/**
 * 外壳保留快捷键。
 * 焦点一旦进入 iframe，这些键在父窗口就收不到了，
 * 所以由 SDK 在 iframe 内捕获后转发回外壳执行（见 bootIframePlugin）。
 */
export const SHELL_SHORTCUTS = ['mod+b', 'mod+r', 'mod+,'];

/**
 * 声明一个插件
 *
 * mount(ctx)        —— 主视图，必填
 * settings(ctx)     —— 插件自己的设置面板，可选。
 *                      声明后外壳标题栏会出现「⚙ 设置」按钮；
 *                      两种挂载模式下写法完全一致。
 */
export function definePlugin(def) {
  return { name: def.name, mount: def.mount, settings: def.settings, ...def };
}

/** 极简 DOM 构造器：h('div.p-card', { onclick }, '文本', childNode) */
export function h(sel, props = {}, ...children) {
  const [tagPart, ...classes] = String(sel).split('.');
  const el = document.createElement(tagPart || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'class') el.className += ' ' + v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(parent, children) {
  for (const c of children.flat(9)) {
    if (c == null || c === false) continue;
    parent.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/* ============================================================
   快捷键
   ============================================================ */

/**
 * 解析快捷键串。
 * 支持：mod+k / ctrl+shift+p / meta+s / alt+/ / esc / f5 / ?
 *  · mod = macOS 的 ⌘、其它平台 Ctrl（写一次两端都对）
 *  · 单字符不区分大小写；'?' 需配合 shift，单独判断
 */
export function parseCombo(combo) {
  const parts = String(combo || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const spec = { key: '', mod: false, ctrl: false, shift: false, alt: false, meta: false };
  for (const p of parts) {
    if (p === 'mod') { spec.mod = true; }
    else if (p === 'ctrl' || p === 'control') { spec.ctrl = true; }
    else if (p === 'shift') { spec.shift = true; }
    else if (p === 'alt' || p === 'option') { spec.alt = true; }
    else if (p === 'meta' || p === 'cmd' || p === 'command' || p === 'super') { spec.meta = true; }
    else spec.key = p;
  }
  if (!spec.key) return null;
  return spec;
}

/** 判断一次按键事件是否匹配某个快捷键 */
export function matchCombo(e, spec) {
  if (!spec) return false;
  // mod：macOS 认 meta，其它认 ctrl
  const modOk = !spec.mod || (isMac() ? e.metaKey : e.ctrlKey);
  if (!modOk) return false;
  // 显式声明的修饰键必须按下；未声明的必须没按（避免 mod+k 被 ctrl+alt+k 误触发）
  const metaOk = spec.meta ? e.metaKey : !e.metaKey || (spec.mod && isMac());
  const ctrlOk = spec.ctrl ? e.ctrlKey : !e.ctrlKey || (spec.mod && !isMac());
  if (!metaOk || !ctrlOk) return false;
  if (spec.alt !== e.altKey) return false;
  if (spec.shift !== e.shiftKey) return false;

  const k = String(e.key || '').toLowerCase();
  const code = String(e.code || '').toLowerCase();
  if (k === spec.key) return true;
  // 功能键：code 形如 f5 / escape
  if (code === spec.key) return true;
  if (code === 'key' + spec.key) return true;         // 'k' → KeyK
  if (spec.key === 'esc' && k === 'escape') return true;
  if (spec.key === 'space' && (k === ' ' || code === 'space')) return true;
  if (spec.key === '?' && k === '?') return true;
  return false;
}

export function isMac() {
  try {
    return /mac|iphone|ipad/i.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
  } catch { return false; }
}

/* ============================================================
   内部：通用 ctx 构造（两种模式共用）
   ============================================================ */
function buildCtx(base) {
  const { id, manifest, mode, root, container, transport, bus, onDestroy } = base;
  const destroyHooks = [];

  const ctx = {
    id,
    mode,                                  // 'module' | 'iframe'
    manifest,
    root,                                  // 挂载点：HTMLElement 或 ShadowRoot
    container,                             // 宿主元素（始终在文档流里）
    version: manifest.version || '0.0.0',

    /** 调用 Rust 命令；两种模式都可用 */
    async invoke(cmd, args = {}) {
      return transport.request('invoke', { cmd, args });
    },

    /** 事件总线：插件之间 / 插件与外壳通信 */
    on(event, handler) {
      return bus.on(event, handler, id);
    },
    emit(event, payload) {
      bus.emit(event, payload, id);
    },

    /** 监听来自 Rust 的事件（需要 Tauri 事件 API；拿不到时返回 null） */
    async listenTauri(event, handler) {
      return transport.request('listen', { event, handler });
    },

    /** 每个插件独立的持久化 KV */
    store: {
      get: (k, def = null) => transport.request('store.get', { k, def }),
      set: (k, v) => transport.request('store.set', { k, v }),
      del: (k) => transport.request('store.del', { k }),
      all: () => transport.request('store.all', {}),
    },

    /** 修改标题栏 / 内容区标题 */
    setTitle(text) { transport.notify('title', { text }); },
    /** 侧边栏角标：传 0 或 null 清除 */
    setBadge(n) { transport.notify('badge', { n }); },
    /** 轻提示 */
    toast(msg, type = 'info') { transport.notify('toast', { msg, type }); },
    /** 请求外壳重新加载本插件 */
    reload() { transport.notify('reload', {}); },
    /** 切换到另一个插件 */
    openPlugin(targetId) { transport.notify('open', { id: targetId }); },

    /**
     * 注册一个应用级快捷键（窗口在前台时生效，与插件是否激活无关）。
     * accel 形如 'Ctrl+Shift+1' / 'Alt+K' / 'Mod+K'（Mod = macOS ⌘ / 其它 Ctrl）。
     * 命中后外壳在总线上发 event，插件用 ctx.on(event, handler) 接收。
     *
     * 与 ctx.shortcut() 的区别：这个由外壳统一持有，适合"全局唤起"；
     * ctx.shortcut() 只在插件激活时生效，适合插件内的局部操作。
     */
    registerShortcut(accel, event, label = '') {
      transport.notify('shortcut.register', { accel, event, label });
    },
    unregisterShortcut(accel) {
      transport.notify('shortcut.unregister', { accel });
    },

    /**
     * 往外壳侧边栏注入一个条目（{ id, label, icon, event }）。
     * 点击后外壳在总线上发 event，插件用 ctx.on(event, handler) 接收。
     * 插件卸载时条目自动移除。
     */
    addSidebarItem(item) { transport.notify('sidebar.add', { item }); },
    removeSidebarItem(itemId) { transport.notify('sidebar.remove', { itemId }); },

    /** 注入样式：module 模式自动加作用域前缀，iframe 模式直接注入 */
    addStyle(css) {
      const style = document.createElement('style');
      if (mode === 'module' && !manifest.shadow) {
        style.textContent = scopeCss(css, `[data-plugin-id="${id}"]`);
      } else {
        style.textContent = css;
      }
      root.appendChild(style);
      return () => style.remove();
    },

    /**
     * 注册快捷键。
     *
     * 关键行为（两种挂载模式一致）：
     *   · 只在插件「被激活」时响应 —— 切到别的插件就自动失效
     *   · 插件卸载时自动注销，不会残留
     *   · 支持 mod+k（mac=⌘，win/linux=Ctrl）、ctrl+shift+p、esc、f5 等
     *   · 返回 off()，可提前注销
     *
     * @param {string|string[]} combo  如 'mod+k' 或 ['mod+k', 'ctrl+k']
     * @param {(e: KeyboardEvent) => void} handler
     * @param {{ preventDefault?: boolean }} [opts]
     */
    shortcut(combo, handler, opts = {}) {
      const specs = (Array.isArray(combo) ? combo : [combo])
        .map(parseCombo).filter(Boolean);
      if (!specs.length || typeof handler !== 'function') return () => {};
      return base.bindShortcut?.(specs, handler, opts) ?? (() => {});
    },

    /** 注册卸载回调（清理定时器、监听器等） */
    onDestroy(fn) { destroyHooks.push(fn); },

    /**
     * 外壳能力（配置 / 外链管理）。
     *
     * 这些方法在**主平台侧执行**并通过桥接返回结果，
     * 所以插件处于隔离态（opaque origin）时依然可用 ——
     * 隔离切断的是"直连通道"（parent / localStorage / Tauri IPC），
     * 不是能力本身。
     *
     *   await ctx.shell.pluginConfig.get('my-plugin')
     *   await ctx.shell.external.listHosts()
     */
    shell: {
      pluginConfig: {
        get: (id) => transport.request('shell.call',
          { ns: 'pluginConfig', method: 'getPluginConfig', args: [id] }),
        set: (id, patch) => transport.request('shell.call',
          { ns: 'pluginConfig', method: 'setPluginConfig', args: [id, patch] }),
      },
      external: {
        load: () => transport.request('shell.call', { ns: 'external', method: 'loadPolicy', args: [] }),
        save: (p) => transport.request('shell.call', { ns: 'external', method: 'savePolicy', args: [p] }),
        list: () => transport.request('shell.call', { ns: 'external', method: 'listHosts', args: [] }),
        pending: () => transport.request('shell.call', { ns: 'external', method: 'pendingHosts', args: [] }),
        decide: (host, policy) => transport.request('shell.call',
          { ns: 'external', method: 'decideHost', args: [host, policy] }),
        setStatus: (host, status, meta) => transport.request('shell.call',
          { ns: 'external', method: 'setHostStatus', args: [host, status, meta] }),
        remove: (host) => transport.request('shell.call', { ns: 'external', method: 'removeHost', args: [host] }),
        suggestCsp: (policy) => transport.request('shell.call',
          { ns: 'external', method: 'suggestCsp', args: [policy] }),
        rescan: () => transport.request('shell.call', { ns: 'external', method: 'scanEntry', args: [] }),
      },
      isIsolated: () => transport.request('shell.isIsolated', {}),
      /**
       * 主题（读 + 写），在**主平台侧**执行。
       *
       * 关键在"写"：iframe 有自己的 document，插件本地 import 一份
       * theme-manager 去 applyTheme，改的只是 iframe 内的 :root，
       * 主面板不会跟着变。走桥接让主平台侧执行，主面板才跟着变，
       * 再由 onChange → pushTheme 把新变量推回 iframe。
       *
       * 读也走桥接：隔离态（opaque origin）下 iframe 的 localStorage 不可用，
       * 本地读会拿到默认值而非用户实际选择。
       *
       * 用法与 external 一致：优先走它，拿不到再回退本地实现。
       */
      theme: {
        // 读
        listThemes: () => transport.request('shell.call', { ns: 'theme', method: 'listThemes', args: [] }),
        getThemeId: () => transport.request('shell.call', { ns: 'theme', method: 'getThemeId', args: [] }),
        getCurrent: () => transport.request('shell.call', { ns: 'theme', method: 'getCurrent', args: [] }),
        getAccent: () => transport.request('shell.call', { ns: 'theme', method: 'getAccent', args: [] }),
        getEnvColor: () => transport.request('shell.call', { ns: 'theme', method: 'getEnvColor', args: [] }),
        getBase: () => transport.request('shell.call', { ns: 'theme', method: 'getBase', args: [] }),
        getHueShift: () => transport.request('shell.call', { ns: 'theme', method: 'getHueShift', args: [] }),
        getLightShift: () => transport.request('shell.call', { ns: 'theme', method: 'getLightShift', args: [] }),
        // 写
        applyTheme: (id, accent, env) => transport.request('shell.call',
          { ns: 'theme', method: 'applyTheme', args: [id, accent, env] }),
        setAccent: (c) => transport.request('shell.call', { ns: 'theme', method: 'setAccent', args: [c] }),
        setEnvColor: (c) => transport.request('shell.call', { ns: 'theme', method: 'setEnvColor', args: [c] }),
        resetColors: () => transport.request('shell.call', { ns: 'theme', method: 'resetColors', args: [] }),
        setThemeShift: (hue, light) => transport.request('shell.call',
          { ns: 'theme', method: 'setThemeShift', args: [hue, light] }),
        saveAsCustom: (name) => transport.request('shell.call',
          { ns: 'theme', method: 'saveAsCustom', args: [name] }),
        deleteCustomTheme: (id) => transport.request('shell.call',
          { ns: 'theme', method: 'deleteCustomTheme', args: [id] }),
      },
    },
    /** 供外壳调用 */
    async __destroy() {
      for (const fn of destroyHooks.reverse()) {
        try { await fn(); } catch (e) { console.error('[plugin destroy]', id, e); }
      }
    },

    /** 主题变量（只读快照） */
    theme: base.theme || {},
  };

  ctx.notify = (payload) => ctx.toast(payload?.body ?? String(payload), 'info');
  return ctx;
}

/* ============================================================
   模式 A：同页模块插件（module）
   插件入口 export default definePlugin({ mount(ctx){ ... return unmount } })
   ============================================================ */
export function createModuleContext({
  manifest, container, bus, theme, shellHooks,
  isActive = () => true,        // 插件当前是否处于激活态（引擎按 activeId 判定）
  scope = null,                 // 事件绑定目标，默认主文档
}) {
  const useShadow = !!manifest.shadow;
  const root = useShadow ? container.attachShadow({ mode: 'open' }) : container;
  if (useShadow) {
    // 让插件内部也能用上主题变量与组件库
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../css/neumorphism.css', import.meta.url).href;
    root.appendChild(link);
  }

  const shortcutCleanups = [];
  const target = scope || document;

  /** 同页插件的快捷键：注册在主文档，靠 isActive() 做到「只在自己激活时生效」 */
  function bindShortcut(specs, handler, opts = {}) {
    const onKey = (e) => {
      if (!isActive()) return;                 // ← 核心：切走了就不响应
      for (const spec of specs) {
        if (matchCombo(e, spec)) {
          if (opts.preventDefault !== false) e.preventDefault();
          try { handler(e); } catch (err) { console.error('[shortcut]', manifest.id, err); }
          return;
        }
      }
    };
    target.addEventListener('keydown', onKey);
    const off = () => {
      target.removeEventListener('keydown', onKey);
      const i = shortcutCleanups.indexOf(off);
      if (i >= 0) shortcutCleanups.splice(i, 1);
    };
    shortcutCleanups.push(off);
    return off;
  }

  const transport = {
    async request(method, payload) {
      switch (method) {
        case 'invoke': {
          const tauri = await getTauri();
          if (!tauri) throw new Error('当前不在 Tauri 环境中（浏览器调试模式无法调用 Rust 命令）');
          return tauri.invoke(payload.cmd, payload.args);
        }
        case 'listen': {
          const { getTauriEvent } = await import('./tauri-core.js');
          const ev = await getTauriEvent();
          if (!ev) throw new Error('Tauri 事件 API 不可用');
          return ev.listen(payload.event, (e) => payload.handler(e.payload, e));
        }
        case 'store.get': {
          const raw = localStorage.getItem(`nexus:${manifest.id}:${payload.k}`);
          return raw == null ? payload.def : JSON.parse(raw);
        }
        case 'store.set':
          localStorage.setItem(`nexus:${manifest.id}:${payload.k}`, JSON.stringify(payload.v));
          return true;
        case 'store.del':
          localStorage.removeItem(`nexus:${manifest.id}:${payload.k}`);
          return true;
        case 'store.all': {
          const out = {};
          const pre = `nexus:${manifest.id}:`;
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k.startsWith(pre)) out[k.slice(pre.length)] = JSON.parse(localStorage.getItem(k));
          }
          return out;
        }
        default:
          throw new Error('未知请求: ' + method);
      }
    },
    notify(type, payload) { shellHooks?.[type]?.(payload); },
  };

  const ctx = buildCtx({
    id: manifest.id, manifest, mode: 'module', root, container,
    transport, bus, theme, bindShortcut,
  });

  // 卸载时兜底注销所有快捷键，杜绝监听器残留
  const baseDestroy = ctx.__destroy;
  ctx.__destroy = async () => {
    shortcutCleanups.splice(0).forEach((off) => { try { off(); } catch {} });
    await baseDestroy();
  };
  return ctx;
}

/* ============================================================
   模式 B：沙箱 iframe 插件
   插件页面里调用 bootIframePlugin(async (ctx) => { ...; return unmount })
   ============================================================ */

/** 把外壳主题变量写进 iframe 的 :root（覆盖式更新，支持反复调用） */
function applyThemeVars(vars) {
  if (!vars) return;
  let s = document.getElementById('nexus-theme-vars');
  if (!s) {
    s = document.createElement('style');
    s.id = 'nexus-theme-vars';
    document.head.appendChild(s);
  }
  s.textContent = ':root{' +
    Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';') + '}';
  // 让表单控件、滚动条跟随外壳基调
  const base = vars['--text'] && isLightColor(vars['--bg']) ? 'light' : 'dark';
  document.documentElement.style.colorScheme = base;
}

/** 粗略判断一个颜色是浅是深，用于设置 color-scheme */
function isLightColor(c) {
  if (!c) return false;
  const m = String(c).match(/rgba?\(([^)]+)\)/);
  let r, g, b;
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
    [r, g, b] = p;
  } else {
    const h = String(c).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!h) return false;
    let t = h[1];
    if (t.length === 3) t = t.split('').map((x) => x + x).join('');
    r = parseInt(t.slice(0, 2), 16);
    g = parseInt(t.slice(2, 4), 16);
    b = parseInt(t.slice(4, 6), 16);
  }
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 140;
}
/**
 * iframe 插件引导
 *
 * bootIframePlugin(mainFn)                    —— 只有主视图
 * bootIframePlugin(mainFn, settingsFn)        —— 额外提供设置面板
 *
 * 外壳加载设置面板时会再开一个同样的页面，并在 init 消息里带 view='settings'，
 * SDK 据此调用 settingsFn 而不是 mainFn；两者拿到的 ctx 完全一致。
 */
export function bootIframePlugin(mountFn, settingsFn) {
  const channel = BRIDGE_CHANNEL;
  let pending = new Map();
  let seq = 0;
  let ctxReady;
  let resolveMount;
  let view = 'main';                 // 'main' | 'settings'
  let currentTheme = {};             // 外壳推来的主题变量，供 ctx.theme 读取
  let isolated = false;              // 是否处于功能隔离（去掉 allow-same-origin）
  let mounted = false;               // mount 只允许执行一次
  const mountPromise = new Promise((r) => (resolveMount = r));

  function post(msg) {
    window.parent.postMessage({ channel, ...msg }, '*');
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.channel !== channel) return;

    // 主题初始化 / 运行时切换（切换主题无需重载插件）
    if (d.type === 'init' || d.type === 'theme') {
      if (d.type === 'init') {
        var { manifest } = d;
        view = d.view || 'main';                 // 本次要渲染哪个视图
      } else {
        manifest = manifest || d.manifest;
      }
      // 把主题变量写到 iframe 的 :root，保证视觉与外壳一致
      if (d.theme) {
        currentTheme = d.theme;
        applyThemeVars(d.theme);
        // 回执：告诉外壳"新变量已生效，可以放心采样了"。
        // 没有它，外壳可能在变量落地前就采样 → 读到旧色 → 基调误判 → 反转错。
        if (d.type === 'theme') post({ type: 'theme-applied' });
      }
      if (d.type !== 'init') return;             // 纯更新，不走挂载流程

      isolated = !!d.isolated;
      document.body.classList.add('nexus-iframe-plugin');
      document.body.classList.toggle('nexus-view-settings', view === 'settings');
      document.body.classList.toggle('nexus-isolated', isolated);
      // 注意：这里**不能**回发 ready。
      // 外壳的 ready Promise 由 mounted / error 解决，而 mounted 要等我们收到 mount 才发；
      // 如果 ready 又要等 init，就成了 init ← ready ← init 的互等死锁。
      // ready 在脚本就绪时就主动发一次（见本函数末尾）。

      /* 隔离插件：外壳读不到 contentDocument，采样会静默失败 → 不反转 →
         深色面板上留一块刺眼的白。所以由插件自己采样并上报基调。 */
      if (d.reportBase) {
        const report = () => post({ type: 'base-report', base: sampleOwnBase(), view });
        report();
        // 内容可能是异步渲染的，稍后再报一次；图片加载完再报一次
        setTimeout(report, 300);
        window.addEventListener('load', () => setTimeout(report, 60), { once: true });
      }

      const bus = makeBusProxy();
      const transport = {
        request(method, payload) {
          const id = ++seq;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            post({ type: 'req', id, method, payload });
            setTimeout(() => {
              if (pending.has(id)) { pending.delete(id); reject(new Error(`桥接超时: ${method}`)); }
            }, 15000);
          });
        },
        notify(type, payload) { post({ type: 'notify', notifyType: type, payload }); },
      };

      const container = document.getElementById('plugin-mount') || document.body;

      /* iframe 的快捷键：注册在自己的 window 上。
         浏览器已按焦点隔离 —— 焦点不在本 iframe 时压根收不到事件，
         天然满足「只在自己激活时生效」，无需再判 activeId。 */
      const shortcutCleanups = [];
      function bindShortcut(specs, handler, opts = {}) {
        const onKey = (e) => {
          for (const spec of specs) {
            if (matchCombo(e, spec)) {
              if (opts.preventDefault !== false) e.preventDefault();
              try { handler(e); } catch (err) { console.error('[shortcut]', manifest.id, err); }
              return;
            }
          }
        };
        window.addEventListener('keydown', onKey);
        const off = () => {
          window.removeEventListener('keydown', onKey);
          const i = shortcutCleanups.indexOf(off);
          if (i >= 0) shortcutCleanups.splice(i, 1);
        };
        shortcutCleanups.push(off);
        return off;
      }

      const ctx = buildCtx({
        id: manifest.id, manifest, mode: 'iframe',
        root: container, container, transport, bus, theme: currentTheme, bindShortcut,
      });

      // 卸载时兜底注销
      const baseDestroy = ctx.__destroy;
      ctx.__destroy = async () => {
        shortcutCleanups.splice(0).forEach((off) => { try { off(); } catch {} });
        await baseDestroy();
      };

      /* 焦点进入 iframe 后，外壳的全局快捷键（⌘R 重载 / ⌘B 侧栏 / ⌘, 设置）
         会因为「事件不跨文档冒泡」而失效。这里把按键转发回外壳兜底执行，
         但仅在外壳快捷键没被本插件占用时转发。 */
      window.addEventListener('keydown', (e) => {
        for (const combo of SHELL_SHORTCUTS) {
          if (matchCombo(e, parseCombo(combo))) {
            post({ type: 'shell-shortcut', combo, key: e.key });
            return;
          }
        }
      });

      ctxReady = ctx;
      resolveMount(ctx);
    }

    if (d.type === 'res') {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      d.ok ? p.resolve(d.data) : p.reject(new Error(d.error));
    }

    if (d.type === 'event' && ctxReady) {
      busLocal.emit(d.event, d.payload);
    }

    if (d.type === 'mount' && ctxReady && !mounted) {
      mounted = true;                            // 重复 mount 不再二次挂载
      // settings 视图下优先用 settingsFn；没提供则回退到主视图，避免开个空面板
      const fn = view === 'settings' ? (settingsFn || mountFn) : mountFn;
      Promise.resolve(fn(ctxReady))
        .then((unmount) => {
          if (typeof unmount === 'function') ctxReady.onDestroy(unmount);
          post({ type: 'mounted', ok: true, view });
        })
        .catch((err) =>
          post({ type: 'mounted', ok: false, view, error: String(err?.stack || err) }));
    }
  });

  // iframe 内部本地事件总线（对外通过桥接转发）
  const busLocal = (() => {
    const map = new Map();
    return {
      on(ev, fn) {
        if (!map.has(ev)) map.set(ev, new Set());
        map.get(ev).add(fn);
        return () => map.get(ev).delete(fn);
      },
      emit(ev, payload) { map.get(ev)?.forEach((fn) => fn(payload)); },
    };
  })();

  function makeBusProxy() {
    return {
      on(event, handler) {
        const off = busLocal.on(event, handler);
        post({ type: 'subscribe', event });
        return () => { off(); post({ type: 'unsubscribe', event }); };
      },
      emit(event, payload) {
        busLocal.emit(event, payload);
        post({ type: 'publish', event, payload });
      },
    };
  }

  window.addEventListener('error', (e) =>
    post({ type: 'error', error: String(e.message) }));
  window.addEventListener('unhandledrejection', (e) =>
    post({ type: 'error', error: String(e.reason?.stack || e.reason) }));

  /* 外链观测：CSP 违规只在违规发生的文档里触发，不会冒泡到父文档，
     所以这里就地捕获并转发给外壳，否则外壳根本不知道插件想访问什么被拦了。 */
  window.addEventListener('securitypolicyviolation', (e) => {
    post({
      type: 'csp-violation',
      blockedURI: String(e.blockedURI || '').slice(0, 300),
      directive: String(e.violatedDirective || ''),
      view,
    });
  });

  // 脚本就绪即通知外壳（外壳收到后回发 init + mount，见 js/host.js）。
  // 上报是否提供设置面板：外壳据此决定要不要显示「⚙ 设置」按钮。
  post({ type: 'ready', hasSettings: typeof settingsFn === 'function' });

  return mountPromise;
}

/**
 * 采样插件自身基调（隔离模式下代替外壳采样）。
 * 取 body 或最外层容器的背景色亮度；拿不到就退回文字色亮度。
 */
function sampleOwnBase() {
  const lum = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    let r, g, b;
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
      [r, g, b] = p;
      if (p.length > 3 && p[3] === 0) return null;      // 全透明，当没取到
    } else {
      const h = String(c).trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
      if (!h) return null;
      let t = h[1];
      if (t.length === 3) t = t.split('').map((x) => x + x).join('');
      r = parseInt(t.slice(0, 2), 16);
      g = parseInt(t.slice(2, 4), 16);
      b = parseInt(t.slice(4, 6), 16);
    }
    if ([r, g, b].some((v) => typeof v !== 'number' || Number.isNaN(v))) return null;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };

  const tryEl = (el) => {
    if (!el) return null;
    let cur = el;
    for (let i = 0; i < 6 && cur; i++) {
      const cs = getComputedStyle(cur);
      const v = lum(cs.backgroundColor);
      if (v !== null) return v;
      cur = cur.parentElement;
    }
    return null;
  };

  const bg = tryEl(document.body);
  if (bg !== null) return bg > 0.55 ? 'light' : 'dark';
  const fg = lum(getComputedStyle(document.body).color);
  if (fg !== null) return fg > 0.55 ? 'dark' : 'light';   // 文字亮 → 底色暗
  return null;
}

/* ============================================================
   CSS 作用域化：给 module 模式插件的样式加前缀，避免互相污染
   ============================================================ */
export function scopeCss(css, scope) {
  return css.replace(/(^|\})([^{}@]+)\{/g, (m, brace, selector) => {
    if (/^\s*(@|from|to|\d+%)/.test(selector)) return m;
    const scoped = selector
      .split(',')
      .map((s) => {
        s = s.trim();
        if (!s) return s;
        if (s.startsWith(':root') || s.startsWith('html') || s.startsWith('body')) return s;
        return `${scope} ${s}`;
      })
      .join(', ');
    return `${brace}${scoped}{`;
  });
}
