/**
 * 扫描：插件实际调用的 ctx.invoke 命令 vs 白名单声明
 * ============================================================
 * 白名单是手写的，最容易出的错是**漂移**：
 *   · 插件新增了调用，忘了补白名单 → 运行时被拒，表现为"点了没反应"
 *   · 白名单里留着已删的调用 → 权限越攒越多，安全水位悄悄下降
 *
 * 所以两边都要扫，双向比对。
 *
 * 用法：node scripts/scan-invoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsJs } from '../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PLUGINS = path.join(ROOT, 'plugins');

/*
 * 匹配命令调用的字面量。要覆盖两种写法：
 *   · ctx.invoke('fpx_x') / ctx.invoke<T>('fpx_x')   —— 直接调
 *   · call<T>('fpx_x')                                —— 插件内的薄封装
 *     （project-group 把所有调用收在 api.ts 里，全走 call<T>，
 *      只认 invoke 的话它整个插件会被扫成"零调用"，
 *      于是白名单里 34 条全被判成"冗余" —— 假结论。）
 *
 * 只认字符串字面量：动态拼接的命令名扫不到，那类一律按"需人工确认"处理。
 */
const RE = /\b(?:ctx\.)?(?:invoke|call)(?:<[^>]*>)?\(\s*['"`]([a-z_][a-z0-9_]*)['"`]/g;

/** 递归取插件目录下所有源码文件 */
function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'editor' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|ts|tsx|html)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** 实测：每个插件真实出现的命令 */
const actual = {};
for (const d of fs.readdirSync(PLUGINS, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const id = d.name;
  const found = new Set();
  for (const f of walk(path.join(PLUGINS, id))) {
    const txt = fs.readFileSync(f, 'utf8');
    for (const m of txt.matchAll(RE)) found.add(m[1]);
  }
  if (found.size) actual[id] = [...found].sort();
}

/**
 * 声明：白名单里写的。
 *
 * 直接 import，而不是正则去抠源码 ——
 * 我第一版用正则按缩进切段，结果 4 空格缩进的条目每一行都被切开，
 * 多行的 agent-flow 整个抠不到，白名单形同没写。
 * 这是"验证工具自己错了"的典型：它会让"未登记"看起来像真实结论。
 */
const { PLUGIN_COMMANDS } = await import('../js/invoke-policy.js');
const declared = {};
for (const [id, list] of Object.entries(PLUGIN_COMMANDS)) {
  declared[id] = [...list].sort();
}

/**
 * Rust 侧**已注册**的命令全集（从 main.rs 的 generate_handler! 抠）。
 *
 * 用它做过滤器：只有在这个集合里的字符串才算"命令调用"。
 * 否则 `call('save')` / `call('list')` 这类插件内部函数会被误判成命令
 * （settings 里就有，第一版报了一堆假"缺失"）。
 *
 * 顺带还能抓到另一类问题：声明了但**根本没注册**的命令 ——
 * 比如 agent-flow 调的 af_fs_tail，后端压根没有，是死调用。
 *
 * ⚠️ 必须先剥注释再解析：generate_handler! 块里带块注释形态的说明段，
 * 不剥的话星号、'"command' 这类注释碎片会被当成命令名收进集合 ——
 * 实测原版解析出 281 个"命令"，里面混着一堆注释残渣。
 * 集合被污染 = 过滤器形同虚设（什么名字都可能"已注册"）。
 */
/*
 * 用**共用实现**，不在这里另写一份。
 * 自己那份（裸 `//` 判据）有两个问题：
 *   ① 又多一份内联副本（剥注释只此一份，见 dead-class 守卫）
 *   ② 裸 `//` 会把 `https://`、`file://` 从斜杠处起**整行后半截吞掉** ——
 *      扫到含 URL 的文件时，解析的是一段被截断的文本（可能假绿）。
 *      共用实现的行注释判据是 `(^|\s)//`，既安全又不漏。
 */
function registeredCommands() {
  const p = path.join(ROOT, 'src-tauri/src/main.rs');
  if (!fs.existsSync(p)) return null;
  const txt = stripCommentsJs(fs.readFileSync(p, 'utf8'));
  const m = txt.match(/generate_handler!\[([\s\S]*?)\]/);
  if (!m) return null;
  const out = new Set();
  for (const tok of m[1].split(/[\s,]+/)) {
    const name = tok.trim().replace(/^.*::/, '');   // fpx::fpx_bootstrap → fpx_bootstrap
    if (/^[a-z_][a-z0-9_]*$/.test(name)) out.add(name);
  }
  return out;
}
const REGISTERED = registeredCommands();
if (REGISTERED) {
  for (const id of Object.keys(actual)) {
    const kept = actual[id].filter((c) => REGISTERED.has(c));
    actual[id] = kept;
    if (!kept.length) delete actual[id];
  }
}

/* ---------------- 双向比对 ---------------- */

/**
 * 内置插件 id（registry.js 静态清单）。
 *
 * ⚠️ 这条是本节成立的前提：**内置插件全权限放行**（checkInvoke 第 2 级，
 * 见 js/invoke-policy.js，且 invoke-policy-test.mjs 里有对应断言）。
 * 也就是说 PLUGIN_COMMANDS 对内置插件**不参与放行判定**——
 * 它们调任何已注册命令都会通过。
 *
 * 本扫描器写在那次契约变更**之前**，把"内置插件的 缺失/冗余"也当错误报。
 * 于是它现在稳定输出 32 处差异，而这些差异一条都不构成运行时缺陷 ——
 * 谁照着去"修"，改的是一份已经不参与判定的清单。
 *
 * 所以按内置/第三方分开：
 *   · 内置  —— 仍打印（清单一旦重新参与判定，这些就是真缺口），但不算错误
 *   · 第三方 —— 逐条严格，缺失/冗余都算错误（这一档是唯一的闸）
 */
function builtinIds() {
  const p = path.join(ROOT, 'plugins', 'registry.js');
  if (!fs.existsSync(p)) return new Set();
  const txt = fs.readFileSync(p, 'utf8');
  return new Set([...txt.matchAll(/id:\s*['"]([^'"]+)['"]/g)].map((m) => m[1]));
}
const BUILTIN = builtinIds();

const problems = [];   // 真正会让功能失效或安全水位下降的
const advisory = [];   // 内置插件的清单漂移：不参与放行，但值得看见

for (const [id, cmds] of Object.entries(actual)) {
  const has = declared[id];
  if (!has) {
    (BUILTIN.has(id) ? advisory : problems).push(
      `${BUILTIN.has(id) ? '[内置·未登记]' : '[未登记]'} 插件 ${id} 调用了命令但未在白名单登记：${cmds.join(', ')}`);
    continue;
  }
  for (const c of cmds) {
    if (!has.includes(c)) {
      (BUILTIN.has(id) ? advisory : problems).push(
        `${BUILTIN.has(id) ? '[内置·缺失]' : '[缺失]'} ${id} 实际调用 ${c}，白名单未声明`);
    }
  }
}
for (const [id, cmds] of Object.entries(declared)) {
  const used = actual[id] || [];
  for (const c of cmds) {
    if (!used.includes(c)) {
      (BUILTIN.has(id) ? advisory : problems).push(
        `${BUILTIN.has(id) ? '[内置·冗余]' : '[冗余]'} ${id} 声明了 ${c}，但源码里没找到调用`);
    }
  }
}

console.log('实测调用：');
for (const [id, cmds] of Object.entries(actual)) {
  console.log(`  ${id.padEnd(16)} ${cmds.length} 个`);
}
console.log('\n白名单声明：');
for (const [id, cmds] of Object.entries(declared)) {
  console.log(`  ${id.padEnd(16)} ${cmds.length} 个`);
}

/* 声明了但后端根本没注册 —— 死调用，白名单不该留 */
if (REGISTERED) {
  for (const [id, cmds] of Object.entries(declared)) {
    for (const c of cmds) {
      if (!REGISTERED.has(c)) problems.push(`[未注册] ${id} 声明了 ${c}，但 Rust 侧没有这个命令（死调用）`);
    }
  }
}

if (advisory.length) {
  console.log(`\n提示（内置插件的清单漂移，当前**不参与放行判定**，故不算错误）${advisory.length} 处：`);
  for (const p of advisory) console.log('  ' + p);
}

if (problems.length) {
  console.log('\n差异：');
  for (const p of problems) console.log('  ' + p);
  console.log(`\n共 ${problems.length} 处`);
} else {
  console.log('\n✓ 实测与声明完全一致（第三方插件逐条严格；内置插件的清单漂移见上方提示）');
}

/* 退出码：有差异就非 0，方便进 CI */
process.exit(problems.length ? 1 : 0);
