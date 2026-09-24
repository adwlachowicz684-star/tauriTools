/**
 * 退出时关闭 MCP 进程（#53，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/mcp-exit-test.mjs
 *
 * #53 此前是**死配置项**：model.rs 有字段、有 Default，
 * 但全库既无读取点、也无界面入口 —— 用户根本看不到它。
 *
 * 两处都要修：后端真的读它并 stop，前端给它一个开关。
 * 只修一边都不算做完。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '..', '..', 'src-tauri', 'src');
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const main = strip(fs.readFileSync(path.join(RS, 'main.rs'), 'utf8'));
const dlg = strip(fs.readFileSync(path.join(HERE, 'components/SettingsDialog.tsx'), 'utf8'));
const types = strip(fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8'));

console.log('\n=== 1. 后端：真的读了配置并 stop ===');
{
  t('有 close_mcp_on_exit 读取点', /load_config\(&dir\)\.close_mcp_on_exit/.test(main));
  t('读到 true 才 stop', /if should_stop \{\s*\n\s*crate::fpx::mcp::stop\(\);/.test(main));
  /* 解析不出数据目录时不能因为报错就不退出 */
  t('读配置失败不阻止退出（unwrap_or(false)）', /unwrap_or\(false\)/.test(main));
}

console.log('\n=== 2. 钩子必须挂对（最容易写错的一处）===');
{
  /*
   * Tauri 2 的 RunEvent **只在 App::run(|h, event| ..) 回调里给**，
   * Builder 上没有 on_event。挂在 Builder 上编译不过 ——
   * 我第一版就是这么写错的。
   */
  t('走 build + run 回调', /\.build\(tauri::generate_context!\(\)\)/.test(main)
    && /\.run\(\|app_handle, event\|/.test(main));
  t('没有挂在 Builder 上的 on_event', !/\.on_event\(\|/.test(main));
  t('匹配 RunEvent::Exit', /if let tauri::RunEvent::Exit = event/.test(main));
}

console.log('\n=== 3. 为什么用 Exit 而不是窗口关闭事件 ===');
{
  /*
   * 本项目用 hide 隐藏窗口（第二实例靠 single-instance 唤回），
   * 且托盘「退出」走 app.exit(0) —— 两者都不经过窗口事件。
   * RunEvent::Exit 是唯一覆盖全部退出路径的钩子。
   */
  t('托盘退出走 app.exit', /"quit" => app\.exit\(0\)/.test(main));
  t('窗口用 hide 不是 close', /w\.hide\(\)/.test(main));
}

console.log('\n=== 4. 前端要有开关（此前连入口都没有）===');
{
  t('types 里有字段', /closeMcpOnExit: boolean/.test(types));
  t('设置里有 state', /const \[closeMcpOnExit, setCloseMcpOnExit\] = useState\(/.test(dlg));
  t('设置里有勾选框', /checked=\{closeMcpOnExit\} onChange=\{setCloseMcpOnExit\}/.test(dlg));
  /* 保存时要带着，否则改了不落盘 */
  t('保存时带上', /\n\s*closeMcpOnExit,/.test(dlg));
  t('说明讲清两种用法', /不勾则进程常驻/.test(dlg));
}

console.log('\n=== #42 MCP 客户端注册自愈 ===');
{
  const mcp = strip(fs.readFileSync(path.join(RS, 'fpx/mcp.rs'), 'utf8'));
  const main = strip(fs.readFileSync(path.join(RS, 'main.rs'), 'utf8'));
  const mod = strip(fs.readFileSync(path.join(RS, 'fpx/mod.rs'), 'utf8'));

  /*
   * 原版 `McpRegistrationService` 三件事：
   *   1) FPX_ROOT 用户环境变量
   *   2) 项目根 .mcp.json（command 用 {env:FPX_ROOT} 占位符）
   *   3) TRAE 全局 mcp.json：**仅当条目已存在时**更新（自愈）
   *
   * 本版只做第 3 件 —— 前两件**不适用**：
   *
   *   · 原版数据目录是 <root>\数据\...，所以 root = 数据目录的父目录
   *     = exe 所在目录（绿色软件布局）。本版数据目录在
   *     %APPDATA%\<APP_ID>\project-group，父目录只是宿主的数据目录，
   *     **不是任何人的项目根** —— 往那儿写 .mcp.json 没有客户端会读。
   *   · 客户端读的是**用户打开的项目目录**下的 .mcp.json，
   *     那个目录我们无从得知，也不该去写。
   *   · FPX_ROOT 是为 .mcp.json 里的 {env:FPX_ROOT} 占位符服务的，
   *     不写 .mcp.json 就没有消费者。
   */

  /* 一、只自愈**已存在**的条目，绝不主动创建 */
  t('有 register_clients 入口', /pub fn register_clients\(\) -> String/.test(mcp));
  t('只处理已存在的配置文件（exists 守卫）',
    /if !path\.exists\(\) \{\s*\n\s*continue;/.test(mcp));
  t('条目不存在就跳过（不创建）',
    /let servers = match root\.get_mut\("mcpServers"\)[\s\S]{0,120}None => return Ok\(false\)/.test(mcp));
  t('不属于本服务的条目不动', /if !mine && !is_own_exe\(entry, &exe_name\) \{\s*\n\s*continue;/.test(mcp));

  /* 二、"是我们 exe 的旧位置"的判据 = 文件名相同 */
  t('is_own_exe 按文件名判（不是路径前缀）',
    /fn is_own_exe\([\s\S]{0,400}file_name\(\)/.test(mcp));
  t('文件名比较忽略大小写',
    /eq_ignore_ascii_case\(exe_name\)/.test(mcp));

  /* 三、启动参数必须是 --stdio，不能照抄原版的 --mcp */
  /*
   * 原版是独立 exe，`--mcp` 就是它的 stdio 入口；
   * 本版 `--mcp` 是"隐藏窗口跑界面"（main.rs），真正的 stdio 是 `--stdio`。
   * 照抄的话客户端拉起进程后收不到任何响应 —— 进程起来了、也不报错，
   * 只是不在说协议，表现为"连上就没反应"，日志里什么都没有。
   */
  t('stdio 参数是 --stdio（不是原版的 --mcp）',
    /pub const MCP_STDIO_ARG: &str = "--stdio";/.test(mcp));
  t('不出现 --mcp 作为注册参数（反面证据）',
    !/MCP_STDIO_ARG: &str = "--mcp"/.test(mcp));

  /* 四、原子写 */
  t('先写 .tmp 再 rename（原子）',
    /let tmp = path\.with_extension\("json\.tmp"\);[\s\S]{0,160}std::fs::rename\(&tmp, path\)/.test(mcp));

  /* 五、幂等：只在变化时写 */
  t('幂等（无变化则不写）',
    /if !changed \{\s*\n\s*return Ok\(false\);/.test(mcp));

  /* 六、启动时自动跑（原版在 App.xaml.cs 后台执行） */
  t('启动时调用 register_clients', /let reg = fpx::mcp::register_clients\(\);/.test(main));
  t('启动结果只记日志（失败不阻断）',
    /if !reg\.is_empty\(\) \{\s*\n\s*eprintln!\("\[mcp\] 注册自愈/.test(main));

  /* 七、有手动入口（启动了不代表事后能再触发） */
  t('有 fpx_mcp_register 命令', /pub fn fpx_mcp_register\(\) -> String/.test(mod));
  t('命令已注册进 invoke_handler', /fpx::fpx_mcp_register,/.test(main));
}

done();
