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

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (EXTS.test(e.name)) {
      out.push(path.join(dir, e.name));
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

for (const f of walk(PLUGINS)) {
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

console.log(`扫了 ${files} 个文件\n`);

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

/* ---------------- 解析错误 ---------------- */
if (errors.length) {
  console.log(`\n⚠️  解析失败 ${errors.length} 个（**这些文件没被真正扫描**，不能当"没问题"）：`);
  for (const e of errors.slice(0, 10)) console.log(`   ${e.file} — ${e.error}`);
}

console.log(`\n结论：deny ${deny.length} / review ${review.length} / 解析失败 ${errors.length}`);
process.exit(deny.length ? 1 : 0);
