import test from 'node:test';
import assert from 'node:assert/strict';
import { bootRefresh, loadBlueprints, type ServerRef } from '../engine/mcpStore';
import { buildBlueprints, type McpToolSchema, type NodeBlueprint } from '../engine/mcpTools';
import type { KV } from '../engine/kv';
import { readSrc } from './srcScan';

const schema = (name: string): McpToolSchema =>
  ({ name, description: '', inputSchema: { type: 'object' } });
const ref = (name: string): ServerRef => ({ name, url: `http://${name}` });
const memKV = (): KV & { box: Record<string, string> } => {
  const box: Record<string, string> = {};
  return { box, get: (k) => box[k] ?? null, set: (k, v) => { box[k] = v; } };
};

/* ================================================================== */
/* 行为：第二次刷新要拿"上一次的结果"当 previous                        */
/* ================================================================== */

/*
 * 本轮要修的那件事。
 *
 * 刷新要传 previous（上一次的蓝图）：
 *   · 连不上的服务靠它保留旧蓝图
 *   · 工具被服务端删掉时靠它**标 stale** 而不是删除
 *
 * 而 hook 传的一直是 mcpBlueprints —— useState 的初值，没有 setter，
 * **恒为启动快照**。于是第一次刷新之后，previous 就再也不对了：
 */
test('第二次刷新：服务删掉的工具要标 stale 保留，不能整条消失', async () => {
  const kv = memKV();
  // 启动快照：空
  let current: NodeBlueprint[] = [];

  // 第一次刷新：拿到 A、B
  const r1 = await bootRefresh([ref('fs')], current,
    async () => [schema('A'), schema('B')], { kv });
  assert.equal(r1.outcome.ok, true);
  current = r1.outcome.list;
  assert.deepEqual(loadBlueprints(kv).map((b) => b.tool).sort(), ['A', 'B']);

  // 第二次刷新（用户改了服务地址）：服务现在只提供 A
  const r2 = await bootRefresh([ref('fs')], current,
    async () => [schema('A')], { kv });
  const stored = loadBlueprints(kv);
  assert.deepEqual(stored.map((b) => b.tool).sort(), ['A', 'B'],
    'B 要还在存盘里 —— 画布上可能有用着它的节点，删了会让它变成未知类型');
  assert.ok(stored.find((b) => b.tool === 'B')?.stale,
    'B 要被标 stale（不在侧栏出现，但老节点照常显示）');
});

/*
 * 反例：previous 用启动快照会怎样 —— 把"为什么必须传当前那份"钉住。
 * 这条测的是 refreshAll 的契约，不是修好的实现；
 * 万一将来有人把它改回"恒用启动快照"，上一条会红。
 */
test('反例：previous 恒为启动快照 → 第一次学到的工具在第二次刷新时消失', async () => {
  const bootSnapshot: NodeBlueprint[] = [];
  const kv = memKV();
  await bootRefresh([ref('fs')], bootSnapshot,
    async () => [schema('A'), schema('B')], { kv });
  assert.deepEqual(loadBlueprints(kv).map((b) => b.tool).sort(), ['A', 'B']);

  // 第二次刷新仍传启动快照（错误做法）
  await bootRefresh([ref('fs')], bootSnapshot, async () => [schema('A')], { kv });
  assert.deepEqual(loadBlueprints(kv).map((b) => b.tool), ['A'],
    '这正是要防的：B 整条没了，而不是被标 stale');
});

test('diff 口径：第二次刷新不该把已有工具再报成新增', async () => {
  let current: NodeBlueprint[] = [];
  const r1 = await bootRefresh([ref('fs')], current, async () => [schema('A')]);
  current = r1.outcome.list;
  const r2 = await bootRefresh([ref('fs')], current, async () => [schema('A')]);
  const added = r2.outcome.diffs.filter((d) => d.kind === 'added').length;
  assert.equal(added, 0, '工具没变就不该报"新增" —— 否则日志每次都说新增一次');
});

/* ================================================================== */
/* 源码守卫：hook 必须传"当前"那份，并在刷新后更新它                    */
/* ================================================================== */

test('源码守卫：刷新传的 previous 不能是启动快照 mcpBlueprints', () => {
  const src = readSrc('hooks/useMcpRegistry.ts');
  const i = src.indexOf('await bootRefresh(');
  assert.ok(i >= 0);
  const call = src.slice(i, src.indexOf(';', i));
  assert.ok(!/\bmcpBlueprints\b/.test(call),
    'mcpBlueprints 是 useState 初值、没有 setter，恒为启动快照 —— 第二次刷新就错了');
});

test('源码守卫：刷新成功后要把结果记进 ref（下次当 previous）', () => {
  const src = readSrc('hooks/useMcpRegistry.ts');
  const i = src.indexOf('if (r.outcome.ok)');
  assert.ok(i >= 0);
  const block = src.slice(i, src.indexOf('\n      }', i));
  assert.ok(/mcpCurrentRef\.current\s*=/.test(block),
    '不更新 ref 的话，下一次刷新拿到的还是启动快照');
});

test('源码守卫：mcpCurrentRef 初值来自启动快照（第一次刷新要有东西可比）', () => {
  const src = readSrc('hooks/useMcpRegistry.ts');
  assert.ok(/useRef<NodeBlueprint\[\]>\(mcpBlueprints\)/.test(src));
});

test('源码守卫：buildBlueprints 仍在（工具清单 → 蓝图）', () => {
  assert.equal(typeof buildBlueprints, 'function');
});
