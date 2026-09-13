export const BRIDGE_CHANNEL: string;

export interface PluginContext {
  /** 插件 id */
  id: string;
  /** 挂载模式 */
  mode: 'module' | 'iframe';
  manifest: PluginManifest;
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
 */
export const SHELL_SHORTCUTS: string[];
export function parseCombo(combo: string): { key: string; mod: boolean; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean } | null;
export function matchCombo(e: KeyboardEvent, spec: ReturnType<typeof parseCombo>): boolean;
export function isMac(): boolean;

export function bootIframePlugin(
  mountFn: (ctx: PluginContext) => Promise<(() => void) | void> | ((() => void) | void),
  settingsFn?: (ctx: PluginContext) => Promise<(() => void) | void> | ((() => void) | void),
): Promise<PluginContext>;

export function scopeCss(css: string, scope: string): string;
