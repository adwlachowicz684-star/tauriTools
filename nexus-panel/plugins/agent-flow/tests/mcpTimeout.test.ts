import test from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshAll, withServerTimeout, SERVER_TIMEOUT_MS, type RefreshOptions,
} from '../engine/mcpStore';
import {
  MCP_SINGLE_TIMEOUT_SEC, MCP_CALL_TIMEOUT_SEC, MCP_HANDSHAKE_CALLS, MCP_TIMEOUT_MARGIN_SEC,
} from '../engine/mcpTools';
import { listTools } from '../engine/mcpClient';
import { readSrc } from './srcScan';

const REF = (name: string) => ({ name, url: `http://${name}` });
const TOOL = (name: string) => ({ name: `tool_${name}`, description: 'd', inputSchema: {} });

/** 永不 settle —— 模拟"服务端连上了但迟迟不返回" */
const hang = (): Promise<never> => new Promise(() => {});

/* ================================================================== */
/* 行为：一个卡住，不能拖死整批                                        */
/* ================================================================== */

/*
 * 本轮要修的那件事。
 *
 * refreshAll 是串行的（for + await）。一个服务不返回，
 * 后面所有服务的工具都拿不到 —— 而"刷新中"还挂着，界面就是一直转圈，
 * 没有任何"卡住了"的提示。
 */
test('一个服务卡住：其它服务的工具照常拿到', async () => {
  const r = await refreshAll({
    servers: [REF('good'), REF('stuck')],
    previous: [],
    serverTimeoutMs: 300,
    fetcher: async (s) => (s.name === 'good' ? [TOOL('good')] : hang()),
  });
  assert.equal(r.ok, true, '有服务成功了，整批就不该算失败');
  assert.ok(r.list.some((b) => b.type === 'mcp:good:tool_good'), 'good 的工具要拿到');
});

test('一个服务卡住：整体在有限时间内返回（不永久挂起）', async () => {
  const t0 = Date.now();
  await refreshAll({
    servers: [REF('stuck')],
    previous: [],
    serverTimeoutMs: 300,
    fetcher: () => hang(),
  });
  assert.ok(Date.now() - t0 < 5000, '必须返回 —— 不返回界面就一直转圈');
});

test('卡住的那个记为失败，并说清是"不返回"而不是"连不上"', async () => {
  const r = await refreshAll({
    servers: [REF('stuck')],
    previous: [],
    serverTimeoutMs: 300,
    fetcher: () => hang(),
  });
  const f = r.failures.find((x) => x.server === 'stuck');
  assert.ok(f, '要有一条失败记录');
  assert.ok(f.reason.includes('不返回'), `要说清是不返回：${f.reason}`);
  assert.ok(f.reason.includes('跳过'), `要说清没拖累别的：${f.reason}`);
});

test('卡住的在前、好的在后 —— 好的照样拿到（顺序无关）', async () => {
  const r = await refreshAll({
    servers: [REF('stuck'), REF('good')],
    previous: [],
    serverTimeoutMs: 300,
    fetcher: async (s) => (s.name === 'good' ? [TOOL('good')] : hang()),
  });
  assert.ok(r.list.some((b) => b.type === 'mcp:good:tool_good'));
});

test('全部卡住：整批失败，但保留旧快照（不能让工具消失）', async () => {
  const previous = [{ type: 'mcp:stuck:old', server: 'stuck', name: 'old' } as never];
  const r = await refreshAll({
    servers: [REF('stuck')], previous, serverTimeoutMs: 300, fetcher: () => hang(),
  });
  assert.equal(r.ok, false);
  assert.ok(r.list.length > 0, '连不上的要保留旧快照 —— 否则一次抖动工具全没了');
});

/* ================================================================== */
/* 超时不能误伤正常服务                                                */
/* ================================================================== */

test('正常服务不受影响（慢一点也照样成功）', async () => {
  const r = await refreshAll({
    servers: [REF('a')], previous: [], serverTimeoutMs: 300,
    fetcher: async () => { await new Promise((res) => setTimeout(res, 50)); return [TOOL('a')]; },
  });
  assert.equal(r.ok, true);
  assert.equal(r.failures.length, 0);
});

/*
 * 本轮要修的那件事 —— 而且是我上一轮自己引入的。
 *
 * 我上一轮把 SERVER_TIMEOUT_MS 写成 60_000，理由是"单次 20 秒 × 3 次
 * = 最坏 60 秒"。**正好相等，零余量**。
 *
 * 实测：单次 1 秒 × 3 次，整体设 3 秒 —— 一个每次都按时返回的
 * 完全正常的服务，被判成"连上了但迟迟不返回"。
 *
 * 这类失效最气人：它只在服务慢到接近上限时才发作，
 * 而发作的提示是"这个服务有问题"，把人支去查一个没坏的服务。
 */
test('整体上限必须严格大于"单次 × 握手次数" —— 相等就会误伤正常服务', () => {
  const worst = MCP_SINGLE_TIMEOUT_SEC * MCP_HANDSHAKE_CALLS * 1000;
  assert.ok(SERVER_TIMEOUT_MS > worst,
    `整体 ${SERVER_TIMEOUT_MS} 必须大于最坏正常值 ${worst} —— 相等都不行`);
  assert.ok(SERVER_TIMEOUT_MS - worst >= 10_000,
    `余量 ${SERVER_TIMEOUT_MS - worst}ms 太小 —— 三次请求之间还有解析与调度开销`);
});

/*
 * 这个慢服务每次都**按时返回**（各 60ms），是完好的。
 *
 * 注意：工具清单不能是空的 —— 空清单自己就是一条 failure
 * （"返回了 0 个工具"），会让"有没有被超时误伤"这条断言
 * 通过一个**错误的理由**。第一版我就这么错了。
 */
const slowOkPost = async (): Promise<{ status: number; text: string }> => {
  await new Promise((r) => setTimeout(r, 60));
  return {
    status: 200,
    text: JSON.stringify({
      jsonrpc: '2.0', id: 1,
      result: { protocolVersion: '2025-06-18', tools: [{ name: 't', description: 'd', inputSchema: {} }] },
    }),
  };
};

test('实测：整体正好等于"单次 × 次数"时，正常服务被误判超时', async () => {
  const r = await refreshAll({
    servers: [REF('slow')], previous: [],
    serverTimeoutMs: 60 * MCP_HANDSHAKE_CALLS, // 正好等于最坏正常耗时
    fetcher: (s) => listTools({ name: s.name, url: s.url }, slowOkPost, 60),
  });
  const f = r.failures[0];
  assert.ok(f, '零余量时应该失败');
  assert.ok(f.reason.includes('不返回'), `必须是超时那条，实际：${f.reason}`);
});

test('实测：留了余量后，同一个慢服务正常通过', async () => {
  const r = await refreshAll({
    servers: [REF('slow')], previous: [],
    serverTimeoutMs: 60 * MCP_HANDSHAKE_CALLS + 1500,
    fetcher: (s) => listTools({ name: s.name, url: s.url }, slowOkPost, 60),
  });
  assert.deepEqual(r.failures.map((x) => x.reason), [], '留余量后不该再误伤');
  assert.equal(r.ok, true);
});

test('默认上限是有限值，且比单次请求的大', () => {
  assert.ok(Number.isFinite(SERVER_TIMEOUT_MS), '必须是有限值 —— Infinity 等于没有上限');
  assert.ok(SERVER_TIMEOUT_MS > 20_000,
    '一次 listTools 发三次请求、每次 20 秒；整体上限比单次小的话会误伤正常服务');
});

test('withServerTimeout：超时后晚到的结果不会冒出未处理拒绝', async () => {
  // 一个 100ms 后才 reject 的 promise，外层 20ms 就超时
  await assert.rejects(
    withServerTimeout(
      new Promise((_, rej) => setTimeout(() => rej(new Error('晚到的')), 100)), 20, 'x'),
    /迟迟不返回/,
  );
  // 等它真的 reject —— 不崩就说明挂了 handler
  await new Promise((res) => setTimeout(res, 150));
});

/* ================================================================== */
/* 源码守卫                                                            */
/* ================================================================== */

test('源码守卫：fetcher 外面必须包超时（不包的话串行会拖死整批）', () => {
  const src = readSrc('engine/mcpStore.ts');
  const i = src.indexOf('export async function refreshAll');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/withServerTimeout\(/.test(body),
    '串行 for + await，一个不返回就全部拿不到 —— 必须每个服务独立限时');
  // 不能只 import 不调用（那种"看着有了"的写法本系列已出过多次）
  assert.ok(!/await opts\.fetcher\(s\)/.test(body), '裸调 fetcher 说明超时没接上');
});

test('源码守卫：超时后要吞掉原 promise 晚到的结果', () => {
  const src = readSrc('engine/mcpStore.ts');
  const i = src.indexOf('export async function withServerTimeout');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/\.catch\(\(\) => undefined\)/.test(body),
    '不吞会冒出未处理的 Promise 拒绝 —— 控制台里一条跟本次操作对不上的红字');
});

test('源码守卫：别处不要用裸 fetcher（同一个坑不能有两份）', () => {
  const src = readSrc('engine/mcpStore.ts');
  const i = src.indexOf('export async function refreshAll');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  const calls = body.match(/opts\.fetcher\(/g) ?? [];
  assert.equal(calls.length, 1, `fetcher 只该调一次（实际 ${calls.length} 次）`);
});

const _o: RefreshOptions = { servers: [], previous: [] };

/*
 * 三个常量散在三处的字面量 —— 改一处漏一处就是两种失效：
 *   · 只改小单次 → 整体相对变宽，卡住的服务要多等很久
 *   · 只改大单次 → 整体相对变窄，正常服务被误伤
 * 所以整体必须**由公式算出来**，不许写死。
 */
test('源码守卫：整体上限必须是公式，不许写死数字', () => {
  const src = readSrc('engine/mcpStore.ts');
  const i = src.indexOf('export const SERVER_TIMEOUT_MS');
  assert.ok(i >= 0);
  const decl = src.slice(i, src.indexOf(';', i));
  assert.ok(/MCP_SINGLE_TIMEOUT_SEC/.test(decl) && /MCP_HANDSHAKE_CALLS/.test(decl),
    `必须由单次上限推导出来，实际：${decl.replace(/\s+/g, ' ')}`);
  /*
   * 只看"除了 ×1000 这个秒→毫秒转换系数之外还有没有裸数字"。
   * 第一版我写成 !/\b\d{4,}\b/ —— 它把 1000 也算进去了，
   * 于是公式写法也被判违规。报红了，但报的是我的正则太宽。
   */
  const nums = (decl.match(/\b\d+\b/g) ?? []).filter((x) => x !== '1000');
  assert.deepEqual(nums, [], `不许出现写死的毫秒数字：${decl.replace(/\s+/g, ' ')}`);
});

test('源码守卫：协议层与 hook 不许再写死超时字面量', () => {
  const cl = readSrc('engine/mcpClient.ts');
  assert.ok(!/timeoutSec = \d/.test(cl),
    'listTools / callTool 的默认参数要用共享常量 —— 写死了改一处漏一处');
  /*
   * callTool 调工具本来就比拉清单慢，所以它该有**自己**的常量，
   * 而不是共用 MCP_SINGLE_TIMEOUT_SEC ——
   * 共用的话，将来按"单次 × 次数"给调用算整体上限就会算错。
   */
  const ci = cl.indexOf('export async function callTool');
  assert.ok(/MCP_CALL_TIMEOUT_SEC/.test(cl.slice(ci, ci + 900)),
    'callTool 要用它自己的常量');
  const hk = readSrc('hooks/useMcpRegistry.ts');
  const i = hk.indexOf('listTools(');
  const call = hk.slice(i, i + 400);
  assert.ok(/MCP_SINGLE_TIMEOUT_SEC/.test(call), 'hook 里同样要用共享常量');
});

test('源码守卫：握手次数与协议实现一致（说三次就别发四次）', () => {
  const src = readSrc('engine/mcpClient.ts');
  const i = src.indexOf('export async function listTools');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  const calls = (body.match(/await httpPost\(/g) ?? []).length;
  assert.equal(calls, MCP_HANDSHAKE_CALLS,
    `声明 ${MCP_HANDSHAKE_CALLS} 次，实际发了 ${calls} 次 —— 余量就白算了`);
});
