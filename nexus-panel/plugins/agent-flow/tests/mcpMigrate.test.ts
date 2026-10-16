import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateFromCanvases, loadServers, type GlobalMcpServer } from '../engine/mcpServers';
import type { KV } from '../engine/kv';
import { readSrc } from './srcScan';

const memKV = (): KV & { box: Record<string, string> } => {
  const box: Record<string, string> = {};
  return { box, get: (k) => box[k] ?? null, set: (k, v) => { box[k] = v; } };
};

const canvasWith = (servers: unknown[]): unknown[] =>
  [{ config: { mcpServers: servers } }];

/* ================================================================== */
/* 行为                                                                */
/* ================================================================== */

test('迁移：画布上的服务并进全局库', () => {
  const kv = memKV();
  const { added, list } = migrateFromCanvases(
    canvasWith([{ id: 'a', name: 'fs', url: 'http://x' }]), kv);
  assert.equal(added, 1);
  assert.equal(list.length, 1);
  assert.equal(loadServers(kv)[0].name, 'fs');
});

test('迁移是幂等的：调两次不会重复', () => {
  const kv = memKV();
  const cs = canvasWith([{ id: 'a', name: 'fs', url: 'http://x' }]);
  migrateFromCanvases(cs, kv);
  const { added } = migrateFromCanvases(cs, kv);
  assert.equal(added, 0, '第二次不该再写');
  assert.equal(loadServers(kv).length, 1);
});

/*
 * 本轮要修的那件事。
 *
 * 迁移只搬 command / url / env / note，**漏了 disabled**。
 * 而 disabled 的含义是"不参与生成节点、不被引用，但配置留着"——
 * 用户专门关掉的服务，迁移之后变成启用的。
 *
 * 后果：一个被禁用（可能连不上、可能正在维护）的服务会被拿去连接，
 * 刷新因此失败并按"连不上"记一条。用户看到的是一条凭空冒出来的
 * 连接失败，而他在全局库里根本没启用过它。
 */
test('迁移要带上 disabled —— 关掉的服务不能变成启用', () => {
  const kv = memKV();
  migrateFromCanvases(
    canvasWith([{ id: 'a', name: 'fs', url: 'http://x', disabled: true }]), kv);
  const s = loadServers(kv)[0];
  assert.equal(s.disabled, true,
    '画布上关掉的服务，迁到全局库后不该变成启用 —— 否则会被拿去连接');
});

test('迁移不覆盖：同名服务保留全局库里现有的（用户新配的优先）', () => {
  const kv = memKV();
  kv.set('agent-flow.mcpServers.v1', JSON.stringify({
    version: 1, servers: [{ id: 'g', name: 'fs', url: 'http://global' }],
  }));
  const { added } = migrateFromCanvases(
    canvasWith([{ id: 'a', name: 'fs', url: 'http://old' }]), kv);
  assert.equal(added, 0);
  assert.equal(loadServers(kv)[0].url, 'http://global', '不该被老画布的覆盖');
});

test('迁移后节点引用要能解析（服务在全局库里可见）', () => {
  const kv = memKV();
  migrateFromCanvases(
    canvasWith([{ id: 'a', name: 'fs', url: 'http://x', disabled: true }]), kv);
  const list = loadServers(kv);
  assert.equal(list.length, 1, 'disabled 要保留配置本身，不是不迁');
  assert.equal(list[0].name, 'fs');
});

test('空名字的服务不迁（没有身份的服务没法引用）', () => {
  const kv = memKV();
  const { added } = migrateFromCanvases(canvasWith([{ id: 'a', name: '  ', url: 'u' }]), kv);
  assert.equal(added, 0);
});

test('没有 config / 没有 mcpServers 的画布不炸', () => {
  const kv = memKV();
  assert.equal(migrateFromCanvases([{}, null, { config: {} }] as unknown[], kv).added, 0);
});

/* ================================================================== */
/* 源码守卫                                                            */
/* ================================================================== */

test('源码守卫：迁移要逐字段搬，disabled 不能漏', () => {
  const src = readSrc('engine/mcpServers.ts');
  const i = src.indexOf('export function migrateFromCanvases');
  assert.ok(i >= 0);
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/disabled:\s*s\?\.disabled/.test(body),
    '用展开 {...s} 会漏字段；逐个搬要连 disabled 一起 —— 关掉的服务不该被启用');
});

test('源码守卫：迁移后要写盘（added>0 才写，幂等靠这个）', () => {
  const src = readSrc('engine/mcpServers.ts');
  const i = src.indexOf('export function migrateFromCanvases');
  const body = src.slice(i, src.indexOf('\n}\n', i));
  assert.ok(/if\s*\(added === 0\)\s*return/.test(body), '没有新增就不写 —— 否则每次加载都写一遍');
  assert.ok(/saveServers\(merged, kv\)/.test(body));
});

const _t: GlobalMcpServer = { id: 'x', name: 'y', disabled: true };
