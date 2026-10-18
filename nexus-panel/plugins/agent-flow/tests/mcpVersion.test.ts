import test from 'node:test';
import assert from 'node:assert/strict';
import { listTools, callTool, MCP_PROTOCOL_VERSION, type HttpPost } from '../engine/mcpClient';
import { readSrc } from './srcScan';

const REF = { name: 's', url: 'http://s' };
const SEQ = (...b: string[]): HttpPost => {
  let n = 0;
  return async () => ({ status: 200, text: b[Math.min(n++, b.length - 1)] });
};
const init = (v: unknown) => JSON.stringify({ jsonrpc: '2.0', result: { protocolVersion: v } });
const TOOLS = '{"jsonrpc":"2.0","result":{"tools":[{"name":"t"}]}}';
const CALL = '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"真实结果"}]}}';

/* ================================================================== */
/* 握手通过 ≠ 能说话                                                   */
/* ================================================================== */

/*
 * 以前握手**完全不看** result.protocolVersion ——
 * 服务端回什么版本都照旧继续。实测（改之前）：
 *
 *   server 说 1999-01-01 → listTools 照常返回工具，一切正常
 *
 * 而 MCP 的流程是：客户端报一个版本，服务端回**它自己**用的那个。
 * 两边不一致时规范允许两种做法（按服务端版本继续 / 断开），
 * 我们只实现了一个版本，所以只能选后者 —— 但**必须说出来**。
 *
 * 静默继续的代价不是"现在出错"，而是把出错**推迟并换个样子**：
 *   握手成功 → 工具清单也拿到了 → 一到真正调用就莫名失败
 * 那种失败完全看不出跟版本有关，用户会去查工具参数、查网络 ——
 * 与 runMcp 注释里说的是同一类：不报错、原因对不上。
 */
test('版本不一致：明确失败，且说清两边各自是什么版本', async () => {
  await assert.rejects(
    listTools(REF, SEQ(init('1999-01-01'), '{"result":{}}', TOOLS), 5),
    (e: Error) => {
      assert.ok(/版本/.test(e.message), `要说版本问题，实际：${e.message}`);
      assert.ok(e.message.includes(MCP_PROTOCOL_VERSION), '要说本端版本');
      assert.ok(e.message.includes('1999-01-01'), '要说服务端版本 —— 否则没法判断升级哪边');
      return true;
    },
  );
});

test('版本不一致：报错要指到"后续调用会失败"，别让人查网络', async () => {
  await assert.rejects(
    listTools(REF, SEQ(init('1999-01-01'), '{"result":{}}', TOOLS), 5),
    (e: Error & { detail?: string }) => {
      assert.ok(/后续调用|调用会失败/.test(e.detail ?? ''),
        `提示要说明后果，实际：${e.detail}`);
      return true;
    },
  );
});

test('版本一致：照常通过（不能被修坏）', async () => {
  const t = await listTools(REF, SEQ(init(MCP_PROTOCOL_VERSION), '{"result":{}}', TOOLS), 5);
  assert.equal(t.length, 1);
});

/*
 * 服务端不回 protocolVersion 时**不报错** ——
 * 规范里这一项是必填，但现实中有 server 不填。
 * 为它把整个服务判掉属于误伤（反方向的错）：
 * 静默继续最多是"将来某次调用失败"，而误报是"现在就不能用"。
 */
test('服务端不给版本：不误伤（照常通过）', async () => {
  const t = await listTools(REF, SEQ('{"jsonrpc":"2.0","result":{}}', '{"result":{}}', TOOLS), 5);
  assert.equal(t.length, 1);
});

test('版本前后带空白：trim 后再比（别把格式差异当成不兼容）', async () => {
  const t = await listTools(
    REF, SEQ(init(`  ${MCP_PROTOCOL_VERSION}  `), '{"result":{}}', TOOLS), 5,
  );
  assert.equal(t.length, 1);
});

test('callTool 同样查版本（不能只查 listTools）', async () => {
  await assert.rejects(
    callTool(REF, 't', {}, SEQ(init('1999-01-01'), '{"result":{}}', CALL), 5),
    (e: Error) => {
      assert.ok(/版本/.test(e.message), `callTool 也要查版本，实际：${e.message}`);
      return true;
    },
  );
});

/* ================================================================== */
/* 源码守卫                                                            */
/* ================================================================== */

test('源码守卫：握手必须校验 protocolVersion（不许只看有没有 error）', () => {
  const src = readSrc('engine/mcpClient.ts');
  const i = src.indexOf('async function handshake');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/protocolVersion/.test(body), '握手要读服务端回的版本');
  assert.ok(/!== MCP_PROTOCOL_VERSION/.test(body),
    '要比对本端版本 —— 只读不比等于没查');
});
