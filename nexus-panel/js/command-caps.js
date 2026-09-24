/**
 * 命令能力分级（command capabilities）
 * ============================================================
 *
 * 给每条后端命令标一个能力等级，用来回答两个问题：
 *
 *   1. 某个插件一共拿到了哪些等级的能力（组合风险）
 *   2. 还有多少命令没定级（待归类队列）
 *
 * ⚠️⚠️ 三个必须知道的约束 ⚠️⚠️
 *
 * ① **未列出 = unknown，不是"安全"**。
 *    这是本表最重要的约定。宁可让一条安全命令挂着 unknown
 *    等人来定，也不能让一条危险命令被默认归成 R1 ——
 *    后者的代价是"看起来安全，实际危险"。
 *
 * ② **本表不参与拦截**。
 *    它只做登记与报告。真正拦不拦由 invoke-policy.js 决定。
 *    这样即便某条定级有争议，也不会造成功能阻断 ——
 *    分级是给人看的，不是给机器执行的。
 *
 * ③ **刻意先不做 @cap 源码标注**。
 *    草案想把等级写进 Rust 源码的文档注释里。但那是 72 处的
 *    写操作，且在无 cargo 的环境下无法编译验证 —— 分错一条
 *    就是"把危险命令标成安全"，比不标更糟。
 *    所以先用这张独立的表把**已知的高危险项**固定下来，
 *    其余留 unknown 逐步归类。等表稳定了再考虑往源码搬。
 *
 * 等级定义
 * --------
 *   M  提权 / 宿主操控 / 进程 / 网络监听
 *      能改变自身权限边界，或操控窗口、起停进程与网络服务。
 *      这类能力叠加时风险不是相加而是相乘（见 PLUGIN_META 组合）。
 *
 *   W  写用户数据
 *      修改文件、配置、卡片结构。误用会丢数据。
 *
 *   S  敏感读
 *      读取用户文件内容、截屏、取加密盐。不改动数据但泄露即事故。
 *
 *   R  普通读 / 无副作用
 *      读版本号、列目录名、查状态。
 *
 *   unknown  未归类（默认）—— 需要人来定
 *
 * 为什么 S 要从"读"里单独分出来
 * ------------------------------
 * 草案原本把读分成 R1/R2/R3 三档。但实际判断时，
 * "读目录名列表"和"读文件正文 / 截屏"是两类完全不同的事：
 * 前者泄露无实质后果，后者泄露就是数据事故。
 * 分三档反而让边界模糊 —— 两档更容易判断对。
 */

/**
 * 显式定级表。
 *
 * 只收录**有把握**的条目；拿不准的一律不写，让它留在 unknown。
 * 每条目都注明了判断依据 —— 将来复核时能看出当初为什么这么定。
 */
export const COMMAND_CAPS = {
  /* ---- M：提权 / 宿主操控 / 进程 / 网络 ---- */

  // 给自己授权任意目录 —— 注释原文即"提权"。绕过所有目录边界。
  af_fs_allow_root: 'M',
  af_fs_disallow_root: 'M',

  // 拉起子进程执行 CLI（invoke-policy.js 注释明确列出）
  run_node: 'M',
  kill_node: 'M',

  // 隐藏 / 关闭窗口（同上，注释明确列出）
  window_action: 'M',
  tray_toggle_window: 'M',
  set_window_icon: 'M',

  // 打开开发者工具 —— 可在宿主上下文里执行任意 JS
  mm_open_devtools: 'M',

  // 起停 MCP 服务：main.rs 里有 `[mcp] listening on http://{addr}/mcp`，
  // 即会**在本机开一个 HTTP 监听**。这是网络暴露面，不是普通读写。
  fpx_mcp_start: 'M',
  fpx_mcp_stop: 'M',
  // 起停 webhook —— 同样是网络监听
  webhook_start: 'M',
  webhook_stop: 'M',
  // 起停文件监听（长期后台任务，占资源且可持续读文件）
  // ⚠️ 注意有**两组**监听命令：watch_start/stop 与 fpx_watch_start/stop。
  // 第一版只写了前者，于是 project-group 那两条一直挂着 unknown ——
  // 漏掉的不是"某条命令"，而是"某个插件的能力等级"被低估。
  watch_start: 'M',
  watch_stop: 'M',
  fpx_watch_start: 'M',
  fpx_watch_stop: 'M',

  /* ---- S：敏感读（泄露即事故，但不改动数据）---- */

  // 设备盐：af_flow.rs 注释说"盐变了之前加密的凭据就全解不开"，
  // 反过来说，拿到盐 + 密文 = 能解开凭据。这是凭据泄露的单点。
  af_device_salt: 'S',

  // 读文件正文（尾部 seek，af_flow.rs 有实现）
  af_fs_tail: 'S',
  fpx_read_file: 'S',
  // 读图片/音频为 data URL —— 内容出到前端
  af_read_image_data_url: 'S',
  af_read_audio_data_url: 'S',
  // 截屏：整个屏幕内容
  fpx_capture_screen: 'S',
  // 扫目录内容（含文件名树）
  fpx_scan_content: 'S',
  // 图标二进制数据
  fpx_icon_data: 'S',
  // 系统吸管取色：**读屏幕像素**。常被当成无害的 UI 小功能，
  // 但它拿到的就是屏幕内容 —— 与截屏同类。
  fpx_pick_color: 'S',

  /* ---- W：写用户数据 ---- */

  // 授权目录内的写 / 删 / 移 —— 最高危的写
  fs_op: 'W',

  fpx_save_config: 'W',
  fpx_create_link: 'W',
  fpx_remove_link: 'W',
  fpx_create_folder: 'W',
  fpx_rename_folder: 'W',
  fpx_move_folder: 'W',
  fpx_rename_content_item: 'W',
  fpx_move_card_across: 'W',
  fpx_clear_invalid: 'W',
  fpx_set_lock: 'W',
  fpx_set_icon: 'W',
  fpx_save_style: 'W',
  fpx_save_icon_data: 'W',
  fpx_save_custom_colors: 'W',
  fpx_import_icons: 'W',
  fpx_set_editor: 'W',
  fpx_edit_file: 'W',
  /*
   * F9 导出专用。比 fpx_write_text 更宽（允许新建），所以扩展名与覆盖
   * 都在 Rust 侧收口（见 fpx::fpx_export_text）。定 W：写用户数据。
   */
  fpx_export_text: 'W',
  fpx_save_chain_clients: 'W',
  fpx_save_chain_actions: 'W',
  fpx_chain_send_action: 'W',
  fpx_chain_send: 'W',
  fpx_backup: 'W',
  fpx_backup_auto_sync: 'W',

  /* ---- R：普通读 / 无副作用 ---- */

  app_version: 'R',
  rust_ping: 'R',
  check_cli: 'R',
  // 这两个是编译期常量：main.rs 里 `fn mm_print_support() -> bool { cfg!(...) }`
  mm_print_support: 'R',
  mm_pdf_vector_support: 'R',

  fpx_bootstrap: 'R',
  fpx_list_dirs: 'R',
  fpx_quick_roots: 'R',
  af_fs_list_roots: 'R',
  fpx_list_icons: 'R',
  fpx_list_editors: 'R',
  fpx_backup_auto_status: 'R',
  fpx_mcp_status: 'R',
  fpx_mcp_tools: 'R',
  fpx_watch_poll: 'R',

  /* ---- 这两条**刻意留 unknown** ---- */
  /*
   * mm_print / mm_svg_to_pdf：会调起系统打印对话框、导出 PDF 文件。
   * 说它是"读"肯定不对（有副作用），说它是"写"又不完全
   * （写到哪由用户选）。拿不准就不写 —— 留在 unknown 里让
   * 真正用过这个功能的人来定，比我猜要好。
   *
   * fpx_open_path / fpx_open_data_dir / fpx_open_backup_dir：
   * "用系统默认程序打开"—— 会启动外部进程（算 M？）还是只算
   * 一次性的用户意图表达（算 W？）取决于打开的目标是否可控。
   * 同样留给使用者判断。
   *
   * fpx_copy_text：写剪贴板。剪贴板算用户数据吗？算，但它同时
   * 也是"复制"这个最基础操作的载体，标 W 会让几乎所有插件都带 W。
   * 先留 unknown。
   */
};

/**
 * 组合风险：草案第七节的规则在这里落地。
 *
 * 单条能力未必危险，**组合**才危险。例如：
 *   只有 M（能开网络监听）→ 没东西可读
 *   只有 S（能读文件）    → 读的是自己那点东西
 *   M + S 同时有         → 能把读到的东西通过网络送出去
 *
 * 所以判据是"持有哪几类"，不是"持有几条"。
 */
export const COMBO_RULES = [
  {
    id: 'exfil',
    level: 'red',
    need: ['M', 'S'],
    why: '既能读用户内容（S），又能起网络/进程（M）—— 构成外传通道',
  },
  {
    id: 'full-control',
    level: 'red',
    need: ['M', 'W'],
    why: '既能改用户数据（W），又能起网络/进程（M）—— 可远程改写',
  },
  {
    id: 'destructive',
    level: 'yellow',
    need: ['W'],
    why: '能写/删用户数据。单看正常，但需确认是否真的需要',
  },
  {
    id: 'sensitive-read',
    level: 'yellow',
    need: ['S'],
    why: '能读敏感内容（文件正文/截屏/凭据盐）',
  },
];

/** 取某命令的等级；未列出返回 unknown */
export function capOf(cmd) {
  return COMMAND_CAPS[cmd] || 'unknown';
}

/**
 * 统计一组命令的能力画像。
 *
 * @param {string[]} cmds
 * @returns {{counts:Object, levels:string[], unknown:string[], combos:Object[]}}
 */
export function capsOf(cmds) {
  const counts = { M: 0, W: 0, S: 0, R: 0, unknown: 0 };
  const unknown = [];
  for (const c of cmds || []) {
    const cap = capOf(c);
    counts[cap] = (counts[cap] || 0) + 1;
    if (cap === 'unknown') unknown.push(c);
  }
  const levels = Object.keys(counts).filter((k) => counts[k] > 0);
  const combos = COMBO_RULES
    .filter((r) => r.need.every((n) => counts[n] > 0))
    .map((r) => ({ ...r }));
  return { counts, levels, unknown, combos };
}

/** 最高风险等级（red > yellow > none），供排序与告警用 */
export function worstLevel(profile) {
  const ls = (profile.combos || []).map((c) => c.level);
  if (ls.includes('red')) return 'red';
  if (ls.includes('yellow')) return 'yellow';
  return 'none';
}
