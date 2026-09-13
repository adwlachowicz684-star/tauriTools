import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeTask, applyEvent, finishTask, cancelTask, progressOf, elapsedOf,
  formatDuration, formatClock, clampOutput,
  STATUS_LABEL, NODE_STATUS_LABEL, SOURCE_LABEL,
  MAX_OUTPUT_CHARS, type TaskRecord,
} from '../engine/tasks';

const T0 = 1700000000000;
const mk = () => makeTask({ canvasId: 'c1', canvasName: '我的流程', source: 'manual', total: 3, now: T0 });

/* ---------- 建任务 ---------- */

test('建任务: 初始为运行中', () => {
  const t = mk();
  assert.equal(t.status, 'running');
  assert.equal(t.startedAt, T0);
  assert.equal(t.endedAt, undefined);
  assert.deepEqual(t.order, []);
});

test('建任务: 画布名与来源被记录', () => {
  const t = mk();
  assert.equal(t.canvasName, '我的流程');
  assert.equal(t.source, 'manual');
});

test('建任务: id 不重复', () => {
  assert.notEqual(makeTask({ canvasId: 'c', canvasName: 'n' }).id,
                  makeTask({ canvasId: 'c', canvasName: 'n' }).id);
});

/* ---------- 节点状态流转 ---------- */

test('node-start: 节点进入运行态并记录开始时间', () => {
  const t = applyEvent(mk(), { type: 'node-start', id: 'a', rendered: '写个脚本' });
  assert.equal(t.nodes.a.status, 'running');
  assert.equal(t.nodes.a.rendered, '写个脚本');
});

test('node-start: 节点按出现顺序进 order（列表不跳）', () => {
  let t = mk();
  t = applyEvent(t, { type: 'node-start', id: 'a', rendered: '' });
  t = applyEvent(t, { type: 'node-start', id: 'b', rendered: '' });
  assert.deepEqual(t.order, ['a', 'b']);
});

test('node-chunk: 追加而非覆盖（这是实时输出的关键）', () => {
  let t = mk();
  t = applyEvent(t, { type: 'node-start', id: 'a', rendered: '' });
  t = applyEvent(t, { type: 'node-chunk', id: 'a', chunk: '你好' });
  t = applyEvent(t, { type: 'node-chunk', id: 'a', chunk: '，世界' });
  assert.equal(t.nodes.a.output, '你好，世界');
});

test('node-chunk: 未 start 过的节点也能累积（不丢开头）', () => {
  const t = applyEvent(mk(), { type: 'node-chunk', id: 'x', chunk: 'abc' });
  assert.equal(t.nodes.x.output, 'abc');
});

test('node-done: 成功时标记 success 并记录结束时间', () => {
  let t = mk();
  t = applyEvent(t, { type: 'node-start', id: 'a', rendered: '' });
  t = applyEvent(t, { type: 'node-done', id: 'a', ok: true, output: '结果' });
  assert.equal(t.nodes.a.status, 'success');
  assert.ok(t.nodes.a.endedAt);
  assert.equal(t.nodes.a.output, '结果');
});

test('node-done: 失败时记录 error', () => {
  const t = applyEvent(mk(), { type: 'node-done', id: 'a', ok: false, output: '', error: '超时' });
  assert.equal(t.nodes.a.status, 'failed');
  assert.equal(t.nodes.a.error, '超时');
});

test('node-done: output 为空时保留已累积的流式内容', () => {
  let t = mk();
  t = applyEvent(t, { type: 'node-chunk', id: 'a', chunk: '流式内容' });
  t = applyEvent(t, { type: 'node-done', id: 'a', ok: true, output: '' });
  assert.equal(t.nodes.a.output, '流式内容');
});

test('node-status: skipped 被记录', () => {
  const t = applyEvent(mk(), { type: 'node-status', id: 'a', status: 'skipped' });
  assert.equal(t.nodes.a.status, 'skipped');
});

/* ---------- 输出截断 ---------- */

test('截断: 超过上限时保留尾部并加提示', () => {
  const long = 'x'.repeat(MAX_OUTPUT_CHARS + 100);
  const r = clampOutput(long);
  assert.ok(r.length < long.length);
  assert.ok(r.indexOf('已截断') >= 0);
  assert.ok(r.endsWith('x'.repeat(100)));
});

test('截断: 恰好等于上限时不处理', () => {
  const s = 'y'.repeat(MAX_OUTPUT_CHARS);
  assert.equal(clampOutput(s), s);
});

test('截断: 大量 chunk 累积后被限长（不会无限膨胀）', () => {
  let t = mk();
  for (let i = 0; i < 3000; i += 1) {
    t = applyEvent(t, { type: 'node-chunk', id: 'a', chunk: '0123456789' });
  }
  assert.ok(t.nodes.a.output.length <= MAX_OUTPUT_CHARS + 50);
});

/* ---------- 分支 / 并发 / 循环 ---------- */

test('branch-taken: 记录分支名与剪枝数量', () => {
  const t = applyEvent(mk(), {
    type: 'branch-taken', id: 'c', branchId: 'b1', label: '包含 error', pruned: ['x', 'y'],
  });
  assert.equal(t.nodes.c.branch, '包含 error');
  assert.equal(t.nodes.c.status, 'success');
  assert.ok(t.logs.some((l) => l.text.indexOf('剪枝 2') >= 0));
});

test('parallel-resolved: 记录并发度', () => {
  const t = applyEvent(mk(), { type: 'parallel-resolved', id: 'p', concurrency: 4, reason: '固定' });
  assert.equal(t.nodes.p.concurrency, 4);
});

test('loop-resolved: 记录总轮数并归零已完成', () => {
  const t = applyEvent(mk(), { type: 'loop-resolved', id: 'l', count: 5, reason: '列表', warnings: ['超过上限'] });
  assert.equal(t.nodes.l.loopTotal, 5);
  assert.equal(t.nodes.l.loopDone, 0);
  assert.ok(t.logs.some((l) => l.text.indexOf('超过上限') >= 0), '警告应进日志');
});

test('loop-iteration: 累计已完成轮数', () => {
  let t = mk();
  t = applyEvent(t, { type: 'loop-resolved', id: 'l', count: 3, reason: '', warnings: [] });
  t = applyEvent(t, { type: 'loop-iteration', id: 'l', index: 0, item: 'a', count: 3 });
  t = applyEvent(t, { type: 'loop-iteration', id: 'l', index: 1, item: 'b', count: 3 });
  assert.equal(t.nodes.l.loopDone, 2);
  assert.equal(t.nodes.l.loopItem, 'b');
});

test('loop-done: 有失败则整节点失败', () => {
  const t = applyEvent(mk(), { type: 'loop-done', id: 'l', rounds: 3, failed: 1 });
  assert.equal(t.nodes.l.status, 'failed');
});

test('loop-done: 全成功则 success', () => {
  const t = applyEvent(mk(), { type: 'loop-done', id: 'l', rounds: 3, failed: 0 });
  assert.equal(t.nodes.l.status, 'success');
});

/* ---------- 层与日志 ---------- */

test('layer-start: 记录当前层与总层数', () => {
  const t = applyEvent(mk(), { type: 'layer-start', layer: 1, total: 4, ids: ['a', 'b'] });
  assert.equal(t.layerNow, 2);
  assert.equal(t.layerTotal, 4);
});

test('日志: 带节点归属，便于按节点过滤', () => {
  const t = applyEvent(mk(), { type: 'node-start', id: 'a', rendered: '' });
  assert.equal(t.logs[0].nodeId, 'a');
});

test('日志: run-error 是流程级，不带 nodeId', () => {
  const t = applyEvent(mk(), { type: 'run-error', message: '有环' });
  assert.equal(t.logs[0].nodeId, undefined);
  assert.ok(t.logs[0].text.indexOf('有环') >= 0);
});

/* ---------- 结束 / 取消 ---------- */

test('finishTask: 成功', () => {
  const t = finishTask(mk(), true, T0 + 5000);
  assert.equal(t.status, 'success');
  assert.equal(t.endedAt, T0 + 5000);
});

test('finishTask: 失败', () => {
  assert.equal(finishTask(mk(), false).status, 'failed');
});

test('cancelTask: 运行中的节点被标成已取消', () => {
  let t = mk();
  t = applyEvent(t, { type: 'node-start', id: 'a', rendered: '' });
  t = cancelTask(t, T0 + 100);
  assert.equal(t.status, 'cancelled');
  assert.equal(t.nodes.a.status, 'failed');
  assert.equal(t.nodes.a.error, '已取消');
});

test('cancelTask: 已结束的节点不被改写', () => {
  let t = mk();
  t = applyEvent(t, { type: 'node-done', id: 'a', ok: true, output: 'ok' });
  t = cancelTask(t);
  assert.equal(t.nodes.a.status, 'success');
});

test('取消优先于失败：用户主动停的不该显示成失败', () => {
  const t = finishTask(cancelTask(mk()), false);
  assert.equal(t.status, 'cancelled');
});

/* ---------- 进度 ---------- */

test('进度: 空任务为 0', () => {
  const p = progressOf(mk());
  assert.equal(p.percent, 0);
  assert.equal(p.total, 3);
});

test('进度: 按已终结数量计算', () => {
  let t = mk();
  t = applyEvent(t, { type: 'node-done', id: 'a', ok: true, output: '' });
  t = applyEvent(t, { type: 'node-done', id: 'b', ok: false, output: '', error: 'x' });
  t = applyEvent(t, { type: 'node-done', id: 'c', ok: true, output: '' });
  const p = progressOf(t);
  assert.equal(p.done, 2);
  assert.equal(p.failed, 1);
  assert.equal(p.percent, 100);
});

test('进度: 跳过的算已终结（不会卡在 99%）', () => {
  let t = mk();
  t = applyEvent(t, { type: 'node-done', id: 'a', ok: true, output: '' });
  t = applyEvent(t, { type: 'node-status', id: 'b', status: 'skipped' });
  const p = progressOf(t);
  assert.equal(p.skipped, 1);
  assert.ok(p.percent > 0);
});

test('进度: 运行中的不计入已终结', () => {
  let t = mk();
  t = applyEvent(t, { type: 'node-start', id: 'a', rendered: '' });
  const p = progressOf(t);
  assert.equal(p.running, 1);
  assert.equal(p.percent, 0);
});

test('进度: total 取声明值与实际的较大者', () => {
  let t = makeTask({ canvasId: 'c', canvasName: 'n', total: 1 });
  t = applyEvent(t, { type: 'node-start', id: 'a', rendered: '' });
  t = applyEvent(t, { type: 'node-start', id: 'b', rendered: '' });
  assert.equal(progressOf(t).total, 2);
});

test('进度: 不会超过 100（节点数多于声明时）', () => {
  let t = makeTask({ canvasId: 'c', canvasName: 'n', total: 1 });
  t = applyEvent(t, { type: 'node-done', id: 'a', ok: true, output: '' });
  t = applyEvent(t, { type: 'node-done', id: 'b', ok: true, output: '' });
  assert.equal(progressOf(t).percent, 100);
});

/* ---------- 时间 ---------- */

test('耗时: 已结束的用结束时间', () => {
  const t = finishTask(mk(), true, T0 + 3000);
  assert.equal(elapsedOf(t, T0 + 99999), 3000);
});

test('耗时: 未结束的用当前时间（能实时走秒）', () => {
  assert.equal(elapsedOf(mk(), T0 + 2500), 2500);
});

test('耗时: 不会出现负数', () => {
  assert.equal(elapsedOf(mk(), T0 - 5000), 0);
});

test('格式化: 秒 / 分 / 时', () => {
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatDuration(65000), '1m05s');
  assert.equal(formatDuration(3720000), '1h02m');
});

test('格式化: 时钟 HH:MM:SS', () => {
  const r = formatClock(T0);
  assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(r), r);
});

/* ---------- 不可变性 ---------- */

test('applyEvent 不改原对象（避免 React 漏渲染）', () => {
  const before = mk();
  const after = applyEvent(before, { type: 'node-start', id: 'a', rendered: '' });
  assert.equal(before.nodes.a, undefined);
  assert.equal(after.nodes.a.status, 'running');
  assert.notEqual(before.logs.length, after.logs.length);
});

test('order 数组也是新的', () => {
  const before = mk();
  const after = applyEvent(before, { type: 'node-start', id: 'a', rendered: '' });
  assert.notEqual(before.order, after.order);
});

/* ---------- 文案 ---------- */

test('文案: 五种任务状态都有中文名', () => {
  for (const k of ['running', 'success', 'failed', 'cancelled']) {
    assert.ok(STATUS_LABEL[k as keyof typeof STATUS_LABEL], k);
  }
});

test('文案: 节点状态都有中文名', () => {
  for (const k of ['idle', 'running', 'success', 'failed', 'skipped']) {
    assert.ok(NODE_STATUS_LABEL[k], k);
  }
});

test('文案: 触发来源都有中文名', () => {
  for (const k of ['manual', 'interval', 'cron', 'watch', 'webhook', 'unknown']) {
    assert.ok(SOURCE_LABEL[k as keyof typeof SOURCE_LABEL], k);
  }
});
