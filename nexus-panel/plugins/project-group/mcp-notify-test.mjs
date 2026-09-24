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

done();
