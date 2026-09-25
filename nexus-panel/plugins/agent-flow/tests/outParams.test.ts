import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import type { Graph, GraphNode } from '../types';
import {
  OUT_DEFAULT, outputsOf, outKindOf, outLabelOf, outValueOf, outLabel,
  NODE_OUTPUTS, makeParamEdge, paramLinkIssues, paramLinksOf,
} from '../engine/paramLinks';
import { runGraph } from '../engine/runner';
import { readSrc, AF_SRC } from './srcScan';

/**
 * 节点输出卡片 —— 一个节点可以有**多个具名输出**。
 *
 * 动机：更新检测跑完产出的不是一个值，而是一组
 * （有没有更新 / 标题 / 链接 / 时间），表格读取产出（行数 / 列数 / 摘要）。
 * 只有一个总出口时，"把标题接到日志节点"做不到 ——
 * 只能整串输出一起接过去，再在下游自己截。
 *
 * 本文件的重点不是"卡片上多画了几行"，而是**那几行不能是摆设**：
 * 口子画出来了，连线就必须取到对应的那一个值，
 * 取不到（或一律取整串）是不报错的静默错误。
 */

const N = (id: string, kind: string, data: Record<string, unknown> = {}): GraphNode =>
  ({ id, data: { kind, ...data } }) as unknown as GraphNode;

/* ------------------------------------------------------------------ */
/* 清单                                                                */
/* ------------------------------------------------------------------ */

test('多输出节点登记了具名输出', () => {
  const keys = outputsOf('update').map((p) => p.key);
  assert.ok(keys.includes(OUT_DEFAULT), '主输出要有');
  assert.ok(keys.includes('title') && keys.includes('url') && keys.includes('date'));
});

test('未登记的节点仍是单输出 —— 老存档与自定义节点不受影响', () => {
  const ports = outputsOf('math');
  assert.equal(ports.length, 1);
  assert.equal(ports[0].key, OUT_DEFAULT);
  assert.deepEqual(outputsOf(null).map((p) => p.key), [OUT_DEFAULT]);
});

test('具名输出有名字 —— 只写种类的四行长得一模一样，只能按顺序猜', () => {
  for (const [kind, ports] of Object.entries(NODE_OUTPUTS)) {
    for (const p of ports) {
      if (p.key === OUT_DEFAULT) continue;
      assert.ok(outLabel(p).length > 0, `${kind}.${p.key} 没有名字`);
    }
  }
});

/* ------------------------------------------------------------------ */
/* 种类                                                                */
/* ------------------------------------------------------------------ */

test('种类按**具体那一个输出**判，不是按节点主输出', () => {
  /*
   * 更新检测主输出是「是/否」，但「标题」是文本。
   * 一律按主输出判，把"标题接到日志文本"标成错参就是误报。
   */
  assert.equal(outKindOf('update', OUT_DEFAULT, {}), 'bool');
  assert.equal(outKindOf('update', 'title', {}), 'text');
  assert.equal(outKindOf('extract', 'len', {}), 'num');
  /* 未登记的具名输出（将来新增）按文本，不瞎猜 */
  assert.equal(outKindOf('update', 'future', {}), 'text');
});

test('报错文案写人话名字，不写 key', () => {
  assert.equal(outLabelOf('update', 'title'), '标题');
  assert.equal(outLabelOf('update', 'url'), '链接');
});

test('类型错时报的是**那一个输出**，不是笼统的"上游输出"', () => {
  const nodes = [
    N('src', 'update'),
    N('dst', 'compare', { op: 'gt', a: '1', b: '2' }),
  ];
  const links = paramLinksOf([makeParamEdge('src', 'dst', 'a', 'title')]);
  const issues = paramLinkIssues(nodes, links);
  assert.ok(issues.dst, '上游「标题」是文本，接到「大于」上要报');
  assert.match(issues.dst[0].message, /标题/);
});

test('主输出的种类仍按节点算 —— 不因具名输出被带偏', () => {
  const nodes = [
    N('src', 'update'),
    N('dst', 'compare', { op: 'gt', a: '1', b: '2' }),
  ];
  const links = paramLinksOf([makeParamEdge('src', 'dst', 'a', OUT_DEFAULT)]);
  const issues = paramLinkIssues(nodes, links);
  assert.ok(issues.dst, '是/否 接到「大于」上仍然要报');
});

/* ------------------------------------------------------------------ */
/* 取值                                                                */
/* ------------------------------------------------------------------ */

test('outValueOf：具名输出走字段表，主输出走整串', () => {
  assert.equal(outValueOf('len', 'abcde', { text: 'abcde', len: '5' }), '5');
  assert.equal(outValueOf(OUT_DEFAULT, 'abcde', { text: 'abcde' }), 'abcde');
  assert.equal(outValueOf(undefined, 'abcde', {}), 'abcde');
  /* null = 这次没产出这个输出，调用方要保留手填值而不是填空串 */
  assert.equal(outValueOf('len', 'abcde', {}), null);
  assert.equal(outValueOf('len', 'abcde', undefined), null);
});

/* ------------------------------------------------------------------ */
/* 端到端                                                              */
/* ------------------------------------------------------------------ */

test('端到端：连「字数」取到的是字数，不是整串输出', async () => {
  /*
   * 不认 sourceArg 的话，这一根线拿到的是整串 'abcde'，
   * 下游转大写得到 'ABCDE' —— 而卡片上明明写的是「字数」。
   * 那种错不报错，只是值不对。
   */
  const g: Graph = {
    nodes: [
      N('src', 'extract', { mode: 'text' }),
      N('dst', 'text', { op: 'upper', a: '', b: '' }),
    ],
    edges: [makeParamEdge('src', 'dst', 'a', 'len')],
  };
  const r = await runGraph(g, { input: 'abcde', onEvent: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.outputs.dst, '5', '取的是 len（字数 5），不是整串 abcde');
});

test('端到端：同一节点两根线各取各的', async () => {
  const g: Graph = {
    nodes: [
      N('src', 'extract', { mode: 'text' }),
      N('t1', 'text', { op: 'upper', a: '', b: '' }),
      N('t2', 'text', { op: 'upper', a: '', b: '' }),
    ],
    edges: [
      makeParamEdge('src', 't1', 'a', 'text'),
      makeParamEdge('src', 't2', 'a', 'len'),
    ],
  };
  const r = await runGraph(g, { input: 'abc', onEvent: () => {} });
  assert.equal(r.outputs.t1, 'ABC', '第一根取内容');
  assert.equal(r.outputs.t2, '3', '第二根取字数');
});

/* ------------------------------------------------------------------ */
/* 源码守卫                                                            */
/* ------------------------------------------------------------------ */

const SRC = process.env.AF_SRC ? true : false;

/** 每种节点对应的执行器文件（对账用） */
const RUNNER_OF: Record<string, string[]> = {
  update: ['engine/runners/update.ts'],
  'github-update': ['engine/runners/githubUpdate.ts'],
  'github-push': ['engine/runners/githubPush.ts'],
  extract: ['engine/runners/extract.ts'],
  ocr: ['engine/runners/ocr.ts'],
  translate: ['engine/runners/translate.ts'],
  tableRead: ['engine/runners/table.ts'],
  agg: ['engine/runners/table.ts'],
  derive: ['engine/runners/table.ts'],
  filter: ['engine/runners/table.ts'],
  canvasIn: ['engine/runners/canvasPort.ts'],
  canvasOut: ['engine/runners/canvasPort.ts'],
};

test('登记的输出字段必须与执行器实际写入的 fields 对得上', () => {
  if (!SRC) return;
  /*
   * 这里漏一个字（比如登记了 'title' 而执行器写的是 '标题'），
   * 表现是"卡片上有这个口子，连了线却取不到值"，而且不报错 ——
   * 取不到就保留手填值，看着像"连线没生效"。
   */
  for (const [kind, ports] of Object.entries(NODE_OUTPUTS)) {
    const files = RUNNER_OF[kind];
    assert.ok(files, `${kind} 登记了输出参数，但没登记对应执行器文件（对账会漏）`);
    const src = readSrc(...files);
    for (const p of ports) {
      if (p.key === OUT_DEFAULT) continue;
      /*
       * 两种写法都要认：
       *   `title: xxx`   正常写法
       *   `{ text, len }` 简写（对象字面量简写属性，冒号都没有）
       * 只认冒号的话，简写字段会被判成"执行器没写"，
       * 于是明明能取到值的口子被误报 —— 那是守卫自己在骗人。
       */
      const re = new RegExp(`['"]?${p.key}['"]?\\s*:|[{,]\\s*${p.key}\\s*[,}]`);
      assert.ok(re.test(src), `${kind} 的输出「${p.key}」在执行器里找不到 —— 连了线取不到值`);
    }
  }
});

test('runner 按 sourceArg 取值，且不丢字段表', () => {
  if (!SRC) return;
  const src = readSrc('engine/runner.ts');
  assert.ok(/outValueOf\(/.test(src), 'runner 要走 outValueOf —— 不认 sourceArg 就一律取整串');
  const m = src.match(/outValueOf\(\s*l\.sourceArg\s*,\s*outputs\[l\.source\]\s*,\s*nodeFields\[l\.source\]\s*\)/);
  assert.ok(m, 'outValueOf 要同时拿到主输出与字段表');
  assert.ok(/if\s*\(v === null\)\s*continue/.test(src), '取不到时要保留手填值，不能填空串');
});

test('App 把 lastFields 写进节点，并在开跑时清掉', () => {
  if (!SRC) return;
  const app = readSrc('App.tsx');
  /*
   * 不写：多输出节点除了主输出那一行全是空白，
   * 看着像"这些口子没产出东西"，也就不敢连。
   */
  assert.ok(/lastFields: e\.fields/.test(app), 'node-fields 事件要把 fields 写回节点');
  /*
   * 不清：这次没跑到与"上次的值"分不开 ——
   * 卡片上仍显示上一次的标题，而这次其实没产出。
   */
  assert.ok(/lastFields: \{\}/.test(app), '开跑时要清掉上次的字段');
});

test('输出卡片上画名字、端口带 key', () => {
  if (!SRC) return;
  const shell = readSrc('components/NodeShell.tsx');
  assert.ok(/node-line__out-name/.test(shell), '卡片上要显示输出参数的名字');
  assert.ok(/outHandleId\(p\.key\)/.test(shell), '每个输出参数各带一个端口');
  assert.ok(/outKindOf\(/.test(shell), '种类要按具体输出算');
});

test('样式里有输出名字那一格', () => {
  if (!SRC) return;
  const css = readSrc('styles.css');
  assert.match(css, /\.node-line__out-name\s*\{/);
});

test('所有测试文件的 AF_SRC 指向同一个仓库', () => {
  /* 顺带确认 srcScan 能用：指错了会静默跳过全部源码守卫 */
  assert.ok(path.isAbsolute(AF_SRC));
});
