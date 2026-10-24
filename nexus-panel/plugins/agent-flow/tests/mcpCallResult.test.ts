import test from 'node:test';
import assert from 'node:assert/strict';
import { callTool, type HttpPost } from '../engine/mcpClient';

/**
 * callTool 返回的 ok 必须如实回答"工具跑成了吗"
 * ------------------------------------------------------------------
 * MCP 的 result.isError 是官方的"工具调用失败了"标志 —— 请求本身成功、
 * 工具也真的跑了，只是跑出来是个错（范围超上限、文件不存在、权限不够）。
 *
 * 而 McpCallResult.ok 是**我们自己的字段**。调用方（将来接上协议通道的
 * 那一处）看到 ok 的第一反应就是"成功了吗"，照它分支就把报错文本当结果
 * 往下传。所以 ok 必须恒等于 !isError —— 两个字段是同一件事的两面，
 * 不允许各说各的。
 *
 * 以前 ok 是硬编码的 true，实测（改之前）：
 *
 *   正常返回        ok=true  isError=false text="写好了"
 *   工具报错        ok=true  isError=true  text="范围超出上限"   ← 自相矛盾
 */

import { readSrc } from './srcScan';

function mockPost(handler: (b: Record<string, unknown>) => { status: number; text: string }) {
  const fn: HttpPost = async (_url: string, body: Record<string, unknown>) => handler(body);
  return fn;
}

const okInit = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { serverInfo: { name: 'x' } } });

async function call(result: unknown) {
  const fn = mockPost((b) => {
    if (b.method === 'tools/call') {
      return { status: 200, text: JSON.stringify({ jsonrpc: '2.0', id: 3, result }) };
    }
    return { status: 200, text: okInit };
  });
  return callTool({ name: 'x', url: 'http://x' }, 't', {}, fn);
}

test('工具报错时 ok 必须是 false（不能两边都成立）', async () => {
  const r = await call({ isError: true, content: [{ type: 'text', text: '范围超出上限' }] });
  assert.equal(r.isError, true);
  assert.equal(r.ok, false);
  // 报错文本仍要保留 —— 它是给人和给下游看的**错误原因**
  assert.ok(r.text.includes('范围超出上限'));
});

test('正常返回：ok 与 isError 都成立各自的那一面', async () => {
  const r = await call({ isError: false, content: [{ type: 'text', text: '写好了' }] });
  assert.equal(r.isError, false);
  assert.equal(r.ok, true);
  assert.ok(r.text.includes('写好了'));
});

test('服务端不写 isError 时不算失败（无标志 ≠ 失败）', async () => {
  const r = await call({ content: [{ type: 'text', text: '写好了' }] });
  assert.equal(r.isError, false);
  assert.equal(r.ok, true);
});

/*
 * 反向测试：**不能**把"没有内容"也判成失败。
 *
 * 工具正常跑完但没输出（写操作成功了、删除成功了）是合法的，
 * text 为空就说失败，会让一批本来正常的工具平白报错。
 * 只盯"ok 不能恒 true"的话，把 `!text` 也算进去照样通过测试。
 */
test('空输出不算失败 —— 工具正常跑完可能就是没有内容', async () => {
  const r = await call({ isError: false, content: [] });
  assert.equal(r.isError, false);
  assert.equal(r.ok, true);
  assert.equal(r.text, '');
});

test('ok 恒等于 !isError（两种情形都验过，这里钉住两者同源）', async () => {
  for (const res of [
    { isError: true, content: [{ type: 'text', text: 'x' }] },
    { isError: false, content: [{ type: 'text', text: 'y' }] },
  ]) {
    const r = await call(res);
    assert.equal(r.ok, !r.isError);
  }
});

/**
 * 源码守卫：ok 必须由 isError 算出来，不许再写死。
 *
 * 只查"有没有 return { ok:" 挡不住 `{ ok: true, ... }` ——
 * 那是这次的 bug 本身。要查的是 ok 的值来自 isError。
 */
test('源码：callTool 的 ok 由 isError 派生，不是写死的 true', () => {
  const src = readSrc('engine/mcpClient.ts');
  const i = src.indexOf('export async function callTool(');
  assert.ok(i >= 0, 'callTool 应该在 mcpClient.ts 里');
  const body = src.slice(i, src.indexOf('\nexport function ', i));
  assert.ok(
    /return\s*\{\s*ok:\s*!isError/.test(body),
    'callTool 应该 return { ok: !isError, ... } —— 写死 ok: true 会让工具报错也显示成功',
  );
  assert.ok(
    !/ok:\s*true/.test(body),
    'callTool 里不该再出现写死的 ok: true',
  );
});
