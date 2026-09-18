import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * strip-ts.py 的已知陷阱守卫。
 *
 * 这个脚本把 TS 剥成 ESM 给测试跑，但它对类型语法的处理很粗糙，
 * 已经踩过八次坑。其中**最危险的一类不是语法错误，而是静默改变数据** ——
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
