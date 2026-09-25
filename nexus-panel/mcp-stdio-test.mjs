/**
 * MCP stdio 模式回归测试（开发用，可删）
 * ------------------------------------------------------------
 * A3：让 Claude Desktop 这类客户端以子进程方式拉起 MCP server。
 *
 * 纯 Rust 侧改动，沙盒装不上 cargo，无法编译验证。
 * 本测试只做源码级接线检查，**不能**替代 cargo build。
 *
 * 行为验证：
 *   printf '{"jsonrpc":"2.0","id":1,"method":"ping"}\n' | nexus-panel.exe --stdio
 * 期望 stdout 只有一行 JSON，没有任何其它输出。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'src-tauri/src');
const rs = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');

const mcp = rs('fpx/mcp.rs');
const mainSrc = rs('main.rs');
const cliSrc = rs('fpx/cli.rs');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/** 取 serve_stdio 函数体 */
const iStdio = mcp.indexOf('pub fn serve_stdio');
const stdioBody = mcp.slice(iStdio, mcp.indexOf('\npub fn stop()', iStdio));

console.log('\n=== 1. 入口位置（最关键的一条）===');
/* stdio 必须在 Builder 之前：Tauri 一旦 run()，往 stdout 打了什么就不可控。 */
const iStdioBranch = mainSrc.indexOf('"--stdio"');
const iBuilder = mainSrc.indexOf('tauri::Builder::default()');
t('main.rs 里有 --stdio 分支', iStdioBranch > 0);
t('--stdio 在 Builder **之前**处理', iStdioBranch > 0 && iBuilder > iStdioBranch,
  `stdio=${iStdioBranch} builder=${iBuilder}`);
t('--stdio 分支里直接 exit，不会继续往下走 Tauri',
  /serve_stdio\(dir\)[\s\S]{0,300}std::process::exit\(0\);/.test(mainSrc));
/* cli::try_handle 也在 Builder 之前，--stdio 要在它之后（两者互不冲突） */
const iCli = mainSrc.indexOf('fpx::cli::try_handle');
t('--stdio 在 cli::try_handle 之后（命令行模式优先，互不冲突）',
  iCli > 0 && iStdioBranch > iCli, `cli=${iCli} stdio=${iStdioBranch}`);

console.log('\n=== 2. stdout 洁净（协议通道不能被污染）===');
/* println! 会走 stdout。eprintln! 走 stderr，是允许的。
   注意 "eprintln!" 包含 "println!" 子串，必须按词边界排除。 */
const stdoutPrints = [...stdioBody.matchAll(/(^|[^a-z])println!/g)];
t('serve_stdio 内没有 println!（只有 eprintln!）', stdoutPrints.length === 0,
  stdoutPrints.length ? `发现 ${stdoutPrints.length} 处` : '');
t('日志走 stderr', /eprintln!/.test(stdioBody));
t('错误退出也用 eprintln! 而非 println!',
  /eprintln!\("\[mcp:stdio\] 退出/.test(mainSrc));

console.log('\n=== 3. 协议：换行分隔 JSON ===');
t('按行读 stdin', /read_line\(&mut line\)/.test(stdioBody));
t('EOF（n==0）时正常退出', /if n == 0 \{\s*\n\s*break;/.test(stdioBody));
t('空行跳过', /if text\.is_empty\(\) \{\s*\n\s*continue;/.test(stdioBody));
t('解析失败回 -32700 而不是崩',
  /"code": -32700/.test(stdioBody) && /解析失败/.test(stdioBody));
/*
 * ⚠️ 早先写的是 `/-32700[\s\S]{0,200}continue;/`：200 字符是个拍脑袋的窗口。
 *    真实实现里 -32700 与 continue 之间夹着 write_out 的**三分支结果处理**
 *    （Ok(true)/Ok(false)/Err(w)），实际间距 ~330 字符，超出窗口 → 假阴性。
 *
 *    改成按**语法结构**取：从 serde_json::from_str 的 Err(e) 分支起、
 *    到该分支闭合为止。这样以后在中间再插入处理也不会脱靶。
 */
const iParseErr = stdioBody.indexOf('Err(e) => {');
const parseErrArm = iParseErr >= 0
  ? stdioBody.slice(iParseErr, stdioBody.indexOf('\n        };', iParseErr))
  : '';
t('解析失败后 continue（一行坏数据不能打死整个 server）',
  /"code":\s*-32700/.test(parseErrArm) && /continue;/.test(parseErrArm),
  `分支长度 ${parseErrArm.length}`);

console.log('\n=== 4. flush（不 flush 客户端会一直等）===');
t('有专门的 write_out 做写 + flush', /fn write_out<W: Write>/.test(mcp));
t('每条响应后 flush', /out\.flush\(\)/.test(stdioBody));
t('write_out 里 writeln 后立即 flush',
  /writeln!\(out, "\{text\}"\)[\s\S]{0,120}out\.flush\(\)/.test(mcp));

console.log('\n=== 5. 通知（无 id 不回复）===');
t('有 dispatch_opt 判定通知', /fn dispatch_opt/.test(mcp));
/* 区分「没有 id 字段」和「id 为 null」：后者是合法请求，要回 id:null */
t('用 contains_key("id") 判断，而不是 is_null（id:null 是合法请求）',
  /o\.contains_key\("id"\)/.test(mcp));
t('stdio 走 dispatch_opt（通知不回复）',
  /if let Some\(resp\) = dispatch_opt\(&req, &dir\)/.test(stdioBody));

console.log('\n=== 6. 数据目录：与 GUI 模式必须同一个 ===');
/* 这是本轮顺带修掉的真 bug：cli.rs 原实现拼的路径和 Tauri 的
   app_data_dir() 不是同一个目录，CLI 一直在读写另一份配置。 */
t('cli.rs 有 APP_IDENTIFIER 常量', /pub const APP_IDENTIFIER: &str = "com\.nexus\.panel";/.test(cliSrc));
t('dirs_data_dir 已改为 pub（供 stdio 复用）', /pub fn dirs_data_dir\(\)/.test(cliSrc));
t('按 Tauri 规则拼：Windows 走 APPDATA', /cfg!\(target_os = "windows"\)[\s\S]{0,120}APPDATA/.test(cliSrc));
t('按 Tauri 规则拼：macOS 走 ~/Library/Application Support',
  /cfg!\(target_os = "macos"\)[\s\S]{0,200}Application Support/.test(cliSrc));
t('按 Tauri 规则拼：Linux 走 XDG_DATA_HOME 优先，回退 ~/.local/share',
  /XDG_DATA_HOME/.test(cliSrc) && /\.local/.test(cliSrc));
t('末尾是 identifier + project-group（与 resolve_data_dir 一致）',
  /base\.join\(APP_IDENTIFIER\)\.join\("project-group"\)/.test(cliSrc));
/* 旧实现用的是 nexus-panel / .nexus-panel，不是 identifier */
t('不再用旧的 nexus-panel 字面量', !/join\("nexus-panel"\)|join\("\.nexus-panel"\)/.test(cliSrc));

console.log('\n=== 7. identifier 一致性守护（改配置忘了改代码就会红）===');
const confPath = path.join(HERE, 'src-tauri/tauri.conf.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
const codeId = cliSrc.match(/pub const APP_IDENTIFIER: &str = "([^"]+)"/)?.[1];
t('tauri.conf.json 的 identifier 与代码常量一致',
  !!codeId && codeId === conf.identifier,
  `配置=${conf.identifier} 代码=${codeId}`);

console.log('\n=== 8. mcp.rs 不再依赖 AppHandle（stdio 才能复用工具链）===');
t('call_tool 收 &Path 而不是 &AppHandle',
  /fn call_tool\(req: &Value, dir: &Path\)/.test(mcp));
t('handle 收 PathBuf', /fn handle\(mut stream: TcpStream, dir: PathBuf\)/.test(mcp));
t('serve 里解析一次 dir 给线程用',
  /let dir = super::store::resolve_data_dir\(&app\)/.test(mcp));
t('无残留 data_dir_of（唯一出口已下沉为 dir 参数）', !/data_dir_of/.test(mcp));
t('无残留 load_cfg(app) / snapshot(app)',
  !/load_cfg\(app\)/.test(mcp) && !/snapshot\(app\)/.test(mcp));

console.log('\n=== 9. 结构 ===');
for (const [label, src] of [['fpx/mcp.rs', mcp], ['main.rs', mainSrc], ['fpx/cli.rs', cliSrc]]) {
  const lines = src.split('\n');
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
  t(`${label} 花括号平衡`, depth === 0 && minD === 0, `depth=${depth}`);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
console.log('注意：只检查接线，**不能**替代 cargo build + 真实管道实测。');
process.exit(fail ? 1 : 0);
