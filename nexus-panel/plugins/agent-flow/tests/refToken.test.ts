/*
 * ==================================================================
 * 引用的字符集：全仓库只许有一处定义
 *
 * ================= 这条守卫的来历 =================
 *
 * 模板引用的字符集以前在两处各写一份：
 *   - engine/template.ts   （运行时渲染 {{...}}）
 *   - engine/scriptExport.ts（导出成 shell / python）
 *
 * template.ts 那次为修「中文参数名取不到」放开了 \u4e00-\u9fa5，
 * **scriptExport.ts 没跟着改**。于是同一个 {{c1.价格}}：
 * 画布上跑能取到值，导出成脚本就原样留在那里 ——
 * 不报错，只有结果不对。
 *
 * 现在统一由 template.ts 的 tokenRe() / refHeadRe() 提供，
 * 其余地方一律来取。这条守卫盯的就是"不许再长出第二份"。
 * ==================================================================
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readSrc, AF_SRC } from './srcScan';

/*
 * 字符集出现处：中文那一段（u4e00）在源码里是 `\\u4e00`，
 * 这里只钉 `u4e00` 这个片段 —— 钉转义层数会被源码的写法变化打断，
 * 而"这个字符集考虑了中文"才是要守的事。
 */
const CN = 'u4e00';

test('引用的字符集只在 template.ts 定义（expr.ts 是刻意独立）', () => {
  /*
   * expr.ts 是表达式分词器，那里的 `-` 是减号运算符，
   * **不能**复用模板的字符集（会把 `5-3` 当成一个名字），
   * 所以它自己有一份，且在源码里写明了理由。
   */
  const dir = path.join(AF_SRC, 'engine');
  const hits = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && readSrc(`engine/${f}`).includes(CN))
    .map((f) => `engine/${f}`)
    .sort();
  assert.deepEqual(
    hits,
    ['engine/expr.ts', 'engine/template.ts'],
    `中文字符集只允许这两处（其余请从 template.ts 取）：${hits.join(', ')}`,
  );
});

test('运行时与导出用的是同一个 tokenRe（导出不再自带一份）', () => {
  const exp = readSrc('engine/scriptExport.ts');
  assert.ok(
    /from '\.\/template'/.test(exp) && /tokenRe\(\)/.test(exp),
    'scriptExport.ts 必须 import 并调用 template.ts 的 tokenRe()',
  );
  assert.ok(!exp.includes(CN), 'scriptExport.ts 里不该再自带一份字符集');
});

test('改 id 时改写引用用的也是同源字符集（refHeadRe）', () => {
  const ref = readSrc('engine/canvasRef.ts');
  assert.ok(/refHeadRe\(\)/.test(ref), 'canvasRef.ts 应调用 refHeadRe()');
  assert.ok(!ref.includes(CN), 'canvasRef.ts 里不该再自己写一份');
});

test('参数名校验与"引用能取到的名字"同源', () => {
  /*
   * 这两处是同一件事的两面：
   *   isValidParamName 判"用户能起什么名字"
   *   REF_CHARS       判"引用时能取到什么名字"
   * 分叉了就是"起了个合法名字却引用不到"，且不报错。
   */
  const cp = readSrc('engine/canvasParams.ts');
  assert.ok(
    /REF_NAME_CHARS/.test(cp) && /REF_NAME_FIRST/.test(cp),
    'canvasParams.ts 的名字校验应取 template.ts 的字符集常量',
  );
  assert.ok(!cp.includes(CN), 'canvasParams.ts 里不该再硬写一份名字字符集');
});

test('每次调用返回新实例（/g 正则带 lastIndex，共用会互相踩）', async () => {
  const { tokenRe } = await import('../engine/template');
  const a = tokenRe();
  const b = tokenRe();
  assert.notEqual(a, b, 'tokenRe() 必须返回新实例');
  a.exec('{{x}}');
  assert.equal(b.lastIndex, 0, '另一个实例不该被前一次 exec 影响');
});
