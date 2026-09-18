import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraph, type RunSummary } from '../engine/runner';
import type { Graph } from '../types';
import {
  parseCsv, toCsv, deriveColumn, filterRows, aggregate, guessDelim, tableBrief,
} from '../engine/table';

/** 一张典型的战斗数值表 */
const CSV = [
  '角色,等级,攻击力,防御力,暴击率',
  '战士,50,100,30,0.2',
  '法师,50,150,10,0.35',
  '刺客,45,120,15,0.5',
].join('\n');

/* ================= CSV 解析 ================= */

test('解析表头与行', () => {
  const t = parseCsv(CSV);
  assert.deepEqual(t.header, ['角色', '等级', '攻击力', '防御力', '暴击率']);
  assert.equal(t.rows.length, 3);
  assert.equal(t.rows[1][2], '150');
});

/** Excel 导出的 CSV 一定带引号，不处理会把单元格切碎而且不报错 */
test('引号内的逗号不被切分', () => {
  const t = parseCsv('名称,描述\n甲,"含有,逗号"');
  assert.equal(t.rows[0][1], '含有,逗号');
});

test('引号内的换行不被切分', () => {
  const t = parseCsv('名称,描述\n甲,"第一行\n第二行"');
  assert.equal(t.rows.length, 1);
  assert.ok(t.rows[0][1].includes('第二行'));
});

test('两个连续引号表示一个引号', () => {
  const t = parseCsv('a\n"他说""你好"""');
  assert.equal(t.rows[0][0], '他说"你好"');
});

test('自动判断分隔符', () => {
  assert.equal(guessDelim('a,b,c\n1,2,3'), ',');
  assert.equal(guessDelim('a\tb\tc\n1\t2\t3'), '\t');
  assert.equal(guessDelim('a;b;c\n1;2;3'), ';');
});

test('去 BOM（Excel 导出常带）', () => {
  const t = parseCsv('\uFEFFa,b\n1,2');
  assert.deepEqual(t.header, ['a', 'b']);
});

test('行长度不齐时补齐，不崩', () => {
  const t = parseCsv('a,b,c\n1');
  assert.deepEqual(t.rows[0], ['1', '', '']);
});

test('序列化后能原样解析回来', () => {
  const t = parseCsv(CSV);
  const back = parseCsv(toCsv(t));
  assert.deepEqual(back, t);
});

/** 含逗号的单元格必须被引号包住，否则往返一次就坏了 */
test('含逗号的单元格往返后不变', () => {
  const t = parseCsv('a,b\n"含,逗号",2');
  const back = parseCsv(toCsv(t));
  assert.equal(back.rows[0][0], '含,逗号');
});

/* ================= 推导列 ================= */

test('对每行套公式，产出新列', () => {
  const t = parseCsv(CSV);
  const r = deriveColumn(t, '期望伤害', '攻击力 * (1 + 暴击率) - 防御力 * 0.5');
  assert.equal(r.ok, true);
  assert.equal(r.table.header[5], '期望伤害');
  // 战士：100*1.2 - 15 = 105
  assert.equal(r.table.rows[0][5], '105');
  // 法师：150*1.35 - 5 = 197.5
  assert.equal(r.table.rows[1][5], '197.5');
});

/**
 * 某行算错时**不中断整张表** ——
 * 200 行的表因为一行有空值就全作废，用户没法定位是哪一行。
 */
test('个别行算错时收集错误，其余行照常', () => {
  /*
   * 用"列名写错"来制造错误 ——
   * 单元格是非数字时按 0 处理（那是设计如此，见「空单元格按 0」），
   * 只有变量不存在才会报错。
   */
  const t = parseCsv('a,b\n1,2\n3,4');
  const r = deriveColumn(t, 'c', 'a + zzz');
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2, '两行都该报错');
  assert.ok(r.errors[0].includes('第 2 行'), r.errors[0]);
});

/** 单元格是非数字时按 0 —— 推导表里常有"这一档还没配"的占位文本 */
test('单元格是非数字时按 0，不算错', () => {
  const t = parseCsv('a,b\n1,待定');
  const r = deriveColumn(t, 'c', 'a + b');
  assert.equal(r.ok, true);
  assert.equal(r.table.rows[0][2], '1');
});

test('列名已存在且不允许覆盖 → 报错，不冲掉原始数据', () => {
  const t = parseCsv(CSV);
  const r = deriveColumn(t, '攻击力', '攻击力 + 1', { replace: false });
  assert.equal(r.ok, false);
  assert.ok(r.errors[0].includes('已经存在'));
  assert.equal(r.table.rows[0][2], '100', '原始数据不该被动过');
});

test('允许覆盖时能覆盖', () => {
  const t = parseCsv(CSV);
  const r = deriveColumn(t, '攻击力', '攻击力 + 10', { replace: true });
  assert.equal(r.ok, true);
  assert.equal(r.table.rows[0][2], '110');
});

test('没填列名或公式会报错', () => {
  const t = parseCsv(CSV);
  assert.equal(deriveColumn(t, '', 'a').ok, false);
  assert.equal(deriveColumn(t, 'x', '').ok, false);
});

test('空单元格按 0 处理', () => {
  const t = parseCsv('a,b\n1,\n2,3');
  const r = deriveColumn(t, 'c', 'a + b');
  assert.equal(r.table.rows[0][2], '1');
});

/* ================= 筛选 ================= */

test('按条件筛行', () => {
  const t = parseCsv(CSV);
  const r = filterRows(t, '暴击率 > 0.3');
  assert.equal(r.ok, true);
  assert.equal(r.table.rows.length, 2);
});

test('没填条件会报错', () => {
  assert.equal(filterRows(parseCsv(CSV), '').ok, false);
});

test('列名写错会报错，不静默返回全表', () => {
  const r = filterRows(parseCsv(CSV), '暴击率率 > 1');
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('不认识的变量'));
});

/* ================= 汇总 ================= */

test('求和 / 平均 / 最大 / 最小 / 计数', () => {
  const t = parseCsv(CSV);
  assert.equal((aggregate(t, '攻击力', 'sum') as { value: number }).value, 370);
  assert.equal((aggregate(t, '攻击力', 'max') as { value: number }).value, 150);
  assert.equal((aggregate(t, '攻击力', 'min') as { value: number }).value, 100);
  assert.equal((aggregate(t, '攻击力', 'count') as { value: number }).value, 3);
  assert.equal((aggregate(t, '攻击力', 'avg') as { value: number }).value, 370 / 3);
});

/** 拼错列名静默得 0 太危险 —— 汇总值算错往往到最后才发现 */
test('列名不存在会报错，不给 0', () => {
  const r = aggregate(parseCsv(CSV), '攻击', 'sum');
  assert.equal(r.ok, false);
  assert.ok((r as { error: string }).error.includes('没有'));
});

test('摘要：行数 × 列数', () => {
  assert.ok(tableBrief(parseCsv(CSV)).includes('3 行'));
  assert.ok(tableBrief(parseCsv(CSV)).includes('5 列'));
});

/* ================= 走 runGraph ================= */

const node = (id: string, kind: string, extra: Record<string, unknown> = {}) => ({
  id, data: { kind, label: id, status: 'idle', output: '', error: '', ...extra },
});
const edge = (s: string, t: string) => ({ id: `${s}->${t}`, source: s, target: t });

const noopExecutor = async () => ({ output: '', ok: true });

async function run(
  nodes: unknown[], edges: unknown[] = [], tableReader?: (p: string) => Promise<string>,
): Promise<RunSummary> {
  return await runGraph(
    { nodes, edges } as unknown as Graph,
    { concurrency: 1, executor: noopExecutor, tableReader, onEvent: () => {} },
  );
}

test('读表 → 推导 → 汇总，整条链跑通', async () => {
  const s = await run(
    [
      node('r', 'tableRead', { path: '/tmp/a.csv' }),
      node('d', 'derive', { newCol: '伤害', expr: '攻击力 - 防御力' }),
      node('a', 'agg', { col: '伤害', op: 'sum' }),
    ],
    [edge('r', 'd'), edge('d', 'a')],
    async () => CSV,
  );
  assert.equal(s.ok, true, JSON.stringify(s.failed));
  // (100-30) + (150-10) + (120-15) = 70 + 140 + 105 = 315
  assert.equal(s.outputs.a, '315');
});

test('筛选后行数变少', async () => {
  const s = await run(
    [
      node('r', 'tableRead', { path: '/tmp/a.csv' }),
      node('f', 'filter', { cond: '等级 >= 50' }),
      node('a', 'agg', { col: '攻击力', op: 'sum' }),
    ],
    [edge('r', 'f'), edge('f', 'a')],
    async () => CSV,
  );
  assert.equal(s.ok, true);
  assert.equal(s.outputs.a, '250'); // 100 + 150
});

test('没有读表能力时明确失败，不假装读到空表', async () => {
  const s = await run([node('r', 'tableRead', { path: '/tmp/a.csv' })]);
  assert.equal(s.ok, false);
  assert.ok(s.failed.includes('r'));
});

test('上游没有表格时明确报错', async () => {
  const s = await run(
    [node('d', 'derive', { newCol: 'x', expr: '1+1' })],
    [], async () => CSV,
  );
  assert.equal(s.ok, false);
});

test('读表节点会带出行数/列数字段', async () => {
  let fields: Record<string, string> = {};
  await runGraph(
    { nodes: [node('r', 'tableRead', { path: '/x' })], edges: [] } as unknown as Graph,
    {
      concurrency: 1, executor: noopExecutor, tableReader: async () => CSV,
      onEvent: (e) => { if (e.type === 'node-fields') fields = (e as { fields: Record<string, string> }).fields; },
    },
  );
  assert.equal(fields['行数'], '3');
  assert.equal(fields['列数'], '5');
});
