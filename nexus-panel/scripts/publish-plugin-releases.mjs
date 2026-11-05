#!/usr/bin/env node
/**
 * 给 12 个插件私有仓补发首个 Release（产物 tarball）
 * ============================================================
 *
 * 为什么删主仓源码前必须先做这一步
 * ------------------------------------------------------------
 * 主仓的 plugins/<id>/ 一旦删除，插件就只剩两个来源：
 *   ① 12 个私有仓里的**源码镜像**（需要 node/vite 构建，用户机器上没有）
 *   ② 各仓 Release 里的**产物 tarball**（下载即用）
 * 实测 12 仓里只有 demoIframe 发过 1 个 release，其余 11 个 releases=0。
 * 若此时删源码，这 11 个插件既不能从主仓构建、也不能从市场装回来 ——
 * 表现为「插件全没了且查不到原因」。所以补发是删除的硬前置。
 *
 * 打包口径（与 probe-private-install.mjs / templates/plugin-repo/release.yml 同形）
 *   · 纯相对路径、无顶层目录、无 ./ 前缀、无软链
 *   · mtime 固定 0，同内容产物 digest 不漂移
 *   · 包内恰好一份 nexus.plugin.json（编排层靠它认 id，不靠仓库名猜）
 *   · 打完立刻用项目自己的 unpackTarGz 回读，坏包绝不上传
 *
 * 幂等 / 防覆盖
 *   · tag 或 release 已存在就复用，同名 asset 已存在就跳过（禁止 clobber）
 *   · draft=false / prerelease=false —— 否则 /releases/latest 会跳过它
 *
 * 用法： node scripts/publish-plugin-releases.mjs --dry-run
 *        node scripts/publish-plugin-releases.mjs --apply
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { repoNameFor, CAMEL } from './plugin-repo-map.mjs';
import { assetNameFor } from '../js/plugin-store-client.js';
import { unpackTarGz } from '../js/plugin-tarball.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');
const TOKEN_FILE = '/data/user_persistent_data/tools/.git_token';
const OWNER = 'adwlachowicz684-star';
const API = 'https://api.github.com';
const UPLOAD = 'https://uploads.github.com';
const VER = '0.1.0';
const TAG = `v${VER}`;

const IDS = Object.keys(CAMEL).sort();
if (IDS.length !== 12) throw new Error(`插件名单数量异常：${IDS.length}（应为 12）`);

const DRY = process.argv.includes('--dry-run');
const APPLY = process.argv.includes('--apply');
if (DRY === APPLY) { console.error('必须且只能指定 --dry-run 或 --apply 之一'); process.exit(2); }
if (!existsSync(TOKEN_FILE)) { console.error('缺凭据'); process.exit(2); }
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'nexus-publish',
  'X-GitHub-Api-Version': '2022-11-28',
};
async function api(method, path, body, base = API, extra = {}) {
  const isBin = Buffer.isBuffer(body);
  const r = await fetch(base + path, {
    method,
    headers: { ...H, ...(body !== undefined && !isBin ? { 'Content-Type': 'application/json' } : {}), ...extra },
    body: body === undefined ? undefined : (isBin ? body : JSON.stringify(body)),
  });
  const txt = await r.text();
  let j = null;
  try { j = txt ? JSON.parse(txt) : null; } catch { /* 非 JSON */ }
  return { status: r.status, j, text: txt };
}

/* ---------- USTAR ---------- */
function ustarHeader(name, size) {
  const h = Buffer.alloc(512, 0);
  const put = (off, len, s) => h.write(String(s), off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  if (Buffer.byteLength(name) > 100) throw new Error(`USTAR 名字超长(${Buffer.byteLength(name)}): ${name}`);
  put(0, 100, name);
  put(100, 8, oct(0o644, 8));
  put(108, 8, oct(0, 8));
  put(116, 8, oct(0, 8));
  put(124, 12, oct(size, 12));
  put(136, 12, oct(0, 12));           // mtime 固定 0
  h.fill(0x20, 148, 156);
  put(156, 1, '0');
  put(257, 6, 'ustar\0');
  put(263, 2, '00');
  put(265, 32, 'nexus');
  put(297, 32, 'nexus');
  let sum = 0;
  for (const b of h) sum += b;
  put(148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}
function makeTarGz(files) {
  const chunks = [];
  for (const f of files) {
    const body = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf8');
    chunks.push(ustarHeader(f.name, body.length), body);
    const pad = (512 - (body.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}
function collectBundle(id) {
  const base = join(ROOT, 'runtime-plugins', id);
  if (!existsSync(join(base, 'index.html'))) throw new Error(`${id}: 产物缺 index.html`);
  const mf = join(ROOT, 'plugins', id, 'nexus.plugin.json');
  if (!existsSync(mf)) throw new Error(`${id}: 源 manifest 不存在`);
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const f = resolve(d, n);
      if (statSync(f).isDirectory()) walk(f);
      else {
        const rel = relative(base, f).replace(/\\/g, '/');
        if (rel.startsWith('..') || rel.includes('\0')) throw new Error(`非法条目: ${rel}`);
        files.push({ name: rel, content: readFileSync(f) });
      }
    }
  };
  walk(base);
  files.push({ name: 'nexus.plugin.json', content: readFileSync(mf) });
  return files;
}

/* ---------- 主流程 ---------- */
let ok = 0, failed = 0;
for (const id of IDS) {
  const repo = repoNameFor(id);
  const assetName = assetNameFor(id, VER);
  try {
    const tar = makeTarGz(collectBundle(id));
    const back = await unpackTarGz(tar);
    if (!back.ok) throw new Error(`打包回读失败: ${back.error}`);
    const mfCount = back.entries.filter(e => e.name.split('/').pop() === 'nexus.plugin.json').length;
    if (mfCount !== 1) throw new Error(`包内 manifest 数 ${mfCount}（应为 1）`);
    if (!back.entries.some(e => e.name === 'index.html')) throw new Error('包内缺 index.html');
    if (!back.entries.every(e => !e.name.startsWith('/') && !e.name.includes('..'))) throw new Error('包内有越界路径');

    const cur = await api('GET', `/repos/${OWNER}/${repo}/releases/tags/${TAG}`);
    console.log(`${id.padEnd(14)} tarball ${String(tar.length).padStart(8)}B / ${String(back.entries.length).padStart(3)} 条目 | 现有 release ${cur.status === 200 ? '有' : '无'}`);
    if (DRY) continue;

    let release = cur.status === 200 ? cur.j : null;
    if (!release) {
      const ref = await api('GET', `/repos/${OWNER}/${repo}/git/ref/heads/main`);
      if (ref.status !== 200) throw new Error(`取 main HEAD 失败 ${ref.status}`);
      const tagRes = await api('POST', `/repos/${OWNER}/${repo}/git/refs`,
        { ref: `refs/tags/${TAG}`, sha: ref.j.object.sha });
      if (![201, 422].includes(tagRes.status)) throw new Error(`建 tag 失败 ${tagRes.status} ${tagRes.text.slice(0, 120)}`);
      const rel = await api('POST', `/repos/${OWNER}/${repo}/releases`, {
        tag_name: TAG, name: `${id} ${TAG}`,
        body: '插件产物（由 publish-plugin-releases.mjs 发布；源码已迁至本仓）',
        draft: false, prerelease: false,
      });
      if (rel.status !== 201) throw new Error(`建 release 失败 ${rel.status} ${rel.text.slice(0, 120)}`);
      release = rel.j;
    }
    if ((release.assets || []).some(a => a.name === assetName)) {
      console.log(`  ↳ 同名 asset 已存在，跳过（不 clobber）`);
      ok++;
      continue;
    }
    const up = await api('POST',
      `/repos/${OWNER}/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(assetName)}`,
      tar, UPLOAD, { 'Content-Type': 'application/gzip' });
    if (up.status !== 201) throw new Error(`上传 asset 失败 ${up.status} ${String(up.text).slice(0, 160)}`);
    console.log(`  ↳ 已上传 ${assetName} (asset id=${up.j?.id})`);
    ok++;
  } catch (e) {
    console.error(`  ❌ ${id}: ${e.message}`);
    failed++;
  }
}
console.log(`\n完成 ${ok}/${IDS.length}，失败 ${failed}`);
process.exit(failed ? 1 : 0);
