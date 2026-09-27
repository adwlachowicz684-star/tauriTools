/**
 * 「声明的产出种类」与「执行器真的吐出来的值」必须对得上。
 *
 * ================= 为什么要跑执行器 =================
 *
 * `producesArgOf` 里那张表是**手写的**，而手写的表必然漂移。
 * 它已经在闸门上错过一次：
 *
 *   代码里写着  case 'gate': return 'bool'
 *   执行器实际  return { output: text }         // 上游原文，透传
 *
 * 两者不一致的表现**不是报错**，是两种更糟的错：
 *   · 闸门 → 文本参数  ：报「错参」（误报，它本来就是文本）
 *   · 闸门 → 布尔参数  ：放行，实际拿到 "hello"（静默错）
 *
 * 而且它躲过了 2200 多项测试 —— 因为既有测试只断言
 * `producesArgOf('compare') === 'bool'` 这种**自证**的式子，
 * 没人拿真实输出对过。
 *
 * 所以这份测试的原则是：**不看代码推，跑出来看**。
 *
 * ================= 为什么只测这几个 =================
 *
 * 能"确定"地产出某种值的节点就这几个（其余一律 unknown 放行）。
 * unknown 那批不需要测 —— 它们本来就不参与校验，写什么都无所谓。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraph, type RunEvent } from '../engine/runner';
import { producesArgOf } from '../engine/paramLinks';
import type { Graph, GraphNode } from '../types';

const node = (
  id: string,
  kind: string,
  extra: Record<string, unknown> = {},
): GraphNode => ({
  id,
  data: { kind, label: id, status: 'idle', output: '', error: '', ...extra },
} as unknown as GraphNode);

const edge = (s: string, t: string) => ({ id: `${s}->${t}`, source: s, target: t });

const CARD = (value: string, valueType = 'text') => ({ id: 'c0', value, valueType });

async function out(
  nodes: GraphNode[],
  edges: { id: string; source: string; target: string }[],
  lastId: string,
): Promise<string> {
  const events: RunEvent[] = [];
  const summary = await runGraph(
    { nodes, edges } as unknown as Graph,
    {
      concurrency: 1,
      executor: async () => ({ output: '', ok: true }),
      llmCaller: async () => ({ ok: true, text: 'T' }),
      onEvent: (e: RunEvent) => events.push(e),
    },
  );
  if (!summary.ok) {
    const who = summary.failed.join(' / ') || '(未知)';
    throw new Error(`流程没跑通就谈不上校验产出：失败节点 ${who}`);
  }
  return String((summary.outputs as Record<string, string>)[lastId] ?? '');
}

const isBool = (v: string) => v === 'true' || v === 'false';
const isNum = (v: string) => v.trim() !== '' && Number.isFinite(Number(v));

/* ================= 数字 ================= */

test('数学 / 随机 / 汇总：声明 num，实际就得是数字', async () => {
  assert.equal(await out([node('a', 'math', { op: 'add', a: '1', b: '2' })], [], 'a'), '3');
  assert.equal(producesArgOf('math'), 'num');

  const r = await out([node('a', 'random', { op: 'int', a: '5', b: '5' })], [], 'a');
  assert.ok(isNum(r), `随机产出应为数字，实际 ${JSON.stringify(r)}`);
  assert.equal(producesArgOf('random'), 'num');

  // agg 要接在表格后面，没有真文件时执行器会先失败 —— 这里只测声明
  assert.equal(producesArgOf('agg'), 'num');
});

/* ================= 布尔 ================= */

test('比较：声明 bool，实际就得是 true/false', async () => {
  const v = await out([node('a', 'compare', { op: 'gt', a: '5', b: '2' })], [], 'a');
  assert.ok(isBool(v), `比较产出应为 true/false，实际 ${JSON.stringify(v)}`);
  assert.equal(producesArgOf('compare'), 'bool');
});

test('更新检测：bool 模式出 true/false，detail 模式是文本', async () => {
  // 默认 outputFormat 就是 bool
  assert.equal(
    producesArgOf('update', { outputFormat: 'bool' }),
    'bool',
    'bool 模式：输出 String(updated)，是布尔',
  );
  assert.equal(
    producesArgOf('update', { outputFormat: 'detail' }),
    'text',
    'detail 模式：输出是「true\\n标题: …」多行文本，不是布尔。'
    + '按 bool 算会把"输出到文本参数"误报成错参',
  );
  assert.equal(
    producesArgOf('update', {}),
    'bool',
    '没填时按默认 bool —— 与 makeUpdateNode 的 ?? bool 必须一致',
  );
});

/* ================= 透传（关键：这几个绝不能是 bool）================= */

test('闸门是透传：声明必须 unknown，绝不能是 bool', async () => {
  const v = await out(
    [
      node('a', 'const', { items: [CARD('hello')] }),
      node('g', 'gate', { mode: 'now', check: 'contains', value: 'ell' }),
    ],
    [edge('a', 'g')],
    'g',
  );
  assert.equal(v, 'hello', '闸门放行时输出上游原文');

  const declared = producesArgOf('gate', { mode: 'now', check: 'contains', value: 'ell' });
  assert.notEqual(declared, 'bool', '闸门不产出 true/false，不能声明成 bool');
  assert.equal(declared, 'unknown', '透传型一律 unknown（不参与校验），与限流/超时/日志一致');
});

test('限流 / 超时 / 日志也是透传：不得撞进任何确定种类', async () => {
  for (const kind of ['throttle', 'timeout', 'log']) {
    assert.equal(
      producesArgOf(kind),
      'unknown',
      `${kind} 是透传，产出取决于上游；判成任何具体种类都是猜，猜错就是误报`,
    );
  }
  const v = await out(
    [
      node('a', 'const', { items: [CARD('hello')] }),
      node('s', 'log', { text: 'x' }),
    ],
    [edge('a', 's')],
    's',
  );
  assert.equal(v, 'hello', '日志节点透传上游原文');
});

/* ================= 常量：按卡片种类 ================= */

test('常量：声明跟着第一张卡的种类走', async () => {
  assert.equal(await out([node('a', 'const', { items: [CARD('7', 'num')] })], [], 'a'), '7');
  assert.equal(producesArgOf('const', { items: [CARD('7', 'num')] }), 'num');
  assert.equal(producesArgOf('const', { items: [CARD('true', 'bool')] }), 'bool');
  assert.equal(producesArgOf('const', { items: [CARD('hi', 'text')] }), 'text');
});

/* ================= 源码守卫：手写表不许随便加条目 ================= */

test('producesArgOf 的布尔组里不能有透传型节点', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const src = require('fs').readFileSync(
    require('path').join(process.env.AF_SRC || '', 'engine', 'paramLinks.ts'),
    'utf-8',
  ) as string;
  const m = src.match(/case 'compare':\s*\n\s*return 'bool';([\s\S]*?)\n\s{4}case 'const'/);
  assert.ok(m, '没找到布尔组 —— 结构变了，这条守卫要跟着改，别直接删');
  /*
   * 必须先去掉注释再查。
   *
   * 我第一版直接 group.includes("'gate'")，而注释里正好写着
   * 「// 'gate' 不在此列：见上」—— 于是**修好之后守卫照样报红**。
   * 这类"守卫自己被注释骗了"比没有守卫更糟：它会逼人把对的改回去。
   */
  const group = m![1]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  /*
   * 透传型节点（闸门 / 限流 / 超时 / 日志 / 重试）的输出取决于上游，
   * 加进布尔组会同时造成误报与静默错（详见文件头的说明）。
   */
  for (const passthrough of ['gate', 'throttle', 'timeout', 'log', 'retry']) {
    assert.ok(
      !group.includes(`'${passthrough}'`),
      `布尔组里出现了透传型节点 '${passthrough}' —— 它不产出 true/false`,
    );
  }
});
