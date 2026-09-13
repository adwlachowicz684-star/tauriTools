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
  /** 插件注入的侧边栏条目发生变化 */
  onSidebarItems?: (items: SidebarItem[]) => void;
  /** 插件注册的快捷键发生变化 */
  onShortcuts?: (shortcuts: Record<string, { pluginId: string; event: string; label: string }>) => void;
}

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
  mount(id: string): Promise<void>;
  unmount(): Promise<void>;
  registerShortcut(pluginId: string, accel: string, event: string, label?: string): boolean;
  unregisterShortcut(accel: string): boolean;
  addSidebarItem(pluginId: string, item: { id: string; label: string; icon?: string; event: string }): boolean;
  removeSidebarItem(pluginId: string, itemId: string): boolean;
  releasePluginRegistrations(pluginId: string): void;
  getShortcuts(): Record<string, { pluginId: string; event: string; label: string }>;
  getSidebarItems(): SidebarItem[];
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
