import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCanvas, nextCanvasName, renameCanvas, removeCanvas, nextActiveId,
  updateCanvasContent, sortForDisplay, serialize, deserialize, toMeta,
  redactNodes, redactSecrets,
  saveToStorage, loadFromStorage, STORAGE_KEYS,
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

/* ---------- 脱敏（密钥不再落盘，脱敏是唯一防线） ---------- */

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


test('脱敏: 参数卡里的密钥也要挡住', () => {
  /*
   * 参数卡（全局环境变量）现在是画布上填值的地方，
   * 而面板上还挂着"不要在这里填密钥"的提示 ——
   * 只脱敏 env.vars 的话，承诺了会挡、实际没挡，导出即泄露。
   */
  const state = {
    canvases: [
      {
        ...makeCanvas('A', { id: 'a' }),
        config: {
          mcpServers: [],
          env: { vars: {} },
          params: [
            { id: 'p1', name: 'API_KEY', value: 'sk-leak' },
            { id: 'p2', name: '输出目录', value: 'D:\\out' },
          ],
        },
      },
    ],
    activeId: 'a',
  };
  const r = redactSecrets(state);
  const ps = (r.canvases[0] as any).config.params;
  assert.equal(ps[0].value, '', '像密钥的名字要被清空');
  assert.equal(ps[1].value, 'D:\\out', '普通参数不能误伤');
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

test('A3: saveToStorage 只写画布，不产生任何密钥存档', () => {
  const store: Record<string, string> = {};
  const state = {
    canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [llmNode('n1', 'sk-persist')] }],
    activeId: 'a',
  };
  saveToStorage((k: string, v: string) => { store[k] = v; }, state);
  assert.equal('agent-flow.llm-keys.v1' in store, false,
    '密钥不再落盘：保存时不应产生任何密钥存档');
  assert.deepEqual(Object.keys(store).sort(),
    ['agent-flow.activeCanvas.v1', 'agent-flow.canvases.v1'],
    '落盘的面只有画布与当前激活 id');
});

test('A3: 历史遗留的密钥存档不会被读成节点密钥', () => {
  const store: Record<string, string> = {
    'agent-flow.canvases.v1': JSON.stringify({
      canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [llmNode('n1', '')] }],
      activeId: 'a',
    }),
    // 历史遗留的保险箱：字段都是字符串，老式"明文 map"读法会把它们当成密钥
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

test('脱敏: GitHub 节点的内联令牌同样被挖空', () => {
  const ghNode = (id: string, token: string) => ({
    id, data: { kind: 'github-push', label: 'push', token, output: 'x' },
  });
  const state = {
    canvases: [{ ...makeCanvas('A', { id: 'a' }), nodes: [ghNode('g1', 'ghp_write_token')] }],
    activeId: 'a',
  };
  const stripped = redactSecrets(state);
  assert.equal((stripped.canvases[0].nodes[0] as any).data.token, '',
    '带写权限的令牌更不能跟着导出去');
});

test('脱敏: llm 密钥与 GitHub 令牌互不串字段', () => {
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
  const red = redactSecrets(state).canvases[0].nodes;
  assert.equal((red[0] as any).data.llm.apiKey, '');
  assert.equal((red[1] as any).data.token, '');
  // 不能把令牌写到 apiKey 上，反之亦然
  assert.equal((red[0] as any).data.token, undefined);
  assert.equal((red[1] as any).data.llm, undefined);
});

test('脱敏: 导出 JSON 里不含任何密钥（覆盖两个字段）', () => {
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


/* ------------------------------------------------------------------ */
/* 清理护栏：内联密钥保险箱不得复活                                    */
/* ------------------------------------------------------------------ */

/*
 * 保险箱（engine/secretVault.ts + agent-flow.llm-keys.v1）已整体移除 ——
 * 它挡不住真正的威胁（加密用的盐与本机特征都在本机），现在统一走凭据中心。
 *
 * 但"删掉"很容易被无意撤销：有人从旧分支合回一个文件，或为了修别的问题
 * 把 collectSecrets 加回来。所以扫一遍源码，出现任何一个旧标识符就失败。
 */
function collectTs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { collectTs(full, out); continue; }
    if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

/*
 * 插件根目录。
 *
 * 本文件跑在两处：源码下（tests/）与编译产物下（.cache/tsout/tests/）。
 * 编译产物里没有源码，所以用 NEXUS_AF_ROOT 显式指定；没给就沿 __dirname
 * 往上找，找不着**直接抛错** —— 静默跳过会让这条护栏形同虚设。
 */
function pluginRoot(): string {
  if (process.env.NEXUS_AF_ROOT) return process.env.NEXUS_AF_ROOT;
  /*
   * AF_SRC 是编译产物下唯一的线索：产物目录里没有源码，
   * 沿 __dirname 往上找必然失败，于是这条护栏静默失效 ——
   * 而它恰恰是盯"未定义变量"的那一类。
   */
  if (process.env.AF_SRC) return process.env.AF_SRC;
  let d = __dirname;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(d, 'App.tsx')) && existsSync(join(d, 'engine'))) return d;
    const up = join(d, '..');
    if (up === d) break;
    d = up;
  }
  throw new Error('找不到 agent-flow 插件根目录，请设 NEXUS_AF_ROOT');
}

test('清理护栏: 源码里不再出现内联密钥保险箱的任何标识符', () => {
  const banned = ['secretVault', 'collectSecrets', 'applySecrets', 'clearSecrets',
    'SecretPolicy', 'SECRET_POLICY_META', 'SECRET_POLICY_KEY'];
  const root = pluginRoot();
  const files = collectTs(join(root, 'engine'))
    .concat(collectTs(join(root, 'components')))
    .concat(collectTs(join(root, 'nodes')))
    .concat([join(root, 'App.tsx'), join(root, 'types.ts')]);

  const hits: string[] = [];
  for (const f of files) {
    /* 剔掉注释再匹配 —— 说明文字不该把自己判失败 */
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');
    for (const b of banned) {
      if (src.includes(b)) hits.push(`${f.split('/').pop()} → ${b}`);
    }
  }
  assert.deepEqual(hits, [], `出现了已废弃的内联密钥标识符: ${hits.slice(0, 5).join(', ')}`);
  assert.ok(files.length > 20, `扫描到的文件太少（${files.length}），护栏可能没覆盖到`);
});

test('清理护栏: STORAGE_KEYS 里不再有密钥存档位', () => {
  assert.deepEqual(Object.keys(STORAGE_KEYS).sort(), ['active', 'canvases'],
    '密钥不再落盘，落盘面只有画布与当前激活 id');
});

test('清理护栏: 脱敏依然生效（密钥不进存档、不随导出走）', () => {
  const state = {
    canvases: [{
      ...makeCanvas('A', { id: 'a' }),
      nodes: [llmNode('n1', 'sk-must-not-persist')],
    }],
    activeId: 'a',
  };
  const store: Record<string, string> = {};
  saveToStorage((k: string, v: string) => { store[k] = v; }, state);
  const dumped = Object.values(store).join('');
  assert.equal(dumped.includes('sk-must-not-persist'), false,
    '这是移除保险箱后**唯一**还在防泄漏的机制，绝不能退化');
});

/*
 * 守卫：任务/历史列表不得再引用未定义的 active / setSel。
 *
 * 这两个名字是"选中态提到 App 持有"那次留下的：
 * 组件里根本没有它们，每行渲染都会求值 → ReferenceError → **整个列表白屏**。
 *
 * 这类问题测试跑不出来（列表组件不进单测），只能扫源码。
 * 匹配 `active &&` 而不是单独的 active —— 后者会命中 activeId / activeCanvas 等合法名字。
 */
test('守卫: 列表组件里不再有未定义的 active / setSel', () => {
  const root = pluginRoot();
  const files = [
    join(root, 'components', 'TaskPanel.tsx'),
    join(root, 'components', 'HistoryPanel.tsx'),
  ];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(!/\bsetSel\b/.test(src), `${f} 里还有 setSel`);
    assert.ok(!/\bactive\s*&&/.test(src), `${f} 里还有 active &&`);
  }
});
