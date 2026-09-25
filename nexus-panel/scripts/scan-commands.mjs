#!/usr/bin/env node
/**
 * 命令一致性扫描器
 * ==================
 * 三份"命令清单"互相对账：
 *
 *   A. generate_handler!  —— **唯一真相源**。没进这里 = 前端调不通
 *   B. #[tauri::command]  —— 只是标注，不等于注册
 *   C. invoke-policy.js   —— 前端白名单
 *
 * ⚠️ 为什么 A 是真相源而不是 B
 * 实测踩过：af_device_salt / af_fs_tail 都有 #[tauri::command]、
 * 都有函数体，但**没进 generate_handler!** —— 看着是命令，实际调不通。
 * 若拿 B 当准，就会往白名单里补进两条永远失败的命令，
 * 表现是"有权限但调用失败"，比明确拒绝更难排查。
 *
 * 用法：node scripts/scan-commands.mjs          （人看）
 *       npm run scan:commands -- --strict       （CI：有问题就退出码 1）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
/*
 * 能力表是**可选依赖**：加载失败就跳过能力画像，
 * 但①②③ 那些核心对账必须照常跑完。
 * 硬依赖的话，一个增值功能的缺失会拖垮整个扫描器 ——
 * 而它偏偏是安全扫描，静默不跑比报错更糟。
 */
let CAPS = null;
try {
  CAPS = await import('../js/command-caps.js');
} catch (e) {
  console.warn('⚠ 未加载 command-caps.js，跳过能力画像：', e?.message || e);
}
const { capsOf, worstLevel, capOf, COMMAND_CAPS } = CAPS || {
  capsOf: () => ({ counts: {}, levels: [], unknown: [], combos: [] }),
  worstLevel: () => 'none',
  capOf: () => 'unknown',
  COMMAND_CAPS: {},
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rsRoot = path.join(root, 'src-tauri', 'src');
const mainRs = path.join(rsRoot, 'main.rs');
const policy = path.join(root, 'js', 'invoke-policy.js');

/* ---------------------------------------------------------------- */
/* 1. 扫 Rust 源文件                                                  */
/* ---------------------------------------------------------------- */

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.rs')) out.push(p);
  }
  return out;
}

/** B：所有带 #[tauri::command] 的函数名 -> 文件 */
function collectAnnotated(files) {
  const map = new Map();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    /* 逐行扫：属性紧贴下一行的 fn（中间允许注释/文档注释） */
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      /*
       * 必须同时认 `#[tauri::command]` 和
       * `#[tauri::command(rename_all = "snake_case")]`。
       * 只写前一种的话，仓库里 47 条带参数的会被当成"没标注"，
       * 于是刷出一大片"注册了但没标注"的假报告 —— 报告一多就没人看了。
       */
      /*
       * 三种写法都要认：
       *   #[tauri::command]
       *   #[tauri::command(rename_all = "snake_case")]   ← 仓库里 47 条
       *   #[tauri::command(async)]
       * 只认第一种的话，47 条会被当成"没标注"，刷出一大片假报告。
       */
      if (!/^\s*#\[tauri::command\s*(?:\([^)]*\))?\s*\]/.test(lines[i])) continue;
      /* 往下找最近的 pub fn / fn（跳过注释与属性） */
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j += 1) {
        const l = lines[j];
        if (/^\s*(\/\/|\/\*|\*)/.test(l)) continue;
        if (/^\s*#\[/.test(l)) continue;
        /*
         * 必须允许 `pub async fn`。
         * 漏掉 async 的话，5 条 async 命令被当成"没标注"——
         * 假报告混进来，真问题（①）就被稀释了。
         */
        const m = l.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z_0-9]+)/);
        /*
         * 同名可能出现两次（两个模块各写一份）—— 记成数组，
         * 后面第 ⑤ 节专门报。这里若用 map.set 覆盖，重复就永远看不见了。
         */
        if (m) {
          const rel = path.relative(root, f);
          const cur = map.get(m[1]) || [];
          if (!cur.includes(rel)) cur.push(rel);
          map.set(m[1], cur);
          break;
        }
        break;  // 既不是注释也不是 fn → 放弃这条
      }
    }
  }
  return map;
}

/*
 * 剥注释后再解析。
 *
 * 不剥的话，块内注释里的 `#[tauri::command]` 会被当成条目
 * （split('::').pop() 得到 "command"），混进注册集合里刷假报告；
 * 更糟的是注释里出现 `generate_handler!` 字样时（本仓库 349 行就有一处），
 * 若它排在真实调用之前，正则会先匹配到注释 —— 于是扫到一段空块，
 * ① ③ 全报 0 条。那是最糟的假绿：报告说"一致"，其实压根没检查。
 */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    /* 行注释：`//` 前面不是 `:`（避免吃掉 http://） */
    .replace(/(?<![:\w])\/\/[^\n]*/g, '');
}

/** A：generate_handler![...] 里的命令名 -> 模块前缀（裸名为 ''） */
function collectRegistered(src) {
  const clean = stripComments(src);
  const m = clean.match(/generate_handler!\s*\[([\s\S]*?)\n\s*\]/);
  if (!m) return null;
  /*
   * 条目形如 `fpx::fpx_bootstrap` 或 `rust_ping`。
   * 命令名 = 最后一段（Tauri 以函数名注册，模块路径不算）。
   *
   * 同时记住**模块前缀**：带本仓库模块前缀却找不到定义的，
   * 是必然的编译错误（E0425），不能和"外部 crate 的命令"混为一谈。
   */
  const out = new Map();
  for (const raw of m[1].split(',')) {
    const x = raw.trim();
    if (!x) continue;
    /* 只认形如 mod::name 的整段：前后不能还有别的标识符/空白标识符 */
    const q = x.match(/^([A-Za-z_]\w*)::([a-z_0-9]+)$/);
    if (q) { out.set(q[2], q[1]); continue; }
    if (/^[a-z_0-9]+$/.test(x)) { out.set(x, ''); continue; }
    /* 其余（注释残留、多行片段）丢弃，别当命令 */
  }
  return out;
}

/*
 * 本仓库的模块名 + 每个模块里**所有** fn 名（不管有没有 #[tauri::command]）。
 *
 * 用来区分两种完全不同的故障：
 *   函数整个没了   → 八成是被"同步本地改动"这类提交覆盖掉的，得补回来
 *   函数还在、只是缺标注 → 新增命令时忘了加属性，补个属性就行
 * 两者修法不同，但症状一样（编译不过），混在一起报会误导排查方向。
 */
function collectModuleShape(files, rsRoot) {
  const modules = new Set();
  const fns = new Map();
  for (const f of files) {
    const rel = path.relative(rsRoot, f).replace(/\\/g, '/');
    let mod = null;
    const dm = rel.match(/^(\w+)\/.*\.rs$/);
    const fm = rel.match(/^(\w+)\.rs$/);
    if (dm) mod = dm[1];
    else if (fm && fm[1] !== 'main') mod = fm[1];
    if (!mod) continue;
    modules.add(mod);
    const set = fns.get(mod) || new Set();
    for (const mm of fs.readFileSync(f, 'utf8')
      .matchAll(/^\s*(?:pub\s+)?(?:async\s+)?fn\s+([a-z_0-9]+)/gm)) {
      set.add(mm[1]);
    }
    fns.set(mod, set);
  }
  return { modules, fns };
}

/* ---------------------------------------------------------------- */
/* 2. 扫前端白名单                                                     */
/* ---------------------------------------------------------------- */

function collectPolicy(src) {
  /* 三条来源都算：PLUGIN_COMMANDS / SAFE_COMMANDS / manifest.commands */
  const names = new Set();
  /*
   * 同时按插件分组 —— 能力画像是**按插件**看的：
   * "agent-flow 同时有 M 和 S" 才有意义，混在一起看不出来。
   */
  const byPlugin = new Map();
  /*
   * 只取**字符串字面量**里的命令名。
   * 别用 /'[a-z_0-9]+'/g 全扫 —— 注释和 HARD_DENY 示例里也有，
   * 会把"示例"当成"已放行"。
   */
  /*
   * 结尾别写死 `\n};` —— 格式化一变（或整个写在一行）就匹配不到，
   * 于是白名单被当成空的，③ 永远报 0 条。那是最糟的假绿：
   * 「看起来一致」其实压根没检查。
   */
  const m = src.match(/export const PLUGIN_COMMANDS\s*=\s*\{([\s\S]*?)\}\s*;/);
  if (m) for (const s of m[1].matchAll(/'([a-z_0-9]{3,})'/g)) names.add(s[1]);
  /*
   * 结尾的 `\)` 必须写成可选的。
   *
   * SAFE_COMMANDS 是**普通数组** `['app_version', 'rust_ping'];`；
   * 而这里原本照搬 PLUGIN_COMMANDS 那套写法要求结尾有 `)`。
   * 匹配不到就一路往后找，把后面的注释也吞进捕获组 ——
   * 于是 CAP_ENFORCEMENT 注释里的 'enforce'、'string' 被当成"白名单命令"，
   * 报出两条"有权限但 Rust 侧没注册"的假问题。
   *
   * 假报告最危险的地方不是多报，而是把真问题稀释掉。
   */
  const m2 = src.match(/export const SAFE_COMMANDS\s*=\s*(?:new Set\(\s*\[|\[)([\s\S]*?)\]\s*\)?\s*;/);
  if (m2) for (const s of m2[1].matchAll(/'([a-z_0-9]{3,})'/g)) names.add(s[1]);
  /* 解析不到就当失效 —— 静默返回空集会掩盖真实问题 */
  if (!m) {
    console.error('✗ 没解析到 PLUGIN_COMMANDS —— 扫描器失效，不要当成"没问题"');
    process.exit(2);
  }
  /* 按 `插件id: [...]` 逐块切，避免跨块串味 */
  /*
   * key 可能带引号（'agent-flow':）也可能不带（home:）。
   * 只写不带引号的版本会**静默漏掉一半插件** ——
   * 实测第一版只解析出 3 个（home/mindmap/settings），
   * 而真正的重点 agent-flow 恰恰是带引号的那个。
   * 表现是"报告看着很干净，其实漏了最该看的那个"。
   */
  for (const blk of m[1].matchAll(/'?([一-龥a-z_0-9-]+)'?\s*:\s*\[([\s\S]*?)\]/g)) {
    const id = blk[1];
    const cs = [...blk[2].matchAll(/'([a-z_0-9]{3,})'/g)].map((x) => x[1]);
    if (cs.length) byPlugin.set(id, cs);
  }
  return { names, byPlugin };
}

/* ---------------------------------------------------------------- */
/* 3. 对账                                                             */
/* ---------------------------------------------------------------- */

const files = walk(rsRoot);
const annotated = collectAnnotated(files);
const mainSrc = fs.readFileSync(mainRs, 'utf8');
const registered = collectRegistered(mainSrc);
const policySrc = fs.readFileSync(policy, 'utf8');
const { names: allowed, byPlugin: cmdsByPlugin } = collectPolicy(policySrc);

let problems = 0;
const say = (title, list, hint) => {
  if (!list.length) return;
  problems += list.length;
  console.log(`\n${title}  (${list.length})`);
  for (const x of list) console.log(`   ${x}`);
  if (hint) console.log(`   → ${hint}`);
};

if (!registered) {
  console.error('✗ 没解析到 generate_handler![...] —— 扫描器失效，不要当成"没问题"');
  process.exit(2);
}

console.log(`Rust 源文件 ${files.length} 个`);
console.log(`#[tauri::command] 标注 ${annotated.size} 条`);
console.log(`generate_handler! 注册 ${registered.size} 条`);
console.log(`前端白名单 ${allowed.size} 条`);

/* ① 标了但没注册 —— 最危险：看着是命令，实际调不通 */
const annoNotReg = [...annotated.keys()].filter((n) => !registered.has(n))
  .sort().map((n) => `${n}   ← ${annotated.get(n).join(', ')}`);
say('① 有 #[tauri::command] 但没进 generate_handler!（调不通）', annoNotReg,
  '要么补进 generate_handler!，要么删掉标注/函数 —— 不能留着骗人');

/*
 * ② 注册了但没标注。
 *
 * 以前这里统一写成"通常无害，可能是外部 crate，可以不管" ——
 * 那是**误判的根源**：fpx::fpx_mcp_register 就被这条措辞放过去了，
 * 而它带本仓库 `fpx::` 前缀、fpx 模块里根本没有这个函数，
 * 是必然的编译错误（E0425），跟"外部 crate"没有任何关系。
 *
 * 所以按"模块前缀是否属于本仓库"拆成三档，措辞分别定性。
 */
const { modules: localModules, fns: moduleFns } = collectModuleShape(files, rsRoot);
const missingFn = [];
const missingAnno = [];
const foreign = [];
for (const [n, mod] of [...registered.entries()].sort()) {
  if (annotated.has(n)) continue;
  if (!mod || !localModules.has(mod)) {
    foreign.push(mod ? `${mod}::${n}` : n);
    continue;
  }
  if (moduleFns.get(mod)?.has(n)) missingAnno.push(`${mod}::${n}`);
  else missingFn.push(`${mod}::${n}`);
}
say('②-a 注册了、模块是本仓库的、但函数整个不存在 —— cargo build 必失败', missingFn,
  '不是"可以不管"：E0425。九成是被同步类提交覆盖丢了，从备份/历史里把函数补回来');
say('②-b 函数存在但缺 #[tauri::command] 标注', missingAnno,
  '补上属性即可（macro 要求的，缺了注册不过）');
say('②-c 无前缀或外部模块 —— 才真的可以不管', foreign,
  '确认是不是外部 crate 提供的命令');

/* ③ 白名单里有但 Rust 侧没注册 —— 有权限却调不通 */
const allowNotReg = [...allowed].filter((n) => !registered.has(n)).sort();
say('③ 前端白名单里有、但 Rust 侧没注册', allowNotReg,
  '写成"有权限"却永远失败，比明确拒绝更难排查 —— 删掉或补注册');

/* ④ 注册了但白名单没放行 —— 已知现状，不算错，只做统计 */
const regNotAllow = [...registered.keys()].filter((n) => !allowed.has(n)).sort();
console.log(`\n④ 注册了但前端白名单未放行：${regNotAllow.length} 条（默认拒绝，属正常）`);
if (regNotAllow.length && process.env.VERBOSE) {
  for (const x of regNotAllow) console.log(`   ${x}`);
}

/* ⑤ 同名命令定义了多份 —— 只有一份会被注册，改错文件等于没改 */
const dups = [...annotated.entries()]
  .filter(([, fs_]) => fs_.length > 1)
  .sort()
  .map(([n, fs_]) => `${n}   ← ${fs_.join('  /  ')}`);
say('⑤ 同名命令定义了多份（只有一份会被注册）', dups,
  '改到没被注册的那份等于白改 —— 删掉多余的，或确认注册的是哪一份');

/* ⑥ .rs 文件没被 mod 声明 —— 整个文件不参与编译 */
{
  const declared = new Set();
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    /*
     * 不能用 `^` 锚定：`mod a; mod b;` 写在一行时行首锚定只认到第一个，
     * 其余文件会被误报成"没声明"。报告一有假，真问题就被稀释了。
     */
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const m of codeOnly.matchAll(/\bmod\s+([a-z_0-9]+)\s*;/g)) declared.add(m[1]);
  }
  const orphans = files
    .map((f) => path.relative(root, f))
    .filter((rel) => {
      const base = path.basename(rel, '.rs');
      if (['main', 'lib'].includes(base)) return false;
      const dir = path.dirname(rel);
      /* 子模块由父 mod.rs 里的 `mod xxx;` 声明；顶层由 main.rs 声明 */
      if (declared.has(base)) return false;
      /* dir/mod.rs 或 dir.rs 存在即视为该目录被声明 */
      return !declared.has(path.basename(dir));
    })
    .sort();
  say('⑥ .rs 文件没有对应的 mod 声明（不参与编译）', orphans,
    '整个文件都不会被编译 —— 在里面改代码不会有任何效果');
}

/* ⑥b 能力表里的死条目：写了但 Rust 侧没这个命令 */
/*
 * 表里的 key 若是笔误（或命令已改名/删除），它**永远不会被匹配到** ——
 * 于是那条命令一直挂着 unknown，看上去只是"还没归类"，
 * 实际是"分级表写错了"。这比漏一条更隐蔽：报告依然很干净。
 */
{
  const dead = Object.keys(COMMAND_CAPS).filter((c) => !registered.has(c)).sort();
  if (dead.length) {
    problems += dead.length;
    console.log(`\n⑥b 能力表里有 ${dead.length} 条命令 Rust 侧并不存在（死条目）`);
    for (const c of dead) console.log(`   ${c}   ← 标为 ${COMMAND_CAPS[c]}，但没这个命令`);
    console.log('   → 笔误或已改名。它会让真正的命令一直挂着 unknown 而被低估');
  }
}

/* ⑦ 能力画像：按插件看**组合**风险 */
/*
 * 单条能力未必危险，组合才危险。例如同时有 M（能起网络/进程）
 * 和 S（能读文件正文/截屏）就构成外传通道 —— 单看任何一条
 * 都像正常功能。
 *
 * ⚠️ 这一节**不拦截**，只登记。拦截会立刻让核心插件不可用
 * （agent-flow 现在就是 M+S+W 全占），所以先把风险摆出来，
 * 等降级改造做完再谈启用。
 */
console.log('\n=== 能力画像（不拦截，仅登记）===');
{
  const rows = [...cmdsByPlugin.entries()]
    .map(([id, cmds]) => ({ id, cmds, p: capsOf(cmds) }))
    .map((r) => ({ ...r, worst: worstLevel(r.p) }))
    .sort((a, b) => {
      const rank = { red: 0, yellow: 1, none: 2 };
      return rank[a.worst] - rank[b.worst] || a.id.localeCompare(b.id);
    });
  for (const r of rows) {
    const c = r.p.counts;
    const flag = r.worst === 'red' ? '🔴' : r.worst === 'yellow' ? '🟡' : '  ';
    console.log(
      `${flag} ${r.id.padEnd(14)} M${c.M} W${c.W} S${c.S} R${c.R} ?${c.unknown}`,
      r.p.combos.length ? `  ← ${r.p.combos.map((x) => x.id).join(', ')}` : '',
    );
  }
  const red = rows.filter((r) => r.worst === 'red');
  if (red.length) {
    console.log(`\n   🔴 ${red.length} 个插件命中红色组合（先看，不要急着一刀切拦截）：`);
    for (const r of red) {
      for (const cb of r.p.combos.filter((x) => x.level === 'red')) {
        console.log(`      ${r.id}: ${cb.why}`);
      }
    }
  }
}

/* 待归类队列：unknown 的命令，按被多少个插件持有排序 */
{
  const cnt = new Map();
  for (const cmds of cmdsByPlugin.values()) {
    for (const c of cmds) if (capOf(c) === 'unknown') cnt.set(c, (cnt.get(c) || 0) + 1);
  }
  const q = [...cnt.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\n   未归类命令 ${q.length} 条（默认 unknown，不是"安全"）：`);
  for (const [c, n] of q) console.log(`      ${c}  ← ${n} 个插件在用`);
  if (!q.length) console.log('      （无）');
}

const strict = process.argv.includes('--strict');
console.log(`\n合计问题 ${problems} 条`);
if (problems) {
  console.log(strict ? '✗ --strict：有问题' : '（加 --strict 可让 CI 失败）');
  process.exit(1);
}
console.log('✓ 三份清单一致');
