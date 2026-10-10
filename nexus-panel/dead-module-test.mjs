/**
 * 死模块守卫：js/ 下"没有任何生产入口能到达"的模块，必须是显式的、带理由的白名单。
 * ============================================================
 * 要防的形状：**测试全绿，但测的是一个生产里根本没接上的模块**。
 *
 * 这比单条恒真断言更隐蔽 —— 单条断言至少还有一行代码可查，而这里
 * 是一整个模块 + 若干测试文件一起"看起来有覆盖"。套件数、断言数都在涨，
 * 信心却是假的：模块改坏了测试照样红，可模块**根本没被用**，红不红都无所谓。
 *
 * 判据为什么不能用"有没有人 import 它"就算了：
 *   · 测试文件自己也会 import 被测模块 —— 那样每个模块都"有人 import"，判定恒真；
 *   · 模块之间还会互相 import —— 只看直接引用会把"被 React 版间接用着的内核"
 *     误判成死的（js/drag-reorder.js 就是这样：只有 drag-reorder-react.js 引它，
 *     而后者被 plugins/settings/App.tsx 用着）。
 * 所以这里做的是**从生产入口出发的传递可达性**，并且把 js/ 内部的边也算进去。
 *
 * 白名单不是"免死金牌"：每一项都必须给出理由，且理由本身要能被验证 ——
 * 否则白名单会膨胀成"反正加一行就绿了"，那这文件也就白写了。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join as pjoin, relative, basename } from 'node:path';

const HERE = process.cwd();
let pass = 0;
const fails = [];
const t = (name, cond, extra = '') => {
  if (cond) pass++;
  else fails.push(`${name}${extra ? ' → ' + extra : ''}`);
};
const read = (p) => readFileSync(p, 'utf8');

/* ---------- 白名单：不可达模块 + 理由 + 验证方式 ---------- */
/* 每一项都要能回答："它凭什么还留着？" 且这个回答要能被下面的断言查到。 */
const ALLOW = {
  'dead-class-scan.js': {
    kind: 'devtool',
    why: '开发期扫描工具：被多个测试 import 后当作工具函数调用，不是给生产用的',
  },
  'theme-normalizer.js': {
    kind: 'dead-feature',
    why: '「采样→滤镜反转」那套适配已废弃（见 js/themes.js 顶部注释），'
       + '宿主改为把变量推到哪、插件就渲染到哪。模块本身没有生产消费者，'
       + '而它的两个测试（adapt / adapt-sequential）因此测的是死代码。'
       + '待确认后连模块、两个测试与 .nexus-tone-overlay / .nexus-adapted 一起删。',
  },
};

/* ---------- 收集文件 ---------- */
const SKIP = new Set(['node_modules', '.git', '.tool_output', 'dist', 'target', '.next']);
const EXTS = new Set(['.js', '.mjs', '.ts', '.tsx', '.html']);
const isTestFile = (rel) => {
  const n = basename(rel);
  return n.endsWith('-test.mjs') || n.endsWith('.test.ts') || n.endsWith('.test.js');
};

const jsModules = readdirSync('js').filter((f) => f.endsWith('.js')).sort();
const prod = [];   // 生产（非测试）文件
const tests = [];  // 测试文件

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = pjoin(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { walk(p); continue; }
    if (!EXTS.has(name.slice(name.lastIndexOf('.')))) continue;
    const rel = relative(HERE, p);
    if (rel.startsWith('js' + '/')) continue;      // js/ 单独处理
    let txt;
    try { txt = read(p); } catch { continue; }
    (isTestFile(rel) ? tests : prod).push([rel, txt]);
  }
}
walk(HERE);

console.log('=== 1. 扫描范围自检 ===');
t('扫到了 js/ 下的模块', jsModules.length > 0, `实测 ${jsModules.length} 个`);
t('扫到了生产文件', prod.length > 0, `实测 ${prod.length} 个`);
t('扫到了测试文件', tests.length > 0, `实测 ${tests.length} 个`);

/* ---------- js/ 内部的依赖边 ---------- */
const modSet = new Set(jsModules);
const edges = new Map();
let edgeCount = 0;
for (const f of jsModules) {
  const txt = read(pjoin('js', f));
  const deps = new Set();
  for (const m of txt.matchAll(/from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\)|import\s+['"]([^'"]+)['"]/g)) {
    const spec = m[1] || m[2] || m[3];
    if (!spec || !spec.startsWith('.')) continue;
    const target = basename(spec);
    if (modSet.has(target) && target !== f) deps.add(target);
  }
  edges.set(f, deps);
  edgeCount += deps.size;
}
t('解析到了 js/ 内部的依赖边（否则可达性退化成"只看直接引用"）',
  edgeCount > 0, `实测 ${edgeCount} 条`);

/* ---------- 生产入口：非测试文件里直接引用了哪些 js 模块 ---------- */
const refPat = (stem) => new RegExp(`js[/\\\\]${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.js)?['"]`);
const entry = new Set();
for (const [rel, txt] of prod) {
  for (const f of jsModules) if (refPat(f.slice(0, -3)).test(txt)) entry.add(f);
}
t('生产入口集合非空（空了则"全部不可达"是空跑）', entry.size > 0, `实测 ${entry.size} 个`);
/* 传递性必须真的在用：drag-reorder.js 只被同目录的 drag-reorder-react.js 引，
   后者才被 plugins/settings/App.tsx 引 —— 它不在 entry 里却在 reachable 里。
   若哪天可达性退化成"只看直接引用"，这里会立刻红。 */
t('可达性确实传递（drag-reorder.js 靠同目录的 react 版间接活着）',
  !entry.has('drag-reorder.js'), '若它进了 entry 说明这条钉子该换了');

/* ---------- 传递可达性 ---------- */
const seen = new Set();
const stack = [...entry];
while (stack.length) {
  const n = stack.pop();
  if (seen.has(n)) continue;
  seen.add(n);
  for (const d of edges.get(n) || []) stack.push(d);
}
const unreachable = jsModules.filter((f) => !seen.has(f));

console.log('=== 2. 不可达模块必须都在白名单里 ===');
const notAllowed = unreachable.filter((f) => !ALLOW[f]);
t('没有白名单之外的新增死模块', notAllowed.length === 0, notAllowed.join('、'));
t('不可达清单与白名单对得上（多了少了都要报）',
  unreachable.length === Object.keys(ALLOW).length
    && unreachable.every((f) => ALLOW[f]),
  `不可达 [${unreachable.join('、')}] vs 白名单 [${Object.keys(ALLOW).join('、')}]`);

console.log('=== 3. 白名单的理由必须能被验证（防止"加一行就绿"）===');
for (const [f, info] of Object.entries(ALLOW)) {
  t(`${f} 的理由非空且说明了性质`, !!info.why && info.why.length > 20 && !!info.kind);
  const importersInTests = tests.filter(([, txt]) => refPat(f.slice(0, -3)).test(txt)).map(([r]) => r);
  if (info.kind === 'devtool') {
    /* 声称"是测试用的工具" —— 那就必须真有测试在 import 它，
       否则它既没有生产消费者也没有测试消费者，连工具都算不上。 */
    t(`${f} 确被测试当作工具 import（理由成立）`, importersInTests.length > 0,
      importersInTests.join('、') || '无');
  } else {
    /* 声称"是废弃特性" —— 那就必须真没有生产消费者。
       哪天有人把它接回生产，这条会红，提醒把白名单项删掉（它不再该豁免）。 */
    const prodRefs = prod.filter(([, txt]) => refPat(f.slice(0, -3)).test(txt)).map(([r]) => r);
    t(`${f} 确实没有生产消费者（理由成立）`, prodRefs.length === 0, prodRefs.join('、'));
    /* 并且它应当至少还有测试在 import —— 否则连"死代码还有测试在测"这层假象都没有，
       那就是彻底的孤儿文件，直接删掉即可，不该占着白名单。 */
    t(`${f} 仍有测试在 import（说明"假绿"风险真实存在）`, importersInTests.length > 0,
      importersInTests.join('、') || '无');
  }
}

console.log('=== 4. 废弃判据要有据可查（不是我觉得它死了）===');
const themes = read(pjoin('js', 'themes.js'));
t('js/themes.js 里写明了"采样→反转"那套已废弃',
  /theme-normalizer\.js/.test(themes) && /已废弃/.test(themes.slice(Math.max(0, themes.indexOf('theme-normalizer.js') - 400), themes.indexOf('theme-normalizer.js') + 400)));
const host = read(pjoin('js', 'host.js'));
t('host.js 里没有 import 它（曾经有 reportBase 那条线）',
  !refPat('theme-normalizer').test(host));
const sdk = read(pjoin('js', 'plugin-sdk.js'));
t('plugin-sdk.js 里没有 import 它', !refPat('theme-normalizer').test(sdk));

console.log('=== 5. 已知死模块的测试已登记（红在明处，不藏着）===');
const pkg = read('package.json');
const scripts = JSON.parse(pkg).scripts;
/* 未登记 = 这个测试等于没写。上一轮正是把它们从"孤儿"补登记进来的。 */
t('adapt-test 已登记', !!scripts['test:adapt'], scripts['test:adapt'] || '未登记');
t('adapt-sequential-test 已登记', !!scripts['test:adapt-sequential'], scripts['test:adapt-sequential'] || '未登记');

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) for (const f of fails) console.log('  ❌ ' + f);
process.exit(fails.length ? 1 : 0);
