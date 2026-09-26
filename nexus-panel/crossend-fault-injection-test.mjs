/**
 * cross-end-check.mjs 故障注入测试（开发用，可删）
 * ------------------------------------------------------------
 * 目的：验证跨端校验脚本**真的能抓到错**，而不是永远打印"全部一致"。
 *
 * 这是文档明确要求的一项：「第一次跑就全绿要怀疑脚本是死的」。
 * 一个只会输出 ✅ 的校验脚本，比没有校验更危险 —— 它会给人虚假的安全感。
 *
 * 做法：造四类错，各跑一次，确认脚本报出**预期的那一类**问题并退出码 1。
 *
 * 注意区分两件事：
 *   · 脚本崩了（抛异常）也"不是全绿"，但那是脚本坏了，不是它抓到了错
 *   · 所以断言的是"输出里含预期类别关键字"，而不是"只要不全绿就算通过"
 */

import { readFileSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const P = (p) => join(HERE, p);

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* ---------------- 工具 ---------------- */

const backups = new Map();
function backup(path) {
  if (backups.has(path)) return;
  const abs = P(path);
  /* 连 mtime 一起存：本测试会把源码改一遍再还原，内容虽然一模一样，
     但 mtime 会被推进到"刚刚"，于是 dist-integrity-test 的
     「产物不早于最新源码」判定在全仓扫描里必红（它跑在本测试之后）。
     还原时把 mtime 写回去，守卫才不会误报。 */
  backups.set(path, { text: readFileSync(abs, 'utf8'), mtime: statSync(abs).mtime });
}
function restore(path) {
  const b = backups.get(path);
  if (!b) return;
  const abs = P(path);
  writeFileSync(abs, b.text);
  try { utimesSync(abs, b.mtime, b.mtime); } catch { /* 忽略：还原失败也不该让测试红 */ }
}
function restoreAll() {
  for (const p of backups.keys()) restore(p);
}

/** 跑一次校验，返回 { out, code, crashed } */
function runCheck() {
  try {
    const out = execFileSync('node', ['cross-end-check.mjs', '--strict'], {
      cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0, crashed: false };
  } catch (e) {
    // --strict 且有问题时退出码 1；execFileSync 会抛
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? -1, crashed: e.status === null || e.status > 1 };
  }
}

/** 注入 → 跑 → 断言 → 恢复 */
function inject(name, path, mutate, expect) {
  backup(path);
  let ok = false, got = '';
  try {
    const orig = readFileSync(P(path), 'utf8');
    const next = mutate(orig);
    if (next === orig) {
      t(name + '（注入未生效）', false, '改动前后相同 —— 注入失败，断言不可信');
      return;
    }
    writeFileSync(P(path), next);
    const r = runCheck();
    got = r.out.slice(0, 400);
    // 必须：报出预期类别 + 退出码 1，且不是脚本崩溃
    const hit = r.out.includes(expect);
    ok = hit && r.code === 1 && !r.crashed;
    t(name, ok, ok ? '' : `期望含「${expect}」且退出码1，实得 code=${r.code} crashed=${r.crashed}`);
  } finally {
    restore(path);
  }
}

/* ---------------- 0. 基线：干净时应当全绿 ---------------- */
console.log('\n=== 0. 基线 ===');
{
  const r = runCheck();
  t('未注入时校验通过（退出码 0）', r.code === 0 && !r.crashed, `code=${r.code}`);
  t('输出含「全部一致」', r.out.includes('全部一致'));
  const m = /Rust 命令 (\d+) · 注册 (\d+)/.exec(r.out);
  t('确实解析到了命令（不是空跑）', !!m && Number(m[1]) > 0, m ? `${m[1]} 个` : '未解析到');
}

/* ---------------- 1. 命令漏注册 ---------------- */
console.log('\n=== 1. 命令存在性 ===');
inject(
  '定义有、注册无 → 报 [注册缺失]',
  'src-tauri/src/main.rs',
  (s) => s.replace('fpx::fpx_bootstrap,', ''),   // 从 invoke_handler 摘掉一个
  '[注册缺失] fpx_bootstrap',
);
inject(
  '注册有、定义无 → 报 [定义缺失]',
  'src-tauri/src/main.rs',
  (s) => s.replace('fpx::fpx_bootstrap,', 'fpx::fpx_bootstrap, fpx::fpx_no_such_cmd,'),
  '[定义缺失] fpx_no_such_cmd',
);

/* ---------------- 2. 参数名不一致 ---------------- */
console.log('\n=== 2. 参数名 ===');
inject(
  '前端传了 Rust 没有的参数名 → 报 [参数名不符]',
  'plugins/project-group/api.ts',
  (s) => s.replace(
    "call<Snapshot>('fpx_create_link', { project, group, names: names ?? null })",
    "call<Snapshot>('fpx_create_link', { project, group, namesX: names ?? null })"),
  '[参数名不符] fpx_create_link',
);

/* ---------------- 3. 必传参数缺失 ---------------- */
console.log('\n=== 3. 必填性 ===');
inject(
  'Rust 必填但前端没传 → 报 [必传参数缺失]',
  'plugins/project-group/api.ts',
  (s) => s.replace(
    "call<Snapshot>('fpx_create_link', { project, group, names: names ?? null })",
    "call<Snapshot>('fpx_create_link', { project })"),
  '[必传参数缺失] fpx_create_link',
);

/* ---------------- 4. DTO 字段 ---------------- */
console.log('\n=== 4. DTO 字段 ===');
inject(
  'Rust 加了字段、TS 没有 → 报 [DTO 字段缺失]',
  'src-tauri/src/fpx/model.rs',
  (s) => s.replace(
    'pub struct FpxConfig {\n',
    'pub struct FpxConfig {\n    pub brand_new_field_for_test: bool,\n'),
  '[DTO 字段缺失] FpxConfig',
);
inject(
  'TS 加了字段、Rust 没有 → 报 [DTO 字段多余]',
  'plugins/project-group/types.ts',
  (s) => s.replace(
    /export interface FpxConfig \{/,
    'export interface FpxConfig {\n  brandNewFieldForTest: boolean;'),
  '[DTO 字段多余] FpxConfig',
);

/* ---------------- 5. 收尾：必须恢复干净 ---------------- */
console.log('\n=== 5. 恢复 ===');
restoreAll();
{
  const r = runCheck();
  t('全部恢复后重新全绿', r.code === 0 && r.out.includes('全部一致'), `code=${r.code}`);
}

/* ---------------- 6. 脚本自身的两个已知特性 ---------------- */
console.log('\n=== 6. 脚本特性 ===');
{
  const srcTxt = readFileSync(P('cross-end-check.mjs'), 'utf8');
  t('跳过了外壳命令（只查 fpx_ 前缀）', /if \(!cmd\.startsWith\('fpx_'\)\) continue;/.test(srcTxt));
  t('排除了 Tauri 注入参数', /INJECTED = new Set\(\['app', 'state'\]\)/.test(srcTxt));
  t('--strict 才非零退出（日常跑只是提示）',
    /process\.argv\.includes\('--strict'\) && problems\.length/.test(srcTxt));
  t('DTO 未镜像只算提示不算错误', /notes\.push\(`\[DTO 未镜像\]/.test(srcTxt));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
