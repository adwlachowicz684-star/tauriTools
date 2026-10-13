/**
 * 参数连线在「来源这次没产出」时的行为。
 *
 * ================= 为什么单独一份 =================
 *
 * 参数连线绕过了模板渲染：模板里写 `{{上游.output}}` 取不到值时，
 * 现在会**明确失败**（见 tests/unresolved.test.ts 那一族）；
 * 而参数连线取不到值时是**保留手填值** —— 两种口径不同，
 * 因为连线是"这个参数的值来自那边"，不是"这里要填一句模板"。
 *
 * 保留手填值这条口径写在 runner.ts 的注释里，但它**没有被跑过**：
 * 既有测试只测 paramLinks 的纯函数（linksInto / outValueOf），
 * 没人拿一张真图去问"来源失败时那个参数到底变成了什么"。
 *
 * 于是漏掉一种情形：**来源跑了，但失败了**。
 *
 * ================= 漏掉的那种情形 =================
 *
 * 失败时 withNodeRun 仍会写 `outputs[id] = ''` —— 那个 '' 是**占位**
 * （好让 `{{id.output}}` 与汇合这类读取有个值），不是产出。
 * 而 paramNodeOf 用 hasOwnProperty 判断"来源有没有产出"，
 * 于是失败与"产出空串"在这一行合并成了同一种行为。
 *
 * 实测（改之前）：
 *
 *   闸门失败 → 「拼接」的 b 从手填的「果」变成 '' → 输出 "X"
 *   用户填的「果」算出来应该是 "X果"
 *
 *   更糟的是目标节点**照常执行**：参数连线不是流程边，失败不沿它传播，
 *   目标不会因为"喂我值的那个节点失败了"而跳过。结果拿着一个被悄悄
 *   清空的参数算出结果、整条流程往下走，日志里只有来源是红的。
 *
 * ================= 判别式 =================
 *
 * 用文本节点的「拼接」而不是比较：
 *
 *   a='X'  b 手填='果'   → "X果"   保留手填
 *   a='X'  b 被清空      → "X"     被覆盖成空串
 *   a='X'  b='香蕉'      → "X香蕉" 连线生效
 *
 * 三种结果互不相同 —— 比较类运算做不到这一点：
 * `'苹果'.includes('')` 恒为 true，判不出"空"和"值"。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraph } from '../engine/runner';
import type { Graph, GraphNode, GraphEdge } from '../types';
import { readSrc } from './srcScan';

const CARD = (value: string) => ({ id: 'c0', value, valueType: 'text' });

const node = (id: string, kind: string, extra: Record<string, unknown> = {}): GraphNode =>
  ({ id, data: { kind, label: id, status: 'idle', output: '', error: '', ...extra } } as unknown as GraphNode);

const flow = (s: string, t: string): GraphEdge =>
  ({ id: `e:${s}->${t}`, source: s, target: t } as GraphEdge);

/** 参数连线：从 source 的默认输出接到 target 的 arg 参数 */
const param = (s: string, t: string, arg: string, sourceArg?: string): GraphEdge =>
  ({
    id: `p:${s}->${t}:${arg}`,
    source: s,
    target: t,
    sourceHandle: `out:${sourceArg ?? 'out'}`,
    targetHandle: `arg:${arg}`,
    type: 'param',
    data: { kind: 'param', targetArg: arg, sourceArg: sourceArg ?? 'out' },
  } as unknown as GraphEdge);

/** 目标节点：文本「拼接」，a='X'，b 手填 '果' */
const target = () => node('c', 'text', { op: 'concat', a: 'X', b: '果' });

async function outOf(nodes: GraphNode[], edges: GraphEdge[]): Promise<string> {
  const s = await runGraph(
    { nodes, edges } as unknown as Graph,
    {
      concurrency: 1,
      executor: async () => ({ output: '', ok: true }),
      llmCaller: async () => ({ ok: true, text: 'T' }),
      onEvent: () => {},
    },
  );
  return String((s.outputs as Record<string, string>)['c'] ?? '');
}

/* ================= 来源没产出 → 保留手填 ================= */

test('来源【失败】：保留手填值，不能被占位空串抹掉', async () => {
  const v = await outOf(
    [
      node('a', 'const', { items: [CARD('苹果')] }),
      // 闸门判定 contains 'zzz' 必不满足 → 失败
      node('g', 'gate', { mode: 'now', check: 'contains', value: 'zzz' }),
      target(),
    ],
    [flow('a', 'c'), param('g', 'c', 'b')],
  );
  assert.equal(
    v,
    'X果',
    '来源失败时那个 "" 是占位、不是产出 —— 参数该保留手填的「果」。'
    + '被抹成空串的话目标是拿空值算出一个无意义的结果，而且不报错',
  );
});

test('来源【被跳过】：保留手填值', async () => {
  const v = await outOf(
    [
      node('a', 'const', { items: [CARD('苹果')] }),
      node('g', 'gate', { mode: 'now', check: 'contains', value: 'zzz' }),
      node('d', 'log', { text: 'x' }),   // 闸门下游 → 被跳过
      target(),
    ],
    [flow('a', 'g'), flow('g', 'd'), flow('a', 'c'), param('d', 'c', 'b')],
  );
  assert.equal(v, 'X果', '来源被跳过 = 这次没有产出 → 保留手填值');
});

test('来源有这个具名输出但这次没写：保留手填值', async () => {
  const v = await outOf(
    [
      node('a', 'const', { items: [CARD('苹果')] }),
      target(),
    ],
    // const 的具名输出是卡 id（c0），这里要一个它根本没有的输出
    [flow('a', 'c'), param('a', 'c', 'b', 'chars')],
  );
  assert.equal(v, 'X果', 'outValueOf 返回 null（这次没这个输出）→ 保留手填值');
});

/* ================= 来源确实产出了 → 照常覆盖 ================= */

test('来源产出空串：照常覆盖成空（不能为了"不覆盖"把这条也改掉）', async () => {
  const v = await outOf(
    [
      node('a', 'const', { items: [CARD('')] }),
      target(),
    ],
    [flow('a', 'c'), param('a', 'c', 'b')],
  );
  assert.equal(
    v,
    'X',
    '来源跑到了、产出就是空 —— 那是真的产出了空，必须照常覆盖。'
    + '把它当成"没产出"的话，"上游明确输出空"与"上游没跑"就分不开了',
  );
});

test('来源正常产出：覆盖手填值（连线确实生效，反向盯住上面几条不是"永远不覆盖"）', async () => {
  const v = await outOf(
    [
      node('a', 'const', { items: [CARD('香蕉')] }),
      target(),
    ],
    [flow('a', 'c'), param('a', 'c', 'b')],
  );
  assert.equal(v, 'X香蕉', '来源有产出时连线必须生效 —— 否则"保留手填"就变成了"连线没用"');
});

/* ================= 源码守卫 ================= */

test('paramNodeOf 必须分辨"失败"与"产出空"—— 只靠 hasOwnProperty 不够', () => {
  const src = readSrc('engine/runner.ts');
  /*
   * 截到函数体结束而不是整段代码。
   *
   * 我第一版用的是宽松匹配，结果"随便哪个文件里出现 failedSet"都能通过 ——
   * 那证明的是"某处有"，不是"这里查了"。守卫自己不能踩这种坑。
   */
  const m = src.match(/function paramNodeOf\([\s\S]*?\n  \}/);
  assert.ok(m, '没找到 paramNodeOf —— 结构变了就改这条守卫，别直接删');
  const body = m![0];
  assert.ok(
    /failedSet/.test(body),
    'paramNodeOf 里没有查失败集合 —— 失败时写入的 "" 是占位，'
    + '只看 hasOwnProperty 会把它当成"产出空串"，从而抹掉手填值',
  );
  assert.ok(
    /hasOwnProperty/.test(body),
    '同时也要保留 hasOwnProperty 那条：它分的是"没跑到"与"产出空串"，'
    + '与失败集合查的不是同一件事，两条缺一不可',
  );
});
