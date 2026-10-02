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

const defsDir = join(AF_SRC, 'nodes/defs');

/** 从 runnerRegistry 源码里解析出「种类 → 执行器」这张表 */
function runners(): Map<string, string> {
  const src = readSrc('engine/runnerRegistry.ts');
  const blk = src.slice(src.indexOf('const RUNNERS'), src.indexOf('\n};', src.indexOf('const RUNNERS')));
  const out = new Map<string, string>();
  for (const m of blk.matchAll(/'?([A-Za-z][\w-]*)'?\s*:\s*(run\w+)\s*,/g)) out.set(m[1], m[2]);
  return out;
}

/* ================================================================ */
/* defs 里每个会执行的种类，RUNNERS 里都得有                           */
/* ================================================================ */

/*
 * 容器类不参与执行，刻意没有执行器。
 *
 * 白名单**必须逐项写明理由** —— 否则"忘了登记"和"刻意不登记"长得一样，
 * 守卫就退化成一条能随手放宽的清单。
 */
const NO_RUNNER_NEEDED: Record<string, string> = {
  frame: '组合框：只框住一批节点，不执行',
  taskPane: 'CLI 窗格：提供共享配置，不执行',
  apiPane: 'API 窗格：提供共享配置，不执行',
  module: '模块：展开成内部节点后由它们各自执行',
  canvasRef: '画布引用：指向另一张画布，本身不执行',
};

function defKinds(): string[] {
  return [...readdirSync(defsDir)]
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
    .flatMap((f) => {
      const s = readFileSync(join(defsDir, f), 'utf-8');
      return [...s.matchAll(/dataKind:\s*'([^']+)'/g)].map((m) => m[1]);
    });
}

test('源码：def 的每个种类，要么有执行器，要么在白名单里', () => {
  const R = runners();
  const kinds = [...new Set(defKinds())];
  assert.ok(kinds.length >= 40, `只读到 ${kinds.length} 个种类，判据可能失效`);
  const missing = kinds.filter((k) => !R.has(k) && !NO_RUNNER_NEEDED[k]);
  assert.deepEqual(
    missing, [],
    `这些种类有 def 却没有执行器 —— 会静默直通成功（绿着、空输出、什么都没做）：${missing.join('、')}`,
  );
  const stale = Object.keys(NO_RUNNER_NEEDED).filter((k) => R.has(k));
  assert.deepEqual(stale, [], `白名单里的这些已经有执行器了，该删掉：${stale.join('、')}`);
});

/*
 * 反向：RUNNERS 里多出来的种类，defs 里也得找得到。
 * 只查正向的话，kind 名写错（'play-audio' 写成 'playAudio'）会变成
 * "两边各说一份"，而 def 那边根本没人执行 —— 且不报错。
 */
test('源码：RUNNERS 里的每个种类，defs 里也有（mcp 是动态生成，单独算）', () => {
  const kinds = new Set(defKinds());
  const extra = [...runners().keys()].filter((k) => k !== 'mcp' && !kinds.has(k));
  assert.deepEqual(extra, [], `RUNNERS 里这些种类在 defs 里查不到：${extra.join('、')}`);
});

/*
 * NodeDef 早已没有 run 字段（见 nodes/types.ts 的说明）：
 * 它全仓无人消费，写了只是"看着接上了、其实没接"。
 * 这条盯住那个假象别回来。
 */
test('源码：def 里不许再写 run 字段（那是没人消费的假象）', () => {
  const bad: string[] = [];
  for (const f of readdirSync(defsDir)) {
    if (!f.endsWith('.ts') && !f.endsWith('.tsx')) continue;
    const s = readFileSync(join(defsDir, f), 'utf-8');
    if (/^[ \t]*run:[ \t]*run\w+,/m.test(s)) bad.push(f);
  }
  assert.deepEqual(bad, [], `这些 def 还在写 run: —— 执行器要登记进 RUNNERS 才生效：${bad.join('、')}`);
});

/* 动态生成的种类不在 defs 里，只能单独钉住 —— 漏了它就是本轮那种失效 */
test('源码：动态生成种类的 dataKind 已注册执行器', () => {
  const src = readSrc('engine/mcpTools.ts');
  const m = src.match(/export const MCP_DAT[aA][kK]IND\s*=\s*'([^']+)'/);
  assert.ok(m, '没找到 MCP_DATAKIND');
  assert.ok(runners().has(m![1]), `${m![1]} 是动态生成的种类，最容易漏 —— 必须在 RUNNERS 里`);
});
