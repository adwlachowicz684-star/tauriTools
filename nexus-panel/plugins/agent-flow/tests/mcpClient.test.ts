import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listTools, callTool, parseRpcBody, transportOf, stdioSupported,
  McpError, MCP_PROTOCOL_VERSION,
} from '../engine/mcpClient';

/**
 * 用假的 httpPost 测协议层 ——
 * 不真连网络，也就不存在"环境不同结果不同"的偶发失败。
 */
type Call = { url: string; body: Record<string, unknown> };

function mockPost(handler: (b: Record<string, unknown>) => { status: number; text: string }) {
  const calls: Call[] = [];
  const fn = async (url: string, body: Record<string, unknown>) => {
    calls.push({ url, body });
    return handler(body);
  };
  return { fn, calls };
}

const okInit = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'x' } } });
const okList = JSON.stringify({
  jsonrpc: '2.0', id: 2,
  result: {
    tools: [
      { name: 'write_formula', description: '写公式', inputSchema: { type: 'object' } },
      { name: 'read_range', description: '读范围', inputSchema: { type: 'object' } },
    ],
  },
});

/* ================= 传输选择 ================= */

test('填了 url 走 HTTP', () => {
  assert.equal(transportOf({ name: 'a', url: 'http://x' }), 'http');
});

test('只填 command 走 stdio（尚未实现）', () => {
  assert.equal(transportOf({ name: 'a', command: 'npx x' }), 'stdio');
  assert.equal(stdioSupported(), false);
});

/** 没填地址必须明确报错，不能当成 HTTP 去连（那样错误完全不对） */
test('没填 HTTP 地址时明确报错', async () => {
  const { fn } = mockPost(() => ({ status: 200, text: okInit }));
  await assert.rejects(
    () => listTools({ name: 'excel', command: 'npx x' }, fn),
    (e: Error) => e instanceof McpError,
  );
});

/* ================= 响应解析 ================= */

test('解析 JSON 响应', () => {
  const r = parseRpcBody('{"jsonrpc":"2.0","id":1,"result":{}}');
  assert.ok(r && r.result);
});

/** MCP 允许 SSE 格式 —— 只按 JSON 解析会得到看不懂的错误 */
test('解析 SSE 响应', () => {
  const sse = [
    'event: message',
    'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}',
    '',
  ].join('\n');
  const r = parseRpcBody(sse);
  assert.ok(r && r.result);
});

test('心跳等无法解析的行被忽略', () => {
  const sse = ': ping\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n';
  assert.ok(parseRpcBody(sse));
});

test('空响应返回 null', () => {
  assert.equal(parseRpcBody(''), null);
  assert.equal(parseRpcBody('   '), null);
});

/* ================= 拉工具清单 ================= */

test('握手 + 拉清单成功', async () => {
  const { fn, calls } = mockPost((b) =>
    b.method === 'tools/list' ? { status: 200, text: okList } : { status: 200, text: okInit });
  const tools = await listTools({ name: 'excel', url: 'http://x' }, fn);
  assert.equal(tools.length, 2);
  assert.equal(tools[0].name, 'write_formula');
  // 必须先握手，否则部分 server 会直接拒绝
  assert.equal(calls[0].body.method, 'initialize');
  assert.ok(calls.some((c) => c.body.method === 'notifications/initialized'));
});

test('握手带协议版本与客户端信息', async () => {
  const { fn, calls } = mockPost((b) =>
    b.method === 'tools/list' ? { status: 200, text: okList } : { status: 200, text: okInit });
  await listTools({ name: 'x', url: 'http://x' }, fn);
  const p = calls[0].body.params as Record<string, unknown>;
  assert.equal(p.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.ok(p.clientInfo);
});

/**
 * 空清单不静默通过 ——
 * 静默返回空会让所有 MCP 节点凭空消失，用户没有任何线索。
 */
test('返回 0 个工具时报错，不静默返回空', async () => {
  const { fn } = mockPost((b) =>
    b.method === 'tools/list'
      ? { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [] } }) }
      : { status: 200, text: okInit });
  await assert.rejects(() => listTools({ name: 'x', url: 'http://x' }, fn), /0 个工具/);
});

test('HTTP 失败时把状态码说清楚', async () => {
  const { fn } = mockPost(() => ({ status: 500, text: 'boom' }));
  await assert.rejects(() => listTools({ name: 'x', url: 'http://x' }, fn), /HTTP 500/);
});

test('server 返回业务错误时说出来', async () => {
  const { fn } = mockPost(() => ({
    status: 200,
    text: JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: '没权限' } }),
  }));
  await assert.rejects(() => listTools({ name: 'x', url: 'http://x' }, fn), /没权限/);
});

/* ================= 调用工具 ================= */

test('调用工具并拼出文本', async () => {
  const { fn } = mockPost((b) => {
    if (b.method === 'tools/call') {
      return {
        status: 200,
        text: JSON.stringify({
          jsonrpc: '2.0', id: 3,
          result: { content: [{ type: 'text', text: '写好了' }, { type: 'text', text: '共 10 格' }] },
        }),
      };
    }
    return { status: 200, text: okInit };
  });
  const r = await callTool({ name: 'x', url: 'http://x' }, 'write_formula', { a: 1 }, fn);
  assert.equal(r.ok, true);
  assert.ok(r.text.includes('写好了'));
  assert.ok(r.text.includes('共 10 格'));
});

test('工具自己报错时能识别出来', async () => {
  const { fn } = mockPost((b) => {
    if (b.method === 'tools/call') {
      return {
        status: 200,
        text: JSON.stringify({
          jsonrpc: '2.0', id: 3,
          result: { isError: true, content: [{ type: 'text', text: '范围超出上限' }] },
        }),
      };
    }
    return { status: 200, text: okInit };
  });
  const r = await callTool({ name: 'x', url: 'http://x' }, 'write_formula', {}, fn);
  assert.equal(r.isError, true);
  assert.ok(r.text.includes('范围超出上限'));
});
