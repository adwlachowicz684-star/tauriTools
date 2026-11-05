#!/usr/bin/env node
/**
 * 真实私有仓联调：发版 → 安装 → 发现 → 查更新 → 卸载 → 重装恢复
 * ============================================================================
 *
 * 为什么需要这个探针（不进 CI）：
 *   前面所有测试都注入假 fetch，真实探针跑的是**公开仓**。
 *   而 12 个插件仓库全部 private —— 不带凭据 GET 私有仓 releases 实测 403，
 *   链路里却连「传凭据」的入口都没有。离线守卫能钉住 headers 透传，
 *   但钉不住「GitHub 的 302 / digest / state 在私有仓上到底是什么形态」。
 *   这一层只能真跑一次。
 *
 * 依赖网络与 token，故**不登记 npm script**：网络失败不能冒充逻辑错。
 *
 * 真跑撞出的两条（已固化成断言，别再踩）：
 *   1. `/releases/latest` **跳过 prerelease 与 draft**。误设成 true 时宿主
 *      只报「找不到 release: latest」，用户会以为插件没发版。
 *   2. 本沙盒出口策略对 release 资产域名一律 403「No policy rule matched
 *      the request」，用公开仓 ErgeMD v0.5.0 对照同样 403 —— 与私有/凭据无关。
 *      故探针只把「下载字节流」这一跳做成本地替身，并显式标注，不假装全真。
 *
 * 用法：
 *   node scripts/probe-private-install.mjs                  # 发版 + 全链路
 *   node scripts/probe-private-install.mjs --no-publish    # 复用已有 release，只跑安装
 *   node scripts/probe-private-install.mjs --cleanup       # 删除本次 release 与 tag（谨慎）
 *
 * 凭据只从持久目录读，不写进代码、不打印、不进任何仓库文件。
 */

import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { createPluginMarket } from '../js/plugin-market.js';
import { createPluginDataStore } from '../js/plugin-data-store.js';
import { LEDGER_FILE, readLedger } from '../js/plugin-ledger.js';
import { unpackTarGz } from '../js/plugin-tarball.js';
import { assetNameFor } from '../js/plugin-store-client.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TOKEN_FILE = '/data/user_persistent_data/tools/.git_token';
const OWNER = 'adwlachowicz684-star';
const ID = 'demo-iframe';
const REPO = 'nexusPanel_plugin_demoIframe';
const VER = '0.1.0';
const TAG = `v${VER}`;
const ASSET_NAME = assetNameFor(ID, VER);
const API = 'https://api.github.com';
const UPLOAD = 'https://uploads.github.com';
const NO_PUBLISH = process.argv.includes('--no-publish');
const CLEANUP = process.argv.includes('--cleanup');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const info = (s) => console.log(`ℹ️ ${s}`);

/* ────────────────────────────────────────────────────────────────
 * 1. 最小 USTAR 打包（只发产物，不发源码）
 *    与 templates/plugin-repo/release.yml 的 python tarfile 同形：
 *    纯相对路径、无顶层目录、无 ./ 前缀、无软链。
 *    打完立刻用项目自己的解包器回读，坏包绝不上上传。
 * ──────────────────────────────────────────────────────────────── */
function ustarHeader(name, size) {
  const h = Buffer.alloc(512, 0);
  const put = (off, len, s) => h.write(String(s), off, len, 'utf8');
  const oct = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  if (Buffer.byteLength(name) > 100) throw new Error(`USTAR 名字超长: ${name}`);
  put(0, 100, name);
  put(100, 8, oct(0o644, 8));
  put(108, 8, oct(0, 8));
  put(116, 8, oct(0, 8));
  put(124, 12, oct(size, 12));
  /* mtime 固定 0：真跑时发现每次打包字节数都不一样（头里带了时间戳），
     同内容产物 digest 漂移会让 ledger 误判「同版本产物被重新上传」。
     CI 模板的 tarfile.add 同样带 mtime，见 release.yml 的对应修正。 */
  put(136, 12, oct(0, 12));
  h.fill(0x20, 148, 156);                 // chksum 先填空格
  put(156, 1, '0');                       // typeflag: 普通文件
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
  chunks.push(Buffer.alloc(1024, 0));     // 两个全零结束块
  return gzipSync(Buffer.concat(chunks));
}
function collectBundle() {
  const base = join(ROOT, 'runtime-plugins', ID);
  const files = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else {
        const rel = relative(base, p).replace(/\\/g, '/');
        if (rel.startsWith('..') || rel.includes('\0')) throw new Error(`非法条目: ${rel}`);
        files.push({ name: rel, content: readFileSync(p) });
      }
    }
  };
  walk(base);
  /* 包内必须有且只有一份 manifest —— 编排层靠它认 id，不靠仓库名猜 */
  files.push({ name: 'nexus.plugin.json', content: readFileSync(join(ROOT, 'plugins', ID, 'nexus.plugin.json')) });
  return files;
}

/* ────────────────────────────────────────────────────────────────
 * 2. GitHub API（带凭据）
 * ──────────────────────────────────────────────────────────────── */
if (!existsSync(TOKEN_FILE)) { console.error('缺凭据文件'); process.exit(2); }
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
const H = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'nexus-panel-probe',
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
  try { j = txt ? JSON.parse(txt) : null; } catch { /* 非 JSON 响应 */ }
  return { status: r.status, json: j, text: txt };
}
/** 供 market 注入的 fetch：所有请求一律带凭据 */
const authedFetch = (url, opts = {}) => fetch(url, {
  ...opts,
  headers: { ...(opts.headers || {}), Authorization: `Bearer ${TOKEN}` },
});

/* ────────────────────────────────────────────────────────────────
 * 3. 发版（幂等、不 clobber）
 * ──────────────────────────────────────────────────────────────── */
const tar = makeTarGz(collectBundle());
const back = await unpackTarGz(tar);
t('打包回读：产物能被项目自己的解包器读回', back.ok === true, back.error || '');
t('打包回读：包内有且只有一份 manifest',
  back.ok && back.entries.filter((e) => e.name.split('/').pop() === 'nexus.plugin.json').length === 1);
t('打包回读：条目全是纯相对路径',
  back.ok && back.entries.every((e) => !e.name.startsWith('/') && !e.name.includes('..')));
info(`tarball ${ASSET_NAME}，${tar.length} 字节，${back.entries.length} 条目`);

/* ⚠️ 沙盒出口策略：release 资产域名（release-assets.githubusercontent.com
   与 github.com/.../releases/download/）一律 403
   「No policy rule matched the request」。已用**公开仓** ErgeMD v0.5.0 的
   asset 做对照，同样 403 —— 与私有、与凭据无关，是环境限制。
   所以只把「下载字节流」这一跳替换成同一份本地产物，并同步把 release
   响应里该 asset 的 digest/size 换成本地字节的真值（否则 digest 校验必红）。
   release 元数据、凭据透传、解包、落盘、台账、查更新、卸载全部走真链路。
   替身状态会在输出与汇总里显式标出，不混进「真实通过」。 */
const localDigest = `sha256:${createHash('sha256').update(tar).digest('hex')}`;
const localAb = (() => { const ab = new ArrayBuffer(tar.length); Buffer.from(ab).set(tar); return ab; })();
let SUBSTITUTE = false;
const hybridFetch = async (url, opts = {}) => {
  const isAsset = /\/releases\/assets\/\d+$/.test(url)
    || /\/releases\/download\//.test(url)
    || /release-assets\.githubusercontent\.com/.test(url);
  if (isAsset) {
    if (SUBSTITUTE) return { status: 200, arrayBuffer: async () => localAb };
    const real = await authedFetch(url, opts);
    if (real.status === 200) return real;      // 用户本机：走真下载
    const body = Buffer.from(await real.arrayBuffer()).toString('utf8');
    if (!/No policy rule matched the request/.test(body)) return real;
    SUBSTITUTE = true;
    info('资产域名被沙盒出口策略阻断 → 仅此一跳改用同一份本地字节流（替身）');
    return { status: 200, arrayBuffer: async () => localAb };
  }
  const real = await authedFetch(url, opts);
  if (SUBSTITUTE && real.status === 200 && /\/releases\/(latest|tags\/)/.test(url)) {
    const j = await real.json();
    if (j && Array.isArray(j.assets)) {
      j.assets = j.assets.map((a) => (a.name === ASSET_NAME
        ? { ...a, digest: localDigest, size: tar.length } : a));
    }
    return { status: 200, json: async () => j };
  }
  return real;
};

let release = null;
if (NO_PUBLISH) {
  const r = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  t('--no-publish：复用已有 release', r.status === 200, `status=${r.status}`);
  release = r.json;
} else {
  let cur = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  if (cur.status === 200) {
    release = cur.json;
    info(`release 已存在，复用（id=${release.id}）`);
  } else {
    const ref = await api('GET', `/repos/${OWNER}/${REPO}/git/ref/heads/main`);
    t('取到 main HEAD', ref.status === 200 && !!ref.json?.object?.sha, `status=${ref.status}`);
    if (!ref.json?.object?.sha) { console.log(`\n通过 ${pass} 项，失败 ${fail} 项`); process.exit(1); }
    const sha = ref.json.object.sha;
    const tag = await api('POST', `/repos/${OWNER}/${REPO}/git/refs`,
      { ref: `refs/tags/${TAG}`, sha });
    t('创建轻量 tag 成功（或已存在）', tag.status === 201 || tag.status === 422, `status=${tag.status}`);
    const rel = await api('POST', `/repos/${OWNER}/${REPO}/releases`, {
      tag_name: TAG, name: `${ID} ${TAG}`,
      body: '私有仓端到端联调产物（由 probe-private-install.mjs 发布）',
      /* ⚠️ /releases/latest 会**跳过 prerelease 与 draft**。误设成 true 时
         宿主拿到 404，只报「找不到 release: latest」，用户会以为没发版 ——
         真实联调第一次就踩了这个，故此处固定 false 并在下面回读断言。 */
      draft: false, prerelease: false,
    });
    t('创建 release 成功', rel.status === 201 || rel.status === 422, `status=${rel.status}`);
    release = rel.json;
    if (!release?.id) { console.log(`\n通过 ${pass} 项，失败 ${fail} 项`); process.exit(1); }
  }
  const existing = (release.assets || []).find((a) => a.name === ASSET_NAME);
  if (existing) {
    info('同名 asset 已存在，不重传（禁止 clobber）');
  } else {
    const up = await api('POST',
      `/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(ASSET_NAME)}`,
      tar, UPLOAD, { 'Content-Type': 'application/gzip' });
    t('上传产物成功', up.status === 201, `status=${up.status} ${String(up.text).slice(0, 120)}`);
    if (up.json) release.assets = [...(release.assets || []), up.json];
  }
}

/* 回读真实 asset 形态：state / digest 是链路的两条硬判据 */
const rr = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
t('回读 release 成功', rr.status === 200, `status=${rr.status}`);
release = rr.json || release;
if (release?.prerelease || release?.draft) {
  const patched = await api('PATCH', `/repos/${OWNER}/${REPO}/releases/${release.id}`,
    { prerelease: false, draft: false });
  t('把误设的 prerelease/draft 修正为正式 release', patched.status === 200, `status=${patched.status}`);
  if (patched.status === 200) release = patched.json;
}
t('release 对 /releases/latest 可见（非 prerelease / 非 draft）',
  release?.prerelease === false && release?.draft === false,
  `prerelease=${release?.prerelease} draft=${release?.draft}`);
const asset = (release.assets || []).find((a) => a.name === ASSET_NAME);
t('产物在 release 里', !!asset, asset ? asset.name : 'not found');
if (asset) {
  info(`真实 asset: state=${asset.state} digest=${String(asset.digest).slice(0, 24)}… size=${asset.size}`);
  t('真实 asset state=uploaded', asset.state === 'uploaded', String(asset.state));
  t('真实 asset 带 sha256 digest', /^sha256:[0-9a-f]{64}$/i.test(String(asset.digest || '')), String(asset.digest).slice(0, 30));

  /* 真发一次资产域名请求，把「环境阻断」与「链路缺陷」分开。
     公开仓对照同样是 403（见文件头），故这不是私有仓或凭据的问题。 */
  const probeUrl = asset.url || asset.browser_download_url;
  const dlRes = await authedFetch(probeUrl,
    { headers: { Accept: 'application/octet-stream' } });
  const dlBuf = Buffer.from(await dlRes.arrayBuffer());
  const denied = dlRes.status === 403 && /No policy rule matched the request/.test(dlBuf.toString('utf8'));
  info(`资产域名真实请求 → status=${dlRes.status} bytes=${dlBuf.length}`
    + (denied ? '（出口策略阻断，已启用单跳替身）' : '（未阻断，走真下载）'));
  if (denied) SUBSTITUTE = true;   // 后续 release 响应同步替换 digest/size
  t('替身字节流本身合法（解包器读得回、digest 是 64hex）',
    (await unpackTarGz(tar)).ok === true && /^sha256:[0-9a-f]{64}$/.test(localDigest));

  /* PATCH 修掉 prerelease 后 /releases/latest 可能短暂仍返回 404（传播延迟）。
     探针重试而不是假装成功；产品侧不需要这层，用户点安装时早已生效。 */
  let latestOk = false, lastStatus = 0;
  for (let i = 0; i < 4 && !latestOk; i++) {
    const q = await api('GET', `/repos/${OWNER}/${REPO}/releases/latest`);
    lastStatus = q.status;
    latestOk = q.status === 200;
    if (!latestOk) await new Promise((r) => setTimeout(r, 1500));
  }
  t('latest 端点对正式 release 可见', latestOk, `status=${lastStatus}`);
} else {
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}

/* ────────────────────────────────────────────────────────────────
 * 4. 全链路（真网络、真落盘、真用户数据）
 * ──────────────────────────────────────────────────────────────── */
const base = mkdtempSync(join(tmpdir(), 'nx-private-install-'));
const installedDir = join(base, 'installed');
const ledgerFile = join(base, 'ledger', LEDGER_FILE);
const dataRoot = join(base, 'appdata');
mkdirSync(dirname(ledgerFile), { recursive: true });
const dataStore = createPluginDataStore({
  fs: {
    async exists(p) { return existsSync(p); },
    async readText(p) { return readFileSync(p, 'utf8'); },
    async writeText(p, s) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); },
    async move(a, b) { mkdirSync(dirname(b), { recursive: true }); renameSync(a, b); },
    async remove(p) { rmSync(p, { recursive: true, force: true }); },
  },
  dataRoot, legacyStorage: null,
});
function mkMarket(fetchFn, headers) {
  return createPluginMarket({
    installedDir, ledgerFile, dataRoot, dataStore,
    fetch: fetchFn, headers,
    reservedIds: ['settings', 'home'],
  });
}
const market = mkMarket(hybridFetch, { Authorization: `Bearer ${TOKEN}` });

const ins = await market.install(`${OWNER}/${REPO}`);
t('真实私有仓安装成功', ins.ok === true, `${ins.stage || ''} ${ins.error || ''}`);
if (!ins.ok) { console.log(`\n通过 ${pass} 项，失败 ${fail} 项`); rmSync(base, { recursive: true, force: true }); process.exit(1); }
t('装进来的 id 来自包内 manifest', ins.id === ID, ins.id);
t('digest 确实被校验（不是 checked=false 的假绿）', ins.digestChecked === true);
t('取到 40 位 commit sha（更新指纹没退化）', /^[0-9a-f]{40}$/i.test(String(ins.sha || '')), String(ins.sha).slice(0, 12));
t('入口文件真的落盘', existsSync(join(installedDir, ID, 'index.html')));
t('资源目录随包带上', existsSync(join(installedDir, ID, 'assets')));
t('台账记下了 repo（契约①）',
  !!readLedger(ledgerFile).ledger.plugins?.[ID]?.repo);
const listed = market.list();
t('扫描发现能看到它',
  Array.isArray(listed?.plugins) && listed.plugins.some((p) => p.id === ID),
  JSON.stringify(Object.keys(listed || {})).slice(0, 120));

const upd = await market.checkUpdates();
const u = (upd.results || []).find((x) => x.id === ID);
t('查更新 checked=true（不是台账空导致的漏报）', !!u && u.checked === true, JSON.stringify(u || {}).slice(0, 160));
t('刚装完判「已是最新」', !!u && u.hasUpdate === false, u?.reason || '');
t('查更新没有把私有仓 403 当成失败', !(upd.errors || []).length, (upd.errors || []).join('; ').slice(0, 160));

await market.writeData(ID, 'theme', 'dark');
const before = await market.readData(ID, 'theme');
t('用户数据写入并读回', before === 'dark', String(before));
const un = await market.uninstall(ID);
t('卸载成功', un.ok === true, un.error || '');
t('卸载默认不删用户数据', un.purgeUserData === false);
t('插件代码目录已删除', !existsSync(join(installedDir, ID)));
t('用户数据仍在（D3）', (await market.readData(ID, 'theme')) === 'dark');
t('台账条目已移除（契约②）', !readLedger(ledgerFile).ledger.plugins?.[ID]);

const re = await market.install(`${OWNER}/${REPO}`);
t('重装成功（独立更新不依赖主程序重构建）', re.ok === true, `${re.stage || ''} ${re.error || ''}`);
t('重装同 id 数据可恢复', (await market.readData(ID, 'theme')) === 'dark');

/* ────────────────────────────────────────────────────────────────
 * 5. 对照组：不带凭据必须明确指向授权，而不是「没发版」
 * ──────────────────────────────────────────────────────────────── */
const base2 = mkdtempSync(join(tmpdir(), 'nx-private-noauth-'));
const market2 = createPluginMarket({
  installedDir: join(base2, 'installed'),
  ledgerFile: join(base2, 'ledger', LEDGER_FILE),
  dataRoot: join(base2, 'appdata'), dataStore: null,
  fetch: (url, opts = {}) => fetch(url, opts), headers: null,
  reservedIds: [],
});
mkdirSync(dirname(join(base2, 'ledger', LEDGER_FILE)), { recursive: true });
const denied = await market2.install(`${OWNER}/${REPO}`);
t('不带凭据安装失败', denied.ok === false, `${denied.stage || ''} ${denied.error || ''}`);
t('失败原因明确指向私有仓/授权（不是裸 403、不是限额、不是没发版）',
  /私有/.test(String(denied.error || '')) && /授权/.test(String(denied.error || ''))
  && !/找不到 release/.test(String(denied.error || ''))
  && !/限额/.test(String(denied.error || '')),
  String(denied.error || '').slice(0, 140));

rmSync(base, { recursive: true, force: true });
rmSync(base2, { recursive: true, force: true });

if (CLEANUP) {
  const rel = await api('GET', `/repos/${OWNER}/${REPO}/releases/tags/${TAG}`);
  if (rel.status === 200 && rel.json?.id) {
    const d = await api('DELETE', `/repos/${OWNER}/${REPO}/releases/${rel.json.id}`);
    t('清理 release', d.status === 204, `status=${d.status}`);
  }
  const g = await api('DELETE', `/repos/${OWNER}/${REPO}/git/refs/tags/${TAG}`);
  t('清理 tag', g.status === 204 || g.status === 404, `status=${g.status}`);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`
  + (SUBSTITUTE ? '；⚠️ 其中「下载字节流」一跳为沙盒出口策略下的本地替身，不算真实下载验证' : '；全部为真实网络'));
process.exit(fail ? 1 : 0);
