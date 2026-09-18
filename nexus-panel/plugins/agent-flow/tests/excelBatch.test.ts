import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planFillDown, shardByRows, parseCellRef, parseRange, rangeSize,
  colToNum, numToCol, findFuncs, findVolatile, findFullColRefs,
  checkLinks, anyStale, MAX_ROWS,
} from '../engine/excelBatch';

/* ================= 单元格与范围 ================= */

test('列字母与数字互换', () => {
  assert.equal(colToNum('A'), 1);
  assert.equal(colToNum('Z'), 26);
  assert.equal(colToNum('AA'), 27);
  assert.equal(colToNum('XFD'), 16384);
  assert.equal(numToCol(1), 'A');
  assert.equal(numToCol(27), 'AA');
  assert.equal(numToCol(16384), 'XFD');
});

test('解析单元格', () => {
  assert.deepEqual(parseCellRef('A1'), { col: 1, row: 1 });
  assert.deepEqual(parseCellRef('$B$12'), { col: 2, row: 12 });
  assert.deepEqual(parseCellRef('XFD1048576'), { col: 16384, row: 1048576 });
  assert.equal(parseCellRef('乱码'), null);
});

test('解析范围（带表名）', () => {
  const r = parseRange("'明细表'!A2:B10");
  assert.equal(r?.sheet, '明细表');
  assert.equal(r?.from.row, 2);
  assert.equal(rangeSize(r!), 18);
});

/* ================= 函数识别 ================= */

test('识别函数调用', () => {
  assert.deepEqual(findFuncs('SUM(A1:A10)').map((f) => f.name), ['SUM']);
  assert.deepEqual(findFuncs('ROUND(A1*2, 1)').map((f) => f.name), ['ROUND']);
});

/** 字符串里的括号不能被当成函数 —— 误报会让人去改没问题的公式 */
test('字符串常量里的括号不算函数', () => {
  assert.equal(findFuncs('IF(A1="abc(", 1, 0)').filter((f) => f.name === 'ABC').length, 0);
  assert.deepEqual(findFuncs('IF(A1="abc(", 1, 0)').map((f) => f.name), ['IF']);
});

test('识别出易失函数', () => {
  assert.deepEqual(findVolatile('OFFSET(A1,0,0)').map((f) => f.name), ['OFFSET']);
  assert.deepEqual(findVolatile('SUM(A1:A10)*2').length, 0);
  assert.deepEqual(findVolatile('RAND()').map((f) => f.name), ['RAND']);
});

test('识别全列引用', () => {
  assert.deepEqual(findFullColRefs('SUM(A:A)').map((f) => f.ref), ['A:A']);
  assert.deepEqual(findFullColRefs('SUM($A:$A)').map((f) => f.ref), ['$A:$A']);
});

/** 限定区域是正确写法，不能误报 */
test('限定区域不算全列引用', () => {
  assert.equal(findFullColRefs('SUM(A1:A1000)').length, 0);
  assert.equal(findFullColRefs('SUM(A1:B2)').length, 0);
});

/* ================= 分片 ================= */

test('不超过单表上限时不分片', () => {
  const s = shardByRows(1000, 2, 4, 4, () => 'S');
  assert.equal(s.length, 1);
  assert.equal(s[0].cells, 1000);
});

test('超过单表上限时拆到多张表', () => {
  const s = shardByRows(MAX_ROWS * 3, 2, 4, 4, (i) => `S${i + 1}`);
  assert.equal(s.length, 4); // 第一片少一行（从第 2 行起）
  assert.equal(s[0].sheet, 'S1');
  assert.equal(s[1].from.row, 2);
});

test('每片都不超过单表上限', () => {
  const s = shardByRows(30_000_000, 2, 4, 4, (i) => `S${i + 1}`);
  for (const x of s) {
    assert.ok(x.to.row <= MAX_ROWS, `片 ${x.sheet} 超过了行数上限`);
  }
  const total = s.reduce((a, x) => a + x.cells, 0);
  assert.equal(total, 30_000_000);
});

/* ================= 计划 ================= */

test('计划是"手动 → 批量写 → 重算 → 恢复"的夹心结构', () => {
  const p = planFillDown({ sheet: '明细', startRef: 'D2', rows: 100, formula: 'B2*C2' });
  const kinds = p.steps.map((s) => s.kind);
  assert.equal(kinds[0], 'setCalc');
  assert.equal((p.steps[0] as { mode: string }).mode, 'manual');
  assert.ok(kinds.includes('writeFormula'));
  assert.ok(kinds.includes('recalc'));
  assert.equal(kinds[kinds.length - 1], 'save');
  // 最后要恢复自动，否则用户改参数不动而毫无线索
  const lastCalc = [...p.steps].reverse().find((s) => s.kind === 'setCalc') as { mode: string };
  assert.equal(lastCalc.mode, 'automatic');
});

test('公式不带 = 时自动补上', () => {
  const p = planFillDown({ sheet: 'S', startRef: 'D2', rows: 10, formula: 'B2*C2' });
  assert.equal((p.steps[1] as { formula: string }).formula, '=B2*C2');
});

test('几千万行会被拆成多个写入步骤，而不是一次调用', () => {
  const p = planFillDown({ sheet: '明细', startRef: 'D2', rows: 30_000_000, formula: 'B2*C2' });
  const writes = p.steps.filter((s) => s.kind === 'writeFormula');
  assert.ok(writes.length > 20, `应有二十多个写入步骤，实际 ${writes.length}`);
  assert.ok(writes.length < 200, '写入步骤不该多到几百次往返');
  assert.equal(p.totalCells, 30_000_000);
});

test('没填公式 → block，不生成步骤', () => {
  const p = planFillDown({ sheet: 'S', startRef: 'D2', rows: 10, formula: '' });
  assert.ok(p.risks.some((r) => r.level === 'block'));
  assert.equal(p.steps.length, 0);
});

test('起始格看不懂 → block', () => {
  const p = planFillDown({ sheet: 'S', startRef: '不是单元格', rows: 10, formula: 'B2' });
  assert.ok(p.risks.some((r) => r.level === 'block'));
});

/** 易失函数在几千万格规模下是硬伤，必须报出来 */
test('易失函数会被报出来', () => {
  const p = planFillDown({ sheet: 'S', startRef: 'D2', rows: 1000, formula: 'OFFSET(A1,0,0)*2' });
  assert.ok(p.risks.some((r) => r.message.includes('易失函数')));
});

test('全列引用会被报出来', () => {
  const p = planFillDown({ sheet: 'S', startRef: 'D2', rows: 1000, formula: 'SUM(A:A)' });
  assert.ok(p.risks.some((r) => r.message.includes('全列引用')));
});

test('超过单表行数会提示要拆表', () => {
  const p = planFillDown({ sheet: 'S', startRef: 'D2', rows: 2_000_000, formula: 'B2' });
  assert.ok(p.risks.some((r) => r.message.includes('超过单表上限')));
});

test('行数为 0 时提示', () => {
  const p = planFillDown({ sheet: 'S', startRef: 'D2', rows: 0, formula: 'B2' });
  assert.ok(p.risks.some((r) => r.message.includes('行数为 0')));
});

/* ================= 外部链接 ================= */

test('源文件比缓存新 → 陈旧，要明确说出会用到旧值', () => {
  const s = checkLinks([{ source: '/a.xlsx', cachedMtime: 1000, currentMtime: 2000 }]);
  assert.equal(s[0].stale, true);
  assert.ok(s[0].reason.includes('旧值'));
});

test('源文件不存在 → 陈旧且缺失', () => {
  const s = checkLinks([{ source: '/a.xlsx', cachedMtime: 1000, currentMtime: null }]);
  assert.equal(s[0].stale, true);
  assert.equal(s[0].missing, true);
});

test('Excel 报告断开 → 陈旧', () => {
  const s = checkLinks([{ source: '/a.xlsx', broken: true }]);
  assert.equal(s[0].stale, true);
});

test('与源一致 → 不陈旧', () => {
  const s = checkLinks([{ source: '/a.xlsx', cachedMtime: 1000, currentMtime: 1000 }]);
  assert.equal(s[0].stale, false);
});

test('anyStale', () => {
  assert.equal(anyStale([{ source: 'a', stale: false, missing: false, reason: '' }]), false);
  assert.equal(anyStale([
    { source: 'a', stale: false, missing: false, reason: '' },
    { source: 'b', stale: true, missing: false, reason: '' },
  ]), true);
});
