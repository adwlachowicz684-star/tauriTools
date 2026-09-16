/**
 * 托盘 / 隐藏到托盘 回归测试（开发用，可删）
 * ------------------------------------------------------------
 * B1：Ctrl+~ 把窗口藏到托盘，托盘图标是唯一的回路。
 *
 * 纯 Rust 侧改动，沙盒装不上 cargo，无法编译验证。
 * 本测试只做源码级接线检查，**不能**替代 cargo build。
 *
 * 行为验证：
 *   起应用 → Ctrl+~ → 窗口消失但进程还在 → 点托盘图标 → 窗口回来
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

const mainSrc = src('src-tauri/src/main.rs');
const shellSrc = src('js/shell.js');
const appSrc = src('src/App.tsx');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

console.log('\n=== 1. Rust：托盘必须创建 ===');
t('导入 tray 相关类型',
  /use tauri::tray::\{[^}]*TrayIconBuilder[^}]*\};/.test(mainSrc));
t('导入 menu 相关类型',
  /use tauri::menu::\{[^}]*MenuBuilder[^}]*\};/.test(mainSrc));
t('setup 里创建了托盘', /TrayIconBuilder::with_id/.test(mainSrc));
/* 光有 Builder 不够 —— 必须真的 .build()。
   破坏验证时发现：把 `tray.build(app)?;` 注释掉，上一条仍然绿
   （Builder 的构造还在），所以必须单独钉住 build 这一行。 */
t('托盘真的调用了 .build(app)', /tray\.build\(app\)\?;/.test(mainSrc));
t('托盘有 id（便于将来按 id 取用）', /with_id\("main-tray"\)/.test(mainSrc));

console.log('\n=== 2. 托盘菜单 ===');
t('有「显示面板」菜单项', /MenuItemBuilder::with_id\("show", "显示面板"\)/.test(mainSrc));
t('有「退出」菜单项', /MenuItemBuilder::with_id\("quit", "退出"\)/.test(mainSrc));
t('菜单事件处理 show', /"show" => focus_main_window\(app\)/.test(mainSrc));
t('菜单事件处理 quit', /"quit" => app\.exit\(0\)/.test(mainSrc));
/* 没有"退出"的话，窗口一藏用户就只能靠任务管理器杀进程 */
t('有 separator（显隐与退出分开，避免误点）', /\.separator\(\)/.test(mainSrc));

console.log('\n=== 3. 左键单击切换 ===');
/* 用 Up 而不是 Down：部分平台 Down 时就触发，随后系统又弹菜单，两者叠加会错乱 */
t('监听 Click 事件的 Left + Up',
  /TrayIconEvent::Click \{\s*button: MouseButton::Left,\s*button_state: MouseButtonState::Up,/.test(mainSrc));
t('点击时按当前可见状态切换（不是无条件 show）',
  /if main_window_visible\(app\) \{[\s\S]{0,120}\.hide\(\)[\s\S]{0,120}focus_main_window\(app\)/.test(mainSrc));

console.log('\n=== 4. focus 三步不能省 ===');
t('有 focus_main_window 辅助函数', /fn focus_main_window\(/.test(mainSrc));
/* 切出 focus_main_window 函数体再检查，**不要在整份源码上匹配**。
   破坏验证时发现：删掉函数里的 set_focus 后这条仍然绿 ——
   因为 single-instance 回调里还有一份同样三步的代码，
   整份匹配会被"另一处仍有"蒙混。这与 theme-bridge 那次是同一类坑。 */
const iFocus = mainSrc.indexOf('fn focus_main_window');
const focusBody = iFocus < 0 ? '' : mainSrc.slice(iFocus, mainSrc.indexOf('\n}', iFocus));
t('unminimize → show → set_focus 顺序正确',
  /w\.unminimize\(\);[\s\S]{0,80}w\.show\(\);[\s\S]{0,80}w\.set_focus\(\);/.test(focusBody));
t('三步都在（缺任一步都不算完整）',
  /unminimize\(\)/.test(focusBody) && /\.show\(\)/.test(focusBody) && /set_focus\(\)/.test(focusBody));
t('取不到窗口时记日志而不是静默失败',
  /没有 main 窗口，无法聚焦/.test(mainSrc));

console.log('\n=== 5. 可见性判定的默认取向 ===');
/* 查不到 / 查询失败都当作不可见：这样切换会走 show 分支（最坏多调一次 show，无害）；
   反过来若当作可见，用户就永远切不回来了。 */
t('is_visible 失败时回退为 false（不是 true）',
  /and_then\(\|w\| w\.is_visible\(\)\.ok\(\)\)\s*\n\s*\.unwrap_or\(false\)/.test(mainSrc));

console.log('\n=== 6. hide 与 close 是两回事 ===');
t('window_action 支持 hide', /"hide" => window\.hide\(\),/.test(mainSrc));
t('hide 分支有注释说明与 close 的区别（close 会销毁窗口）',
  /与 `close` 的区别是 close 会\*\*销毁\*\*窗口/.test(mainSrc));
t('注册了 tray_toggle_window 命令',
  /tray_toggle_window\s*\n?\s*\]\)/.test(mainSrc) || /\n\s+tray_toggle_window\n\s+\]\)/.test(mainSrc));

console.log('\n=== 7. 托盘在 --mcp 模式下也创建（关键）===');
/* --mcp 模式窗口本来就是隐藏的，没有托盘的话进程只能靠任务管理器杀。
   所以托盘必须在 if mcp_only 之外。 */
const iTray = mainSrc.indexOf('TrayIconBuilder::with_id');
const iMcp = mainSrc.indexOf('if mcp_only {');
t('托盘创建在 if mcp_only **之前**', iTray > 0 && iMcp > iTray,
  `tray=${iTray} mcp=${iMcp}`);

console.log('\n=== 8. 图标缺失时的降级 ===');
t('取不到默认图标时仍创建托盘（功能不丢）',
  /默认图标不可用，托盘将无图标/.test(mainSrc));
t('用 default_window_icon 而不是硬编码路径',
  /app\.default_window_icon\(\)\.cloned\(\)/.test(mainSrc));

console.log('\n=== 9. 前端：Ctrl+~ 接线 ===');
/* 反引号键位：多数布局 e.key 是 '`'；带 Shift 的 '~' 一并接受 */
t('无构建版（shell.js）有 mod+` 命令',
  /'mod\+`':/.test(shellSrc));
t('无构建版监听 ` 或 ~',
  /e\.key === '`' \|\| e\.key === '~'/.test(shellSrc));
t('Vite 版（App.tsx）监听 ` 或 ~',
  /e\.key === '`' \|\| e\.key === '~'/.test(appSrc));
t('两个版本都调 win("hide")',
  /host\.win\('hide'\)/.test(shellSrc) && /win\('hide'\)/.test(appSrc));

console.log('\n=== 10. 隐藏后必须告诉用户怎么回来（否则以为崩了）===');
/* 窗口隐藏后收不到键盘事件，全局快捷键要额外插件。
   所以只能"藏"不能"唤"，提示就变成了必需项而不是锦上添花。 */
t('无构建版有提示', /已隐藏到托盘/.test(shellSrc));
t('Vite 版有提示', /已隐藏到托盘/.test(appSrc));
t('提示里说明了唤回方式（点托盘图标）',
  /点击托盘图标可唤回/.test(shellSrc) && /点击托盘图标可唤回/.test(appSrc));

console.log('\n=== 11. React 依赖数组 ===');
/* 用了 pushToast 就要进依赖数组，否则 linter 报警；
   pushToast 依赖 setTimer（[]），所以稳定，不会反复重绑 keydown。 */
t('keydown 的 useEffect 依赖含 pushToast',
  /\}, \[activeId, pushToast\]\);/.test(appSrc));

console.log('\n=== 12. 结构 ===');
const lines = mainSrc.split('\n');
let depth = 0, inBlock = false, minD = 0;
for (const ln of lines) {
  let j = 0;
  while (j < ln.length) {
    const c = ln[j];
    if (inBlock) {
      if (ln.substr(j, 2) === '*/') { inBlock = false; j += 2; continue; }
      j++; continue;
    }
    if (ln.substr(j, 2) === '//') break;
    if (ln.substr(j, 2) === '/*') { inBlock = true; j += 2; continue; }
    if (c === '"') {
      j++;
      while (j < ln.length) {
        if (ln[j] === '\\') { j += 2; continue; }
        if (ln[j] === '"') { j++; break; }
        j++;
      }
      continue;
    }
    if (c === "'") {
      const nxt = ln[j + 1] || '';
      if (nxt === '\\') { j += 4; continue; }
      if (ln[j + 2] === "'") { j += 3; continue; }
      j++; continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth < minD) minD = depth;
    j++;
  }
}
t('main.rs 花括号平衡', depth === 0 && minD === 0, `depth=${depth}`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
console.log('注意：只检查接线，**不能**替代 cargo build + 真实托盘实测。');
process.exit(fail ? 1 : 0);
