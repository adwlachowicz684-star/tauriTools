/**
 * 体检单覆盖守卫：被 sweep 静默漏掉的 test: 脚本，必须有账
 * =========================================================
 * 起因（代码梳理实测）：
 *   package.json 有 275 条 test: 脚本，sweep-tests.mjs 的 filter1 收 274 条，
 *   静默漏掉 1 条：
 *       test:af = bash plugins/agent-flow/scripts/run-tests.sh
 *   正则 /\.mjs|\.cjs|\.tsx?/ 只认 node 直跑的脚本，.sh 一律不匹配。
 *   而这条背后是 plugins/agent-flow/tests/ 下 133 个 .test.ts（此前实测
 *   2874 项断言）—— 体检单上完全看不见它们。
 *
 *   更隐蔽的是：test-registry-test.mjs 第 ①c 节**专门**守着
 *   「目录级运行器 run-tests.sh 必须被 npm script 点名」。两个守卫各管一半，
 *   中间这条缝（registry 知道它存在、sweep 不把它算进体检单）没人盯。
 *
 * ⚠️ 为什么不直接改 sweep 把它收进来：
 *   run-tests.sh 走官方 TS runner（node 20 认不出 .test.ts，要先用项目自己的
 *   typescript 编译），而环境反复被清、编译依赖不稳。硬收进 sweep 会让体检单
 *   从「稳定全绿」变成「每次跑都有一片环境假红」，反而没人看了。
 *   cwd-invariant-test.mjs 的文件头也是同样理由明确排除 bash 类。
 *   所以这里**只记账、不改判据**：漏网事实被钉住，等 run-tests.sh 有了稳定的
 *   汇总输出再销账。这是本项目「白名单 = 欠账台账」的既有手法。
 *
 * ⚠️ 本守卫刻意不 spawn 子进程：sweep-tests.mjs 的 isMetaTest 用
 *   「spawn + .scripts + test: 前缀」三条件形态判定来排除会展开全部测试的
 *   元测试。本文件只读文件、不 spawn，因此会被 sweep 当普通测试正常收进去。
 *
 * ⚠️ 已知边界（破坏验证实测，不藏着）：
 *   把 ② 的判据**人为替换成字面量 true**，本守卫会 12/0 全绿 —— 元断言 E/F
 *   测的是 coverageOk 这个函数，不是 ② 有没有真的调它。任何纯静态守卫都
 *   挡不住「把断言删掉」这种改写，这一层靠每次改动时人做的破坏验证兜，
 *   不靠守卫自证。判据**写歪**（恒匹配 / 台账清空 / 新增漏网）则 ①②⑤ 都会喊，
 *   已逐向实测（见任务清单）。
 *
 * 运行：node test-coverage-guard-test.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectTestFiles } from './scripts/retired-guard-baseline.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const sweepSrc = readFileSync(join(ROOT, 'sweep-tests.mjs'), 'utf8');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

/* ---------------- ① 判据不许漂移 ----------------
 * 不与 sweep 共用实现（它没导出），而是把它 filter1 那行的原样文本当锚点。
 * sweep 改了这条正则 → 这里立刻红，逼着同步本守卫；否则本守卫算出来的
 * 「漏网集合」和 sweep 真实收的集合会各走各的，而两边都不报错。
 */
const NEEDLE = String.raw`/\.mjs|\.cjs|\.tsx?/.test(v)`;
const re = new RegExp(String.raw`\.mjs|\.cjs|\.tsx?`);
t('① 锚点命中：sweep 的 filter1 判据仍是那一条（改名/重写会被喊）',
  sweepSrc.includes(NEEDLE),
  sweepSrc.includes(NEEDLE) ? '' : 'sweep 里的判据文本变了，本守卫的漏网集合已不可信');

/** 计算「会被 sweep filter1 排除的 test: 脚本」。re 可注入，供元断言自检。 */
const leakedWith = (scripts, rx) => Object.entries(scripts)
  .filter(([k]) => k.startsWith('test:'))
  .filter(([, v]) => !rx.test(v))
  .map(([k]) => k)
  .sort();

/* ---------------- ② 台账：漏一条记一条 ----------------
 * 白名单不是豁免，是欠账。修好一条 → 实际漏网少一条 → 主断言红，逼你销账；
 * 新漏一条 → 实际多一条 → 同样红。两条方向都喊得出声。
 */
/**
 * 台账已销账：136 条指向已退场插件目录的死 script 从 package.json 移除，
 * `test:af` 连同 run-tests.sh、133 个 .test.ts 一起迁到独立仓。
 * sweep filter1 现在收齐全部 `test:` 脚本，漏网集合为空 —— ② 绿是**真绿**，
 * 不是「把台账清空换来的绿」：④ 会钉住销账前提，⑤ 的元断言仍逐向验判据。
 */
const KNOWN = [];

const realLeaked = leakedWith(pkg.scripts, re);
const knownKeys = KNOWN.map((x) => x.key).sort();
/** ② 与元断言 E/F 共用同一份判据：分着写两份会各改各的，一边敏感一边不敏感。 */
const coverageOk = (scripts, rx, keys) =>
  JSON.stringify(leakedWith(scripts, rx)) === JSON.stringify(keys);
t('② 漏网集合恰为台账（多漏一条 / 修好一条都要喊）',
  coverageOk(pkg.scripts, re, knownKeys),
  `实际 ${JSON.stringify(realLeaked)} / 台账 ${JSON.stringify(knownKeys)}`);

/* ---------------- ③ 台账本身不能是空壳 ---------------- */
for (const item of KNOWN) {
  t(`③ 台账条目 ${item.key} 真实存在于 scripts（不能靠加假条目消红）`,
    Object.hasOwn(pkg.scripts, item.key));
  t(`③ 台账条目 ${item.key} 有 why 与 unblock（记了就得说清怎么销）`,
    typeof item.why === 'string' && item.why.length > 20
    && typeof item.unblock === 'string' && item.unblock.length > 20);
}

/* ---------------- ④ 销账前提确实成立（不是把 runner 删了蒙混过关） --------
 * 退场态下 runner 与 .test.ts 都不在主仓，这里改钉三件事：
 * script 真的删了、源码目录真的迁出了、主仓真的不再残留 .test.ts。
 * 任何一条不成立，都说明「台账清空」不是销账而是把证据抹掉了。
 */
t('④ 销账前提：test:af 已从主仓 scripts 移除', !Object.hasOwn(pkg.scripts, 'test:af'));
t('④ 销账前提：agent-flow 源码目录确已迁出（不是把 runner 删了）',
  !existsSync(join(ROOT, 'plugins', 'agent-flow', 'index.html')));
const tsLeft = collectTestFiles(ROOT).tsOnDisk.length;
t('④ 销账前提：主仓不再残留 .test.ts（整批随源码迁出）', tsLeft === 0,
  `实得 ${tsLeft}`);

/* ---------------- ⑤ 元断言：判据不能是摆设 ----------------
 * 本项目反复栽的形状：判据恒真/恒假时主断言照样全绿，只有配对样本喊得出声。
 * 这里三个方向都钉：能分辨 bash 与 node、恒匹配会漏成空、恒不匹配会泛滥。
 */
const SAMPLE = {
  'test:node': 'node a-test.mjs',
  'test:bash': 'bash plugins/agent-flow/scripts/run-tests.sh',
  build: 'vite build',           // 非 test: 前缀，不该被算进来
};
t('⑤ 元断言 A：样本里恰好只把 bash 那条判为漏网（判据能分辨）',
  JSON.stringify(leakedWith(SAMPLE, re)) === JSON.stringify(['test:bash']),
  JSON.stringify(leakedWith(SAMPLE, re)));
t('⑤ 元断言 B：判据改成恒匹配时漏网为空（A 不是恒真）',
  leakedWith(SAMPLE, /.*/).length === 0);
t('⑤ 元断言 C：判据改成恒不匹配时连 node 测试也算漏网（A 不是恒假）',
  leakedWith(SAMPLE, /(?!)()/).length === 2,
  String(leakedWith(SAMPLE, /(?!)()/).length));
t('⑤ 元断言 D：非 test: 前缀的脚本不进漏网集合（别把 build 也算进去）',
  !leakedWith(SAMPLE, /(?!)()/).includes('build'));
t('⑤ 元断言 E：同一判据对「新增一条漏网」返回 false（不是恒真）',
  coverageOk({ ...pkg.scripts, 'test:__probe_leak': 'bash x.sh' }, re, knownKeys) === false);
/* 台账本身已经为空，再拿「台账清空」当坏样本就没有区分力了
   （空 vs 空 → true）。改成注入一条真漏网：空台账下判据必须喊。 */
t('⑤ 元断言 F：台账为空时注入一条漏网，判据返回 false（不是恒真）',
  coverageOk({ ...pkg.scripts, 'test:__probe_leak2': 'bash y.sh' }, re, []) === false);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
