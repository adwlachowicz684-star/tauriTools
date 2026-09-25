/**
 * 测试注册表守卫 —— 防止「写了测试却没人跑」。
 *
 * 起因：自查时发现 9 个测试文件**不被任何 npm script 引用**，
 * 其中 `command-consistency-test.mjs` 已经**失败 2 项**，
 * 但因为它从来没被跑过，谁也不知道。
 *
 * 这是比"断言写错"更严重的失效：断言写错至少还有人看见红，
 * 而"没被跑"连红的机会都没有 —— 它安静地躺在那里，
 * 让人以为防线还在。
 *
 * 所以这里守两件事：
 *   ① 每个测试文件都必须被某个 script 引用（否则等于没写）
 *   ② 每个 script 指向的测试文件都必须真实存在（否则 npm run 直接崩）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
let pass = 0; let fail = 0;
const t = (name, ok, info) => {
  if (ok) { pass++; console.log(`✅ ${name}${info ? ` → ${info}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${info ? ` → ${info}` : ''}`); }
};

/* ---------- 收集测试文件 ---------- */
/*
 * 用递归遍历而不是 glob —— glob 在 node 20 下是实验特性，
 * 且这里的目的是"一个都不漏"，显式遍历更可控。
 */
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.vite']);
const tests = [];
(function walk(dir) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(join(dir, e.name));
    } else if (/^.*-test\.mjs$/.test(e.name)) {
      tests.push(join(dir, e.name));
    }
  }
})(HERE);

/*
 * 排除 testkit / 夹具：它们名字里带 test 但不是测试，
 * 是被别的文件 import 的工具模块。
 */
const real = tests.filter((f) => !/testkit|\.kit\.mjs|fixtures?\//i.test(f));

/* ---------- 读取 package.json ---------- */
const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
const scripts = pkg.scripts || {};
const scriptText = Object.values(scripts).join(' ');

/* ---- ① 每个测试文件都要被某个 script 引用 ---- */
const orphan = real.filter((f) => !scriptText.includes(basename(f)));
t('每个测试文件都被某个 npm script 引用（否则等于没写）',
  orphan.length === 0,
  orphan.length ? orphan.map((f) => f.replace(HERE, '')).join(' | ') : `${real.length} 个测试全部有主`);

/* ---- ② script 指向的文件必须存在 ---- */
const missing = [];
for (const [k, v] of Object.entries(scripts)) {
  for (const m of v.matchAll(/node\s+([^\s&|]+\.mjs)/g)) {
    const p = m[1];
    if (!p.includes('test')) continue;
    if (!existsSync(join(HERE, p))) missing.push(`${k} → ${p}`);
  }
}
t('npm script 指向的测试文件都真实存在',
  missing.length === 0, missing.join(' | ') || `${Object.keys(scripts).length} 个 script 已核对`);

/* ---- ③ 测试文件必须**有可能失败** ---- */
/*
 * 判据不能是"数断言个数" —— 第一版就是这么写的，结果误报 4 个：
 *   mindmap-test.mjs       用 ok(cond, name)，名字在**第二参**
 *   sidebar-listener-test  没有断言函数，直接 process.exit(条件)
 *   smoke-test.mjs         见下
 * 它们都是真测试，只是断言风格不同。
 *
 * 真正该问的是：**这个文件有没有可能退出非 0？**
 * 答不上来的才是有问题的 —— 一个永远 exit(0) 的测试，
 * 跑一万次也是全绿，等于没有。
 *
 * 这条最有价值的战果是 smoke-test.mjs（也就是 `npm test`）：
 * 它结尾写的是无条件的 `process.exit(0)`，
 * 前面的 `console.log('❌ 运行时错误: ...')` 只是**打印**，
 * 既不断言也不改退出码 —— 于是 npm test **结构上不可能失败**。
 * 现已修掉（改成 fail ? 1 : 0，并补了真断言）。
 */
const alwaysGreen = [];
for (const f of real) {
  const src = readFileSync(f, 'utf8');
  /*
   * 第二类：退出逻辑在**共享测试框架**里。
   * project-group 的 69 个测试都 `import { makeT } from './testkit.mjs'`，
   * `done()` 里才有 `process.exit(st.fail ? 1 : 0)` ——
   * 只扫当前文件当然看不见。第一版就是漏了这条，误报 69 个。
   */
  const viaHarness = /makeT\s*\(|testkit\.mjs|from\s+['"][^'"]*testkit/
    .test(src);
  const canFail = viaHarness
    || /fail\s*\?\s*1\s*:\s*0/.test(src)        // exit(fail ? 1 : 0)
    || /process\.exit\(\s*1\s*\)/.test(src)                 // 直接 exit(1)
    || /process\.exit\(\s*(?:fail|errors|bad|nFail)/.test(src) // 跟着计数变量
    || /process\.exit\([^)]*[?:][^)]*1/.test(src)              // 三元里含 1
    || /process\.exitCode\s*=/.test(src)
    || /throw\s+new\s+Error/.test(src);                        // 抛错也算能失败
  if (!canFail) alwaysGreen.push(f.replace(HERE, ''));
}
t('没有"永远全绿"的测试（必须有非 0 退出路径）',
  alwaysGreen.length === 0,
  alwaysGreen.join(' | ') || `${real.length} 个都可能失败`);

/* ---- ③b 共享测试框架自身也必须能失败 ---- */
/*
 * 上面放行了"退出逻辑在框架里"的测试，那框架本身就必须可靠。
 * 否则一处 `process.exit(0)` 会让几十个测试同时变成装饰品。
 */
/*
 * ⚠️ 相对路径要以**导入方所在目录**为基准，不是本文件所在目录。
 * 第一版写成了 join(HERE, rel)，而 testkit.mjs 在 plugins/project-group/ 下，
 * 拼出来当然不存在 → existsSync 全 false → "核对 0 个框架"，
 * 于是这条断言变成永远通过（这也是一种"防线在但放水"）。
 */
const kitFiles = [];
for (const f of real) {
  const m = readFileSync(f, 'utf8').match(/from\s+['"]([^'"]*testkit[^'"]*)['"]/);
  if (m) kitFiles.push(join(dirname(f), m[1]));
}
const kits = [...new Set(kitFiles)].filter((k) => existsSync(k));
const badKits = kits.filter((k) => !/fail\s*\?\s*1\s*:\s*0/.test(readFileSync(k, 'utf8')));
t('共享测试框架自身会按失败数退出（一处放行不能拖垮几十个测试）',
  badKits.length === 0,
  badKits.map((k) => k.replace(HERE, '')).join(' | ') || `核对 ${kits.length} 个框架`);

/* ---- ④ 元守卫：本文件自己也得被引用 ---- */
t('本守卫自身也被 npm script 引用（不然它也会变成孤儿）',
  scriptText.includes('test-registry-test.mjs'),
  scriptText.includes('test-registry-test.mjs') ? '已注册' : '未注册 —— 请加 test:registry');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
