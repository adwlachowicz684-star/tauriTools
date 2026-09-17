/**
 * 插件宿主引擎（与 UI 框架无关）
 * ------------------------------------------------------------
 * 原生外壳（js/shell.js）与 React 外壳（src/App.tsx）共用这一份引擎，
 * 保证两种技术栈下插件行为完全一致。
 */

import { getTauri, isInsideTauri } from './tauri-core.js';
/* ctx.invoke 的命令白名单。此前是无条件透传（插件可调任意后端命令），
   它是文件残留与安全上最大的口子，嵌合后会进一步放大。 */
import { checkInvoke } from './invoke-policy.js';
/* 卸载残留校验（只读 · 不阻断 · 同步）。见该文件头部说明。 */
import { snapshotGlobals, auditUnmount } from './unmount-audit.js';
/* 元素检查器：iframe 内的鼠标事件收不到（不跨文档冒泡），
   靠插件转发坐标回来，再由这两个函数去 iframe 自己的文档里命中。
   引入它们而不是走事件，是因为需要同步读取"检查器是否开着"。 */
import { isInspectorOn, moveInIframe, clickInIframe } from './inspector.js';
import { createModuleContext, BRIDGE_CHANNEL } from './plugin-sdk.js';
/* 同页插件入口加载器：Vite 构建下走 import.meta.glob，
   否则原来的动态 import 在无构建模式才不会被构建期丢掉。 */
import { loadModuleEntry } from './plugin-entries.js';
import { installAdapter } from './theme-normalizer.js';
import * as normalizer from './theme-normalizer.js';
import { getPluginConfig } from './plugin-config.js';
import * as pluginConfig from './plugin-config.js';
import * as extPolicy from './external-policy.js';
import {
  initTheme, exportVars, exportVarsFor, findTheme,
  onChange as onThemeChange,
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

/* -------------------- 关闭窗口的行为 -------------------- */

const CLOSE_ACTION_KEY = 'nexus:close-action';

/**
 * 点标题栏 ✕ 时做什么：
 *   'hide'  → 藏到托盘（默认。进程还在，靠托盘唤回）
 *   'close' → 真正退出
 *
 * 默认取 hide：装了托盘之后，"关闭"还把进程杀掉就与托盘的存在相矛盾 ——
 * 用户既然能从托盘唤回，就说明这个应用是常驻型的。
 * 但仍要给用户选退出的权利：有人就是希望 ✕ 等于退出。
 *
 * 值只认这两种，其它一律回退默认 —— 手改 localStorage 不该把按钮变哑
 * （点下去什么都不发生比报错更难发现）。
 */
function readCloseAction() {
  try {
    return localStorage.getItem(CLOSE_ACTION_KEY) === 'close' ? 'close' : 'hide';
  } catch { return 'hide'; }
}

let closeAction = readCloseAction();
const closeActionHooks = new Set();

export function getCloseAction() {
  return closeAction;
}

/** 设置 ✕ 的行为；返回实际生效的值 */
export function setCloseAction(v) {
  const next = v === 'close' ? 'close' : 'hide';
  if (next === closeAction) return closeAction;
  closeAction = next;
  try { localStorage.setItem(CLOSE_ACTION_KEY, closeAction); } catch { /* 无妨 */ }
  // 通知外壳刷新 ✕ 的提示文案，否则按钮还写着旧行为
  for (const fn of closeActionHooks) {
    try { fn(closeAction); } catch (e) { console.error('[closeAction hook]', e); }
  }
  return closeAction;
}

export function onCloseActionChange(fn) {
  closeActionHooks.add(fn);
  return () => closeActionHooks.delete(fn);
}

const windowApi = {
  getCloseAction,
  setCloseAction,
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

  /* ---- 服务插件运行时（kind:'service'） ----
     服务不进侧边栏，用户不直接打开；它们被挂到一个隐藏的常宿容器里，
     由任意插件通过 ctx.services.call(id, method, args) 调用。

     两个关键点：

     ① **必须真实挂到 DOM**。iframe 只有在文档里才会加载运行，
        所以容器要"藏"而不是"不插入" —— 用移出视口的方式，
        不用 display:none（部分浏览器对完全隐藏的 iframe 会延迟/跳过加载）。

     ② **懒加载 + 并发去重**。服务可能有十几个，启动时全挂会很慢；
        谁被调才挂谁。首次调用会并发到达（多个插件同时要色盘），
        所以挂载中的 Promise 存在表里，后来者直接复用，不重复挂载。 */
  const serviceHost = document.createElement('div');
  serviceHost.id = 'nexus-service-host';
  serviceHost.setAttribute('aria-hidden', 'true');
  /* 两种状态：
     · 常驻（默认）—— 移出视口。iframe 只有在文档里才会加载运行，
       所以用"看不见"而不是 display:none（后者部分浏览器会延迟/跳过加载）。
     · 交互（调 interactive 服务时临时切）—— 居中浮层 + 遮罩，
       服务画出的色盘/图标面板才看得见、点得着。 */
  const SERVICE_HIDDEN_CSS =
    'position:absolute;left:-99999px;top:0;width:400px;height:300px;overflow:hidden;pointer-events:none;';
  const SERVICE_SHOWN_CSS =
    'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);' +
    'width:min(560px,90vw);height:min(420px,80vh);z-index:9999;' +
    'background:var(--surface,#222);border:1px solid var(--edge,#444);' +
    'border-radius:8px;box-shadow:0 12px 40px rgba(0,0,0,.45);overflow:hidden;';
  serviceHost.style.cssText = SERVICE_HIDDEN_CSS;
  (opts.serviceHostParent || document.body).appendChild(serviceHost);

  /* 交互服务弹出时的遮罩。单独建一个元素而不是给容器加 ::before ——
     容器尺寸/定位两种状态完全不同，伪元素跟着变会很难调。 */
  const serviceMask = document.createElement('div');
  serviceMask.id = 'nexus-service-mask';
  serviceMask.style.cssText =
    'display:none;position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.45);';
  (opts.serviceHostParent || document.body).appendChild(serviceMask);

  /** 显示/隐藏交互服务的浮层 */
  function showServiceUi(on) {
    serviceHost.style.cssText = on ? SERVICE_SHOWN_CSS : SERVICE_HIDDEN_CSS;
    serviceMask.style.display = on ? '' : 'none';
    serviceHost.setAttribute('aria-hidden', on ? 'false' : 'true');
    // 焦点交给服务里的 iframe，否则键盘操作（如 Esc、输入框）落在主文档
    if (on) {
      try {
        serviceHost.querySelector('iframe')?.contentWindow?.focus();
      } catch { /* 隔离态拿不到 contentWindow，忽略 */ }
    }
  }
  /* 点遮罩 = 取消。没有它，用户想放弃只能找服务自己的取消按钮，
     而有些服务（比如只画了格子没放按钮的）就没给退路。 */
  serviceMask.addEventListener('click', () => showServiceUi(false));

  /** id -> { promise, instance } */
  const services = new Map();

  function serviceManifest(id) {
    return state.plugins.find((p) => p.id === id && p.kind === 'service');
  }

  async function ensureService(id) {
    const existing = services.get(id);
    if (existing) return existing;

    const manifest = serviceManifest(id);
    if (!manifest) throw new Error(`未找到服务插件: ${id}`);

    const entry = {
      promise: (async () => {
        const box = document.createElement('div');
        box.style.cssText = 'width:100%;height:100%;';
        serviceHost.appendChild(box);
        const inst = manifest.type === 'iframe'
          ? await mountIframeView(box, manifest, null, 'service')
          : await mountModule(box, manifest, null);
        if (!inst) throw new Error(`服务插件挂载失败: ${id}`);
        entry.instance = inst;
        return inst;
      })(),
      instance: null,
    };
    services.set(id, entry);
    return entry;
  }

  /** 供调试/面板使用：列出已声明的服务（未挂载的也列出） */
  function listServices() {
    return state.plugins
      .filter((p) => p.kind === 'service')
      .map((p) => ({ id: p.id, name: p.name, icon: p.icon, description: p.description,
                     version: p.version, mounted: services.has(p.id) }));
  }

  /**
   * 调用服务插件的方法。
   *
   * 两种挂载形态走不同通路，但调用方写法完全一致：
   *   · iframe 服务 —— 发 service.call 消息，等它的 service.res
   *   · module 服务 —— 直接调 def.methods[method]，省掉消息往返
   *
   * 服务**懒加载**：谁被调才挂谁。启动就把十几个服务全挂起来会很慢，
   * 而多数服务整场可能一次都用不到。
   */
  async function callService(id, method, args) {
    const entry = await ensureService(id);
    const inst = await entry.promise;
    if (typeof method !== 'string' || !method) {
      throw new Error('服务方法名不能为空');
    }
    /* 交互服务（registry 里标 interactive:true）要先把它显示出来 ——
       色盘、图标选择这类服务**必须用户看得见才用得了**，
       而服务平时挂在移出视口的容器里。

       用 try/finally 保证无论成功/失败/取消都收回浮层：
       漏收会留一块永远盖在界面上的遮罩，只能刷新页面。 */
    const interactive = !!inst.manifest?.interactive;
    if (interactive) showServiceUi(true);
    try {
      return await dispatchServiceCall(inst, id, method, args);
    } finally {
      if (interactive) showServiceUi(false);
    }
  }

  async function dispatchServiceCall(inst, id, method, args) {
    if (inst.iframe) {
      if (typeof inst.callService !== 'function') {
        throw new Error(`服务实例不支持调用: ${id}`);
      }
      return inst.callService(method, args);
    }
    // module 服务：方法表挂在 def.methods 上
    const fn = inst.def?.methods?.[method];
    if (typeof fn !== 'function') {
      throw new Error(`服务 ${id} 未提供方法: ${method}`);
    }
    return fn(args, inst.ctx);
  }

  const setBadge = (id, n) => {
    state.badges[id] = n || 0;
    hooks.onBadges?.({ ...state.badges });
  };

  /* ---- 加载 / 卸载 ---- */
  async function mount(id) {
    const manifest = state.plugins.find((p) => p.id === id);
    /* 服务插件不该被用户直接打开：它没有主视图，打开是空白。
       拦在这里而不是只靠侧边栏不显示 —— 侧边栏只是 UI，
       快捷键、恢复上次插件等路径都可能绕过它。 */
    if (manifest?.kind === 'service') {
      await unmount();
      state.activeId = null;
      const stage0 = getStage();
      if (stage0) {
        stage0.innerHTML = `<div class="nx-empty lg"><div class="nx-empty-mark">◈</div>
          <p>「${manifest.name}」是服务插件，供其它插件调用，不能直接打开</p></div>`;
      }
      hooks.onActive?.(null);
      return;
    }
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
      /* .nx-empty.lg = 全屏大空态（居中 + 图标），.nx-empty-mark 是那个圆形图标。
         两者都在 css/controls.css 里，外壳不再自己写一套 */
      stage.innerHTML = `<div class="nx-empty lg"><div class="nx-empty-mark">◈</div>
        <p>左侧选择一个插件，或点击 ＋ 安装新插件</p></div>`;
      return;
    }

    const token = Symbol(id);
    state.mounting = token;
    /* 加载覆盖层：盖在插件之上，插件显形时淡出，失败时给错误框让位。
       不能用 stage.innerHTML 直接写 —— 挂载 iframe 时会清 innerHTML，
       那样提示当场就没了，而插件还要等适配完成才显形。 */
    stage.innerHTML = '';
    const dismiss = showLoading(stage, manifest);

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
          // 插件自选了主题后，它看到的"面板基调"就是那套的基调。
          // 不传的话 installAdapter 会取全局基调 → 深浅判断反 → 滤镜加反。
          panelBase: baseForPlugin(manifest.id),
        };
        await reAdapt(instance);
      } else if (instance) {
        hooks.onAdaptInfo?.({ adapted: false, reason: 'adapt-disabled' });
      }
      /* 显形放在适配之后：滤镜挂上之前 iframe 是「白底未适配」的样子，
         此刻摘遮罩就等于把那帧白放给用户看。
         适配关掉时也要显形 —— 那是用户的选择，不是没走到这一步。 */
      revealFrame(instance?.iframe);
      // iframe 插件由 revealFrame 顺带收掉加载层；同页插件（module）没有
      // iframe，得在这里自己收，否则它会一直盖着已就绪的插件
      dismiss();

      // 告诉外壳：这个插件有没有自己的设置面板（决定要不要显示「⚙ 设置」）
      hooks.onSettingsAvailable?.(instance ? hasSettings(instance) : false);
    } catch (err) {
      /* err.frameInfo 由 mountIframeView 在 iframe 还在时抓的现场快照，
         取出来单独传给错误框 —— 它不属于 Error 的标准字段，
         直接透传会让 formatDiagnostics 把它当成普通对象展开。 */
      if (state.mounting === token) showError(stage, manifest, err, err?.frameInfo);
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
      // 抽屉里同样先盖一层加载层：设置页也是独立文档，一样有那段空窗期
      const dismissSettings = showLoading(container, manifest);
      let inst;
      try {
        inst = await mountIframeView(container, manifest, null, 'settings');
      } catch (e) { dismissSettings(true); throw e; }
      inst.adaptInput = {
        manifest, wrap: inst.wrap, target: inst.target,
        root: null, isIframe: true,
      };
      await reAdapt(inst);
      // 与主视图同理：等适配滤镜挂上再摘遮罩，否则抽屉里也会闪一下白
      revealFrame(inst?.iframe);
      dismissSettings();
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

    /*
     * module 入口加载。
     *
     * 原先直接 `import(/* @vite-ignore *\/ entry)`，而 @vite-ignore 会让
     * Vite 跳过静态分析 → 产物里没有该 chunk → 运行时 404。
     * 这也是"Vite 模式下同页插件不可用"的根因。
     *
     * 现在走 loadModuleEntry：Vite 构建下用 import.meta.glob 的懒加载器
     * （构建期已展开并重写路径），无构建模式退回动态 import（行为不变）。
     */
    const mod = await loadModuleEntry(manifest.entry);
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

    /*
     * 卸载残留校验。
     *
     * **只在最前/最后各拍一张快照，中间不改任何流程** ——
     * 这是"安全不影响功能"的关键：校验是只读的观察，
     * 不做清理、不抛错、不 await，因此不可能阻断或拖慢卸载。
     *
     * before 必须在任何 await 之前拍：一旦进入 await，
     * 其它并发流程（切插件、主题重算）就可能已经改了全局，
     * 快照baseline 就脏了。
     */
    const auditBefore = snapshotGlobals();

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

    /* 末尾同步跑，永不 throw（auditUnmount 内部已全包 try）。
       不放进上面的 try：它是独立的一步，失败也不该影响任何既有清理。 */
    auditUnmount(inst.manifest?.id, auditBefore);
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
      /*
       * 同页入口：走 loadModuleEntry（构建期 glob），
       * 而不是直接 @vite-ignore 动态 import —— 后者在 Vite 产物里
       * 不生成 chunk，会 404。详见 plugin-entries.js 头部。
       */
      mod = await loadModuleEntry(manifest.entry);
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
      services: {
        call: (id, method, args) => callService(id, method, args),
        list: () => listServices(),
      },
    });

    stage.innerHTML = '';
    stage.appendChild(wrap);

    /* 插件自选主题：同页插件与外部共享主文档的 :root，没有自己的文档，
       所以只能把变量写到它自己的容器上（CSS 变量向下继承，只影响这个子树）。
       iframe 插件走 init/theme 消息，用不到这里。
       注意要在 mount 前写：插件挂载时可能立刻读变量做初始化配色。 */
    applyThemeVarsTo(container, varsForPlugin(manifest.id));

    const result = await def.mount(ctx);
    return { manifest, def, ctx, wrap, target: container, root: container,
             unmount: typeof result === 'function' ? result : null, iframe: null };
  }

  /* ---- 模式 B：沙箱 iframe 插件（默认） ----
     view='main' 主视图；view='settings' 渲染插件自己的设置面板
     （设置面板复用同一个入口页面，只是 init 时告知 SDK 走 settings 分支） */
  /**
   * 让插件 iframe 显形（配合 .plugin-frame 的 opacity:0 初始值）。
   *
   * 时机很关键：必须在**主题变量推完 + 适配滤镜挂上之后**调用，
   * 提前了就会把「白底未适配」的那一帧放出来 —— 深色面板下切插件
   * 闪一下刺眼的白，就是这个窗口。
   *
   * 重复调用无害（classList.add 幂等），所以调用方不用自己记状态。
   */
  function revealFrame(iframe) {
    try { iframe?.classList?.add('revealed'); } catch { /* iframe 已销毁 */ }
    /* 插件已经显形，加载层该退场了。
       从 iframe 往上找到宿主容器再清，这样连 900ms 兜底显形那条路径
       也会自动把加载层收掉，不必在每个调用点各写一遍。 */
    try {
      const hostEl = iframe?.closest?.('.plugin-wrap')?.parentElement;
      if (hostEl) dismissLoading(hostEl);
    } catch { /* iframe 已销毁 */ }
  }

  /** 兜底显形：适配卡住（插件报错、握手超时）时也不能让插件永远隐身 */
  function armRevealFallback(iframe, delay = 900) {
    const timer = setTimeout(() => revealFrame(iframe), delay);
    return () => clearTimeout(timer);
  }

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
    const t0 = performance.now?.() ?? Date.now();
    wrap.appendChild(iframe);
    liveFrames.add(iframe);

    const cleanupFns = [];
    // 事件订阅登记表（见 case 'subscribe' 的说明）
    const subs = [];
    let bridgeHandler = null;
    let hasSettings = false;
    let handshaked = false;          // 每个 iframe 实例只握手一次
    // 握手阶段就要写 reportedBase，此时完整实例还没构造出来，先放一个可变壳
    const inst0 = {};
    /* 本 iframe 实例私有的"服务调用等待表"：id -> 回包处理函数。
       挂载 iframe 服务时用它接收 service.res。 */
    const serviceCalls = new Map();

    /* iframe 现场快照：失败时随错误一起带到错误框里。
       必须在 iframe 还在的时候抓 —— 出错后 wrap 会被移除，届时只剩一个
       被 detach 的 iframe，"有没有 load 过"这类运行时状态就丢了。 */
    let loadedAt = null;
    const frameSnapshot = () => {
      try {
        const r = {
          'iframe src': iframe.getAttribute('src') || iframe.src || '(空)',
          sandbox: iframe.getAttribute('sandbox') || '(无)',
          隔离态: iframe.dataset.isolated === '1' ? '是' : '否',
          已加载: loadedAt ? `是（耗时 ${loadedAt}ms）` : '否',
          已握手: handshaked ? '是' : '否',
        };
        /* 同源（非隔离）时能读到内部文档，补充最能说明问题的两项：
           页面到底渲染出东西没有、内部有没有自己报错。 */
        try {
          const doc = iframe.contentDocument;
          if (doc) {
            r['内部节点数'] = String(doc.body?.childElementCount ?? '(无 body)');
            r['内部标题'] = doc.title || '(无)';
          } else r['内部文档'] = '读不到（隔离态或尚未解析）';
        } catch { r['内部文档'] = '读不到（跨源限制）'; }
        return r;
      } catch { return { 说明: '快照失败' }; }
    };

    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const e = new Error('iframe 插件握手超时（10s）');
        try { e.frameInfo = frameSnapshot(); } catch { /* 别让快照失败淹了真错 */ }
        reject(e);
      }, 10000);

      /**
       * 空页面快速失败。
       *
       * 握手超时是 10s，这 10 秒里 iframe 已经在屏上了，看到的就是它自己的
       * 底色（已改为 --bg，见 .plugin-frame）——不刺眼，但**什么都没有**，
       * 用户不知道是"加载中"还是"坏了"。这里在 load 之后再看一眼：
       * 页面确实渲染出了内容就放行，一个节点都没有就立刻报错，把主题化的
       * 错误框顶上去，不必干等到 10s。
       *
       * 判空只认"body 一个子元素都没有"。正常插件的 HTML 里至少有挂载点
       * （<div id="root">），React/Vue 挂载前后 body 都不是空的，所以不会误伤。
       * 隔离态拿不到 contentDocument，读不到就跳过（那种情况只能等超时）。
       */
      let emptyCheck = null;
      const onLoad = () => {
        if (loadedAt === null) {
          try { loadedAt = Math.round(performance.now() - t0); } catch { loadedAt = -1; }
        }
        if (handshaked || emptyCheck) return;
        emptyCheck = setTimeout(() => {
          if (handshaked) return;
          let empty = false;
          try {
            const doc = iframe.contentDocument;
            empty = !doc || !doc.body || (doc.body.childElementCount === 0
              && !doc.body.textContent.trim());
          } catch { return; }        // 隔离态（opaque origin）读不到，放弃检测
          if (empty) {
            const e = new Error('插件页面没有渲染出内容 —— 入口文件可能缺失，或该插件需要先执行构建');
            try { e.frameInfo = frameSnapshot(); } catch { /* 同上 */ }
            reject(e);
          }
        }, 1500);
        cleanupFns.push(() => clearTimeout(emptyCheck));
      };
      iframe.addEventListener('load', onLoad);
      cleanupFns.push(() => iframe.removeEventListener('load', onLoad));

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
              // 插件可能自选了主题（见 varsForPlugin）；没有则等同全局
              type: 'init', manifest, theme: varsForPlugin(manifest.id), view,
              isolated,                         // 插件据此决定能力探测方式
              /* 让插件自报基调。两种场景：
                 1) 隔离插件 —— 外壳读不到 contentDocument，采样会静默失败
                 2) followsTheme 插件 —— 它自己跟随面板主题，基调该由它说了算。
                    外壳采样反而会误判：变量已推过去、界面已变浅，
                    但采样仍可能读到残留深色区域判成 dark，于是施加 invert
                    把已变浅的部分二次翻转（"变白一秒后又变黑"）。
                 上报值用 sampleOwnBase() 读插件自己的 body 背景：
                 follow 模式 → 等于面板基调 → 不加滤镜；
                 native 模式 → 固定深色 → 该加就加。 */
              reportBase: (isolated || !!manifest.followsTheme) && adaptTheme,
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
            /* 新挂载的 iframe 要立刻同步检查器状态 ——
               设置面板正是"打开抽屉才挂载"的，少了这句它就永远收不到通知。 */
            if (isInspectorOn()) {
              try { send(iframe, { type: 'inspect', on: true }); } catch {}
            }
            d.ok ? resolve() : reject(new Error(d.error));
            break;
          case 'error':
            clearTimeout(timeout);
            reject(new Error(d.error));
            break;
          case 'req':
            handleBridgeRequest(manifest, iframe, d);
            break;
          /* iframe 内的鼠标位置（见 broadcastInspect 的说明）。
             x/y 是插件**自己视口**里的坐标，正好能直接喂给它的
             document.elementFromPoint，不需要换算。 */
          case 'inspect-move':
            moveInIframe(iframe, d.x, d.y);
            break;
          case 'inspect-click':
            clickInIframe(iframe, d.x, d.y);
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
          /* 服务调用的回包。
             由 serviceCalls 表（本 iframe 实例私有）里的 id 找回等待者。
             注意这里是**实例私有**的表：每个服务 iframe 各自一份，
             id 只在自己这条桥接上有意义，混用会串台。 */
          case 'service.res':
            serviceCalls.get(d.id)?.(d);
            serviceCalls.delete(d.id);
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

    /* 清掉上一次的插件 DOM，但**保留加载覆盖层**（.plugin-loading）。
       以前这里是无条件 innerHTML = ''，加载提示当场被抹掉，
       而 iframe 还要等主题变量推入 + 适配滤镜挂上才淡入 ——
       中间那段就是一片没有内容的底色，看着像卡死。 */
    for (const n of [...hostEl.children]) {
      if (!n.classList.contains('plugin-loading')) n.remove();
    }
    hostEl.appendChild(wrap);

    /* 兜底显形：mounted 之后无论后面适配成功与否，最多 900ms 一定显示。
       没有它，reAdapt 抛错或插件自报基调迟迟不来时，插件会一直隐身。 */
    cleanupFns.push(armRevealFallback(iframe));

    /* 卸载时注销，否则 liveFrames 会一直持有已移除的 iframe：
       既泄漏，又会在广播时给一个没内容的窗口发消息。 */
    cleanupFns.push(() => liveFrames.delete(iframe));

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
      serviceCalls,
      /** 向本 iframe 服务发一次调用，等它的 service.res */
      callService(method, args) {
        const id = `svc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        return new Promise((resolve, reject) => {
          /* 超时必须清理，否则 promise 永远悬着 ——
             调用方 await 不到结果，界面就那么卡着，没有任何提示。 */
          const timer = setTimeout(() => {
            serviceCalls.delete(id);
            reject(new Error(`服务调用超时: ${manifest.id}.${method}（15s）`));
          }, 15000);
          serviceCalls.set(id, (d) => {
            clearTimeout(timer);
            d.ok ? resolve(d.data) : reject(new Error(d.error || '服务调用失败'));
          });
          send(iframe, { type: 'service.call', id, method, args });
        });
      },
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

  /* ---------------------------------------------------------------
     元素检查器：把开关状态广播给所有 iframe 插件
     ---------------------------------------------------------------
     鼠标在 iframe 上时主文档收不到 mousemove/click，所以必须让插件
     自己在内部监听并转发坐标回来。

     两个时机都要覆盖，缺一个就会出现"某些 iframe 查不了"：
       · 检查器开关时 —— 广播给当前所有已挂载的 iframe
       · iframe 新挂载时 —— 设置面板是打开抽屉才挂的，
         若检查器已经开着，它必须一挂上就收到通知
     --------------------------------------------------------------- */
  const liveFrames = new Set();

  function broadcastInspect(on) {
    for (const f of liveFrames) {
      try { send(f, { type: 'inspect', on: !!on }); } catch { /* 已卸载 */ }
    }
  }

  /* 监听检查器开关。用事件而不是让 inspector 反向依赖 host，
     保持"引擎不知道 UI"的方向不变。 */
  document.addEventListener('nexus:inspector-toggle', (e) => {
    broadcastInspect(!!e.detail?.on);
  });

  /** iframe 插件的桥接服务端：转发 invoke / store 等请求 */
  async function handleBridgeRequest(manifest, iframe, d) {
    const reply = (ok, data, error) => send(iframe, { type: 'res', id: d.id, ok, data, error });
    try {
      const { method, payload } = d;
      switch (method) {
        case 'invoke': {
          const tauri = await getTauri();
          if (!tauri) throw new Error('当前不在 Tauri 环境中');
          /*
           * 白名单校验：**必须**在真正 invoke 之前。
           *
           * 此前这里是无条件透传 —— cmd 完全由插件传入，
           * 于是插件能调后端全部 47 个命令，包括 fs_op（写删文件）、
           * run_node（拉子进程）、af_fs_allow_root（给自己授权目录 = 提权）。
           * 这是文件残留与安全上最大的口子。
           */
          const verdict = checkInvoke(manifest.id, payload?.cmd);
          if (!verdict.ok) {
            /* 拒绝时也要回包，不能只是抛错不回 ——
               调用方在等 res，漏回会让它挂到超时，界面表现为"点了没反应"。 */
            return reply(false, null, verdict.reason);
          }
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
        /* 服务调用：沙箱插件 → 宿主 → 服务 iframe。
           宿主居中转发是必要的：服务跑在自己的沙箱里，调用方拿不到它的
           contentWindow，只能靠宿主这条已知的桥接通道。 */
        case 'service.call': {
          const data = await callService(payload.id, payload.method, payload.args);
          return reply(true, data);
        }
        case 'service.list':
          return reply(true, listServices());
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
            : ns === 'normalizer' ? normalizerApi
            : ns === 'window' ? windowApi : null;
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

  /* ---- 加载覆盖层 ---- */

  /**
   * 盖一层「正在加载…」。
   *
   * 它是**覆盖在插件之上**的兄弟节点，不是插件的替代品：
   * 插件在下面照常加载渲染，加载层只负责在它显形之前挡住那片空底色。
   * 这样成功时只是淡出（插件已经就绪，不会闪），失败时才换成错误框。
   *
   * 底层色必须是 --bg（不透明）：下面那个 iframe 在适配完成前是 opacity:0，
   * 但它的 --bg 底板仍然在 —— 加载层若半透明就会与之叠出奇怪的颜色。
   *
   * @returns {Function} 幂等的移除函数（成功 / 失败 / 切插件都会调）
   */
  function showLoading(hostEl, manifest) {
    if (!hostEl) return () => {};
    const el = document.createElement('div');
    /* 同时挂 .nx-loading：基础表现（全屏覆盖、居中、淡出）在
       css/controls.css 里，.plugin-loading 只留外壳自己的 .loading-inner
       与 .loading-done 两处差异。只挂一个类会丢掉那一整层基础样式。 */
    el.className = 'nx-loading plugin-loading';
    el.innerHTML = `
      <div class="loading-inner">
        <div class="spinner"></div>
        <span class="loading-text">正在加载 <span class="loading-name">${
          escapeHtml(manifest?.name || manifest?.id || '插件')
        }</span>…</span>
      </div>`;
    hostEl.appendChild(el);

    // 加载超过 3s 再补一句，避免用户以为卡死了 ——
    // 此时多半是在等首次构建产物，或插件脚本抛错了正走向握手超时
    const slow = setTimeout(() => {
      const t = el.querySelector('.loading-text');
      if (t) t.insertAdjacentHTML('beforeend',
        '<br><span style="opacity:.75">首次加载可能较慢，若长时间无响应请检查是否已执行构建</span>');
    }, 3000);

    let gone = false;
    return function dismiss(immediate = false) {
      if (gone) return;
      gone = true;
      clearTimeout(slow);
      if (!el.isConnected) return;
      if (immediate) { el.remove(); return; }
      el.classList.add('loading-done');
      // 淡出后再摘：立刻 remove 会让底下刚显形的插件"跳"一下
      setTimeout(() => el.remove(), 240);
    };
  }

  /** 清掉容器里的加载层（切插件 / 卸载时用，不关心返回值） */
  function dismissLoading(hostEl, immediate = false) {
    if (!hostEl) return;
    for (const n of hostEl.querySelectorAll('.plugin-loading')) {
      if (immediate) n.remove();
      else if (!n.classList.contains('loading-done')) {
        n.classList.add('loading-done');
        setTimeout(() => n.remove(), 240);
      }
    }
  }

  /* ---- 错误边界 ---- */
  function showError(stage, manifest, err, extra) {
    console.error(`[plugin:${manifest?.id}]`, err);
    dismissLoading(stage, true);        // 立即摘掉，别挡着错误框

    /* 诊断信息要在**清掉 DOM 之前**抓：err 里的堆栈此刻最完整，
       而 iframe 相关的现场（src / sandbox）马上就要随 wrap 一起没了。 */
    let diag = null;
    try { diag = collectDiagnostics(manifest, err, extra); } catch { /* 诊断失败不影响报错 */ }
    if (diag) console.error(`[plugin:${manifest?.id}] 诊断报告\n` + formatDiagnostics(diag));

    stage.innerHTML = renderErrorBox(manifest, err, diag);
    stage.querySelector('#err-retry').onclick = () => mount(manifest?.id);
    stage.querySelector('#err-back').onclick = () => hooks.onOpen?.('home') ?? mount('home');

    /* 复制 / 导出：把完整报告带走，方便贴 issue 或发给开发者 */
    const body = stage.querySelector('#err-diag-body');
    if (body) {
      const btnCopy = stage.querySelector('#err-copy');
      const btnExport = stage.querySelector('#err-export');
      btnCopy.onclick = async () => {
        const ok = await copyText(body.textContent || '');
        hooks.toast?.(ok ? '诊断日志已复制' : '复制失败，请手动选中日志区复制', ok ? 'ok' : 'err');
      };
      btnExport.onclick = async () => {
        /* 桌面对话框需要 fs/dialog 插件，本项目没启用（Cargo.toml 里只有
           http + shell），所以导出走的是 web 的 Blob + a.download。
           各平台 webview 对下载的支持并不一致，被拦下来时不能默默失败 ——
           回落到复制，至少内容不会丢。 */
        try {
          const name = downloadText(body.textContent || '', diagnosticsFilename(manifest));
          hooks.toast?.(`已导出 ${name}`, 'ok');
        } catch {
          const ok = await copyText(body.textContent || '');
          hooks.toast?.(
            ok ? '导出被环境拦截，已改为复制到剪贴板' : '导出失败，请手动选中日志区复制',
            ok ? 'ok' : 'err');
        }
      };
    }
  }

  /* ---- 窗口控制 ---- */
  async function win(action) {
    const tauri = await getTauri();
    if (!tauri) { hooks.toast?.('浏览器调试模式：窗口控制不可用', 'err'); return; }
    try { await tauri.invoke('window_action', { action }); }
    catch (e) { hooks.toast?.('窗口控制失败：' + e, 'err'); }
  }

  /**
   * 把当前主题重新推给一个已加载的插件实例，并**等它应用完**再返回。
   *
   * 两条路都要覆盖：
   * - iframe 插件走 postMessage。必须等它回执 —— 推完立刻去采样会读到旧主题
   *   的颜色，基调误判，于是施加本不该有的反转。
   * - 同页插件重刷容器上的内联变量。它继承 :root，改 :root 也会带过去，
   *   但插件自选主题时容器上的值优先级更高，不刷新就一直沿用旧的那套。
   *
   * 主题变化与插件配置变化共用这一条路：两者的后果完全一样，
   * 「插件该用哪套变量」的答案变了。
   */
  async function syncThemeToInstance(inst) {
    if (!inst) return;
    if (inst.iframe) {
      await pushTheme(inst.iframe, inst.manifest?.id);
    } else if (inst.root) {
      applyThemeVarsTo(inst.root, varsForPlugin(inst.manifest?.id));
    }
    await reAdapt(inst);
  }

  // 主题：初始化并联动（iframe 推送新变量，无需重载；适配结果重算）
  initTheme();
  onThemeChange(() => syncThemeToInstance(state.instance));

  // 插件自选主题改完立刻生效，不必重载。
  // 只认当前活跃插件：别的插件此刻没加载，等它被加载时自己会算一遍。
  pluginConfig.onPluginConfigChange?.((id) => {
    const inst = state.instance;
    if (!inst || inst.manifest?.id !== id) return;
    syncThemeToInstance(inst);
  });

  /**
   * 把新主题推给 iframe 插件，并**等它确认已应用**再返回。
   *
   * 这一步不能省：postMessage 是异步的，如果推完立刻去采样插件颜色，
   * 读到的还是旧主题的颜色 → 基调误判 → 施加本不该有的反转。
   * SDK 应用完变量会回 theme-applied；老插件不回就靠超时兜底。
   */
  function pushTheme(iframe, pluginId) {
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
        send(iframe, { type: 'theme', theme: varsForPlugin(pluginId) });
      } catch { finish(); }
    });
  }

  return {
    state, bus, mount, unmount, mountSettings, win, setBadge,
    hasSettings: () => hasSettings(state.instance),
    /* 点 ✕ 的行为（'hide' | 'close'）。外壳**在点击时**才取，
       所以设置页改完立即生效，不用重启。 */
    getCloseAction,
    setCloseAction,
    onCloseActionChange,
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

/* -------------------- 插件自选主题 -------------------- */

/**
 * 该插件自己指定的主题；没有则返回 null（表示跟随全局）。
 *
 * 规则：按**全局当前基调**在插件的两套之间选 ——
 *   全局是深色 → 用插件的 themeDark；全局是浅色 → 用 themeLight。
 * 所以插件只跟随"深浅"这一档，不跟随用户在同基调里换哪套主题。
 *
 * 两个防御都不能省：
 *   · 基调必须对得上。配置里存的是"深色用哪套"，就不能在浅色下生效，
 *     否则用户把某套深色主题误选进浅色槽，浅色面板上会突然冒出一块深色。
 *   · findTheme 兜底拿不到（自定义主题被删）时返回 null 跟随全局，
 *     不让一个失效的配置把插件变量变成空对象。
 */
export function resolvePluginTheme(pluginId) {
  if (!pluginId) return null;
  let cfg;
  try { cfg = getPluginConfig(pluginId); } catch { return null; }
  const base = themeManager.getBase();
  const want = base === 'light' ? cfg.themeLight : cfg.themeDark;
  if (!want) return null;
  const t = findTheme(want);
  if (!t || t.base !== base) return null;
  return t;
}

/** 该插件实际要用的主题变量（未指定时等同全局）。 */
export function varsForPlugin(pluginId) {
  const t = resolvePluginTheme(pluginId);
  return t ? exportVarsFor(t) : exportVars();
}

/**
 * 该插件实际表现出的基调。
 *
 * 供主题适配使用：适配要的是"插件看到的面板是什么基调"。
 * 插件自选了主题后，它看到的就是那套的基调，而不是全局的 ——
 * 若这里还返回全局基调，深浅判断会反，滤镜会加反。
 */
export function baseForPlugin(pluginId) {
  const t = resolvePluginTheme(pluginId);
  return t ? t.base : themeManager.getBase();
}

/**
 * 把主题变量写到容器元素上（module 模式专用）。
 *
 * 同页插件与外部共享主文档的 :root，**没有自己的文档**，
 * 所以"插件用别的主题"不能靠改 :root，只能把变量写到它自己的容器上 ——
 * CSS 变量会向下继承，正好只影响这个插件的子树。
 * iframe 插件有独立文档，走 init/theme 消息即可，用不到这个。
 */
export function applyThemeVarsTo(el, vars) {
  if (!el?.style) return;
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
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
 * 收集排错所需的上下文。
 * --------------------------------------------------------------------
 * 插件加载失败时，光有 `err.message` 通常不够判断：
 *   · 同一个插件在别人机器上正常 —— 差在构建产物、隔离策略还是主题？
 *   · 「握手超时」到底是插件没 build，还是沙箱把它拦了？
 *   · 「页面空白」是入口路径写错，还是无构建模式下加载了 TSX？
 * 这些都得靠环境信息才能定位，所以这里把相关状态一次性抓全。
 *
 * 设计上刻意**全部包 try/catch**：诊断代码本身绝不能抛出新错误，
 * 否则用户会看到一个"收集诊断信息失败"的报错，把真正的错误盖掉。
 *
 * @param {{id?:string,name?:string,type?:string,entry?:string}} manifest
 * @param {unknown} err
 * @param {object} [extra] 调用方补充的现场信息（如 iframe 的 src / sandbox）
 * @returns {object} 结构化诊断对象
 */
export function collectDiagnostics(manifest, err, extra = {}) {
  const pick = (fn, fallback = '(未知)') => {
    try { const v = fn(); return v == null || v === '' ? fallback : v; }
    catch { return '(读取失败)'; }
  };

  const cfg = pick(() => (manifest?.id ? getPluginConfig(manifest.id) : null), null);
  const th = pick(() => themeManager.getCurrent?.(), null);

  return {
    meta: {
      时间: pick(() => new Date().toISOString()),
      页面: pick(() => location.href),
      UA: pick(() => navigator.userAgent),
      视口: pick(() => `${window.innerWidth}×${window.innerHeight}`
        + ` (DPR ${window.devicePixelRatio || 1})`),
      语言: pick(() => navigator.language),
    },
    runtime: {
      运行形态: pick(() => (isInsideTauri() ? 'Tauri 桌面端' : '浏览器')),
      构建模式: pick(() => (isNoBuild() ? '无构建（直接使用源码）' : '已构建')),
      协议: pick(() => location.protocol),
      插件数量: pick(() => String(state.plugins?.length ?? 0), '0'),
    },
    plugin: {
      名称: pick(() => manifest?.name),
      ID: pick(() => manifest?.id),
      类型: pick(() => (manifest?.type === 'iframe' ? 'iframe 沙箱' : '同页 module')),
      入口: pick(() => manifest?.entry),
      解析后入口: pick(() => (manifest?.entry ? resolveEntry(manifest.entry) : null)),
      版本: pick(() => manifest?.version, '(未声明)'),
      内置: pick(() => (manifest?.builtin ? '是' : '否')),
      需要构建: pick(() => (manifest?.requiresBuild ? '是' : '否')),
    },
    config: cfg ? {
      功能隔离: cfg.isolated ? '开启（不可访问 parent/localStorage）' : '关闭（同源直连）',
      主题适配: cfg.adaptTheme ? '开启' : '关闭',
      深色策略: cfg.themeDark || '(跟随全局)',
      浅色策略: cfg.themeLight || '(跟随全局)',
      适配策略: pick(() => normalizer.resolvePolicy?.(manifest?.id) ?? '(未取到)', '(未取到)'),
    } : { 说明: '无插件配置（manifest 缺少 id）' },
    theme: th ? {
      主题: pick(() => `${th.name} (${th.id})`),
      基调: pick(() => th.base),
      风格: pick(() => th.style || '(未声明)'),
      强调色: pick(() => themeManager.getAccent?.(), '(未设置)'),
      环境色: pick(() => themeManager.getEnvColor?.(), '(未设置)'),
      色相偏移: pick(() => String(themeManager.getHueShift?.(th.id) ?? 0)),
      明暗偏移: pick(() => String(themeManager.getLightShift?.(th.id) ?? 0)),
    } : { 说明: '主题未初始化' },
    // iframe 现场：由 mountIframeView 传入，只在 iframe 插件失败时才有
    frame: Object.keys(extra).length ? extra : null,
    error: {
      类型: pick(() => err?.constructor?.name || (typeof err), typeof err),
      名称: pick(() => err?.name, '(无)'),
      消息: pick(() => err?.message || String(err), '(无)'),
      堆栈: pick(() => err?.stack, '(无堆栈)'),
    },
  };
}

/**
 * 把诊断对象格式化成可复制 / 可导出的纯文本。
 *
 * 用 `键: 值` 的对齐排版而不是 JSON，因为这份内容是**给人读**的
 * （贴到 issue 里、发给别人看），JSON 的引号和转义在这种场景里很碍眼。
 */
export function formatDiagnostics(diag) {
  const out = [];
  const LABEL = {
    meta: '环境', runtime: '运行时', plugin: '插件',
    config: '插件配置', theme: '主题', frame: 'iframe 现场', error: '错误',
  };
  const width = (k) => [...k].reduce((n, c) => n + (c.charCodeAt(0) > 127 ? 2 : 1), 0);
  out.push('='.repeat(56));
  out.push('Nexus Panel 插件加载失败诊断报告');
  out.push('='.repeat(56));
  for (const [sec, obj] of Object.entries(diag)) {
    if (!obj) continue;
    out.push('');
    out.push(`【${LABEL[sec] || sec}】`);
    const keys = Object.keys(obj);
    const w = Math.max(...keys.map(width));
    for (const k of keys) {
      out.push(`  ${k}${' '.repeat(Math.max(0, w - width(k)))} : ${String(obj[k])}`);
    }
  }
  out.push('');
  out.push('='.repeat(56));
  return out.join('\n');
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
export function renderErrorBox(manifest, err, diag) {
  const msg = String(err?.stack || err?.message || err);
  const title = escapeHtml(manifest?.name || manifest?.id || '未知插件');
  /* 诊断报告：默认折叠，因为大部分用户只关心"重试能不能好"，
     一大坨环境信息糊在脸上反而挡住了那行错误。
     需要排查的人（或要贴给开发者时）再展开。 */
  const report = escapeHtml(diag ? formatDiagnostics(diag) : '');
  return `
      <div class="err-box">
        <h3>⚠ 插件「${title}」加载失败</h3>
        <pre>${escapeHtml(msg)}</pre>
        <div class="row">
          <button class="p-btn primary" id="err-retry">重试</button>
          <button class="p-btn" id="err-back">返回概览</button>
        </div>
        ${report ? `
        <details class="err-diag">
          <summary>诊断日志（环境 / 插件配置 / 主题 / 堆栈）</summary>
          <div class="err-diag-actions">
            <button class="p-btn" id="err-copy">复制</button>
            <button class="p-btn" id="err-export">导出 .log</button>
          </div>
          <pre class="err-diag-body" id="err-diag-body">${report}</pre>
        </details>` : ''}
      </div>`;
}

/**
 * 把文本放进剪贴板。
 *
 * navigator.clipboard 有两个会踩的前提：
 *   1. 需要安全上下文（https / localhost）—— 用 file:// 打开时不成立
 *   2. 需要文档处于焦点 —— 弹窗刚渲染时未必满足
 * 任一不满足都会 reject，所以必须回落到 execCommand（老 API 但在
 * 非安全上下文里仍可用）。两种都不行就让用户手动选中。
 *
 * @returns {Promise<boolean>} 是否成功
 */
export async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* 落到下面的兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // 不能 display:none —— 那样选不中。挪到视口外即可
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0;';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/**
 * 触发文件下载。
 *
 * @returns {string} 实际使用的文件名
 */
export function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 立刻 revoke 会让部分浏览器来不及取数据，留一帧
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return filename;
}

/** 诊断报告的文件名：带上插件 id 与时间，便于在多份报告里分辨 */
export function diagnosticsFilename(manifest) {
  const id = (manifest?.id || 'plugin').replace(/[^a-zA-Z0-9_-]/g, '_');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `nexus-error-${id}-${ts}.log`;
}

/** 无构建模式下过滤掉需要编译器的插件（React/TSX） */
export function filterByRuntime(plugins) {
  return isNoBuild() ? plugins.filter((p) => !p.requiresBuild) : plugins;
}

/**
 * 侧边栏该显示哪些插件 —— 即排除服务插件（kind:'service'）。
 *
 * 单独抽出来是因为**有多条路径**要做这个判断：侧边栏渲染、
 * 恢复上次打开的插件、快捷键切换……只在一处过滤的话，
 * 别的路径迟早会把服务塞进主舞台。
 */
export function visiblePlugins(plugins) {
  return (plugins || []).filter((p) => p.kind !== 'service');
}

/** 是否是服务插件 */
export function isService(p) {
  return p?.kind === 'service';
}

export { isInsideTauri };
