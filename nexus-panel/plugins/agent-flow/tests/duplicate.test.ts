import test from 'node:test';
import assert from 'node:assert/strict';
import { stripRuntime, cloneData, duplicateElements } from '../engine/duplicate';

/**
 * 复制节点（Ctrl+拖动）的纯逻辑。
 *
 * UI 交互本身测不了（要挂 React），但"复制出什么"这部分是纯函数，
 * 值得盯住 —— 尤其"副本不能带着旧的执行结果"。
 */

/* ---- stripRuntime ---- */

test('清掉 status / output / error', () => {
  const s = stripRuntime({ label: 'A', status: 'success', output: '旧响应', error: '旧报错' });
  assert.equal(s.status, undefined);
  assert.equal(s.output, undefined);
  assert.equal(s.error, undefined);
});

test('清掉所有 last* 字段（复制出来不该显示上次的结果）', () => {
  const s = stripRuntime({
    label: 'A', lastSha: 'abc1234', lastBranch: 'main',
    lastChars: 42, lastFiles: ['a.ts'], lastFiredAt: 999,
  });
  assert.equal(s.lastSha, undefined);
  assert.equal(s.lastBranch, undefined);
  assert.equal(s.lastChars, undefined);
  assert.equal(s.lastFiles, undefined);
  assert.equal(s.lastFiredAt, undefined);
});

test('配置字段完整保留', () => {
  const s = stripRuntime({
    label: '查天气', url: 'https://a', method: 'POST',
    headers: 'X: 1', llm: { provider: 'openai' },
  });
  assert.equal(s.url, 'https://a');
  assert.equal(s.method, 'POST');
  assert.equal(s.headers, 'X: 1');
  assert.deepEqual(s.llm, { provider: 'openai' });
});

test('enabled / input 这类配置字段不被误伤', () => {
  const s = stripRuntime({ enabled: true, input: '全局输入', config: { port: 9000 } });
  assert.equal(s.enabled, true);
  assert.equal(s.input, '全局输入');
  assert.deepEqual(s.config, { port: 9000 });
});

test('空数据与 null 都不崩', () => {
  assert.deepEqual(stripRuntime(null), {});
  assert.deepEqual(stripRuntime(undefined), {});
  assert.deepEqual(stripRuntime({}), {});
});

/* ---- cloneData ---- */

test('深拷贝：改副本的嵌套对象不影响原件', () => {
  const src = { llm: { provider: 'openai', apiKey: 'sk-1' }, rules: [{ id: 'r1' }] };
  const copy = cloneData(src);
  (copy.llm as Record<string, unknown>).provider = 'deepseek';
  assert.equal(src.llm.provider, 'openai', '原件不该被改到');
});

test('深拷贝：数组也是独立的', () => {
  const src = { rules: [{ id: 'r1' }] };
  const copy = cloneData(src);
  (copy.rules as Array<Record<string, unknown>>).push({ id: 'r2' });
  assert.equal((src.rules as unknown[]).length, 1);
});

test('循环结构时不抛异常（退化成浅拷贝，至少顶层独立）', () => {
  const src: Record<string, unknown> = { a: 1 };
  src.self = src;
  const copy = cloneData(src);
  assert.equal(copy.a, 1);
});

/* ---- duplicateElements ---- */

function baseInput(over) {
  return {
    nodes: [],
    edges: [],
    ids: [],
    makeNodeId: (old) => `${old}_copy`,
    makeEdgeId: (old) => `${old}_copy`,
    makeData: (newId, oldData) => ({ ...(oldData as object), status: 'idle' }),
    ...over,
  };
}

test('复制单个节点：新 id、位置、data 都按回调来', () => {
  const r = duplicateElements(baseInput({
    nodes: [{ id: 't1', position: { x: 10, y: 20 }, data: { label: 'A' } }],
    ids: ['t1'],
  }));
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].id, 't1_copy');
  assert.deepEqual(r.nodes[0].position, { x: 10, y: 20 });
  assert.equal((r.nodes[0].data as { label: string }).label, 'A');
  assert.equal(r.map.t1, 't1_copy');
});

test('偏移生效（非拖动复制场景用）', () => {
  const r = duplicateElements(baseInput({
    nodes: [{ id: 'a', position: { x: 10, y: 20 }, data: {} }],
    ids: ['a'],
    offset: { x: 24, y: 24 },
  }));
  assert.deepEqual(r.nodes[0].position, { x: 34, y: 44 });
});

test('副本是选中态、原件交给调用方去取消（这里只负责副本）', () => {
  const r = duplicateElements(baseInput({
    nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: {} }],
    ids: ['a'],
  }));
  assert.equal(r.nodes[0].selected, true);
  assert.equal(r.nodes[0].dragging, false);
});

test('只复制内部边，跨集合的边不复制', () => {
  const r = duplicateElements(baseInput({
    nodes: [
      { id: 'a', position: { x: 0, y: 0 }, data: {} },
      { id: 'b', position: { x: 1, y: 1 }, data: {} },
    ],
    edges: [
      { id: 'e1', source: 'a', target: 'b' },   // 内部边：该复制
      { id: 'e2', source: 'x', target: 'a' },   // 单边在外：不该复制
      { id: 'e3', source: 'a', target: 'y' },   // 单边在外：不该复制
    ],
    ids: ['a', 'b'],
  }));
  assert.equal(r.edges.length, 1);
  assert.equal(r.edges[0].id, 'e1_copy');
  // 端点要改指副本，否则副本会连回原件
  assert.equal(r.edges[0].source, 'a_copy');
  assert.equal(r.edges[0].target, 'b_copy');
});

test('多选复制：每个节点都有独立的新 id', () => {
  const r = duplicateElements(baseInput({
    nodes: [
      { id: 'a', position: { x: 0, y: 0 }, data: {} },
      { id: 'b', position: { x: 50, y: 0 }, data: {} },
    ],
    ids: ['a', 'b'],
  }));
  assert.equal(r.nodes.length, 2);
  assert.notEqual(r.nodes[0].id, r.nodes[1].id);
});

test('不在 ids 里的节点不复制', () => {
  const r = duplicateElements(baseInput({
    nodes: [
      { id: 'a', position: { x: 0, y: 0 }, data: {} },
      { id: 'b', position: { x: 1, y: 1 }, data: {} },
    ],
    ids: ['a'],
  }));
  assert.equal(r.nodes.length, 1);
  assert.equal(r.nodes[0].id, 'a_copy');
});

test('ids 为空则不产出任何东西', () => {
  const r = duplicateElements(baseInput({
    nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: {} }],
    ids: [],
  }));
  assert.deepEqual(r.nodes, []);
  assert.deepEqual(r.edges, []);
});

test('data 是深拷贝：改副本不动原件（嵌套对象尤其）', () => {
  const original = { llm: { provider: 'openai' }, label: 'A' };
  const r = duplicateElements(baseInput({
    nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: original }],
    ids: ['a'],
    makeData: (newId, oldData) => ({ ...(oldData as object) }),
  }));
  (r.nodes[0].data as { llm: { provider: string } }).llm.provider = 'deepseek';
  assert.equal(original.llm.provider, 'openai', '原件必须不受影响');
});

test('makeData 拿到的是原 id（取节点定义要用）', () => {
  const seen = [];
  duplicateElements(baseInput({
    nodes: [{ id: 'a', position: { x: 0, y: 0 }, data: { label: 'A' } }],
    ids: ['a'],
    makeData: (newId, oldData, oldId) => { seen.push(oldId); return { ...(oldData as object) }; },
  }));
  assert.deepEqual(seen, ['a']);
});

/**
 * 这条是复制功能的关键保障：
 * 复制一个跑过的节点，副本必须是"待运行"，而不是显示成已完成、带着旧输出。
 * 若这里失守，用户会以为副本已经跑过了。
 */
test('复制跑过的节点：副本不带执行结果（配合 create 铺默认值后为 idle）', () => {
  const r = duplicateElements(baseInput({
    nodes: [{
      id: 'a', position: { x: 0, y: 0 },
      data: { label: 'A', status: 'success', output: '旧响应', lastSha: 'abc' },
    }],
    ids: ['a'],
    // 模拟 UI 层：create 铺默认（idle），再叠配置
    makeData: (newId, oldData) => ({
      ...{ status: 'idle', output: '', error: '' },
      ...stripRuntime(oldData),
    }),
  }));
  const d = r.nodes[0].data as Record<string, unknown>;
  assert.equal(d.status, 'idle');
  assert.equal(d.output, '');
  assert.equal(d.lastSha, undefined);
  assert.equal(d.label, 'A', '配置要留下');
});
