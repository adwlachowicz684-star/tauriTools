/**
 * 单实例（single-instance）接线检查（开发用，可删）
 * ------------------------------------------------------------
 * 这是**纯 Rust 侧**的改动，沙盒里装不上 cargo（rustup 下载被拦截），
 * 无法真正编译验证。本测试只做源码级接线检查 —— 它能保证的是
 * "这行代码还在、写法没被改坏"，**不能**替代 cargo build。
 *
 * 真正的验证只有一条：本机跑 `cargo build`，然后连开两次应用，
 * 确认第二次会把第一次的窗口带到前台而不是新开一个。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const cargo = src('src-tauri/Cargo.toml');
const main = src('src-tauri/src/main.rs');

/* ---------- 1. 依赖 ---------- */
console.log('\n=== 1. 依赖 ===');
t('Cargo.toml 声明了 tauri-plugin-single-instance',
  /tauri-plugin-single-instance\s*=\s*"2"/.test(cargo));

/* 插件要求 Rust >= 1.77.2；Cargo.toml 里 rust-version 正好是这个，
   差一个版本就是硬编译错误，钉住它 */
const rv = cargo.match(/rust-version\s*=\s*"([^"]+)"/);
t('rust-version 满足插件要求（>= 1.77.2）', !!rv && rv[1] >= '1.77.2', rv?.[1]);

/* ---------- 2. 注册 ---------- */
console.log('\n=== 2. 注册 ===');
t('main.rs 调用了 init', /tauri_plugin_single_instance::init\(/.test(main));

/* 必须排在其它插件之前：第二个实例要尽早退出，
   否则它会白做一堆初始化再被杀掉 */
const iSingle = main.indexOf('tauri_plugin_single_instance::init');
const iShell = main.indexOf('tauri_plugin_shell::init');
const iHttp = main.indexOf('tauri_plugin_http::init');
t('注册在最前面（早于 shell / http）',
  iSingle > 0 && iSingle < iShell && iSingle < iHttp,
  `single=${iSingle} shell=${iShell} http=${iHttp}`);

/* ---------- 3. 回调内容 ---------- */
console.log('\n=== 3. 回调 ===');
// 取 init(...) 这一段的正文
const seg = main.slice(iSingle, iSingle + 900);
t('拿到 main 窗口', /get_webview_window\("main"\)/.test(seg));
t('unminimize（最小化时直接 set_focus 在部分平台无效）', /w\.unminimize\(\)/.test(seg));
t('show（--mcp 拉起的实例窗口是隐藏的）', /w\.show\(\)/.test(seg));
t('set_focus（真正带到前台）', /w\.set_focus\(\)/.test(seg));
t('窗口不存在时有兜底日志，而不是静默', /已有实例没有 main 窗口/.test(seg));
t('闭包不捕获外部变量（否则要 move + \'static）',
  /init\(\|app, _argv, _cwd\|/.test(seg));

/* ---------- 4. MCP-only 用 hide 而不是 close ---------- */
console.log('\n=== 4. MCP-only ===');
const iMcp = main.indexOf('if mcp_only {');
const mcpSeg = main.slice(iMcp, iMcp + 900);
t('用 hide（close 会销毁窗口，之后再双击就"点了没反应"）',
  /w\.hide\(\)/.test(mcpSeg));
t('不再用 close 销毁主窗口', !/w\.close\(\)/.test(mcpSeg));
t('注释里写明了为什么是 hide', /hide 而不是 close/.test(mcpSeg));

/* window_action 里的 "close" 是用户点关闭按钮，与单实例无关，必须还在 */
t('用户点关闭按钮的 close 未被误删',
  /"close"\s*=>\s*window\.close\(\)/.test(main));

/* ---------- 5. 命令行模式不受影响 ---------- */
console.log('\n=== 5. 命令行模式 ===');
/* fpx::cli::try_handle 在 Builder 之前就 exit 了，不进 Tauri，
   所以 CLI（自检 / 导出之类）在有实例运行时仍要能用 —— 这是刻意的。 */
const iCli = main.indexOf('fpx::cli::try_handle');
t('CLI 分支在 Builder 之前', iCli > 0 && iCli < main.indexOf('tauri::Builder::default()'));
t('CLI 分支直接 exit，不进 Tauri', /std::process::exit\(/.test(main.slice(iCli, iCli + 300)));

/* ---------- 6. 括号平衡（无法编译，至少保证结构没写坏） ---------- */
console.log('\n=== 6. 结构自检 ===');
const lines = main.split('\n');
let depth = 0, inBlock = false, minDepth = 0;
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
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth < minDepth) minDepth = depth;
    j++;
  }
}
t('main.rs 花括号平衡', depth === 0 && minDepth === 0, `收尾 depth=${depth}`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
console.log('注意：本测试只检查接线，**不能**替代 cargo build + 实际双开验证。');
process.exit(fail ? 1 : 0);
