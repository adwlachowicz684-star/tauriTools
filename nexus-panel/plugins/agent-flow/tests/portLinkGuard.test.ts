/**
 * 显式端口「放了却没连线」—— 展开时不能变成一根导线。
 *
 * ================= 修之前实测 =================
 *
 * 子画布里放一个「画布输入」但没接下游（旁边还有个 task 节点）：
 *   canvasPorts → entries=["in1"] exits=["in1","b"]   ← in1 既进又出
 *   checkPorts  → warn「输入节点还没接下游」            ← 有人看出来了
 *   expand      → problems=[]                          ← 但没人调 checkPorts
 *
 * 换成「画布输出」没接上游：
 *   canvasPorts → entries=["a","out1"] exits=["out1"] ← out1 既进又出
 *   checkPorts  → []                                   ← 连 warn 都没有
 *   expand      → problems=[]
 *
 * 四种形态全都是「1 入 1 出、接口健康」，展开后外部数据从端口进来、
 * 又从同一个端口出去，中间的节点一件没跑。界面上是"子画布没输出"，
 * 排查时会去查下游节点，想不到是画布接口自己把自己短接了。
 *
 * ================= 三处修复 =================
 * ① canvasPorts：显式端口只做声明的那一侧，不参与另一侧的自动推导
 * ② portWarnings：输入/输出两侧对称检查，且任一漏接就报（不是"全漏才报"）
 * ③ expandCanvasRefs：把 warn 接进 problems —— checkPorts 早就在报，
 *    但全项目没人调它，那句「接口有问题时不静默」一直是空话
 *
 * 判据（缺哪一侧、哪些端口没接）各收成一份，两处共用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canvasPorts, checkPorts, expandCanvasRefs,
  portBlockers, portWarnings,
  KIND_CANVAS_IN, KIND_CANVAS_OUT, KIND_CANVAS_REF,
} from '../engine/canvasRef';
import { readSrc } from './srcScan';

const SRC = 'engine/canvasRef.ts';
const N = (id: string, kind: string, extra: Record<string, unknown> = {}) =>
  ({ id, data: { kind, label: id, ...extra } });
const E = (s: string, t: string) => ({ id: `${s}-${t}`, source: s, target: t });
const V = (nodes: unknown[], edges: unknown[] = [], id = 'c', name = '子画布') =>
  ({ id, name, nodes, edges }) as never;

/** 把一个视图作为子画布展开，返回 problems 文本 */
function expand(view: unknown): string[] {
  const id = (view as { id: string }).id;
  const r = expandCanvasRefs(
    { nodes: [N('ref', KIND_CANVAS_REF, { canvasId: id })], edges: [] },
    (cid) => (cid === id ? view as never : null),
  );
  return r.problems.map((p) => p.reason);
}

/* ================= 一、端口不再自穿 ================= */

test('输入节点没接下游：不被自动推导成出口', () => {
  const v = V([N('in1', KIND_CANVAS_IN), N('b', 'task')]);
  const p = canvasPorts(v as never);
  assert.deepEqual(p.entries, ['in1']);
  assert.deepEqual(p.exits, ['b']);
  assert.deepEqual(p.entries.filter((x) => p.exits.includes(x)), [], '同一个节点既进又出 = 直通');
});

test('输出节点没接上游：不被自动推导成入口', () => {
  const v = V([N('a', 'task'), N('out1', KIND_CANVAS_OUT)]);
  const p = canvasPorts(v as never);
  assert.deepEqual(p.entries, ['a']);
  assert.deepEqual(p.exits, ['out1']);
  assert.deepEqual(p.entries.filter((x) => p.exits.includes(x)), []);
});

test('只有输入节点时出口为空 —— 不再「1 入 1 出」假健康', () => {
  const p = canvasPorts(V([N('in1', KIND_CANVAS_IN)]) as never);
  assert.deepEqual(p.entries, ['in1']);
  assert.deepEqual(p.exits, []);
  assert.equal(portBlockers(p).noExits, true);
});

test('只有输出节点时入口为空', () => {
  const p = canvasPorts(V([N('out1', KIND_CANVAS_OUT)]) as never);
  assert.deepEqual(p.entries, []);
  assert.deepEqual(p.exits, ['out1']);
  assert.equal(portBlockers(p).noEntries, true);
});

test('反例: 显式端口都连好时，接口仍然正确（不许一律排除）', () => {
  const v = V(
    [N('x', 'task'), N('in1', KIND_CANVAS_IN), N('y', 'task'), N('out1', KIND_CANVAS_OUT)],
    [E('x', 'in1'), E('in1', 'y'), E('y', 'out1')],
  );
  const p = canvasPorts(v as never);
  assert.deepEqual(p.entries, ['in1']);
  assert.deepEqual(p.exits, ['out1']);
  assert.deepEqual(portWarnings(v as never), []);
  assert.equal(checkPorts(v as never).length, 0);
});

test('反例: 没有显式端口时自动推导不变', () => {
  const p = canvasPorts(V([N('a', 'task'), N('b', 'log')], [E('a', 'b')]) as never);
  assert.deepEqual(p.entries, ['a']);
  assert.deepEqual(p.exits, ['b']);
});

test('反例: 画布引用节点仍不算接口', () => {
  const p = canvasPorts(V([N('r', KIND_CANVAS_REF, { canvasId: 'other' })]) as never);
  assert.equal(p.entries.length, 0);
});

/* ================= 二、两侧对称报 ================= */

test('checkPorts 报输入节点没接下游', () => {
  const issues = checkPorts(V([N('in1', KIND_CANVAS_IN), N('b', 'task')]) as never);
  assert.ok(issues.some((i) => i.level === 'warn' && i.message.includes('输入节点')), JSON.stringify(issues));
});

test('checkPorts 报输出节点没接上游（修之前完全不报）', () => {
  const issues = checkPorts(V([N('a', 'task'), N('out1', KIND_CANVAS_OUT)]) as never);
  assert.ok(issues.some((i) => i.level === 'warn' && i.message.includes('输出节点')), JSON.stringify(issues));
});

test('三个输入漏接一个也要报，不能只查「全漏」', () => {
  const v = V(
    [N('in1', KIND_CANVAS_IN), N('in2', KIND_CANVAS_IN), N('in3', KIND_CANVAS_IN), N('b', 'task')],
    [E('in1', 'b'), E('in2', 'b')],
  );
  const w = portWarnings(v as never);
  assert.equal(w.length, 1);
  assert.ok(w[0].includes('1 个'), JSON.stringify(w));
});

test('三个输出漏接一个也要报（对称）', () => {
  const v = V(
    [N('a', 'task'), N('out1', KIND_CANVAS_OUT), N('out2', KIND_CANVAS_OUT), N('out3', KIND_CANVAS_OUT)],
    [E('a', 'out1'), E('a', 'out2')],
  );
  const w = portWarnings(v as never);
  assert.equal(w.length, 1);
  assert.ok(w[0].includes('输出节点') && w[0].includes('1 个'), JSON.stringify(w));
});

test('反例: 端口都接好时一条 warn 都没有', () => {
  const v = V(
    [N('in1', KIND_CANVAS_IN), N('b', 'task'), N('out1', KIND_CANVAS_OUT)],
    [E('in1', 'b'), E('b', 'out1')],
  );
  assert.deepEqual(portWarnings(v as never), []);
  assert.equal(checkPorts(v as never).length, 0);
});

/* ================= 三、运行时真的说出来 ================= */

test('展开时把输入侧 warn 接进 problems', () => {
  const v = V([N('in1', KIND_CANVAS_IN), N('b', 'task')], [], 'c2', '子画布2');
  const problems = expand(v);
  assert.ok(problems.some((r) => r.includes('输入节点')), JSON.stringify(problems));
});

test('展开时把输出侧 warn 接进 problems', () => {
  const v = V([N('a', 'task'), N('out1', KIND_CANVAS_OUT)], [], 'c3', '子画布3');
  const problems = expand(v);
  assert.ok(problems.some((r) => r.includes('输出节点')), JSON.stringify(problems));
});

test('只有输入节点时展开报「接口不完整」（修之前静默）', () => {
  const v = V([N('in1', KIND_CANVAS_IN)], [], 'c4', '子画布4');
  assert.ok(expand(v).some((r) => r.includes('接口不完整')));
});

test('反例: 正常子画布展开没有 problems', () => {
  const v = V([N('a', 'task'), N('b', 'log')], [E('a', 'b')], 'c5', '正常');
  assert.deepEqual(expand(v), []);
});

test('反例: 只调用别的画布时，不因为提示多报 problem', () => {
  const v = V([N('r', KIND_CANVAS_REF, { canvasId: 'other' })], [], 'c6', '转发');
  const issues = checkPorts(v as never);
  assert.ok(issues.some((i) => i.message.includes('接口由被调用的那张决定')));
  assert.deepEqual(portWarnings(v as never), []);
  const problems = expand(v);
  assert.ok(!problems.some((r) => r.includes('接口由被调用的那张决定')), JSON.stringify(problems));
});

/* ================= 四、判据只有一份（源码守卫） ================= */

/** 切出函数体：从函数名到下一个 export function / 注释块 */
function bodyOf(src: string, name: string): string {
  const at = src.indexOf(`export function ${name}(`);
  assert.ok(at >= 0, `源码里没找到 ${name} —— 守卫读错东西了`);
  const next = src.indexOf('export function ', at + 10);
  return src.slice(at, next < 0 ? at + 4000 : next);
}

test('守卫自身: 源码真的读到了', () => {
  const s = readSrc(SRC);
  assert.ok(s.includes('export function portWarnings('));
  assert.ok(s.includes('export function portBlockers('));
});

test('守卫: checkPorts 不自己写「缺哪一侧」的判据', () => {
  const b = bodyOf(readSrc(SRC), 'checkPorts');
  assert.ok(b.includes('portBlockers('), 'checkPorts 没走共用判据');
  assert.ok(!/\.entries\.length\s*===/.test(b) && !/\.exits\.length\s*===/.test(b),
    'checkPorts 又抄了一份 length===0 —— 两处各改各的老问题');
  assert.ok(b.includes('portWarnings('), 'checkPorts 没走共用 warn 判据');
});

test('守卫: expandCanvasRefs 不自己写「缺哪一侧」的判据，且真的调 portWarnings', () => {
  const s = readSrc(SRC);
  const b = bodyOf(s, 'expandCanvasRefs');
  assert.ok(b.includes('portBlockers('), '展开没走共用判据');
  assert.ok(b.includes('portWarnings('), '运行时没把端口悬空报进 problems');
  // 调用不能躲在短路后面（只查名字出现的假守卫，本系列踩过多次）
  const shortCircuit = /(\|\||&&)[^;\n]{0,100}portWarnings\s*\(/.test(b);
  assert.ok(!shortCircuit, 'portWarnings 的调用被短路了 —— 实际上不会执行');
  assert.ok(b.includes('for (const w of portWarnings(view))'), 'warn 没有逐条进 problems');
});

test('守卫: canvasPorts 的两侧推导都排除了对侧显式端口', () => {
  const b = bodyOf(readSrc(SRC), 'canvasPorts');
  assert.ok(b.includes('!isExplicitOut.has(id)'), '没接的画布输出仍会被当成入口');
  assert.ok(b.includes('!isExplicitIn.has(id)'), '没接的画布输入仍会被当成出口');
});
