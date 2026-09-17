export const BRIDGE_CHANNEL: string;

/**
 * Owned 归属句柄。
 *
 * 所有"会污染宿主文档"的动作都该走它 —— 它当场记下归属，
 * 卸载时**只撤本插件名下的**，别的插件不受影响。
 *
 * 为什么需要：卸载靠插件自己 push cleanupFns，漏一个就漏一片；
 * 而事后差分只能看到"总量变了"，说不清是谁留的。
 * 走通道 = 一定被记下 = dispose 一定撤。
 */
export interface Owned {
  /** 归属插件 id */
  readonly pluginId: string;

  /** 通用：自己提供撤销函数。所有专用方法都是它的语法糖。 */
  addUndo(capability: string, undo: () => void): () => void;

  /** 在宿主全局目标（window / document / body）上挂监听 */
  addListener(
    target: EventTarget,
    type: string,
    handler: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): () => void;

  /** 往宿主文档挂节点（浮层 / portal / 弹窗） */
  addNode(parent: Node, node: Node): () => void;

  /** 定时器句柄（kind: 'interval' | 'raf'） */
  addTimer(kind: 'interval' | 'raf', id: number): () => void;

  setInterval(fn: () => void, ms: number): number;
  setTimeout(fn: () => void, ms: number): number;

  /** 动态样式（挂到 document.head） */
  addStyle(node: Node): () => void;

  /** 带 disconnect / close 的句柄：Observer、WebSocket、BroadcastChannel… */
  addHandle(capability: string, handle: { disconnect?: () => void; close?: () => void }): () => void;

  /** 撤销全部。**幂等** —— 重复调用安全。 */
  dispose(): { undone: number; failed: number };

  /** 用到了哪些能力（供 manifest.capabilities 交叉校验） */
  capabilities(): string[];

  size(): number;
  isDisposed(): boolean;
}

export interface PluginContext {
  /** 插件 id */
  id: string;
  /** 挂载模式 */
  mode: 'module' | 'iframe';
  manifest: PluginManifest;
  /**
   * 归属通道。**同页（module）插件必用** ——
   * 它与宿主同文档，挂在 window / body 上的东西不会随容器移除而消失，
   * 是残留的真正来源。
   *
   * iframe 插件也会拿到（保持 ctx 形状一致），
   * 但它记的是 iframe 自己 window 上的东西，随 iframe 一起消失。
   */
  owned: Owned;
  /** 挂载点：HTMLElement 或 ShadowRoot */
  root: HTMLElement | ShadowRoot;
  /** 宿主元素（始终在文档流里） */
  container: HTMLElement;
  version: string;

  /** 调用 Rust 命令 */
  invoke<T = any>(cmd: string, args?: Record<string, any>): Promise<T>;

  /** 插件间事件总线，返回取消函数 */
  on(event: string, handler: (payload?: any) => void): () => void;
  /** 广播事件给其他插件 */
  emit(event: string, payload?: any): void;

  /** 监听 Rust 推送的事件（仅 module 模式） */
  listenTauri(event: string, handler: (payload?: any) => void): Promise<() => void>;

  /** 插件级持久化 KV */
  store: {
    get<T = any>(k: string, def?: T): Promise<T>;
    set(k: string, v: any): Promise<boolean>;
    del(k: string): Promise<boolean>;
    all(): Promise<Record<string, any>>;
  };

  /**
   * 服务插件调用（kind:'service'）。
   *
   * `call` 是通用入口 —— 第三方服务靠它接入，新增服务不用改 SDK。
   * 下面几个是**内置服务的薄封装**，只做参数转换、不另起语义：
   * 用起来顺手，但随时可以退回 call 写法。
   */
  services: {
    call(id: string, method: string, args?: Record<string, any>): Promise<any>;
    list(): Promise<Array<{ id: string; name: string; mounted: boolean }>>;
    /*
     * 统一约定（三个内置服务一致，第三方服务也建议照此）：
     *   resolve(值)   —— 用户选了
     *   resolve(null) —— **用户取消**（正常流程，不抛异常）
     *   reject(错误)  —— 真出错（服务没装 / 挂载失败 / 超时 / 崩溃）
     *
     * 于是调用方无需 try/catch 就能一行调起：
     *   const r = await ctx.services.color.pick({ initial, custom: saved });
     *   if (r.hex) apply(r.hex);
     *   save(r.custom);          // 取消了也要存
     *
     * 只要颜色、不管收藏：
     *   const hex = await ctx.services.color.pickHex();
     */
    /** 取色服务 */
    color: {
      /**
       * 打开取色面板。
       *
       * 返回 `{ hex, custom }`：
       *   · hex —— 选中的颜色，取消为 null
       *   · custom —— 最新自定义色，**取消也要存**（用户可能刚收藏完就取消）
       *
       * 调用方把自己的 custom 传进来、把返回的 custom 存起来，
       * 就能"下次打开还记住"，且各调用方互不干扰。
       */
      pick(initial?: string | null, opts?: {
        /** 给了就实时广播拖动中的颜色（默认不需要：色盘自己的预览块就在变） */
        previewEvent?: string;
        /** 允许返回 null 表示"清除颜色" */
        allowNull?: boolean;
        /** 自定义常用色：传进来 → 显示；返回时 → 存起来 */
        custom?: string[];
        /** 覆盖默认 24 个预设色 */
        preset?: string[];
      }): Promise<{ hex: string | null; custom: string[] }>;
      /** 只要颜色、不管自定义色时用这个（一行版） */
      pickHex(initial?: string | null, opts?: {
        previewEvent?: string; allowNull?: boolean; custom?: string[]; preset?: string[];
      }): Promise<string | null>;
      /** 归一化任意颜色输入，非法返回 null */
      normalize(color: string): Promise<string | null>;
      /** 24 个预设色 */
      presets(): Promise<string[]>;
      /** 取当前色的 HSV（想自己画格子时用） */
      hsv(color?: string): Promise<{ h: number; s: number; v: number }>;
    };
    /** 图标选择服务 */
    icon: {
      /** 打开浏览面板，返回 { name, url }；**取消返回 null** */
      browse(keyword?: string): Promise<{ name: string; url: string } | null>;
      list(): Promise<string[]>;
      url(name: string): Promise<string>;
    };
    /** Markdown 编辑服务 */
    md: {
      /** 打开编辑面板，返回编辑后的文本；**取消返回 null** */
      edit(text?: string, title?: string): Promise<string | null>;
      /** 只要渲染结果 */
      render(text: string): Promise<string>;
    };
  };

  /** 修改内容区标题 */
  setTitle(text: string): void;
  /** 侧边栏角标，0/null 清除 */
  setBadge(n: number | null): void;
  /** 轻提示 */
  toast(msg: string, type?: 'info' | 'ok' | 'err'): void;
  /** 重新加载本插件 */
  reload(): void;
  /** 跳转到另一个插件 */
  openPlugin(id: string): void;
  /** 注册应用级快捷键（窗口前台即生效）；命中后外壳在总线上发 event */
  registerShortcut(accel: string, event: string, label?: string): void;
  unregisterShortcut(accel: string): void;
  /** 往外壳侧边栏注入条目；点击后外壳在总线上发 event */
  addSidebarItem(item: { id: string; label?: string; icon?: string; event?: string; [k: string]: unknown }): void;
  removeSidebarItem(itemId: string): void;

  /** 注入样式（module 模式自动加作用域前缀），返回移除函数 */
  addStyle(css: string): () => void;
  /** 注册卸载回调 */
  onDestroy(fn: () => void | Promise<void>): void;
  /** 主题变量快照 */
  theme: Record<string, string>;
}

export interface PluginManifest {
  id: string;
  name: string;
  icon?: string;
  type?: 'module' | 'iframe';
  entry: string;
  version?: string;
  description?: string;
  shadow?: boolean;
  builtin?: boolean;
  requiresBuild?: boolean;
  custom?: boolean;
}

export interface PluginDefinition {
  name?: string;
  version?: string;
  mount(ctx: PluginContext): void | Promise<void | (() => void)>;
  /** 插件自己的设置面板（可选）；声明后外壳标题栏出现「⚙ 设置」 */
  settings?(ctx: PluginContext): void | Promise<void | (() => void)>;
  [k: string]: any;
}

export function definePlugin(def: PluginDefinition): PluginDefinition;

/** h('div.p-card', { onclick }, ...children) */
export function h(
  sel: string,
  props?: Record<string, any> | null,
  ...children: any[]
): HTMLElement;

/**
 * iframe 插件引导
 * bootIframePlugin(mainFn)              —— 只有主视图
 * bootIframePlugin(mainFn, settingsFn)  —— 额外提供设置面板
 * bootIframePlugin(mountFn, settingsFn, serviceMethods) —— 服务插件专用，
 *   第三个参数注册方法表，供宿主 ctx.services.call 调进来。
 *
 * 注意：第三个参数**JS 实现早就支持**，但声明里一直没写，
 * 导致 TS 侧（nexus-react.tsx 的 bootServiceReactPlugin）传 3 个参数报
 * TS2554。声明落后于实现会让"其实能跑"的代码看起来是错的。
 */
export const SHELL_SHORTCUTS: string[];
export function parseCombo(combo: string): { key: string; mod: boolean; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean } | null;
export function matchCombo(e: KeyboardEvent, spec: ReturnType<typeof parseCombo>): boolean;
export function isMac(): boolean;

export function bootIframePlugin(
  mountFn: (ctx: PluginContext) => Promise<(() => void) | void> | ((() => void) | void),
  settingsFn?: (ctx: PluginContext) => Promise<(() => void) | void> | ((() => void) | void) | null,
  /** 服务插件（kind:'service'）的方法表；普通插件不传 */
  serviceMethods?: Record<string, (args: any, ctx: PluginContext) => Promise<any> | any>,
): Promise<PluginContext>;

export function scopeCss(css: string, scope: string): string;
