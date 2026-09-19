import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * strip-ts.py 的已知陷阱守卫。
 *
 * 这个脚本把 TS 剥成 ESM 给测试跑，但它对类型语法的处理很粗糙，
 * 已经踩过十一次坑。其中**最危险的一类不是语法错误，而是静默改变数据** ——
 * 生成的 .mjs 能跑、测试也可能过，但算出来的值是错的。
 *
 * 这里把每次踩过的坑都钉一条用例：
 *   · 提醒后来人别再写回去
 *   · 万一脚本被改坏了能立刻发现
 */

const SRC = fs.readFileSync(path.join(process.env.AF_SRC ?? '.', 'engine/table.ts'), 'utf8');

/**
 * 检查前先剥掉块注释。
 *
 * 注释里为了说明这个坑，正好要把坏写法原样写出来（`delim = ','`）。
 * 不剥的话说明本身就是一条永久假阳性，
 * 反过来会逼人为了过测试去改写注释。
 */
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '');

test('陷阱一：toCsv 的分隔符不能写成默认参数', () => {
  /*
   * `delim = ','` 会被脚本变成 `', '`（多个空格）。
   * 结果是含逗号的单元格不再被引号包住，往返一次数据悄悄损坏。
   * 这也是为什么函数体里写成 `delim ? delim : ','`。
   */
  assert.ok(!/delim\s*=\s*','/.test(stripComments(SRC)),
    '别把分隔符写成默认参数 —— strip-ts.py 会把它变成 ", "，静默破坏数据');
  assert.ok(/delim\s*&&\s*delim\.length\s*>\s*0\s*\?\s*delim\s*:\s*','/.test(stripComments(SRC)),
    '分隔符应在函数体内部取默认值');
});

test('陷阱二：class 里带类型注解的方法签名不能用', () => {
  const EXPR = fs.readFileSync(path.join(process.env.AF_SRC ?? '.', 'engine/expr.ts'), 'utf8');
  /*
   * `peek(): Tok | undefined {` 会被原样留下，生成的 .mjs 直接语法错误。
   * 所以解析器写成闭包函数，不用 class。
   */
  assert.ok(!/^\s+\w+\s*\(\s*\)\s*:\s*\w+\s*\|\s*undefined\s*\{/m.test(stripComments(EXPR)),
    '别在 class 方法上写类型注解 —— strip-ts.py 剥不干净');
});


/* ---------------- 陷阱九 / 十：断言与对象类型注解 ---------------- */

/*
 * 这两条都属于"生成的 .mjs 直接语法错误"，
 * 比陷阱一（静默改数据）好查，但每次新写带类型的函数都可能撞上。
 */

const FL = fs.readFileSync(
  path.join(process.env.AF_SRC ?? '.', 'engine/fieldLike.ts'), 'utf8',
);

const flCode = stripComments(FL);

test('陷阱九：函数类型断言不能内联（要写成类型别名）', () => {
  /*
   * `(v as (d: Record<string, unknown>) => unknown)(data)` 会被剥成
   * `(v ) => unknown)(data)` —— 箭头函数的返回类型被当成函数体边界。
   */
  const bad = /as\s*\(\s*\w+\s*:\s*[^)]*=>/.test(flCode);
  assert.equal(bad, false, '函数类型断言要写成 type 别名，不能内联');
});

test('陷阱十：内联对象类型注解不能带分号（要写成类型别名）', () => {
  /*
   * `let x: { value: string; label: string }[]` 会被剥成
   * `let x; label: string }[]` —— 分号让脚本误判语句边界。
   */
  const bad = /:\s*\{[^}]*;[^}]*\}\s*\[\]/.test(flCode);
  assert.equal(bad, false, '对象类型注解要写成 type 别名，不能内联');
});


/* ---------------- 陷阱十一：函数上的泛型参数列表 ---------------- */

const CRN = fs.readFileSync(
  path.join(process.env.AF_SRC ?? '.', 'engine/canvasRefName.ts'), 'utf8',
);

test('陷阱十一：函数不能带泛型参数列表（要用类型别名）', () => {
  /*
   * `export function f<T extends X>(...)` 的 `<T ...>` 剥不掉，
   * 会原样留在 .mjs 里 → SyntaxError: Unexpected token '<'
   */
  const bad = /function\s+\w+\s*</.test(stripComments(CRN));
  assert.equal(bad, false, '函数泛型剥不掉，改用 type 别名收住约束');
});
