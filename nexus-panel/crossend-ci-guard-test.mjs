#!/usr/bin/env node
/**
 * 跨端契约 CI 归属守卫（离线，进体检单）
 * ==========================================================================
 * 插件源码退场后，TS 侧契约（api.ts / types.ts）迁到独立仓，主仓只剩 Rust 侧。
 * 主仓 `test:crossend-contract`（无 --ts-root）因此 fail-closed 报红 —— 那是
 * 职责归属提示，不是能力缺失；真正的两端比对在持有 TS 契约的插件仓 CI 里跑。
 *
 * 本守卫钉住三件事：
 *   ① 主仓模板存在且要素齐全（校验器、--strict、双 root、公开仓匿名 clone）
 *   ② 适用仓集合由 12 仓实测快照**独立反推**，必须恰等于欠账台账
 *   ③ 主仓那两条 script 仍在 —— 防止有人悄悄删掉红项当「消红」
 *
 * ⚠️ 离线：快照由联网探针 scripts/probe-crossend-ci.mjs 刷新，网络失败绝不
 *    冒充「仓里没有契约文件」。纯静态守不住「把主断言整行换成 true」，这层
 *    靠每轮改动的破坏验证兜底。
 * ⚠️ 不 spawn：sweep-tests.mjs 会把不 spawn 的测试正常收进体检单。
 *
 * 运行：node crossend-ci-guard-test.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
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

/* 判据抽成共用函数：主断言与元断言若各写一份，改了一边另一边不会喊。 */
const hasBoth = (v) => Array.isArray(v?.api) && v.api.length > 0
  && Array.isArray(v?.types) && v.types.length > 0;
const derive = (repos, pred) => Object.entries(repos)
  .filter(([, v]) => pred(v)).map(([name]) => name).sort();
const setEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let scan, ledger, pkg, tpl = '', parseOk = true, parseErr = '';
try {
  scan = JSON.parse(read('scripts/crossend-ci-scan.json'));
  ledger = JSON.parse(read('scripts/crossend-ci-applicable.json'));
  pkg = JSON.parse(read('package.json'));
  tpl = read('templates/plugin-repo/contract.yml');
} catch (e) { parseOk = false; parseErr = e.message; }
t('① 四份输入可解析', parseOk, parseErr);
if (!parseOk) { console.log(`通过 ${pass} 项，失败 ${fail} 项`); process.exit(1); }

const repos = scan.repos || {};
const rows = Array.isArray(ledger.rows) ? ledger.rows : [];
const scripts = pkg.scripts || {};

/* ---------- ① 模板要素 ---------- */
t('①a 模板引用 cross-end-check.mjs 且带 --strict',
  /cross-end-check\.mjs/.test(tpl) && /--strict/.test(tpl));
t('①b 模板同时给 --root（主仓 Rust）与 --ts-root（本仓 TS）',
  /--root=/.test(tpl) && /--ts-root=/.test(tpl));
t('①c 模板从公开主仓匿名 shallow clone，且不注入任何凭据',
  /git clone --depth 1 https:\/\/github\.com\/adwlachowicz684-star\/tauriTools\.git/.test(tpl)
  && !/secrets\./.test(tpl) && !/\$\{\{\s*secrets\./.test(tpl));
t('①d 模板跑校验前先验 TS 契约两个文件存在（缺失不空跑）',
  /\$TS_DIR\/api\.ts/.test(tpl) && /\$TS_DIR\/types\.ts/.test(tpl));
t('①e 模板写明适用条件（不是 12 仓无差别安装）',
  /同时持有/.test(tpl) && /缺 api\.ts/.test(tpl));

/* ---------- ② 快照独立反推 vs 欠账台账 ---------- */
t('②a 快照恰覆盖 12 个插件仓', Object.keys(repos).length === 12, String(Object.keys(repos).length));
t('②b 快照每仓都有 api/types 数组',
  Object.values(repos).every((v) => Array.isArray(v.api) && Array.isArray(v.types)));
t('②c 快照仓名全部是 nexusPanel_plugin_ 前缀',
  Object.keys(repos).every((k) => k.startsWith('nexusPanel_plugin_')));

const expected = derive(repos, hasBoth);
const ledRepos = rows.map((r) => r.repo).sort();
t('②d 独立反推的适用集合恰为 1（12 仓实测只有 projectGroup 同时有两文件）',
  expected.length === 1 && expected[0] === 'nexusPanel_plugin_projectGroup',
  JSON.stringify(expected));
t('②e 反推集合恰等于台账（多装一个/漏装一个都会红）',
  setEq(expected, ledRepos), `反推 ${expected.length} / 台账 ${ledRepos.length}`);
t('②f 台账每条齐 repo/tsDir/workflow/why/unblock',
  rows.every((r) => r.repo && r.tsDir && r.workflow
    && typeof r.why === 'string' && r.why.length > 20
    && typeof r.unblock === 'string' && r.unblock.length > 20));
t('②g 台账无重复 repo', new Set(ledRepos).size === ledRepos.length);

/* ---------- ③ 职责归属：不许悄悄消红 ---------- */
t('③a 主仓仍保留 test:crossend-contract（fail-closed 红项，不删了当消红）',
  scripts['test:crossend-contract'] === 'node cross-end-check.mjs --strict');
t('③b 主仓仍保留手工入口 crossend:check',
  scripts['crossend:check'] === 'node cross-end-check.mjs');
t('③c 联网探针存在且不登记进体检单（网络失败不能冒充契约漂移）',
  existsSync(R('scripts/probe-crossend-ci.mjs'))
  && !Object.values(scripts).some((v) => typeof v === 'string' && v.includes('probe-crossend-ci.mjs')));

/* ---------- 元断言：判据不能是摆设 ---------- */
t('④a 恒真判据会把 12 仓全判成适用（即不等于台账，判据会喊）',
  !setEq(derive(repos, () => true), ledRepos));
t('④b 恒假判据给出空集（不等于台账，判据会喊）',
  !setEq(derive(repos, () => false), ledRepos));
t('④c 少一个 api.ts 时反推集合会变短（防快照被悄悄改）',
  (() => {
    const copy = JSON.parse(JSON.stringify(repos));
    copy['nexusPanel_plugin_projectGroup'].api = [];
    return !setEq(derive(copy, hasBoth), expected);
  })());
t('④d 台账多一条时集合判据会红',
  !setEq(expected, ledRepos.concat(['nexusPanel_plugin_extra']).sort()));
t('④e hasBoth 对缺 types 的仓返回 false（不是恒真）',
  hasBoth({ api: ['x'], types: [] }) === false);
t('④f hasBoth 对两者齐的仓返回 true（不是恒假）',
  hasBoth({ api: ['x'], types: ['y'] }) === true);
t('④g ①a 的模板判据能识别「模板被摘掉 --strict」',
  !(/cross-end-check\.mjs/.test(tpl.replace(/--strict/g, ''))
    && /--strict/.test(tpl.replace(/--strict/g, ''))));
t('④h ③c 的「探针未登记」判据能识别「探针被登记」',
  (() => {
    const bad = { ...scripts, 'test:probe': 'node scripts/probe-crossend-ci.mjs' };
    return Object.values(bad).some((v) => typeof v === 'string' && v.includes('probe-crossend-ci.mjs'));
  })());

console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
