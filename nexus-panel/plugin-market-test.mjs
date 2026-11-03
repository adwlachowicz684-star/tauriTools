/**
 * 插件市场 · 编排层端到端测试
 * ============================================================================
 *
 * 与前面六个模块的分层区别：
 * ------------------------------------------------------------
 * 那六个测的是**零件**，全部用手工构造的 entries 或注入的假数据。
 * 本文件从**真实 .tar.gz 字节流**开始，走完
 *   下载 → 解包 → 校验 → 落盘 → 记台账 → 发现 → 查更新 → 卸载 → 重装
 * 整条链路。零件全绿但串不起来，是本项目反复栽的那类假象
 * （"每个模块都测过" ≠ "接起来能用"）。
 *
 * 用真实临时目录，不用 mock fs：越界写出、原子替换、数据保留
 * 这些都只有落真盘才验得出来。
 *
 * 三条接线契约各有一对正反断言：
 *   ① 装成功记台账 —— 查更新必须 checked=true；故意不记就查不到
 *   ② 卸载删台账 —— 卸完更新列表里不该再有它
 *   ③ 卸载保留数据 —— 重装同 id 要读得回来；显式删才真删
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';

import { parseTar, unpackTarGz } from './js/plugin-tarball.js';
import { createPluginMarket, inferAssetId } from './js/plugin-market.js';
import { createPluginDataStore } from './js/plugin-data-store.js';
import { DATA_DIR_NAME } from './js/plugin-data-store.js';
import { MANIFEST_FILE } from './js/plugin-manifest.js';
import { ASSET_PREFIX, ASSET_SUFFIX, assetNameFor } from './js/plugin-store-client.js';
import { LEDGER_FILE, readLedger, writeLedger } from './js/plugin-ledger.js';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const cleanup = [];
function fresh(tag) { const d = mkdtempSync(join(tmpdir(), `nx-market-${tag}-`)); cleanup.push(d); return d; }

/**
 * 读台账供断言用。**文件不存在要返回空台账，不能让 readFileSync 抛出去**。
 *
 * 破坏验证时真实撞到：把 install 里的"记台账"注释掉 → 测试不是报红，
 * 而是在第 3 节直接 ENOENT 崩掉、连汇总行都没有。那种输出比"红 3 条
 * 并点名"难查得多，而且看起来像环境坏了。守卫崩了不等于守卫喊了。
 * 解析失败（文件在但不是合法 JSON）仍要抛 —— 那才是真该报的故障。
 */
function readLedgerSafe(file) {
  if (!existsSync(file)) return { plugins: {} };
  return JSON.parse(readFileSync(file, 'utf8'));
}

/* ==========================================================================
   造真 tar 的夹具（校验和必须算对，否则解包器会按"坏包"拒掉）
   ========================================================================== */
function tarHeader(name, size, type = '0') {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 100, 'utf8');
  h.write('0000644\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii');
  h.write('0000000\0', 116, 8, 'ascii');
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii');
  h.fill(32, 148, 156);
  h[156] = type.charCodeAt(0);
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}
function makeTar(entries) {
  const blocks = [];
  for (const e of entries) {
    const body = Buffer.isBuffer(e.content) ? e.content : Buffer.from(String(e.content ?? ''));
    blocks.push(tarHeader(e.name, e.dir ? 0 : body.length, e.dir ? '5' : '0'));
    if (body.length) {
      blocks.push(body);
      const pad = (512 - (body.length % 512)) % 512;
      if (pad) blocks.push(Buffer.alloc(pad));
    }
  }
  blocks.push(Buffer.alloc(1024));   // 两个全零块
  return Buffer.concat(blocks);
}
const makeTarGz = (entries) => gzipSync(makeTar(entries));

function pluginEntries(id, version = '1.0.0', extra = []) {
  return [
    { name: `${id}-${version}/${MANIFEST_FILE}`,
      content: JSON.stringify({ id, name: `插件 ${id}`, version, entry: 'index.html', kind: 'app' }) },
    { name: `${id}-${version}/index.html`, content: `<html>${id} ${version}</html>` },
    ...extra,
  ];
}

/* ==========================================================================
   假 fetch / 假后端 fs —— 只替掉网络与 appData 边界，落盘全走真盘
   ========================================================================== */
function nodeFsAdapter() {
  return {
    async exists(p) { return existsSync(p); },
    async readText(p) { return readFileSync(p, 'utf8'); },
    async writeText(p, s) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); },
    async move(a, b) { mkdirSync(dirname(b), { recursive: true }); renameSync(a, b); },
    async remove(p) { rmSync(p, { recursive: true, force: true }); },
  };
}
function jsonRes(obj) {
  return { status: 200, json: async () => obj };
}
/** 造一个 release：assets 里每个 {name, buffer?} 都指向同一份 tar（默认） */
function makeFetch(cfg) {
  /* 默认带真实 sha256 + state=uploaded —— 与 2026-11-03 真联调看到的
     GitHub asset 形态一致。这样**所有安装用例都会真的走过 digest 校验**，
     而不是只有专门写的一节在验。cfg 可注入四种异常形态。 */
  const assets = cfg.assets.map((a) => {
    const buf = a.buffer || cfg.tar;
    const base = {
      name: a.name, size: buf.length, id: 1,
      browser_download_url: `https://dl.example/${encodeURIComponent(a.name)}`,
      updated_at: '2026-11-01T00:00:00Z',
      state: cfg.assetState || 'uploaded',
    };
    if (cfg.noDigest) return base;
    if (cfg.badDigest) return { ...base, digest: `sha256:${'0'.repeat(64)}` };
    return { ...base, digest: `sha256:${createHash('sha256').update(buf).digest('hex')}` };
  });
  return async (url) => {
    if (/\/releases\/(latest|tags\/)/.test(url)) {
      return jsonRes({ tag_name: cfg.tag || 'v1.0.0', assets });
    }
    if (/\/commits\//.test(url)) {
      return jsonRes({ sha: 'a'.repeat(40) });
    }
    if (url.startsWith('https://dl.example/')) {
      const name = decodeURIComponent(url.slice('https://dl.example/'.length));
      const hit = cfg.assets.find((a) => a.name === name);
      if (!hit || cfg.downloadFails) return { status: 404 };
      const buf = hit.buffer || cfg.tar;
      const ab = new ArrayBuffer(buf.length);
      Buffer.from(ab).set(buf);
      return { status: 200, arrayBuffer: async () => ab };
    }
    return { status: 404 };
  };
}
function makeMarket(cfg) {
  const base = fresh('m');
  const installedDir = join(base, 'installed');
  const ledgerFile = join(base, 'ledger', LEDGER_FILE);
  const dataRoot = join(base, 'appdata');
  mkdirSync(dirname(ledgerFile), { recursive: true });
  const dataStore = createPluginDataStore({
    fs: nodeFsAdapter(), dataRoot, legacyStorage: null,
  });
  const market = createPluginMarket({
    installedDir, ledgerFile, dataRoot, dataStore,
    staticPlugins: cfg.staticPlugins || [],
    fetch: makeFetch(cfg),
    reservedIds: ['settings', 'home'],
  });
  return { market, installedDir, ledgerFile, dataRoot, dataStore, base };
}

/* ==========================================================================
   1. 解包器：真字节流、坏包、以及"坏条目必须原样交出去"
   ========================================================================== */
console.log('\n--- 1. .tar.gz → entries ---');
{
  const buf = makeTarGz(pluginEntries('demo', '1.0.0', [
    { name: 'demo-1.0.0/assets/app.js', content: 'console.log(1)' },
    { name: '../../OUTSIDE.txt', content: 'PWNED' },
    { name: 'demo-1.0.0/assets/', dir: true },
  ]));
  const r = unpackTarGz(buf);
  t('真 tarball 解包成功', r.ok === true, r.error || '');
  t('条目数正确', r.entries.length === 5, String(r.entries.length));
  t('manifest 条目在', r.entries.some((e) => e.name.endsWith(MANIFEST_FILE)));
  t('目录条目标了 dir', r.entries.some((e) => e.dir === true && e.name.endsWith('assets/')));
  t('文件内容逐字节还原',
    r.entries.some((e) => e.name.endsWith('app.js') && e.content.toString() === 'console.log(1)'));
  t('⛔ 越界条目原样保留（由 installer 拦，不在这里静默丢）',
    r.entries.some((e) => e.name === '../../OUTSIDE.txt'));
  t('非 gzip 拒绝', unpackTarGz(Buffer.from('<html>not a tar</html>')).ok === false);
  t('zip 魔数明确拒绝、不降级',
    /zip/.test(unpackTarGz(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0])).error || ''));
  const bad = Buffer.from(makeTar(pluginEntries('demo')));
  bad[0] = bad[0] ^ 0xff;   // 破坏第一个头的校验和
  t('校验和不匹配 → 拒绝解析坏包', parseTar(bad).ok === false);
  t('坏包给出可定位的错误', /校验和/.test(parseTar(bad).error || ''));
  t('空 tar 拒绝', parseTar(Buffer.alloc(1024)).ok === false);
}

/* ==========================================================================
   2. 产物名反推 id（不另写正则，用 assetNameFor 正向核对）
   ========================================================================== */
console.log('\n--- 2. 产物名反推 id ---');
{
  t('普通名', inferAssetId(assetNameFor('demo', '1.2.3')) === 'demo');
  t('id 含连字符', inferAssetId(assetNameFor('my-plugin', '1.2.3')) === 'my-plugin');
  t('id 含数字段', inferAssetId(assetNameFor('plugin-2', '1.2.3')) === 'plugin-2');
  t('带预发布版本', inferAssetId(assetNameFor('demo', '2.0.0-beta.1')) === 'demo');
  t('非规范前缀 → null', inferAssetId('other-demo-1.0.0.tar.gz') === null);
  t('非法 id → null', inferAssetId(`${ASSET_PREFIX}Bad_Id-1.0.0${ASSET_SUFFIX}`) === null);
  t('空版本 → null', inferAssetId(`${ASSET_PREFIX}demo-${ASSET_SUFFIX}`) === null);
}

/* ==========================================================================
   3. 端到端安装 + 三条接线契约
   ========================================================================== */
console.log('\n--- 3. 输入 GitHub 地址 → 装好可用 ---');
{
  const tar = makeTarGz(pluginEntries('demo', '1.0.0'));
  const cfg = { assets: [{ name: assetNameFor('demo', '1.0.0') }], tar };
  const { market, installedDir, ledgerFile } = makeMarket(cfg);

  const r = await market.install('owner/demo-repo');
  t('安装成功', r.ok === true, `${r.stage || ''} ${r.error || ''}`);
  t('id 从包内 manifest 自动识别（没猜仓库名）', r.id === 'demo', String(r.id));
  t('目录按 id 落盘', existsSync(join(installedDir, 'demo', 'index.html')));
  t('manifest 也落盘', existsSync(join(installedDir, 'demo', MANIFEST_FILE)));
  t('commit sha 取到了 40 位', /^[a-f0-9]{40}$/.test(r.sha || ''));

  /* 契约①：装成功必须记台账 */
  const ledgerRaw = readLedgerSafe(ledgerFile);
  t('契约① 台账里确实有这条记录', !!ledgerRaw.plugins.demo, Object.keys(ledgerRaw.plugins).join(','));
  t('契约① 台账记了 repo', ledgerRaw.plugins.demo?.repo?.repo === 'demo-repo');
  t('契约① 台账 source=market（卸载去留靠它，不靠 id 前缀）',
    ledgerRaw.plugins.demo?.source === 'market');

  /* 发现：扫描目录即出现，不需要改任何静态清单 */
  const listed = market.list();
  t('list() 出现刚装的插件', listed.plugins.some((p) => p.id === 'demo' && p.installed === true));
  t('list() 没有把越界/暂存目录当插件', listed.found === 1, `found=${listed.found}`);

  /* 契约① 反证：查更新必须真的查到它（漏记台账 → 结果为空） */
  const up = await market.checkUpdates();
  const one = up.results.find((x) => x.id === 'demo');
  t('契约① 查更新确实查了这个插件（不是空跑）', !!one && one.checked === true,
    JSON.stringify(up.results));
  t('同版本不谎报有更新', one && one.hasUpdate === false, one?.reason);

  /* 防顶替：产物名声明 demo，包里却是 evil */
  const evilTar = makeTarGz(pluginEntries('evil', '1.0.0'));
  const evil = makeMarket({ assets: [{ name: assetNameFor('demo', '1.0.0') }], tar: evilTar });
  const er = await evil.market.install('owner/demo-repo');
  t('⛔ 产物名与包内 manifest.id 不一致 → 拒装', er.ok === false && er.stage === 'identity',
    `${er.stage} ${er.error}`);
  t('拒装后没有落任何目录', !existsSync(join(evil.installedDir, 'evil')));

  /* 一个仓库托管多个插件、又没指定 id → 不许猜 */
  const multi = makeMarket({
    assets: [{ name: assetNameFor('demo', '1.0.0') }, { name: assetNameFor('other', '1.0.0') }], tar,
  });
  const mr = await multi.market.install('owner/mono-repo');
  t('⛔ 多产物不指定 id → 明确拒绝并要求指定', mr.ok === false && mr.stage === 'asset',
    `${mr.stage} ${mr.error}`);
  const mr2 = await multi.market.install('owner/mono-repo', { id: 'demo' });
  t('指定 id 后可以装', mr2.ok === true, `${mr2.stage} ${mr2.error}`);
}

/* ==========================================================================
   4. 失败链路不产生半状态
   ========================================================================== */
console.log('\n--- 4. 失败不留半状态 ---');
{
  const tar = makeTarGz(pluginEntries('demo', '1.0.0'));
  const { market, installedDir, ledgerFile } = makeMarket({
    assets: [{ name: assetNameFor('demo', '1.0.0') }], tar, downloadFails: true,
  });
  const r = await market.install('owner/demo-repo');
  t('下载失败 → 明确报 stage=download', r.ok === false && r.stage === 'download', `${r.stage} ${r.error}`);
  t('下载失败后没有落目录', !existsSync(join(installedDir, 'demo')));
  t('下载失败后台账没被写', !existsSync(ledgerFile));

  const badTar = makeMarket({
    assets: [{ name: assetNameFor('demo', '1.0.0') }],
    tar: Buffer.from('this is not a gzip stream'),
  });
  const br = await badTar.market.install('owner/demo-repo');
  t('坏包 → 明确报 stage=unpack', br.ok === false && br.stage === 'unpack', `${br.stage} ${br.error}`);
  t('坏包后没有落目录', !existsSync(join(badTar.installedDir, 'demo')));
}

/* ==========================================================================
   5. 契约②③：卸载与重装的数据去留
   ========================================================================== */
console.log('\n--- 5. 卸载保留数据 · 重装可恢复 ---');
{
  const tar = makeTarGz(pluginEntries('demo', '1.0.0'));
  const cfg = { assets: [{ name: assetNameFor('demo', '1.0.0') }], tar };
  const ctx = makeMarket(cfg);
  const { market, installedDir, ledgerFile, dataRoot } = ctx;

  await market.install('owner/demo-repo');
  await market.writeData('demo', 'theme', 'dark');
  await market.writeData('demo', 'fontSize', 16);
  const dataDir = join(dataRoot, DATA_DIR_NAME, 'demo');
  t('用户数据按 id 分目录落盘', existsSync(join(dataDir, 'store.json')));

  const u = await market.uninstall('demo');
  t('卸载成功', u.ok === true, u.error || '');
  t('卸载删掉了代码目录', !existsSync(join(installedDir, 'demo')));
  t('契约③ 默认保留用户数据（purgeUserData=false）', u.purgeUserData === false);
  t('契约③ 数据目录仍在', existsSync(join(dataDir, 'store.json')));

  /* 契约②：台账条目必须删掉 */
  const after = readLedgerSafe(ledgerFile);
  t('契约② 台账里不再有 demo', !after.plugins.demo, Object.keys(after.plugins).join(','));
  const up = await market.checkUpdates();
  t('契约② 卸载后更新列表不再查它', !up.results.some((x) => x.id === 'demo'),
    JSON.stringify(up.results));

  /* 重装同 id，数据要读得回来 */
  const re = await market.install('owner/demo-repo');
  t('重装成功（同 id）', re.ok === true, `${re.stage} ${re.error}`);
  t('重装后 theme 仍是 dark', (await market.readData('demo', 'theme')) === 'dark');
  t('重装后 fontSize 仍是 16', (await market.readData('demo', 'fontSize')) === 16);
  t('重装没把旧数据顶掉（仍是同一份文件）', existsSync(join(dataDir, 'store.json')));

  /* 显式要求才删 */
  const u2 = await market.uninstall('demo', { removeUserData: true });
  t('显式 removeUserData → purge=true', u2.ok === true && u2.purgeUserData === true);
  t('显式要求后数据目录真的没了', !existsSync(dataDir));

  /* 反向：不给 removeUserData 时不能"顺手"删 —— 上面已验，这里补一条
     "未知来源也走保留"（判不准宁可多留，不可多删） */
  const unknown = makeMarket(cfg);
  await unknown.market.install('owner/demo-repo');
  await unknown.market.writeData('demo', 'k', 'v');
  const uu = await unknown.market.uninstall('demo');
  t('未知来源不猜 id 前缀，仍走保留', uu.purgeUserData === false);
}

/* ==========================================================================
   6. 元断言：守卫不是恒真也不是恒假
   ========================================================================== */
console.log('\n--- 6. 元断言（防止整节空跑 / 判据恒真） ---');
{
  t('install 能成功（不恒拒）',
    (await makeMarket({ assets: [{ name: assetNameFor('demo', '1.0.0') }], tar: makeTarGz(pluginEntries('demo')) })
      .market.install('o/r')).ok === true);
  t('install 能拒绝（不恒放行）：地址无法解析',
    (await makeMarket({ assets: [], tar: Buffer.alloc(0) }).market.install('not-a-repo')).ok === false);
  t('uninstall 能拒绝未安装的插件',
    (await makeMarket({ assets: [], tar: Buffer.alloc(0) }).market.uninstall('ghost')).ok === false);
  t('checkUpdates 空台账不报插件（不是凭空造结果）',
    (await makeMarket({ assets: [], tar: Buffer.alloc(0) }).market.checkUpdates()).results.length === 0);
}

/* ==========================================================================
   7. 产物完整性：真实 GitHub asset 形态接线（2026-11-03 真联调后补）
   ==========================================================================
   夹具默认带真 sha256 + state=uploaded，所以**前面所有安装用例都真的
   走过校验**。这里专门验四种异常形态，并确认注入真的落到了响应里 ——
   字段名拼错时 cfg 会被静默忽略，测试照样全绿，那是最难查的一种假绿。
   ========================================================================== */
console.log('\n--- 7. digest 完整性校验接线 ---');
{
  const tar = makeTarGz(pluginEntries('demo', '1.0.0'));
  const name = assetNameFor('demo', '1.0.0');
  const relUrl = 'https://api.github.com/repos/owner/demo-repo/releases/latest';

  /* 元断言：先证明三种注入确实落到假 GitHub 响应里 */
  const badResp = await (makeFetch({ assets: [{ name }], tar, badDigest: true }))(relUrl);
  const badAssets = (await badResp.json()).assets;
  t('元断言：badDigest 真的写进了响应（不是拼错字段名）',
    /^sha256:0{64}$/.test(badAssets[0].digest || ''), String(badAssets[0].digest).slice(0, 20));
  const noResp = await (makeFetch({ assets: [{ name }], tar, noDigest: true }))(relUrl);
  t('元断言：noDigest 响应里确实没有 digest 字段',
    !('digest' in (await noResp.json()).assets[0]));
  const stResp = await (makeFetch({ assets: [{ name }], tar, assetState: 'starter' }))(relUrl);
  t('元断言：assetState 真的写进了响应',
    (await stResp.json()).assets[0].state === 'starter');

  const okCtx = makeMarket({ assets: [{ name }], tar });
  const r = await okCtx.market.install('owner/demo-repo');
  t('默认（带真实 digest）安装成功', r.ok === true, `${r.stage} ${r.error}`);
  t('digestChecked=true（这次真的验了，不是空跑）', r.digestChecked === true);

  const bad = makeMarket({ assets: [{ name }], tar, badDigest: true });
  const br = await bad.market.install('owner/demo-repo');
  t('digest 不匹配 → 拒装且 stage=digest', br.ok === false && br.stage === 'digest',
    `${br.stage} ${br.error}`);
  t('digest 拒装后没有落目录（无半状态）', !existsSync(join(bad.installedDir, 'demo')));
  t('digest 拒装后台账没写', !readLedgerSafe(bad.ledgerFile).plugins.demo);

  const old = makeMarket({ assets: [{ name }], tar, noDigest: true });
  const or = await old.market.install('owner/demo-repo');
  t('老 release 无 digest → 仍能装上（不把兼容当故障）', or.ok === true, `${or.stage} ${or.error}`);
  t('无 digest 时 digestChecked=false（不冒充已校验）', or.digestChecked === false);
  t('无 digest 在 warnings 里如实告知',
    (or.warnings || []).some((w) => /没有 digest/.test(w)), JSON.stringify(or.warnings || []));

  const up = makeMarket({ assets: [{ name }], tar, assetState: 'starter' });
  const ur = await up.market.install('owner/demo-repo');
  t('上传中的产物不被挑中 → 明确拒绝', ur.ok === false && ur.stage === 'asset',
    `${ur.stage} ${ur.error}`);
  t('上传中拒装后没有落目录', !existsSync(join(up.installedDir, 'demo')));
}

/* ==========================================================================
   7. 台账坏了不许写回（安装/卸载两条路径）· 写失败不许抛异常
   --------------------------------------------------------------------------
   与项目里修过的「清单文件坏 → 被当成空 → 加一条就整份覆盖」完全同形，
   只是载体换成插件台账：readLedger 解析失败时会把原文件改名备份并返回
   **空台账** + corrupted:true。编排层只取 .ledger 就等于拿"空"当
   "磁盘上没有记录"，recordInstall 合并后写回 → 其余插件的更新记录全没，
   而且不报错。写台账失败则原先是 throw，调用方按 `if (!r.ok)` 写会撞上
   穿透的异常，界面上只剩"点了没反应"。
   ========================================================================== */
console.log('\n--- 7. 台账损坏 / 写入失败 ---');
{
  const tar = makeTarGz(pluginEntries('demo', '1.0.0'));
  const cfg = { assets: [{ name: assetNameFor('demo', '1.0.0') }], tar };

  /* A. 损坏：先装出一份含其它插件的台账，再把它写成截断 JSON */
  const ctx = makeMarket(cfg);
  const { market, ledgerFile, installedDir } = ctx;
  const ok0 = await market.install('owner/demo-repo');
  t('前置：正常安装成功（本节不是空跑）', ok0.ok === true, `${ok0.stage || ''} ${ok0.error || ''}`);
  const before = readLedgerSafe(ledgerFile);
  const withOther = { ...before, plugins: { ...before.plugins,
    other: { id: 'other', source: 'market', version: '1.0.0', repo: { owner: 'o', repo: 'r' } } } };
  const broken = JSON.stringify(withOther).slice(0, -15);
  writeFileSync(ledgerFile, broken);

  /* 钉住缺陷本身，不钉实现：底层确实把坏文件当空台账、并改名备份 */
  const st = readLedger(ledgerFile);
  t('底层 readLedger 报 corrupted 且返回空台账（缺陷存在的证据）',
    st.corrupted === true && Object.keys(st.ledger.plugins).length === 0,
    `corrupted=${st.corrupted} plugins=${Object.keys(st.ledger.plugins).length}`);
  t('底层把原文件改名备份，没有直接删', !!st.backup && existsSync(st.backup));
  t('备份里还在其它插件的记录', /"other"/.test(st.backup ? readFileSync(st.backup, 'utf8') : ''));

  /* 上面那次只读检查也会移走坏文件；重新写坏一份，验编排层的写前预检 */
  writeFileSync(ledgerFile, broken);
  const ri = await market.install('owner/demo-repo');
  t('⛔ 台账损坏时安装被明确拒绝（stage=ledger，不是抛异常）',
    ri && ri.ok === false && ri.stage === 'ledger', JSON.stringify(ri));
  t('拒绝理由点名备份 / 人工核对（用户找得回数据）',
    /备份|人工核对/.test(ri?.error || ''), ri?.error);
  t('⛔ 损坏的台账没有被写回成「只剩这一条」', !existsSync(ledgerFile),
    existsSync(ledgerFile) ? '被写回了' : '未写回');
  const backups = readdirSync(dirname(ledgerFile)).filter((x) => x.includes('.corrupt-'));
  t('原文件仍在备份里（其它插件记录没丢）',
    backups.length > 0
      && backups.some((b) => /"other"/.test(readFileSync(join(dirname(ledgerFile), b), 'utf8'))),
    backups.join(','));

  /* install 的预检已把坏文件移进备份；要验卸载/查更新，得各自重新写坏一份 */
  writeFileSync(ledgerFile, broken);
  const ru = await market.uninstall('demo');
  t('⛔ 台账损坏时卸载同样被拒绝，插件没被删',
    ru && ru.ok === false && ru.stage === 'ledger'
      && existsSync(join(installedDir, 'demo', 'index.html')), JSON.stringify(ru));

  writeFileSync(ledgerFile, broken);
  const up = await market.checkUpdates();
  t('checkUpdates 只读不崩，且把台账异常如实带出来（不吞）',
    Array.isArray(up.results) && up.errors.length > 0, JSON.stringify(up.errors).slice(0, 160));

  /* B. 写入失败：删掉台账目录，让原子写的临时文件落不下去 */
  const ctx2 = makeMarket(cfg);
  const ok2 = await ctx2.market.install('owner/demo-repo');
  t('前置：B 场景首次安装成功', ok2.ok === true, `${ok2.stage || ''} ${ok2.error || ''}`);
  rmSync(dirname(ctx2.ledgerFile), { recursive: true, force: true });
  t('底层 writeLedger 确实会失败（本节不是空跑）',
    writeLedger(ctx2.ledgerFile, { plugins: {} }).ok === false);
  let ri2 = null, thrown2 = null;
  try { ri2 = await ctx2.market.install('owner/demo-repo'); }
  catch (e) { thrown2 = String((e && e.message) || e); }
  t('⛔ 台账写入失败不抛异常（按契约返回结构化失败）',
    !thrown2 && ri2 && ri2.ok === false && ri2.stage === 'ledger',
    thrown2 || JSON.stringify(ri2));
  t('写失败理由点名台账写入失败与人工核对',
    /台账写入失败/.test(ri2?.error || '') && /人工核对|旧版本/.test(ri2?.error || ''), ri2?.error);

  const ctx3 = makeMarket(cfg);
  await ctx3.market.install('owner/demo-repo');
  rmSync(dirname(ctx3.ledgerFile), { recursive: true, force: true });
  let ru3 = null, thrown3 = null;
  try { ru3 = await ctx3.market.uninstall('demo'); }
  catch (e) { thrown3 = String((e && e.message) || e); }
  t('⛔ 卸载时台账写入失败也不抛异常',
    !thrown3 && ru3 && ru3.ok === false && ru3.stage === 'ledger',
    thrown3 || JSON.stringify(ru3));
}

for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录 */ } }
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
