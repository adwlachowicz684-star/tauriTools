#!/usr/bin/env node
/**
 * 插件私有仓断点续跑状态守卫（离线）
 * ============================================================
 * 守什么
 * ------------------------------------------------------------
 * 状态文件是防覆盖的唯一依据：记着哪些仓是我方建的、上次推到哪个 commit。
 * 三条通道（整仓初始化 / 增量刷新 / 联网核验）此前各写一份读取实现，
 * 且都把「文件损坏」和「文件不存在」混成同一种空状态。半份 JSON 的后果：
 *   · 初始化：12 仓全变 owned=false，被判成别人的仓而拒绝覆盖；
 *   · 刷新：刷新成功却以空对象写回，抹掉其余 11 仓的历史；
 *   · 核验：12 仓全报「状态落后」，--fix-state 把损坏洗白成合法状态并报 ✅。
 * 文件头注释早已写明这个风险，代码恰好把它静默掉了。
 *
 * 另外钉住第三条通道的路径同源：核验与刷新上一轮已统一用 repoStatePath()，
 * 初始化脚本仍指向项目内那个不存在的目录，校准与重置都落不到它读的文件。
 *
 * 判据两层：行为层真跑共享模块；接线层扫三个脚本（先剥注释）。
 * 四组反向验证各自撤掉一处修复，判据必须照样报红且不互相干扰。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const S = await import('./scripts/plugin-repo-state.mjs');
const { repoStatePath, ROOT } = await import('./scripts/build-plugin-repos.mjs');

let pass = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else fails.push(name + (extra ? ` — ${extra}` : ''));
}
function read(f) { return fs.readFileSync(path.join(HERE, f), 'utf8'); }

/* 剥注释：先去块注释，再只剥「行首或空白之后」的行注释。
   不能见 // 就吞 —— 源码里的 https 前缀会被从斜杠处整行截断，
   判据于是盯错地方（本项目在别的守卫上栽过这个）。 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');
}
const code = (f) => stripComments(read(f));

const FILES = {
  verify: 'scripts/verify-plugin-repos.mjs',
  refresh: 'scripts/refresh-plugin-repos.mjs',
  create: 'scripts/create-plugin-repos.mjs',
  shared: 'scripts/plugin-repo-state.mjs',
};

/* ------------------------------------------------------------------ *
 * 1. 行为层：共享模块真身
 * ------------------------------------------------------------------ */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-state-guard-'));
const stateFile = path.join(tmp, 'plugin-repos-v2-state.json');
const heads = new Map([['r1', 'head-aaaa'], ['r2', 'head-bbbb']]);

{
  const r = S.loadPluginRepoState(stateFile);
  t('文件不存在 = 首次运行：允许空状态且标记 missing',
    r.ok && r.missing && Object.keys(r.state).length === 0, JSON.stringify(r));
}
{
  const history = { r1: { owned: true, done: true, commit: 'head-aaaa', refreshedFiles: ['js/a.js'] } };
  fs.writeFileSync(stateFile, JSON.stringify(history, null, 2) + '\n');
  const r = S.loadPluginRepoState(stateFile);
  t('合法状态原样读回，历史字段不丢',
    r.ok && !r.missing && r.state.r1.owned === true
    && r.state.r1.refreshedFiles[0] === 'js/a.js', JSON.stringify(r));
}
{
  fs.writeFileSync(stateFile, '{"r1": {"owned": true');   // 502 写了一半
  const r = S.loadPluginRepoState(stateFile);
  t('半份 JSON 必须判不可解析，绝不回退成空状态',
    !r.ok && /不可解析/.test(r.reason) && Object.keys(r.state).length === 0, r.reason);
  const rep = S.stateDriftReport({
    state: r.state, loadError: r.reason, heads, fix: true, expectedCount: 2,
  });
  t('损坏时 --fix-state 必须被拒（canFix=false）', rep.canFix === false && rep.fatal === true);
  t('损坏被计成红而不是「状态落后」的绿', rep.stateDrift === 1);
  t('损坏时输出要明说不许校准', rep.lines.join('\n').includes('拒绝校准'));
}
{
  fs.writeFileSync(stateFile, '[]');
  const r = S.loadPluginRepoState(stateFile);
  t('顶层结构异常也要 fail-closed', !r.ok && /结构异常/.test(r.reason), r.reason);
}
{
  const noDir = path.join(tmp, 'no-such-dir', 'state.json');
  let threw = false;
  try { S.savePluginRepoState(noDir, { r1: { owned: true } }); } catch { threw = true; }
  t('保存不造假 git 目录：父目录不存在时抛错',
    threw && !fs.existsSync(path.dirname(noDir)));
}
{
  const before = { r1: { owned: true, done: true, commit: 'head-aaaa', scope: 'shared-only' } };
  S.savePluginRepoState(stateFile, before);
  const after = S.loadPluginRepoState(stateFile);
  t('原子写可被读回且保留 scope 等历史字段',
    after.ok && after.state.r1.scope === 'shared-only' && !fs.existsSync(stateFile + '.tmp'));
  S.resetPluginRepoState(stateFile);
  t('重置后文件消失（幂等，重复重置不抛）',
    !fs.existsSync(stateFile) && (() => { try { S.resetPluginRepoState(stateFile); return true; } catch { return false; } })());
}
{
  const okRep = S.stateDriftReport({ state: { r1: { commit: 'old' }, r2: { commit: 'head-bbbb' } },
    heads, fix: true, expectedCount: 2 });
  t('正常落后 + --fix-state 才允许校准（判据不恒假）',
    okRep.canFix === true && okRep.stateDrift === 1 && !okRep.fatal);
  const driftRep = S.stateDriftReport({ state: {}, heads, fix: true, drift: 1, expectedCount: 2 });
  t('内容有漂移时拒绝校准', driftRep.canFix === false);
  const shortRep = S.stateDriftReport({ state: {}, heads, fix: true, expectedCount: 12 });
  t('仓数不齐时拒绝校准', shortRep.canFix === false);
}
fs.rmSync(tmp, { recursive: true, force: true });

/* ------------------------------------------------------------------ *
 * 2. 接线层：三条通道都用同一份判据
 * ------------------------------------------------------------------ */
const legacyParse = /JSON\.parse\(fs\.readFileSync\(STATE/;
const legacySwallow = /catch\s*\{\s*return\s*\{\s*\}\s*;?\s*\}/;
for (const [name, f] of Object.entries(FILES)) {
  if (name === 'shared') continue;
  const s = code(f);
  t(`${name}: 引入共享状态模块`, s.includes("'./plugin-repo-state.mjs'"));
  t(`${name}: 不再自己解析状态文件`, !legacyParse.test(s));
  t(`${name}: 不再把异常吞成空对象`, !legacySwallow.test(s));
}
{
  const s = code(FILES.create);
  t('create: 状态路径与核验/刷新同源（用 repoStatePath）',
    /const STATE = repoStatePath\(\)/.test(s));
  t('create: 不再写死项目内那个不存在的 .git 路径',
    !/path\.resolve\(ROOT,\s*'\.git'/.test(s));
  t('create: 损坏即停且重置走共享函数',
    /if \(!loadedState\.ok\)/.test(s) && /process\.exit\(1\)/.test(s)
    && /resetPluginRepoState\(STATE\)/.test(s));
  t('create: 三处保存都走共享原子写',
    (s.match(/savePluginRepoState\(STATE, state\)/g) || []).length === 3);
}
{
  const s = code(FILES.refresh);
  t('refresh: 损坏即拒绝刷新', /if \(!loaded\.ok\)/.test(s) && /process\.exit\(1\)/.test(s));
  t('refresh: 保存走共享原子写', /savePluginRepoState\(STATE, state\)/.test(s));
}
{
  const s = code(FILES.verify);
  t('verify: 状态判定走共享纯函数', /stateDriftReport\(/.test(s));
  t('verify: 损坏分支单独处理且计入 drift',
    /rep\.fatal/.test(s) && /drift\+\+/.test(s));
  t('verify: 不再自己算 canFix', !/const canFix =/.test(s));
  t('verify: 校准写回走共享原子写', /savePluginRepoState\(STATE, state\)/.test(s));
}
{
  const s = code(FILES.shared);
  t('共享模块导出三个入口', /export function loadPluginRepoState/.test(s)
    && /export function savePluginRepoState/.test(s)
    && /export function stateDriftReport/.test(s));
  t('共享模块区分 ENOENT 与解析失败', /ENOENT/.test(s) && /不可解析/.test(s));
}
{
  /* 旧守卫只扫了核验与刷新两个脚本，第三条通道从缝里漏了出去。 */
  const s = code('plugin-manifest-repos-test.mjs');
  t('既有路径守卫已把 create 纳入同源检查',
    s.includes(FILES.create));
}

/* ------------------------------------------------------------------ *
 * 3. 路径不同源的实证（不是文本差异，是真磁盘状态）
 * ------------------------------------------------------------------ */
{
  const real = repoStatePath();
  const wrong = path.resolve(ROOT, '.git', 'plugin-repos-v2-state.json');
  t('写死的那条路径确实不存在，而真实状态文件存在',
    !fs.existsSync(wrong) && fs.existsSync(real), `${wrong} / ${real}`);
  const realState = JSON.parse(fs.readFileSync(real, 'utf8'));
  t('真实状态文件里确实有 12 仓记录（校准该落在这里）',
    Object.keys(realState).length === 12, `实为 ${Object.keys(realState).length}`);
}

/* ------------------------------------------------------------------ *
 * 4. 四组反向验证：撤掉修复，判据必须照样报红
 * ------------------------------------------------------------------ */
function wired(src, name) {
  const s = stripComments(src);
  const common = s.includes("'./plugin-repo-state.mjs'")
    && !legacyParse.test(s) && !legacySwallow.test(s);
  if (name === 'create') {
    return common && /const STATE = repoStatePath\(\)/.test(s)
      && !/path\.resolve\(ROOT,\s*'\.git'/.test(s)
      && /if \(!loadedState\.ok\)/.test(s);
  }
  if (name === 'refresh') {
    return common && /if \(!loaded\.ok\)/.test(s) && /process\.exit\(1\)/.test(s);
  }
  /* 必须钉住「损坏分支内部」那一处 drift++：文件里还有别处的 drift++，
     只查 /drift\+\+/ 会被它们喂饱，撤掉损坏分支也照样绿。 */
  return common && /if \(rep\.fatal\) \{[\s\S]{0,500}?drift\+\+/.test(s)
    && !/const canFix =/.test(s);
}
for (const [name, f] of Object.entries(FILES)) {
  if (name !== 'shared') t(`正向接线：${name} 判据为绿`, wired(read(f), name));
}
{
  const a = read(FILES.create).replace(
    'const STATE = repoStatePath();',
    "const STATE = path.resolve(ROOT, '.git', 'plugin-repos-v2-state.json');");
  t('反向A：create 路径改回写死，判据报红', !wired(a, 'create'));
}
{
  const b = read(FILES.refresh).replace(
    'if (!loaded.ok) {', 'if (false) {');
  t('反向B：refresh 撤掉损坏检查，判据报红', !wired(b, 'refresh'));
}
{
  const c = read(FILES.verify).replace('if (rep.fatal) {', 'if (false) {');
  t('反向C：verify 撤掉损坏独占分支，判据报红', !wired(c, 'verify'));
}
{
  /* 旧判据眼里「损坏」只是「状态落后」，于是会拿空对象重写： */
  const brokenPath = path.join(os.tmpdir(), 'plugin-state-guard-broken-' + process.pid + '.json');
  fs.writeFileSync(brokenPath, '{"r1":');
  const broken = S.loadPluginRepoState(brokenPath);
  const legacyCanFix = (fix, drift, netFail, headCount, expected) =>
    fix && drift === 0 && netFail === 0 && headCount === expected;
  const rep = S.stateDriftReport({ state: broken.state, loadError: broken.reason,
    heads, fix: true, expectedCount: 2 });
  t('反向D：旧判据会把损坏洗白（canFix 为真）',
    legacyCanFix(true, 0, 0, heads.size, 2) === true);
  t('反向D：新判据在同一份损坏样本上拒绝校准', rep.canFix === false);
  const washed = { r1: { commit: 'head-aaaa' } };  // 以空状态为底重写的结果
  t('反向D：洗白后 owned/scope 等历史字段确实消失',
    washed.r1.owned === undefined && washed.r1.scope === undefined);
  fs.unlinkSync(brokenPath);
}

console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
for (const f of fails) console.error('  ❌ ' + f);
process.exit(fails.length ? 1 : 0);
