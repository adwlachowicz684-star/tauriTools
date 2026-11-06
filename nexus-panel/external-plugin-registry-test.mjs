#!/usr/bin/env node
/**
 * 外部工具型插件登记守卫
 * ============================================================
 * 背景：第 47 轮把 github-manager 登记成「与 12 个可安装插件并列平级、
 * 但不参与产物链」的 EXTERNAL_PLUGINS。plugin-repo-map.mjs 为此写了十条
 * 注释解释「为什么不能塞进 CAMEL」，而全仓守卫只盯 CAMEL：
 *   · plugin-repo-sync-test.mjs 逐份校验 CAMEL 的 12 个值
 *   · repo-mirror-sync-test.mjs 钉住 IDS = Object.keys(CAMEL).sort()
 *   · plugin-identity-test.mjs 钉住 registry 25 = module 13 + runtime 12
 * 新表一项都没被守着。
 *
 * 最危险的是 `CAMEL[id] || EXTERNAL_PLUGINS[id]` 这个短路：万一有人把
 * 外部 id 也写进 CAMEL（照旧错误提示「新增插件须同步补 CAMEL 映射」做，
 * 就会这么干），短路静默以 CAMEL 为准，仓库名**一个字节都不变**
 * —— camelOf('github-manager') 恰好也是 githubManager —— 于是没有任何
 * 基于仓库名的守卫会发现，只有 IDS 变成 13 才会在别处红一片。而那时
 * 共享镜像与 nexus.plugin.json 已经在往 Node CLI 仓库里推了。
 *
 * 所以本守卫分两层：行为层真 import 模块（含双表重叠、原型链、错误文案），
 * 接线层剥注释扫四条建仓/刷新/核验/发布通道，确认外部表没被并进遍历源。
 * 反向验证用「把真实源码做字符串变换后动态 import」的变体模块，
 * 不改动磁盘上的生产文件。
 *
 * 运行：node external-plugin-registry-test.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripCommentsFlatJs } from './test-scan-utils.mjs';
import {
  CAMEL, EXTERNAL_PLUGINS, REPO_PREFIX, OWNER, repoNameFor, repoFieldFor,
} from './scripts/plugin-repo-map.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = rel => readFileSync(join(ROOT, rel), 'utf8');
const clean = rel => stripCommentsFlatJs(read(rel));

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

/* ---------- 可注入判据（反向验证测的就是这些） ---------- */
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const throwsFor = (mod, id) => {
  try { mod.repoNameFor(id); return false; } catch { return true; }
};
const nameOf = (mod, id) => {
  try { return mod.repoNameFor(id); } catch (e) { return 'THREW:' + String(e && e.message || e); }
};
const unknownMsg = (mod) => {
  try { mod.repoNameFor('ghost-plugin'); return ''; }
  catch (e) { return String((e && e.message) || e); }
};
const noOverlap = (camel, external) => {
  const ck = Object.keys(camel), ek = Object.keys(external);
  if (ck.some(k => has(external, k))) return false;
  const cv = Object.values(camel), ev = Object.values(external);
  return !cv.some(v => ev.includes(v));
};
const msgMentionsBoth = (mod) => {
  const m = unknownMsg(mod);
  return /CAMEL/.test(m) && /EXTERNAL_PLUGINS/.test(m);
};
const idSourcesOnlyCamel = (src) =>
  src.includes('export const IDS = Object.keys(CAMEL).sort()')
  && !/Object\.keys\(\s*EXTERNAL_PLUGINS\s*\)/.test(src)
  && !/\[\s*\.\.\.Object\.keys\(CAMEL\)\s*,\s*\.\.\.Object\.keys\(EXTERNAL_PLUGINS\)/.test(src);
const protoSafe = (mod) =>
  ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']
    .every(id => throwsFor(mod, id));

/* ---------- ① 前置：集合非空，别让空集合判据恒真 ---------- */
const camelIds = Object.keys(CAMEL);
const externalIds = Object.keys(EXTERNAL_PLUGINS);
t('①a 前置：可安装插件集合非空且恰为 12', camelIds.length === 12, `实际 ${camelIds.length}`);
t('①b 前置：外部工具型集合非空', externalIds.length >= 1, `实际 ${externalIds.length}`);
t('①c 元断言：空集合不会通过 ①a/①b', !(camelIds.length === 0 && externalIds.length === 0));
t('①d 两张表的 id 与驼峰值都无交集', noOverlap(CAMEL, EXTERNAL_PLUGINS));
t('①e 元断言：注入双表重叠会被判据抓到',
  !noOverlap({ ...CAMEL, 'github-manager': 'githubManager' }, EXTERNAL_PLUGINS));
t('①f 元断言：注入同名驼峰值（不同 id）也会被抓到',
  !noOverlap(CAMEL, { 'another-tool': 'mindmap' }));
t('①g 全部 13 个仓库名互不重复',
  new Set([...Object.values(CAMEL), ...Object.values(EXTERNAL_PLUGINS)]).size
    === camelIds.length + externalIds.length);

/* ---------- ② 行为层：真 import 的模块 ---------- */
const MOD = { repoNameFor };
for (const id of camelIds) {
  t(`②a ${id}: 仓库名 = 前缀 + CAMEL 值`,
    nameOf(MOD, id) === `${REPO_PREFIX}${CAMEL[id]}`, nameOf(MOD, id));
}
for (const id of externalIds) {
  t(`②b ${id}: 外部工具型也走同一个仓库名规则`,
    nameOf(MOD, id) === `${REPO_PREFIX}${EXTERNAL_PLUGINS[id]}`, nameOf(MOD, id));
  t(`②c ${id}: repoFieldFor 与 repoNameFor 一致`,
    repoFieldFor(id) === `${OWNER}/${REPO_PREFIX}${EXTERNAL_PLUGINS[id]}`);
}
t('②d 未登记 id fail-closed 抛错', throwsFor(MOD, 'ghost-plugin'));
t('②e 未登记 id 的错误文案同时指向两张表（不把人往 CAMEL 里带）', msgMentionsBoth(MOD),
  unknownMsg(MOD));
t('②f 原型链键一律抛错，不拼出形似合规的仓库名', protoSafe(MOD));

/* ---------- ③ 接线层：四条通道的遍历源只认 CAMEL ---------- */
const gen = clean('scripts/build-plugin-repos.mjs');
t('③a IDS 仍只从 CAMEL 派生', idSourcesOnlyCamel(gen));
t('③b 元断言：把外部表并进 IDS 的合成样本会被拒绝',
  !idSourcesOnlyCamel('export const IDS = Object.keys(CAMEL).sort()\n'
    + 'IDS.push(...Object.keys(EXTERNAL_PLUGINS));'));
t('③c 元断言：空文本不会被当成合规', !idSourcesOnlyCamel(''));
t('③d 元断言：只写外部表也不合规',
  !idSourcesOnlyCamel('export const IDS = Object.keys(EXTERNAL_PLUGINS).sort()'));

const channels = [
  'scripts/create-plugin-repos.mjs',
  'scripts/refresh-plugin-repos.mjs',
  'scripts/verify-plugin-repos.mjs',
  'scripts/publish-plugin-releases.mjs',
  'scripts/retire-plugin-sources.mjs',
  'scripts/verify-source-retirement.mjs',
];
for (const rel of channels) {
  const src = clean(rel);
  t(`③e ${rel.split('/').pop()}: 不把 EXTERNAL_PLUGINS 并进建仓/刷新/发布遍历源`,
    !/Object\.keys\(\s*EXTERNAL_PLUGINS\s*\)/.test(src));
}
{
  const mapSrc = clean('scripts/plugin-repo-map.mjs');
  t('③f repoNameFor 真的接了外部表（不是只声明不用）',
    /EXTERNAL_PLUGINS/.test(mapSrc.slice(mapSrc.indexOf('export function repoNameFor'))));
  t('③g repoNameFor 用 hasOwnProperty 判登记，不是裸取值短路',
    /hasOwnProperty/.test(mapSrc.slice(mapSrc.indexOf('export function repoNameFor'))));
  t('③h 元断言：旧短路写法会被 ③g 抓到',
    !/hasOwnProperty/.test('export function repoNameFor(id) {\n'
      + '  const c = CAMEL[id] || EXTERNAL_PLUGINS[id];\n  return c;\n}'));
}

/* ---------- ④ 反向验证：真实源码变换后动态 import ---------- */
const mapText = read('scripts/plugin-repo-map.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'nx-ext-reg-'));
let seq = 0;
/* ⛔ 变体必须能编译。第一版 V2 的替换把模板字符串截成半截，脚本直接
   SyntaxError 崩在 ④b 之后，后面十几条断言一条没跑、而 tail 管道把退出码
   吞成 0 —— 崩掉的脚本比写错的脚本更危险，它连"自己没在干活"都不说。 */
async function variant(transform, label) {
  const p = join(tmp, `v${++seq}.mjs`);
  writeFileSync(p, transform(mapText), 'utf8');
  try {
    const mod = await import(pathToFileURL(p).href);
    /* ⛔ 不许写 `, true` 占位：那样变体编译出空模块也照样报绿，
       后面十几条断言会拿 undefined 当证据，整节变成假绿。 */
    t(`④ 编译闸门：${label} 变体可加载`, !!(mod
      && typeof mod.repoNameFor === 'function'
      && mod.CAMEL && mod.EXTERNAL_PLUGINS),
      `repoNameFor=${typeof (mod && mod.repoNameFor)}`);
    return mod;
  } catch (e) {
    t(`④ 编译闸门：${label} 变体可加载`, false, String((e && e.message) || e));
    return null;
  }
}
const oldShortCircuit = s => s.replace(
  /export function repoNameFor\(id\) \{[\s\S]*?\n\}/,
  `export function repoNameFor(id) {
  const c = CAMEL[id] || EXTERNAL_PLUGINS[id];
  if (!c) throw new Error('未登记的插件 id: ' + id + '（新增插件须同步补 CAMEL 映射）');
  return REPO_PREFIX + c;
}`);
const onlyCamelMsg = s => s.replace(
  /  if \(!c\) \{[\s\S]*?\n  \}/,
  "  if (!c) throw new Error('未登记的插件 id: ' + id + '（新增插件须同步补 CAMEL 映射）');");
const dualRegistered = s => s.replace(
  /export const EXTERNAL_PLUGINS = \{/,
  "export const EXTERNAL_PLUGINS = {\n  'mindmap': 'mindmap',");
const nullMod = { repoNameFor: () => { throw new Error('变体未编译'); } };
const V = m => m || nullMod;

try {
  const v1 = await variant(oldShortCircuit, 'V1 旧短路');
  t('④a V1 旧短路：原型链键不再 fail-closed（证明 ②f 不恒真）', !protoSafe(V(v1)));
  t('④b V1 旧短路：错误文案只提 CAMEL（证明 ②e 不恒真）', !msgMentionsBoth(V(v1)));

  const v2 = await variant(onlyCamelMsg, 'V2 旧文案');
  t('④c V2 文案改回只提 CAMEL → ②e 会红', !msgMentionsBoth(V(v2)));
  t('④d V2 仍能把外部 id 解析对（证明 ④c 判的是文案不是接线）',
    nameOf(V(v2), externalIds[0]) === `${REPO_PREFIX}${EXTERNAL_PLUGINS[externalIds[0]]}`);

  const v3 = await variant(dualRegistered, 'V3 双表重叠');
  t('④e V3 双表重叠 → 必须显式拒绝，不许短路静默以 CAMEL 为准',
    throwsFor(V(v3), 'mindmap'), nameOf(V(v3), 'mindmap'));
  t('④f V3 双表重叠 → ①d 的重叠判据也会红',
    !noOverlap(CAMEL, { ...EXTERNAL_PLUGINS, mindmap: 'mindmap' }));

  const v4 = await variant(s => s.replace(
    /  const inCamel = has\(CAMEL, id\);/,
    '  const inCamel = false;'), 'V4 摘 CAMEL 分支');
  t('④g V4 摘掉 CAMEL 分支 → 可安装插件全部解析不了（证明 ②a 不恒真）',
    nameOf(V(v4), camelIds[0]) !== `${REPO_PREFIX}${CAMEL[camelIds[0]]}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
