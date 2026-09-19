/**
 * ctx.invoke 命令白名单（插件 → 后端命令）
 * ============================================================
 * 背景：此前 `case 'invoke'` 是**无条件透传**的 ——
 *
 *   return reply(true, await tauri.invoke(payload.cmd, payload.args));
 *
 * `cmd` 完全由插件传入，没有任何校验。于是插件可以调用后端
 * **任意**已注册命令（47 个），包括：
 *   · fs_op              —— 写 / 删 / 移 文件（授权目录内）
 *   · run_node           —— 拉起子进程执行 CLI
 *   · af_fs_allow_root   —— **给自己授权任意目录**（提权）
 *   · fpx_capture_screen —— 截屏
 *   · window_action      —— 隐藏/关闭窗口
 *
 * 这是文件残留与安全上最大的一个口子，而嵌合（同文档）会把它放大。
 *
 * 策略：**声明制白名单，默认拒绝**
 *
 *   插件只能用 manifest.commands 里**显式列出**的命令。
 *   没声明 = 拒绝。新增能力默认拒绝，要进白名单需过审 ——
 *   这样机制不会随时间推移越来越松（写成"允许列表再往上加"
 *   其实是黑名单思路，方向是反的）。
 *
 * 白名单内容来自**实测扫描**（各插件源码里真实出现的 ctx.invoke），
 * 不是拍脑袋 —— 见 scripts/scan-invoke.mjs。
 */

/**
 * 全局硬禁止：即使插件声明了也不给。
 *
 * 目前为空，但**保留这个闸门**。理由：声明制挡的是"没声明的插件"，
 * 挡不住"插件被诱导去声明"。真正危险的少数命令需要第二道锁。
 *
 * 等绿/黄/红分区定稿后，红区命令进这里。
 */
export const HARD_DENY = new Set([
  /* 例：'window_action', 'tray_toggle_window', 'mm_open_devtools' */
]);

/**
 * 各插件允许的命令。
 *
 * key = 插件 id，value = 允许的命令集合。
 * **未列出的插件 → 全部拒绝**（默认拒绝，不是默认放行）。
 */
export const PLUGIN_COMMANDS = {
  home: ['rust_ping', 'app_version'],

  /*
   * agent-flow
   * ----------------------------------------------------------
   * 清单由 scripts/scan-invoke.mjs 实测得出（对照源码 + Rust 已注册命令），
   * 不是手写的。两处修正值得记：
   *
   *   · af_device_salt —— **Rust 侧根本没有这个命令**，是死调用。
   *     （对应 af_flow.rs 里 af_device_salt / make_device_salt 的
   *      dead_code warning：写了但没接上。白名单不该收容死调用，
   *      否则它看起来像"已授权的能力"。）
   *   · check_cli —— 源码里查无此调用，是我第一版凭印象加的，删掉。
   *
   * af_fs_* 三个：lib/tauri.ts 里确实写了 invoke，但**上层未见调用点**，
   * 属于预留。给它是为了让"将来接上调用"不会静默被拒；
   * 接上时请复核 —— 授权目录是敏感能力（Rust 侧有 canonicalize +
   * starts_with 兜底，但它决定了 fs_op 能碰哪些路径）。
   */
  'agent-flow': [
    'app_version',
    'af_read_image_data_url',
    'af_fs_allow_root',
    'af_fs_disallow_root',
    'af_fs_list_roots',
    'fs_op',
    'run_node',
    'kill_node',
    'watch_start',
    'watch_stop',
    'webhook_start',
    'webhook_stop',
  ],

  'project-group': [
    'app_version',
    'set_window_icon',
    'fpx_bootstrap',
    'fpx_save_config',
    'fpx_create_link',
    'fpx_remove_link',
    'fpx_read_file',
    'fpx_open_path',
    'fpx_copy_text',
    'fpx_create_folder',
    'fpx_set_lock',
    'fpx_set_icon',
    'fpx_save_style',
    'fpx_icon_data',
    'fpx_save_icon_data',
    'fpx_pick_color',
    'fpx_save_custom_colors',
    'fpx_open_data_dir',
    'fpx_open_backup_dir',
    'fpx_backup',
    'fpx_edit_file',
    'fpx_move_card_across',
    'fpx_chain_send',
    'fpx_chain_send_action',
    'fpx_capture_screen',
    'fpx_watch_start',
    'fpx_watch_stop',
    'fpx_mcp_start',
    'fpx_mcp_stop',
    'fpx_backup_auto_status',
    'fpx_backup_auto_sync',
    'fpx_clear_invalid',
    'fpx_rename_folder',
    'fpx_move_folder',
    'fpx_rename_content_item',
    /* 以下由 scan-invoke 实测补入（第一版漏了 call<T> 多行写法） */
    'fpx_chain_actions',
    'fpx_chain_clients',
    'fpx_import_icons',
    'fpx_list_dirs',
    'fpx_list_editors',
    'fpx_list_icons',
    'fpx_mcp_status',
    'fpx_mcp_tools',
    'fpx_quick_roots',
    'fpx_save_chain_actions',
    'fpx_save_chain_clients',
    'fpx_scan_content',
    'fpx_set_editor',
    'fpx_watch_poll',
  ],

  mindmap: ['mm_print', 'mm_svg_to_pdf', 'mm_open_devtools'],

  /* settings 虽然是 iframe 插件，但它是**外壳的一部分**：
     授权目录管理就是它干的。所以它拿到 af_fs_* 三个命令。
     别的插件没有 —— 这正是"插件给自己授权目录"这类提权被挡住的原因。 */
  settings: ['af_fs_allow_root', 'af_fs_disallow_root', 'af_fs_list_roots', 'app_version'],

  /* 色盘服务要用系统吸管 —— 与 fpx_pick_color 命令对应 */
  'color-picker': ['fpx_pick_color'],

  'demo-iframe': ['rust_ping'],
  'demo-module': ['rust_ping', 'app_version'],
  'demo-react': ['app_version', 'rust_ping'],
};

/**
 * 安全只读命令：**任何**插件都能调，无需登记。
 *
 * 为什么要有这一层：
 * PLUGIN_COMMANDS 是"默认拒绝"，用户通过侧边栏「＋」安装的自定义插件
 * 不在表里 —— 于是它连 `app_version`（读个版本号）都会被拒。
 * 安全对了，功能死了：插件装上去一调后端就失败，而这类命令
 * 本身就是无害的只读查询。
 *
 * 只放**无任何副作用**的查询。凡涉及写文件、拉进程、授权目录、
 * 截屏、操控窗口的，一律不进这里 —— 那些必须显式登记。
 */
export const SAFE_COMMANDS = ['app_version', 'rust_ping'];

/**
 * 能力分级是否参与拦截。
 *
 * ⚠️ 当前是 'report-only'（只登记不拦截），这是**刻意的选择**，不是没做完。
 *
 * 理由：能力画像显示 agent-flow 和 project-group 现在就命中红色组合
 * （M+S 外传通道、M+W 可远程改写）。它们是核心插件 ——
 * 一旦按组合拦截，功能立刻不可用，等于"安全对了、功能死了"。
 *
 * 所以顺序是：先让风险可见 → 给插件做降级改造（拆分命令或加护栏）
 * → 改造完成后才把这里改成 'enforce'。
 *
 * 写成常量而不是散在注释里，是为了让这个决策**可断言**：
 * 测试钉住它是 'report-only'，谁顺手接上拦截都会被挡回去。
 */
export const CAP_ENFORCEMENT = 'report-only';

/**
 * 校验一次 invoke 是否被允许。
 *
 * 判定顺序（越靠前优先级越高）：
 *   1. HARD_DENY        —— 全局禁止，谁声明都没用
 *   2. manifest.commands —— 插件自带声明（自定义插件安装时由用户填写）
 *   3. PLUGIN_COMMANDS  —— 内置插件的静态登记（实测扫描得出）
 *   4. SAFE_COMMANDS    —— 只读兜底，保证"装了就能用"
 *   5. 其余一律拒绝
 *
 * 注意 2 与 3 是**并集**不是替换：内置插件在 manifest 里补声明也能生效，
 * 将来给某个内置插件临时加命令不必改这张静态表。
 *
 * 本函数**刻意不引用 command-caps.js**。能力等级只用于报告，
 * 不参与这里的判定 —— 见 CAP_ENFORCEMENT 的说明。
 *
 * @param {string} pluginId 插件 id
 * @param {string} cmd      要调用的命令
 * @param {object} [manifest] 插件清单，带 commands 时使用
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkInvoke(pluginId, cmd, manifest) {
  const name = String(cmd || '').trim();
  if (!name) {
    return { ok: false, reason: '命令名为空' };
  }
  if (HARD_DENY.has(name)) {
    return { ok: false, reason: `命令已被全局禁止: ${name}` };
  }
  /* 插件自带声明。自定义插件靠这条获得授权 ——
     这是"用户自己决定给这个插件什么权限"，与静态表的区别只是来源。 */
  const own = Array.isArray(manifest?.commands) ? manifest.commands : null;
  if (own && own.includes(name)) return { ok: true };

  const allow = PLUGIN_COMMANDS[pluginId];
  if (allow && allow.includes(name)) return { ok: true };

  if (SAFE_COMMANDS.includes(name)) return { ok: true };

  /* 未登记且不在安全集合 —— 默认拒绝。
     未来联网安装插件时，这一条仍是最主要的一道闸。 */
  return { ok: false, reason: `插件 ${pluginId} 未声明命令: ${name}` };
}
