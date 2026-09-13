import type { PluginContext } from '../../js/plugin-sdk.js';
import type {
  BackupAutoStatus, BackupResult, Bootstrap, CaptureResult, CardKind, ChainClient,
  ChainAction, ChainSendResult, ContentItem, CustomChainClient, DirEntryLite,
  ClearResult, EditorCandidate, FpxConfig, McpToolRow, MoveAcrossResult,
  RenameResult, Snapshot, WatchEvent,
} from './types';

/**
 * 所有后端调用集中在这里，组件层不直接 invoke。
 * 参数名统一 snake_case，与 Rust 侧保持一致。
 */
export function makeApi(ctx: PluginContext) {
  const call = <T>(cmd: string, args: Record<string, unknown> = {}) =>
    ctx.invoke<T>(cmd, args);

  return {
    bootstrap: () => call<Bootstrap>('fpx_bootstrap'),

    saveConfig: (config: FpxConfig) =>
      call<Snapshot>('fpx_save_config', { config }),

    createLink: (project: string, group: string, names?: string[]) =>
      call<Snapshot>('fpx_create_link', { project, group, names: names ?? null }),

    removeLink: (project: string) =>
      call<Snapshot>('fpx_remove_link', { project }),

    scanContent: (root: string, kind = 'all') =>
      call<ContentItem[]>('fpx_scan_content', { root, kind }),

    readFile: (path: string, max?: number) =>
      call<string>('fpx_read_file', { path, max: max ?? null }),

    openPath: (path: string, mode: 'auto' | 'dir' | 'containing' | 'editor' = 'auto') =>
      call<void>('fpx_open_path', { path, mode }),

    listDirs: (path: string) =>
      call<DirEntryLite[]>('fpx_list_dirs', { path }),

    quickRoots: () => call<DirEntryLite[]>('fpx_quick_roots'),

    /** 给项目/项目组文件夹改名（物理 rename + 同步所有登记） */
    renameFolder: (kind: 'project' | 'group', path: string, newName: string) =>
      call<RenameResult>('fpx_rename_folder', { kind, path, new_name: newName }),

    /** 清除无效项：摘掉页签里已不存在的路径 */
    clearInvalid: () => call<ClearResult>('fpx_clear_invalid'),

    /** 更换软件窗口图标（外壳能力，非本插件数据） */
    setWindowIcon: (path: string) => call<void>('set_window_icon', { path }),

    createFolder: (parent: string, name: string, hierarchy?: string, template?: string) =>
      call<string>('fpx_create_folder', {
        parent, name, hierarchy: hierarchy ?? null, template: template ?? null,
      }),

    setLock: (path: string, denyDelete: boolean, denyWrite: boolean) =>
      call<Snapshot>('fpx_set_lock', { path, deny_delete: denyDelete, deny_write: denyWrite }),

    setIcon: (path: string, iconRef: string | null, affectExplorer?: boolean) =>
      call<Snapshot>('fpx_set_icon', {
        path, icon_ref: iconRef, affect_explorer: affectExplorer ?? null,
      }),

    /** 图标与标签色一次保存（避免两次写入互相覆盖） */
    saveStyle: (path: string, iconRef: string | null, color: string | null) =>
      call<Snapshot>('fpx_save_style', {
        path, icon_ref: iconRef, color,
      }),

    listIcons: () => call<string[]>('fpx_list_icons'),

    /** 屏幕取色：不传坐标则取当前鼠标位置（Windows 有效） */
    pickColor: (x?: number, y?: number) =>
      call<string>('fpx_pick_color', { x: x ?? null, y: y ?? null }),

    saveCustomColors: (colors: string[]) =>
      call<Snapshot>('fpx_save_custom_colors', { colors }),

    /* ---- 备份 / 编辑器 / 连锁 / 截图 / 监听 / MCP ---- */

    backup: (kind: CardKind, target?: string | null, appendOnly?: boolean) =>
      call<BackupResult>('fpx_backup', {
        kind, target: target ?? null, append_only: appendOnly ?? null,
      }),

    /** refresh=true 强制重扫并刷新缓存；否则返回缓存（缓存为空时自动扫一次） */
    listEditors: (refresh = false) =>
      call<EditorCandidate[]>('fpx_list_editors', { refresh }),

    setEditor: (path: string) => call<Snapshot>('fpx_set_editor', { path }),

    editFile: (path: string) => call<null>('fpx_edit_file', { path }),

    chainClients: () => call<ChainClient[]>('fpx_chain_clients'),

    /** 保存手动添加的连锁客户端清单，返回最新完整列表 */
    saveChainClients: (clients: CustomChainClient[]) =>
      call<ChainClient[]>('fpx_save_chain_clients', { clients }),

    chainSend: (client: string, directory: string, prompt?: string | null) =>
      call<ChainSendResult>('fpx_chain_send', {
        client, directory, prompt: prompt ?? null,
      }),

    /** 连锁动作清单（内置 + 自定义） */
    chainActions: () => call<ChainAction[]>('fpx_chain_actions'),

    saveChainActions: (actions: ChainAction[]) =>
      call<ChainAction[]>('fpx_save_chain_actions', { actions }),

    /** 按动作发送；prompt 传入则临时覆盖模板（不落盘）；client 传入则临时覆盖客户端 */
    chainSendAction: (
      actionId: string, kind: CardKind, path: string,
      prompt?: string | null, client?: string | null,
    ) =>
      call<ChainSendResult>('fpx_chain_send_action', {
        action_id: actionId, kind, path,
        prompt: prompt ?? null, client: client ?? null,
      }),

    captureScreen: () => call<CaptureResult>('fpx_capture_screen'),

    watchStart: (intervalSecs?: number) =>
      call<boolean>('fpx_watch_start', { interval_secs: intervalSecs ?? null }),

    watchStop: () => call<boolean>('fpx_watch_stop'),

    /** 取走累积的监听事件（取完即清空） */
    watchPoll: () => call<WatchEvent[]>('fpx_watch_poll'),

    mcpStart: (port?: number) => call<string>('fpx_mcp_start', { port: port ?? 0 }),

    /** MCP 工具清单（含开关状态） */
    mcpTools: () => call<McpToolRow[]>('fpx_mcp_tools'),

    /** 跨类别移动卡片（项目 ⇄ 项目组），可能触发物理搬家 */
    moveCardAcross: (fromKind: CardKind, path: string, dstKind: CardKind, dstTabIndex?: number) =>
      call<MoveAcrossResult>('fpx_move_card_across', {
        from_kind: fromKind, path, dst_kind: dstKind, dst_tab_index: dstTabIndex ?? null,
      }),

    /** 自动备份状态：是否运行中、间隔、上次执行时间 */
    backupAutoStatus: () => call<BackupAutoStatus>('fpx_backup_auto_status'),

    /** 按 config.backupAutoMinutes 启停定时备份，返回是否运行中 */
    backupAutoSync: () => call<boolean>('fpx_backup_auto_sync'),

    mcpStop: () => call<boolean>('fpx_mcp_stop'),

    mcpStatus: () => call<{ running: boolean }>('fpx_mcp_status'),

    importIcons: (fromDir: string) => call<string[]>('fpx_import_icons', { from_dir: fromDir }),

    /** 数据目录里的图标 → data URI（沙箱内无法直接用本地路径显示） */
    iconData: (path: string) => call<string>('fpx_icon_data', { path }),

    /** 内置图标内容固化到数据目录，返回落盘路径 */
    saveIconData: (name: string, dataBase64: string) =>
      call<string>('fpx_save_icon_data', { name, data_base64: dataBase64 }),

    openDataDir: () => call<void>('fpx_open_data_dir'),
  };
}

export type Api = ReturnType<typeof makeApi>;

/**
 * 路径比较键：去尾部分隔符、统一分隔符、转小写。
 * 与 Rust 侧 store::normalize_key 保持同一套规则，用于判断"是不是同一个目录"。
 * （Windows 大小写不敏感；Linux/macOS 上转小写会把 A/a 视为同一路径，
 *   但对改名/清除无效这类"同一批数据内部比对"的场景无害）
 */
export function normalizeKey(p: string): string {
  return p.trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

/** 统一错误信息抽取 */
export function errText(e: unknown): string {
  const raw = e as { message?: string } | string | null;
  if (!raw) return '未知错误';
  if (typeof raw === 'string') return raw;
  return raw.message ?? String(raw);
}
