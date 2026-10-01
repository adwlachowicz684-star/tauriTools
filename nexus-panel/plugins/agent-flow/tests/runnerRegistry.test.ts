import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getRunner } from '../engine/runnerRegistry';
import { runGraph, type RunEvent } from '../engine/runner';
import type { Graph } from '../types';
import { readSrc, AF_SRC } from './srcScan';

/* ================================================================ */
/* 每个「会执行」的节点种类，静态执行器表里都得有                       */
/* ================================================================ */

/*
 * 为什么单独写这个文件：
 *
 * 执行分发只认 `engine/runnerRegistry.ts` 里那张手写的 RUNNERS 表。
 * 没有执行器的种类会走到 runner.ts 的兜底分支 —— 那里是
 *
 *     outputs[id] = ''; setStatus(id, 'success'); emit({ ok: true })
 *
 * 也就是**绿着成功、输出为空、什么都没做**。不报错、日志干净、
 * 界面上一切正常，是最难查的一类失效。
 */

const node = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id,
  data: { kind, label: id, status: 'idle', output: '', error: '', ...extra },
});

const noopExecutor = async () => ({ output: '', ok: true });

async function run(nodes: unknown[], edges: unknown[] = []) {
  const events: RunEvent[] = [];
  const summary = await runGraph(
    { nodes, edges } as unknown as Graph,
    { concurrency: 1, executor: noopExecutor, input: '', onEvent: (e) => events.push(e) },
  );
  return { summary, events };
}

/* MCP：动态生成的那一族，最容易从手写表里漏掉 */
test('MCP 节点有执行器（不是静默直通）', () => {
  assert.ok(getRunner({ kind: 'mcp' }), 'mcp 没有执行器 —— 会绿着成功、什么都没做');
});

test('MCP 节点：明确失败并说明「通道还没接上」', async () => {
  const { summary, events } = await run([
    node('m', 'mcp', { mcpServer: 'notion', mcpTool: 'search' }),
  ]);
  assert.equal(summary.ok, false, '不该成功 —— 它什么都没调用');
  assert.ok(summary.failed.includes('m'), 'm 该记为失败');
  const e = events.find((x) => x.type === 'node-done' && x.id === 'm');
  assert.ok(e && !e.ok, 'node-done 该是 ok:false');
  assert.match(String((e as { error?: string }).error ?? ''), /还没接上/, `失败原因不对：${JSON.stringify(e)}`);
  assert.match(String((e as { error?: string }).error ?? ''), /search/, '原因里该带上工具名');
  assert.match(String((e as { error?: string }).error ?? ''), /notion/, '原因里该带上服务名');
});

/* 反向：不只是"报了错"，而是**真的没有直通成功** */
/*
 * 反向：旧行为是"绿着 success + 空输出 + 什么都没做"。
 * 只断言"执行器存在"会放过"执行器跑了但没失败"—— 那等于没接上。
 */
test('MCP 节点不再静默成功（旧行为是这个测试要防的）', async () => {
  const { events } = await run([node('m', 'mcp', { mcpServer: 's', mcpTool: 't' })]);
  const done = events.find((x) => x.type === 'node-done' && x.id === 'm');
  assert.ok(done, 'm 该有个 node-done 事件');
  assert.equal((done as { ok?: boolean }).ok, false, '不该 ok:true —— 那正是"看着跑通了其实没做"');
});

/* ================================================================ */
/* 两份清单对账：nodes/defs 的 run  ↔  RUNNERS                        */
/* ================================================================ */

const defsDir = join(AF_SRC, 'nodes/defs');

function defRuns(): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of readdirSync(defsDir)) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
    const s = readFileSync(join(defsDir, f), 'utf-8');
    const k = s.match(/dataKind:\s*'([^']+)'/);
    const r = s.match(/^\s*run:\s*(\w+),/m);
    if (k) out.set(k[1], r ? r[1] : '');
  }
  return out;
}

function runners(): Map<string, string> {
  const src = readSrc('engine/runnerRegistry.ts');
  const blk = src.slice(src.indexOf('const RUNNERS'), src.indexOf('\n};', src.indexOf('const RUNNERS')));
  const out = new Map<string, string>();
  for (const m of blk.matchAll(/^\s*'?([a-zA-Z0-9_-]+)'?:\s*(\w+),/gm)) out.set(m[1], m[2]);
  return out;
}

test('源码：def 声明了 run 的种类，RUNNERS 里必须有', () => {
  const D = defRuns();
  const R = runners();
  assert.ok(D.size >= 40, `只读到 ${D.size} 个 def，判据可能失效`);
  assert.ok(R.size >= 38, `只读到 ${R.size} 个执行器，判据可能失效`);
  for (const [kind, fn] of D) {
    if (!fn) continue; // 容器类（frame / 窗格…）不执行，刻意没有 run
    assert.ok(R.has(kind), `${kind} 的 def 写了 run: ${fn}，但 RUNNERS 里没有它 —— 会静默直通成功`);
    assert.equal(R.get(kind), fn, `${kind} 的执行器不一致：def=${fn} RUNNERS=${R.get(kind)}`);
  }
});

/*
 * 反向：RUNNERS 里多出来的，def 那边也得对得上。
 * 只查正向的话，写错 kind 名（比如 'playAudio' 写成 'play-audio'）
 * 会变成"两边各说一份"，而 def 那条路根本不执行。
 */
test('源码：RUNNERS 里的每一项，def 那边也对得上', () => {
  const D = defRuns();
  const R = runners();
  for (const [kind, fn] of R) {
    if (kind === 'mcp') continue; // 动态生成，不在 defs 里
    assert.ok(D.has(kind), `RUNNERS 里的 ${kind} 没有对应的 def`);
    assert.equal(D.get(kind), fn, `${kind} 的执行器不一致：def=${D.get(kind)} RUNNERS=${fn}`);
  }
});

/* 动态生成的种类不在 defs 里，只能单独钉住 —— 漏了它就是本轮那种失效 */
test('源码：动态生成种类的 dataKind 已注册执行器', () => {
  const src = readSrc('engine/mcpTools.ts');
  const m = src.match(/export const MCP_DAT[aA][kK]IND\s*=\s*'([^']+)'/);
  assert.ok(m, '没找到 MCP_DATAKIND');
  assert.ok(runners().has(m![1]), `${m![1]} 是动态生成的种类，最容易漏 —— 必须在 RUNNERS 里`);
});
