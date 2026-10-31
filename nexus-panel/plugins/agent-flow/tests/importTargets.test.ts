import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { AF_SRC, stripComments } from './srcScan';

/**
 * 相对 import 的目标文件必须真的存在。
 *
 * ================= 为什么要这条 =================
 *
 * #399 移除 engine/taskBoard.ts 时删掉了 engine 层、hooks、部分组件和
 * 两个测试文件，却**漏了** components/TaskBoard.tsx 与 TaskBoardDetail.tsx ——
 * 它们还写着 `from '../engine/taskBoard'`。
 *
 * 结果是整个插件编译不过（TS2307 × 2 + 连带 TS7006 × 4），
 * 而 2821 项测试**一条都不红**：跑测试用的是 transpile-only，
 * 不解析模块。于是"编译不过"这件事没有任何信号。
 *
 * 同一件事在 session.test.ts 里又发生一次：用例删了、
 * 头上的 import 没删，整个文件 Cannot find module 崩掉，
 * 崩的样子是"模块找不到"，看不出是这里多了一行。
 *
 * 这类洞的共同形状：**删了定义，没删引用**。而引用散在各处，
 * 靠人记得是记不住的 —— 所以交给静态扫描。
 *
 * ⛔ 为什么不用 tsc 的结果（check-types.sh 已经能抓）：
 *    它没被强制跑，于是抓了也没用。这条在 2821 项测试里，
 *    每次跑测试都会执行，不依赖有人记着另跑一个脚本。
 */

/** 模块说明符能指向的候选文件（TS 的解析顺序，够用即可） */
function candidates(abs: string): string[] {
  return [
    abs,
    abs + '.ts',
    abs + '.tsx',
    abs + '.d.ts',
    abs + '.js',
    abs + '.mjs',
    path.join(abs, 'index.ts'),
    path.join(abs, 'index.tsx'),
    path.join(abs, 'index.js'),
  ];
}

/**
 * 取文件里所有相对 import / export-from 的说明符。
 * 先剥注释与字符串外的干扰：`from '` 只可能出现在字符串里，
 * 所以直接扫 `'...'` 即可，但模板字符串里的动态路径要跳过（含 ${）。
 */
function specsIn(src: string): string[] {
  const out: string[] = [];
  const re = /(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const s = m[1];
    if (!s.startsWith('.') || s.includes('${')) continue;
    out.push(s);
  }
  return out;
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else if (/\.tsx?$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** .css 不参与：TS 侧有 TS2882 白名单（样式表导入是构建层的事） */
const SKIP_EXT = /\.(css|svg|png|json)$/;

test('相对 import 的目标文件必须存在（删了定义就该删引用）', () => {
  const files = walk(path.join(AF_SRC));
  const bad: string[] = [];
  let checked = 0;
  for (const f of files) {
    // 先剥注释：注释里常写着"以前是 from './x'"，那是历史说明不是真引用
    const src = stripComments(fs.readFileSync(f, 'utf-8'));
    const dir = path.dirname(f);
    for (const s of specsIn(src)) {
      if (SKIP_EXT.test(s)) continue;
      checked++;
      const abs = path.resolve(dir, s);
      if (!candidates(abs).some((c) => fs.existsSync(c))) {
        bad.push(`${path.relative(AF_SRC, f)} → ${s}`);
      }
    }
  }
  assert.ok(checked > 100, `扫描到的相对 import 太少（${checked}），判据怕是瞎了`);
  assert.deepEqual(bad, [], '这些 import 指向不存在的模块，会让整个插件编译不过');
});

test('判据自己不能失明：造一个假 import 要能报出来', () => {
  const abs = path.join(AF_SRC, 'engine');
  assert.ok(!candidates(path.join(abs, '__definitely_missing__')).some((c) => fs.existsSync(c)),
    '不存在的模块必须判为不存在');
  assert.ok(candidates(path.join(abs, 'session')).some((c) => fs.existsSync(c)),
    '存在的模块（省略扩展名）必须判为存在 —— 否则所有 import 都会假红');
});

test('判据扫的范围要够（不能因为 walk 没进子目录而漏掉整个 components/）', () => {
  const files = walk(path.join(AF_SRC));
  assert.ok(files.length > 80, `扫到的源码文件太少（${files.length}）`);
  assert.ok(files.some((f) => f.includes(`${path.sep}components${path.sep}`)), '要扫到 components/');
  assert.ok(files.some((f) => f.includes(`${path.sep}engine${path.sep}`)), '要扫到 engine/');
  assert.ok(files.some((f) => f.includes(`${path.sep}tests${path.sep}`)), '要扫到 tests/（测试里的 import 同样是真引用）');
});
