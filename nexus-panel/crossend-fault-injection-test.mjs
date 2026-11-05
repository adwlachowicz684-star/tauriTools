/**
 * cross-end-check.mjs 故障注入测试（开发用）
 * ------------------------------------------------------------
 * 目的：验证跨端校验脚本**真的能抓到错**，而不是永远打印"全部一致"。
 *
 * 这是文档明确要求的一项：「第一次跑就全绿要怀疑脚本是死的」。
 * 一个只会输出 ✅ 的校验脚本，比没有校验更危险 —— 它会给人虚假的安全感。
 *
 * 做法：造六类错，各跑一次，确认脚本报出**预期的那一类**问题并退出码 1。
 *
 * 注意区分两件事：
 *   · 脚本崩了（抛异常）也"不是全绿"，但那是脚本坏了，不是它抓到了错
 *   · 所以断言的是"输出里含预期类别关键字"，而不是"只要不全绿就算通过"
 *
 * 【第 35 节改造：注入不再打真实源码】
 * 旧版直接在主仓真实文件上改（model.rs 插假字段、main.rs 插假命令），
 * 靠 try/finally + 开跑前清残留兜底。2026-11-05 全量复查超时被 SIGKILL，
 * finally 没跑，2 个 `fpx::fpx_no_such_cmd` 永久留在 main.rs —— 推上去
 * 会让 Rust 直接编译失败，而没有任何守卫会报（见清单 34.1）。
 *
 * 现在：开工时把 Rust 源复制进临时目录，TS 侧夹具**从真实 Rust 源派生**
 * （不手写第二份契约），cross-end-check.mjs 用 `--root=<tmp>` 只读写副本。
 * 于是「被 kill 留下污染」这个根因消失，退场态也不再让判据空跑。
 * 收尾用真实文件 sha 前后比对钉住「零污染」，而不是靠注释自证。
 */

import {
  readFileSync, writeFileSync, statSync, utimesSync, existsSync,
  readdirSync, mkdirSync, copyFileSync, mkdtempSync, rmSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL = (p) => join(HERE, p);                 // 主仓真实源码（只读）
let ROOT = null;                                   // 临时源树（可写）
const P = (p) => join(ROOT, p);                    // 注入目标

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

/* ---------------- 历史残留清理（只读之外，唯一会写真实源码的地方） ----------------
   本测试不再改真实源码，下面这段只负责清掉**旧版**被 kill 时留下的注入残留。
   保留它是因为工作区里可能仍有历史残留，推上去同样会让 Rust 编译失败。
   ⚠️ 子串型注入不能按行删：invoke_handler 那一整行还有十几个正常命令，
      删整行比残留更严重。 */
const INJECT_MARKERS = [
  ['src-tauri/src/fpx/model.rs', 'pub brand_new_field_for_test: bool,'],
  ['plugins/project-group/types.ts', 'brandNewFieldForTest: boolean;'],
];
const INJECT_SNIPPETS = [
  ['src-tauri/src/main.rs', 'fpx::fpx_no_such_cmd, '],
];
const stripSnippets = (s, snippet) => s.split(snippet).join('');
{
  let cleaned = 0;
  for (const [rel, marker] of INJECT_MARKERS) {
    const abs = REAL(rel);
    let s;
    try { s = readFileSync(abs, 'utf8'); } catch { continue; }
    if (!s.includes(marker)) continue;
    writeFileSync(abs, s.split('\n').filter((l) => !l.includes(marker)).join('\n'));
    cleaned++;
  }
  for (const [rel, snippet] of INJECT_SNIPPETS) {
    const abs = REAL(rel);
    let s;
    try { s = readFileSync(abs, 'utf8'); } catch { continue; }
    const next = stripSnippets(s, snippet);
    if (next === s) continue;
    writeFileSync(abs, next);
    cleaned++;
  }
  if (cleaned) console.log(`⚠️  开跑前清掉 ${cleaned} 处旧版注入残留`);
}
{
  const sample = 'fpx::fpx_bootstrap, fpx::fpx_no_such_cmd, fpx::fpx_no_such_cmd, fpx::fpx_save_config,';
  const clean = 'fpx::fpx_bootstrap, fpx::fpx_save_config,';
  t('⑤ 元断言：重复两次的注入残留被清掉，同行正常命令保留',
    stripSnippets(sample, 'fpx::fpx_no_such_cmd, ') === clean);
  t('⑤ 元断言：干净文本不受清理影响（不误删）',
    stripSnippets(clean, 'fpx::fpx_no_such_cmd, ') === clean);
}

/* ---------------- 临时源树：Rust 复制 + TS 夹具派生 ---------------- */

const snakeToCamel = (s) =>
  s.split('_').map((p, i) => (i ? p[0].toUpperCase() + p.slice(1) : p)).join('');

/** 按大括号配对截取结构体内容（与 cross-end-check 的 readBraced 同形） */
function bracedBody(src, openIdx) {
  let depth = 0;
  for (let j = openIdx; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, j);
    }
  }
  return '';
}

const WATCHED_REAL = [
  'src-tauri/src/main.rs',
  'src-tauri/src/fpx/model.rs',
  'src-tauri/src/fpx/mod.rs',
];
const realShaBefore = new Map(WATCHED_REAL.map((r) => [r, sha(REAL(r))]));

function buildRoot() {
  const root = mkdtempSync(join(tmpdir(), 'crossend-fixture-'));
  const srcDir = join(root, 'src-tauri/src');
  const fpxDir = join(srcDir, 'fpx');
  const pluginDir = join(root, 'plugins/project-group');
  mkdirSync(fpxDir, { recursive: true });
  mkdirSync(pluginDir, { recursive: true });

  copyFileSync(REAL('src-tauri/src/main.rs'), join(srcDir, 'main.rs'));
  const rustFiles = readdirSync(REAL('src-tauri/src/fpx')).filter((f) => f.endsWith('.rs'));
  for (const f of rustFiles) {
    copyFileSync(REAL('src-tauri/src/fpx/' + f), join(fpxDir, f));
  }

  /* types.ts 从真实 model.rs 派生：字段名与 cross-end-check 的
     snakeToCamel(rustFields) 完全一致，所以干净基线必然通过。
     若 Rust 侧改名/加字段，夹具自动跟着变 —— 不存在「第二份契约漂移」。 */
  const model = readFileSync(REAL('src-tauri/src/fpx/model.rs'), 'utf8');
  const m = /pub struct FpxConfig\s*\{/.exec(model);
  if (!m) throw new Error('model.rs 里找不到 FpxConfig，夹具无法派生');
  const fields = [...bracedBody(model, model.indexOf('{', m.index))
    .matchAll(/pub\s+(\w+)\s*:/g)].map((x) => snakeToCamel(x[1]));
  const tsLines = fields.map((f) => `  ${f}: unknown;`).join('\n');
  writeFileSync(join(pluginDir, 'types.ts'),
    `// 由 crossend-fault-injection-test.mjs 从 model.rs 派生，勿手改\nexport interface FpxConfig {\n${tsLines}\n}\n`);

  /* api.ts 只需一条真实调用：fpx_create_link 的参数名来自 Rust 定义，
     下面 §0 有元断言核对，Rust 改参数名会先红，而不是产出假夹具。 */
  writeFileSync(join(pluginDir, 'api.ts'),
    `declare function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;\n` +
    `export const createLink = (project: string, group: string, names: string[] | null) =>\n` +
    `  call<unknown>('fpx_create_link', { project, group, names: names ?? null });\n`);

  return { root, fields, rustFiles };
}

const built = buildRoot();
ROOT = built.root;

/* ---------------- 注入 / 恢复（只作用于临时副本） ---------------- */

const backups = new Map();
function backup(path) {
  if (backups.has(path)) return;
  const abs = P(path);
  backups.set(path, { text: readFileSync(abs, 'utf8'), mtime: statSync(abs).mtime });
}
function restore(path) {
  const b = backups.get(path);
  if (!b) return;
  const abs = P(path);
  writeFileSync(abs, b.text);
  try { utimesSync(abs, b.mtime, b.mtime); } catch { /* 忽略 */ }
}
function restoreAll() { for (const p of backups.keys()) restore(p); }
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { restoreAll(); cleanup(); process.exit(130); });
}
process.on('uncaughtException', (e) => { restoreAll(); cleanup(); console.error(e); process.exit(1); });
process.on('unhandledRejection', (e) => { restoreAll(); cleanup(); console.error(e); process.exit(1); });
function cleanup() { try { rmSync(ROOT, { recursive: true, force: true }); } catch { /* 忽略 */ } }

/** 跑一次校验；--root 必须真的传给被检脚本，否则测试会在真实源码上跑 */
function runCheck(extraArgs = []) {
  const args = ['cross-end-check.mjs', '--strict', `--root=${ROOT}`, ...extraArgs];
  try {
    const out = execFileSync('node', args, {
      cwd: HERE, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { out, code: 0, crashed: false };
  } catch (e) {
    return { out: (e.stdout || '') + (e.stderr || ''), code: e.status ?? -1,
             crashed: e.status === null || e.status > 1 };
  }
}

/** 注入 → 跑 → 断言 → 恢复 */
function inject(name, path, mutate, expect) {
  if (!existsSync(P(path))) {
    t(name + '（夹具缺失）', false, `${path} 不存在：临时源树没建好，判据不可信`);
    return;
  }
  backup(path);
  let ok = false;
  try {
    const orig = readFileSync(P(path), 'utf8');
    const next = mutate(orig);
    if (next === orig) {
      t(name + '（注入未生效）', false, '改动前后相同 —— 注入失败，断言不可信');
      return;
    }
    writeFileSync(P(path), next);
    const r = runCheck();
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
  t('夹具从 model.rs 派生出 FpxConfig 字段', built.fields.length > 0,
    `${built.fields.length} 个`);
  t('临时源树复制了 Rust 命令文件', built.rustFiles.length > 0,
    `${built.rustFiles.length} 个`);
  const modSrc = readFileSync(REAL('src-tauri/src/fpx/mod.rs'), 'utf8');
  t('夹具调用的参数名与 Rust 定义一致（不是编出来的）',
    /\bfn fpx_create_link\s*\(/.test(modSrc) &&
    /project:\s*String/.test(modSrc) && /group:\s*String/.test(modSrc) &&
    /names:\s*Option/.test(modSrc));
  const r = runCheck();
  t('未注入时校验通过（退出码 0）', r.code === 0 && !r.crashed, `code=${r.code}`);
  t('输出含「全部一致」', r.out.includes('全部一致'));
  const m = /Rust 命令 (\d+) · 注册 (\d+)/.exec(r.out);
  t('确实解析到了命令（不是空跑）', !!m && Number(m[1]) > 0, m ? `${m[1]} 个` : '未解析到');
  t('--root 真的生效（报告里的契约源指向临时目录）', r.out.includes(ROOT));
  /* 必须直接走一次「契约源缺席」分支：本测试平时总给完整源树，
     readSource 的 catch 从不触发 —— 若把那条 problem 注释掉，
     全套注入照样 24/0 全绿（本轮破坏验证 B 实测到的假绿）。
     缺席时必须显式报 [契约源缺失] + 标准汇总行 + exit 1，不能空跑放行。 */
  {
    const tsFile = P('plugins/project-group/api.ts');
    const saved = readFileSync(tsFile, 'utf8');
    try {
      rmSync(tsFile);
      const bad = runCheck();
      t('TS 契约源缺席 → fail-closed（显式报缺失 + 汇总行 + exit 1）',
        bad.out.includes('[契约源缺失]') &&
        /通过 \d+ 项，失败 \d+ 项/.test(bad.out) &&
        bad.code === 1 && !bad.crashed,
        `code=${bad.code} crashed=${bad.crashed}`);
    } finally { writeFileSync(tsFile, saved); }
  }
  /* 判据必须认得「源根被换掉」：给一个不含 Rust 源的空目录应报契约源缺失，
     否则 --root 形同虚设，测试其实一直在真实源码上跑。 */
  const empty = mkdtempSync(join(tmpdir(), 'crossend-empty-'));
  try {
    const bad = runCheck([`--root=${empty}`]);
    t('换一个空源根会报 [契约源缺失]（--root 不是摆设）',
      bad.out.includes('[契约源缺失]') && bad.code === 1);
  } finally { rmSync(empty, { recursive: true, force: true }); }
}

/* ---------------- 1. 命令漏注册 ---------------- */
console.log('\n=== 1. 命令存在性 ===');
inject('定义有、注册无 → 报 [注册缺失]', 'src-tauri/src/main.rs',
  (s) => s.replace('fpx::fpx_bootstrap,', ''), '[注册缺失] fpx_bootstrap');
inject('注册有、定义无 → 报 [定义缺失]', 'src-tauri/src/main.rs',
  (s) => s.replace('fpx::fpx_bootstrap,', 'fpx::fpx_bootstrap, fpx::fpx_no_such_cmd,'),
  '[定义缺失] fpx_no_such_cmd');

/* ---------------- 2. 参数名不一致 ---------------- */
console.log('\n=== 2. 参数名 ===');
inject('前端传了 Rust 没有的参数名 → 报 [参数名不符]', 'plugins/project-group/api.ts',
  (s) => s.replace('{ project, group, names: names ?? null }',
                   '{ project, group, namesX: names ?? null }'),
  '[参数名不符] fpx_create_link');

/* ---------------- 3. 必传参数缺失 ---------------- */
console.log('\n=== 3. 必填性 ===');
inject('Rust 必填但前端没传 → 报 [必传参数缺失]', 'plugins/project-group/api.ts',
  (s) => s.replace('{ project, group, names: names ?? null }', '{ project }'),
  '[必传参数缺失] fpx_create_link');

/* ---------------- 4. DTO 字段 ---------------- */
console.log('\n=== 4. DTO 字段 ===');
inject('Rust 加了字段、TS 没有 → 报 [DTO 字段缺失]', 'src-tauri/src/fpx/model.rs',
  (s) => s.replace('pub struct FpxConfig {\n',
                   'pub struct FpxConfig {\n    pub brand_new_field_for_test: bool,\n'),
  '[DTO 字段缺失] FpxConfig');
inject('TS 加了字段、Rust 没有 → 报 [DTO 字段多余]', 'plugins/project-group/types.ts',
  (s) => s.replace(/export interface FpxConfig \{/,
                   'export interface FpxConfig {\n  brandNewFieldForTest: boolean;'),
  '[DTO 字段多余] FpxConfig');

/* ---------------- 5. 收尾：必须恢复干净 ---------------- */
console.log('\n=== 5. 恢复 ===');
restoreAll();
{
  const r = runCheck();
  t('全部恢复后重新全绿', r.code === 0 && r.out.includes('全部一致'), `code=${r.code}`);
  let same = true;
  const changed = [];
  for (const [rel, before] of realShaBefore) {
    if (sha(REAL(rel)) !== before) { same = false; changed.push(rel); }
  }
  t('★ 全程零污染：主仓真实源码 sha 未变（注入只打副本）', same,
    same ? `${WATCHED_REAL.length} 个文件逐一核对` : `被改：${changed.join(', ')}`);
}

/* ---------------- 6. 脚本自身的已知特性 ---------------- */
console.log('\n=== 6. 脚本特性 ===');
{
  const srcTxt = readFileSync(REAL('cross-end-check.mjs'), 'utf8');
  t('跳过了外壳命令（只查 fpx_ 前缀）', /if \(!cmd\.startsWith\('fpx_'\)\) continue;/.test(srcTxt));
  t('排除了 Tauri 注入参数', /INJECTED = new Set\(\['app', 'state'\]\)/.test(srcTxt));
  t('--strict 才非零退出（日常跑只是提示）',
    /process\.argv\.includes\('--strict'\) && problems\.length/.test(srcTxt));
  t('DTO 未镜像只算提示不算错误', /notes\.push\(`\[DTO 未镜像\]/.test(srcTxt));
  t('源根可注入（--root / --ts-root）',
    /argVal\('--root'\)/.test(srcTxt) && /argVal\('--ts-root'\)/.test(srcTxt));
  t('契约源缺席是显式 problem，不是空集合放行',
    /\[契约源缺失\]/.test(srcTxt) && /readSource\(join\(PLUGIN, 'api\.ts'\)\)/.test(srcTxt));
}

cleanup();
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
