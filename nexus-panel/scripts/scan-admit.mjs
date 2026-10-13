/**
 * 扫描全部插件源码 → 静态准入报告（分诊队列）
 * ============================================================
 * 这是白名单体系的**入口**：
 *   · deny   —— 不可撤销，必须拒绝嵌合（出现即退出码非 0）
 *   · review —— 静态可判定但**不该直接做**（应走 owned 通道），
 *               不阻断，作为"待分类队列"输出，供逐步归类
 *
 * 用法：node scripts/scan-admit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/*
 * 动态 import + 友好报错。
 *
 * 直接静态 import 的话，缺依赖时会甩一堆栈，
 * 而"跑不起来"和"扫出来没问题"在退出码上很容易被混淆 ——
 * 后者会让人误以为插件都干净。
 */
let scanFileText;
try {
  ({ scanFileText } = await import('../js/plugin-admit.js'));
} catch (e) {
  /*
   * 提示文案要跟着解析器走。改用 typescript 后这里还写着 acorn/esbuild ——
   * 真缺依赖时看到的是一条**指错方向**的提示（又一处"说明落后于实现"）。
   */
  console.error('❌ 静态准入扫描无法启动：缺少 typescript');
  console.error('   它是项目已有的 devDependency，先 npm install 再跑。');
  console.error('   原始错误:', e.message);
  process.exit(2);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PLUGINS = path.join(ROOT, 'plugins');

/*
 * 排除目录：
 *   · editor / dist / node_modules —— 第三方或产物，不是本项目的源码，
 *     扫它们会得到一堆与决策无关的结果（kityminder 必然命中）。
 *     第三方库的处理方式是"整体留 iframe"，不是逐条归类。
 *   · tests / scripts —— 不参与运行时加载
 */
const SKIP_DIRS = new Set([
  'node_modules', 'dist', 'editor', 'build', '.git',
  'tests', 'scripts', '__tests__',
]);
const EXTS = /\.(js|mjs|cjs|ts|tsx|jsx|html)$/;

/*
 * 测试脚手架**按文件名**排除，不能只靠上面的目录名。
 *
 * 本项目的测试不是集中在一个 tests/ 里，而是**散落在各插件根目录** ——
 * plugins/mindmap/mindmap-test.mjs 是 1MB 的测试，和插件源码同层（实测
 * plugins/ 下有 129 个 *-test.mjs）。所以只按目录排除时，那条规则一条都没生效。
 *
 * 后果是它稳定输出 18 条 deny，全部集中在 mindmap-test.mjs：测试为了在
 * node 里模拟浏览器，必须去改原型、桩掉 location/click —— 这些在运行时源码
 * 里是 deny（全局生效、影响别的插件），在测试里却是**唯一可行的做法**。
 *
 * 这类漏网的形状很好认：**真违规不会整整齐齐集中在同一个测试文件里**。
 * 看一眼 deny 的文件名分布就能分辨，靠"逐条去改测试"是改不完的。
 *
 * ⓘ 已核实：plugins/ 下没有任何 *-test.mjs 被 registry.js 或 html 当成
 *   插件入口加载（registry.js 里出现的三处都只在注释里），所以排除它们
 *   不会漏掉任何真正会被加载的代码。
 */
const TEST_FILE = /(-test\.mjs$|-test\.js$|-test\.tsx?$|\.test\.[cm]?[jt]sx?$)/;

function walk(dir, out = [], skipped = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out, skipped);
    } else if (EXTS.test(e.name)) {
      (TEST_FILE.test(e.name) ? skipped : out).push(path.join(dir, e.name));
    }
  }
  return out;
}

/** 从 html 里抠出内联脚本（外链 src 的不扫，那是另一个加载单元） */
function inlineScripts(code) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const m of code.matchAll(re)) {
    if (/\bsrc\s*=/.test(m[1] || '')) continue;
    out.push(m[2]);
  }
  return out;
}

const deny = [];
const review = [];
const errors = [];
let files = 0;

const skipped = [];
for (const f of walk(PLUGINS, [], skipped)) {
  files += 1;
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const raw = fs.readFileSync(f, 'utf8');
  const chunks = f.endsWith('.html') ? inlineScripts(raw) : [raw];
  for (const code of chunks) {
    if (!code || !code.trim()) continue;
    const r = scanFileText(code, rel);
    if (r.error) errors.push({ file: rel, error: r.error });
    deny.push(...r.deny);
    review.push(...r.review);
  }
}

console.log(`扫了 ${files} 个文件（另有 ${skipped.length} 个测试脚手架已排除）\n`);

/* ---------------- deny ---------------- */
if (deny.length) {
  console.log(`🔴 拒绝（不可撤销，必须处理）${deny.length} 条：`);
  for (const d of deny) console.log(`   [${d.rule}] ${d.file}:${d.line}  ${d.detail}`);
} else {
  console.log('🔴 拒绝项：无');
}

/* ---------------- review（分诊队列）---------------- */
const byRule = new Map();
for (const r of review) {
  if (!byRule.has(r.rule)) byRule.set(r.rule, []);
  byRule.get(r.rule).push(r);
}
console.log(`\n🟡 待分类队列 ${review.length} 条（不阻断，供逐步归类）：`);
for (const [rule, list] of [...byRule.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`   ${rule.padEnd(22)} ${list.length} 条  例：${list[0].file}:${list[0].line}`);
}

/* ---------------- 自检：排除判据不能失效、也不能过宽 ---------------- */
/*
 * 少了这两条，把 TEST_FILE 改成「什么都不排除」或「什么都排除」，
 * 报告照样能打印出来：前者是又一批 18 条假拒绝，后者是 files=0 的假绿。
 */
const selfFails = [];
/*
 * ⓘ 两条都**只看结果、不再拿 TEST_FILE 去判一遍**。
 *   第一版写的是「deny 里有没有来自测试文件的条目」—— 用 TEST_FILE 自己
 *   去判，于是判据被改成永不匹配时它**跟着一起瞎**（破坏验证实测没报）。
 *   这正是本项目反复撞的形状：拿被检查的东西去检查它自己。
 */
if (skipped.length === 0) {
  selfFails.push('没有任何测试文件被排除 —— 排除判据失效，deny 会重新被测试脚手架淹没');
}
if (files === 0) selfFails.push('没有任何文件被真正扫描 —— 排除判据过宽');
if (selfFails.length) {
  console.log(`\n❌ 自检失败 ${selfFails.length} 条：`);
  for (const s of selfFails) console.log(`   ${s}`);
}

/* ---------------- 解析错误 ---------------- */
if (errors.length) {
  console.log(`\n⚠️  解析失败 ${errors.length} 个（**这些文件没被真正扫描**，不能当"没问题"）：`);
  for (const e of errors.slice(0, 10)) console.log(`   ${e.file} — ${e.error}`);
}

console.log(`\n结论：deny ${deny.length} / review ${review.length} / 解析失败 ${errors.length}`);

/*
 * 汇总行 —— 体检（sweep-tests.mjs）靠它判断"这个脚本到底跑完没有"。
 * 没有它时退出码 0 也会被判成「可疑」，而"扫出来没问题"和"根本没扫"
 * 在退出码上是一样的。
 *
 * 一"项" = 一个被真正扫描的文件；文件里出现 deny 或解析失败记 1 项失败。
 */
const badFiles = new Set([
  ...deny.map((d) => d.file),
  ...errors.map((e) => e.file),
]);
const passItems = Math.max(0, files - badFiles.size);
console.log(`通过 ${passItems} 项，失败 ${badFiles.size + selfFails.length} 项`);
process.exit(deny.length || selfFails.length ? 1 : 0);
