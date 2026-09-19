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
  /**
   * 本插件允许调用的后端命令（白名单的**插件自带**部分）。
   *
   * 自定义插件（侧边栏「＋」安装）不在静态白名单 PLUGIN_COMMANDS 里，
   * 只靠那张表的话它连 app_version 都会被拒 —— 安全对了、功能死了。
   * 这条让插件（或安装它的用户）自己声明需要哪些命令。
   *
   * 这只是"用户给自己的插件授权"，不是安全漏洞：
   * 用户本来就能改文件。真正的闸是 HARD_DENY 与"未声明即拒绝"。
   */
  commands?: string[];
  /**
   * 'app'（默认，侧边栏可见） | 'service'（供其它插件调用）
   * | 'toolbar'（标题栏右上角的小按钮）
   *
   * 分类只认这个字段，**不看目录位置** ——
   * 三类插件都平铺在 plugins/ 下。
   * 目录再分一层就成了第二个真相源：移动目录忘了改这里，
   * 服务就会出现在侧边栏（而判定逻辑只认 kind）。
   */
  kind?: 'app' | 'service' | 'toolbar';
  /**
   * 服务专用：调用时由宿主临时显示为居中浮层。
   * 色盘 / 图标选择 / md 编辑这类服务**必须用户看得见才用得了**，
   * 而服务平时挂在移出视口的常驻容器里。
   */
  interactive?: boolean;
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
/* 排除服务插件（kind:'service'）—— 侧边栏/恢复上次插件/快捷键切换都要用，
   所以单独导出，别在各处各写一遍 filter。 */
export function visiblePlugins(plugins: PluginManifest[]): PluginManifest[];
export function isService(p: PluginManifest | null | undefined): boolean;
/** 是否是工具栏插件（显示在标题栏右上角，不进侧边栏） */
export function isToolbar(p: PluginManifest | null | undefined): boolean;
export function isInsideTauri(): boolean;
export const THEME_VARS: string[];
