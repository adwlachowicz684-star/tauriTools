import test from 'node:test';
import assert from 'node:assert/strict';
import {
  refreshAll, withServerTimeout, SERVER_TIMEOUT_MS, type RefreshOptions,
} from '../engine/mcpStore';
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
