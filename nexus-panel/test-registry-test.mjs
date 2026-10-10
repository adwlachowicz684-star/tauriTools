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
 * ---------- 补齐「只有 script 点名、文件名不合规」的测试 ----------
 *
 * 上面按文件名收集（`-test.mjs` / `.test.tsx?`），于是
 * `smoke-react.mjs` 这类**跑得到、但名字不合规**的文件一个都进不了视野：
 * 它有 npm script、真在跑、有 12 条断言，而 ③d/③e/③f 从来没扫过它。
 *
 * 实测：往 smoke-react.mjs 注入一条恒真的长度判据，本守卫
 * 14 通过 / 0 失败 —— 一条都没抓到，报的仍是"核对 296 个测试文件"。
 *
 * 这是同一类失效的第三遍：**判据漏掉整批对象，报告照样绿**。
 * 前两遍是 .test.ts 漏扫、目录级运行器漏认。
 *
 * ⓘ 排除 sweep-tests.mjs：它是体检工具不是测试，且 test:sweep 指向它，
 *   算进来会让"每个测试文件都被 script 引用"这类断言多一个自指对象。
 */
const SCRIPT_FILE_RE = /[\w./-]+\.(?:mjs|cjs|tsx?)\b/g;
const scriptFiles = [];
for (const [name, cmd] of Object.entries(scripts)) {
  if (!name.startsWith('test:')) continue;
  for (const m of cmd.match(SCRIPT_FILE_RE) || []) {
    const rel = m.replace(/^\.\//, '');
    if (/sweep-tests\.mjs$/.test(rel)) continue;
    if (/testkit|\.kit\.mjs|fixtures?\//i.test(rel)) continue;
    if (!existsSync(join(HERE, rel))) continue;
    if (!scriptFiles.includes(rel)) scriptFiles.push(rel);
  }
}
/* 只统计「文件名不合规、全靠 script 点名才被发现」的那批 */
const scriptOnly = scriptFiles.filter(
  (f) => !/-test\.mjs$/.test(f) && !/\.test\.tsx?$/.test(f),
);
for (const f of scriptOnly) {
  if (!tests.includes(f)) { tests.push(f); real.push(f); }
}

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

/*
 * ⓘ 这条不能省：上面那段补齐逻辑要是被删掉，scriptOnly 仍然非空、
 *   而 real 里没有它们 —— 于是 ③d/③e/③f 集体失明，本守卫照样全绿。
 *   跟 ③b「空集合 = 防线放水」是同一类。
 */
t('只被 script 点名的测试也进得了视野（漏扫＝整批断言没人守，报告照样绿）',
  scriptOnly.length > 0 && scriptOnly.every((f) => real.includes(f)),
  scriptOnly.length === 0
    ? '没收到只靠 script 点名的测试（收集判据坏了）'
    : `只靠 script 点名：${scriptOnly.join(' | ')}`);

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

/* ---- ③d 恒真断言：判据永远为真 = 防线被悄悄撤掉 ---- */
/*
 * 起因（2026-10-03 全仓扫描扫出四处）：
 *   ok(r.posted.length >= 0, '渲染不主动发消息')
 *   ok(e2.posted.length >= 0, '（对照）不同对象引用不会被当成自己')
 *   ok(bad.length >= 0, 'panels：扫描到 input.mm-input 定义')
 *   t('待决定的会被列出', ext.pendingHosts().length >= 0)
 * 共同点是「长度 >= 0」—— 数组长度永远不可能小于 0，判据**不可能失败**。
 *
 * 后果比"多一条绿"严重得多：破坏验证实测，把源码真的改坏
 * （① 渲染时主动发消息 ② 拖回自己由引用比较退化成 id 比较）：
 *   旧的恒真写法 → 3187 通过 / **0 失败**（一处都没抓到）
 *   改成真判据后   → 3185 通过 / **3 失败**（全部抓到）
 * 也就是说这四处此前一条都没守，而报告一直是全绿。
 *
 * 只收**机械可判定**的形态（长度 >= 0 / > -1）。
 * `!csp || …` 这种"前缀逃生舱"同样让断言空转（external-test 里真有一条），
 * 但形态太多、误伤重，不在这里判 —— 靠人工读和破坏验证。
 *
 * ⚠️ 必须剥注释：下面这段注释本身就写着「长度 >= 0」字样，
 *    不剥的话本文件自己就会命中。同理，**说明文字里也不要写出 `.length` 加
 *    比较符的字面组合**（字符串不会被剥），否则本守卫恒红。
 */
const TAUT = [/\.length\s*>=\s*0\b/, /\.length\s*>\s*-1\b/];
/*
 * ⓘ 检测器自检：喂一条已知恒真的样本，要求判据**必须命中**。
 *   否则有人把 TAUT 清空（或把正则改坏），本守卫照样全绿 ——
 *   防线被撤了还报平安，与 ③b「空集合 = 防线放水」是同一类假绿。
 *   实测：判据清空后注入一条真恒真断言，本守卫 9 通过 / 0 失败（一处没抓到）。
 *
 *   样本用**拼接**构造：整条字面量写进源码会被本守卫自己扫到
 *   （字符串不受"剥注释"保护），那会让它**恒红** —— 比恒真更难发现。
 */
const TAUT_SAMPLE = '.' + 'length' + ' >' + '= 0';
t('③d 判据必须真能命中恒真样本（判据被清空 = 防线被悄悄撤掉）',
  TAUT.length > 0 && TAUT.some((re) => re.test(TAUT_SAMPLE)),
  `判据 ${TAUT.length} 条`);
const tautHits = [];
for (const f of real) {
  const body = stripCommentsJs(readFileSync(f, 'utf8'));
  body.split('\n').forEach((line, i) => {
    if (TAUT.some((re) => re.test(line))) {
      tautHits.push(`${f.replace(HERE, '')}:${i + 1} → ${line.trim().slice(0, 90)}`);
    }
  });
}
t('测试里没有恒真的长度判据（永远为真 = 那条断言一条都没守）',
  /*
   * real.length > 0 这条不能省：收集判据要是被改坏，集合为空 → 恒真 →
   * 报出来还是"核对 0 个测试文件"这种看着像过的措辞（③b 已踩过一次）。
   */
  real.length > 0 && tautHits.length === 0,
  real.length === 0
    ? '一个测试文件都没收到（收集判据坏了）'
    : (tautHits.join(' | ') || `核对 ${real.length} 个测试文件`));

/* ---- ③e 逃生舱：条件以「空则短路」开头 = 那条断言常年在空跑 ---- */
/*
 * 起因（external-test 实测）：条件是这种形状 —— 前半段先判"有没有东西"，
 * 没有就直接算通过，有才去验内容。而历史上走到那里恰好**一个都没有**，
 * 于是它从来没验过任何东西；反过来说，一旦真有了内容它立刻红，
 * 而红的原因跟"内容对不对"毫无关系（详见 external-test 里的说明）。
 *
 * 跟 ③d 的区别：③d 是"那个量恒非负"（长度永远不小于 0），
 * 这里是"空集合短路"。共同点是**断言不可能失败**，而报告一片绿。
 *
 * ============ 为什么不能像 ③d 那样整行扫 ============
 *
 * 这个形状出现在模拟代码、循环跳过里**完全正常**。实测全仓按行扫出
 * 7 处，逐条核对后 7 处都是这类合法用法（React 依赖比较、every 回调里的
 * 跳过）。整行扫会一片误报，而误报的下场不是"红着"，是**守卫被删掉** ——
 * 那连 ③d 一起没了。所以只判**断言调用的条件参数开头**。
 *
 * 覆盖边界：只认 t / ok / assert 三种调用（各文件的断言函数名不同，
 * 全认会误伤同名变量）。.test.ts 用的是别家的断言函数，不在覆盖内。
 */
/*
 * 只抓**同向矛盾**的那一半：`没有东西 → 就算验到了`。
 * 反过来的写法是语义自洽的，实测 tooltip-test 有一条 ——
 * "元素不存在" 本来就属于 "元素不带 on" 的子集，两种实现（摘类 / 删元素）
 * 都真地让提示不见了，那条断言并不是在空跑。误报它的下场不是红着，
 * 是守卫被人删掉（连 ③d 一起），所以这里宁松一档。
 */
const ESCAPE = /^!\s*(\w+)\s*\|\|\s*\(?\s*\1\s*[.[]/;
/* 样本拼接构造：整条字面量写进源码会被本节自己扫到，那会让它恒红 */
const ESC_SAMPLE = '!' + 'csp' + ' || csp' + '.includes(';
t('③e 判据必须真能命中逃生舱样本（判据被清空 = 防线被悄悄撤掉）',
  ESCAPE.test(ESC_SAMPLE) && !ESCAPE.test('a || b'),
  ESCAPE.test(ESC_SAMPLE) ? '样本命中' : '判据没命中样本 —— 防线已被撤');
{
  /* 取 start 处左括号的配对内容 */
  const parenOf = (src, start) => {
    let depth = 0;
    for (let i = start; i < src.length; i++) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')' && (depth -= 1) === 0) return src.slice(start + 1, i);
    }
    return null;
  };
  /* 按顶层逗号切参数（跳过嵌套括号与字符串里的逗号） */
  const splitTop = (s) => {
    const out = []; let depth = 0, cur = '', q = null;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (q) { cur += c; if (c === q && s[i - 1] !== '\\') q = null; continue; }
      if (c === '"' || c === "'" || c === '`') { q = c; cur += c; continue; }
      if ('([{'.includes(c)) depth += 1;
      else if (')]}'.includes(c)) depth -= 1;
      if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    out.push(cur);
    return out;
  };
  const escHits = [];
  for (const f of real) {
    if (!f.endsWith('.mjs')) continue;
    let raw;
    try { raw = readFileSync(f, 'utf8'); } catch { continue; }
    const src = stripCommentsJs(raw);
    for (const fn of ['t', 'ok', 'assert']) {
      const re = new RegExp('\\b' + fn + '\\s*\\(', 'g');
      let m;
      while ((m = re.exec(src))) {
        const inner = parenOf(src, m.index + m[0].length - 1);
        if (inner === null) continue;
        const args = splitTop(inner);
        let cond = ((fn === 't' ? args[1] : args[0]) || '').trim();
        /* 容 (x || y) 的外层括号 */
        while (cond.startsWith('(') && cond.endsWith(')')) cond = cond.slice(1, -1).trim();
        if (ESCAPE.test(cond)) {
          const line = src.slice(0, m.index).split('\n').length;
          escHits.push(`${f.replace(HERE, '')}:${line} → ${cond.slice(0, 80)}`);
        }
      }
    }
  }
  t('断言条件里没有逃生舱（空则直接判过 = 那条常年没在验）',
    escHits.length === 0, escHits.join(' | ') || '干净');

  /* ---- ③f 占位断言：条件写成字面量 true = 那条永远不可能失败 ---- */
  /*
   * 起因（2026-10-08 全仓扫描，mindmap-test 三处）：
   *   ok(true, '（跳过）用户分组数量不符，跳过最后一组删除测试')
   *   ok(true, 'mouseleave 未抛错')
   *   ok(true, '（已知）ref.t 不随包带走，导入后重新生成首帧')
   * 三条都恒真，而且**计入通过数** —— 于是"这一条其实没测"被混进
   * "通过 3260 项"里，报告上看不出有任何东西被跳过/没验过。
   * 其中第二条还掩盖了"崩 ≠ 红"：真抛异常时脚本崩在半路，
   * 后面几千条断言一条都不跑，而这三条照样绿。
   *
   * 修法不是删掉它们（跳过确实要登记），而是**单列 skip 计数**并写进汇总行：
   * 跳过必须看得见，不能冒充通过。
   *
   * 判据：只认布尔断言函数（t / ok / assert）里出现**裸 true / !0** 这个参数。
   * 不认字符串字面量 —— ok('说明') 在"名字在前"的签名下是合法写法，
   * 无法与"忘了写条件"区分，误报的下场是守卫被删（连 ③d 一起），宁松一档。
   */
  const bareTrue = (inner) => splitTop(inner)
    .some((a) => /^(true|!0)$/.test(a.trim()));
  /* 样本拼接构造：整条字面量写进源码会被本节自己扫到，那会让它恒红 */
  const TRUE_SAMPLE = 'tr' + 'ue, x)';
  t('③f 判据必须真能命中占位样本（判据被清空 = 防线被悄悄撤掉）',
    bareTrue(TRUE_SAMPLE) && !bareTrue('a === b, x'),
    bareTrue(TRUE_SAMPLE) ? '样本命中' : '判据没命中样本 —— 防线已被撤');
  const trueHits = [];
  for (const f of real) {
    if (!f.endsWith('.mjs')) continue;
    let raw;
    try { raw = readFileSync(f, 'utf8'); } catch { continue; }
    const src = stripCommentsJs(raw);
    for (const fn of ['t', 'ok', 'assert']) {
      const re = new RegExp('\\b' + fn + '\\s*\\(', 'g');
      let m;
      while ((m = re.exec(src))) {
        const inner = parenOf(src, m.index + m[0].length - 1);
        if (inner === null) continue;
        if (bareTrue(inner)) {
          const line = src.slice(0, m.index).split('\n').length;
          trueHits.push(`${f.replace(HERE, '')}:${line} → ${inner.trim().slice(0, 70)}`);
        }
      }
    }
  }
  t('断言里没有占位式的恒真 true（跳过/已知取舍要单列，不能冒充通过）',
    trueHits.length === 0, trueHits.join(' | ') || '干净');
}

/* ---- ④ 元守卫：本文件自己也得被引用 ---- */
t('本守卫自身也被 npm script 引用（不然它也会变成孤儿）',
  scriptText.includes('test-registry-test.mjs'),
  scriptText.includes('test-registry-test.mjs') ? '已注册' : '未注册 —— 请加 test:registry');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
