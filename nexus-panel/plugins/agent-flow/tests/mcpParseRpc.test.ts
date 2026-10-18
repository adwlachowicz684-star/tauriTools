import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRpcBody, listTools, callTool, type HttpPost } from '../engine/mcpClient';
import { readSrc } from './srcScan';

const OK = (text: string): HttpPost => async () => ({ status: 200, text });
const OK_INIT = '{"jsonrpc":"2.0","result":{"protocolVersion":"2025-06-18"}}';
const TOOLS = '{"jsonrpc":"2.0","result":{"tools":[{"name":"t","description":"d","inputSchema":{}}]}}';
/** 第一次（initialize）给正常响应，之后给 body */
const SEQ = (...bodies: string[]): HttpPost => {
  let n = 0;
  return async () => ({ status: 200, text: bodies[Math.min(n++, bodies.length - 1)] });
};

/* ================================================================== */
/* 批处理数组：不能被当成单条响应                                      */
/* ================================================================== */

/*
 * JSON-RPC 的批处理响应是数组。这一层从来只发单条请求，
 * 所以收到数组就意味着"格式不认识"。
 *
 * 以前 `JSON.parse(src) as RpcResponse` 直接返回了数组（as 不做检查）：
 *   · listTools → result 是 undefined → 抛「返回了 0 个工具」（说错了原因）
 *   · callTool  → 不查 result → blocks=[] → text=''
 *                 → { ok: true, text: '' }  **绿着成功、输出为空**
 */
test('数组（批处理）不算一条响应', () => {
  assert.equal(parseRpcBody('[{"jsonrpc":"2.0","result":1}]'), null);
  assert.equal(parseRpcBody('[]'), null);
  assert.equal(parseRpcBody('data: [{"result":1}]'), null, 'SSE 里裹着数组同样不算');
});

test('正常对象、SSE 都不受影响', () => {
  assert.deepEqual(parseRpcBody('{"jsonrpc":"2.0","result":1}')?.result, 1);
  assert.deepEqual(parseRpcBody('data: {"jsonrpc":"2.0","result":1}')?.result, 1);
  assert.deepEqual(parseRpcBody('data:{"jsonrpc":"2.0","result":1}')?.result, 1, '无空格也要认');
  assert.equal(parseRpcBody(''), null);
  assert.equal(parseRpcBody('<html>登录页</html>'), null);
});

test('callTool 遇到数组：报错，而不是绿着成功返回空', async () => {
  await assert.rejects(
    callTool({ name: 's', url: 'http://s' }, 't', {},
      OK('[{"jsonrpc":"2.0","result":{"content":[{"text":"真实结果"}]}}]'), 5),
    (e: Error) => {
      assert.ok(/读不懂/.test(e.message), `要说读不懂，实际：${e.message}`);
      return true;
    },
  );
});

test('callTool 拿到真结果时照常返回（不能被修坏）', async () => {
  const r = await callTool({ name: 's', url: 'http://s' }, 't', {},
    OK('{"jsonrpc":"2.0","result":{"content":[{"type":"text","text":"真实结果"}]}}'), 5);
  assert.equal(r.ok, true);
  assert.equal(r.text, '真实结果');
});

test('listTools 遇到数组：说"读不懂"，不是"返回了 0 个工具"', async () => {
  await assert.rejects(
    listTools({ name: 's', url: 'http://s' }, SEQ(OK_INIT, '[{"jsonrpc":"2.0","result":{}}]'), 5),
    (e: Error) => {
      assert.ok(/读不懂/.test(e.message), `要说读不懂，实际：${e.message}`);
      assert.ok(!/0 个工具/.test(e.message), '不该说成"0 个工具" —— 那会把人支去查 server');
      return true;
    },
  );
});

test('listTools 正常路径不受影响', async () => {
  const t = await listTools({ name: 's', url: 'http://s' }, SEQ(OK_INIT, TOOLS), 5);
  assert.equal(t.length, 1);
  assert.equal(t[0].name, 't');
});

/* ================================================================== */
/* 「连不上：HTTP 200」这种自相矛盾的话                                */
/* ================================================================== */

/*
 * 已存在的一个洞（不是本轮引入，但本轮扩大了它的触发面）：
 *
 * 以前合成一句 `连不上：${body?.error?.message ?? 'HTTP ' + status}`，
 * 状态码 200 而响应读不懂时，`body` 为 null → 退化成
 * 「**连不上**：HTTP **200**」—— 自相矛盾。
 *
 * 实测：地址填成一个网页就会拿到这一句。用户看到 200 却说连不上，
 * 只会以为程序坏了；而真相恰恰相反 —— 连上了，只是对方返回的不是
 * MCP 响应（多半是地址填错了）。
 *
 * 注：`initialize()` 那一份本来就是分开写的（对的），
 * listTools 里内联的这份是第二套实现 —— 于是两套口径不一致。
 */
test('listTools：200 但读不懂时，不许说"连不上"', async () => {
  await assert.rejects(
    listTools({ name: 's', url: 'http://s' }, OK('<html>登录页</html>'), 5),
    (e: Error) => {
      assert.ok(!/连不上/.test(e.message), `连上了就不能说连不上：${e.message}`);
      assert.ok(!/HTTP 200/.test(e.message), `不该拿 200 当错误：${e.message}`);
      assert.ok(/读不懂/.test(e.message), `要说读不懂：${e.message}`);
      return true;
    },
  );
});

test('listTools：真的 4xx 时要说 HTTP 错误（不能一概说读不懂）', async () => {
  await assert.rejects(
    listTools({ name: 's', url: 'http://s' }, async () => ({ status: 404, text: 'not found' }), 5),
    (e: Error) => {
      assert.ok(/连不上/.test(e.message), `4xx 要说连不上：${e.message}`);
      assert.ok(/404/.test(e.message), `要带上状态码：${e.message}`);
      return true;
    },
  );
});

/* ================================================================== */
/* 源码守卫                                                            */
/* ================================================================== */

/*
 * 收窄在**独立的** isRpcObject 里，不在 parseRpcBody 体内 ——
 *
 * 第一版我截取 parseRpcBody 函数体去找 Array.isArray，**报红了**，
 * 但报的是我的锚点错了（收窄不在这个函数里）。照着那条红去改，
 * 就会去动 parseRpcBody 而不是真正的判据。
 *
 * 所以这里查两处：判据本身，以及 parseRpcBody 确实用了它 ——
 * 只查一处的话，"判据写好了但没人用"照样通过。
 */
test('源码守卫：类型收窄要排除数组（不能靠 as 断言）', () => {
  const src = readSrc('engine/mcpClient.ts');
  const i = src.indexOf('function isRpcObject');
  assert.ok(i >= 0, '要有一个收窄函数 —— JSON.parse 返回 any，as 断言不做检查');
  const decl = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/Array\.isArray/.test(decl), '必须排除数组（批处理响应）');
  assert.ok(/typeof .*=== 'object'/.test(decl), '必须确认是对象');
});

test('源码守卫：parseRpcBody 两条路径都要走收窄（JSON 与 SSE）', () => {
  const src = readSrc('engine/mcpClient.ts');
  const i = src.indexOf('export function parseRpcBody');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('\n}\n', i));
  const uses = (body.match(/isRpcObject\(/g) ?? []).length;
  assert.ok(uses >= 2, `JSON 与 SSE 两条路径都要收窄，实际只用了 ${uses} 次`);
});

test('源码守卫：listTools 不许把"HTTP 错误"和"读不懂"合成一句', () => {
  const src = readSrc('engine/mcpClient.ts');
  const i = src.indexOf('export async function listTools');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(!/status >= 400 \|\| !\w+Body/.test(body),
    '合成一句就会说出「连不上：HTTP 200」这种自相矛盾的话');
  // 两类都要有
  assert.ok(/status >= 400/.test(body), '要有 HTTP 错误这条');
  assert.ok(/!initBody/.test(body) && /!listBody/.test(body), '两步各自都要查"读不懂"');
});
