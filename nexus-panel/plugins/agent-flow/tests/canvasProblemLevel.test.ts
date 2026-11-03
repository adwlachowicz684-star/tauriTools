import test from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from './srcScan';
import {
  expandCanvasRefs, canvasInnerId, splitCanvasProblems,
  KIND_CANVAS_REF, KIND_CANVAS_IN,
} from '../engine/canvasRef';

/**
 * 跨画布展开的 problems 里混着两件完全不同的事：
 *
 *   fail —— 引用节点没展开、原样留在图里。它没有执行器，dispatchNode
 *           的兜底是直通 + success + 空输出，必须由调用方预置成失败。
 *   warn —— 已经展开成内部节点了，只是接口配置有问题（端口没连线、
 *           没有入口/出口）。只是提示，绝不能让节点失败。
 *
 * 探针实测（修之前）：子画布有个「画布输入」没接下游时，
 *   展开结果里 cr1__in1 / cr1__calc / cr1__out1 三个内部节点都在，
 *   日志却是「⚠ 跨画布调用「cr1」未能展开：画布「报表」的 1 个
 *   画布输入节点还没接下游」—— 明明展开了，还带着只有展开后才
 *   算得出来的端口诊断。排查方向被指到「画布是不是被删了」。
 *
 * 而且当时是靠「instanceId 是否还在图里」猜语义：那是结构上的巧合，
 * 不是契约。现在 level 显式带在 problem 上，分类收进
 * splitCanvasProblems 一处，两档日志分开说。
 */

const N = (id: string, kind: string, extra: Record<string, unknown> = {}) =>
  ({ id, data: { kind, label: id, ...extra } });
const E = (s: string, t: string) => ({ id: `${s}-${t}`, source: s, target: t });

/** 显式输入端口拖出来了但没接下游：展开成功，只该报 warn */
function loosePortView() {
  return {
    id: 'B', name: '报表',
    nodes: [
      N('in1', KIND_CANVAS_IN),
      N('calc', 'log', { text: '算' }),
      N('out1', 'canvasOut'),
    ],
    edges: [E('calc', 'out1')],
  };
}

function looseGraph() {
  return {
    nodes: [N('cr1', KIND_CANVAS_REF, { canvasId: 'B' }), N('down', 'log', { text: '下游' })],
    edges: [E('cr1', 'down')],
  };
}

/* ================= 行为 ================= */

test('探针：展开成功的实例报 warn，不进 prefailed', () => {
  const B = loosePortView();
  const ex = expandCanvasRefs(looseGraph(), (id) => (id === 'B' ? B : null));

  assert.ok(ex.nodes.some((n) => n.id === 'cr1__in1'), '内部节点确实并进来了 —— 它展开了');
  assert.ok(!ex.nodes.some((n) => n.id === 'cr1'), '引用节点已被内部节点替换');
  assert.equal(ex.problems.length, 1, JSON.stringify(ex.problems));
  assert.equal(ex.problems[0].level, 'warn');
  assert.match(ex.problems[0].reason, /画布输入节点还没接下游/);

  const { failed, warned } = splitCanvasProblems(ex.problems);
  assert.equal(failed.length, 0, 'warn 绝不能进 prefailed（那会让一个不存在的节点失败）');
  assert.equal(warned.length, 1);
  assert.equal(warned[0].instanceId, 'cr1');
});

test('四种「没展开」的情形都是 fail，且实例确实还在图里', () => {
  const cases: { name: string; run: () => ReturnType<typeof expandCanvasRefs> }[] = [
    {
      name: '没填 canvasId',
      run: () => expandCanvasRefs(
        { nodes: [N('cr1', KIND_CANVAS_REF)], edges: [] }, () => null,
      ),
    },
    {
      name: '找不到画布',
      run: () => expandCanvasRefs(looseGraph(), () => null),
    },
    {
      name: '循环调用',
      run: () => {
        const A = {
          id: 'A', name: 'A',
          nodes: [N('r', KIND_CANVAS_REF, { canvasId: 'B' })], edges: [],
        };
        const B = {
          id: 'B', name: 'B',
          nodes: [N('r', KIND_CANVAS_REF, { canvasId: 'A' })], edges: [],
        };
        return expandCanvasRefs({ nodes: [N('top', KIND_CANVAS_REF, { canvasId: 'A' })], edges: [] },
          (id) => (id === 'A' ? A : id === 'B' ? B : null));
      },
    },
    {
      name: '超过展开深度',
      run: () => expandCanvasRefs(looseGraph(), () => loosePortView(), { maxDepth: 0 }),
    },
  ];

  for (const c of cases) {
    const ex = c.run();
    const ids = new Set(ex.nodes.map((n) => String(n.id)));
    /* 成环那例会附带一条「接口不完整」warn，只挑目标那条判，别把 warn 一并否定 */
    const target = ex.problems.find((p) => /找不到画布|循环调用|没有指定|层数/.test(p.reason));
    assert.ok(target, `${c.name}：没找到目标 problem：${JSON.stringify(ex.problems)}`);
    assert.equal(target!.level, 'fail', `${c.name}：「${target!.reason}」该判失败`);
    assert.ok(ids.has(target!.instanceId), `${c.name}：${target!.instanceId} 不在图里，预置失败会落空`);
    assert.ok(
      splitCanvasProblems(ex.problems).failed.some((f) => f.instanceId === target!.instanceId),
      `${c.name}：目标 problem 必须进 prefailed`,
    );
  }
});

test('接口不完整的提示也是 warn（不是没展开）', () => {
  /* 只有画布输入、没有其它节点 → 没有出口，但仍会展开 */
  const B = { id: 'B', name: 'B', nodes: [N('in1', KIND_CANVAS_IN)], edges: [] };
  const ex = expandCanvasRefs(looseGraph(), (id) => (id === 'B' ? B : null));
  assert.ok(ex.problems.length > 0, '这条守卫要真读到提示，否则 every 恒绿');
  const ids = new Set(ex.nodes.map((n) => String(n.id)));
  for (const p of ex.problems) {
    assert.equal(p.level, 'warn', `「${p.reason}」已经展开了，不该判失败`);
    assert.ok(!ids.has(p.instanceId), 'warn 的 instanceId 指向已被替换掉的实例');
  }
  assert.equal(splitCanvasProblems(ex.problems).failed.length, 0);
});

test('内层 fail 透传后仍是 fail，加前缀后在图里', () => {
  const B = {
    id: 'B', name: 'B',
    nodes: [N('cr2', KIND_CANVAS_REF, { canvasId: 'goneC' }), N('b1', 'log')],
    edges: [E('cr2', 'b1')],
  };
  const g = { nodes: [N('cr1', KIND_CANVAS_REF, { canvasId: 'B' })], edges: [] };
  const ex = expandCanvasRefs(g, (id) => (id === 'B' ? B : null));
  const p = ex.problems.find((x) => x.reason.includes('goneC'));
  assert.ok(p, `没找到内层失败：${JSON.stringify(ex.problems)}`);
  assert.equal(p!.level, 'fail', 'level 要跟 ...p 一起透传，别在递归里丢掉');
  assert.equal(p!.instanceId, canvasInnerId('cr1', 'cr2'));
  assert.ok(ex.nodes.some((n) => n.id === p!.instanceId), '加了前缀的 id 必须真的在图里');
  assert.ok(splitCanvasProblems(ex.problems).failed.some((f) => f.instanceId === p!.instanceId));
});

test('内层 warn 透传后仍是 warn，且带上外层前缀', () => {
  const C = loosePortView();
  const B = {
    id: 'B', name: 'B',
    nodes: [N('cr2', KIND_CANVAS_REF, { canvasId: 'C' }), N('tail', 'log')],
    edges: [E('cr2', 'tail')],
  };
  const g = { nodes: [N('cr1', KIND_CANVAS_REF, { canvasId: 'B' })], edges: [] };
  const ex = expandCanvasRefs(g, (id) => (id === 'C' ? C : id === 'B' ? B : null));
  const p = ex.problems.find((x) => x.reason.includes('画布输入节点还没接下游'));
  assert.ok(p, `没找到内层 warn：${JSON.stringify(ex.problems)}`);
  assert.equal(p!.level, 'warn');
  assert.ok(p!.instanceId.startsWith('cr1__'), `内层 warn 没加外层前缀：${p!.instanceId}`);
  assert.equal(splitCanvasProblems(ex.problems).failed.length, 0);
});

test('分类器：混合输入按 level 分开、保持顺序与原因', () => {
  const mixed = [
    { instanceId: 'a', reason: '找不到画布', level: 'fail' as const },
    { instanceId: 'b', reason: '端口没接', level: 'warn' as const },
    { instanceId: 'c', reason: '成环', level: 'fail' as const },
  ];
  const { failed, warned } = splitCanvasProblems(mixed);
  assert.deepEqual(failed.map((x) => x.instanceId), ['a', 'c']);
  assert.deepEqual(warned.map((x) => x.instanceId), ['b']);
  assert.equal(failed[0].reason, '找不到画布');
  assert.equal(warned[0].reason, '端口没接');
});

test('反例：空 problems 不凭空造出 failed', () => {
  const { failed, warned } = splitCanvasProblems([]);
  assert.deepEqual(failed, []);
  assert.deepEqual(warned, []);
});

/* ================= 源码守卫 ================= */

test('源码守卫：每处新构造的 problem 都显式标了 level', () => {
  const s = readSrc('engine/canvasRef.ts');
  /* 可信度：先证明读到的确实是 canvasRef.ts 的代码 */
  assert.match(s, /export function expandCanvasRefs\(/, 'readSrc 没读到 expandCanvasRefs');
  assert.match(s, /p\.level === 'fail'/, '分类器里必须按 level 判，不能一律当失败');

  const pushes = [...s.matchAll(/problems\.push\(([\s\S]*?)\);/g)].map((m) => m[1]);
  assert.ok(pushes.length >= 7, `只找到 ${pushes.length} 处 problems.push，守卫可能读空了`);
  for (const body of pushes) {
    /* 内层透传用 ...p 把 level 一起带过去，行为测试另有两条钉住 */
    if (body.includes('...p')) continue;
    assert.match(
      body, /level:\s*'(fail|warn)'/,
      `这处 problems.push 没标 level，新增问题会静默落到错误那一档：${body.slice(0, 120)}`,
    );
  }
});

test('源码守卫：App 两档日志分开说，prefailed 只由 failed 生成', () => {
  const s = readSrc('App.tsx');
  assert.match(s, /splitCanvasProblems\(canvasExpanded\.problems\)/);
  assert.match(s, /for \(const p of failed\)/);
  assert.match(s, /for \(const p of warned\)/);
  assert.match(s, /未能展开/, 'fail 档要说未能展开');
  assert.match(s, /已展开，但接口需检查/, 'warn 档不许再说未能展开');
  assert.match(s, /prefailed\[p\.instanceId\] = p\.reason;/);
  assert.ok(!s.includes('expandNodeIds'), '别退回「id 是否真的在图里」那套巧合判据');

  const warnSeg = s.slice(s.indexOf('for (const p of warned)'), s.indexOf('const graph ='));
  assert.ok(warnSeg.length > 0, '没截到 warn 循环，下面的断言会恒绿');
  assert.ok(!warnSeg.includes('prefailed'), 'warn 档不许写进 prefailed');
});
