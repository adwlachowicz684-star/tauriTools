#!/usr/bin/env node
/**
 * 退场态欠账守卫 —— 销账态
 * ==========================================================================
 * 第 30 轮：删除 136 条死 script 后，干净远端树实跑 5 个守卫仍剩 25 条红，
 *   全部是「对象随插件源码迁出主仓」造成，不是真缺陷。用既有手法
 *   「白名单 = 欠账台账」钉住：台账与快照必须双向一致。
 *
 * 第 37 轮 ★ 查出守卫自己成了假绿：
 *   探针 probe-retired-state.mjs 在干净远端树实跑那 5 个守卫，合计 0 红；
 *   而台账 25 条、快照 25 条、本守卫 14/0 全绿 —— 它验的只是「两份文件一致」，
 *   两份都是退场初期的过期数据，互相印证，谁也没对过现实。
 *   这比「台账漂移」更难发现：不崩、不红、不缺汇总行。
 *
 * 现在 rows / reds 均为空且 EXPECTED=0。⚠️ 空集合下 ④ 的集合判据恒真，
 * 单靠它守不住任何东西，所以销账态必须另配三层：
 *   ① 销账前提：快照确由那个探针刷新、解析成功、5 个守卫文件仍在、note 有依据
 *   ② 注入样本：任一侧偷偷加一条 / 条数被改 / 判据恒空，元断言都要喊
 *   ③ 每轮改动跑 probe --check 兜底 —— 离线守卫无法自己证明「现实 0 红」，
 *      它能钉住的只是「快照来自那个探针且被显式刷新过」。这个边界不藏着。
 *
 * ⚠️ 不 spawn：sweep-tests.mjs 会把不 spawn 的测试正常收进体检单。
 * ⚠️ 已知边界：纯静态守不住「把主断言整行换成 true」，靠每轮破坏验证兜。
 *
 * 运行：node retired-guard-debt-test.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
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
const EXPECTED = 0;

/* 判据抽成共用函数：主断言与元断言各写一份会各改各的，一边敏感一边不敏感。 */
const canon = (xs) => xs.map((x) => `${x.guard}\u0000${x.assertion}`).sort();
const setEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const countOk = (n) => n === EXPECTED;
const rowsWellFormed = (rows) => rows.every((r) => KNOWN_GUARDS.includes(r.guard) && r.assertion
  && typeof r.why === 'string' && r.why.length > 20
  && typeof r.unblock === 'string' && r.unblock.length > 20);
const noSuffix = (rows) => rows.every((r) => !r.assertion.includes(' — '));

let debt = { rows: [] }, snap = { reds: [] };
let debtOk = true, snapOk = true, debtErr = '', snapErr = '';
try { debt = JSON.parse(read('scripts/retired-guard-debt.json')); } catch (e) { debtOk = false; debtErr = e.message; }
try { snap = JSON.parse(read('scripts/retired-guard-snapshot.json')); } catch (e) { snapOk = false; snapErr = e.message; }

t('① 欠账台账可解析', debtOk, debtErr);
t('① 快照可解析', snapOk, snapErr);
const rows = Array.isArray(debt.rows) ? debt.rows : [];
const reds = Array.isArray(snap.reds) ? snap.reds : [];

/* ---------- ② 销账态：两边都必须真的空 ---------- */
t('② 台账条数恰为 0（偷偷加一条 / 把数字改回 25 都要喊）',
  countOk(rows.length), String(rows.length));
t('② 快照条数恰为 0', countOk(reds.length), String(reds.length));

/* ---------- ③ 格式判据（空集合下恒真，靠 ⑤F 证明它不是摆设） ---------- */
t('③ 台账每条齐 guard/assertion/why/unblock', rowsWellFormed(rows));
t('③ 断言名已规范化（不含 " — 实际值" 后缀）', noSuffix(rows));
t('③ 台账无重复 (guard,assertion)', new Set(canon(rows)).size === rows.length);
t('③ 快照 reds 是纯字符串且无重复',
  reds.every((x) => typeof x === 'string') && new Set(reds).size === reds.length);

const actual = canon(rows);
t('④ 台账集合恰等于快照（销账必须两边一起改，单侧改会红）',
  setEq(actual, [...reds].sort()), `台账 ${actual.length} / 快照 ${reds.length}`);

/* ---------- ④b 销账前提：不是把证据抹掉了 ---------- */
t('④b 销账前提：快照确由 probe-retired-state.mjs 刷新（不是手改空）',
  snap.capturedBy === 'probe-retired-state.mjs', String(snap.capturedBy));
t('④c 销账前提：5 个守卫文件仍在（不是把守卫删了消红）',
  KNOWN_GUARDS.every((g) => existsSync(R(g))));
t('④d 销账前提：台账 note 写明销账依据（探针 / 0 红）',
  typeof debt.note === 'string' && /探针|0 红/.test(debt.note));
t('④e 销账前提：reds 是数组且为空（不是文件损坏后的空壳）',
  Array.isArray(snap.reds) && snap.reds.length === 0);
t('④f 销账前提：台账 capturedBy 与快照一致',
  debt.capturedBy === snap.capturedBy);

/* ---------- ⑤ 元断言：空集合下判据不能是摆设 ---------- */
const extra = { guard: 'test-registry-test.mjs', assertion: '假注入的一条新红' };
t('⑤ 元断言 A：台账多一条时真判据会给出不同集合（防恒真）',
  !setEq(actual, canon(rows.concat([extra]))));
t('⑤ 元断言 B：条数判据能识别「多一条」（不是恒真）',
  countOk(rows.length) === true && countOk(rows.length + 1) === false);
t('⑤ 元断言 C：快照多一条时 ④ 会红（空集也不是恒真）',
  !setEq(actual, [...reds, 'x\u0000y'].sort()));
t('⑤ 元断言 D：恒空判据会把「多一条红」判成相等（即必须用真 canon）',
  (() => { const alwaysEmpty = () => []; return setEq(alwaysEmpty(rows.concat([extra])), alwaysEmpty(rows)) === true; })());
t('⑤ 元断言 E：恒真判据会把「多一条红」判成相等（即假绿）',
  (() => { const badEq = () => true; return badEq(actual, canon(rows.concat([extra]))) === true; })());
t('⑤ 元断言 F：rowsWellFormed 对缺 why 的假行返回 false（格式判据不是恒真）',
  rowsWellFormed([{ guard: 'test-registry-test.mjs', assertion: 'x', why: 'short', unblock: 'short' }]) === false);
t('⑤ 元断言 G：把 EXPECTED 改回 25 时条数判据会红',
  (() => { const oldCountOk = (n) => n === 25; return oldCountOk(rows.length) === false; })());

console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
