/** 与 Rust 端 fpx/model.rs 一一对应的 DTO */

export interface TabItem {
  name: string;
  items: string[];
}

export interface LockItem {
  path: string;
  denyDelete: boolean;
  denyWrite: boolean;
}

export interface IconGroup {
  name: string;
  icons: string[];
}

export interface FpxConfig {
  projectTabs: TabItem[];
  groupTabs: TabItem[];
  linkAgents: Record<string, boolean>;
  customLinkAgents: string[];
  linkAgentRemarks: Record<string, string>;
  linkAgentVendors: Record<string, string>;
  /** 预设链接名 → 改名后的目录名（影响实际建链目录名） */
  linkAgentRenames: Record<string, string>;
  /** 置顶的链接名，按此列表顺序排在最前 */
  linkAgentsPinned: string[];
  tagColors: Record<string, string>;
  customColors: string[];
  folderIcons: Record<string, string>;
  locks: LockItem[];
  createProjectDir: string | null;
  createGroupDir: string | null;
  createGroupTemplateDir: string | null;
  /** 跨类别移动卡片时是否同步物理搬家文件夹 */
  moveFolderOnCrossMove: boolean;
  /** 搬家范围：defaultRoots / defaultRootsFlatten / anywhere */
  moveFolderScope: string;
  /** 用户手动添加的连锁客户端 */
  customChainClients: CustomChainClient[];
  /** 编辑器候选缓存（免每次重扫） */
  editorPickCache: EditorPickCacheItem[];
  /** 项目备份目标目录；空 = 回退 backupDir */
  backupProjectDir: string | null;
  /** 项目组备份目标目录；空 = 回退 backupDir */
  backupGroupDir: string | null;
  editToolPath: string | null;
  iconAffectExplorer: boolean;
  autoSelect: boolean;
  /** 跨栏拖放卡片时直接建链，不再确认 */
  quickLink: boolean;
  /** 新建时路径是否携带当前页签层级 */
  createPathCarriesHierarchy: boolean;
  presetIcons: string[];
  /** 图标分组：组内是图标显示名（内置名或已导入的文件名） */
  iconGroups: IconGroup[];
  backupDir: string | null;
  backupAppendOnly: boolean;
  /** 自动备份间隔（分钟）；0 = 关闭 */
  backupAutoMinutes: number;
  mcpEnabled: boolean;
  /** 工具名 → 是否启用（缺失视为开启） */
  mcpTools: Record<string, boolean>;
  chainClient: string | null;
  chainPrompt: string | null;
  watchEnabled: boolean;
  watchIntervalSecs: number;
}

export interface CardInfo {
  path: string;
  name: string;
  exists: boolean;
  hasLink: boolean;
  hasBroken: boolean;
  hasConflict: boolean;
  linkCount: number;
  linkedGroup: string | null;
  locked: boolean;
  denyDelete: boolean;
  denyWrite: boolean;
  icon: string | null;
  tagColor: string | null;
  /** 颜色是否继承自所链接的项目组 */
  tagColorInherited: boolean;
}

export interface TabInfo {
  name: string;
  items: CardInfo[];
}

export interface LinkRow {
  project: string;
  group: string;
  groupName: string;
  created: string;
  names: string[];
  state: 'valid' | 'broken' | 'conflict' | 'partial';
}

export interface PresetAgent {
  /** 已应用改名后的显示名 */
  name: string;
  /** 预设固有键（.opencode 等），改名时 renames 以它为键 */
  original: string;
  vendor: string;
}

export interface Bootstrap {
  dataDir: string;
  platform: string;
  config: FpxConfig;
  projectTabs: TabInfo[];
  groupTabs: TabInfo[];
  links: LinkRow[];
  presetAgents: PresetAgent[];
  /** 全部链接名（预设显示名 + 自定义），已按置顶排序 */
  allNames: string[];
}

export interface Snapshot {
  config: FpxConfig;
  projectTabs: TabInfo[];
  groupTabs: TabInfo[];
  links: LinkRow[];
}

export interface ContentItem {
  kind: 'agent' | 'skill' | 'rule';
  name: string;
  relPath: string;
  path: string;
  isDir: boolean;
}

export interface DirEntryLite {
  name: string;
  path: string;
  hasChild: boolean;
}

/* ---------------------------- 备份 ---------------------------- */

export interface BackupResult {
  target: string;
  sources: number;
  missingSources: number;
  newFiles: number;
  updatedFiles: number;
  deletedFiles: number;
  skippedLinks: number;
  errors: string[];
}

/* ---------------------------- 编辑器 ---------------------------- */

export interface EditorCandidate {
  name: string;
  exe: string;
}

/* ---------------------------- Agent 连锁 ---------------------------- */

export interface ChainClient {
  id: string;
  name: string;
  installed: boolean;
}

export interface ChainSendResult {
  ok: boolean;
  client: string;
  needsPaste: boolean;
  message: string;
}

/** 用户手动添加的连锁客户端 */
export interface CustomChainClient {
  id: string;
  name: string;
  /** 可执行文件路径 */
  exe: string | null;
  /** URL scheme（exe 不可用时用它唤起） */
  scheme: string | null;
}

/** 编辑器候选缓存一条 */
export interface EditorPickCacheItem {
  name: string;
  exe: string;
}

/** 跨类别移动的结果 */
export interface MoveAcrossResult {
  snapshot: Snapshot;
  /** 物理搬家后的路径；未搬家为 null */
  relocated: string | null;
}

/** 一个连锁动作：内置四项（自由任务/审查/归并/部署）+ 自定义 */
export interface ChainAction {
  id: string;
  name: string;
  /** 内置标识（= id）；空串 = 自定义动作 */
  builtin: string;
  icon: string;
  /** 是否加入卡片右键菜单 */
  showContextMenu: boolean;
  /** 是否挂到外壳侧边栏 */
  showSidebar: boolean;
  /** 应用级快捷键，如 Ctrl+Shift+1；空 = 不注册 */
  shortcut: string | null;
  /** 项目侧模板；空 = 用内置默认 */
  project: string | null;
  /** 项目组侧模板 */
  group: string | null;
  /** 专属客户端；空 = 跟随全局默认 */
  client: string | null;
}

/* ---------------------------- 截图 / 监听 ---------------------------- */

export interface CaptureResult {
  path: string;
  width: number;
  height: number;
}

export interface WatchEvent {
  path: string;
  kind: 'added' | 'removed' | 'changed';
  at: string;
}

/* ---------------------------- MCP 工具开关 ---------------------------- */

export interface McpToolRow {
  name: string;
  desc: string;
  enabled: boolean;
}

/* ---------------------------- 自动备份 ---------------------------- */

export interface BackupAutoStatus {
  running: boolean;
  minutes: number;
  /** 上次自动备份时刻；未跑过为 null */
  lastRun: string | null;
}

export type CardKind = 'project' | 'group';
