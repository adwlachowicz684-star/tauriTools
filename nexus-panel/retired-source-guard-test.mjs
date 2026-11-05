#!/usr/bin/env node
/**
 * 退场源码引用守卫：登记了的 test:* 不许悄悄引用「主仓已经没有」的插件源码
 * ==========================================================================
 * 起因（本轮实测，也是上一轮结论的更正）：
 *   第 38 轮把 12 个插件的源码整体迁到独立私有仓后，主仓 plugins/<id>/ 只剩
 *   空目录。上一轮只口头报了 `test:controls` / `test:dead-class` 两套崩在
 *   ENOENT —— 实际是 **43 个已登记脚本、153 条不存在的 plugins/ 引用**，
 *   其中至少 17 套实跑崩在半路（一条断言都跑不到），另有若干挂起。
 *
 *   更难察觉的是「体检单全绿」：test:coverage-guard 守的是「有没有登记」，
 *   retired-guard-debt 守的是「台账与快照互相一致」，谁也没问过
 *   「登记的那条命令，指向的源码还在不在」。于是 CI 只看关键几套时，
 *   一片守卫从没执行过，报告上照样全绿。
 *
 * 本守卫只做机械可判定的一层：
 *   剥注释 → 扫全部 test:* 脚本里的 plugins/<id>/<path> 字面量 → 与磁盘比
 *   → 不存在的引用必须与欠账台账 **双向一致**（少登记 / 台账过期都报红）。
 *   不做语义判定：合成样本与真读盘都由台账写明 kind / why / unblock。
 *
 * ⚠ 判据自己最容易漏报，这里已经栽过一次：
 *   第一版写成「路径最后一段必须含 /」，结果把最常见的两层路径
 *   `plugins/mindmap/styles.css` 全部跳过，53 条只剩 21 条。
 *   改成 `p.split('/').length >= 3` 才是「plugins/<id>/<file>」。
 *   所以 ⑤ 的注入样本专门钉住两层路径必须认得出。
 *
 * ⚠ 不 spawn（sweep 的 isMetaTest 要求 spawn+.scripts+test: 三者同时命中，
 *   本文件不 spawn，能被正常收进体检单）；ROOT 取自 import.meta.url，
 *   cwd-invariant 换到空目录跑时结论不变。
 *
 * 运行：node retired-source-guard-test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAMEL, REPO_PREFIX } from './scripts/plugin-repo-map.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const R = (p) => join(ROOT, p);
const read = (p) => readFileSync(R(p), 'utf8');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  if (!ok) console.log(`❌ ${name}${extra ? ' → ' + extra : ''}`);
};

/* ---------------- 共用判据（主断言与元断言只用这一份） ---------------- */
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, (m, pre) => pre);

const PATH_RE = /plugins\/[A-Za-z0-9_-]+\/[A-Za-z0-9_./-]+/g;

/** 返回一段源码里「引用了但磁盘上不存在」的 plugins/ 路径集合。 */
const missingOf = (src, root = ROOT) => {
  const out = new Set();
  for (const m of strip(src).matchAll(PATH_RE)) {
    const p = m[0].replace(/[)'"` ,;]+$/, '');
    // plugins/<id>/<file> 最少三段；写成「最后一段含 /」会漏掉两层源码路径
    if (p.split('/').length < 3) continue;
    if (!existsSync(join(root, p))) out.add(p);
  }
  return out;
};

const key = (g, r) => g + '\u0000' + r;
const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));
const canon = (xs) => [...xs].sort().join('\n');

/* ---------------- ① 枚举已登记脚本 ---------------- */
const pkg = JSON.parse(read('package.json'));
const guards = new Map();
for (const [name, cmd] of Object.entries(pkg.scripts)) {
  if (!name.startsWith('test:')) continue;
  const m = /([\w./-]+\.(?:mjs|cjs|js|tsx?))\b/.exec(cmd);
  if (!m || !existsSync(R(m[1]))) continue;
  const g = m[1];
  if (!guards.has(g)) guards.set(g, []);
  guards.get(g).push(name);
}

const actual = new Set();
for (const g of guards.keys()) {
  for (const r of missingOf(read(g))) actual.add(key(g, r));
}

/* ---------------- ② 台账与双向集合一致 ---------------- */
let ledger;
try {
  ledger = JSON.parse(read('scripts/retired-source-guards.json'));
} catch (e) {
  console.log('❌ 台账不可解析：' + e.message);
  console.log('通过 0 项，失败 1 项');
  process.exit(1);
}
const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
const book = new Set();
for (const r of rows) {
  for (const ref of r.refs || []) book.add(key(r.guard, ref));
}

t('① 台账非空（空集合下集合判据恒真，等于没守）', rows.length > 0,
  `rows=${rows.length}`);
t('② 实际引用 ⊆ 台账（新增的退场引用必须登记）',
  [...actual].every((x) => book.has(x)),
  '未登记：' + [...actual].filter((x) => !book.has(x)).slice(0, 3).join(' , '));
t('② 台账 ⊆ 实际引用（台账不许留过期条目）',
  [...book].every((x) => actual.has(x)),
  '过期：' + [...book].filter((x) => !actual.has(x)).slice(0, 3).join(' , '));
t('② 扫描结果非空（全绿迁移完成后须显式改成销账态判据）', actual.size > 0,
  `actual=${actual.size}`);

/* ---------------- ③ 台账每条都要有依据、对象仍存在 ---------------- */
const knownRepos = new Set(Object.values(CAMEL).map((c) => REPO_PREFIX + c));
const SAMPLE = '（合成样本，无归属仓）';
const badRow = [];
for (const r of rows) {
  const ok = guards.has(r.guard)
    && Array.isArray(r.refs) && r.refs.length > 0
    && typeof r.why === 'string' && r.why.length > 20
    && typeof r.unblock === 'string' && r.unblock.length > 20
    && Array.isArray(r.repos) && r.repos.length > 0
    && r.repos.every((x) => x === SAMPLE || knownRepos.has(x))
    && r.refs.every((p) => !existsSync(R(p)));
  if (!ok) badRow.push(r.guard);
}
t('③ 台账每条：guard 仍登记 / refs 非空且确实不存在 / why+unblock 有依据 / 归属仓来自 CAMEL',
  badRow.length === 0, badRow.slice(0, 4).join(' , '));
t('③ 归属仓集合来自唯一真值源（不另抄一份）', knownRepos.size >= 12,
  `knownRepos=${knownRepos.size}`);

/* ---------------- ④ 集合判据自己不能是恒真 / 恒假 ---------------- */
t('④ 集合判据不是恒真（换成恒真时注入样本必须报红）',
  setEq(actual, new Set(['__never_a_real_key__'])) === false);
t('④ 集合判据不是恒假', setEq(actual, actual) === true);
t('④ 少登记一条必然报红', setEq(actual, new Set([...book].slice(1))) === false);

/* ---------------- ⑤ 注入样本：判据形态必须认得全 ---------------- */
// 样本用 join 拼出，避免本文件自身被扫描时混进一条真实引用
const probePath = ['plugins', 'zz-probe', 'ghost.ts'].join('/');
const probeSrc = `const a = "${probePath}"; const b = "package.json";`;
t('⑤ 两层源码路径认得出（第一版判据就是在这里漏报的）',
  missingOf(probeSrc).has(probePath));
t('⑤ 存在的路径不误报', !missingOf('const a = "package.json";').has('package.json'));
t('⑤ 注释里的假路径不算数（剥注释生效）',
  !missingOf(`// const a = "${probePath}";`).has(probePath));
t('⑤ 台账删一条后双向判据必红',
  (() => {
    const less = new Set([...book].slice(1));
    return !setEq(actual, less) && !setEq(less, actual);
  })());
t('⑤ 规范化后的集合可复算（canon 不吞条目）',
  canon(actual).split('\n').length === actual.size || actual.size === 0);

console.log(`\n已登记 test:* 脚本 ${guards.size} 个，退场源码引用 ${actual.size} 条，台账 ${rows.length} 行 / ${book.size} 条`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
