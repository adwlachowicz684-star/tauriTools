import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeCanvas, nextCanvasName, renameCanvas, removeCanvas, nextActiveId,
  updateCanvasContent, sortForDisplay, serialize, deserialize, toMeta,
  redactNodes, redactSecrets, collectSecrets, applySecrets,
  saveToStorage, loadFromStorage, clearSecrets, STORAGE_KEYS,
} from '../engine/canvasStore';

const C = (id: string, name: string, nodes: number = 0, updatedAt: number = 0) => ({
  ...makeCanvas(name, { id, nodes: new Array(nodes).fill({}), updatedAt }),
});

/* ---------- 命名 ---------- */

test('命名: 首个为 "工作流 1"', () => {
  assert.equal(nextCanvasName([]), '工作流 1');
});

test('命名: 跳过已存在的名字', () => {
  const list = [C('a', '工作流 1'), C('b', '工作流 2')];
  assert.equal(nextCanvasName(list), '工作流 3');
});

test('命名: 支持自定义前缀', () => {
  assert.equal(nextCanvasName([], '管道'), '管道 1');
});

/* ---------- 改名 ---------- */

test('改名: 正常改名', () => {
  const list = [C('a', '旧名')];
  const r = renameCanvas(list, 'a', '新名');
  assert.equal(r.name, '新名');
  assert.equal(r.list[0].name, '新名');
});

test('改名: 首尾空白被去掉', () => {
  const r = renameCanvas([C('a', 'x')], 'a', '  带空格  ');
  assert.equal(r.name, '带空格');
});

test('改名: 空名回退到原名', () => {
  const r = renameCanvas([C('a', '原名')], 'a', '   ');
  assert.equal(r.name, '原名');
});

test('改名: 与自身同名不算冲突', () => {
  const r = renameCanvas([C('a', '同名')], 'a', '同名');
  assert.equal(r.name, '同名');
});

test('改名: 重名自动加后缀 (2)', () => {
  const list = [C('a', 'A'), C('b', 'B')];
  const r = renameCanvas(list, 'a', 'B');
  assert.equal(r.name, 'B (2)');
});

test('改名: 重名后缀递增', () => {
  const list = [C('a', 'A'), C('b', 'X'), C('c', 'X (2)')];
  const r = renameCanvas(list, 'a', 'X');
  assert.equal(r.name, 'X (3)');
});

test('改名: 目标不存在则原样返回', () => {
  const list = [C('a', 'A')];
  const r = renameCanvas(list, 'ghost', 'Z');
  assert.equal(r.list, list);
});

/* ---------- 删除 ---------- */

test('删除: 移除指定画布', () => {
  const list = [C('a', 'A'), C('b', 'B')];
  const r = removeCanvas(list, 'a');
  assert.deepEqual(r.list.map((c) => c.id), ['b']);
  assert.equal(r.removed?.id, 'a');
});

test('删除: 不存在的返回 null', () => {
  const r = removeCanvas([C('a', 'A')], 'ghost');
  assert.equal(r.removed, null);
  assert.equal(r.list.length, 1);
});

test('删除: 删中间项 → 激活后一项', () => {
  const list = [C('a', 'A'), C('b', 'B'), C('c', 'C')];
  const after = removeCanvas(list, 'b').list;
  assert.equal(nextActiveId(after, 'b', 1), 'c');
});

test('删除: 删末项 → 激活前一项', () => {
  const list = [C('a', 'A'), C('b', 'B')];
  const after = removeCanvas(list, 'b').list;
  assert.equal(nextActiveId(after, 'b', 1), 'a');
});

test('删除: 删光了 → null', () => {
  assert.equal(nextActiveId([], 'a', 0), null);
});

test('删除: 索引越界时退到第一项', () => {
  const list = [C('a', 'A')];
  assert.equal(nextActiveId(list, 'x', -1), 'a');
});

/* ---------- 内容更新 ---------- */

test('更新: 写入节点与连线', () => {
  const list = [C('a', 'A')];
  const r = updateCanvasContent(list, 'a', { nodes: [{ id: 1 }], edges: [{ id: 'e' }] });
  assert.equal(r[0].nodes.length, 1);
  assert.equal(r[0].edges.length, 1);
});

test('更新: 只给 nodes 时保留 edges', () => {
  const list = [C('a', 'A', 0)];
  const withEdges = updateCanvasContent(list, 'a', { edges: [{ id: 'e' }] });
  const r = updateCanvasContent(withEdges, 'a', { nodes: [{ id: 1 }] });
  assert.equal(r[0].edges.length, 1, 'edges 应保留');
});

/* ---------- 展示 ---------- */

test('toMeta: 汇总节点与连线数', () => {
  const m = toMeta(C('a', 'A', 3));
  assert.equal(m.id, 'a');
  assert.equal(m.name, 'A');
  assert.equal(m.nodeCount, 3);
});

test('排序: 最近更新的在前', () => {
  const list = [C('a', 'A', 0, 100), C('b', 'B', 0, 300), C('c', 'C', 0, 200)];
  assert.deepEqual(sortForDisplay(list).map((c) => c.id), ['b', 'c', 'a']);
});

test('排序: 不修改原数组', () => {
  const list = [C('a', 'A', 0, 100), C('b', 'B', 0, 300)];
  sortForDisplay(list);
  assert.equal(list[0].id, 'a');
});

/* ---------- 持久化 ---------- */

test('持久化: 序列化后能还原', () => {
  const state = { canvases: [C('a', 'A', 2)], activeId: 'a' };
  const back = deserialize(serialize(state));
  assert.equal(back.canvases.length, 1);
  assert.equal(back.canvases[0].name, 'A');
  assert.equal(back.activeId, 'a');
});

test('持久化: 空输入返回空状态', () => {
  assert.deepEqual(deserialize(null), { canvases: [], activeId: null });
});

test('持久化: 非法 JSON 不抛异常', () => {
  const r = deserialize('{ 这不是 json');
  assert.deepEqual(r.canvases, []);
});

test('持久化: 非对象输入不崩', () => {
  assert.deepEqual(deserialize('"just a string"').canvases, []);
  assert.deepEqual(deserialize('123').canvases, []);
});

test('持久化: 缺失字段自动补齐', () => {
  const raw = JSON.stringify({ canvases: [{ id: 'a' }] });
  const r = deserialize(raw);
  assert.equal(r.canvases[0].name, '工作流 1', '缺 name 应补默认名');
  assert.deepEqual(r.canvases[0].nodes, []);
  assert.deepEqual(r.canvases[0].edges, []);
});

test('持久化: 重复 id 自动去重（避免 React key 冲突）', () => {
  const raw = JSON.stringify({
    canvases: [{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }],
  });
  const r = deserialize(raw);
  assert.notEqual(r.canvases[0].id, r.canvases[1].id);
});

test('持久化: activeId 指向已删除画布时退到第一项', () => {
  const raw = JSON.stringify({
    canvases: [{ id: 'a', name: 'A' }],
    activeId: 'deleted',
  });
  const r = deserialize(raw);
  assert.equal(r.activeId, 'a');
});

test('持久化: 无画布时 activeId 为 null', () => {
  const raw = JSON.stringify({ canvases: [], activeId: 'x' });
  assert.equal(deserialize(raw).activeId, null);
});

/* ---------- 脱敏与密钥保险箱 ---------- */

/** 造一个带 apiKey 的 OCR 节点 */
const llmNode = (id: string, apiKey: string) => ({
  id,
  data: {
    kind: 'ocr',
    label: '图片识别',
    llm: { provider: 'openai', baseUrl: '', model: 'gpt-4o', apiKey, timeoutSec: 60 },
    output: '识别结果',
  },
});

test('脱敏: 节点里的 apiKey 被挖空', () => {
  const out = redactNodes([llmNode('n1', 'sk-secret-123')]) as any[];
  assert.equal(out[0].data.llm.apiKey, '');
});


test('脱敏: 不动其他字段（label / model / output 保持原样）', () => {
  const out = redactNodes([llmNode('n1', 'sk-secret-123')]) as any[];
  assert.equal(out[0].data.kind, 'ocr');
  assert.equal(out[0].data.label, '图片识别');
  assert.equal(out[0].data.llm.model, 'gpt-4o');
  assert.equal(out[0].data.output, '识别结果');
});


test('脱敏: 不修改原对象（返回新引用）', () => {
  const src = llmNode('n1', 'sk-secret-123');
  redactNodes([src]);
  assert.equal((src as any).data.llm.apiKey, 'sk-secret-123');
});


test('脱敏: 没有 llm 的节点原样返回', () => {
  const n = { id: 't1', data: { kind: 'task', label: '任务', cli: 'codebuddy' } };
  const out = redactNodes([n]) as any[];
  assert.deepEqual(out[0], n);
});


test('脱敏: llm 里没有 apiKey 字段时不动', () => {
  const n = { id: 'o1', data: { kind: 'ocr', llm: { model: 'gpt-4o' } } };
  const out = redactNodes([n]) as any[];
  assert.equal(out[0].data.llm.model, 'gpt-4o');
  assert.equal('apiKey' in out[0].data.llm, false);
});


test('脱敏: output 里带 llm 字样不会被误伤（只认节点结构）', () => {
  const n = { id: 't1', data: { kind: 'task', output: 'llm: { apiKey: "fake" }' } };
  const out = redactNodes([n]) as any[];
  assert.equal(out[0].data.output, 'llm: { apiKey: "fake" }');
});


test('脱敏: serialize 后不含明文密钥', () => {
  const state = {
    canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [llmNode('n1', 'sk-leak')] }],
    activeId: 'a',
  };
  const raw = serialize(state);
  assert.equal(raw.includes('sk-leak'), false, '序列化结果里不应出现密钥');
});


test('脱敏: redactSecrets 覆盖每个画布', () => {
  const state = {
    canvases: [
      { ...makeCanvas('A', { id: 'a' }), nodes: [llmNode('n1', 'k1')] },
      { ...makeCanvas('B', { id: 'b' }), nodes: [llmNode('n2', 'k2')] },
    ],
    activeId: 'a',
  };
  const r = redactSecrets(state);
  assert.equal((r.canvases[0].nodes[0] as any).data.llm.apiKey, '');
  assert.equal((r.canvases[1].nodes[0] as any).data.llm.apiKey, '');
});


test('保险箱: 按节点 id 收集密钥', () => {
  const state = {
    canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [llmNode('n1', 'k1'), llmNode('n2', 'k2')] }],
    activeId: 'a',
  };
  assert.deepEqual(collectSecrets(state), {
    'n1#llm.apiKey': 'k1', 'n2#llm.apiKey': 'k2',
  });
});


test('保险箱: 跳过空密钥与无 llm 的节点', () => {
  const state = {
    canvases: [{
      ...makeCanvas('A', { id: 'a' }),
      nodes: [llmNode('n1', ''), { id: 't1', data: { kind: 'task' } }, llmNode('n2', 'k2')],
    }],
    activeId: 'a',
  };
  assert.deepEqual(collectSecrets(state), { 'n2#llm.apiKey': 'k2' });
});


test('保险箱: 回填密钥到对应节点', () => {
  const state = {
    canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [llmNode('n1', ''), llmNode('n2', '')] }],
    activeId: 'a',
  };
  const r = applySecrets(state, { 'n2#llm.apiKey': 'real-key' });
  assert.equal((r.canvases[0].nodes[0] as any).data.llm.apiKey, '');
  assert.equal((r.canvases[0].nodes[1] as any).data.llm.apiKey, 'real-key');
});


test('保险箱: 空密钥表时原样返回', () => {
  const state = {
    canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [llmNode('n1', '')] }],
    activeId: 'a',
  };
  assert.deepEqual(applySecrets(state, {}), state);
});


test('保险箱: 往返一致（收集 → 脱敏 → 回填 得到原密钥）', () => {
  const state = {
    canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [llmNode('n1', 'sk-round')] }],
    activeId: 'a',
  };
  const keys = collectSecrets(state);
  const stripped = redactSecrets(state);
  assert.equal((stripped.canvases[0].nodes[0] as any).data.llm.apiKey, '');
  const back = applySecrets(stripped, keys);
  assert.equal((back.canvases[0].nodes[0] as any).data.llm.apiKey, 'sk-round');
});


test('保险箱: 已删节点的密钥不会被收集（自动清理）', () => {
  const state = {
    canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [llmNode('n2', 'k2')] }],
    activeId: 'a',
  };
  // 只收集当前存在的节点，所以 n1 的旧密钥不会留在存储里
  assert.deepEqual(collectSecrets(state), { 'n2#llm.apiKey': 'k2' });
});


test('A3: 画布存档里不含明文密钥', () => {
  const store: Record<string, string> = {};
  const state = {
    canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [llmNode('n1', 'sk-persist')] }],
    activeId: 'a',
  };
  saveToStorage((k: string, v: string) => { store[k] = v; }, state);
  assert.equal(store['agent-flow.canvases.v1'].includes('sk-persist'), false,
    '画布存档里不应有明文密钥');
});

test('A3: saveToStorage 不再往保险箱写明文（密钥由 secretVault 单独加密落盘）', () => {
  const store: Record<string, string> = {};
  const state = {
    canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [llmNode('n1', 'sk-persist')] }],
    activeId: 'a',
  };
  saveToStorage((k: string, v: string) => { store[k] = v; }, state);
  assert.equal('agent-flow.llm-keys.v1' in store, false,
    '画布保存时绝不能碰保险箱 —— 否则会把密文覆盖成明文');
});

test('A3: 保险箱里是密文时，loadFromStorage 不会把它误读成密钥', () => {
  const store: Record<string, string> = {
    'agent-flow.canvases.v1': JSON.stringify({
      canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [llmNode('n1', '')] }],
      activeId: 'a',
    }),
    // 加密后的保险箱：字段都是字符串，老式"明文 map"读法会把它们当成密钥
    'agent-flow.llm-keys.v1': JSON.stringify({
      v: 1, alg: 'AES-GCM', iter: 310000,
      salt: 'AAAA', iv: 'BBBB', data: 'CCCC',
    }),
  };
  const back = loadFromStorage((k: string) => store[k] ?? null);
  const key = (back.canvases[0].nodes[0] as any).data.llm.apiKey;
  assert.equal(key, '', '密文包不能被当成节点密钥回填');
  assert.equal(key === 'AAAA' || key === '1', false);
});

test('保险箱: GitHub 节点的内联令牌同样被收集与脱敏', () => {
  const ghNode = (id: string, token: string) => ({
    id, data: { kind: 'github-push', label: 'push', token, output: 'x' },
  });
  const state = {
    canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [ghNode('g1', 'ghp_write_token')] }],
    activeId: 'a',
  };
  assert.deepEqual(collectSecrets(state), { 'g1#token': 'ghp_write_token' });

  const stripped = redactSecrets(state);
  assert.equal((stripped.canvases[0].nodes[0] as any).data.token, '',
    '带写权限的令牌更不能跟着导出去');

  const back = applySecrets(stripped, { 'g1#token': 'ghp_write_token' });
  assert.equal((back.canvases[0].nodes[0] as any).data.token, 'ghp_write_token');
});

test('保险箱: llm 密钥与 GitHub 令牌互不串字段', () => {
  const state = {
    canvases: [{
      ...makeCanvas('A', { id: 'a' }),
      nodes: [
        llmNode('n1', 'sk-1'),
        { id: 'g1', data: { kind: 'github-push', token: 'ghp-1' } },
      ],
    }],
    activeId: 'a',
  };
  const keys = collectSecrets(state);
  const back = applySecrets(redactSecrets(state), keys);
  assert.equal((back.canvases[0].nodes[0] as any).data.llm.apiKey, 'sk-1');
  assert.equal((back.canvases[0].nodes[1] as any).data.token, 'ghp-1');
  // 不能把令牌写到 apiKey 上，反之亦然
  assert.equal((back.canvases[0].nodes[0] as any).data.token, undefined);
  assert.equal((back.canvases[0].nodes[1] as any).data.llm, undefined);
});

test('保险箱: 导出 JSON 里不含任何密钥（脱敏覆盖两个字段）', () => {
  const state = {
    canvases: [{
      ...makeCanvas('A', { id: 'a' }),
      nodes: [
        llmNode('n1', 'sk-secret-123'),
        { id: 'g1', data: { kind: 'github-push', token: 'ghp-secret-456' } },
      ],
    }],
    activeId: 'a',
  };
  const json = JSON.stringify(redactNodes(state.canvases[0].nodes));
  assert.equal(json.includes('sk-secret-123'), false);
  assert.equal(json.includes('ghp-secret-456'), false);
});

test('保险箱: clearSecrets 只删密钥，不动画布', () => {
  const store: Record<string, string> = {
    'agent-flow.canvases.v1': '{}',
    'agent-flow.llm-keys.v1': '{"n1":"k1"}',
  };
  clearSecrets((k: string) => { delete store[k]; });
  assert.equal('agent-flow.llm-keys.v1' in store, false);
  assert.equal('agent-flow.canvases.v1' in store, true);
});
