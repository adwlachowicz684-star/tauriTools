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

/** A：generate_handler![...] 里的命令名 */
function collectRegistered(src) {
  const m = src.match(/generate_handler!\s*\[([\s\S]*?)\n\s*\]/);
  if (!m) return null;
  /*
   * 条目形如 `fpx::fpx_bootstrap` 或 `rust_ping`。
   * 命令名 = 最后一段（Tauri 以函数名注册，模块路径不算）。
   */
  return new Set(
    m[1].split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => x.split('::').pop()),
  );
}

/* ---------------------------------------------------------------- */
/* 2. 扫前端白名单                                                     */
/* ---------------------------------------------------------------- */

function collectPolicy(src) {
  /* 三条来源都算：PLUGIN_COMMANDS / SAFE_COMMANDS / manifest.commands */
  const names = new Set();
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
  const m2 = src.match(/export const SAFE_COMMANDS\s*=\s*(?:new Set\(\s*\[|\[)([\s\S]*?)\]\s*\)\s*;/);
  if (m2) for (const s of m2[1].matchAll(/'([a-z_0-9]{3,})'/g)) names.add(s[1]);
  /* 解析不到就当失效 —— 静默返回空集会掩盖真实问题 */
  if (!m) {
    console.error('✗ 没解析到 PLUGIN_COMMANDS —— 扫描器失效，不要当成"没问题"');
    process.exit(2);
  }
  return names;
}

/* ---------------------------------------------------------------- */
/* 3. 对账                                                             */
/* ---------------------------------------------------------------- */

const files = walk(rsRoot);
const annotated = collectAnnotated(files);
const mainSrc = fs.readFileSync(mainRs, 'utf8');
const registered = collectRegistered(mainSrc);
const policySrc = fs.readFileSync(policy, 'utf8');
const allowed = collectPolicy(policySrc);

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

/* ② 注册了但没标注 —— 通常无害（可能是外部 crate），但值得看一眼 */
const regNotAnno = [...registered].filter((n) => !annotated.has(n)).sort();
say('② 注册了但没有 #[tauri::command] 标注', regNotAnno,
  '确认是不是本仓库定义的；外部 crate 的命令可以不管');

/* ③ 白名单里有但 Rust 侧没注册 —— 有权限却调不通 */
const allowNotReg = [...allowed].filter((n) => !registered.has(n)).sort();
say('③ 前端白名单里有、但 Rust 侧没注册', allowNotReg,
  '写成"有权限"却永远失败，比明确拒绝更难排查 —— 删掉或补注册');

/* ④ 注册了但白名单没放行 —— 已知现状，不算错，只做统计 */
const regNotAllow = [...registered].filter((n) => !allowed.has(n)).sort();
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

const strict = process.argv.includes('--strict');
console.log(`\n合计问题 ${problems} 条`);
if (problems) {
  console.log(strict ? '✗ --strict：有问题' : '（加 --strict 可让 CI 失败）');
  process.exit(1);
}
console.log('✓ 三份清单一致');
