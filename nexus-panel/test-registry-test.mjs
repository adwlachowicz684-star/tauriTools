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
import { stripCommentsJs } from './test-scan-utils.mjs';

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
 *
 * ============ 为什么判据里必须有 .test.ts ============
 *
 * 第一版只认 `-test.mjs`，于是 `plugins/agent-flow/tests/` 下的
 * **104 个 .test.ts 一个都进不了 real** —— 守卫照样报告
 * "N 个测试全部有主"，而那 104 个连被检查的资格都没有。
 *
 * 这比"某个测试红了没人管"更隐蔽：整批测试根本不在视野里，
 * 报告却是绿的。所以下面另有一条断言专门守"判据没漏扫"。
 */
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.vite']);
const tests = [];
const tsOnDisk = [];
(function walk(dir) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walk(join(dir, e.name));
    } else if (/^.*-test\.mjs$/.test(e.name)) {
      tests.push(join(dir, e.name));
    } else if (/\.test\.tsx?$/.test(e.name)) {
      tests.push(join(dir, e.name));
      tsOnDisk.push(join(dir, e.name));
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

/*
 * ---------- 目录级运行器 ----------
 *
 * 有些测试**不是逐个点名的**：一个脚本跑整个目录。
 * agent-flow 的 104 个 .test.ts 就是这样 ——
 * `run-tests.sh` 里是一句 `node --test tests/`。
 *
 * 于是"文件名出现在 script 文本里"这条判据对它们**永远为假**，
 * 硬套会把 104 个真测试全报成孤儿（而它们其实跑得好好的）。
 *
 * 但反过来也不能"见到 run-tests.sh 就算有主"：
 * 真正要守的恰恰是**这个运行器自己有没有人调用**。
 * 没人调用的 run-tests.sh，等于整个目录的测试都没人跑，
 * 而按"见到就算"它会把 104 个全判成有主 —— 假绿。
 *
 * 所以覆盖成立要同时满足两条：目录下有运行器 **且** 它被 script 点名。
 */
const RUNNER_NAMES = ['run-tests.sh'];
const runnersFound = [];
/*
 * 独立扫一遍全仓库，不要靠 coveredByRunner 的**副作用**去收集：
 * 那边只在"文件名没被点名"时才走到，万一哪天所有文件都被写进 script，
 * runnersFound 会是空的，①c 就变成永远通过的假绿。
 */
(function walkRunners(dir) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) continue;
      walkRunners(join(dir, e.name));
    } else if (RUNNER_NAMES.includes(e.name)) {
      runnersFound.push(join(dir, e.name).replace(HERE, ''));
    }
  }
})(HERE);

function coveredByRunner(f) {
  let d = dirname(f);
  while (d.startsWith(HERE)) {
    for (const r of RUNNER_NAMES) {
      /*
       * 两处都要找：运行器可能和被测文件同目录，也可能在**同级 scripts/ 下**
       * （agent-flow 的 run-tests.sh 就在 scripts/，被测的在 tests/）。
       * 只找同目录的话，第一版实测把 103 个真测试全报成孤儿 ——
       * 而它们跑起来是 2326 项全过。
       */
      for (const p of [join(d, r), join(d, 'scripts', r)]) {
        if (existsSync(p)) return { runner: p.replace(HERE, ''), cited: scriptText.includes(r) };
      }
    }
    d = dirname(d);
  }
  return null;
}

/* ---- ① 每个测试文件都要被某个 script 引用（或被目录级运行器覆盖） ---- */
const orphan = real.filter((f) => {
  if (scriptText.includes(basename(f))) return false;
  const c = coveredByRunner(f);
  return !(c && c.cited);
});
t('每个测试文件都被某个 npm script 引用（否则等于没写）',
  orphan.length === 0,
  orphan.length ? orphan.map((f) => f.replace(HERE, '')).join(' | ') : `${real.length} 个测试全部有主`);

/* ---- ①b 判据不能漏扫 .test.ts ---- */
/*
 * 收集判据若退回只认 -test.mjs，第 ① 条会**照样全绿** ——
 * 因为看不见的文件压根不参与判定。漏扫的表现是"报告变干净了"，
 * 而不是"报错"。所以另开一条，拿磁盘上真实存在的 .test.ts 对账。
 */
const missedTs = tsOnDisk.filter((f) => real.includes(f) === false);
t('收集判据覆盖 .test.ts（漏扫会让整批测试悄悄消失、报告却仍是绿的）',
  missedTs.length === 0 && tsOnDisk.length > 0,
  /*
   * 措辞要能一眼看出"是漏扫"而不是"本来就少"：
   * 收集判据退回只认 .mjs 时 tsOnDisk 会变成 0，
   * 若写成"0 个全部在视野内"，读着像通过 —— 而这一条其实是红的。
   */
  tsOnDisk.length === 0
    ? '一个 .test.ts 都没收集到 —— 判据漏扫了'
    : (missedTs.length ? `漏了 ${missedTs.length} 个` : `磁盘上 ${tsOnDisk.length} 个 .test.ts 全部在视野内`));

/* ---- ①c 目录级运行器自己必须被 npm script 点名 ---- */
/*
 * 这条守的是 2026-10-01 查到的实况：run-tests.sh 能跑通 104 个测试
 * （2326 项全过），但**全仓库没有任何 script / CI 引用它** ——
 * 只在 README 里被提到。于是那 104 个测试从来没被自动执行过。
 *
 * 它们不红、不报错、也不出现在任何报告里，只是安静地不跑。
 */
const uncited = runnersFound.filter((r) => !scriptText.includes(basename(r)));
t('目录级运行器（run-tests.sh）被 npm script 点名（否则它跑的整批测试都没人跑）',
  runnersFound.length > 0 && uncited.length === 0,
  runnersFound.length === 0 ? '没发现目录级运行器' : (uncited.join(' | ') || `${runnersFound.join(' | ')} 已注册`));

/* ---- ② script 指向的文件必须存在 ---- */
const missing = [];
for (const [k, v] of Object.entries(scripts)) {
  /* 脚本可能是 `cd 子目录 && node xxx.mjs` —— 那 xxx.mjs 相对的是
     子目录，不是仓库根。第一版不懂 cd，于是把**唯一一条**写了 cd 的
     script（test:pg-chain-panel-input）判成"指向的文件不存在" ——
     纯假阳性。这里把 cd 前缀剥掉再拼路径。
     （那条 script 本身也已改成根目录相对，与其他 168 条一致；
       但守卫不能依赖"大家都别写 cd"，否则下一个人写了就又误报。） */
  const cdm = /(?:^|[&|;]\s*)cd\s+([^\s&|;]+)/.exec(v);
  const baseDir = cdm ? join(HERE, cdm[1]) : HERE;
  for (const m of v.matchAll(/node\s+([^\s&|]+\.mjs)/g)) {
    const p = m[1];
    if (!p.includes('test')) continue;
    if (!existsSync(join(baseDir, p))) missing.push(`${k} → ${p}`);
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
    || /throw\s+new\s+Error/.test(src)                        // 抛错也算能失败
    /*
     * node:test —— 退出码由 `node --test` 这个**运行器**决定：
     * 有用例失败它就退出非 0。文件里自然找不到 exit / throw。
     *
     * 不认这条的话，104 个 .test.ts 会被整批判成"永远全绿的装饰品"——
     * 而它们实测 2326 项**全过**，是 agent-flow 引擎唯一的回归防线。
     */
    || /from\s+['"]node:test['"]/.test(src);
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
 * 拼出来当然不存在 → existsSync 全 false → "核对 0 个框架"。
 *
 * 而当时这条断言只判 `badKits.length === 0` —— 集合是空的时候
 * 它**照样通过**。这就是"防线在、但放水"：注释里写明了坑，
 * 判据却抓不到它。2026-10-01 用破坏验证（把 join(dirname(f),…)
 * 改回 join(HERE,…)）实测确认：改动生效、界面显示"核对 0 个框架"，
 * 而结果是 7 通过 / 0 失败。
 *
 * 所以判据必须加上 kits.length > 0：一个都没核对到，本身就是失守。
 */
const kitFiles = [];
for (const f of real) {
  const m = readFileSync(f, 'utf8').match(/from\s+['"]([^'"]*testkit[^'"]*)['"]/);
  if (m) kitFiles.push(join(dirname(f), m[1]));
}
const kits = [...new Set(kitFiles)].filter((k) => existsSync(k));
const badKits = kits.filter((k) => !/fail\s*\?\s*1\s*:\s*0/.test(readFileSync(k, 'utf8')));
t('共享测试框架自身会按失败数退出（一处放行不能拖垮几十个测试）',
  /*
   * kits.length > 0 这条不能省：省了它，路径基准写错时集合为空、
   * 断言恒真，报出来还是"核对 0 个框架"这种看着像过的措辞。
   */
  kitFiles.length > 0 && kits.length > 0 && badKits.length === 0,
  kits.length === 0
    ? `一个框架都没核对到（收集到 ${kitFiles.length} 条 testkit 引用，但拼出的路径都不存在 —— 相对路径要以导入方目录为基准）`
    : (badKits.map((k) => k.replace(HERE, '')).join(' | ') || `核对 ${kits.length} 个框架`));

/* ---- ③c 元守卫：③b 的判据不能只判"空集合" ---- */
/*
 * 上面那条若只写 badKits.length === 0，则"一个框架都没核对到"时它恒真——
 * 报出来还是"核对 0 个框架"，读着像通过，实际是失守。
 *
 * 2026-10-01 用破坏验证实测过：把路径基准改回 join(HERE, …)，
 * 改动确实落地、措辞确实变成"核对 0 个框架"，而结果是 7 通过 / 0 失败。
 * 也就是注释里写着坑、判据却抓不到它。
 *
 * 所以这里用源码级断言把 kits.length > 0 钉死：
 * 谁把它删了，这条立刻红。
 *
 * ⚠️ 必须先剥注释再查：上面这段注释里就写着 "kits.length > 0" 四个字，
 * 不剥的话即使判据被删光，正则也会匹配到注释 —— 又一处假绿。
 * （和 command-consistency 那条"断言查存在性、不查那一处存在"同源。）
 *
 * ⚠️⚠️ 只剥注释不够，剥字符串字面量也不够 —— 2026-10-02 两步都实测过：
 *
 *   ① 只剥注释：下面这两条**说明文字**（字符串字面量）里也写着
 *      '判据含 kits.length > 0' / '判据里没有 kits.length > 0 …'，
 *      判据删光了照样匹配 → 8 通过 / 0 失败，**防假绿的守卫自己就是假绿**；
 *   ② 再剥字符串：全文件扫的替换式会在别处错配引号（本文件有模板串、
 *      正则字面量），把判据那一段一起吞掉 → 反过来变成恒红。
 *
 * 两次都是"查存在性、不查那一处存在"。所以最终改成**只取判据那一段**：
 * 从 `const kits = ` 起到 `badKits.length === 0,` 为止，
 * 这段里没有注释也没有字符串，命中即真命中。
 * 两个锚点任何一个找不到都必须报红（找不到 = 判据被改得认不出了，
 * 此时静默放过比报红危险）。
 */
const selfSrc = stripCommentsJs(readFileSync(fileURLToPath(import.meta.url), 'utf8'));
/*
 * 整条判据一起匹配（不是只查 kits.length > 0 四个字）：
 * 只查片段会命中下面两条说明文字里的同样字样（见上），那是假绿。
 * 代价是判据重排会误报红 —— 误报红看得见、假绿看不见，两害取其轻。
 */
const NEED_JUDGE = /kitFiles\.length\s*>\s*0\s*&&\s*kits\.length\s*>\s*0\s*&&\s*badKits\.length\s*===\s*0/;
t('③b 必须要求"至少核对到 1 个框架"（只判空集合 = 防线放水）',
  NEED_JUDGE.test(selfSrc),
  NEED_JUDGE.test(selfSrc)
    ? '判据含 kits.length > 0'
    : '判据里没有 kits.length > 0 —— 空集合会让 ③b 恒真');

/* ---- ④ 元守卫：本文件自己也得被引用 ---- */
t('本守卫自身也被 npm script 引用（不然它也会变成孤儿）',
  scriptText.includes('test-registry-test.mjs'),
  scriptText.includes('test-registry-test.mjs') ? '已注册' : '未注册 —— 请加 test:registry');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
