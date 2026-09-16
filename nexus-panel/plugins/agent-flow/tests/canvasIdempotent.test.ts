import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateCanvasContent, makeCanvas, sortForDisplay } from '../engine/canvasStore';

/**
 * 幂等性 —— 防止"保存 → 触发自己 → 再保存"的无限循环。
 *
 * App.tsx 里写回画布内容的 effect 依赖了 canvases，而它自己又去 setCanvases。
 * 只要 updateCanvasContent 每次都造新对象，这条链就会自转：
 * 空闲时每 400ms 全量序列化并写一次 localStorage，updatedAt 一直跳，
 * 按它排序的列表还会反复重排。
 *
 * 这里守住根因：内容没变就原样返回入参。
 */
test('内容没变时返回同一个数组引用（React 据此跳过重渲染）', () => {
  const c = makeCanvas('A', { id: 'c1' });
  const before = [c];
  const after = updateCanvasContent(before, 'c1', { nodes: c.nodes, edges: c.edges });
  assert.equal(after, before, '必须返回入参本身，不能是新数组');
});

test('内容没变时不刷 updatedAt（否则排序会一直重排）', () => {
  const c = makeCanvas('A', { id: 'c1' });
  const after = updateCanvasContent([c], 'c1', { nodes: c.nodes, edges: c.edges });
  assert.equal(after[0].updatedAt, c.updatedAt);
});

test('内容真的变了才更新，且 updatedAt 前进', () => {
  const c = makeCanvas('A', { id: 'c1' });
  const nodes = [{ id: 'n1', data: { label: 'x' } }];
  const after = updateCanvasContent([c], 'c1', { nodes });
  assert.notEqual(after, [c]);
  assert.deepEqual(after[0].nodes, nodes);
  assert.ok(after[0].updatedAt >= c.updatedAt);
});

test('内容等价但数组是新实例时也算没变（React Flow 每次都给新数组）', () => {
  const c = makeCanvas('A', { id: 'c1' });
  const before = [c];
  // 结构相同、引用不同
  const nodes = JSON.parse(JSON.stringify(c.nodes));
  const edges = JSON.parse(JSON.stringify(c.edges));
  const after = updateCanvasContent(before, 'c1', { nodes, edges });
  assert.equal(after, before, '应按内容判断，不能只比引用');
});

test('不存在的 id 原样返回，不新增也不报错', () => {
  const c = makeCanvas('A', { id: 'c1' });
  const before = [c];
  assert.equal(updateCanvasContent(before, 'nope', { nodes: [] }), before);
  assert.equal(updateCanvasContent(before, 'nope', { nodes: [] }).length, 1);
});

test('只给其中一个字段时另一个保持不变', () => {
  const c = makeCanvas('A', { id: 'c1' });
  c.nodes = [{ id: 'n1' }];
  c.edges = [{ id: 'e1' }];
  const after = updateCanvasContent([c], 'c1', { nodes: [{ id: 'n2' }] });
  assert.deepEqual(after[0].nodes, [{ id: 'n2' }]);
  assert.deepEqual(after[0].edges, [{ id: 'e1' }], 'edges 不该被清空');
});

test('保存不再循环后：连续调用只前进一次 updatedAt', async () => {
  const c = makeCanvas('A', { id: 'c1' });
  let list = [c];
  const nodes = [{ id: 'n1' }];
  list = updateCanvasContent(list, 'c1', { nodes });
  const t1 = list[0].updatedAt;
  // 模拟 effect 又跑了两轮，内容没变
  list = updateCanvasContent(list, 'c1', { nodes });
  list = updateCanvasContent(list, 'c1', { nodes });
  assert.equal(list[0].updatedAt, t1, '重复保存不该继续推进 updatedAt');
});

test('排序不受重复保存影响', () => {
  const a = makeCanvas('A', { id: 'a' });
  const b = makeCanvas('B', { id: 'b' });
  let list = [a, b];
  list = updateCanvasContent(list, 'a', { nodes: [{ id: 'n' }] });
  const order1 = sortForDisplay(list).map((c) => c.id);
  list = updateCanvasContent(list, 'a', { nodes: [{ id: 'n' }] });
  const order2 = sortForDisplay(list).map((c) => c.id);
  assert.deepEqual(order2, order1, '重复保存不该改变展示顺序');
});

/*
 * 源码级守卫：保存 effect 的依赖数组里不能有 canvases。
 *
 * 为什么是源码检查：App.tsx 是含 JSX 的 React 组件，本项目的测试链路
 * 只剥类型不转 JSX，没法把组件挂起来跑。而这条约束恰恰在依赖数组里，
 * 纯文本就能查准。检查前先剥注释 —— 那段注释里为了说明这个坑，
 * 恰好要提到 canvases，不剥就成了永久假阳性。
 */
test('App.tsx 的保存 effect 依赖里不得出现 canvases（会自触发无限循环）', () => {
  const src = process.env.AF_SRC;
  assert.ok(src, 'AF_SRC 未设置：run-tests.sh 应导出仓库根路径');
  const code = readFileSync(join(src, 'App.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  const at = code.indexOf('const saveTimer = useRef');
  assert.ok(at > 0, '没找到保存 effect');
  const tail = code.slice(at, at + 1500);
  const dep = tail.match(/\},\s*\[([^\]]*)\]/);
  assert.ok(dep, '没找到该 effect 的依赖数组');

  assert.doesNotMatch(
    dep[1],
    /\bcanvases\b/,
    '保存 effect 的依赖里出现了 canvases：写回内容会产生新的 canvases 引用，' +
      '于是 effect 自己触发自己，空闲时每 400ms 全量写一次 localStorage。' +
      '写回用的是函数式更新 (cs) => ...，不需要读外层的 canvases。',
  );
});
