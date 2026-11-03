import test from 'node:test';
import assert from 'node:assert/strict';
import { exportFlow } from '../engine/scriptExport';
import { readSrc, AF_SRC } from './srcScan';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * scriptExport.ts 的「同一件事多份实现」守卫。
 *
 * 这个文件有 1580 行，四种导出格式各自成段。以前：
 *   · 拓扑展平 + cyclic 记 skipped 的骨架，toShell / toPython /
 *     toMarkdown 各抄一份（连说明注释也抄了三份），flatOrder 又自己
 *     调了一次 topoLayers —— 一共四处，且注释写着「同一口径」而
 *     实际一个把 cyclic 加进顺序、一个不加。
 *   · 取节点种类有 11 处、三种写法，其中两种回退到类型里根本不存在的
 *     type 字段（GraphNode 只有 { id, data }）。今天都退化成空串所以
 *     看不出差别，一旦 data 里加了 type 就会一边认出节点、一边写 TODO。
 *   · 并发 / 停止节点的提示文案在 shell 和 python 逐字相同，各写一份。
 *
 * 收成 kindOf / flattenGraph / 两个常量之后，本文件钉住「不许再分叉」。
 * 守卫读的是剥注释后的源码 —— 注释里引用旧写法是历史说明，不算数。
 */

const REL = 'engine/scriptExport.ts';

const n = (id: string, kind: string, data: Record<string, unknown> = {}) => ({
  id,
  type: kind,
  data: { kind, label: id, status: 'idle', output: '', error: '', ...data },
});
const g = (nodes: unknown[], edges: unknown[] = []) => ({ nodes, edges }) as never;

test('（前置）AF_SRC 指向插件根、源码读得到', () => {
  assert.ok(fs.existsSync(path.join(AF_SRC, REL)), '读不到 scriptExport.ts');
  assert.match(readSrc(REL), /function flattenGraph/, '守卫会读空、集体假通过');
});

/* ---------------- 源码守卫 ---------------- */

test('拓扑计算只有一处，四种格式都走公共骨架', () => {
  const src = readSrc(REL);
  assert.equal(
    (src.match(/topoLayers\(g, paramLinksOf\(g\.edges\)\)/g) ?? []).length,
    1,
    '又出现第二份拓扑计算 —— flatOrder 曾经自己调一次、注释却说「同一口径」',
  );
  assert.ok(
    (src.match(/flattenGraph\(g\)/g) ?? []).length >= 4,
    '调用点了：toShell / toPython / toMarkdown 的解构 + flatOrder',
  );
  assert.match(src, /\.\.\.cyclic/,
    'flatOrder 必须显式把环里节点加回来（分支初始化漏一个就是 UnboundLocalError）');
});

test('节点种类只认一个入口，不许再加任何回退', () => {
  const src = readSrc(REL);
  assert.equal((src.match(/d\.kind\s*\?\?/g) ?? []).length, 0,
    '又出现 d.kind ?? ... 的回退：GraphNode / NodeData 里都没有 type，那是死回退');
  assert.equal((src.match(/\(n as \{ type\?: string \}\)\.type/g) ?? []).length, 0,
    '又出现顶层 type 的硬断言 —— 那个字段在 GraphNode 上不存在');
  assert.ok((src.match(/kindOf\(n\)/g) ?? []).length >= 11,
    '11 处取种类的地方都要走 kindOf，少一处就是两种口径');
});

test('并发 / 停止的提示收成常量，不许两份文案各改各的', () => {
  const src = readSrc(REL);
  assert.equal((src.match(/画布上的并发度上限在脚本里没有对应物/g) ?? []).length, 1);
  assert.equal((src.match(/停止节点在脚本里不终止流程/g) ?? []).length, 1);
  assert.equal((src.match(/reason: SKIP_PARALLEL,/g) ?? []).length, 2);
  assert.equal((src.match(/reason: SKIP_STOP,/g) ?? []).length, 2);
});

/* ---------------- 行为：三种格式口径一致 ---------------- */

test('成环节点在三种格式里都记进 skipped、不静默丢掉', () => {
  const graph = g(
    [n('a', 'log'), n('b', 'log')],
    [
      { id: 'e1', source: 'a', target: 'b' },
      { id: 'e2', source: 'b', target: 'a' },
    ],
  );
  const reasons: string[][] = [];
  for (const f of ['shell', 'python', 'markdown'] as const) {
    const r = exportFlow(graph, f);
    const cyc = r.skipped.filter((x) => x.reason.includes('环里'));
    assert.ok(cyc.length > 0, `${f}：环里节点一个都没报，用户会拿到少节点的脚本`);
    reasons.push(cyc.map((x) => x.reason));
  }
  assert.deepEqual(reasons[0], reasons[1], 'shell 与 python 的成环提示不一致');
  assert.deepEqual(reasons[1], reasons[2], 'python 与 markdown 的成环提示不一致');
  for (const r of reasons) {
    for (const why of r) assert.equal(why, '这个节点处在环里，排不进执行顺序');
  }
});

test('并发与停止节点的提示在 shell / python 逐字一致', () => {
  const graph = g([n('p', 'parallel'), n('s', 'stop')]);
  /*
   * 每个节点其实会报两条：一条是这里的流程提示，另一条是
   * 「这类节点没有对应的 shell/python 写法」（格式特有、本就该不同）。
   * 只筛共用的那两条来比 —— 混在一起比会把"本来就该不同"判成分叉。
   */
  const common = (f: 'shell' | 'python') => exportFlow(graph, f).skipped.filter(
    (x) => x.reason.includes('并发在脚本里是顺序执行')
      || x.reason.includes('停止节点在脚本里不终止流程'),
  );
  const sh = common('shell');
  const py = common('python');
  assert.equal(sh.length, 2, '两个节点都该各自报一条流程提示');
  assert.deepEqual(sh, py, '两份文案分叉了 —— 各写一份必然各改各的');
});

/**
 * 防过度修复 / 防回退复活：故意给一个「顶层有 type、data 里没有 kind」的节点。
 *
 * 如果有人把 kindOf 改成回退到 n.type，shell 会认出 log 生成 echo、
 * markdown 会写「记录一条日志」—— 而这个节点的种类**并没有声明**。
 * 两种回退当年都是死代码，复活它就是重新引入两种口径。
 */
test('没声明 data.kind 的节点，三种格式都不认成任何种类', () => {
  const odd = {
    id: 'x',
    type: 'log',
    data: { label: 'x', status: 'idle', output: '', error: '', text: 'hi' },
  };
  const graph = g([odd]);
  const md = exportFlow(graph, 'markdown').text;
  const sh = exportFlow(graph, 'shell').text;
  assert.ok(!md.includes('记录一条日志'), 'markdown 把顶层 type 当成了种类');
  assert.ok(!md.includes('`log`'), 'markdown 标题里不该冒出 kind');
  assert.match(sh, /# TODO 未翻译：x/, 'shell 不该认出这是 log 节点');
});
