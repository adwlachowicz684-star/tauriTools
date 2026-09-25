import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AF_SRC } from './srcScan';

/** 原样读源码（不去注释）—— 这张表里有些项后面跟着说明 */
const readSrcRaw = (rel: string): string =>
  fs.readFileSync(path.join(AF_SRC, rel), 'utf-8');
import {
  mathOp, textOp, compareOp, randomOp, num, fmt, opSummary, opBrief, briefArg,
  opBriefParts, opSignOf,
} from '../engine/ops';

const v = (r: { ok: boolean; value?: string; error?: string }) =>
  (r as { ok: true; value: string }).value;

/* ================= 数字解析 ================= */

test('空与非数字按 0 处理（不报错）', () => {
  assert.equal(num(''), 0);
  assert.equal(num('abc'), 0);
  assert.equal(num(undefined), 0);
  assert.equal(num('  12  '), 12);
});

test('支持百分号与千分位', () => {
  assert.equal(num('50%'), 0.5);
  assert.equal(num('1,234'), 1234);
});

/**
 * 整数不显示小数点 ——
 * 显示成 2.0 会让下游比较节点按文本比对时匹配不上。
 */
test('整数不带小数点', () => {
  assert.equal(fmt(2), '2');
  assert.equal(fmt(2.5), '2.5');
});

test('浮点尾巴被收掉（0.1+0.2）', () => {
  assert.equal(v(mathOp('add', '0.1', '0.2')), '0.3');
});

/* ================= 数学 ================= */

test('加减乘除取余', () => {
  assert.equal(v(mathOp('add', 2, 3)), '5');
  assert.equal(v(mathOp('sub', 5, 3)), '2');
  assert.equal(v(mathOp('mul', 4, 3)), '12');
  assert.equal(v(mathOp('div', 10, 4)), '2.5');
  assert.equal(v(mathOp('mod', 10, 3)), '1');
});

test('除零明确报错（结果没有合理默认值）', () => {
  const r = mathOp('div', 10, 0);
  assert.equal(r.ok, false);
  assert.ok((r as { error: string }).error.includes('0'));
});

test('取最值与取整', () => {
  assert.equal(v(mathOp('min', 3, 7)), '3');
  assert.equal(v(mathOp('max', 3, 7)), '7');
  assert.equal(v(mathOp('round', '2.6', '')), '3');
  assert.equal(v(mathOp('floor', '2.6', '')), '2');
  assert.equal(v(mathOp('ceil', '2.2', '')), '3');
  assert.equal(v(mathOp('abs', '-5', '')), '5');
});

/* ================= 文本 ================= */

test('拼接 / 长度 / 大小写 / 去空格', () => {
  assert.equal(v(textOp('concat', 'a', 'b')), 'ab');
  assert.equal(v(textOp('length', 'hello', '')), '5');
  assert.equal(v(textOp('upper', 'ab', '')), 'AB');
  assert.equal(v(textOp('lower', 'AB', '')), 'ab');
  assert.equal(v(textOp('trim', '  x  ', '')), 'x');
});

test('替换：默认替换全部', () => {
  assert.equal(v(textOp('replace', 'a-b-c', '-', '/')), 'a/b/c');
});

/** 位置从 1 开始数 —— 与用户直觉一致 */
test('取子串位置从 1 开始', () => {
  assert.equal(v(textOp('substr', 'abcdef', '2', '4')), 'bcd');
  assert.equal(v(textOp('substr', 'abcdef', '1', '')), 'abcdef');
});

test('取第几段', () => {
  assert.equal(v(textOp('split', 'a,b,c', ',', '2')), 'b');
  // 越界给空而不是报错
  assert.equal(v(textOp('split', 'a,b', ',', '9')), '');
});

test('重复次数有上限（防卡死）', () => {
  assert.equal(v(textOp('repeat', 'ab', '2')), 'abab');
  assert.equal(textOp('repeat', 'a', '999999').ok, false);
});

/* ================= 比较 ================= */

/** 这条最要紧：字符串比较下 "10" < "9" 会成立，且不报错 */
test('两边是数字就按数字比（10 大于 9）', () => {
  assert.equal(v(compareOp('gt', '10', '9')), 'true');
  assert.equal(v(compareOp('lt', '10', '9')), 'false');
});

test('非数字按文本比', () => {
  assert.equal(v(compareOp('eq', 'abc', 'abc')), 'true');
  assert.equal(v(compareOp('gt', 'b', 'a')), 'true');
});

test('包含 / 开头 / 结尾', () => {
  assert.equal(v(compareOp('contains', 'hello', 'ell')), 'true');
  assert.equal(v(compareOp('startsWith', 'hello', 'he')), 'true');
  assert.equal(v(compareOp('endsWith', 'hello', 'lo')), 'true');
});

/**
 * 输出 'true'/'false' 而不是空串 ——
 * 空串在条件节点里会被当成"没内容"，从而走错分支。
 */
test('比较结果一定是 true/false 文本，不是空', () => {
  assert.equal(v(compareOp('eq', 'a', 'b')), 'false');
  assert.notEqual(v(compareOp('eq', 'a', 'b')), '');
});

/* ================= 随机 ================= */

/** 固定 rng 序列，让随机可测 */
const seq = (xs: number[]) => { let i = 0; return () => xs[i++ % xs.length]; };

test('随机整数在范围内', () => {
  assert.equal(v(randomOp('int', '1', '3', seq([0]))), '1');
  assert.equal(v(randomOp('int', '1', '3', seq([0.999]))), '3');
});

test('范围反了会报错', () => {
  assert.equal(randomOp('int', '5', '1').ok, false);
});

test('随机选一个', () => {
  assert.equal(v(randomOp('pick', 'a,b,c', '', seq([0]))), 'a');
  assert.equal(v(randomOp('pick', 'a,b,c', '', seq([0.99]))), 'c');
});

test('没得选会报错', () => {
  assert.equal(randomOp('pick', '', '').ok, false);
});

test('打乱保留全部元素', () => {
  const r = randomOp('shuffle', 'a,b,c', '', seq([0.5, 0.2, 0.9]));
  assert.equal(r.ok, true);
  assert.equal(v(r).split(',').sort().join(','), 'a,b,c');
});

/* ================= 摘要 ================= */

test('摘要覆盖四类运算', () => {
  assert.equal(opSummary('math', 'add'), '＋');
  assert.equal(opSummary('text', 'concat'), '拼接');
  assert.equal(opSummary('compare', 'gt'), '大于');
  assert.equal(opSummary('random', 'pick'), '随机选一个');
});

/* ------------------------------------------------------------------ */

test('opBrief 把参数写进摘要 —— 改了参数摘要就要跟着变', () => {
  /*
   * 起因：摘要以前只显示运算名（"＋"），改了 a / b 卡片上毫无变化，
   * 用户以为没生效。这条直接钉住"参数必须出现在摘要里"。
   */
  assert.equal(opBrief('math', { op: 'add', a: '10', b: '5' }), '10 ＋ 5');
  assert.equal(opBrief('math', { op: 'add', a: '1', b: '2' }), '1 ＋ 2');
  assert.equal(opBrief('compare', { op: 'gt', a: '生命值', b: '100' }), '生命值 > 100');
  assert.equal(opBrief('random', { op: 'int', a: '1', b: '100' }), '随机整数 1~100');
  assert.equal(opBrief('text', { op: 'concat', a: 'a', b: 'b' }), 'a ＋ b');
});

test('opBrief 缺参数显示 ? —— 要能看出缺的是哪一个', () => {
  /*
   * `10 ＋ ?` 一眼知道第二个数没填；
   * 如果只写"参数待填"，还得点开面板去找。
   */
  assert.equal(opBrief('math', { op: 'add', a: '10' }), '10 ＋ ?');
  assert.equal(opBrief('math', { op: 'add' }), '? ＋ ?');
});

test('opBrief 单目运算不显示第二个数', () => {
  assert.equal(opBrief('math', { op: 'round', a: '3.7' }), 'round(3.7)');
  assert.equal(opBrief('math', { op: 'abs', a: '-5' }), 'abs(-5)');
});

test('opBrief 保留模板原样 —— 用户要确认引用的是哪个上游', () => {
  /*
   * 替用户把 {{task1.output}} 渲染掉的话，
   * 他反而看不出自己引用的是哪一个。
   */
  const b = opBrief('math', { op: 'mul', a: '{{task1.output}}', b: '2' });
  assert.match(b, /\{\{task1\.output\}\}/);
});

test('opBrief 长参数截断', () => {
  const long = 'x'.repeat(50);
  const b = opBrief('math', { op: 'add', a: long, b: '1' });
  assert.ok(b.length < 50, `摘要应当截断，实际：${b}`);
  assert.ok(b.endsWith('1'), '第二个数要保留');
});

test('briefArg 空值返回 ?', () => {
  assert.equal(briefArg(''), '?');
  assert.equal(briefArg(undefined), '?');
  assert.equal(briefArg('  '), '?');
  assert.equal(briefArg('abc'), 'abc');
});

test('未知运算退回运算名，不返回空串', () => {
  /*
   * 摘要是空的会让卡片少一行、高度跳动；
   * 未来新增运算忘了补摘要时，至少还能看出是什么运算。
   */
  assert.equal(opBrief('math', { op: 'futureOp' }), 'futureOp');
});

/* ------------------------------------------------------------------ */

test('每个运算都有摘要 —— 新增运算忘了补，这条会红', () => {
  /*
   * 从 ops.ts 的**类型定义**里读出全部字面量，逐个验证。
   *
   * 手写一份清单的话，新增运算时两边不同步 ——
   * 清单里没有，检查也就看不见它，正是这类守卫最容易漏的情况。
   * 从类型定义读，新增一个 op 就必须有对应摘要，否则这里立刻红。
   */
  const t = fs.readFileSync(
    path.join(process.env.AF_SRC ?? path.resolve(__dirname, '..'), 'engine/ops.ts'),
    'utf-8',
  );
  const kinds: { type: string; kind: string }[] = [
    { type: 'MathOp', kind: 'math' },
    { type: 'TextOp', kind: 'text' },
    { type: 'CompareOp', kind: 'compare' },
    { type: 'RandomOp', kind: 'random' },
  ];

  /*
   * 真的没有参数的运算。目前只有随机真假 ——
   * 它不读 a / b，硬要求摘要里出现参数反而是错的。
   */
  const NO_ARG_OP: Record<string, string[]> = { random: ['bool'] };

  let n = 0;
  for (const { type, kind } of kinds) {
    const block = t.match(new RegExp(`export type ${type} =([\\s\\S]*?);`));
    assert.ok(block, `ops.ts 里找不到 ${type}`);
    const lits = block[1].match(/'([a-zA-Z]+)'/g) ?? [];
    assert.ok(lits.length > 0, `${type} 一个运算都没有，正则是不是写错了`);
    for (const raw of lits) {
      const op = raw.replace(/'/g, '');
      n += 1;
      const brief = opBrief(kind, { op, a: '1', b: '2', c: '3' });
      assert.ok(brief, `${kind}/${op} 的摘要是空的`);
      assert.notEqual(brief, op, `${kind}/${op} 没有对应摘要（原样返回了运算名）`);
      /*
       * 关键的一条：摘要里必须出现参数本身。
       *
       * 只查"非空且不等于运算名"是不够的 ——
       * 删掉 opBrief 里的分支后它退回 opSummary，而 opSummary
       * 也有全部运算名，于是检查照样通过，而摘要里没有参数，
       * 改了参数卡片上还是没变化（正是要防的那个问题）。
       * 是故障注入时发现这个假阴性的。
       */
      if (!NO_ARG_OP[kind]?.includes(op)) {
        assert.ok(
          brief.includes('1'),
          `${kind}/${op} 的摘要里没有参数（"${brief}"）—— 改了参数卡片上看不出变化`,
        );
      }
    }
  }
  assert.ok(n >= 30, `只检查了 ${n} 个运算，类型定义可能没读到`);
});

/* ================= 符号表只能有一份 ================= */

/*
 * 运算符写法（＋ / × / ≥ …）曾经有三份手写表：
 * 卡片摘要两份（算术、比较各一），任务窗口的判据又抄了第三份。
 *
 * 加一个新运算漏改一份，症状是同一个运算在两处写法不同
 * （卡片 `＋`、判据 `add`）—— 不报错，只有并排看才发现，
 * 而用户不会并排看，只会觉得"这个判据怎么写得这么怪"。
 *
 * 现在合并成 ops.ts 里导出的唯一一份。这里盯两件事：
 *   1. 不许再出现第二张表（按"带符号字面的 Record<string,string>"判定）
 *   2. 所有带符号的运算，卡片与判据取到的是同一个符号
 */
test('运算符写法只有一份，且卡片与判据取到同一个符号', () => {
  /*
   * 用 readSrc 而不是 __dirname ——
   * 测试跑在编译产物目录里，__dirname 指不到仓库源码
   * （第一版就是这么写的，于是直接 ENOENT）。
   */
  const src = readSrcRaw('engine/ops.ts');
  const runnerSrc = readSrcRaw('engine/runners/ops.ts');

  // 1. 判据那边不许自带表
  assert.ok(
    !/const\s+\w*SIGN\w*\s*:\s*Record<\s*string\s*,\s*string\s*>\s*=\s*\{/.test(runnerSrc),
    '判据里又出现了一张符号表 —— 应该 import opSignOf，不要各写一份',
  );
  assert.ok(runnerSrc.includes('opSignOf'), '判据没有改用 opSignOf');

  /*
   * 2. 卡片与判据取到同一个符号
   *
   * 表可能是一张，也可能按算术/比较分成两张 —— 结构不重要，
   * 重要的是**出口只有一个**（opSignOf）：
   * 卡片画什么、判据写什么，都必须由它决定。
   *
   * 所以这里把所有 *SIGN* 表都抓出来合并，再逐项比对，
   * 而不是绑死某一种写法（绑死的守卫在别人换结构时会假红）。
   */
  const tables = [...src.matchAll(
    /const\s+(\w*SIGN\w*)[^=]*=\s*\{([\s\S]*?)\};/g,
  )];
  assert.ok(tables.length > 0, 'ops.ts 里找不到符号表 —— 守卫本身失效了');
  const signs = tables.flatMap((t) =>
    [...t[2].matchAll(/([a-zA-Z]+):\s*'([^']+)'/g)].map(
      (m) => [m[1], m[2]] as [string, string],
    ),
  );
  assert.ok(signs.length >= 11, `符号表只解析到 ${signs.length} 项`);

  for (const [op, sign] of signs) {
    // 卡片摘要
    const kind = ['add', 'sub', 'mul', 'div', 'mod'].includes(op) ? 'math' : 'compare';
    const parts = opBriefParts(kind, { kind, op, a: '1', b: '2' });
    const opPart = parts.find((p) => p.role === 'op' || p.role === 'fn');
    assert.ok(opPart, `${kind}/${op} 的摘要里没有运算符格`);
    assert.equal(opPart.text, sign, `${kind}/${op}：卡片写 "${opPart.text}"，符号表是 "${sign}"`);

    // 判据：直接对函数断言，避免复制一份实现
    assert.equal(opSignOf(op), sign, `${op}：opSignOf 与符号表不一致`);
  }
});
