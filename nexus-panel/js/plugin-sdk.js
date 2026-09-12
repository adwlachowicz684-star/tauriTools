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

/** 声明一个插件（语法糖，便于静态检查与未来扩展） */
export function definePlugin(def) {
  return { name: def.name, mount: def.mount, ...def };
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

    /** 注册卸载回调（清理定时器、监听器等） */
    onDestroy(fn) { destroyHooks.push(fn); },
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
export function createModuleContext({ manifest, container, bus, theme, shellHooks }) {
  const useShadow = !!manifest.shadow;
  const root = useShadow ? container.attachShadow({ mode: 'open' }) : container;
  if (useShadow) {
    // 让插件内部也能用上主题变量与组件库
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../css/neumorphism.css', import.meta.url).href;
    root.appendChild(link);
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

  return buildCtx({
    id: manifest.id, manifest, mode: 'module', root, container,
    transport, bus, theme,
  });
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
export function bootIframePlugin(mountFn) {
  const channel = BRIDGE_CHANNEL;
  let pending = new Map();
  let seq = 0;
  let ctxReady;
  let resolveMount;
  const mountPromise = new Promise((r) => (resolveMount = r));

  function post(msg) {
    window.parent.postMessage({ channel, ...msg }, '*');
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.channel !== channel) return;

    // 主题初始化 / 运行时切换（切换主题无需重载插件）
    if (d.type === 'init' || d.type === 'theme') {
      if (d.type === 'init') var { manifest, theme } = d;
      else manifest = manifest || d.manifest;
      // 把主题变量写到 iframe 的 :root，保证视觉与外壳一致
      if (d.theme) applyThemeVars(d.theme);
      if (d.type !== 'init') return;             // 纯更新，不走挂载流程

      document.body.classList.add('nexus-iframe-plugin');

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
      const ctx = buildCtx({
        id: manifest.id, manifest, mode: 'iframe',
        root: container, container, transport, bus, theme,
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

    if (d.type === 'mount' && ctxReady) {
      Promise.resolve(mountFn(ctxReady))
        .then((unmount) => {
          if (typeof unmount === 'function') ctxReady.onDestroy(unmount);
          post({ type: 'mounted', ok: true });
        })
        .catch((err) => post({ type: 'mounted', ok: false, error: String(err?.stack || err) }));
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

  // 脚本就绪即通知外壳（外壳收到后回发 init + mount，见 js/host.js）
  post({ type: 'ready' });

  return mountPromise;
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
