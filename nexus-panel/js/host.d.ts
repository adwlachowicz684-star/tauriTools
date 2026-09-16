export interface PluginManifest {
  id: string;
  name: string;
  icon?: string;
  /** 'module' 同页挂载 | 'iframe' 沙箱挂载（默认） */
  type?: 'module' | 'iframe';
  /** 入口文件，相对项目根目录 */
  entry: string;
  version?: string;
  description?: string;
  /** module 模式下启用 Shadow DOM 样式隔离 */
  shadow?: boolean;
  builtin?: boolean;
  /** 需要构建工具（React / TSX）才能运行，无构建模式下自动隐藏 */
  requiresBuild?: boolean;
  custom?: boolean;
}

export interface HostHooks {
  toast?: (msg: string, type?: 'info' | 'ok' | 'err') => void;
  onTitle?: (text: string) => void;
  onSubtitle?: (text: string) => void;
  onBadges?: (badges: Record<string, number>) => void;
  onActive?: (id: string | null) => void;
  onNavigate?: (id: string) => void;
  onOpen?: (id: string) => void;
  /** 当前插件是否提供了自己的设置面板（决定「⚙ 设置」按钮显隐） */
  onSettingsAvailable?: (has: boolean) => void;
  /** iframe 插件把外壳保留键（mod+r / mod+b / mod+,）转发回来执行 */
  onShellShortcut?: (combo: string) => void;
  /** 插件内部被 CSP 拦下的外链（跨域事件外壳收不到，靠插件转发） */
  onCspViolation?: (info: { blockedURI: string; directive: string; view?: string }, manifest?: PluginManifest) => void;
  /** 插件往侧边栏注入的条目集合发生变化（增删时回调全量） */
  onSidebarItems?: (items: Array<{ id: string; pluginId: string; label: string; icon?: string; event: string; [k: string]: unknown }>) => void;
}

export interface Bus {
  on(event: string, handler: (payload?: any) => void): () => void;
  emit(event: string, payload?: any): void;
}

export interface HostState {
  plugins: PluginManifest[];
  activeId: string | null;
  badges: Record<string, number>;
  /**
   * 当前挂载中的插件实例（未挂载时为 null）。
   * 形如 { manifest, ctx, unmount, iframe, bridgeHandler, cleanupFns } —— 结构随挂载模式变化，
   * 只作调试观测用，业务代码不要依赖内部字段。
   */
  instance?: { manifest?: PluginManifest; [k: string]: unknown } | null;
  [k: string]: unknown;
}

export interface Host {
  state: HostState;
  bus: Bus;
  mount(id: string): Promise<void>;
  unmount(): Promise<void>;
  /**
   * 把插件自己的设置面板挂载到给定容器，返回 teardown。
   * module → 调 def.settings(ctx)；iframe → 开一个 view='settings' 的沙箱。
   */
  mountSettings(container: HTMLElement, manifest?: PluginManifest): Promise<() => void>;
  /** 当前插件是否声明了设置面板 */
  hasSettings(): boolean;
  win(action: 'minimize' | 'maximize' | 'close' | 'hide' | 'topmost'): Promise<void>;
  setBadge(id: string, n: number): void;
  readTheme(): Record<string, string>;
  getPlugins(): PluginManifest[];
  /** 已注册的应用级快捷键：accel → { pluginId, event, label } */
  getShortcuts(): Record<string, { pluginId: string; event: string; label?: string }>;
  /** 插件注入到侧边栏的条目 */
  getSidebarItems(): Array<{ id: string; pluginId: string; label: string; icon?: string; event: string; [k: string]: unknown }>;
  refresh(): Promise<PluginManifest[]>;
  removePlugin(id: string): void;
}

export function createHost(opts: {
  getStage: () => HTMLElement | null;
  hooks?: HostHooks;
}): Host;

export function createBus(): Bus;
/**
 * ✕ 的行为：'hide' 藏到托盘（默认）/ 'close' 真正退出。
 * 值存在 localStorage，跨会话保留。
 */
export type CloseAction = 'hide' | 'close';
export function getCloseAction(): CloseAction;
/** 传非 'close' 的值一律按 'hide' 处理；变化时会通知所有订阅者 */
export function setCloseAction(v: CloseAction): CloseAction;
/** 订阅变化，返回取消订阅的函数 */
export function onCloseActionChange(fn: (v: CloseAction) => void): () => void;

export function loadRegistry(): Promise<PluginManifest[]>;
export function getCustomPlugins(): PluginManifest[];
export function saveCustomPlugins(list: PluginManifest[]): void;
export function resolveEntry(entry: string): string;
export function readTheme(): Record<string, string>;
export function escapeHtml(s: string): string;
export function isNoBuild(): boolean;
export function filterByRuntime(plugins: PluginManifest[]): PluginManifest[];
export function isInsideTauri(): boolean;
export const THEME_VARS: string[];
