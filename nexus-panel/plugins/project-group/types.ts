/** 与 Rust 端 fpx/model.rs 一一对应的 DTO */

export interface TabItem {
  name: string;
  items: string[];
}

export interface LockItem {
  path: string;
  denyDelete: boolean;
  denyWrite: boolean;
  /** 「账面固定」（#21）：仅登记在案，不落系统权限 */
  accountOnly?: boolean;
}

/** 图标改名结果（#10）：affected 是同步更新的卡片引用数，必须让用户看见 */
export interface RenameIconResult {
  path: string;
  affected: number;
  icons: string[];
  snapshot: Snapshot;
}

export interface IconGroup {
  name: string;
  icons: string[];
}

export interface FpxConfig {
  /** config schema 版本。老配置没有这个键，后端按 1 处理并在加载时升级 */
  schemaVersion: number;
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
  /** 退出软件时一并关闭 MCP 后台进程 */
  closeMcpOnExit: boolean;
  /** 工具名 → 是否启用（缺失视为开启） */
  mcpTools: Record<string, boolean>;
  chainClient: string | null;
  chainPrompt: string | null;
  /**
   * 连锁动作有序清单（对应 Rust `chain_actions`）。
   * null = 尚未迁移，后端首次读取时会用内置默认值生成。
   *
   * 前端不直接编辑它（走 `fpx_chain_actions` / `fpx_save_chain_actions`），
   * 但保存整份 config 时必须原样带回去：若 JSON 里缺这个字段，
   * serde 走 default 得到 null，后端会判定「尚未迁移」并用内置值重置，
   * 用户自己加的动作就没了。
   */
  chainActions: ChainAction[] | null;
  watchEnabled: boolean;
  /** 快捷键覆盖（动作 id → combo）；只存改过的项，null = 全部默认 */
  hotkeys: Record<string, string> | null;
  watchIntervalSecs: number;
  /**
   * 日志区最多保留多少条（#32）。同时决定显示与"复制全部"能拿到多少。
   * 后端会在读取时夹回 10~2000，这里只负责展示与提交。
   */
  logMaxLines: number;
  /** 三栏宽度 star 值（#54）。null = 用默认 */
  colStars: number[] | null;
  /** 日志区高度 px（#55）。null = 用默认 */
  logRowHeight: number | null;
  /** 设置浮层高度 px（#56）。null = 自适应内容高度 */
  settingsPanelHeight: number | null;
  /** MCP 服务浮层高度 px（#56） */
  mcpPanelHeight: number | null;
  /** 使用说明浮层高度 px（#56） */
  tipsPanelHeight: number | null;
  /**
   * MCP 访问令牌（后端生成）。**前端不展示、不编辑，但必须原样带回去**。
   *
   * 保存配置是整份覆盖：JSON 里缺这个键，serde 走 default 得到 null，
   * 后端下次启动就会重新生成一枚新令牌 —— 而 AI 客户端里配好的那条旧令牌
   * 从此失效，用户只看到"连不上"，无从下手。
   * 与 chainActions 同理（见那里的注释）。
   */
  mcpToken: string | null;
  /** 开发者模式（#46）：开启后允许删除内置连锁动作 */
  devMode: boolean;
  /** 按钮上显示快捷键提示（#50），默认开 */
  showShortcuts: boolean;
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
  /** 「账面固定」（#21）：仅登记在案，无系统权限。与 locked（ACL）是两件事。 */
  accountFixed?: boolean;
  icon: string | null;
  tagColor: string | null;
  /** 颜色是否继承自所链接的项目组 */
  tagColorInherited: boolean;
  /** 逐条链接明细；展开链接时用。老版本后端没有此字段，按空数组处理 */
  linkDetails?: LinkDetail[];
}

export interface LinkDetail {
  /** 链接名（如 .opencode、agents） */
  name: string;
  /** 指向的项目组名 */
  groupName: string;
  /** 指向的项目组路径 */
  group: string;
  /** valid / broken / conflict */
  state: 'valid' | 'broken' | 'conflict';
  created: string;
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
  /** config.json 的体检结果（未知键、迁移记录）。空 = 正常 */
  configNotices: string[];
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

/** 文件夹改名 / 搬家的结果 */
export interface RenameResult {
  snapshot: Snapshot;
  /** 改名 / 搬家后的完整路径 */
  newPath: string;
  /** 同步改动的页签登记条数 */
  tabHits: number;
  /** 同步改动的链接记录条数 */
  recHits: number;
  /** 搬家时重建成功的链接数（项目组搬家才有，改名恒为 0） */
  relinked?: number;
  /** 重建失败的项目清单（路径：原因）；非空说明有链接需要手动复查 */
  relinkErrors?: string[];
}

/**
 * 内容区（agent / skill / rule）条目改名的结果。
 * 内容条目不进配置，所以没有快照——前端拿到 newPath 后重新扫目录即可。
 */
export interface ContentRenameResult {
  /** 改名后的绝对路径 */
  newPath: string;
}

/** 清除无效项的结果 */
export interface ClearResult {
  snapshot: Snapshot;
  /** 被移除的无效路径 */
  removed: string[];
  /** 从页签里摘掉的条数 */
  tabHits: number;
  /** 清理掉的失效链接记录条数 */
  recHits: number;
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
