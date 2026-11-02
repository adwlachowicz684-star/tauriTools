/*
 * 画布之间互相调用成环 —— 要**在保存时就说**，不能等到运行
 *
 * ============ 这次改的是什么 ============
 *
 * findCanvasCycles 早就写好了，但全项目**没有任何地方调用它**。
 * 它自己的注释写着：
 *
 *   每次保存画布时跑一次最合适 ——
 *   等到执行时才发现在循环，用户已经在别的画布上改了半天。
 *
 * 这句话一直没兑现 —— 典型的「对策写了没接上」。
 *
 * ============ 不是会不会崩的问题 ============
 *
 * 执行侧其实是挡住的：expandCanvasRefs 里 stack.includes(canvasId)
 * 会跳过并记一条 problem，所以不会栈溢出。
 *
 * 但那意味着**只有点了运行才知道**，而且被跳过的是一整块，
 * 表现为下游没输出 —— 排查时会去查下游节点，
 * 想不到是两张画布绕起来了。
 *
 * ============ 为什么值得单独钉住 ============
 *
 * 这类"函数写了、注释写了、没人调"的东西，
 * 单测全绿也发现不了 —— 因为它自己是**对的**。
 * 所以下面除了行为测试，还有一条源码守卫盯 App.tsx 真的调了它。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { findCanvasCycles, referencedCanvases } from '../engine/canvasRef';
import { readSrc } from './srcScan';

const APP = path.join('App.tsx');

/** 造一个 CanvasView：nodes 里放 n 个画布引用节点 */
function view(id: string, refs: string[]): Parameters<typeof findCanvasCycles>[0][number] {
  return {
    id,
    name: `画布${id}`,
    nodes: refs.map((r, i) => ({
      id: `${id}_r${i}`,
      data: { kind: 'canvasRef', canvasId: r },
    })) as never,
    edges: [],
  };
}

/* ================================================================== */
/* 一、正例：真的成环要查出来                                           */
/* ================================================================== */

test('行为: A→B→A 要查出来', () => {
  assert.deepEqual(findCanvasCycles([view('A', ['B']), view('B', ['A'])]), [['A', 'B', 'A']]);
});

test('行为: 自环 A→A 要查出来', () => {
  assert.deepEqual(findCanvasCycles([view('A', ['A'])]), [['A', 'A']]);
});

test('行为: 三张画布的环要查出来', () => {
  assert.deepEqual(
    findCanvasCycles([view('A', ['B']), view('B', ['C']), view('C', ['A'])]),
    [['A', 'B', 'C', 'A']],
  );
});

test('行为: 环要带上完整路径（用户得知道是哪几张）', () => {
  const cyc = findCanvasCycles([view('A', ['B']), view('B', ['C']), view('C', ['B'])]);
  assert.equal(cyc.length, 1);
  assert.ok(cyc[0].includes('B') && cyc[0].includes('C'), `路径不完整：${JSON.stringify(cyc[0])}`);
});

/* ================================================================== */
/* 二、反例：别把正常的图说成有环                                        */
/* ================================================================== */

test('反例: 菱形（A→B、A→C、B→D、C→D）不是环', () => {
  assert.deepEqual(
    findCanvasCycles([view('A', ['B', 'C']), view('B', ['D']), view('C', ['D']), view('D', [])]),
    [],
  );
});

test('反例: 链（A→B→C）不是环', () => {
  assert.deepEqual(findCanvasCycles([view('A', ['B']), view('B', ['C']), view('C', [])]), []);
});

test('反例: 引用了已被删除的画布不算环（是另一类问题）', () => {
  assert.deepEqual(findCanvasCycles([view('A', ['ZZZ'])]), []);
});

test('反例: 空画布不报错', () => {
  assert.deepEqual(findCanvasCycles([]), []);
  assert.deepEqual(findCanvasCycles([view('A', [])]), []);
});

test('反例: 引用的不是画布引用节点时，不当成依赖', () => {
  assert.deepEqual(referencedCanvases([{ id: 'n', data: { kind: 'http' } }] as never), []);
});

/* ================================================================== */
/* 三、源码守卫：必须真的被调用                                          */
/* ================================================================== */

test('守卫: App.tsx 真的调用了 findCanvasCycles —— 否则注释是空话', () => {
  const s = readSrc(APP);
  assert.ok(
    s.includes('findCanvasCycles('),
    'App.tsx 没调用 findCanvasCycles —— 环只在运行时才暴露',
  );
  /*
   * ⚠️ 第一版只查 s.includes('findCanvasCycles(')，**注入 A 全绿漏过去了**：
   * 把调用写成 `() => ([]) || findCanvasCycles(...)` 时，文本还在、
   * 而它永远不会被求值 —— 又是一次「只查名字出现」的假守卫
   * （与 SECRET_HEADER_HINTS 只喂固定样例、守卫自指那几次同一族）。
   *
   * 所以这里盯的是**调用不能躲在短路运算符后面**。
   */
  const shortCircuit = /(\|\||&&)[^;\n]{0,120}findCanvasCycles\s*\(/.test(s);
  assert.ok(!shortCircuit, 'findCanvasCycles 的调用躲在 || / && 后面 —— 实际上不会执行');
  assert.ok(s.includes('() => findCanvasCycles('), 'memo 的结论不是直接来自 findCanvasCycles');
});

test('守卫: 成环要报**画布名**而不是 id', () => {
  /*
   * id 是一串 md 开头的东西，用户在界面上从来没见过。
   * 「画布 md8f2c 与 md1a9b 成环」等于没说 —— 他得先猜哪个是哪张。
   */
  const s = readSrc(APP);
  const at = s.indexOf('findCanvasCycles(');
  assert.ok(at >= 0, '没找到调用');
  /*
   * 不能写成 seg.includes('.name') —— 那段里本来就有 `name: c.name`
   * （构造 CanvasView 用的），于是"报 id"也能通过（注入 C 红 0）。
   * 查的是"把 id 过一遍 nameOf"这个动作。
   */
  const seg = s.slice(at, at + 2200);
  assert.ok(seg.includes('.map(nameOf)'), '日志里没把 id 换成画布名');
});

test('守卫: 只在"这一批环变了"时说一次 —— 否则日志被同一句话淹没', () => {
  const s = readSrc(APP);
  const at = s.indexOf('findCanvasCycles(');
  assert.ok(at >= 0);
  /*
   * 同样不能只查 'cycleKeyRef' 出现过 —— 把判据写成
   * `if (false && key === cycleKeyRef.current) return;` 时名字还在、
   * 去重却失效了（注入 B 就是这么漏过去的，红 0）。
   * 所以查**整句判据**。
   */
  assert.ok(
    s.includes('if (key === cycleKeyRef.current) return;'),
    '去重判据不是原本那句 —— 每次编辑都会刷一行日志',
  );
});

test('守卫自身: 源码真的读到了', () => {
  assert.ok(readSrc(APP).length > 60000, 'App.tsx 太短 —— 指错地方了');
});
