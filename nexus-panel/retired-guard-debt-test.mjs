#!/usr/bin/env node
/**
 * 退场态欠账守卫 —— 删掉 136 条死 script 后，主仓剩下的假红必须有账
 * ==========================================================================
 * 实测（干净远端树，不是本地留着 12 份源码副本的工作区）：
 *   退场前 5 个守卫里 4 个红；删除 136 条死 script 后仍剩 25 条红，
 *   全部是「对象随插件源码迁出主仓」造成，不是真缺陷。
 *
 * 本守卫刻意**不改那 4 个现有守卫的任何判据** —— 零敲碎打改守卫消红，
 * 正是本项目反复反对的。改用既有手法：白名单＝欠账台账。
 *   · 修好一条 → 探针刷新快照后，本守卫红，逼你同步销台账
 *   · 新增一条红 → 本守卫红，逼你先想清楚
 *   · 台账/快照任一侧被悄悄改动 → 集合对不上即红
 *
 * ⚠️ 离线：只读 scripts/retired-guard-snapshot.json（由联网探针生成），
 *    网络失败绝不冒充「内容没漂移」。刷新快照须显式跑 probe-retired-state.mjs。
 * ⚠️ 不 spawn 子进程：sweep-tests.mjs 会把不 spawn 的测试正常收录进体检单。
 * ⚠️ 已知边界：纯静态守不住「把主断言整行换成 true」，这层靠破坏验证兜。
 *
 * 运行：node retired-guard-debt-test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const R = (p) => join(ROOT, p);
const read = (p) => readFileSync(R(p), 'utf8');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  ok ? pass++ : fail++;
  if (!ok) console.log(`❌ ${name}${extra ? ' → ' + extra : ''}`);
};

const KNOWN_GUARDS = [
  'test-registry-test.mjs',
  'test-coverage-guard-test.mjs',
  'retired-supply-test.mjs',
  'orphan-modules-guard-test.mjs',
  'plugin-repo-sync-test.mjs',
];
const EXPECTED = 25;

/* 判据可注入：主断言与元断言共用同一份，分着写会各改各的。 */
const canon = (xs) => xs.map((x) => `${x.guard}\u0000${x.assertion}`).sort();
const setEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let debt = { rows: [] }, snap = { reds: [] };
let debtOk = true, snapOk = true, debtErr = '', snapErr = '';
try { debt = JSON.parse(read('scripts/retired-guard-debt.json')); } catch (e) { debtOk = false; debtErr = e.message; }
try { snap = JSON.parse(read('scripts/retired-guard-snapshot.json')); } catch (e) { snapOk = false; snapErr = e.message; }

t('① 欠账台账可解析', debtOk, debtErr);
t('① 快照可解析', snapOk, snapErr);
const rows = Array.isArray(debt.rows) ? debt.rows : [];
const reds = Array.isArray(snap.reds) ? snap.reds : [];

t('② 台账条数恰为 25（多一条/销一条都要喊）', rows.length === EXPECTED, String(rows.length));
t('② 快照条数恰为 25', reds.length === EXPECTED, String(reds.length));
t('③ 台账每条齐 guard/assertion/why/unblock，且说明不是空壳',
  rows.every((r) => KNOWN_GUARDS.includes(r.guard) && r.assertion
    && typeof r.why === 'string' && r.why.length > 20
    && typeof r.unblock === 'string' && r.unblock.length > 20));
t('③ 断言名已规范化（不含 " — 实际值" 后缀，否则快照永远对不上）',
  rows.every((r) => !r.assertion.includes(' — ')));
t('③ 台账无重复 (guard,assertion)', new Set(canon(rows)).size === rows.length);
t('③ 快照 reds 是纯字符串且无重复',
  reds.every((x) => typeof x === 'string') && new Set(reds).size === reds.length);

const actual = canon(rows);
t('④ 台账集合恰等于快照（销账必须两边一起改，单侧改会红）',
  setEq(actual, [...reds].sort()), `台账 ${actual.length} / 快照 ${reds.length}`);

/* ---- 元断言：判据不能是摆设 ---- */
const extra = { guard: 'test-registry-test.mjs', assertion: '假注入的一条新红' };
t('⑤ 元断言 A：多一条红时真判据会给出不同集合（防恒真）',
  !setEq(actual, canon(rows.concat([extra]))));
t('⑤ 元断言 B：台账少一行时条数判据会喊（防恒真）',
  (rows.length - 1) !== EXPECTED);
t('⑤ 元断言 C：空台账不得判为与快照一致（防恒假）',
  !setEq(canon([]), [...reds].sort()));
t('⑤ 元断言 D：快照多一条时 ④ 会红',
  !setEq(actual, [...reds, 'x\u0000y'].sort()));
t('⑤ 元断言 E：恒真判据会把「多一条红」判成相等（即假绿）',
  (() => { const badEq = () => true; return badEq(actual, canon(rows.concat([extra]))) === true; })());

console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
