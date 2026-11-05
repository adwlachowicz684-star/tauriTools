#!/usr/bin/env node
/**
 * 真实 GitHub API 联调探针（手动跑，不进 CI）
 * ============================================================================
 *
 * 为什么单独有这么一个文件
 * ------------------------------------------------------------
 * 市场逻辑层的单元测试**全部注入假 fetch**：GitHub 挂了不能让测试变红，
 * 但也因此测不到「真实 API 的字段形态」。2026-11-03 第一次真跑就发现：
 *
 *   · asset 带 `digest: sha256:<64hex>` 和 `state: uploaded` —— 此前链路
 *     一个都没用（现已接入 verifyAssetDigest / isUploadedAsset）
 *   · `target_commitish` 一半是 40 位 sha、一半是字符串 "main"
 *     （tauri-apps/tauri 前者，sveltejs/svelte、microsoft/vscode 后者）
 *   · `/commits/{不存在的ref}` 返回 422 而不是 404
 *
 * 真实响应的**字段形态**已固化进 plugin-store-client-test.mjs 第 8 节，
 * 以后 API 改形态不用联网也能喊出来。本探针负责的是另一半：
 * 真网络、真 redirect、真 tarball 字节流 —— 那些离线测不到的东西。
 *
 * ⛔ 不登记进 package.json 的 test:* script：它依赖网络与 GitHub 活着，
 *    混进 CI 会把「网络失败」和「逻辑错」混在一起。文件名也刻意不叫
 *    *-test.mjs，避免被 test-registry 守卫当成未登记的孤儿。
 *
 * 用法
 * ------------------------------------------------------------
 *   node scripts/probe-github-real.mjs            # 全跑（含 ~67MB tarball）
 *   node scripts/probe-github-real.mjs --quick    # 跳过 tarball 下载
 *
 * token 从 GITHUB_TOKEN 环境变量或 /data/user_persistent_data/tools/.git_token 读。
 * 全程**只读**，不创建 release、不改任何仓库。
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const QUICK = process.argv.includes('--quick');

const TOKEN = process.env.GITHUB_TOKEN
  || (existsSync('/data/user_persistent_data/tools/.git_token')
    ? readFileSync('/data/user_persistent_data/tools/.git_token', 'utf8').trim()
    : '');

const { fetchRelease, resolveUpdate, downloadAsset, verifyAssetDigest, isUploadedAsset } =
  await import(join(ROOT, 'js/plugin-store-client.js'));
const { fetchRefSha } = await import(join(ROOT, 'js/plugin-ledger.js'));
const { unpackTarGz } = await import(join(ROOT, 'js/plugin-tarball.js'));

const realFetch = async (url, init = {}) => {
  const h = new Headers(init.headers || {});
  if (String(url).startsWith('https://api.github.com/')) {
    if (TOKEN) h.set('Authorization', `Bearer ${TOKEN}`);
    h.set('Accept', 'application/vnd.github+json');
    h.set('User-Agent', 'nexus-panel-probe');
  }
  return fetch(url, { ...init, headers: h, redirect: 'follow' });
};

let bad = 0;
const check = (label, cond, extra = '') => {
  if (!cond) bad++;
  console.log(`${cond ? '✅' : '❌'} ${label}${extra ? ' → ' + extra : ''}`);
};

console.log('===== A. 真实 release 字段形态 =====');
const REPOS = [['tauri-apps', 'tauri'], ['sveltejs', 'svelte'], ['microsoft', 'vscode']];
const rels = {};
for (const [owner, repo] of REPOS) {
  const r = await fetchRelease({ owner, repo }, { fetch: realFetch });
  if (!r.ok) { console.log(`ℹ️ ${owner}/${repo}: ${r.error}`); continue; }
  const rel = r.release;
  rels[`${owner}/${repo}`] = rel;
  const a0 = (rel.assets || [])[0];
  console.log(`${owner}/${repo}  tag=${rel.tag_name}  target_commitish=${String(rel.target_commitish).slice(0, 12)}  assets=${(rel.assets || []).length}`);
  if (a0) {
    console.log(`   asset[0]: name=${a0.name} state=${a0.state} digest=${String(a0.digest).slice(0, 20)}… size=${a0.size}`);
    check(`   ${owner}/${repo} asset 是已上传完成`, isUploadedAsset(a0) === true);
    check(`   ${owner}/${repo} digest 是 sha256:64hex`, /^sha256:[0-9a-f]{64}$/i.test(a0.digest || ''));
  }
  /* 两种形态都要能见到：全是 sha 或全是分支名都说明我们的采样偏了 */
  const u = resolveUpdate('0.0.1', rel, 'probe-nonexistent-plugin');
  console.log(`   resolveUpdate → hasUpdate=${u.hasUpdate} reason=${u.reason}`);
}

console.log('\n===== B. target_commitish 两种形态都被覆盖 =====');
const forms = Object.values(rels).map((r) => String(r.target_commitish || ''));
check('至少一个 40 位 sha 形态', forms.some((s) => /^[0-9a-f]{40}$/i.test(s)));
check('至少一个分支名形态（不是 sha）', forms.some((s) => s && !/^[0-9a-f]{40}$/i.test(s)),
  forms.join(' | ').slice(0, 100));

console.log('\n===== C. fetchRefSha 真实行为 =====');
for (const [k, rel] of Object.entries(rels)) {
  const [owner, repo] = k.split('/');
  const tag = String(rel.tag_name || '');
  const ok = await fetchRefSha({ owner, repo }, tag, { fetch: realFetch });
  const missing = await fetchRefSha({ owner, repo }, 'no-such-tag-xyz-probe', { fetch: realFetch });
  console.log(`${k} @ ${tag}: ok=${ok.ok} sha=${String(ok.sha).slice(0, 12)} 不存在ref=${missing.ok}`);
  check(`${k}: 存在的 tag 取得到 sha`, ok.ok === true);
  check(`${k}: 不存在的 ref 明确失败（422 也当失败）`, missing.ok === false);
}

if (QUICK) {
  console.log('\n--quick：跳过 tarball 下载与解包');
} else {
  console.log('\n===== D. 真实 tarball 字节流（含长路径 / PAX）=====');
  const url = 'https://api.github.com/repos/adwlachowicz684-star/skill-tree/tarball/main';
  const dl = await downloadAsset({ browser_download_url: url }, { fetch: realFetch });
  check('下载成功且是 gzip', dl.ok === true && dl.buffer.subarray(0, 2).toString('hex') === '1f8b',
    `bytes=${dl.bytes} err=${dl.error || ''}`);
  if (dl.ok) {
    const out = await unpackTarGz(dl.buffer);
    const longs = out.entries.filter((e) => e.name.length > 100);
    console.log(`   entries=${out.entries.length} >100字符=${longs.length} maxLen=${Math.max(0, ...out.entries.map((e) => e.name.length))} skipped=${out.skipped.length} warnings=${out.warnings.length}`);
    check('真实 tarball 解包成功', out.ok === true, out.error || '');
    check('没有条目被静默跳过', out.skipped.length === 0);
    check('确实遇到并还原了 >100 字符的长路径（USTAR 名字字段只有 100 字节）',
      longs.length > 0);
    check('长名条目内容非空（不是只还原了名字、丢了数据）',
      longs.some((e) => !e.dir && e.content && e.content.length > 0));

    /* digest 校验对真实字节流：拿不到服务端 digest 时至少验证"自洽" */
    const { createHash } = await import('node:crypto');
    const selfDigest = `sha256:${createHash('sha256').update(dl.buffer).digest('hex')}`;
    const v = await verifyAssetDigest(dl.buffer, { digest: selfDigest });
    check('verifyAssetDigest 对真实字节流自洽', v.ok === true && v.checked === true);
    const vBad = await verifyAssetDigest(dl.buffer, { digest: `sha256:${'0'.repeat(64)}` });
    check('verifyAssetDigest 对坏 digest 会拒', vBad.ok === false);
  }
}

console.log(`\n真实联调：${bad ? `❌ ${bad} 项不符合预期` : '✅ 全部符合预期'}`);
process.exit(bad ? 1 : 0);
