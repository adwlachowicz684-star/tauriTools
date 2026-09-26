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
/*
 * 焦点进入 iframe 后**外壳收不到任何键盘事件**（不跨文档冒泡），
 * 所以这些组合键要靠插件转发回来执行。
 *
 * 'esc' 在列的原因：元素检查器开着时，鼠标扫过 iframe 里的控件会把焦点
 * 带进插件，此时按 ESC 外壳根本收不到 —— 检查器就关不掉了。
 * 宿主侧只在"检查器开着"时才消费它，避免抢走插件自己的 ESC（关弹窗）。
 */
/* ctx.invoke 的命令白名单（默认拒绝）。详见该文件头部说明。 */
import { checkInvoke } from './invoke-policy.js';
/* Owned 归属通道：让"卸载干净"从约定变成结构性保证。详见该文件头部。 */
import { createOwned } from './owned.js';
import { claimPath, readClaims, releasePath } from './plugin-fs.js';

export const SHELL_SHORTCUTS = ['mod+b', 'mod+r', 'mod+,', 'esc'];

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
/* 内置服务的**薄封装**。
   底层仍是通用 call（第三方服务靠它接入），这里只给内置的几个服务
   补上类型化快捷方式，让调用方写起来更顺手、也不容易拼错 method。

   刻意保持"薄"：只做参数转换，不另起一套语义，也不隐藏 call ——
   调用方随时可以退回通用写法，第三方服务也不受影响。 */
function withBuiltinShortcuts(services) {
  const { call, list, available } = services;
  /*
   * 每个内置服务都补一个 `available()`。
   *
   * 为什么值得单独给：无构建模式下 color-picker（React/TSX,
   * requiresBuild）会被过滤掉，调用方若直接 pick() 会 throw。
   * 有了这个就能先问一句再降级：
   *
   *   if (!(await ctx.services.color.available())) {
   *     // 退化成 <input type="color"> 或直接跳过
   *   }
   */
  const whenAvailable = (id) => () => Promise.resolve(available ? available(id) : true);
  return {
    ...services,
    /*
     * 统一约定（三个内置服务一致，第三方服务也建议照此）：
     *
     *   resolve(值)   —— 用户选了
     *   resolve(null) —— **用户取消**（正常流程，不是错误）
     *   reject(错误)  —— 真出错（服务没装 / 挂载失败 / 超时 / 崩溃）
     *
     * 为什么取消不抛异常：取消是用户点了「取消」，是最常见的结果之一。
     * 用异常表达会让每个调用方都得写 try/catch 才能"一行调起"，
     * 漏了就是 unhandled rejection。
     *
     * 于是调用方可以这样，无需 try/catch：
     *   const r = await ctx.services.color.pick(initial, { custom: saved });
     *   if (r.hex) apply(r.hex);
     *   save(r.custom);          // 取消了也要存
     *
     * 只要颜色、不管收藏：
     *   const hex = await ctx.services.color.pickHex();
     */
    color: {
      /**
       * 打开取色面板。返回 `{ hex, custom }`。
       *
       * hex —— 选中的颜色，取消为 null。
       * custom —— 最新自定义色，**取消也要存**（用户可能刚收藏完就取消）。
       *
       * 传进来的 custom 会显示，返回的 custom 存起来，
       * 就能"下次打开还记住"，且各调用方互不干扰。
       */
      pick: (initial, opts) => call('color-picker', 'pick', { initial, ...(opts || {}) }),
      /**
       * 一行版：只关心颜色时用这个。
       * 内部取 PickResult.hex，丢掉 custom —— 需要记住自定义色就用 pick。
       */
      pickHex: async (initial, opts) =>
        ((await call('color-picker', 'pick', { initial, ...(opts || {}) })) || {}).hex ?? null,
      /** 归一化任意颜色输入，非法返回 null */
      normalize: (color) => call('color-picker', 'normalize', { color }),
      /** 列出 24 个预设色 */
      presets: () => call('color-picker', 'presets'),
      /** 取当前色的 HSV（调用方想自己画格子时用） */
      hsv: (color) => call('color-picker', 'hsv', { color }),
      /** 当前环境能否用（无构建模式下该服务不可用，见 N28） */
      available: whenAvailable('color-picker'),
    },
    icon: {
      /** 打开图标浏览面板，返回 { name, url }；取消返回 null */
      browse: (keyword) => call('icon-picker', 'browse', { keyword }),
      /** 只要清单 */
      list: () => call('icon-picker', 'list'),
      /** 名字 → URL */
      url: (name) => call('icon-picker', 'url', { name }),
      /** 当前环境能否用 */
      available: whenAvailable('icon-picker'),
    },
    md: {
      /** 打开编辑面板，返回编辑后的文本；取消返回 null */
      edit: (text, title) => call('md-editor', 'edit', { text, title }),
      /** 只要渲染结果（调用方自己做编辑框时用） */
      render: (text) => call('md-editor', 'render', { text }),
      /** 当前环境能否用 */
      available: whenAvailable('md-editor'),
    },
  };
}

function buildCtx(base) {
  const { id, manifest, mode, root, container, transport, bus, onDestroy, owned } = base;
  const destroyHooks = [];

  const ctx = {
    id,
    mode,                                  // 'module' | 'iframe'
    manifest,

    /*
     * openArgs —— 宿主**打开本插件时**带进来的参数（E2 入口）。
     *
     * 例：宿主/别的插件调 openWithArgs('md', { path: 'D:/a.md' })，
     * 插件挂载后 ctx.openArgs.path 就是那个路径。
     *
     * 为什么不能只靠 ctx.on(event)：
     *   事件总线是**同步**的 Map，插件必须挂载完成、on 过之后才收得到。
     *   而"打开时带参数"这件事发生在挂载**之前** ——
     *   先 mount 再 emit，插件订阅时那一发早已过去，永远收不到。
     *   所以挂载期的参数必须由宿主持有并塞进 ctx，不能走总线。
     *
     * 没有参数时是 null（不是 {}），让插件能区分"没带参数"和"带了空对象"。
     */
    openArgs: base.openArgs ?? null,

    /**
     * 已挂载之后再次收到新的打开参数。
     *
     * 走的是事件总线：那时插件已经挂载完成，顺序不再是问题。
     * 事件名带插件 id 做前缀 —— 总线是全局的，不带上 id
     * 会让所有插件都收到别人的打开参数。
     *
     * @param {(args: any) => void} handler
     * @returns {() => void} 取消订阅
     */
    onOpenArgs(handler) {
      return bus.on(`plugin:open-args:${id}`, handler, id);
    },
    /*
     * owned —— 归属通道。
     *
     * 所有"会污染宿主文档"的动作都该走它：
     *   ctx.owned.addListener(window, 'resize', fn)
     *   ctx.owned.addNode(document.body, modalEl)
     * 它当场记下归属，卸载时只撤本插件名下的，别的插件不受影响。
     *
     * iframe 插件也会拿到一份（保持 ctx 形状一致），
     * 但它记的是 iframe **自己** window 上的东西，
     * 随 iframe.remove() 一起消失 —— 记了也无害。
     */
    owned,
    /* 调用服务插件（kind:'service'）：
         await ctx.services.call('color-picker', 'pick', { from: '#3a7afe' })
       返回 Promise，拿到服务方法的返回值。

       两种通路，调用方写法完全一致：
         · 沙箱插件 —— 走桥接转发给宿主，宿主再转给服务 iframe。
           所以服务即使跑在另一个沙箱里也能被调用，隔离不影响能力。
         · 同页插件 —— 宿主直接注入（base.services），省掉消息往返。
           不注入就回退桥接，那时会报"未知请求"，错误信息明确。 */
    services: withBuiltinShortcuts(base.services || {
      call: (id, method, args) =>
        transport.request('service.call', { id, method, args }),
      list: () => transport.request('service.list', {}),
      /*
       * 沙箱通路：走桥接问宿主。
       * 与同页那条（宿主直接注入）返回类型一致 —— 都是 Promise<boolean>，
       * 调用方不用分叉。
       */
      available: (id) => transport.request('service.available', { id }),
    }),
    root,                                  // 挂载点：HTMLElement 或 ShadowRoot
    container,                             // 宿主元素（始终在文档流里）
    version: manifest.version || '0.0.0',

    /** 调用 Rust 命令；两种模式都可用 */
    async invoke(cmd, args = {}) {
      return transport.request('invoke', { cmd, args });
    },

    /**
     * 本地**绝对路径** → webview 能加载的 asset 协议地址。
     *
     * Rust 侧返回的图片路径是磁盘绝对路径（如 `C:\...\_imgs\xxx.png`），
     * 直接塞进 `<img src>` 会被当成相对 URL 而 404 —— 症状是缩略图**全部裂开**，
     * 且不报任何错。必须转成本地 asset 地址。
     *
     * 【为什么必须是同步的】
     * 调用方拿到返回值就直接拼进 DOM（`src="' + apiU(it.img) + '"`），
     * 返回 Promise 只会让 src 变成 [object Promise]。所以这里不走
     * `await getTauri()`，而是直接读全局注入的同步 API，读不到就自己拼。
     *
     * @param {string} filePath 磁盘绝对路径
     * @param {string} protocol 默认 'asset'
     * @returns {string}
     */
    convertFileSrc(filePath, protocol = 'asset') {
      const w = typeof window !== 'undefined' ? window : globalThis;
      const g = w.__TAURI_INTERNALS__;
      const fn = (g && g.convertFileSrc) || (w.__TAURI__ && w.__TAURI__.tauri && w.__TAURI__.tauri.convertFileSrc);
      if (typeof fn === 'function') {
        try {
          return fn(filePath, protocol);
        } catch {
          /* 落到下面自己拼 */
        }
      }
      /* 兜底：与 Tauri 的规则一致 —— Windows 上是 http://asset.localhost/… */
      const p = encodeURIComponent(filePath || '');
      const isWin = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');
      return isWin ? `http://${protocol}.localhost/${p}` : `${protocol}://${p}`;
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

    /*
     * 文件清单制（D3）—— 声明"这个文件/目录是我产出的"。
     *
     * DOM 残留能靠快照差分发现，**文件残留发现不了**：文件名不带
     * 来源信息，没有任何办法从磁盘现状反推归属。而卸载要清理就
     * 必须先回答归属，答错会删掉用户文件 —— 删错比不删更糟。
     * 所以只能事前声明。
     *
     * 用法：
     *   await ctx.fs.claim(outDir, { kind: 'dir', note: '缩略图缓存' });
     *   await ctx.fs.claims();            // 我自己声明过哪些
     *   await ctx.fs.release(path);       // 我删掉了，撤回声明
     *
     * 三种返回都是 Promise —— **沙箱模式走桥接、同页模式宿主直注**，
     * 形状必须一致，否则调用方要按模式分叉。
     *
     * claim 失败**不抛**：那只是"不再被记账"，不该让插件写不了文件。
     */
    fs: {
      claim: (path, meta = {}) => transport.request('fs.claim', { path, meta }),
      claims: () => transport.request('fs.claims', {}),
      release: (path) => transport.request('fs.release', { path }),
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
    /*
     * 切换到另一个插件，可带打开参数（E2 触发源）。
     *
     * 例：项目组里点一个 .md 文件 →
     *   await ctx.openPlugin('md', { path: 'D:/a.md' })
     * 目标插件挂载后 ctx.openArgs.path 就是那个路径。
     *
     * 【这里原先是 openPlugin(targetId) 只走 transport.notify('open')】
     * 那版三个问题：① 不带参数，E2 无从触发；
     *   ② notify 是"发出去不管"，没有返回值；
     *   ③ 更隐蔽的 —— 本轮一度在 ctx 里**另加了一份同名 openPlugin**，
     *      对象字面量里后者覆盖前者，注入的函数永远不被调用，
     *      表现为"调了没反应"且不报错。所以只保留**这一份**，
     *      再要加能力就改这里，不要另起同名键。
     *
     * 两条通路（与 services 同构）：
     *   · 同页 —— 宿主直接注入函数（base.openPlugin），不走消息
     *   · 沙箱 —— 桥接请求 'open-plugin'，由宿主校验后执行
     *
     * 外面套 Promise.resolve 是必须的：module 的 transport.request 是
     * **同步**返回，直接 .catch 会 TypeError（非 Promise 没有 catch），
     * 而调用方都在 await，抛出去就成了 unhandled rejection ——
     * 界面上只表现为"点了没反应"。
     *
     * 安全前提：这条能力**只允许内置插件**用，宿主会校验 manifest.builtin。
     * 否则第三方插件可以 openPlugin('md', { path: '任意文件' })，
     * 借 md 的 fpx_read_file（任意路径读取，不经 guard）把内容读出来 ——
     * 它自己没这条命令，却能借别人的白名单，是**提权**。
     *
     * @param {string} targetId 目标插件 id
     * @param {any} [args] 打开参数
     * @returns {Promise<boolean>} 宿主是否受理（不存在/被拒绝 = false）
     */
    openPlugin(targetId, args) {
      return Promise.resolve(
        base.openPlugin
          ? base.openPlugin(targetId, args)
          : transport.request('open-plugin', { id: targetId, args }),
      ).catch(() => false);
    },

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
      /**
       * 插件主题适配策略（读 + 写），同样在**主平台侧**执行。
       *
      /**
       * 窗口行为：点 ✕ 是"藏到托盘"还是"真正退出"。
       *
       * 走桥接的原因与主题/适配策略一致 —— 设置页在 Vite 模式下是 iframe，
       * 隔离态（opaque origin）下 localStorage 不可用，本地读写都会落空。
       * 而且这是**外壳窗口**的行为，本来就该由外壳持有，不该由插件各存一份。
       */
      window: {
        getCloseAction: () => transport.request('shell.call',
          { ns: 'window', method: 'getCloseAction', args: [] }),
        setCloseAction: (v) => transport.request('shell.call',
          { ns: 'window', method: 'setCloseAction', args: [v] }),
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
  services = null,              // 服务调用入口（宿主注入）；同页插件与宿主同文档，直连
  openArgs = null,              // 打开参数（E2）：宿主 mount(id, args) 带进来
  openPlugin = null,            // 跨插件打开（E2 触发源）；由宿主注入，见 host.js
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
          /*
           * 同页（module）插件与宿主**同文档**，理论上可以直接 import
           * tauri-core 绕过这里 —— 所以这层不是硬边界，是纵深防御：
           *   · 挡住"顺手调了没声明的命令"（绝大多数情况）
           *   · 让违规在开发期就暴露，而不是等到出事
           * 真正的硬边界在 iframe 侧（host.js 的 case 'invoke'）。
           */
          const v = checkInvoke(manifest?.id, payload?.cmd, manifest);
          if (!v.ok) throw new Error(v.reason);
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
          if (raw == null) return payload.def;
          // 存储可能被外部改写、或跨版本格式变了。单个键读不出就退默认值，
          // 不该让一次读取把调用方整体带崩。
          try { return JSON.parse(raw); } catch { return payload.def; }
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
          // 逐键 try：一个键坏掉不该让整份配置拿不到（此前会整体抛错）
          for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (!k || !k.startsWith(pre)) continue;
            try { out[k.slice(pre.length)] = JSON.parse(localStorage.getItem(k)); } catch { /* 跳过坏键 */ }
          }
          return out;
        }
        /*
         * 文件清单（D3）—— **同页模式必须自己实现这一支**。
         *
         * 这个 switch 没有 default 兜底（未命中会抛"未知请求"），
         * 所以 ctx.fs.* 在这里不加分支的话，同页插件调 claim 会
         * **抛错**，而 iframe 插件走宿主桥接却正常 ——
         * 同一个 API 两种模式行为不同，是最难排查的那类问题。
         *
         * 记账函数两边共用（js/plugin-fs.js），保证语义一致。
         */
        case 'fs.claim':
          return claimPath(manifest?.id, payload.path, payload.meta);
        case 'fs.claims':
          return readClaims(manifest?.id);
        case 'fs.release':
          return releasePath(manifest?.id, payload.path);
        default:
          throw new Error('未知请求: ' + method);
      }
    },
    notify(type, payload) { shellHooks?.[type]?.(payload); },
  };

  /*
   * Owned 归属句柄。
   *
   * 只发给**同页（module）插件** —— 它们与宿主同文档，
   * 挂在 window / document.body 上的东西不会随容器移除而消失，
   * 是残留的真正来源。
   *
   * 走通道 = 一定被记下 = dispose 一定撤；
   * 没走通道的由静态准入兜底。两者叠加才成立，缺一层都不完整。
   */
  const owned = createOwned(manifest.id, {
    warn: (...a) => console.warn('[owned]', ...a),
  });

  const ctx = buildCtx({
    id: manifest.id, manifest, mode: 'module', root, container,
    transport, bus, theme, bindShortcut, owned,
    services,   // 同页插件与宿主同文档，宿主直接注入，不必绕桥接
    openArgs,
    openPlugin, // 跨插件打开；同页由宿主注入，没注入时 buildCtx 会退到桥接
  });

  // 卸载时兜底注销所有快捷键，杜绝监听器残留
  const baseDestroy = ctx.__destroy;
  ctx.__destroy = async () => {
    shortcutCleanups.splice(0).forEach((off) => { try { off(); } catch {} });
    /*
     * owned 必须**先于** baseDestroy 撤销，且必须在 try 之外或最内层保证执行：
     * 插件自己漏掉的清理，靠这一步兜底。
     * 放在最前面：先撤它登记的句柄，再走插件自己的 unmount，
     * 避免插件 unmount 里用到已撤销的东西时状态不一致。
     */
    try { owned.dispose(); } catch (e) { console.error('[owned dispose]', e); }
    await baseDestroy();
  };
  return ctx;
}

/* ============================================================
   模式 B：沙箱 iframe 插件
   插件页面里调用 bootIframePlugin(async (ctx) => { ...; return unmount })
   ============================================================ */

/** 把外壳主题变量写进 iframe 的 :root（覆盖式更新，支持反复调用） */
/**
 * @param {object} vars     主题变量
 * @param {string} [base]   宿主给的权威基调（'light' | 'dark'），可省略
 */
function applyThemeVars(vars, base) {
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
  /*
   * 只看底色，不再额外要求 --text 存在。
   * 原写法 `vars['--text'] && isLightColor(...)`：--text 缺失时
   * **无论底色多亮都判成 dark** —— 用一个不相关变量的存在性去否决
   * 真正的判据，任何漏传 --text 的链路都会把浅色主题整体翻成深色，
   * 且不报错。isLightColor 自身已处理空值（返回 false → dark），
   * 这层门是多余的。
   */
  /*
   * 基调优先用宿主给的权威值（第二个参数，来自消息的 themeBase 字段）。
   *
   * 只在没有时才回退按 --bg 亮度推断：老版本宿主不传这个字段。
   * 为什么不能只靠推断 —— 用户可以在设置页只改基调、不动 --bg，
   * 此时 --bg 仍是深色值，推断会判成 dark 而面板实际是浅色，
   * 于是插件 CSS 里 [data-nexus-base="light"] 那一档永远匹配不上。
   *
   * ⚠️ 这里不能去引用外层消息对象 d —— 本函数只收 vars，
   * 引用 d 会是 ReferenceError（严格模式下整个 SDK 挂掉）。
   * 基调必须由调用方显式传进来。
   */
  const resolvedBase = (base === 'light' || base === 'dark')
    ? base
    : (isLightColor(vars['--bg']) ? 'light' : 'dark');
  document.documentElement.style.colorScheme = resolvedBase;
  /* 把基调也写成 data 属性，供插件 CSS 按基调切档。
     光有 colorScheme 不够：那是给浏览器原生控件用的，CSS 选择器读不到。
     而插件里常有些"品牌色的浅色变体"（错误文字、代码段…），
     它们在深色底上对比度很好，放到浅色底上只有 1.1~2.5 —— 基本看不见。
     这类色不能简单换成主题变量（失去品牌识别度），要按基调切两档，
     方括号选择器便可在浅色下换成加深版本：
         :root                     { --my-err: #ffb4b4; }   深色档
         [data-nexus-base="light"] { --my-err: #b91c1c; }   浅色档
     native 模式的插件不该吃这套（它固定深色），
     所以 agent-flow 的选择器是 [data-af-mode="follow"][data-nexus-base="light"]。 */
  try { document.documentElement.dataset.nexusBase = resolvedBase; } catch { /* 忽略 */ }
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
export function bootIframePlugin(mountFn, settingsFn, serviceMethods) {
  const channel = BRIDGE_CHANNEL;
  let pending = new Map();
  let seq = 0;
  let ctxReady;
  let resolveMount;
  let view = 'main';                 // 'main' | 'settings'
  let currentTheme = {};             // 外壳推来的主题变量，供 ctx.theme 读取
  let isolated = false;              // 是否处于功能隔离（去掉 allow-same-origin）
  let openArgs = null;               // 宿主打开本插件时带进来的参数（E2）
  let mounted = false;               // mount 只允许执行一次
  // 宿主的 origin，由 init 消息带过来，作为 postMessage 的 targetOrigin。
  //
  // 为什么需要：隔离态下本插件是 opaque origin，**读不到** parent 的 origin
  // （访问 parent.location 会抛 SecurityError），而 postMessage 的
  // targetOrigin 又必须精确匹配才能送达。所以只能由宿主自报。
  // 拿不到时（老版宿主不带此字段）回退 '*'，否则整个桥接会断。
  let hostOrigin = '*';
  const mountPromise = new Promise((r) => (resolveMount = r));

  function post(msg) {
    window.parent.postMessage({ channel, ...msg }, hostOrigin);
  }

  /* ---------------------------------------------------------------
     元素检查器：把本 iframe 内的鼠标位置转发回外壳
     ---------------------------------------------------------------
     鼠标在本 iframe 上时，事件归本 iframe 的文档所有，
     外壳**一个也收不到**（事件不跨文档冒泡）—— 于是外壳那边
     的 elementFromPoint 永远拿不到 iframe，插件里的一切都选不中。

     所以由插件自己监听，把位置转发回去，外壳再拿这个坐标去
     本 iframe 的 document 上做命中。坐标不用换算：
     这里给的本来就是本 iframe 视口里的 clientX/clientY。
     --------------------------------------------------------------- */
  let stopInspectRelay = null;
  function setInspectRelay(on) {
    stopInspectRelay?.();
    stopInspectRelay = null;
    if (!on) return;

    /* 节流到每帧一次：mousemove 每秒能触发上百次，
       每条都 postMessage 会白白吃掉主线程。检查器用不着那么高的采样率。 */
    let raf = 0;
    const onMove = (e) => {
      if (raf) return;
      const x = e.clientX, y = e.clientY;
      raf = requestAnimationFrame(() => {
        raf = 0;
        post({ type: 'inspect-move', x, y });
      });
    };
    /* 点击必须**同步**阻止：外壳的回应是异步的（postMessage 往返），
       等它回来再 preventDefault 已经晚了，按钮早就被真的触发了。 */
    const onClick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      post({ type: 'inspect-click', x: e.clientX, y: e.clientY });
    };

    window.addEventListener('mousemove', onMove, true);
    window.addEventListener('click', onClick, true);
    stopInspectRelay = () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', onMove, true);
      window.removeEventListener('click', onClick, true);
    };
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.channel !== channel) return;
    /* 来源校验：只认宿主窗口（iframe 的唯一父窗口）。
       缺了它，同域任意窗口（含被注入的脚本、另一个标签页）都能伪造
       init / mount / theme 消息，冒充宿主与插件对话。
       用 e.source 而不是 e.origin：隔离态下本插件与宿主都可能是
       opaque origin，origin 字符串无从比较，而窗口引用是精确的。
       项目里 plugins/mindmap/editor-bridge.js 已是这个写法。 */
    if (e.source !== window.parent) return;

    // 主题初始化 / 运行时切换（切换主题无需重载插件）
    if (d.type === 'init' || d.type === 'theme') {
      if (d.type === 'init') {
        var { manifest } = d;
        view = d.view || 'main';                 // 本次要渲染哪个视图
        if (d.hostOrigin) hostOrigin = d.hostOrigin;
        /*
         * 打开参数：与 module 模式同一份语义（见 buildCtx 里 openArgs 的说明）。
         * iframe 端由 init 消息带过来，挂载时塞进 ctx。
         * 少了这一环会出现"同页插件拿得到参数、沙箱插件拿不到"，
         * 正是注释里反复提的那种最难排查的问题。
         */
        if ('openArgs' in d) openArgs = d.openArgs ?? null;
      } else {
        manifest = manifest || d.manifest;
      }
      // 把主题变量写到 iframe 的 :root，保证视觉与外壳一致
      if (d.theme) {
        currentTheme = d.theme;
        applyThemeVars(d.theme, d.themeBase);
        /* 回执：告诉外壳"新变量已落地"，pushTheme 正在等这条消息。
           不回的话外壳只能等超时兜底（400ms）才 resolve。
           d.theme 为空时不回 —— 没写任何变量，谈不上"已生效"。 */
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
        openArgs,
      });

      // 卸载时兜底注销
      const baseDestroy = ctx.__destroy;
      ctx.__destroy = async () => {
        shortcutCleanups.splice(0).forEach((off) => { try { off(); } catch {} });
        stopInspectRelay?.();
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

    /* 检查器开关。新挂载的插件（比如打开设置抽屉才挂的设置面板）
       会在 mounted 后收到一条，见 host.js 里的广播。 */
    if (d.type === 'inspect') {
      setInspectRelay(!!d.on);
      return;
    }

    if (d.type === 'res') {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      d.ok ? p.resolve(d.data) : p.reject(new Error(d.error));
    }

    /* 服务调用：宿主转发别的插件发来的 ctx.services.call(...)。
       方法表由 bootServicePlugin 传入；普通插件没传，这里会回"未提供"。

       必须**回一条消息**（无论成败）：调用方在等 res，
       漏回会让它一直挂到超时（15s），而用户看到的就是"点了没反应"。

       第二个参数把 ctx 交给服务方法 —— 服务同样需要 store / invoke /
       shell 这些能力（比如色盘要记住用户最近用过的颜色）。 */
    if (d.type === 'service.call') {
      const reply = (ok, data, error) =>
        post({ type: 'service.res', id: d.id, ok, data, error });
      const fn = serviceMethods?.[d.method];
      if (typeof fn !== 'function') {
        reply(false, null, `服务未提供方法: ${d.method}`);
        return;
      }
      Promise.resolve()
        .then(() => fn(d.args, ctxReady))
        .then((data) => reply(true, data, null))
        .catch((err) => reply(false, null, String(err?.message || err)));
      return;
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
 * 服务插件引导（kind:'service'）
 *
 * 与 bootIframePlugin 的区别：
 *   · 不渲染业务 UI —— 它是"被调用"的，不是"被浏览"的
 *   · 用一张方法表代替 mount 函数
 *
 * 外壳收到别的插件的 ctx.services.call(id, method, args) 时，
 * 会转发一条 service.call 消息进来，SDK 在这张表里找到对应方法执行。
 *
 * 方法签名：(args, ctx) => value | Promise<value>
 *   · args —— 调用方传的参数对象
 *   · ctx  —— 本服务自己的上下文（store / invoke / shell 都可用）
 *
 * 返回值会被送回调用方。**抛出即失败**：调用方的 await 会 reject，
 * 所以错误信息要写清楚，那是调用方能看到的唯一线索。
 */
export function bootServicePlugin(methods) {
  /* 仍然走 bootIframePlugin：握手、主题、桥接、ctx 构造全部复用，
     只是 mount 时什么都不渲染 —— 服务没有"主视图"这个概念。 */
  return bootIframePlugin(
    async () => {
      /* 服务不需要渲染。但完全不写点东西的话，外壳的"空页面快速失败"
         检测（body 无子节点）会把服务误判成坏插件并报错 ——
         所以入口 HTML 里放了一行说明文字，这里不再动 DOM。 */
    },
    null,
    methods,
  );
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
