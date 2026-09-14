/**
 * 插件宿主引擎（与 UI 框架无关）
 * ------------------------------------------------------------
 * 原生外壳（js/shell.js）与 React 外壳（src/App.tsx）共用这一份引擎，
 * 保证两种技术栈下插件行为完全一致。
 */

import { getTauri, isInsideTauri } from './tauri-core.js';
import { createModuleContext, BRIDGE_CHANNEL } from './plugin-sdk.js';
import { installAdapter } from './theme-normalizer.js';
import * as normalizer from './theme-normalizer.js';
import { getPluginConfig } from './plugin-config.js';
import * as pluginConfig from './plugin-config.js';
import * as extPolicy from './external-policy.js';
import {
  initTheme, exportVars, onChange as onThemeChange,
} from './theme-manager.js';
// 命名空间导入：供 ctx.shell.theme 桥接用。用具名导入会和本文件的
// 局部变量撞名，用命名空间取最省心。
import * as themeManager from './theme-manager.js';
// 注意：必须先 import 再 export。`export { X } from '...'` 是纯转发，
// 不会在本模块作用域里留下 X 绑定 —— 而 readTheme() 内部直接读 THEME_VARS，
// 只写转发式导出会抛 ReferenceError。写法与 theme-manager.js 保持一致。
import { THEME_VARS } from './themes.js';

/**
 * 主题变量清单：直接沿用 themes.js 的唯一真源，不再在此维护副本。
 * --------------------------------------------------------------------
 * 此前这份本地清单停留在重构前：用的是 --accent-2 / --r 这两个旧名，
 * 且缺 --ok --running --env-color --surface-raised --text-soft --bg-image 等
 * 新增变量。readTheme() 按它遍历取值，导致插件层拿不到刚分离出来的状态色
 * （--ok / --running）与环境色（--env-color），旧名则读到空字符串。
 *
 * 保留具名导出（而非 `export *`），让 `import { THEME_VARS } from './host.js'`
 * 的既有写法继续可用；theme-manager.js 早已是同样的 re-export 写法，
 * 三方共用同一份定义，从根上消除再次漂移的可能。
 */
export { THEME_VARS };

export function isNoBuild() {
  return globalThis.__NEXUS_NO_BUILD__ === true;
}

/**
 * 供 iframe 插件经 ctx.shell.theme 桥接调用的主题能力。
 *
 * 为什么需要它：主题变量写在 :root 上，而 iframe 插件有**自己的 document**。
 * 设置页是 iframe，它若直接 import 一份 theme-manager 并调 applyTheme，
 * 改的只是 iframe 内部的 :root —— 于是"插件（设置页自己）变了、主面板没变"。
 * 而标题栏右上角的切换跑在主平台侧，改的是主文档 :root，
 * 主面板变、再经 pushTheme 推给 iframe，所以两边都变。
 *
 * 桥接之后：写操作由主平台侧执行 → 主面板立刻变 → onChange 触发 pushTheme
 * → iframe 收到新变量并重绘。单向流动，不会来回触发（iframe 只是应用，不回写）。
 *
 * 用白名单而不是整个模块：主题是外壳的核心状态，不希望插件能调到
 * 任意内部方法（含未导出的派生逻辑）。
 */
export const THEME_API_METHODS = [
  // 读
  'listThemes', 'getThemeId', 'getCurrent', 'getAccent', 'getEnvColor',
  'getBase', 'getHueShift', 'getLightShift', 'exportVars',
  // 写
  'applyTheme', 'setAccent', 'setEnvColor', 'resetColors', 'setThemeShift',
  'saveAsCustom', 'deleteCustomTheme',
];
const themeApi = Object.fromEntries(
  THEME_API_METHODS.map((m) => [m, themeManager[m]]).filter(([, fn]) => typeof fn === 'function'),
);

/**
 * 插件主题适配策略（normalizer），同样经 ctx.shell 桥接。
 *
 * 与主题同源的问题：策略存在 localStorage 里，iframe 插件（尤其隔离态，
 * opaque origin 下 localStorage 根本不可用）本地写不进主平台侧，
 * 主面板读到的还是旧值。
 *
 * 但这里还多一层 —— **光写对还不够**。适配结果是在 installAdapter() 时
 * 按 resolvePolicy() 算一次并固化成滤镜的；策略改了若不重算，当前插件
 * 的滤镜不会变，看起来就是"改了没反应"。所以两个写方法外面包了一层：
 * 写完立刻让宿主对当前实例重跑 reAdapt()。
 *
 * reAdapt 在 createHost 闭包里，这里用回调注入（单例宿主，够用）。
 */
export const NORMALIZER_API_METHODS = [
  'getPolicy', 'setPolicy', 'getPluginOverride', 'setPluginOverride', 'resolvePolicy',
];

/** 由 createHost 注入：策略变更后重算当前插件的适配。 */
let onAdaptPolicyChanged = () => {};

const normalizerApi = {
  getPolicy: normalizer.getPolicy,
  resolvePolicy: normalizer.resolvePolicy,
  getPluginOverride: normalizer.getPluginOverride,
  setPolicy: (v) => {
    normalizer.setPolicy(v);
    onAdaptPolicyChanged();
  },
  setPluginOverride: (id, v) => {
    normalizer.setPluginOverride(id, v);
    onAdaptPolicyChanged();
  },
};

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
    /* 把重算入口暴露给模块级的 normalizerApi：
       策略是从 iframe 里改的，改完必须重算当前插件才看得到效果。 */
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

  // 策略变更（可能来自 iframe 设置页）→ 对当前插件重算适配。
  // 只重算当前这一个：其它插件下次挂载时自然会按新策略来，
  // 没必要为没在显示的东西付采样开销。
  onAdaptPolicyChanged = () => {
    if (state.instance) reAdapt(state.instance);
  };

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
    // 事件订阅登记表（见 case 'subscribe' 的说明）
    const subs = [];
    let bridgeHandler = null;
    let hasSettings = false;
    let handshaked = false;          // 每个 iframe 实例只握手一次
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
            // 只握手一次：旧版 SDK 收到 init 会回发一次 ready，不去重会形成
            // ready ↔ init 无限往返，每轮还会重建 ctx 与事件订阅。
            // token 校验拦掉已被放弃的挂载（settings 视图 token 为 null，不拦）。
            if (handshaked || (token && state.mounting !== token)) break;
            handshaked = true;
            hasSettings = !!d.hasSettings;      // 插件上报：是否提供了设置面板
            // 主动回发 init（含 manifest/主题），再发 mount，两者必须都在这里发：
            // ready 这个 Promise 只由 mounted / error 解决，而 mounted 又要等 iframe
            // 收到 mount 才回 —— 把 mount 放到 await ready 之后就是互等死锁。
            // postMessage 按序送达：iframe 先处理 init（ctx 就绪），随后 mount 才能挂载。
            send(iframe, {
              type: 'init', manifest, theme: exportVars(), view,
              isolated,                         // 插件据此决定能力探测方式
              reportBase: isolated && adaptTheme,  // 隔离且要适配 → 让插件自报基调
              // 宿主自报 origin，供插件回发消息时用作 targetOrigin。
              // 隔离态下插件是 opaque origin，读不到 parent.location，
              // 只能靠这里告诉它 —— 否则它只能通配 '*'。
              hostOrigin: window.location.origin || '*',
            });
            send(iframe, { type: 'mount' });
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
          case 'subscribe': {
            const unsub = bus.on(d.event, (payload) => send(iframe, { type: 'event', event: d.event, payload }));
            cleanupFns.push(unsub);
            // 单独记一份，供 unsubscribe 精确摘除。
            //
            // 为什么必须支持退订：插件每次 ctx.on(event, h) 都会在宿主挂一个 handler，
            // ctx.off() 只是发来一条 'unsubscribe'。若宿主不处理，handler 永不移除 ——
            // 插件里"动作清单变化就退订重订"是最常见的写法，于是每改一次设置，
            // 同一事件的处理函数就多一个，表现为"按一次快捷键执行两次"。
            subs.push({ event: d.event, unsub });
            break;
          }
          case 'unsubscribe': {
            // 后进先出：同一个事件被订阅多次时，摘掉最近挂上的那个
            for (let i = subs.length - 1; i >= 0; i--) {
              if (subs[i].event === d.event) {
                try { subs[i].unsub(); } catch { /* 已失效则忽略 */ }
                subs.splice(i, 1);
                break;
              }
            }
            break;
          }
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

    // mount 已在收到 ready 时与 init 一起发出（见上面的 ready 分支）。
    // 这里不能再发：ready Promise 由 mounted / error 解决，而 mounted 要等 iframe
    // 收到 mount 才回 —— 放在 await ready 之后就是互等死锁。
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

  /**
   * 往 iframe 发桥接消息。
   *
   * targetOrigin 按插件是否隔离取不同值：
   *   非隔离 —— 带 allow-same-origin，与外壳同源 → 用精确 origin。
   *             这样万一 iframe 被导航到别的站点，消息不会跟着泄漏过去。
   *   隔离   —— 去掉了 allow-same-origin，iframe 是 opaque origin，
   *             没有任何字符串能匹配它，只能用 '*'。
   *             这是 sandbox 机制的固有限制，不是漏改；此时发往的是
   *             iframe.contentWindow 这一个具体窗口，不是广播。
   */
  function targetOriginFor(iframe) {
    try {
      return iframe.dataset.isolated === '1' ? '*' : (window.location.origin || '*');
    } catch { return '*'; }
  }

  function send(iframe, msg) {
    iframe.contentWindow?.postMessage(
      { channel: BRIDGE_CHANNEL, ...msg },
      targetOriginFor(iframe),
    );
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
          if (raw == null) return reply(true, payload.def);
          // 存储可能被外部改写、或跨版本格式变了。单个键读不出就退默认值，
          // 不该让一次读取把插件整体带崩。
          try { return reply(true, JSON.parse(raw)); } catch { return reply(true, payload.def); }
        }
        case 'store.set':
          localStorage.setItem(`nexus:${manifest.id}:${payload.k}`, JSON.stringify(payload.v));
          return reply(true, true);
        case 'store.del':
          localStorage.removeItem(`nexus:${manifest.id}:${payload.k}`);
          return reply(true, true);
        case 'store.all': {
          const out = {}, pre = `nexus:${manifest.id}:`;
          // 逐键 try：一个键坏掉不该让整份配置拿不到（此前会整体抛错）
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || !k.startsWith(pre)) continue;
            try { out[k.slice(pre.length)] = JSON.parse(localStorage.getItem(k)); } catch { /* 跳过坏键 */ }
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
            : ns === 'external' ? extPolicy
            : ns === 'theme' ? themeApi
            : ns === 'normalizer' ? normalizerApi : null;
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

  /* ---------------- 复合 key 的分隔符 ---------------- */
  /*
   * 插件级注册表（应用快捷键、侧边栏注入项）用「pluginId + 分隔符 + 子 id」
   * 拼成单个 key 存进 Map。分隔符用 NUL（\u0000）是因为它不可能出现在
   * 正常的 id 里 —— 但这条前提此前只存在于注释中，8 处字面量各自手写，
   * 新增调用点没有类型约束提醒你用同一个分隔符。
   *
   * 现在收成常量 + 两个工具函数：拼 key 只能走 keyOf()，前缀判断只能走
   * keyPrefix()，散落的字面量与「手拼前缀」的写法都消失。
   * 写成 \u0000 转义序列而非裸字节，源码文件保持纯文本（grep / git diff
   * 都正常），运行时行为不变。
   */
  const SEP = '\u0000';
  const keyOf = (pluginId, sub) => `${pluginId}${SEP}${sub}`;
  const keyPrefix = (pluginId) => `${pluginId}${SEP}`;

  /* ---------------- 应用级快捷键 ---------------- */
  /** key: keyOf(pluginId, accel) */
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
    const k = keyOf(pluginId, accel);
    if (appShortcuts.has(k)) window.removeEventListener('keydown', appShortcuts.get(k).fn);
    const fn = (e) => {
      if (!accelMatches(e, accel)) return;
      e.preventDefault();
      e.stopPropagation();
      bus.emit(event, { accel, label, pluginId });
    };
    window.addEventListener('keydown', fn);
    // 顺手把 accel / pluginId 也存进值里：这样反向查表时不必再按分隔符
    // 拆字符串 —— 分隔符只用于「拼」，不用于「拆」，耦合就少一半。
    appShortcuts.set(k, { fn, event, label, accel, pluginId });
  }

  function unregisterAppShortcut(pluginId, accel) {
    const k = keyOf(pluginId, accel);
    const rec = appShortcuts.get(k);
    if (!rec) return;
    window.removeEventListener('keydown', rec.fn);
    appShortcuts.delete(k);
  }

  /** 插件卸载时清掉它注册的全部应用级快捷键 */
  function clearAppShortcuts(pluginId) {
    for (const [k, rec] of [...appShortcuts]) {
      if (!k.startsWith(keyPrefix(pluginId))) continue;
      window.removeEventListener('keydown', rec.fn);
      appShortcuts.delete(k);
    }
  }

  /* ---------------- 侧边栏注入条目 ---------------- */
  /** key: keyOf(pluginId, itemId) */
  const injectedItems = new Map();

  function addSidebarItem(pluginId, item) {
    if (!item?.id) return;
    const key = keyOf(pluginId, item.id);
    injectedItems.set(key, { ...item, pluginId });
    publishInjected();
  }

  function removeSidebarItem(pluginId, itemId) {
    injectedItems.delete(keyOf(pluginId, itemId));
    publishInjected();
  }

  function clearSidebarItems(pluginId) {
    let changed = false;
    for (const k of [...injectedItems.keys()]) {
      if (k.startsWith(keyPrefix(pluginId))) { injectedItems.delete(k); changed = true; }
    }
    if (changed) publishInjected();
  }

  function publishInjected() {
    hooks.onSidebarItems?.([...injectedItems.values()]);
  }

  /* ---- 错误边界 ---- */
  function showError(stage, manifest, err) {
    console.error(`[plugin:${manifest?.id}]`, err);
    stage.innerHTML = renderErrorBox(manifest, err);
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
      [...appShortcuts.values()].map((v) => [v.accel, { pluginId: v.pluginId, event: v.event, label: v.label }]),
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

/**
 * 渲染插件加载失败的错误框，返回 HTML 字符串。
 *
 * 单独抽出来是为了让测试能调真实渲染路径。此前 xss-test.mjs 里
 * 复刻了一份同样的模板 —— 于是它验的是自己那份拷贝：源码改了而
 * 测试没跟着改，测试照样全绿。这正是"插件名 XSS 连续三轮漏修"
 * 之所以能发生的结构性原因。现在只有这一处模板，改它就改了生产代码。
 *
 * 两个插值都来自插件清单（可由用户导入/编辑），因此都要转义：
 * 只转义 msg 不转义 name，等于把门锁了却留着一扇窗。
 *
 * @param {{name?: string, id?: string}} manifest
 * @param {unknown} err
 * @returns {string}
 */
export function renderErrorBox(manifest, err) {
  const msg = String(err?.stack || err?.message || err);
  const title = escapeHtml(manifest?.name || manifest?.id || '未知插件');
  return `
      <div class="err-box">
        <h3>⚠ 插件「${title}」加载失败</h3>
        <pre>${escapeHtml(msg)}</pre>
        <div class="row">
          <button class="p-btn primary" id="err-retry">重试</button>
          <button class="p-btn" id="err-back">返回概览</button>
        </div>
      </div>`;
}

/** 无构建模式下过滤掉需要编译器的插件（React/TSX） */
export function filterByRuntime(plugins) {
  return isNoBuild() ? plugins.filter((p) => !p.requiresBuild) : plugins;
}

export { isInsideTauri };
