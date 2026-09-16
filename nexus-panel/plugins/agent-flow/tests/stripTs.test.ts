import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * strip-ts.py 的回归测试。
 *
 * 这个脚本是"没装全工具链时跑测试"的关键一环，它的 bug 很特殊：
 * 不报语法错，而是**静默改变语义**（类型残留变成合法 JS）。
 * 所以必须为已修的每个坑留一条用例。
 */

const SCRIPT = join(process.env.AF_SRC ?? process.cwd(), 'scripts/strip-ts.py');

function strip(code: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'strip-'));
  const src = join(dir, 'in.ts');
  const out = join(dir, 'out.mjs');
  writeFileSync(src, code, 'utf-8');
  execFileSync('python3', [SCRIPT, src, out], { stdio: 'pipe' });
  return readFileSync(out, 'utf-8');
}

test('（前置）脚本存在且可执行', () => {
  const out = strip('const a = 1;');
  assert.match(out, /const a = 1/);
});

/**
 * 这条守一个静默语义错误：
 * 对象类型的联合断言若只吃到配对的 }，`| undefined` 会残留成按位或，
 * `obj | undefined` 在 JS 里恒为 0 —— 不报错，但变量莫名其妙变成 0。
 */
test('对象类型的联合断言要整体移除，不留 | undefined', () => {
  const out = strip(
    'const own = data.inner as { nodes?: unknown[]; edges?: unknown[] } | undefined;',
  );
  assert.ok(!out.includes('| undefined'), `不该残留 | undefined：${out}`);
  assert.ok(!/\|\s*undefined/.test(out), `不该残留按位或：${out}`);
  assert.match(out, /data\.inner/);
});

test('普通联合断言（非对象）不留 | undefined', () => {
  const out = strip('const x = y as Foo | undefined;');
  assert.ok(!/\|\s*undefined/.test(out), `残留了：${out}`);
});

test('泛型联合断言不留 | undefined', () => {
  const out = strip('const x = y as Partial<T> | undefined;');
  assert.ok(!/\|\s*undefined/.test(out), `残留了：${out}`);
});

test('对象类型断言后面紧跟 ] 不被吃掉', () => {
  // 真实场景：数组字面量里的对象断言，`as` 后面紧邻 `]`
  const out = strip('const arr = [{ ...a } as ConditionRule];');
  assert.match(out, /\]\s*;?/, '数组结尾的 ] 要保留');
  assert.ok(!out.includes('ConditionRule'), '类型名该删');
});

test('非空断言后紧跟括号要正确剥离', () => {
  const out = strip('const r = opts.fsExecutor!(...args);');
  assert.ok(!out.includes('!('), `! 残留：${out}`);
  assert.match(out, /opts\.fsExecutor\(\.\.\.args\)/);
});

test('前缀取反 if (!x) 不受影响', () => {
  const out = strip('if (!ready) return;');
  assert.match(out, /if \(!ready\)/, '! 是取反，不是断言，不能删');
});

test('keyof / typeof 索引类型整体移除', () => {
  const out = strip('const k = x as keyof typeof META;');
  assert.ok(!out.includes('keyof') && !out.includes('typeof'), `残留：${out}`);
});

test('数组后缀 as Foo[] 保留下标语法', () => {
  const out = strip('const a = b as Foo[];');
  assert.ok(!out.includes('Foo'), `类型名该删：${out}`);
});
