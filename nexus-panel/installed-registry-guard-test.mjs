#!/usr/bin/env node
/**
 * 已安装插件「进注册表」守卫（第 54 轮）
 * ============================================================================
 *
 * 修的缺口：market.list() 早就调 pluginsWithInstalled() 合并
 * installed-plugins/，但外壳 loadRegistry() 只读静态 registry.js，
 * host.refresh / shell.js / App.tsx 三处赋值点都走它 —— 装完的插件
 * 不进 state.plugins，侧边栏不出现、也打不开。几十个守卫全绿也看不见，
 * 因为它们测的是模块内部，不是这条接线。
 *
 * 判据分两层，缺一不可：
 *   · 行为层：真 import js/installed-registry.js，注入内存 fs 真跑合并、
 *     静态优先、三条降级契约、projectInstalled 不污染静态插件；
 *   · 结构层：钉住 host.js 的调用位置（必须在 registerBuiltinIds 之后）、
 *     扫描报告不被吞、resolveFrameSrc 的 installed 分支必须排在
 *     resolveEntry 之前、三处赋值点不许绕过 loadRegistry。
 *
 * 为什么不能只做文本扫描：把 `await loadInstalledRegistry(list)` 换成
 * 一个恒等函数，文本判据照样过，产品里依旧「装了不出现」。
 * 反过来只做行为层也守不住「调用被摘掉」，所以两层都在。
 *
 * 行为层统一经 safe() 包装：被测模块抛错时转成一条点名断言 + 空结果，
 * 守卫不会崩在顶层 await 且没有汇总行（「守卫崩了不等于守卫喊了」）。
 *
 * 已知边界（与第 30/31/49/53 轮同形）：纯静态守卫挡不住「把主断言
 * 整行删掉或改成 true」。元断言只验判据函数本身能识别坏输入，
 * 靠每轮破坏验证兜这一层，不假装能自证。
 *
 * 零外部依赖，按 import.meta.url 定位根，从任意 cwd 可跑。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadInstalledRegistry, projectInstalled, LOAD_STATE,
} from './js/installed-registry.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const r = (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : '');

let pass = 0;
let fail = 0;
function t(name, ok, info = '') {
  if (ok) { pass += 1; return; }
  fail += 1;
  console.log(`  ✗ ${name}${info ? ` — ${info}` : ''}`);
}

/* ---------------- 内存 fs 夹具（只实现扫描器用到的四个方法） ---------------- */
function memFs({ files = {}, dirs = {}, failReaddir = false, failExists = false } = {}) {
  return {
    async exists(p) {
      if (failExists) throw new Error('exists 故意抛错');
      return files[p] !== undefined || dirs[p] !== undefined;
    },
    async readdir(p) {
      if (failReaddir) throw new Error('readdir 故意抛错');
      return Array.isArray(dirs[p]) ? [...dirs[p]] : [];
    },
    async readText(p) {
      if (files[p] === undefined) throw new Error(`ENOENT: ${p}`);
      return files[p];
    },
    async isFile(p) { return files[p] !== undefined; },
  };
}

const BASE = '/appdata/installed-plugins';
const STATIC = [
  { id: 'home', name: '概览', type: 'module', entry: './plugins/home/index.js' },
  { id: 'settings', name: '设置', type: 'module', entry: './plugins/settings/index.js' },
];

/** entries: { [id]: { manifest: object|string, entry?: string } } */
function fixture(entries, opts = {}) {
  const files = {};
  const names = Object.keys(entries);
  for (const id of names) {
    const spec = entries[id] || {};
    const d = `${BASE}/${id}`;
    if (spec.manifest !== undefined) {
      files[`${d}/nexus.plugin.json`] = typeof spec.manifest === 'string'
        ? spec.manifest : JSON.stringify(spec.manifest);
    }
    if (spec.entry) files[`${d}/${spec.entry}`] = '<html></html>';
  }
  const dirs = opts.dirExists === false
    ? {}
    : { [BASE]: names, ...Object.fromEntries(names.map((n) => [`${BASE}/${n}`, []])) };
  return memFs({ files, dirs, ...opts });
}
const OK_MF = (id, over = {}) => ({
  id, name: `插件 ${id}`, version: '1.2.3', entry: 'index.html', ...over,
});
const FAKE_TAURI = { invoke: async () => 'true' };
const run = (entries, opts = {}) => loadInstalledRegistry(STATIC, {
  tauri: FAKE_TAURI, dataRoot: '/appdata', fs: fixture(entries, opts),
});

/* 行为层若被测模块抛错，顶层 await 会让守卫崩且没有汇总行 ——
 * 「守卫崩了不等于守卫喊了」。统一包一层，抛错转成一条点名断言 + 空结果，
 * 后续断言自然跟着红，但汇总行一定还在。 */
const EMPTY_RESULT = { plugins: [], report: { skipped: [1], errors: [1], found: -1, degraded: null } };
async function safe(label, fn) {
  try { return await fn(); }
  catch (e) {
    t(`${label} 调用不得抛异常`, false, String((e && e.message) || e));
    return null;
  }
}

/* ---------------- ① 行为层：真跑合并 ---------------- */
{
  const a = (await safe('①', () => run({
    foo: { manifest: OK_MF('foo'), entry: 'index.html' },
  }))) || EMPTY_RESULT;
  const foo = a.plugins.find((p) => p && p.id === 'foo');
  t('①a 装好的插件进注册表（state.plugins 会出现在侧边栏）',
    !!foo && foo.installed === true, JSON.stringify(a.plugins.map((p) => p && p.id)));
  t('①b 静态插件原样保留，没被合并弄丢',
    a.plugins.filter((p) => p && (p.id === 'home' || p.id === 'settings')).length === 2);
  t('①c projectInstalled 打上 loadState（resolveFrameSrc 靠它 fail-closed）',
    !!foo && foo.loadState === LOAD_STATE, foo && foo.loadState);
  t('①d 保留包内 installedEntry 供真机方案选分支',
    !!foo && foo.installedEntry === 'index.html');
  t('①e 正常安装不产生 skipped / errors',
    a.report.skipped.length === 0 && a.report.errors.length === 0,
    JSON.stringify(a.report));
  t('①f found 如实等于扫到的目录数', a.report.found === 1, String(a.report.found));
}

/* ---------------- ② 行为层：静态优先与坏条目不静默 ---------------- */
{
  const b = (await safe('②', () => run({
    home: { manifest: OK_MF('home', { name: '顶替设置页' }), entry: 'index.html' },
    broken: { manifest: '{不是 JSON' },
    noEntry: { manifest: OK_MF('noEntry'), entry: null },
  }))) || EMPTY_RESULT;
  const homes = b.plugins.filter((p) => p && p.id === 'home');
  t('②a 静态优先：装进来的同名插件不能顶掉内置', homes.length === 1
    && homes[0].name === '概览', JSON.stringify(homes));
  t('②b 冲突条目带 reason 报出，不是静默丢弃',
    b.report.skipped.some((s) => s.id === 'home' && /冲突/.test(s.reason)),
    JSON.stringify(b.report.skipped));
  t('②c 坏 manifest / 缺 entry 都进 skipped 且点名到 id',
    ['broken', 'noEntry'].every((id) => b.report.skipped.some((s) => s.id === id)),
    JSON.stringify(b.report.skipped));
  t('②d 三个坏条目一个都不进注册表，静态清单原样保留',
    b.plugins.length === STATIC.length
      && ['broken', 'noEntry'].every((id) => !b.plugins.some((p) => p && p.id === id))
      && JSON.stringify(b.plugins) === JSON.stringify(STATIC),
    JSON.stringify(b.plugins.map((p) => p && p.id)));
}

/* ---------------- ③ 行为层：三条降级契约 ---------------- */
{
  const c = (await safe('③a', () => loadInstalledRegistry(STATIC, {
    tauri: null, dataRoot: '/appdata', fs: fixture({}),
  }))) || EMPTY_RESULT;
  t('③a 非 Tauri：原样返回静态清单、不抛错、degraded 写明原因',
    JSON.stringify(c.plugins) === JSON.stringify(STATIC) && c.report.degraded === 'not-in-tauri',
    c.report.degraded);

  const d = (await safe('③b', () => loadInstalledRegistry(STATIC, {
    tauri: FAKE_TAURI, dataRoot: null, fs: fixture({}),
  }))) || EMPTY_RESULT;
  t('③b 取不到数据目录：原样返回静态清单、不抛错',
    JSON.stringify(d.plugins) === JSON.stringify(STATIC) && d.report.degraded === 'no-data-dir',
    d.report.degraded);

  const e = (await safe('③c', () => run({}, { dirExists: false }))) || EMPTY_RESULT;
  t('③c 目录不存在是干净正常态，不产生 errors（否则「没装过」被报成「扫描出错」）',
    JSON.stringify(e.plugins) === JSON.stringify(STATIC) && e.report.errors.length === 0
      && e.report.found === 0, JSON.stringify(e.report));

  const g = (await safe('③d', () => loadInstalledRegistry(STATIC, {
    tauri: FAKE_TAURI, dataRoot: '/appdata',
    fs: memFs({ dirs: { [BASE]: ['foo'] }, failReaddir: true }),
  }))) || EMPTY_RESULT;
  t('③d 扫描失败：静态清单不丢、错误如实带出',
    JSON.stringify(g.plugins) === JSON.stringify(STATIC) && g.report.errors.length > 0,
    JSON.stringify(g.report.errors));
}

/* ---------------- ④ 结构层：接线位置与 fail-closed ---------------- */
const host = r('js/host.js');
const reg = r('js/installed-registry.js');
const debtRaw = r('scripts/market-binding-debt.json');

/** 只截取 loadRegistry 函数体做判据，避免别处的同名字符串误命中。 */
function loadRegistryBody(src) {
  const i = src.indexOf('export async function loadRegistry()');
  if (i < 0) return '';
  const j = src.indexOf('\n}', i);
  return j > i ? src.slice(i, j) : src.slice(i);
}
const body = loadRegistryBody(host);
const hasMergeCall = (s) => /await\s+loadInstalledRegistry\s*\(/.test(s)
  && s.indexOf('registerBuiltinIds(') >= 0
  && s.indexOf('await loadInstalledRegistry(') > s.indexOf('registerBuiltinIds(');

t('④a host.js 引入 loadInstalledRegistry', /import\s*\{[^}]*loadInstalledRegistry/.test(host));
t('④b loadRegistry 内真的调用合并，且排在 registerBuiltinIds 之后',
  hasMergeCall(body), body.slice(0, 120).replace(/\s+/g, ' '));
t('④c 扫描报告写入 lastInstalledScan，不静默吞',
  /lastInstalledScan\s*=\s*merged\.report/.test(host));
t('④d 报告有导出，UI / 诊断取得到',
  /export\s+function\s+installedScanReport\s*\(/.test(host));
t('④e 合并委托 pluginsWithInstalled，判据只有一份',
  /pluginsWithInstalled\s*\(/.test(reg));

/* 剥注释必须做：模块文件头写着「mergeInstalled 早就写好」，
 * 不剥注释会把这句历史说明算成真调用（第 22 轮同款坑）。
 * 行注释判据带 [^:] 左边界，防把 https:// 的 // 当注释起点。 */
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
const hasDuplicateMerge = (s) => /\bmergeInstalled\s*\(/.test(stripJs(s));
t('④f 不另写一份 mergeInstalled（防商店面板与侧边栏分叉）',
  hasDuplicateMerge(reg) === false);

/** 判据：installed 分支必须排在 resolveEntry 之前。 */
function installedFirst(src) {
  const i = src.indexOf('export async function resolveFrameSrc(');
  if (i < 0) return false;
  const seg = src.slice(i, i + 2200);
  const a = seg.indexOf('manifest.installed === true');
  const b = seg.indexOf('return resolveEntry(manifest.entry)');
  return a >= 0 && b > a;
}
t('④g resolveFrameSrc 的 installed 分支排在 resolveEntry 之前',
  installedFirst(host));
t('④h installed 分支是 throws（走 showError 明确错误框，不静默套壳）',
  /manifest\.installed === true[\s\S]{0,900}throw new Error/.test(host));
t('④i 错误文案带 nextAction，用户知道下一步做什么',
  host.includes('nextAction: real-device-checks'));
t('④j 静态 runtime 分支仍在（12 个内置插件不受影响）',
  /!manifest\s*\|\|\s*!manifest\.runtime/.test(host));

/* ---------------- ⑤ 三处赋值点不许绕过 ---------------- */
for (const [name, src] of [
  ['host.js', host], ['js/shell.js', r('js/shell.js')], ['src/App.tsx', r('src/App.tsx')],
]) {
  t(`⑤ ${name} 仍走 loadRegistry（绕过它就装了不出现）`,
    /await\s+loadRegistry\s*\(/.test(src));
}

/* ---------------- ⑥ 台账状态不被自查自封 ---------------- */
let debt = null;
try { debt = JSON.parse(debtRaw); } catch { /* 下面会红 */ }
t('⑥a 台账是合法 JSON', !!debt);
t('⑥b status 仍是 wired、runtimeVerified 仍是 false',
  !!debt && debt.status === 'wired' && debt.runtimeVerified === false,
  debt && `${debt.status}/${debt.runtimeVerified}`);
t('⑥c runtime-load 仍为 pending-real-device（加载 URL 未验）',
  !!debt && (debt.blockers || []).some((b) => b.id === 'runtime-load'
    && b.status === 'pending-real-device'));
t('⑥d 新增 registry-entry 记为 resolved-in-code',
  !!debt && (debt.blockers || []).some((b) => b.id === 'registry-entry'
    && b.status === 'resolved-in-code'));
t('⑥e 每条 blocker 都有 id / why / options',
  !!debt && (debt.blockers || []).every((b) => b.id && b.why
    && Array.isArray(b.options) && b.options.length >= 2));

/* ---------------- ⑦ 元断言：判据自己不能恒真 ---------------- */
t('⑦a hasMergeCall 对空文本为假（不恒真）', hasMergeCall('') === false);
t('⑦b hasMergeCall 对「删掉调用」的文本为假',
  hasMergeCall(body.replace(/await\s+loadInstalledRegistry\s*\([^)]*\)/, 'list')) === false);
t('⑦c hasMergeCall 对「调用挪到 registerBuiltinIds 之前」为假',
  hasMergeCall('await loadInstalledRegistry(list); registerBuiltinIds([]);') === false);
t('⑦d installedFirst 对「分支在 resolveEntry 之后」为假',
  installedFirst('export async function resolveFrameSrc(manifest){'
    + ' const x=1; return resolveEntry(manifest.entry); }'
    + ' if (manifest.installed === true) throw new Error("x");') === false);
t('⑦e installedFirst 对空文本为假', installedFirst('') === false);
t('⑦e2 剥注释判据能认出真写了第二份 mergeInstalled（不恒假）',
  hasDuplicateMerge('import { mergeInstalled } from "./x.js";\nconst y = mergeInstalled(a, b);') === true);
t('⑦e3 剥注释判据不把注释里的说明算成调用',
  hasDuplicateMerge('/* 以前用过 mergeInstalled() */\nconst y = doScan(a, b);') === false);
{
  const stat = { id: 'home' };
  const inst = { id: 'foo', installed: true, entry: 'index.html' };
  const out = projectInstalled([stat, inst]);
  t('⑦f projectInstalled 确实会给 installed 打标记（不恒等）',
    out[1].loadState === LOAD_STATE && out[1].installedEntry === 'index.html');
  t('⑦g projectInstalled 不污染静态插件', out[0] === stat
    && out[0].loadState === undefined);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
