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
  /** 插件注入的侧边栏条目发生变化 */
  onSidebarItems?: (items: SidebarItem[]) => void;
}

/** 插件注入到外壳侧边栏的条目 */
export interface SidebarItem {
  id: string;
  pluginId: string;
  label: string;
  icon?: string;
  event: string;
}

export interface Bus {
  on(event: string, handler: (payload?: any) => void): () => void;
  emit(event: string, payload?: any): void;
}

export interface HostState {
  plugins: PluginManifest[];
  activeId: string | null;
  badges: Record<string, number>;
}

export interface Host {
  state: HostState;
  bus: Bus;
  getSidebarItems(): SidebarItem[];
  mount(id: string): Promise<void>;
  unmount(): Promise<void>;
  /**
   * 把插件自己的设置面板挂载到给定容器，返回 teardown。
   * module → 调 def.settings(ctx)；iframe → 开一个 view='settings' 的沙箱。
   */
  mountSettings(container: HTMLElement, manifest?: PluginManifest): Promise<() => void>;
  /** 当前插件是否声明了设置面板 */
  hasSettings(): boolean;
  win(action: 'minimize' | 'maximize' | 'close' | 'topmost'): Promise<void>;
  setBadge(id: string, n: number): void;
  readTheme(): Record<string, string>;
  getPlugins(): PluginManifest[];
  refresh(): Promise<PluginManifest[]>;
  removePlugin(id: string): void;
}

export function createHost(opts: {
  getStage: () => HTMLElement | null;
  hooks?: HostHooks;
}): Host;

export function createBus(): Bus;
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
