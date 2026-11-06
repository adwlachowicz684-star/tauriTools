#!/usr/bin/env node
/**
 * 装配层运行时真跑守卫（第 50 轮）
 * ============================================================================
 *
 * 为什么不能只靠 market-binding-guard-test.mjs 的静态判据
 * ------------------------------------------------------------
 * 静态守卫能证明「生产入口写了实例化」「装配层没有 node:」「headerBox
 * 传的是引用」，但证明不了「实例化真的成功」「三个能力真的能调」「运行时
 * 输入的 PAT 真的进了请求头」。本项目反复栽的就是「看起来接上了」。
 *
 * 本测试在**没有 Tauri 运行时**的 Node 里，用注入口构造一个等效环境，
 * 真跑 createWebviewMarket → list / writeData / readData / install，
 * 并检查凭据既不落盘也不出现在任何文件里。
 *
 * 注入口只用于测试：装配层默认路径是 createFs(invoke) + 全局 fetch，
 * 由 market-binding-guard-test.mjs ⑥k/⑥l 钉住，防止测试口子把生产路径顶掉。
 *
 * 环境前提：js/ 下的编排层闭包第 48 轮已全部去 node: 化，所以这里能
 * 直接用 Node ESM import，不需要 vm 隔离 realm（webview-runtime-test.mjs
 * 另用 vm 证明「没有 Buffer/process/require 也能加载」）。
 */

import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWebviewMarket } from './js/market-binding.js';
import { createNodeFs } from './scripts/node-fs-adapter.mjs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const base = mkdtempSync(join(tmpdir(), 'nx-market-binding-'));
const sentHeaders = [];
/** 假 fetch：只记录请求头，返回 404（私有仓无权访问时 GitHub 的真实形态）。 */
const fakeFetch = async (url, opts = {}) => {
  sentHeaders.push({ url, headers: { ...(opts.headers || {}) } });
  return {
    status: 404,
    headers: { get: () => null },
    json: async () => ({}),
    text: async () => '',
  };
};
/** Tauri stub：装配层只在未注入 fs 时才走 invoke，这里仍然给一个可计数的桩，
 *  用来断言「生产默认路径没被误触发」。 */
let invokeCalls = 0;
const tauri = { invoke: async (cmd, args) => { invokeCalls++; return { ok: true, text: '' }; } };

try {
  /* ── 1. 真实例化 ── */
  const r = await createWebviewMarket({
    tauri,
    resolveDataDir: async () => base,
    fs: createNodeFs(),
    fetchFn: fakeFetch,
    reservedIds: ['settings', 'home', 'store'],
  });
  t('①a 装配成功 ok=true', r.ok === true, JSON.stringify(r.message || ''));
  t('①b 返回 market 实例', !!(r.market && typeof r.market === 'object'));
  t('①c 暴露 setToken', typeof r.setToken === 'function');
  t('①d 注入 fs 时未误触 Tauri invoke', invokeCalls === 0, String(invokeCalls));

  const market = r.market;
  for (const m of ['list', 'install', 'uninstall', 'checkUpdates', 'readData', 'writeData']) {
    t(`①e market.${m} 可调用`, typeof market[m] === 'function');
  }

  /* ── 2. 能力真跑 ── */
  const listed = await market.list();
  t('②a 列表返回结构（不是 Promise 也不是异常）',
    !!listed && Array.isArray(listed.plugins), JSON.stringify(Object.keys(listed || {})));

  await market.writeData('demo-iframe', 'theme', 'dark');
  t('②b writeData → readData 往返', (await market.readData('demo-iframe', 'theme')) === 'dark');
  t('②c 用户数据按 id 分目录落盘', existsSync(join(base, 'plugin-data', 'demo-iframe', 'store.json')));

  const upd = await market.checkUpdates();
  t('②d 查更新返回结构', !!upd && Array.isArray(upd.results) && Array.isArray(upd.errors));

  /* ── 3. PAT 运行时注入真的进了请求头（headerBox 引用契约） ── */
  const PAT = 'unit_test_pat_' + 'x'.repeat(24);
  sentHeaders.length = 0;
  const before = await market.install('someowner/somerepo');
  t('③a 无凭据时 install 明确失败（不抛异常）', before.ok === false, before.stage || '');
  t('③b 无凭据时请求头没有 Authorization',
    sentHeaders.length > 0 && !Object.keys(sentHeaders[0].headers)
      .some((k) => k.toLowerCase() === 'authorization'),
    JSON.stringify(sentHeaders[0]?.headers || {}));

  r.setToken(PAT);
  sentHeaders.length = 0;
  await market.install('someowner/somerepo');
  const authed = sentHeaders[0]?.headers || {};
  t('③c 输入 PAT 后请求头带上 Authorization（引用共享生效）',
    authed.Authorization === `Bearer ${PAT}`, JSON.stringify(authed));

  r.setToken(null);
  sentHeaders.length = 0;
  await market.install('someowner/somerepo');
  t('③d 撤销 PAT 后 Authorization 消失',
    !Object.keys(sentHeaders[0]?.headers || {})
      .some((k) => k.toLowerCase() === 'authorization'),
    JSON.stringify(sentHeaders[0]?.headers || {}));

  /* ── 4. 凭据不落盘：扫描整个临时目录 ── */
  let leak = null;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      let isDir = false;
      try { isDir = statSync(p).isDirectory(); } catch { /* ignore */ }
      if (isDir) { walk(p); continue; }
      try { if (readFileSync(p, 'utf8').includes(PAT)) leak = p; } catch { /* binary */ }
    }
  };
  walk(base);
  t('④a PAT 没写进 appDataDir 任何文件', leak === null, leak || '');
  t('④b 装配层没把凭据拼进 URL',
    sentHeaders.every((x) => !x.url.includes(PAT)));

  /* ── 5. 降级路径：没有 Tauri / 没有 appDataDir 时结构化失败 ── */
  const noTauri = await createWebviewMarket({ tauri: null, resolveDataDir: async () => base });
  t('⑤a 无 Tauri 返回 not-in-tauri（不抛异常）',
    noTauri.ok === false && noTauri.reason === 'not-in-tauri', noTauri.reason || '');
  const noDir = await createWebviewMarket({
    tauri, resolveDataDir: async () => null, fs: createNodeFs(), fetchFn: fakeFetch,
  });
  t('⑤b 无 appDataDir 返回 no-data-dir（不抛异常）',
    noDir.ok === false && noDir.reason === 'no-data-dir', noDir.reason || '');

  /* ── 6. 元断言：判据不是恒真 ── */
  t('⑥a fakeFetch 确实被调用过（③b/③c 不是空集合恒真）', sentHeaders.length >= 1);
  t('⑥b 404 响应确实被编排层当失败处理', before.ok === false);
} catch (e) {
  t('整体执行未抛异常', false, `${e?.name || 'Error'}: ${e?.message || e}`);
} finally {
  rmSync(base, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
