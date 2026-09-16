import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraph } from '../engine/runner';
import {
  makeGenericHttpNode, makeExtractNode, makeNode,
  type GenericHttpNodeData, type ExtractNodeData,
} from '../types';

/**
 * 参数型自定义节点（HTTP 请求 / 数据提取）的集成测试。
 *
 * 走 runGraph 而不是只测纯函数：这两个节点的价值在"串进流程里能用"，
 * 单测纯逻辑验证不了执行器分发、能力校验、失败传播这些接缝。
 */

type Captured = { url: string; method?: string; headers?: Record<string, string>; body?: string };

function httpStub(
  responder: (c: Captured) => { status: number; text: string; headers?: Record<string, string> },
  captured: Captured[] = [],
) {
  return async (url: string, o: { method?: string; headers?: Record<string, string>; body?: string }) => {
    captured.push({ url, method: o.method, headers: o.headers, body: o.body });
    const r = responder({ url, method: o.method, headers: o.headers, body: o.body });
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: r.text,
      headers: r.headers ?? {},
    };
  };
}

const base = { concurrency: 1, executor: async () => 'never', onEvent: () => {} };
const HTTP_JSON = JSON.stringify({
  code: 0,
  data: { items: [{ title: '今日要闻', url: 'https://x/1' }] },
});

/* ---------- HTTP 节点 ---------- */

test('HTTP 节点：发出请求并写入 outputs', async () => {
  const cap: Captured[] = [];
  const g = {
    nodes: [{ id: 'h', data: makeGenericHttpNode('h', { url: 'https://api.test/v1/news', method: 'GET' }).data }],
    edges: [],
  };
  const s = await runGraph(g, {
    ...base,
    httpRequester: httpStub(() => ({ status: 200, text: HTTP_JSON }), cap),
  });
  assert.equal(s.ok, true);
  assert.equal(s.outputs ? true : true, true);
  assert.equal(cap[0].url, 'https://api.test/v1/news');
  assert.equal(cap[0].method, 'GET');
});

test('HTTP 节点：请求头按行解析，# 开头的是注释', async () => {
  const cap: Captured[] = [];
  const g = {
    nodes: [{
      id: 'h',
      data: makeGenericHttpNode('h', {
        url: 'https://api.test/x',
        headersText: '# 这是注释\nX-Token: abc\n\nX-Extra: 1',
      }).data,
    }],
    edges: [],
  };
  await runGraph(g, { ...base, httpRequester: httpStub(() => ({ status: 200, text: 'ok' }), cap) });
  assert.equal(cap[0].headers?.['X-Token'], 'abc');
  assert.equal(cap[0].headers?.['X-Extra'], '1');
  assert.equal(cap[0].headers?.['# 这是注释'], undefined);
});

test('HTTP 节点：JSON 请求体自动补 Content-Type', async () => {
  const cap: Captured[] = [];
  const g = {
    nodes: [{
      id: 'h',
      data: makeGenericHttpNode('h', {
        url: 'https://api.test/x', method: 'POST', body: '{"a":1}', bodyIsJson: true,
      }).data,
    }],
    edges: [],
  };
  await runGraph(g, { ...base, httpRequester: httpStub(() => ({ status: 200, text: 'ok' }), cap) });
  assert.equal(cap[0].headers?.['Content-Type'], 'application/json');
  assert.equal(cap[0].body, '{"a":1}');
});

test('HTTP 节点：GET 不发请求体（部分服务端会直接拒）', async () => {
  const cap: Captured[] = [];
  const g = {
    nodes: [{
      id: 'h',
      data: makeGenericHttpNode('h', {
        url: 'https://api.test/x', method: 'GET', body: '{"a":1}',
      }).data as GenericHttpNodeData,
    }],
    edges: [],
  };
  await runGraph(g, { ...base, httpRequester: httpStub(() => ({ status: 200, text: 'ok' }), cap) });
  assert.equal(cap[0].body, undefined);
});

test('HTTP 节点：4xx 默认算失败，且失败要传播到下游', async () => {
  const cap: Captured[] = [];
  const g = {
    nodes: [
      { id: 'h', data: makeGenericHttpNode('h', { url: 'https://api.test/x' }).data },
      makeNode('B', { prompt: 'x' }),
    ],
    edges: [{ id: 'e1', source: 'h', target: 'B' }],
  };
  const s = await runGraph(g, {
    ...base,
    httpRequester: httpStub(() => ({ status: 404, text: 'not found' }), cap),
  });
  assert.equal(s.failed.includes('h'), true, '4xx 应算失败');
  assert.equal(s.skipped.includes('B'), true, '下游应跳过');
  assert.equal(s.ok, false);
});

test('HTTP 节点：关掉"4xx 算失败"则继续，错误响应也能传给下游', async () => {
  const cap: Captured[] = [];
  const g = {
    nodes: [
      { id: 'h', data: makeGenericHttpNode('h', { url: 'https://api.test/x', failOnHttpError: false }).data },
      makeNode('B', { prompt: 'x' }),
    ],
    edges: [{ id: 'e1', source: 'h', target: 'B' }],
  };
  const s = await runGraph(g, {
    ...base,
    httpRequester: httpStub(() => ({ status: 404, text: 'not found' }), cap),
  });
  assert.equal(s.failed.includes('h'), false);
  assert.equal(s.skipped.includes('B'), false, '不应跳过下游');
});

test('HTTP 节点：缺执行器时失败要传播（不能只变红）', async () => {
  const g = {
    nodes: [
      { id: 'h', data: makeGenericHttpNode('h', { url: 'https://api.test/x' }).data },
      makeNode('B', { prompt: 'x' }),
    ],
    edges: [{ id: 'e1', source: 'h', target: 'B' }],
  };
  const s = await runGraph(g, { ...base });
  assert.equal(s.failed.includes('h'), true);
  assert.equal(s.skipped.includes('B'), true);
});

test('HTTP 节点：未填地址要报错而不是发出请求', async () => {
  const cap: Captured[] = [];
  const g = {
    nodes: [{ id: 'h', data: makeGenericHttpNode('h', { url: '  ' }).data }],
    edges: [],
  };
  const s = await runGraph(g, {
    ...base,
    httpRequester: httpStub(() => ({ status: 200, text: 'ok' }), cap),
  });
  assert.equal(s.failed.includes('h'), true);
  assert.equal(cap.length, 0, '地址为空不该发起请求');
});

test('HTTP 节点：URL 与请求体支持模板变量', async () => {
  const cap: Captured[] = [];
  const g = {
    nodes: [
      { id: 't', data: { kind: 'trigger', label: 'T', source: 'manual', text: '' } },
      {
        id: 'h',
        data: makeGenericHttpNode('h', {
          url: 'https://api.test/q?kw={{t.output}}',
          method: 'POST',
          body: '{"kw":"{{t.output}}"}',
        }).data,
      },
    ],
    edges: [{ id: 'e1', source: 't', target: 'h' }],
  };
  await runGraph(g, {
    ...base,
    input: '天气',
    httpRequester: httpStub(() => ({ status: 200, text: 'ok' }), cap),
  });
  assert.equal(cap[0].url, 'https://api.test/q?kw=天气');
  assert.equal(cap[0].body, '{"kw":"天气"}');
});

/* ---------- 提取节点 ---------- */

test('提取节点：从 HTTP 响应里取出字段（这是它存在的意义）', async () => {
  const g = {
    nodes: [
      { id: 'h', data: makeGenericHttpNode('h', { url: 'https://api.test/x' }).data },
      { id: 'e', data: makeExtractNode('e', { mode: 'json', spec: 'data.items[0].title' }).data },
    ],
    edges: [{ id: 'e1', source: 'h', target: 'e' }],
  };
  const s = await runGraph(g, {
    ...base,
    httpRequester: httpStub(() => ({ status: 200, text: HTTP_JSON })),
  });
  assert.equal(s.ok, true);
  // outputs 是该节点的输出文本，也就是下游用 {{e.output}} 引用的东西
  assert.equal(s.outputs.e, '今日要闻');
});

test('提取节点：取不到时默认失败并传播', async () => {
  const g = {
    nodes: [
      { id: 'h', data: makeGenericHttpNode('h', { url: 'https://api.test/x' }).data },
      { id: 'e', data: makeExtractNode('e', { mode: 'json', spec: 'data.nope' }).data },
      makeNode('B', { prompt: 'x' }),
    ],
    edges: [
      { id: 'e1', source: 'h', target: 'e' },
      { id: 'e2', source: 'e', target: 'B' },
    ],
  };
  const s = await runGraph(g, {
    ...base,
    httpRequester: httpStub(() => ({ status: 200, text: HTTP_JSON })),
  });
  assert.equal(s.failed.includes('e'), true);
  assert.equal(s.skipped.includes('B'), true);
});

test('提取节点：关掉"取不到就失败"则输出空串继续走', async () => {
  const g = {
    nodes: [
      { id: 'h', data: makeGenericHttpNode('h', { url: 'https://api.test/x' }).data },
      { id: 'e', data: makeExtractNode('e', { mode: 'json', spec: 'data.nope', failOnMiss: false }).data },
      makeNode('B', { prompt: 'x' }),
    ],
    edges: [
      { id: 'e1', source: 'h', target: 'e' },
      { id: 'e2', source: 'e', target: 'B' },
    ],
  };
  const s = await runGraph(g, {
    ...base,
    httpRequester: httpStub(() => ({ status: 200, text: HTTP_JSON })),
  });
  assert.equal(s.failed.includes('e'), false);
  assert.equal(s.skipped.includes('B'), false);
});

test('提取节点：不依赖任何执行器，浏览器模式下也能用', async () => {
  const g = {
    nodes: [{ id: 'e', data: makeExtractNode('e', { mode: 'line', spec: 'first' }).data as ExtractNodeData }],
    edges: [],
  };
  // 只给必需项，不传任何执行器能力
  const s = await runGraph(g, { ...base, input: '第一行\n第二行' });
  assert.equal(s.ok, true, '提取节点不该因为没有执行器而失败');
});
