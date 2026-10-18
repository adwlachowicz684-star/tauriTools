import test from 'node:test';
import assert from 'node:assert/strict';
import { listTools, callTool, type HttpPost } from '../engine/mcpClient';
import { readSrc } from './srcScan';

const REF = { name: 's', url: 'http://s' };
/** 按序返回：initialize / notifications / 真正那一步 */
const SEQ = (...bodies: string[]): HttpPost => {
  let n = 0;
  return async () => ({ status: 200, text: bodies[Math.min(n++, bodies.length - 1)] });
};
const OK_INIT = '{"jsonrpc":"2.0","result":{"protocolVersion":"2025-06-18"}}';
const CALL_OK = '{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"真实结果"}]}}';
const TOOLS_OK = '{"jsonrpc":"2.0","result":{"tools":[{"name":"t","description":"d","inputSchema":{}}]}}';
const INIT_ERR = '{"jsonrpc":"2.0","error":{"code":-32600,"message":"不支持的协议版本"}}';

/* ================================================================== */
/* callTool 以前完全不看握手的响应                                     */
/* ================================================================== */

/*
 * 以前 callTool 内联了一份握手，而且**连 initialize 的返回值都没接**：
 *
 *     await httpPost(url, { method: 'initialize', ... }, headers, t);
 *     await httpPost(url, { method: 'notifications/initialized' }, ...);
 *     const res = await httpPost(url, { method: 'tools/call', ... });
 *
 * 实测（改之前）：initialize 返回 JSON-RPC 错误时，callTool 照发 tools/call，
 * 返回 `{ ok: true, text: '', isError: false }` ——
 * **绿着成功、输出为空、什么都没做**。
 *
 * 而握手那份注释自己就写着：不发 notifications/initialized 时，
 * server 的拒绝「往往只有一句 no session，很难定位」。
 * callTool 连握手失败都看不见，就更定位不了。
 *
 * 注：callTool 目前没有调用点（协议通道还没接上），所以这是**潜伏**的 ——
 * 接上那天就会发作。listTools 那份本来是对的，
 * 两份写法不同 = 迟早按错的那个补齐。
 */
test('callTool：握手被拒时明确失败，不许绿着成功返回空', async () => {
  await assert.rejects(
    callTool(REF, 't', {}, SEQ(INIT_ERR, '{"result":{}}', CALL_OK), 5),
    (e: Error) => {
      assert.ok(/握手失败/.test(e.message), `要说握手失败，实际：${e.message}`);
      assert.ok(/不支持的协议版本/.test(e.message), '要带上 server 给的原因');
      return true;
    },
  );
});

test('callTool：握手 HTTP 500 时说连不上，不许继续调', async () => {
  await assert.rejects(
    callTool(REF, 't', {}, async () => ({ status: 500, text: 'boom' }), 5),
    (e: Error) => {
      assert.ok(/连不上/.test(e.message), `要说连不上，实际：${e.message}`);
      assert.ok(/500/.test(e.message), '要带上状态码');
      return true;
    },
  );
});

test('callTool：握手返回 HTML（地址填错）时说读不懂，不许说连不上', async () => {
  await assert.rejects(
    callTool(REF, 't', {}, async () => ({ status: 200, text: '<html>登录页</html>' }), 5),
    (e: Error) => {
      assert.ok(/读不懂/.test(e.message), `要说读不懂，实际：${e.message}`);
      assert.ok(!/连不上/.test(e.message), '连上了就不能说连不上');
      return true;
    },
  );
});

test('callTool：握手正常时照常返回（不能被修坏）', async () => {
  const r = await callTool(REF, 't', {}, SEQ(OK_INIT, '{"result":{}}', CALL_OK), 5);
  assert.equal(r.ok, true);
  assert.equal(r.text, '真实结果');
});

/* ================================================================== */
/* 两步都要发 —— 少发 notifications/initialized 会被拒绝                */
/* ================================================================== */

test('listTools：两步都要发，且顺序对', async () => {
  const seen: string[] = [];
  const post: HttpPost = async (_u, body) => {
    const m = String((body as { method?: unknown }).method ?? '');
    seen.push(m);
    return { status: 200, text: m === 'tools/list' ? TOOLS_OK : OK_INIT };
  };
  await listTools(REF, post, 5);
  assert.deepEqual(seen, ['initialize', 'notifications/initialized', 'tools/list']);
});

test('callTool：两步都要发，且顺序对', async () => {
  const seen: string[] = [];
  const post: HttpPost = async (_u, body) => {
    const m = String((body as { method?: unknown }).method ?? '');
    seen.push(m);
    return { status: 200, text: m === 'tools/call' ? CALL_OK : OK_INIT };
  };
  await callTool(REF, 't', {}, post, 5);
  assert.deepEqual(seen, ['initialize', 'notifications/initialized', 'tools/call']);
});

/* ================================================================== */
/* 源码守卫                                                            */
/* ================================================================== */

/*
 * 以前握手有**三份**：initialize()（只发一步）、listTools 内联、
 * callTool 内联。收成 handshake 一处之后，
 * 最要防的是"将来有人图省事再内联一份"。
 */
test('源码守卫：notifications/initialized 全仓只允许一份', () => {
  const src = readSrc('engine/mcpClient.ts');
  const n = (src.match(/notifications\/initialized/g) ?? []).length;
  assert.equal(n, 1,
    `握手只允许一份实现，实际出现 ${n} 次 —— 多一份就必然漂移`);
});

test('源码守卫：initialize 请求也只允许一份（不许再内联握手）', () => {
  const src = readSrc('engine/mcpClient.ts');
  const n = (src.match(/method: 'initialize'/g) ?? []).length;
  assert.equal(n, 1, `initialize 只允许发一处，实际 ${n} 处`);
});

test('源码守卫：listTools / callTool 都要调 handshake（不是各写一份）', () => {
  const src = readSrc('engine/mcpClient.ts');
  for (const fn of ['export async function listTools', 'export async function callTool']) {
    const i = src.indexOf(fn);
    assert.ok(i >= 0, `找不到 ${fn}`);
    const body = src.slice(i, src.indexOf('\n}\n', i));
    assert.ok(/handshake\(/.test(body), `${fn} 必须调 handshake，不许内联一份`);
  }
});

/*
 * 死代码：`initialize()` 与 `McpSession` 此前 export 着、零调用点，
 * 而 initialize **没发** notifications/initialized ——
 * 它自己的注释写着那一步"必须发，否则部分 server 拒绝后续调用"。
 * 于是谁按它的返回值去调后续方法，谁就拿到一句 "no session"。
 * 已删除；留守卫防它回来。
 */
test('源码守卫：不许再有 McpSession / export initialize（它是半截握手）', () => {
  const src = readSrc('engine/mcpClient.ts');
  assert.ok(!/export type McpSession/.test(src), 'McpSession 已删 —— 它承诺的 sessionId 永远拿不到');
  assert.ok(!/export async function initialize/.test(src),
    'initialize 已删 —— 它只发 initialize 不发通知，是半截握手');
});
