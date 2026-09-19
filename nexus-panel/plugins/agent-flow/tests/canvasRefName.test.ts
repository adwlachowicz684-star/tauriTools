import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canvasRefDisplayName, canvasRefOptions, syncCanvasRefNames,
} from '../engine/canvasRefName';

/**
 * 「调用画布」节点的显示名。
 *
 * 起因：画布没名字时卡片显示 `cvmamu7obyv93` 这种内部 id 片段，
 * 用户看着像乱码。内部 id 对用户没有任何意义 ——
 * 显示它的唯一后果是让人以为是故障。
 */

const CANVASES = [
  { id: 'cv1', name: '战斗数值' },
  { id: 'cv2', name: '掉落表' },
  { id: 'cv3', name: '' },
];

test('手填的覆盖名最优先', () => {
  const s = canvasRefDisplayName(
    { displayName: '主表', canvasName: '战斗数值', canvasId: 'cv1' }, CANVASES,
  );
  assert.equal(s, '主表');
});

test('没覆盖名时用目标画布的**当前**名字（不是快照）', () => {
  /*
   * 快照是创建时复制的。目标画布后来改名，
   * 还显示旧名会让人以为调错了画布。
   */
  const s = canvasRefDisplayName({ canvasName: '旧名', canvasId: 'cv1' }, CANVASES);
  assert.equal(s, '战斗数值');
});

test('查不到画布时退回快照', () => {
  const s = canvasRefDisplayName({ canvasName: '快照名', canvasId: 'zzz' }, CANVASES);
  assert.equal(s, '快照名');
});

test('目标画布没名字 → 「未命名画布」，绝不显示 id', () => {
  const s = canvasRefDisplayName({ canvasId: 'cvmamu7obyv93' }, CANVASES);
  assert.equal(s, '未命名画布');
  assert.ok(!s.includes('mamu'), '内部 id 不能露出来');
});

test('压根没选画布 → 「还没选要调用哪张画布」', () => {
  assert.equal(canvasRefDisplayName({}, CANVASES), '还没选要调用哪张画布');
});

test('覆盖名是全空格时当没填', () => {
  const s = canvasRefDisplayName({ displayName: '   ', canvasId: 'cv1' }, CANVASES);
  assert.equal(s, '战斗数值');
});

test('目标画布没名字时，任何路径都不出现 id 片段', () => {
  const s = canvasRefDisplayName({ canvasId: 'cvmamu7obyv93', canvasName: '' }, CANVASES);
  assert.ok(!/mamu|cv[a-z0-9]{6}/.test(s), `不该含内部 id：${s}`);
});

/* ---------------- 下拉框候选 ---------------- */

test('候选排除当前画布（调自己会成环）', () => {
  const o = canvasRefOptions(CANVASES, 'cv1');
  assert.deepEqual(o.map((x) => x.value), ['cv2', 'cv3']);
});

test('没名字的画布显示「未命名画布」而不是空白选项', () => {
  const o = canvasRefOptions(CANVASES, null);
  assert.equal(o.find((x) => x.value === 'cv3')?.label, '未命名画布');
});

test('列表为空时不出错（新建的第一张画布）', () => {
  assert.deepEqual(canvasRefOptions([], 'cv1'), []);
  assert.deepEqual(canvasRefOptions(null, null), []);
});

/* ---------------- 改名回写 ---------------- */

const N = (id: string, data: Record<string, unknown>) => ({ id, data });

test('目标画布改名后回写到引用节点', () => {
  const nodes = [N('n1', { canvasId: 'cv1', canvasName: '旧名' })];
  const out = syncCanvasRefNames(nodes, [{ id: 'cv1', name: '新名' }]);
  assert.equal(out[0].data.canvasName, '新名');
});

test('覆盖名不会被回写覆盖', () => {
  const nodes = [N('n1', { canvasId: 'cv1', canvasName: '旧名', displayName: '主表' })];
  const out = syncCanvasRefNames(nodes, [{ id: 'cv1', name: '新名' }]);
  assert.equal(out[0].data.displayName, '主表');
});

test('没变化就原样返回同一引用（否则每次都重渲染整张图）', () => {
  const nodes = [N('n1', { canvasId: 'cv1', canvasName: '战斗数值' })];
  const out = syncCanvasRefNames(nodes, CANVASES);
  assert.equal(out, nodes, '必须是同一个数组引用');
});

test('目标画布没名字时不改写（卡片会自己兜底）', () => {
  const nodes = [N('n1', { canvasId: 'cv3', canvasName: '曾经有名字' })];
  const out = syncCanvasRefNames(nodes, CANVASES);
  assert.equal(out[0].data.canvasName, '曾经有名字');
});

test('非 canvasRef 节点不受影响', () => {
  const nodes = [N('n1', { kind: 'task', prompt: 'hi' })];
  const out = syncCanvasRefNames(nodes, CANVASES);
  assert.equal(out, nodes);
});

test('只改变了的行（其余保持引用不变）', () => {
  const a = N('n1', { canvasId: 'cv1', canvasName: '旧' });
  const b = N('n2', { canvasId: 'cv2', canvasName: '掉落表' });
  const out = syncCanvasRefNames([a, b], CANVASES);
  assert.notEqual(out[0], a, '变了的行要换引用');
  assert.equal(out[1], b, '没变的行保持引用');
});
