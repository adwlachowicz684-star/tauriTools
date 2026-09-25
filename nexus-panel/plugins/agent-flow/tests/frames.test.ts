import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fitFrames, isFrameNode, frameMemberIds, selectionWithFrames,
  frameDelta, makeFrame, frameGeometryOf, boundsOf,
  FRAME_PAD, FRAME_HEAD,
  type FrameAnyNode,
} from '../engine/frames';
import { readSrc } from './srcScan';

type N = FrameAnyNode & { data?: unknown };

const node = (id: string, x: number, y: number, w = 200, h = 96): N =>
  ({ id, position: { x, y }, width: w, height: h, data: { kind: 'task', label: id } });

const frame = (id: string, members: string[], x = 0, y = 0): N => ({
  ...(makeFrame<N>(id, members, '组合')),
  position: { x, y },
});

/* ================= 识别 ================= */

test('按 type 或 data.kind 都认得出组合框', () => {
  /*
   * 两个口径都要认：转图后 node.type 会被剥掉，
   * 只认 type 的话执行层就"认不出这是框"，框会被当成普通节点去跑。
   */
  assert.equal(isFrameNode({ id: 'f', type: 'frame' }), true);
  assert.equal(isFrameNode({ id: 'f', data: { kind: 'frame' } }), true);
  assert.equal(isFrameNode({ id: 'n', type: 'task' }), false);
  assert.equal(isFrameNode(null), false);
});

test('成员清单去重、且只留字符串', () => {
  const f = { id: 'f', data: { kind: 'frame', members: ['a', 'a', 3, null, 'b'] } };
  assert.deepEqual(frameMemberIds(f), ['a', 'b']);
  assert.deepEqual(frameMemberIds({}), []);
});

/* ================= 自适应 ================= */

test('包围盒取成员的并集，且不含框自己', () => {
  const nodes = [node('a', 0, 0), node('b', 300, 200), frame('f', ['a', 'b'])];
  const b = boundsOf(nodes, ['a', 'b', 'f']);
  assert.deepEqual(b, { x1: 0, y1: 0, x2: 500, y2: 296 });
});

test('成员一个都不在时没有包围盒', () => {
  assert.equal(boundsOf([node('a', 0, 0)], ['zzz']), null);
});

test('框连标题条一起罩住', () => {
  const nodes = [node('a', 100, 100)];
  const g = frameGeometryOf(frame('f', ['a']), nodes)!;
  assert.equal(g.x, 100 - FRAME_PAD);
  assert.equal(g.y, 100 - FRAME_PAD - FRAME_HEAD);
  assert.equal(g.width, 200 + FRAME_PAD * 2);
  assert.equal(g.height, 96 + FRAME_PAD * 2 + FRAME_HEAD);
});

test('成员挪了，框跟着变', () => {
  const before = fitFrames([frame('f', ['a']), node('a', 0, 0)]);
  const after = fitFrames([frame('f', ['a']), node('a', 400, 300)]);
  const f0 = before.find((n) => n.id === 'f')!;
  const f1 = after.find((n) => n.id === 'f')!;
  assert.notDeepEqual(f1.position, f0.position);
  assert.equal(f1.position.x, 400 - FRAME_PAD);
});

test('没变时返回同一个数组', () => {
  /*
   * 每次都返回新数组的话，渲染派生会每次都判定"变了"，
   * 拖动时每帧多一次渲染，而且存档会被反复写。
   */
  const list = [frame('f', ['a']), node('a', 0, 0)];
  const once = fitFrames(list);
  const twice = fitFrames(once);
  assert.equal(twice, once);
});

test('成员被删了：从清单里清掉，全没了就删掉框', () => {
  const out = fitFrames([frame('f', ['a', 'gone']), node('a', 0, 0)]);
  const f = out.find((n) => n.id === 'f')!;
  assert.deepEqual(frameMemberIds(f), ['a']);

  /*
   * 空框在数据上和"刚建的框"分不开，留着它用户只看到
   * 一个框不住任何东西的框。而删掉它不丢任何节点。
   */
  const empty = fitFrames([frame('f', ['gone'])]);
  assert.equal(empty.find((n) => n.id === 'f'), undefined);
});

/* ================= 选中 ================= */

test('点框 = 选中里面所有节点', () => {
  const nodes = [frame('f', ['a', 'b']), node('a', 0, 0), node('b', 0, 200)];
  assert.deepEqual(selectionWithFrames(nodes, ['f']).sort(), ['a', 'b', 'f']);
});

test('点成员 = 只选中它自己', () => {
  const nodes = [frame('f', ['a', 'b']), node('a', 0, 0), node('b', 0, 200)];
  assert.deepEqual(selectionWithFrames(nodes, ['a']), ['a']);
});

/* ================= 拖框 = 挪成员 ================= */

test('拖框把位移转给成员，框自己不动', () => {
  const nodes = [frame('f', ['a']), node('a', 100, 100)];
  const d = frameDelta(nodes, 'f', 50, -20);
  assert.deepEqual(d, { a: { x: 150, y: 80 } });
});

test('嵌合下级跟着一起挪（expand）', () => {
  /*
   * 只挪成员本身会把串拆散：下级留在原地，串断成两截。
   */
  const nodes = [frame('f', ['a']), node('a', 0, 0), node('c', 0, 200)];
  const d = frameDelta(nodes, 'f', 10, 10, (id) => (id === 'a' ? ['c'] : []));
  assert.deepEqual(Object.keys(d).sort(), ['a', 'c']);
});

test('不是框就没有位移', () => {
  assert.deepEqual(frameDelta([node('a', 0, 0)], 'a', 10, 10), {});
});

/* ================= 源码守卫 ================= */
/*
 * 这几处失效的样子都是"安静的"：
 * 不报错、界面看着也正常，只是框的行为悄悄没了。
 */

test('执行前把组合框滤掉', () => {
  const src = readSrc('App.tsx');
  assert.match(src, /filter\(\(n\) => !isFrameNode\(n\)\)/);
});

test('画布渲染走的是自适应之后的那份', () => {
  const src = readSrc('App.tsx');
  assert.match(src, /framedNodes\.map\(/);
  assert.match(src, /fitFrames\(displayNodes\)/);
});

test('拖框的位移转给了成员', () => {
  const src = readSrc('App.tsx');
  /*
   * 前面带"非标识符字符"：只写 frameDelta( 的话，
   * 把调用改名成别的 xxxFrameDelta( 也照样命中 ——
   * 那就等于"改坏了还报绿"，比没有这条守卫更糟。
   */
  assert.match(src, /(^|[^A-Za-z0-9_$])frameDelta\(/);
});

test('嵌合不认组合框（两个方向都挡住）', () => {
  const src = readSrc('engine/stack.ts');
  const hits = src.match(/if \(isFrameNode\(n\)\) continue;/g) ?? [];
  assert.ok(hits.length >= 2, `嵌合应挡住组合框，实际 ${hits.length} 处`);
});

test('组合框不进侧栏', () => {
  const src = readSrc('nodes/defs/frame.ts');
  assert.match(src, /presets: \(\) => \[\]/);
});

test('组合框已注册', () => {
  const src = readSrc('nodes/index.ts');
  assert.match(src, /import '\.\/defs\/frame';/);
});
