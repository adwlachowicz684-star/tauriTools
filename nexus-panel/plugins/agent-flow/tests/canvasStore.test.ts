import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeCanvas, nextCanvasName, renameCanvas, removeCanvas, nextActiveId,
  updateCanvasContent, sortForDisplay, serialize, deserialize, toMeta,
  redactNodes, redactSecrets, normalizeCanvasConfig, redactCanvasConfig,
  redactEnv, redactParams,
  saveToStorage, loadFromStorage, STORAGE_KEYS,
} from '../engine/canvasStore';
import { AF_SRC } from './srcScan';

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

/*
 * 【数据丢失】存档里带 config 的画布，读出来 config 必须是同一份。
 *
 * deserialize 以前逐字段重建 Canvas 时**把 config 整个漏掉了**：
 * 节点、连线、名字都在，唯独画布级配置（MCP 服务 + 画布参数）消失。
 *
 * 危害在于没有痕迹：用户看到"我的流程还在，但服务没了"，
 * 只会以为自己没存过 —— 而节点里 {{params.路径}} 的引用会静默取空。
 */
test('存档往返：画布级配置（MCP 服务与画布参数）不能被丢掉', () => {
  const c = {
    ...makeCanvas('带配置的画布'),
    config: {
      mcpServers: [{ id: 's1', name: '文件服务', command: 'npx -y fs' }],
      env: { vars: { PATH_LIKE: '/tmp' } },
      params: [{ id: 'p1', name: '路径', value: '/data' }],
    },
  };
  const back = deserialize(serialize({ canvases: [c], activeId: c.id }));
  const cfg = back.canvases[0].config;
  assert.ok(cfg, 'config 必须还在 —— 漏掉它就是"流程还在、服务没了"');
  assert.equal(cfg!.mcpServers.length, 1);
  assert.equal(cfg!.mcpServers[0].name, '文件服务');
  assert.equal(cfg!.params?.length, 1);
  assert.equal(cfg!.env.vars.PATH_LIKE, '/tmp');
});

/* 没存过配置的画布，读出来要拿到与 emptyCanvasConfig 同构的空配置 */
test('存档往返：没存过 config 的画布读出来是空配置（不是 undefined）', () => {
  const c = { ...makeCanvas('没配过') };
  const back = deserialize(serialize({ canvases: [c], activeId: c.id }));
  const cfg = back.canvases[0].config;
  assert.ok(cfg, '给一份空配置，让调用方不必到处判 undefined');
  assert.deepEqual(cfg!.mcpServers, []);
  assert.deepEqual(cfg!.env.vars, {});
});

/*
 * config 来自存档，可能是手改坏的。
 * 直接透传会让 validateCanvasConfig 对非数组 for...of → 抛在渲染阶段 → 画布打不开。
 */
test('normalizeCanvasConfig: 坏字段归一，但不崩', () => {
  const a = normalizeCanvasConfig({ mcpServers: 'nope', env: { vars: null }, params: 'nope' });
  assert.deepEqual(a.mcpServers, []);
  assert.deepEqual(a.env.vars, {});
  assert.deepEqual(a.params, []);

  const b = normalizeCanvasConfig(null);
  assert.deepEqual(b.mcpServers, []);

  // 数组里的非对象条目要丢掉，但不能因此把整份配置丢了
  const cc = normalizeCanvasConfig({ mcpServers: [{ id: 's1', name: 'ok' }, 'junk', null] });
  assert.equal(cc.mcpServers.length, 1);
  assert.equal(cc.mcpServers[0].id, 's1');
});
/*
 * MCP 服务的 env 是「启动命令要用的环境变量」，正是最顺手放 token 的地方。
 * 以前只脱敏 env.vars 与 params，漏了这一处 —— 明文落进 localStorage，
 * 而文件顶部写的是「密钥一律不落盘」。
 */
test('脱敏: MCP 服务 env 里的密钥也要挡住', () => {
  const cfg = {
    mcpServers: [
      { id: 's1', name: '文件服务', command: 'npx -y fs', env: { GITHUB_TOKEN: 'ghp_xxx', PATH_LIKE: '/tmp' } },
    ],
    env: { vars: {} },
    params: [],
  } as never;
  const r = redactCanvasConfig(cfg);
  assert.equal(r.mcpServers[0].env?.GITHUB_TOKEN, '', '服务 env 里的 token 必须挖空');
  assert.equal(r.mcpServers[0].env?.PATH_LIKE, '/tmp', '不是密钥的环境变量要保留');
  // 服务的结构字段不能因为脱敏丢了
  assert.equal(r.mcpServers[0].name, '文件服务');
  assert.equal(r.mcpServers[0].command, 'npx -y fs');
});

/* 走 localStorage 那条路（serialize）也要挡住 —— 两条路必须是同一份口径 */
test('脱敏: 服务 env 的密钥不进 localStorage', () => {
  const c = {
    ...makeCanvas('带服务'),
    config: {
      mcpServers: [{ id: 's1', name: 'n', command: 'x', env: { NOTION_API_KEY: 'secret_ntn' } }],
      env: { vars: {} },
      params: [],
    },
  };
  const raw = serialize({ canvases: [c], activeId: c.id });
  assert.ok(!raw.includes('secret_ntn'), '密钥不能出现在存档里');
  const back = JSON.parse(raw).canvases[0].config;
  assert.equal(back.mcpServers[0].env.NOTION_API_KEY, '');
});

/*
 * 画布导出成文件 / 从文件导回来，配置必须跟着走。
 *
 * 以前 exportJson 只带 nodes/edges/triggers、importJson 只读 nodes/edges ——
 * 于是「导出画布、换台机器导入」静默丢掉画布级配置（MCP 服务 + 画布参数），
 * 节点里 {{params.路径}} 全部取空，且不报错。
 *
 * App.tsx 不进单测（要 DOM），所以扫源码。
 */
test('守卫: 画布导出带 config、导入读 config（丢一半就是"换台机器就用不了"）', () => {
  const src = readFileSync(join(pluginRoot(), 'App.tsx'), 'utf8');
  const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const m = noComment.match(/const text = JSON\.stringify\(([\s\S]*?)\n\s*\);/);
  assert.ok(m, '没找到导出那句 JSON.stringify');
  assert.ok(/config/.test(m![1]), '导出必须带 config —— 只带 nodes/edges 会丢画布级配置');
  assert.ok(
    /redactCanvasConfig/.test(m![1]),
    '导出必须脱敏 —— 配置里有服务 env 与参数卡，不脱敏就是把密钥写进要发给别人的文件',
  );

  assert.ok(
    /\.config\b[\s\S]{0,200}normalizeCanvasConfig|normalizeCanvasConfig\(p\.config\)/.test(noComment),
    '导入必须读 config 并归一 —— 文件可能手改过',
  );

  /*
   * 导入是整体替换：文件里没有 nodes 数组时继续往下走，
   * 会把当前画布清空（"导入了一个别的文件"是极常见的手误）。
   */
  assert.ok(
    /Array\.isArray\(p\?\.nodes\)/.test(noComment),
    '导入前必须确认 nodes 是数组 —— 否则拿 undefined 去 setNodes 会清空画布',
  );
});
/*
 * 运行时状态（status / output / error / last*）与"要交出去的文件"。
 *
 * 四个出口——存模块、设为默认、存预设、复制节点——都剥运行时，
 * 只有**导出画布**以前没剥。而导出的文件是要发给别人的：
 * 每个节点都带着 status:'success' 和上次的实际输出，而那输出里可能是
 * 脚本执行结果、接口响应、乃至令牌。收到的人看到一堆绿节点，
 * 会以为这就是流程自带的结果。
 */
test('导出画布剥掉运行时状态（输出里可能带着上一次的真实结果）', () => {
  const src = readFileSync(join(pluginRoot(), 'App.tsx'), 'utf8');
  const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  const m = noComment.match(/const text = JSON\.stringify\(([\s\S]*?)\n\s*\);/);
  assert.ok(m, '没找到导出那句 JSON.stringify');
  assert.ok(
    /stripRuntimeNodes/.test(m![1]),
    '导出必须剥运行时 —— 只调 redactNodes 会把 status/output 一起交出去',
  );
  assert.ok(
    /redactNodes/.test(m![1]),
    '导出仍要脱敏 —— 密钥与运行时是两回事，不能只剥一个',
  );

  /*
   * 导入也要剥：防手改过的、或老版本导出的文件带进"已跑完"的假象。
   *
   * 锚点必须带上 p.nodes —— 只写 `setNodes\(` 会匹配到 App 里**第一处**
   * setNodes（那处是切画布时读存档，与此无关），于是这条守卫要么恒绿
   * （第一处恰好也剥了）、要么恒红（第一处没剥），两种都是假守卫。
   */
  const imp = noComment.match(/setNodes\(([^;]*\bp\.nodes\b[^;]*)\);/);
  assert.ok(imp, '没找到导入那句 setNodes(...p.nodes...)');
  assert.ok(
    /stripRuntimeNodes/.test(imp![1]),
    '导入必须剥运行时 —— 别处来的文件里 status:success 会让人以为这次跑过了',
  );
});

/*
 * 这条是**反向**的，专门守上面那条别被"统一"过去。
 *
 * 存档（localStorage）**不剥**运行时是有意的：那是本人本机的，
 * 刷新后还想看得见上次跑的结果 —— 与"要交出去的文件"是两回事。
 *
 * 扫源码的守卫挡不住"顺手把存档也剥了"（那行代码本身没毛病），
 * 所以钉行为：序列化之后 status / output 必须还在。
 */
test('存档保留运行时状态（刷新后还要看得见上次的结果）', () => {
  const st = {
    canvases: [{
      id: 'c1', name: 'w', updatedAt: 0,
      nodes: [{
        id: 'n1', position: { x: 0, y: 0 },
        data: { kind: 'task', prompt: 'p', status: 'success', output: '上次的结果' },
      }],
      edges: [],
    }],
    activeId: 'c1',
  } as never;
  const back = JSON.parse(serialize(st)).canvases[0].nodes[0].data;
  assert.equal(back.status, 'success', '存档要保留状态 —— 刷新后看得见上次跑到哪');
  assert.equal(back.output, '上次的结果', '存档要保留输出');
});

/*
 * env.vars 与 params 的脱敏。
 *
 * 为什么单独钉住：故障注入时我发现——把 redactEnv 改成直接透传，
 * **测试照样全绿**（此前没有任何一条测试真的检查过它）。
 * 而它挡的是"变量名像密钥"这种最顺手填 token 的地方。
 *
 * 扫源码的守卫抓不住这种退化：源码里 `out[k] = v` 与
 * `out[k] = 判据 ? '' : v` 都"看起来在脱敏"，只有跑一遍才看得出。
 */
test('脱敏: env.vars 里名字像密钥的要挖空', () => {
  const r = redactEnv({ MY_TOKEN: 'abc', NOTION_API_KEY: 'ntn_x', PLAIN_PATH: '/tmp' });
  assert.equal(r.MY_TOKEN, '', 'token 必须挖空');
  assert.equal(r.NOTION_API_KEY, '', 'api key 必须挖空');
  assert.equal(r.PLAIN_PATH, '/tmp', '不像密钥的变量名要保留');
});

test('脱敏: 参数卡里名字像密钥的要挖空', () => {
  const r = redactParams([
    { id: 'p1', name: 'apiKey', value: 'sk-live' } as never,
    { id: 'p2', name: '路径', value: '/tmp' } as never,
  ]);
  assert.equal(r[0].value, '', '参数卡里的密钥必须挖空');
  assert.equal(r[1].value, '/tmp', '普通参数要保留');
  assert.equal(r[0].name, 'apiKey', '只挖值，名字要留着（界面还要显示）');
});

/* ==================================================================
 * 源码守卫：画布存档只有一条写路径，且那条路默认脱敏
 *
 * 模块 / 变量 / 预设三处都出过同一个 bug：写入口不止一个，
 * 于是"某条路记得脱敏、另一条路忘了"。画布这块目前是干净的
 * （serialize 里默认调 redactSecrets，唯一写入口是 saveToStorage），
 * 但**没有东西拦着第二条路长出来**。
 *
 * 扫源码的守卫接不住"新增一个调用点但忘了脱敏"那类退化 ——
 * 那行代码本身没毛病。这里钉的是更靠前的一层：
 * 不允许出现**绕过 serialize 直接写画布存档**的地方。
 * ================================================================== */

/** 遍历若干根，收集全部 .ts/.tsx（不含 tests 与编译产物） */
function walkSources(): { rel: string; src: string }[] {
  const roots = ['App.tsx', 'components', 'engine', 'hooks', 'lib'];
  const out: { rel: string; src: string }[] = [];
  const walk = (rel: string): void => {
    const abs = join(AF_SRC, rel);
    if (!existsSync(abs)) return;
    if (statSync(abs).isFile()) {
      if (/\.tsx?$/.test(rel)) out.push({ rel, src: readFileSync(abs, 'utf-8') });
      return;
    }
    for (const f of readdirSync(abs)) {
      if (f === 'tests' || f === 'node_modules') continue;
      walk(join(rel, f));
    }
  };
  for (const r of roots) walk(r);
  return out;
}

/*
 * 画布存档的 key 字面量。'agent-flow.canvases.v1' 与 STORAGE_KEYS.canvases
 * 都要认 —— 只认字面量的话，将来有人改用 STORAGE_KEYS.canvases 就绕过去了。
 */
const CANVAS_KEY_PAT = /agent-flow\.canvases\.v\d|STORAGE_KEYS\.canvases/;

test('源码守卫：不存在绕过 serialize 直接写画布存档的路径', () => {
  const bad: string[] = [];
  for (const { rel, src } of walkSources()) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /*
     * engine/kv.ts 的 defaultKV 是通用 KV 后端 —— 它不认识具体 key，
     * 写什么是调用方决定的。它出现 setItem 不算"第二条写画布的路"。
     */
    if (rel === join('engine', 'kv.ts')) continue;
    for (const m of code.matchAll(/localStorage\s*\.\s*setItem\s*\(([^;]{0,200})/g)) {
      if (CANVAS_KEY_PAT.test(m[1])) bad.push(`${rel}: ${m[0].slice(0, 120)}`);
    }
  }
  assert.deepEqual(
    bad,
    [],
    '写画布存档只能走 saveToStorage（它内部走 serialize 脱敏） —— '
    + '直接 setItem 就是第二条路，迟早有一处忘了脱敏',
  );
});

/* serialize 必须自己调 redactSecrets，不能只靠调用方记得 */
test('源码守卫：serialize 默认脱敏（不依赖调用方自觉）', () => {
  const src = readFileSync(join(AF_SRC, 'engine', 'canvasStore.ts'), 'utf-8');
  const at = src.indexOf('export function serialize');
  assert.ok(at >= 0, '源码里要有 serialize');
  const body = src.slice(at, at + 400);
  assert.ok(
    /redactSecrets\s*\(/.test(body),
    'serialize 必须调 redactSecrets —— 默认脱敏，不该依赖调用方记得',
  );
});

/* canvasStore 不该知道存储后端 —— 认识了 localStorage 就绕不过去了 */
test('源码守卫：canvasStore 不直接碰 localStorage（存储后端是注入的）', () => {
  const src = readFileSync(join(AF_SRC, 'engine', 'canvasStore.ts'), 'utf-8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(
    /localStorage/.test(code),
    false,
    'canvasStore 的 get/set 是注入的 —— 直接碰 localStorage 就等于又开一条写路径',
  );
});

/* 行为上也钉一遍：走 saveToStorage 落盘的东西是脱过敏的 */
test('存画布：saveToStorage 落盘的内容不含明文密钥', () => {
  const written: Record<string, string> = {};
  const c = {
    ...makeCanvas('带密钥', { id: 'a' }),
    nodes: [llmNode('n1', 'sk-leak-plain')],
  };
  saveToStorage((k, v) => { written[k] = v; }, { canvases: [c as never], activeId: 'a' });

  const raw = written[STORAGE_KEYS.canvases] ?? '';
  assert.ok(raw.length > 0, '要真的写了画布');
  assert.equal(raw.includes('sk-leak-plain'), false, '落盘内容必须脱敏');
  /* 顺带确认 activeId 是单独一个 key，不是混在画布里 */
  assert.ok(written[STORAGE_KEYS.active] === 'a', 'activeId 单独存');
});

/* ==================================================================
 * 导出文件里**不许再带 triggers**
 *
 * 顶层 triggers 是"触发器曾独立存储"留下的冗余副本：
 *   · 与 nodes 里那份完全重复（同一张画布的触发器）
 *   · 导入侧根本不读它（importJson 只读 nodes）
 *
 * 冗余的代价是实的：同一份 webhook 校验令牌在两处，
 * nodes 那份走 redactNodes 被挖空，顶层这份是裸的 ——
 * 于是导出的文件里明文躺着令牌，而看 nodes 是空的，以为剥干净了。
 *
 * 而且它不是"这一次"的问题：留着就等于"将来 Trigger 再加字段，
 * 还得记得剥第二次"。所以删字段，而不是补一次脱敏。
 * ================================================================== */

test('守卫: 导出不带顶层 triggers（冗余副本会漏脱敏）', () => {
  const src = readFileSync(join(pluginRoot(), 'App.tsx'), 'utf8');
  const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const m = noComment.match(/const text = JSON\.stringify\(([\s\S]*?)\n\s*\);/);
  assert.ok(m, '没找到导出那句 JSON.stringify');
  assert.equal(
    /\btriggers\b/.test(m![1]),
    false,
    '导出不许带顶层 triggers —— 它与 nodes 冗余，且是漏脱敏的入口',
  );
});

/*
 * 比"不带 triggers"更通用的一层：
 * 导出的**每个字段**都必须经过脱敏（edges 是连线，无凭据，除外）。
 *
 * 只盯 triggers 的话，将来有人加一个新字段（比如把任务历史塞进去），
 * 测试照样全绿 —— 而那个字段是裸的。
 */
test('守卫: 导出对象里除 edges 外每个字段都过脱敏', () => {
  const src = readFileSync(join(pluginRoot(), 'App.tsx'), 'utf8');
  const noComment = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  /*
   * 必须截到**对象字面量内部**（\{ ... \}）——
   * 截到 `);` 的话会把 JSON.stringify 的第三四个参数（null, 2）
   * 也当成导出字段，于是守卫对着 'null' / '2' 报红：
   * 报红了，但报的是错的理由，人照着它改就会去动字段解析。
   */
  const m = noComment.match(/const text = JSON\.stringify\(\s*(\{[\s\S]*?\n\s*\})/);
  assert.ok(m, '没找到导出那句 JSON.stringify');

  const fields: { key: string; val: string }[] = [];
  for (const line of m![1].split('\n')) {
    const t = line.trim();
    if (!t || t === '{' || t === '}') continue;
    /* 简写：edges, */
    const short = t.match(/^(\w+)\s*,\s*$/);
    if (short) { fields.push({ key: short[1], val: '' }); continue; }
    /* 完整：key: value, —— 值可能跨行，这里取到行尾（当前写法都是单行） */
    const full = t.match(/^(\w+)\s*:\s*(.*?),?$/);
    if (full) fields.push({ key: full[1], val: full[2] });
  }

  assert.ok(fields.length >= 3, `至少要认出 nodes/edges/config，实际 ${fields.length}`);
  const bad = fields.filter(
    (f) => f.key !== 'edges' && !/redact|stripRuntime|stripSecrets/.test(f.val),
  );
  assert.deepEqual(
    bad.map((f) => f.key),
    [],
    '导出是"交给别人"的动作 —— 除 edges（连线无凭据）外每个字段都必须过脱敏',
  );
});
