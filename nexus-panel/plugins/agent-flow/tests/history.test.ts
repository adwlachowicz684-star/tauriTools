import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseHistory, serializeHistory, addToHistory, pruneHistory, removeFromHistory,
  clearCanvasHistory, compactTask, sizeOfEntry, historyStats, formatSize,
  filterHistory, withinRange, timeBucketOf, groupByTime, formatDateTime,
  emptyHistory, HISTORY_VERSION, MAX_ENTRIES, MAX_TOTAL_CHARS,
  MAX_NODE_OUTPUT, MAX_LOGS_PER_ENTRY, MAX_NODES_PER_ENTRY,
  type HistoryEntry,
} from '../engine/history';
import { readSrc, AF_SRC } from './srcScan';
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { makeTask, applyEvent, finishTask, type TaskRecord } from '../engine/tasks';

const T0 = new Date(2026, 8, 14, 12, 0, 0).getTime();
const mkTask = (canvasId: string, name: string, i: number, ok = true): TaskRecord => {
  let t = makeTask({ canvasId, canvasName: name, now: T0 + i * 1000 });
  t = applyEvent(t, { type: 'node-start', id: 'n1', rendered: '写个脚本' });
  t = applyEvent(t, { type: 'node-chunk', id: 'n1', chunk: '一些输出内容' });
  t = finishTask(t, ok, T0 + i * 1000 + 500);
  return t;
};

/* ---------- 裁剪 ---------- */

test('裁剪: 保留基本字段', () => {
  const e = compactTask(mkTask('c1', 'A', 1));
  assert.equal(e.canvasName, 'A');
  assert.equal(e.status, 'success');
  assert.ok(e.endedAt);
});

test('裁剪: 节点输出被限长', () => {
  let t = makeTask({ canvasId: 'c', canvasName: 'n', now: T0 });
  t = applyEvent(t, { type: 'node-chunk', id: 'a', chunk: 'x'.repeat(9000) });
  const e = compactTask(t);
  assert.ok(e.nodes.a.output.length < 9000, '应被截断');
  assert.ok(e.nodes.a.output.length <= MAX_NODE_OUTPUT + 40);
});

test('裁剪: 短输出不截断', () => {
  let t = makeTask({ canvasId: 'c', canvasName: 'n', now: T0 });
  t = applyEvent(t, { type: 'node-chunk', id: 'a', chunk: '短内容' });
  assert.equal(compactTask(t).nodes.a.output, '短内容');
});

test('裁剪: 日志限量，且保留最新的', () => {
  let t = makeTask({ canvasId: 'c', canvasName: 'n', now: T0 });
  for (let i = 0; i < 200; i += 1) {
    t = applyEvent(t, { type: 'run-error', message: `第${i}条` });
  }
  const e = compactTask(t);
  assert.ok(e.logs.length <= MAX_LOGS_PER_ENTRY);
  assert.ok(e.logs[e.logs.length - 1].text.indexOf('第199条') >= 0, '应保留最新');
});

test('裁剪: 节点数超限', () => {
  let t = makeTask({ canvasId: 'c', canvasName: 'n', now: T0 });
  for (let i = 0; i < MAX_NODES_PER_ENTRY + 30; i += 1) {
    t = applyEvent(t, { type: 'node-start', id: `n${i}`, rendered: '' });
  }
  const e = compactTask(t);
  assert.ok(e.order.length <= MAX_NODES_PER_ENTRY);
});

test('裁剪: running 被存成 cancelled（不该永远显示运行中）', () => {
  const t = makeTask({ canvasId: 'c', canvasName: 'n', now: T0 });
  assert.equal(compactTask(t).status, 'cancelled');
});

test('裁剪: running 时补上 endedAt', () => {
  const t = makeTask({ canvasId: 'c', canvasName: 'n', now: T0 });
  assert.ok(compactTask(t).endedAt, '不该留下永远走不完的任务');
});

test('裁剪: 已结束的任务状态不被改写', () => {
  assert.equal(compactTask(mkTask('c', 'A', 1, false)).status, 'failed');
});

/* ---------- 体积估算 ---------- */

test('体积: 空记录也有基础开销', () => {
  assert.ok(sizeOfEntry(compactTask(makeTask({ canvasId: 'c', canvasName: 'n', now: T0 }))) > 0);
});

test('体积: 输出越长估算越大', () => {
  const a = compactTask(makeTask({ canvasId: 'c', canvasName: 'n', now: T0 }));
  let t = makeTask({ canvasId: 'c', canvasName: 'n', now: T0 });
  t = applyEvent(t, { type: 'node-chunk', id: 'a', chunk: 'x'.repeat(1500) });
  const b = compactTask(t);
  assert.ok(sizeOfEntry(b) > sizeOfEntry(a));
});

test('体积: 格式化', () => {
  assert.equal(formatSize(500), '500 字');
  assert.ok(formatSize(5000).indexOf('K字') > 0);
  assert.ok(formatSize(3000000).indexOf('M字') > 0);
});

/* ---------- 解析 ---------- */

test('解析: 空输入', () => {
  assert.equal(parseHistory(null).entries.length, 0);
});

test('解析: 非法 JSON 不抛异常', () => {
  assert.equal(parseHistory('{坏了').entries.length, 0);
});

test('解析: 非对象输入', () => {
  assert.equal(parseHistory('"字符串"').entries.length, 0);
});

test('解析: 缺 id 的记录被丢弃', () => {
  const f = parseHistory(JSON.stringify({ entries: [{ canvasName: 'x' }] }));
  assert.equal(f.entries.length, 0);
});

test('解析: 缺失字段补齐', () => {
  const f = parseHistory(JSON.stringify({ entries: [{ id: 'a' }] }));
  assert.equal(f.entries[0].canvasName, '未命名流程');
  assert.equal(f.entries[0].status, 'cancelled');
  assert.deepEqual(f.entries[0].order, []);
});

test('解析: 非法 status 回退到 cancelled', () => {
  const f = parseHistory(JSON.stringify({ entries: [{ id: 'a', status: 'weird' }] }));
  assert.equal(f.entries[0].status, 'cancelled');
});

test('解析: 版本号被规范', () => {
  assert.equal(parseHistory('{}').v, HISTORY_VERSION);
});

test('解析: 节点字段缺省不崩', () => {
  const f = parseHistory(JSON.stringify({
    entries: [{ id: 'a', nodes: { n1: null, n2: { status: 'success' } } }],
  }));
  assert.equal(f.entries[0].nodes.n1, undefined);
  assert.equal(f.entries[0].nodes.n2.status, 'success');
});

test('解析: 往返一致', () => {
  const h = addToHistory(emptyHistory(), mkTask('c1', 'A', 1)).file;
  const back = parseHistory(serializeHistory(h));
  assert.equal(back.entries.length, 1);
  assert.equal(back.entries[0].canvasName, 'A');
});

/* ---------- 追加与配额 ---------- */

test('追加: 新记录在最前', () => {
  const h = addToHistory(emptyHistory(), mkTask('c1', '新', 9)).file;
  const h2 = addToHistory(h, mkTask('c2', '更新', 20)).file;
  assert.equal(h2.entries[0].canvasName, '更新');
});

test('追加: 超过条数上限时淘汰最旧的', () => {
  let h = emptyHistory();
  for (let i = 0; i < MAX_ENTRIES + 25; i += 1) {
    h = addToHistory(h, mkTask('c', `任务${i}`, i)).file;
  }
  assert.ok(h.entries.length <= MAX_ENTRIES, `应被裁到 ${MAX_ENTRIES} 以内，实际 ${h.entries.length}`);
  // 最旧的（任务0）应已被淘汰
  assert.equal(h.entries.some((e) => e.canvasName === '任务0'), false);
});

test('追加: 超长记录会触发字符预算淘汰', () => {
  let h = emptyHistory();
  // 造一条超大的：把字符预算占满
  let big = makeTask({ canvasId: 'c', canvasName: '大任务', now: T0 });
  for (let i = 0; i < 60; i += 1) {
    big = applyEvent(big, { type: 'node-start', id: `n${i}`, rendered: 'r'.repeat(700) });
    big = applyEvent(big, { type: 'node-chunk', id: `n${i}`, chunk: 'y'.repeat(3000) });
  }
  h = addToHistory(h, big).file;
  // 再追加普通任务，不该因为一条超长记录而失败
  const after = addToHistory(h, mkTask('c', '普通', 99));
  assert.ok(after.file.entries.length >= 1);
});

test('配额: 字符预算被遵守', () => {
  let h = emptyHistory();
  for (let i = 0; i < 400; i += 1) {
    let t = makeTask({ canvasId: 'c', canvasName: `n${i}`, now: T0 + i });
    t = applyEvent(t, { type: 'node-chunk', id: 'a', chunk: 'z'.repeat(2500) });
    h = addToHistory(h, t).file;
  }
  const st = historyStats(h.entries);
  assert.ok(st.chars <= MAX_TOTAL_CHARS, `字符数 ${st.chars} 应 <= ${MAX_TOTAL_CHARS}`);
});

test('配额: 淘汰会报告数量', () => {
  let h = emptyHistory();
  for (let i = 0; i < MAX_ENTRIES + 10; i += 1) {
    h = addToHistory(h, mkTask('c', `x${i}`, i)).file;
  }
  const r = pruneHistory(h.entries.concat([compactTask(mkTask('c', 'y', 1))]));
  assert.ok(r.removed >= 0);
  assert.ok(r.entries.length <= MAX_ENTRIES);
});

/* ---------- 删除 ---------- */

test('删除: 按 id 移除', () => {
  const h = addToHistory(emptyHistory(), mkTask('c1', 'A', 1)).file;
  const id = h.entries[0].id;
  assert.equal(removeFromHistory(h, id).entries.length, 0);
});

test('删除: id 不存在时不变', () => {
  const h = addToHistory(emptyHistory(), mkTask('c1', 'A', 1)).file;
  assert.equal(removeFromHistory(h, '不存在').entries.length, 1);
});

test('清空某流程: 只删该流程', () => {
  let h = addToHistory(emptyHistory(), mkTask('c1', 'A', 1)).file;
  h = addToHistory(h, mkTask('c2', 'B', 2)).file;
  const after = clearCanvasHistory(h, 'c1');
  assert.equal(after.entries.length, 1);
  assert.equal(after.entries[0].canvasId, 'c2');
});

/* ---------- 统计 ---------- */

test('统计: 空', () => {
  const s = historyStats([]);
  assert.equal(s.total, 0);
  assert.equal(s.usage, 0);
});

test('统计: 分类计数', () => {
  let h = addToHistory(emptyHistory(), mkTask('c', 'ok', 1, true)).file;
  h = addToHistory(h, mkTask('c', 'bad', 2, false)).file;
  h = addToHistory(h, compactTask(makeTask({ canvasId: 'c', canvasName: 'cancel', now: T0 }))).file;
  const s = historyStats(h.entries);
  assert.equal(s.success, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.cancelled, 1);
});

test('统计: usage 在 0~100', () => {
  const s = historyStats([compactTask(mkTask('c', 'A', 1))]);
  assert.ok(s.usage >= 0 && s.usage <= 100);
});

test('统计: 记录最早与最晚时间', () => {
  let h = addToHistory(emptyHistory(), mkTask('c', 'old', 1)).file;
  h = addToHistory(h, mkTask('c', 'new', 9)).file;
  const s = historyStats(h.entries);
  assert.equal(s.oldestAt, T0 + 1000);
  assert.equal(s.newestAt, T0 + 9000);
});

/* ---------- 时间范围 ---------- */

const NOW = new Date(2026, 8, 14, 18, 0, 0).getTime();

test('范围: today 只含今天', () => {
  assert.equal(withinRange(new Date(2026, 8, 14, 1, 0).getTime(), NOW, 'today'), true);
  assert.equal(withinRange(new Date(2026, 8, 13, 23, 0).getTime(), NOW, 'today'), false);
});

test('范围: 7d', () => {
  assert.equal(withinRange(NOW - 3 * 86400000, NOW, '7d'), true);
  assert.equal(withinRange(NOW - 20 * 86400000, NOW, '7d'), false);
});

test('范围: 30d', () => {
  assert.equal(withinRange(NOW - 20 * 86400000, NOW, '30d'), true);
  assert.equal(withinRange(NOW - 60 * 86400000, NOW, '30d'), false);
});

test('范围: all 全通过', () => {
  assert.equal(withinRange(NOW - 999 * 86400000, NOW, 'all'), true);
});

/* ---------- 时间桶 ---------- */

test('桶: 今天', () => {
  assert.equal(timeBucketOf(new Date(2026, 8, 14, 9, 0).getTime(), NOW), '今天');
});

test('桶: 昨天', () => {
  assert.equal(timeBucketOf(new Date(2026, 8, 13, 9, 0).getTime(), NOW), '昨天');
});

test('桶: 本周', () => {
  assert.equal(timeBucketOf(new Date(2026, 8, 10, 9, 0).getTime(), NOW), '本周');
});

test('桶: 更早', () => {
  assert.equal(timeBucketOf(new Date(2026, 7, 1, 9, 0).getTime(), NOW), '更早');
});

test('桶: 分组顺序固定为今天→更早', () => {
  const es: HistoryEntry[] = [
    compactTask(mkTask('c', '旧', 1)),
  ];
  es[0] = { ...es[0], startedAt: new Date(2026, 7, 1).getTime() };
  es.push({ ...compactTask(mkTask('c', '今', 2)), startedAt: NOW });
  const g = groupByTime(es, NOW);
  assert.equal(g[0].bucket, '今天');
  assert.equal(g[g.length - 1].bucket, '更早');
});

test('桶: 空桶不输出', () => {
  const g = groupByTime([{ ...compactTask(mkTask('c', 'A', 1)), startedAt: NOW }], NOW);
  assert.equal(g.length, 1);
});

test('桶: 桶内按时间倒序', () => {
  const a = { ...compactTask(mkTask('c', '早', 1)), startedAt: NOW - 3600000 };
  const b = { ...compactTask(mkTask('c', '晚', 2)), startedAt: NOW - 60000 };
  const g = groupByTime([a, b], NOW);
  assert.equal(g[0].entries[0].startedAt, b.startedAt);
});

/* ---------- 筛选 ---------- */

test('筛选: 按状态', () => {
  let h = addToHistory(emptyHistory(), mkTask('c', 'ok', 1, true)).file;
  h = addToHistory(h, mkTask('c', 'bad', 2, false)).file;
  const r = filterHistory(h.entries, { status: 'failed' }, NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].canvasName, 'bad');
});

test('筛选: 按流程名搜索', () => {
  let h = addToHistory(emptyHistory(), mkTask('c', '部署脚本', 1)).file;
  h = addToHistory(h, mkTask('c', '代码审查', 2)).file;
  const r = filterHistory(h.entries, { keyword: '部署' }, NOW);
  assert.equal(r.length, 1);
});

test('筛选: 搜索能命中日志内容', () => {
  let t = makeTask({ canvasId: 'c', canvasName: 'X', now: NOW });
  t = applyEvent(t, { type: 'run-error', message: '端口被占用' });
  const h = addToHistory(emptyHistory(), t).file;
  assert.equal(filterHistory(h.entries, { keyword: '端口' }, NOW).length, 1);
});

test('筛选: 搜索能命中节点输出（关键词多半在输出里而非日志）', () => {
  let t = makeTask({ canvasId: 'c', canvasName: 'X', now: NOW });
  t = applyEvent(t, { type: 'node-chunk', id: 'a', chunk: '生成了 handleSubmit 函数' });
  const h = addToHistory(emptyHistory(), t).file;
  assert.equal(filterHistory(h.entries, { keyword: 'handlesubmit' }, NOW).length, 1);
});

test('筛选: 搜索不相关的词返回空', () => {
  let t = makeTask({ canvasId: 'c', canvasName: 'X', now: NOW });
  t = applyEvent(t, { type: 'node-chunk', id: 'a', chunk: '一些内容' });
  const h = addToHistory(emptyHistory(), t).file;
  assert.equal(filterHistory(h.entries, { keyword: '不存在的词' }, NOW).length, 0);
});

test('筛选: 关键词忽略大小写', () => {
  const h = addToHistory(emptyHistory(), mkTask('c', 'Deploy', 1)).file;
  assert.equal(filterHistory(h.entries, { keyword: 'deploy' }, NOW).length, 1);
});

test('筛选: 关键词前后空格不影响', () => {
  const h = addToHistory(emptyHistory(), mkTask('c', 'A', 1)).file;
  assert.equal(filterHistory(h.entries, { keyword: '  A  ' }, NOW).length, 1);
});

test('筛选: 无关键词时不过滤', () => {
  const h = addToHistory(emptyHistory(), mkTask('c', 'A', 1)).file;
  assert.equal(filterHistory(h.entries, { keyword: '' }, NOW).length, 1);
});

test('筛选: 按 canvasId', () => {
  let h = addToHistory(emptyHistory(), mkTask('c1', 'A', 1)).file;
  h = addToHistory(h, mkTask('c2', 'B', 2)).file;
  assert.equal(filterHistory(h.entries, { canvasId: 'c2' }, NOW).length, 1);
});

test('筛选: 条件组合', () => {
  let h = addToHistory(emptyHistory(), mkTask('c1', 'A', 1, true)).file;
  h = addToHistory(h, mkTask('c1', 'B', 2, false)).file;
  h = addToHistory(h, mkTask('c2', 'C', 3, false)).file;
  const r = filterHistory(h.entries, { canvasId: 'c1', status: 'failed' }, NOW);
  assert.equal(r.length, 1);
  assert.equal(r[0].canvasName, 'B');
});

/* ---------- 日期格式 ---------- */

test('日期: 格式化为 M月D日 HH:MM', () => {
  const r = formatDateTime(new Date(2026, 8, 14, 9, 5).getTime());
  assert.equal(r, '9月14日 09:05');
});

/* ==================================================================
 * 历史归档：不做脱敏，但这件事必须被说出来
 *
 * 归档的是**原始运行结果**（节点输出与日志），不挖里面的"疑似令牌"。
 *
 * ============ 为什么不去挖 ============
 * 输出是任意文本。按密钥判据挖必然误伤 ——
 * 一段讲 apiKey 用法的文档、一句 "token 已刷新" 的日志都会被挖空。
 * 而误伤是"能看但内容缺了一块"，比明文躺着**更难发现**：
 * 用户只会以为这次运行就是这样。
 *
 * 节点侧是刻意不剥 output 文本的（canvasStore 那条
 * 「output 里带 llm 字样不会被误伤」盯着），历史与它同一口径。
 *
 * ============ 那代价谁承担 ============
 * 输出里被 echo 出令牌时（脚本里 echo $TOKEN、接口把凭据回显了），
 * 它会明文躺在 localStorage 里，且跨会话保留。
 * 所以界面上必须明说，并保留清空入口 —— 否则用户会以为这里
 * 和节点配置一样是挖过密钥的。
 * ================================================================== */

test('归档：输出里的令牌按原样保留（不误伤文本）', () => {
  const t = makeTask({ canvasId: 'c', canvasName: 'n', now: T0 });
  t.nodes.n1 = { id: 'n1', status: 'success', output: '文档：设置 apiKey 后即可调用，token 会过期' };
  t.order = ['n1'];
  const raw = serializeHistory(addToHistory(emptyHistory(), t).file);
  assert.ok(
    raw.includes('设置 apiKey 后即可调用'),
    '讲 apiKey 用法的文档不能被挖空 —— 挖了就是"能看但缺了一块"',
  );
  assert.ok(raw.includes('token 会过期'), '普通句子里的 token 字样也不能被挖');
});

test('源码守卫：历史面板明说"原始输出不做脱敏"', () => {
  const src = readSrc('components/HistoryPanel.tsx');
  assert.ok(
    /原始输出.*不做脱敏|不做脱敏/.test(src),
    '归档不脱敏，界面上必须说出来 —— 否则用户以为这里和节点配置一样挖过密钥',
  );
});

/*
 * 历史目前**没有导出入口**（只有清空）。一旦有人加导出，就是"交给别人"的动作，
 * 必须先脱敏 —— 与 exportCustomPresets / exportVariables 同一条理由。
 *
 * 现在没有导出，所以这条守卫钉的是"别顺手加一个裸的导出"。
 */
test('源码守卫：没有绕过脱敏的历史导出入口', () => {
  /* readSrc 只接文件 —— 传目录会 EISDIR。这里自己遍历 */
  const roots = ['App.tsx', 'components', 'engine', 'hooks'];
  const src = (function walk(): string {
    const parts: string[] = [];
    const go = (rel: string): void => {
      const abs = join(AF_SRC, rel);
      if (!existsSync(abs)) return;
      if (!statSync(abs).isDirectory()) {
        if (/\.tsx?$/.test(rel)) parts.push(readSrc(rel));
        return;
      }
      for (const f of readdirSync(abs)) go(join(rel, f));
    };
    for (const r of roots) go(r);
    return parts.join('\n');
  })();
  assert.equal(
    /exportHistory|downloadHistory|saveHistoryFile/.test(src),
    false,
    '历史导出必须先脱敏 —— 归档的是原始输出，裸导出就把回显的令牌交出去了',
  );
});

test('归档：清空入口存在（明文躺着的代价要可消除）', () => {
  const src = readSrc('components/HistoryPanel.tsx');
  assert.ok(/清空全部/.test(src), '不脱敏就要能彻底清掉');
});
