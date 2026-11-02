import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AF_SRC } from './srcScan';

/**
 * 废弃链路守卫：正则剥离器 strip-ts.py 整套已移除，不许复活。
 *
 * run-tests.sh 开头列过它累计踩过的 12 类坑，每一类都是**静默产出坏代码**
 * （类型残留变成合法 JS、默认参数里的 ',' 被改成 ', '…）。
 * 它现在由真正的 tsc 取代。留一个还能被 exec 的脚本，就总有人会
 * "临时用它跑一下"，于是测试测的是旧产物 —— 改了被测文件结果也不变。
 *
 * ⛔ 刻意不查「名字有没有出现」：run-tests.sh、gen-node-docs.mjs 和
 * 五个测试文件里都还留着历史说明，提到它是对的。要查的是**调用**。
 * 所以先剥注释，只认剥完之后还剩下的路径字符串。
 */
const ROOT = AF_SRC;
const SELF = 'tests/noStripTs.test.ts';
const SKIP = ['node_modules', 'afts', 'dist', '.git', '__pycache__'];
const EXTS = ['.ts', '.tsx', '.js', '.mjs', '.py', '.sh'];

function stripAllComments(src: string): string {
  return src
    .replace(/["\u0027]{3}[\s\S]*?["\u0027]{3}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^\s*#.*$/gm, '');
}

function allFiles(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (SKIP.includes(e.name)) continue;
        walk(path.join(d, e.name));
      } else if (e.isFile() && EXTS.some((x) => e.name.endsWith(x))) {
        const abs = path.join(d, e.name);
        const rel = path.relative(ROOT, abs).split(path.sep).join('/');
        if (rel === SELF) continue;
        out.push({ rel, src: fs.readFileSync(abs, 'utf-8') });
      }
    }
  };
  walk(ROOT);
  return out;
}

test('（前置）AF_SRC 指向插件根', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'App.tsx')),
    '读不到 App.tsx —— 守卫会读空串、集体假通过');
});

test('strip-ts.py 与它那份回归测试都不存在', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'scripts/strip-ts.py')),
    'scripts/strip-ts.py 又回来了：它是已被 tsc 取代的正则剥离器');
  assert.ok(!fs.existsSync(path.join(ROOT, 'tests/stripTs.test.ts')),
    'tests/stripTs.test.ts 又回来了：它测的是已废弃工具，且会 exec 它');
});

test('没有任何代码再调用正则剥离器（注释里的历史说明不算）', () => {
  const files = allFiles();
  assert.ok(files.length > 300, `只扫到 ${files.length} 个文件，扫描范围读空了`);
  const callers = files.filter((f) => /strip-ts\.py/.test(stripAllComments(f.src)));
  assert.deepEqual(callers.map((f) => f.rel), [],
    `这些文件剥注释后仍引用 strip-ts.py：${callers.map((f) => f.rel).join(', ')}`);
});

test('run-tests.sh 仍走真正的 tsc（不许把编译换回正则）', () => {
  const sh = stripAllComments(fs.readFileSync(path.join(ROOT, 'scripts/run-tests.sh'), 'utf-8'));
  assert.match(sh, /-p\s+"\$TSCONFIG"/, '编译那一步不见了');
  assert.match(sh, /TSC_ARR/, 'tsc 命令没起来就跑测试，会拿上一轮旧产物');
});
