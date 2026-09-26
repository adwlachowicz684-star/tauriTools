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
 * ② **本表参与拦截，所以"留 unknown"不是中性选择**。
 *    invoke-policy.js 的 checkInvoke 直接读它：
 *      · THIRD_DENY_CAPS = ['M'] —— 按 capOf() 的返回值禁第三方
 *      · 组合风险拦截 —— 按 capsOf() 算出的等级组合判红区
 *    两条都**只认显式等级**，unknown 一条都不命中，
 *    于是留 unknown 的命令对所有防护隐身（详见 KEEP_UNKNOWN）。
 *    早期注释写"本表不参与拦截"是错的，已更正。
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

  /*
   * 应用自更新（src/updater.rs）。三条**全是 M** —— 一条都不能降级：
   *   updater_check    对外发 HTTP 请求（暴露当前版本与所选通道）
   *   updater_install  下载安装包并**执行安装** —— 等价于运行下载下来的二进制
   *   updater_relaunch 结束并重启本进程
   *
   * 定 M 而不是 S/W 的理由：它们改的不是"用户数据"，
   * 而是**这个程序自身**。装上一个被掉包的更新，
   * 之前所有的目录白名单、命令分级、沙箱隔离全部作废 ——
   * 这是比任何读写都高一个量级的能力。
   *
   * 因此第三方插件一律拿不到（THIRD_DENY_CAPS 含 'M'），
   * 且 updater 必须注册为 **builtin** 且 id 锁定 ——
   * 别人注册一个同名 updater 就能劫持更新通道，这是供应链层面的攻击面。
   */
  updater_check: 'M',
  updater_install: 'M',
  updater_relaunch: 'M',

  /*
   * 试卷查重（src/dupview/）原生化之后，**这里一条 M 都没有了**。
   *
   * 早先它的后端是个 python 服务：起子进程 + 在本机监听 127.0.0.1:8767，
   * 于是 backend_start / stop / status 三条都得定 M。
   * 现在扫描、渲染、比对全在 Rust 进程内完成 —— 不拉子进程、不开端口，
   * 所以下面只剩 S（读，含路径）与 W（处置）。
   *
   * 这是原生化最直接的安全收益：插件不再持有「起进程」与「网络监听」
   * 两种能力，CSP 里也不必为它放行任何回环地址。
   */

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

  /*
   * 试卷查重（src/dupview/）的读类命令。
   *
   * 定 S 而不是 R：它们的返回值里全是**用户试卷的文件名与绝对路径**
   * （list 给出整棵目录树、pages 给出逐页图路径、scan_status 带当前文件），
   * 拿到它等于拿到用户磁盘上的目录结构。按本表"宁高勿低"的取向，归 S。
   *
   * 读的仍是**已经扫进 map.json 的**文件，不是任意路径：
   * 这些命令都不收"要读哪个文件"的参数，无法被拿来遍历磁盘。
   */
  dupview_roots: 'S',
  dupview_list: 'S',
  dupview_pages: 'S',
  dupview_scan_status: 'S',
  dupview_scan: 'S',
  dupview_scanall: 'S',
  dupview_browse: 'S',

  /* ---- W：写用户数据 ---- */

  // 授权目录内的写 / 删 / 移 —— 最高危的写
  fs_op: 'W',

  /*
   * 试卷查重：移动用户文件。
   *
   * 实现上是「移到 <data>/_trash」而不是真删（可一键还原），
   * 但对用户来说那批文件确实从原位置消失了，按"看得到的效果"定 W。
   */
  dupview_delete: 'W',
  dupview_restore: 'W',

  // 试卷查重：写的是插件自己的配置（roots.json 根目录列表、done.json 处理标记）。
  // 不涉及用户文件，但会被上面的处置命令拿来决定"能处置哪些文件"，
  // 所以同样按写来管 —— 篡改根目录列表等于扩大处置范围。
  dupview_addroot: 'W',
  dupview_delroot: 'W',
  dupview_dir_done: 'W',

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
  /* 常用文件夹（工具级，所有目录选择器共用） */
  fpx_list_fav_dirs: 'R',
  fpx_save_fav_dirs: 'W',
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

  /*
   * 手动触发 MCP 客户端注册自愈（#42）。
   *
   * 定 W，但要比普通 W 多看一眼：它写的**不是本应用的数据目录**，
   * 而是用户 home 下**其它应用**的配置文件
   * （claude_desktop_config.json 之类，见 fpx::mcp::client_config_paths）。
   * 也就是"一个应用去改另一个应用的配置"—— 影响面超出本程序。
   * register_clients 只改本服务那一条 key、不删别人的条目，
   * 所以定 W 而不是 M（不开网络、不起进程）。
   */
  fpx_mcp_register: 'W',

  /* ---- 常用文件夹：读列表 ---- */
  fpx_chain_actions: 'R',
  fpx_chain_clients: 'R',

  /*
   * ⚠️ 定 M，不是 W。
   *
   * 它自己的实现注释写着：mode=auto 在 Windows 上 `start "" <path>`
   * 对 .exe/.bat 就是**执行**，等于一条任意执行通道。
   * 现在靠 ensure_path_in 把目标收口到数据目录内压住了风险 ——
   * 但**收口是降险，不是消除**：将来谁放宽了 ensure_path_in，
   * 这条就立刻变回任意执行。定 M 才能让第三方禁令持续生效。
   */
  fpx_open_path: 'M',
};

/**
 * 刻意留 unknown 的命令 —— **必须逐条登记并写理由**。
 *
 * ⚠️⚠️ 为什么不能"不写就算了" ⚠️⚠️
 *
 * 早期这里写着"拿不准就不写，留在 unknown 里等人来定"。
 * 那个推理有个前提错误：**unknown 不是中性状态，它是隐身状态**。
 *
 *   · THIRD_DENY_CAPS = ['M'] —— unknown 不在里面，第三方禁令绕过
 *   · COMBO_RULES 按等级组合   —— unknown 不参与，M+S / M+W 红区绕过
 *   · capsOf 的 counts.unknown —— 只计数，不进 levels
 *
 * 也就是说一条留 unknown 的命令，在风险画像里**完全不可见**：
 * 既不告警也不拦截。所以"先留着"不是保守，是把它从所有防护里摘出去。
 *
 * 因此改成显式名单：想留 unknown 必须在这里登记并说明理由。
 * 没登记又没分级 = command-consistency-test 第 17 组会报红。
 */
export const KEEP_UNKNOWN = {
  /* 调起系统打印对话框。有副作用，但输出目标由用户在对话框里选，
     插件无法指定；非 macOS 分支直接返回 Err（见 main.rs）。 */
  mm_print: '弹对话框、目标由用户选；非 macOS 直接不可用',

  /* svg → pdf 是**纯计算**，返回 String，不落盘。
     只加载系统字体做矢量转换，没有写操作。 */
  mm_svg_to_pdf: '纯计算，返回字符串不写文件',

  /* 打开本程序的数据目录。无路径参数，目标固定，
     不是"任意路径打开"（那是 fpx_open_path，已定 M）。 */
  fpx_open_data_dir: '目标固定为本程序数据目录，无外部参数',

  /* 同上，kind 只有 group/project 两个取值，目标仍由 resolver 固定。 */
  fpx_open_backup_dir: '目标由 backup::resolve_dir 固定，kind 仅两值',

  /* 写剪贴板。算副作用，但它是"复制"这个最基础操作的载体，
     标 W 会让几乎所有插件都带 W（进而触发 destructive 黄区），
     反而淹没真正的信号。保持 unknown，等有明确判据再定。 */
  fpx_copy_text: '写剪贴板：定级会让几乎所有插件带 W，信号被淹没',
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
