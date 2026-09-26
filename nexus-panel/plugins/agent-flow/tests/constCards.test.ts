import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import type { Graph, GraphNode } from '../types';
import {
  constsOf, constItemKey, constItemLabel, makeConstNode, type ConstNodeData,
} from '../types';
import { outputsOf, OUT_DEFAULT, outKindOf, outLabelOf } from '../engine/paramLinks';
import { runGraph } from '../engine/runner';
import { argTypeIssues } from '../engine/argTypes';
import { validateNode } from '../engine/nodeValidate';
import { readSrc, AF_SRC } from './srcScan';

/**
 * 常量节点上的**多张卡**。
 *
 * 一个流程里往往要几个固定值（阈值 / 价格 / 开关），以前得摆三个常量节点，
 * 它们各自独立、连线互相看不见。现在一个节点放多张卡，每张卡各带一个
 * 输出端口 —— 于是"把阈值接到大于上、把价格接到写入上"从同一个节点拖出来。
 *
 * 本文件的重点是三件**失效时不报错**的事：
 *   · items 是唯一数据源（没有顶层 value / valueType 可退回）
 *   · 每张卡的端口必须取到**自己那张卡**的值
 *   · 写卡只写整份 items —— 不写点号路径、也不镜像顶层
 */

const N = (id: string, data: Record<string, unknown>): GraphNode =>
  ({ id, data: { kind: 'const', ...data } }) as unknown as GraphNode;

/* ------------------------------------------------------------------ */
/* 唯一数据源                                                          */
/* ------------------------------------------------------------------ */

/*
 * 老画布不管：items 之外没有第二份数据。
 *
 * 曾经"没有 items 就用顶层 value / valueType 合成一张"，代价是写卡必须
 * 双向镜像 —— 漏一处就是"卡片显示变了、跑出来还是旧的"，且不报错。
 */
test('items 之外没有第二份数据（不合成、不兜底）', () => {
  const d = { kind: 'const', valueType: 'num', value: '42' } as unknown as ConstNodeData;
  assert.deepEqual(constsOf(d), [], '顶层字段不再被读成一张卡');
  assert.deepEqual(constsOf({ kind: 'const' } as unknown as ConstNodeData), []);
});

test('新建的常量节点自带一张卡（空 items 的节点没有端口可连）', () => {
  const d = makeConstNode('c1').data as ConstNodeData;
  const list = constsOf(d);
  assert.equal(list.length, 1);
  assert.ok(list[0].id.length > 0, '卡要有 id —— 连线按 id 记');
});

test('卡没起名时也有名字可显示（输出端口不能是空白）', () => {
  const it = { id: 'a', valueType: 'num', value: '1' } as never;
  assert.ok(constItemLabel(it, 1).length > 0);
  assert.equal(constItemKey({ id: '' } as never, 3), 'c3', '没 id 时按下标兜底');
});

/* ------------------------------------------------------------------ */
/* 端口                                                                */
/* ------------------------------------------------------------------ */

test('每张卡一个输出端口，键是卡 id（改名不断线）', () => {
  const d = {
    kind: 'const',
    items: [
      { id: 'a', name: '阈值', valueType: 'num', value: '10' },
      { id: 'b', name: '价格', valueType: 'text', value: '9.9' },
    ],
  } as unknown as Record<string, unknown>;
  const keys = outputsOf('const', d).map((p) => p.key);
  assert.deepEqual(keys, [OUT_DEFAULT, 'a', 'b']);
  /* 主输出之外的每一行都要有名字，否则用户只能按顺序猜 */
  for (const p of outputsOf('const', d)) {
    if (p.key === OUT_DEFAULT) continue;
    assert.ok(outLabelOf('const', p.key, d).length > 0, `${p.key} 没有名字`);
  }
  /* 数字卡是 num、文本卡是 text —— 一律按文本会让数字卡接到大于上被误报 */
  assert.equal(outKindOf('const', 'a', d), 'num');
  assert.equal(outKindOf('const', 'b', d), 'text');
});

test('单卡常量也有具名端口（不因数量变化而消失）', () => {
  const d = {
    kind: 'const',
    items: [{ id: 'a', valueType: 'bool', value: 'true' }],
  } as unknown as Record<string, unknown>;
  assert.deepEqual(outputsOf('const', d).map((p) => p.key), [OUT_DEFAULT, 'a']);
  assert.equal(outKindOf('const', 'a', d), 'bool');
});

/* ------------------------------------------------------------------ */
/* 执行                                                                */
/* ------------------------------------------------------------------ */

test('多张卡各产出各的值，主输出是第一张', async () => {
  const g: Graph = {
    nodes: [
      N('c', {
        items: [
          { id: 'a', name: '阈值', valueType: 'num', value: '10' },
          { id: 'b', name: '开关', valueType: 'bool', value: 'yes' },
        ],
      }),
      N('t1', { kind: 'text', op: 'upper', a: '', b: '' }),
      N('t2', { kind: 'text', op: 'upper', a: '', b: '' }),
    ],
    edges: [
      { id: 'p1', source: 'c', target: 't1', data: { kind: 'param', sourceArg: 'a', targetArg: 'a' } },
      /* 用**卡名**取：模板引用用的就是这个名字 */
      { id: 'p2', source: 'c', target: 't2', data: { kind: 'param', sourceArg: 'b', targetArg: 'a' } },
    ] as unknown as Graph['edges'],
  };
  const r = await runGraph(g, { input: '', onEvent: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.outputs.c, '10', '主输出是第一张卡 —— 老画布的行为不变');
  assert.equal(r.outputs.t1, '10', '按卡 id 取到「阈值」');
  /*
   * 布尔卡要规范化：'yes' 得跑成 'true'。
   * 不规范化的话下游条件节点判成不成立，而卡片上明明写着「真」。
   */
  assert.equal(r.outputs.t2, 'TRUE');
});

test('一张卡的值就是主输出', async () => {
  const g: Graph = {
    nodes: [N('c', { items: [{ id: 'a', name: '标题', valueType: 'text', value: 'hello' }] })],
    edges: [],
  };
  const r = await runGraph(g, { input: '', onEvent: () => {} });
  assert.equal(r.outputs.c, 'hello');
});

test('一张卡都没有时输出空串（不是报错）', async () => {
  const g: Graph = { nodes: [N('c', { items: [] })], edges: [] };
  const r = await runGraph(g, { input: '', onEvent: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.outputs.c, '');
});

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

test('有卡空着时要提醒（只看第一张的话第二张的空值没人管）', () => {
  const d = {
    kind: 'const',
    items: [
      { id: 'a', name: '阈值', valueType: 'num', value: '10' },
      { id: 'b', name: '备注', valueType: 'text', value: '' },
    ],
  } as unknown as ConstNodeData;
  const v = validateNode({ data: d });
  assert.notEqual(v.level, 'ok', '第二张卡空着要报出来');
  assert.match((v.messages ?? []).join(' '), /备注/, '要说清是**哪一张**卡空着');
});

test('错参指名到卡，而不是笼统的「值」', () => {
  const issues = argTypeIssues('const', {
    kind: 'const',
    items: [{ id: 'a', name: '阈值', valueType: 'num', value: 'abc' }],
  } as unknown as Record<string, unknown>);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, 'a');
  assert.match(issues[0].message, /阈值/);
});

/* ------------------------------------------------------------------ */
/* 源码守卫：整份写 + 镜像                                             */
/* ------------------------------------------------------------------ */

/**
 * 写卡必须**整份写** items，且不往顶层镜像。
 *
 * 点号路径（items.0.value）在 items 不存在时会建出一个没有 id 的对象，
 * 卡片拿不到稳定 key、连线跟着漂。
 *
 * 反向那条同样要盯：镜像回顶层 value / valueType 的代码一旦回来，
 * 数据就又有两份 —— 而两份数据里"漏镜像一处"是不报错的。
 */
test('卡片与面板写卡时只整份写 items（不镜像顶层）', () => {
  if (!AF_SRC) return;
  for (const f of ['components/ToolNode.tsx', 'components/inspectors/ConstInspector.tsx']) {
    const src = readSrc(f);
    assert.match(src, /items:\s*next/, `${f} 没有整份写 items —— 点号路径会造出缺 id 的对象`);
    assert.doesNotMatch(src, /valueType:\s*next\[0\]/, `${f} 又把第一张卡镜像回顶层 valueType 了`);
    assert.doesNotMatch(src, /value:\s*next\[0\]/, `${f} 又把第一张卡镜像回顶层 value 了`);
  }
  /* 数据层也不能再合成 —— 有兜底就意味着顶层字段还在被读 */
  const t = readSrc('types.ts');
  assert.doesNotMatch(
    t.slice(t.indexOf('export function constsOf')),
    /d\.value/,
    'constsOf 又去读顶层 value 了 —— 数据变成两份',
  );
});

test('常量卡片的就地编辑走 apply（不能走单字段点分路径）', () => {
  if (!AF_SRC) return;
  const src = readSrc('components/ToolNode.tsx');
  const body = src.slice(src.indexOf('export function ConstNode'));
  assert.match(body, /apply:/, '卡片编辑没用 apply —— 单字段写入会绕过整份写');
  /*
   * 两处都要认：下拉（改种类）与输入框（改值）。
   * 只认一处的话，另一种控件会退回单字段写入 —— 表现为
   * "卡片显示变了、跑出来还是旧的"，且不报错。
   */
  const ac = readSrc('components/ArgCell.tsx');
  const hits = ac.match(/edit\.apply \? edit\.apply\(/g) ?? [];
  assert.ok(hits.length >= 2, `ArgCell 只有 ${hits.length} 处认 apply（下拉与输入框都要认）`);
});

test('执行器按卡写两份字段：id 给连线、名字给模板', () => {
  if (!AF_SRC) return;
  /*
   * 只写 id 的话 {{节点id.卡名}} 读不到值；只写名字的话改名会断线。
   * 两种缺失都不报错 —— 前者表现为模板输出空串，后者表现为改名后连线失效。
   */
  const src = readSrc('engine/runners/const.ts');
  assert.match(src, /constItemKey\(/, '执行器没按卡 id 写字段 —— 连线取不到值');
  assert.match(src, /fields\[nm\]/, '执行器没按卡名写字段 —— {{节点.卡名}} 读不到值');
});

test('卡片上的端口要按 data 现算（常量卡会增删）', () => {
  if (!AF_SRC) return;
  /*
   * 只传 kind 的话 outputsOf 拿不到 items，端口永远是 [out] ——
   * 输出卡片上不出现那些口子，用户"每张卡都能连出去"就成了空话，
   * 而静态表本身没变，读代码看不出来。
   */
  const src = readSrc('components/NodeShell.tsx');
  assert.match(src, /outputsOf\(kind,\s*data\)/, 'NodeShell 没把 data 传给 outputsOf');
  const pl = readSrc('engine/paramLinks.ts');
  assert.match(pl, /if \(dataKind === 'const'\)/, 'outputsOf 不认 const —— 常量没有具名端口');
});

test('const 契约标了 manualParams（参数说明手写，AI 才知道有 items）', () => {
  if (!AF_SRC) return;
  const spec = readSrc(path.join('engine', 'nodeSpec.ts'));
  const seg = spec.slice(spec.indexOf("const: S('text'"));
  assert.match(seg.slice(0, 600), /manualParams/, 'const 没标 manualParams');
  assert.match(seg.slice(0, 600), /key: 'items'/, '参数说明里没有 items —— AI 加不出第二张卡');
});
