/**
 * MCP 通知不回包（#486）+ stdout 断裂优雅退出（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/mcp-notify-test.mjs
 *
 * #486 在状态表里曾被标成"真缺失（mcp.rs 只在注释里提到）"。
 * 回原版 `McpServer.cs` 核对后确认：**本已实现**（`dispatch_opt` 返回 None、
 * stdio 只在 `Some` 时写、HTTP 走 204）—— 是**清单误判**。
 *
 * 但它**一条断言都没有**。通知不回包这类行为一旦回退，
 * 表现是"客户端连上就断开"，而日志里什么都没有 —— 最难查的那一类。
 * 所以本文件的价值不在修，而在**把它钉住**。
 *
 * 顺带修的真差异：stdout 断裂（客户端关闭管道）时原版是 `break` 优雅退出，
 * 本版此前用 `?` 往外抛 → main 里 `exit(1)`。于是**对方正常退出**
 * 被记成一条失败日志 + 非零退出码，部分客户端会据此报"服务崩溃"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '..', '..', 'src-tauri', 'src');
const { t, done } = makeT();
/* 注释里也会提到这些关键字（本文件自己就在提），
   所以断言一律打在**剥掉注释**的源码上 ——
   不剥的话把代码删了、注释留着，断言照样通过（空跑）。 */
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const mcp = strip(fs.readFileSync(path.join(RS, 'fpx', 'mcp.rs'), 'utf8'));

console.log('\n=== 1. #486 通知不回包：三处必须都在 ===');
{
  /* 一、内核：dispatch_opt 对"没有 id"返回 None */
  t('dispatch_opt 存在', /fn dispatch_opt\(req: &Value, dir: &Path\) -> Option<Value>/.test(mcp));

  const f = mcp.indexOf('fn dispatch_opt(');
  const body = mcp.slice(f, f + 700);
  /*
   * 二、必须区分「没有 id」与「id 为 null」。
   *
   * 后者是**合法请求**，客户端要的是 `id:null` 的响应；
   * 当成通知吞掉的话，客户端会一直等一个永不到来的响应 ——
   * 表现为"卡住无响应"，而服务端看起来一切正常。
   */
  t('判据含「对象里没有 id 这个键」', /contains_key\("id"\)/.test(body), body.slice(0, 200));
  t('判据含「id 不是 null」（id:null 仍要回）', /!v\.is_null\(\)/.test(body));
  t('无 id 时返回 None', /return None;/.test(body));

  /* 三、stdio 主循环：只在 Some 时才写 */
  const loop = mcp.slice(mcp.indexOf('pub fn serve_stdio('), mcp.indexOf('fn write_out<W: Write>('));
  t('stdio 用 dispatch_opt 而不是 dispatch', /dispatch_opt\(&req, &dir\)/.test(loop));
  t('只在 Some(resp) 时才写 stdout', /if let Some\(resp\) = dispatch_opt/.test(loop));
  t('stdio 主循环里没有裸的 dispatch(&req', !/[^_]dispatch\(&req/.test(loop));

  /* 四、HTTP 模式：通知回 204，不是 200 */
  t('HTTP 对无 id 的请求回 204', /req\.get\("id"\)\.is_none\(\)[\s\S]{0,120}\(204, Value::Null\)/.test(mcp));
}

console.log('\n=== 2. stdout 断裂要优雅退出（对齐原版 McpServer.RunAsync）★ ===');
{
  /*
   * 原版：写 stdout 抛异常 → `break`（"客户端已关闭，正常退出服务循环"）。
   * 此前本版用 `?` 往外抛 → main 里 `exit(1)`。
   *
   * 后果是**报错报的不是真问题**：对方正常退出被记成失败 + 非零退出码，
   * 部分客户端据此报"服务崩溃"，而真相只是对方先走了。
   */
  const loop = mcp.slice(mcp.indexOf('pub fn serve_stdio('), mcp.indexOf('fn write_out<W: Write>('));
  t('解析失败那条也判了管道断开', (loop.match(/Ok\(false\)/g) || []).length >= 2);
  t('断开时 break 而不是 return Err', /Ok\(false\)[\s\S]{0,120}break;/.test(loop));
  t('不再有裸的 write_out\(...\)\?', !/write_out\([^)]*\)\?;/.test(loop));

  /*
   * 必须区分「管道断了」与「序列化失败」。
   *
   * 后者是真 bug，静默吞掉就再也查不到了。
   * 用**返回值**（Ok(true)/Ok(false)/Err）区分，而不是靠错误字符串去匹配 ——
   * 靠字符串的话改一下措辞判断就失效，且失效表现是"该退出的没退出"。
   */
  const w = mcp.slice(mcp.indexOf('fn write_out<W: Write>('), mcp.indexOf('fn write_out<W: Write>(') + 700);
  t('write_out 返回 Result<bool, String>', /fn write_out<W: Write>\(out: &mut W, v: &Value\) -> Result<bool, String>/.test(w));
  t('写失败返回 Ok(false)（正常收尾）', /if writeln!\(out, "\{text\}"\)\.is_err\(\) \{ return Ok\(false\); \}/.test(w));
  t('序列化失败仍然返回 Err（真 bug 不能吞）', /序列化响应失败/.test(w));
}

console.log('\n=== 4. #483 config 损坏告警必须走 stderr ★ ===');
{
  const mcp = strip(fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx/mcp.rs'), 'utf8'));
  const i = mcp.indexOf('pub fn serve_stdio(');
  const blk = mcp.slice(i, i + 2200);

  /*
   * 一、必须**在启动时**打，不能等到有请求。
   *
   * 等到有请求才报的话：客户端若只发 `initialize`（很多客户端就这样），
   * 告警永远发不出去 —— 而那正是最需要它的时候。
   */
  /*
   * 顺序断言必须**两端都判存在**：
   * 某端找不到时 indexOf 返回 -1，而 `-1 < 任意正数` 恒真 ——
   * 断言会**空跑**：锚点被改没了，它照样报绿，你以为在验次序，其实什么都没验。
   * 这类空跑靠"剥注释"扫不出来（锚点是代码不是注释），只能显式判 >= 0。
   */
  const iIssues = blk.indexOf('config_issues');
  const iReader = blk.indexOf('BufReader::new');
  t('启动时就打（在读 stdin 之前）',
    iIssues >= 0 && iReader >= 0 && iIssues < iReader);

  /*
   * 二、**必须走 stderr**。
   *
   * stdout 是 JSON-RPC 协议流，往里混一行文本会让客户端解析失败 ——
   * 表现为"连上就断开"，且日志里什么都没有。
   */
  t('走 stderr（不是 stdout / println!）',
    /writeln!\(std::io::stderr\(\)/.test(blk));
  /*
   * 用 `(?<![a-z])println!\(` 而不是 `println!\(`：
   * **`eprintln!(` 里就含 `println!(`** 这个子串，
   * 不排除前导字母的话会把 stderr 的那几处误判成 stdout（假失败）。
   */
  t('没有用 println! 输出到 stdout', !/(?<![a-z])println!\(/.test(blk));

  /*
   * 三、两类都要报，缺一不可。
   *
   * `config_issues` 只认**能解析**的 JSON（未知键 / 迁移记录），
   * 解析失败它直接返回空。若只用它，**最严重的那一类反而一条都不报**。
   */
  t('报 config_issues（未知键/迁移）', /store::config_issues\(&dir\)/.test(blk));
  t('报 Corrupted（解析失败，最严重那类）', /LoadOutcome::Corrupted/.test(blk));
  t('Corrupted 里说清"按默认值运行"', /按默认值运行/.test(blk));
  t('Corrupted 里说清原文另存到哪', /原文已另存为/.test(blk));

  /*
   * 四、打不出来**不能**让服务起不来。
   *
   * 用 `let _ =` 忽略结果：stderr 也可能被关掉（部分客户端不接 stderr），
   * 那时若把错误往外抛，服务直接启动失败 ——
   * 用户看到的是"MCP 连不上"，而真相只是"没人听 stderr"。
   */
  /*
   * 计数正则必须允许**换行与缩进**：Corrupted 那条是多行 `writeln!(`。
   * 只按单行匹配的话第二处统计不到（本轮就报了"忽略 1 处"的假失败）。
   */
  const ignores = (blk.match(/let _ = writeln!\([\s\S]{0,40}stderr\(\)/g) || []).length;
  t('写 stderr 失败不影响启动（let _ = 忽略）', ignores >= 2, '忽略 ' + ignores + ' 处');
  t('Corrupted 分支没有用 ? 往外抛', !/Corrupted[\s\S]{0,300}\?;/.test(blk));
}

done();
