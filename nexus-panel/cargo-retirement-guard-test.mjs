#!/usr/bin/env node
/**
 * 退场后的 cargo / 打包链守卫（离线、cwd 无关）
 * ============================================================
 * 背景：12 个 iframe 插件源码迁出主仓时只删了 plugins/<id>/ 目录，
 * 没有收尾打包链：
 *
 *   · src-tauri/tauri.conf.json 的 bundle.resources 仍写
 *     "../plugins/dupview/pdfium.dll": "pdfium.dll"
 *     → src-tauri/build.rs 的 tauri_build::build() 校验资源路径失败
 *     → cargo check / npm run tauri:build 100% 挂，报错是
 *       "resource path `..\plugins\dupview\pdfium.dll` doesn't exist"。
 *   · src-tauri/src/dupview/pdf.rs 的开发态候选路径也指向同一目录，
 *     它不报编译错，只在运行时静默退回系统库路径，UI 表现为
 *     「扫描没反应」—— 比上一条更难查。
 *
 * 而 5 个退场态守卫 + 欠账台账没有任何一个覆盖 cargo 链，体检单全绿。
 * 本守卫把「资源路径真实存在」和「不指向已退场目录」做成两条互不掩盖的
 * 判据（这个 BUG 的形状正是：删了目录，配置里的字符串还在）。
 *
 * 复用 test-scan-utils 的 stripCommentsFlatJs：全仓只此一份剥注释实现，
 * 自己再写一份会被 inline-strip-audit 当成新增内联实现（P0-3 欠账）。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsFlatJs } from './test-scan-utils.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const R = (...p) => resolve(HERE, ...p);
const read = (p) => readFileSync(R(p), 'utf8');
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  if (!ok) console.log(`❌ ${name}${extra ? ' → ' + extra : ''}`);
};

/* ---------- 纯判据 ---------- */

/** resources 的源路径列表；解析失败/结构异常返回 null（fail-closed，不等于"没有资源"） */
function resourceKeys(text) {
  let obj;
  try { obj = JSON.parse(text); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const res = obj?.bundle?.resources;
  if (res === undefined || res === null) return [];
  if (Array.isArray(res)) return res.filter((x) => typeof x === 'string');
  if (typeof res === 'object') return Object.keys(res);
  return null;
}

/** 维度一：指向已退场插件目录的引用 */
function retiredRefs(keys) {
  return keys.filter((k) => k.includes('../plugins/') || k.startsWith('plugins/'));
}

/** 维度二：tauri_build 真正会拒的那一类 —— 本地资源路径不存在 */
function missingRefs(keys, exists) {
  return keys.filter((k) => /^\.\.?\//.test(k) && !k.includes('*') && !exists(k));
}

/** 剥注释后取 Rust 字符串字面量里的 ../plugins/ 路径 */
function rsRetiredPaths(text) {
  const code = stripCommentsFlatJs(text);
  const re = /"[^"\n]*\.\.\/plugins\/[^"\n]*"/g;
  return [...code.matchAll(re)].map((m) => m[0]);
}

/** 先剥注释再匹配：注释掉 tauri_build::build() 等于绕过资源校验，
 *  若不剥注释，注释里的字样会把守卫骗成「仍在做校验」（假绿）。 */
function buildScriptChecks(text) {
  return /tauri_build\s*::\s*build\s*\(/.test(stripCommentsFlatJs(text));
}

/** 台账状态反演：dll 回来了就必须销账，不许台账永远挂着 */
function expectedDebt(hasDll) {
  return hasDll ? [] : ['pdfium-dll-absent'];
}

function walkRs(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { walkRs(p, out); continue; }
    if (name.endsWith('.rs')) out.push(p);
  }
  return out;
}

try {
  /* ---------- ① 主配置：资源路径必须真实存在 ---------- */
  const confText = read('src-tauri/tauri.conf.json');
  const keys = resourceKeys(confText);
  const existsFromSrcTauri = (k) => existsSync(resolve(R('src-tauri'), k));

  t('①a tauri.conf.json 可解析且 resources 结构合法', keys !== null);
  t('①b bundle.resources 不含指向已退场 plugins/ 的路径',
    keys !== null && retiredRefs(keys).length === 0,
    keys === null ? '解析失败' : retiredRefs(keys).join(','));
  t('①c bundle.resources 每条本地路径都真实存在',
    keys !== null && missingRefs(keys, existsFromSrcTauri).length === 0,
    keys === null ? '解析失败' : missingRefs(keys, existsFromSrcTauri).join(','));
  t('①d 不能靠删掉整个 resources 来"修"问题（runtime-plugins 仍在）',
    keys !== null && keys.some((k) => k.includes('runtime-plugins')),
    keys === null ? '解析失败' : keys.join(','));

  /* 元断言：两条判据各自独立成立，坏样本只坏一处也能抓 */
  const badRetired = ['../plugins/dupview/pdfium.dll', '../runtime-plugins/'];
  const badMissing = ['../runtime-plugins/', '../gone/file.dll'];
  t('①e 元断言：退役目录引用会被 ①b 判据抓到', eq(retiredRefs(badRetired), [badRetired[0]]));
  t('①f 元断言：不存在的资源路径会被 ①c 判据抓到（本次 BUG 的形状）',
    eq(missingRefs(badMissing, () => false), badMissing));
  t('①g 元断言：好样本两条判据都不误报',
    retiredRefs(['../runtime-plugins/']).length === 0
    && missingRefs(['../runtime-plugins/'], () => true).length === 0);
  t('①h 元断言：非法 JSON / 空文本不得判成"通过"',
    resourceKeys('{') === null && resourceKeys('') === null);
  const alwaysEmpty = () => [];
  t('①i 元断言：判据恒空的假实现会被 ①e 区分出来',
    alwaysEmpty(badRetired).length === 0 && retiredRefs(badRetired).length === 1);

  /* ---------- ② Rust 侧：不许再出现 ../plugins/ 字面量 ---------- */
  const rsFiles = walkRs(R('src-tauri/src'));
  const rsHits = [];
  for (const p of rsFiles) {
    const found = rsRetiredPaths(readFileSync(p, 'utf8'));
    for (const h of found) rsHits.push(`${relative(R('.'), p)}: ${h}`);
  }
  t('②a src-tauri/src 下无 ../plugins/ 路径字面量', rsHits.length === 0, rsHits.join(' | '));
  t('②b 元断言：注入一行真实字符串会被判据抓到',
    rsRetiredPaths('fn f(){ c.push(PathBuf::from("x").join("../plugins/dupview/x.dll")); }').length === 1);
  t('②c 元断言：只写在注释里的历史路径不算命中（剥注释生效）',
    rsRetiredPaths('// 旧版放在 ../plugins/dupview/pdfium.dll\nfn f(){}').length === 0);
  t('②d 元断言：空文本返回空集', rsRetiredPaths('').length === 0);
  t('②e pdf.rs 的开发态候选已改到 src-tauri/resources/（防回退）',
    read('src-tauri/src/dupview/pdf.rs').includes('join("resources/pdfium.dll")'));

  /* ---------- ③ 所有 tauri 配置（vite 配置会 merge 进主配置） ---------- */
  const confNames = readdirSync(R('src-tauri')).filter((n) => /^tauri.*\.json$/.test(n));
  t('③a 扫到的 tauri 配置不少于 2 份', confNames.length >= 2, String(confNames.length));
  for (const n of confNames) {
    const k = resourceKeys(read('src-tauri/' + n));
    t(`③b ${n} 资源引用合法`, k !== null
      && retiredRefs(k).length === 0
      && missingRefs(k, existsFromSrcTauri).length === 0,
      k === null ? '解析失败' : k.join(','));
  }
  const injectedConf = JSON.stringify({ bundle: { resources: { '../plugins/dupview/pdfium.dll': 'pdfium.dll' } } });
  const injectedKeys = resourceKeys(injectedConf);
  t('③c 元断言：给任一配置注入坏路径，配置级判据会抓',
    retiredRefs(injectedKeys).length === 1 && missingRefs(injectedKeys, () => false).length === 1);

  /* ---------- ④ 欠账台账：dll 缺失不许静默当无事发生 ---------- */
  const debt = JSON.parse(read('scripts/cargo-retirement-debt.json'));
  const dllExists = existsSync(R('src-tauri/resources/pdfium.dll'));
  const rows = Array.isArray(debt.rows) ? debt.rows : null;
  const expected = expectedDebt(dllExists);
  t('④a 台账可解析且恰为期望欠账集合',
    rows !== null && eq(rows.map((r) => r.id), expected),
    rows === null ? 'rows 缺失' : rows.map((r) => r.id).join(',') + ` / 期望 ${expected.join(',')}`);
  t('④b 台账每条有 why / unblock / evidence',
    rows !== null && rows.every((r) => r.why && r.why.length > 20 && r.unblock && r.unblock.length > 20 && r.evidence));
  t('④c 元断言：dll 存在时台账必须销空、缺席时必须挂着（状态反演）',
    eq(expectedDebt(true), []) && eq(expectedDebt(false), ['pdfium-dll-absent']));
  const cleared = [];
  t('④d 元断言：清空台账会被 ④a 抓到（dll 已恢复时清空才正确）',
    eq(cleared, expected) === (expected.length === 0));
  t('④e 台账 note 说明白名单即欠账', typeof debt.note === 'string' && debt.note.includes('欠账'));

  /* ---------- ⑤ build.rs 不许被删（删了等于绕过资源校验） ---------- */
  const buildRs = read('src-tauri/build.rs');
  t('⑤a build.rs 仍调用 tauri_build::build()', buildScriptChecks(buildRs));
  t('⑤b 元断言：空文本不判为已校验', buildScriptChecks('') === false);
  t('⑤c 元断言：注释掉的调用不判为已校验（防绕过资源校验）',
    buildScriptChecks('fn main() { /* tauri_build::build() */ }') === false);

  /* ---------- ⑥ 守卫自身必须被 npm script 点名 ---------- */
  const pkg = JSON.parse(read('package.json'));
  const registered = (p) => p?.scripts?.['test:cargo-retirement'] === 'node cargo-retirement-guard-test.mjs';
  t('⑥a test:cargo-retirement 指向本守卫', registered(pkg), String(pkg.scripts?.['test:cargo-retirement']));
  t('⑥b 元断言：空 scripts / 错命令不判为已登记',
    registered({}) === false
    && registered({ scripts: { 'test:cargo-retirement': 'node other.mjs' } }) === false);
} catch (e) {
  t('守卫执行异常（fail-closed，不静默放行）', false, String(e && e.message || e));
}

console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
