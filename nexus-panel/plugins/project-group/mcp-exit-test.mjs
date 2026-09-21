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

done();
