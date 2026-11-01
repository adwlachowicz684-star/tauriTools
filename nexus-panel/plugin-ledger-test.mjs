/**
 * 安装台账测试（阶段 3 · 更新）
 * ============================================================
 * 用**真实临时目录 + 真实文件**（不用 mock fs）
 * ------------------------------------------------------------
 * 本模块最要紧的失效形状是「台账坏了被静默当空台账」——
 * 后果是界面显示「未安装」，用户再装一次就覆盖掉已有的用户数据。
 * mock 文件系统测不出「文件真的被截断」这类事。
 *
 * 三条规矩（沿用本项目既有教训）
 * ------------------------------------------------------------
 * 1. **独占样本**：每条判据都要一个只被它自己拦住的样本，
 *    否则判据互相掩护，坏掉一条测试照样绿。
 * 2. **混入正常样本**：健壮性断言（坏 XXX 不得拖垮整批）里必须夹一个好样本，
 *    否则「扫出 0 个」看起来完全合理，测不出崩溃。
 * 3. **元断言**：断言判据本身对坏样本有反应 —— 判据失效时主断言仍绿的假绿，
 *    只有元断言抓得住。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEDGER_FILE, LEDGER_VERSION,
  isSha, assetFingerprint, sameFingerprint,
  emptyLedger, normalizeEntry, readLedger, writeLedger,
  getEntry, recordInstall, recordUninstall,
  fetchRefSha, checkUpdates, resolveUpdateFor,
} from './js/plugin-ledger.js';
import { scanInstalledPlugins } from './js/installed-plugin-scan.js';
import { MANIFEST_FILE } from './js/plugin-manifest.js';

let pass = 0, fail = 0, skip = 0, note = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const info = (name, extra = '') => { note++; console.log(`ℹ️ ${name}${extra ? ' → ' + extra : ''}`); };

const cleanup = [];
function fresh(tag) { const d = mkdtempSync(join(tmpdir(), `nx-ledger-${tag}-`)); cleanup.push(d); return d; }

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);

/** 假 fetch：按 url 返回预设响应 */
function fakeFetch(map) {
  return async (url) => {
    for (const [frag, res] of Object.entries(map)) {
      if (String(url).includes(frag)) {
        if (res === 'throw') throw new Error('网络中断');
        return { status: res.status, json: async () => res.body };
      }
    }
    return { status: 404, json: async () => ({}) };
  };
}

/** 构造一个 release。id 决定产物名 —— 不能写死 'demo'，
 *  否则按别的 id 去挑产物时必然挑不到，测试就变成在测 helper 自己。 */
const rel = (tag, assets, id = 'demo') => ({
  tag_name: tag,
  target_commitish: 'main',
  assets: assets.map((a, i) => ({
    id: 1000 + i, name: a.name || `nexus-plugin-${id}-${tag}.tar.gz`,
    size: a.size == null ? 1024 : a.size,
    updated_at: a.updated_at || '2026-01-01T00:00:00Z',
    browser_download_url: `https://example.invalid/${tag}.tar.gz`,
  })),
});

/* ============================================================
   1. sha 判定（实测依据：target_commitish 可能是 "main"）
   ============================================================ */
console.log('\n--- 1. sha 判定 ---');
{
  t('40 位小写 hex 是 sha', isSha(SHA) === true);
  t('"main" 不是 sha（实测 vscode/svelte 的 target_commitish）', isSha('main') === false);
  t('39 位不是 sha', isSha('a'.repeat(39)) === false);
  t('41 位不是 sha', isSha('a'.repeat(41)) === false);
  t('大写 hex 不是 sha', isSha('A'.repeat(40)) === false);
  t('非字符串不是 sha', isSha(null) === false && isSha(123) === false);
}

/* ============================================================
   2. 产物指纹
   ============================================================ */
console.log('\n--- 2. 产物指纹 ---');
{
  const a = { id: 1, size: 100, updated_at: 't1' };
  const b = { id: 1, size: 100, updated_at: 't2' };
  t('相同产物指纹相同', assetFingerprint(a) === assetFingerprint({ ...a }));
  t('重传产物（updated_at 变）指纹不同', assetFingerprint(a) !== assetFingerprint(b));
  t('缺 id → null（不猜）', assetFingerprint({ size: 1, updated_at: 't' }) === null);
  t('缺 size → null', assetFingerprint({ id: 1, updated_at: 't' }) === null);
  t('缺 updated_at → null', assetFingerprint({ id: 1, size: 1 }) === null);
  t('非对象 → null', assetFingerprint(null) === null);
  t('sameFingerprint 相同', sameFingerprint('x', 'x') === true);
  t('sameFingerprint 不同', sameFingerprint('x', 'y') === false);
  t('缺指纹返回 null 而非 false（无法判断 ≠ 不同）', sameFingerprint(null, 'x') === null);
}

/* ============================================================
   3. 记录归一化（独占样本）
   ============================================================ */
console.log('\n--- 3. 记录归一化 ---');
{
  const bad = [
    [null, 'null', '不是对象'],
    [{ id: 'Bad-Id' }, '大写 id', 'id 不合法'],
    [{ id: 'ok', sha: 'main' }, 'sha 不是 40 位', '40 位 commit sha'],
    [{ id: 'ok', repo: { owner: '', repo: 'x' } }, 'repo 不合法', 'repo 字段不合法'],
  ];
  for (const [input, label, must] of bad) {
    const r = normalizeEntry(input);
    if (label === 'null' || label === '大写 id') {
      t(`${label} 被拒`, r.ok === false, r.errors.join(';'));
    } else {
      t(`${label} 有告警`, r.ok === true && r.errors.some((e) => e.includes(must)), r.errors.join(';'));
    }
  }
  {
    const r = normalizeEntry({ id: 'demo', repo: { owner: 'o', repo: 'r' }, ref: 'v1', sha: SHA, version: '1.0.0' });
    t('合法记录通过', r.ok === true);
    t('repo 被解析', r.entry.repo && r.entry.repo.owner === 'o' && r.entry.repo.repo === 'r');
    t('sha 被保留', r.entry.sha === SHA);
    t('有 repo → source=market', r.entry.source === 'market');
  }
  {
    const r = normalizeEntry({ id: 'demo' });
    t('无 repo → source=custom', r.entry.source === 'custom');
  }
  {
    /* 独占样本：sha 是 "main" 时**必须丢弃**（否则指纹永不变化 → 更新静默漏报） */
    const r = normalizeEntry({ id: 'demo', sha: 'main' });
    t('sha="main" 被丢弃（不是被存下来）', r.entry.sha === null, String(r.entry.sha));
  }
}

/* ============================================================
   4. 读台账：三种情况必须分开
   ============================================================ */
console.log('\n--- 4. 读台账 ---');
{
  const d = fresh('read');
  const f = join(d, LEDGER_FILE);

  /* 4.1 不存在 = 正常态，不是错误 */
  const r1 = readLedger(join(d, 'no-such-file.json'));
  t('文件不存在：不算错误（还没装过，正常态）', r1.errors.length === 0 && r1.corrupted === false);
  t('文件不存在：返回空台账', Object.keys(r1.ledger.plugins).length === 0);

  /* 4.2 截断的 JSON：必须备份 + 标记 corrupted，不能静默当空 */
  writeFileSync(f, '{"version":1,"plugins":{"demo":');
  const r2 = readLedger(f);
  t('截断的 JSON 被判为损坏', r2.corrupted === true);
  t('损坏时原文件被备份留证', r2.backup && existsSync(r2.backup), String(r2.backup));
  t('损坏时原文件已移走（不会被下次直接覆盖）', !existsSync(f));
  t('损坏时仍返回可用空台账（不让调用方崩）', r2.ledger && typeof r2.ledger.plugins === 'object');

  /* 4.3 结构不对（没有 plugins） */
  const f3 = join(d, 's3.json');
  writeFileSync(f3, '{"version":1}');
  const r3 = readLedger(f3);
  t('缺少 plugins 对象被判为损坏', r3.corrupted === true);

  /* 4.4 坏条目跳过，但**好条目必须还在**（混入正常样本） */
  const f4 = join(d, 's4.json');
  writeFileSync(f4, JSON.stringify({
    version: LEDGER_VERSION,
    plugins: {
      bad: { id: 'BAD ID' },
      demo: { id: 'demo', version: '1.0.0', repo: { owner: 'o', repo: 'r' } },
    },
  }));
  const r4 = readLedger(f4);
  t('坏条目被跳过并记原因', r4.errors.some((e) => e.includes('bad')));
  t('好条目仍然读得到（坏条目不拖垮整批）', getEntry(r4.ledger, 'demo') !== null);
  t('好条目的 repo 完整', getEntry(r4.ledger, 'demo').repo.repo === 'r');

  /* 4.5 往返 */
  const f5 = join(d, 's5.json');
  const w = writeLedger(f5, r4.ledger);
  t('写台账成功', w.ok === true, String(w.error));
  const r5 = readLedger(f5);
  t('写入后可读回（往返一致）', getEntry(r5.ledger, 'demo') !== null && !r5.corrupted);
  /* 残留检查要能**自证不是空跑**：
   * 先手工放一个假残留，确认这个检查真能看见它；
   * 否则「没有残留」可能只是「压根没看对地方」。 */
  writeFileSync(join(d, `${LEDGER_FILE}.tmp-fake`), 'x');
  const seen = readdirSync(d).filter((n) => n.startsWith(`${LEDGER_FILE}.tmp-`));
  t('元：残留检查确实能发现残留（不是空跑）', seen.length === 1, seen.join(','));
  rmSync(join(d, `${LEDGER_FILE}.tmp-fake`), { force: true });
  const left = readdirSync(d).filter((n) => n.startsWith(`${LEDGER_FILE}.tmp-`));
  t('写后不留 .tmp 残留', left.length === 0, left.join(','));
}

/* ============================================================
   5. 写入原子性
   ============================================================ */
console.log('\n--- 5. 写入原子性 ---');
{
  const d = fresh('atomic');
  const f = join(d, LEDGER_FILE);
  writeFileSync(f, JSON.stringify({ version: LEDGER_VERSION, plugins: { demo: { id: 'demo', version: '1.0.0' } } }));
  const r = readLedger(f);
  const w = writeLedger(f, r.ledger);
  t('覆盖写入成功', w.ok === true);
  t('覆盖后内容完整（不是半截）', JSON.parse(readFileSync(f, 'utf8')).plugins.demo.version === '1.0.0');
  t('路径非法时报错而非抛异常', writeLedger(null, {}).ok === false);
}

/* ============================================================
   6. 记账 / 销账
   ============================================================ */
console.log('\n--- 6. 记账与销账 ---');
{
  let L = emptyLedger();
  const r1 = recordInstall(L, {
    id: 'demo', version: '1.0.0', repo: { owner: 'o', repo: 'r' }, ref: 'v1.0.0',
    sha: SHA, asset: { id: 1, size: 100, updated_at: 't1' }, at: 'T1',
  });
  t('首次安装记账成功', r1.entry !== null && r1.ledger.plugins.demo);
  t('installedAt 记下', r1.entry.installedAt === 'T1');
  t('指纹入账', typeof r1.entry.fingerprint === 'string' && r1.entry.fingerprint.length > 0);

  const r2 = recordInstall(r1.ledger, {
    id: 'demo', version: '1.1.0', repo: { owner: 'o', repo: 'r' }, ref: 'v1.1.0',
    sha: SHA2, asset: { id: 2, size: 200, updated_at: 't2' }, at: 'T2',
  });
  t('更新后 installedAt 保留首次（不能被刷掉）', r2.entry.installedAt === 'T1', String(r2.entry.installedAt));
  t('更新后 updatedAt 刷新', r2.entry.updatedAt === 'T2');

  /* 同版本重传产物：必须说出来（依据 3） */
  const r3 = recordInstall(r2.ledger, {
    id: 'demo', version: '1.1.0', repo: { owner: 'o', repo: 'r' }, ref: 'v1.1.0',
    sha: SHA2, asset: { id: 2, size: 999, updated_at: 't3' }, at: 'T3',
  });
  t('同版本但产物变了 → 有告警', r3.warnings.some((w) => w.includes('产物内容已变化')), r3.warnings.join('|'));

  const e = getEntry(r3.ledger, 'demo');
  t('getEntry 取得到', e !== null && e.version === '1.1.0');
  t('getEntry 取不到的返回 null', getEntry(r3.ledger, 'nope') === null);

  const u = recordUninstall(r3.ledger, 'demo');
  t('销账成功', u.removed === true && !u.ledger.plugins.demo);
  t('销账不影响其它条目', (() => {
    const L2 = recordInstall(emptyLedger(), { id: 'a', version: '1.0.0' }).ledger;
    const L3 = recordInstall(L2, { id: 'b', version: '1.0.0' }).ledger;
    const r = recordUninstall(L3, 'a');
    return r.ledger.plugins.b && !r.ledger.plugins.a;
  })());
  t('销账不存在的 id 不报错', recordUninstall(emptyLedger(), 'zzz').removed === false);
}

/* ============================================================
   7. 取真实 sha（实测：不存在 ref 返回 422）
   ============================================================ */
console.log('\n--- 7. 取真实 commit sha ---');
{
  const repo = { owner: 'o', repo: 'r' };
  const ok = await fetchRefSha(repo, 'v1.0.0', {
    fetch: fakeFetch({ '/commits/v1.0.0': { status: 200, body: { sha: SHA } } }),
  });
  t('正常返回 sha', ok.ok === true && ok.sha === SHA);

  const e422 = await fetchRefSha(repo, 'nope', {
    fetch: fakeFetch({ '/commits/nope': { status: 422, body: {} } }),
  });
  t('422 判为 ref 不存在（实测：不是 404）', e422.ok === false && e422.error.includes('ref 不存在'));

  const e404 = await fetchRefSha(repo, 'nope', {
    fetch: fakeFetch({ '/commits/nope': { status: 404, body: {} } }),
  });
  t('404 判为 ref 不存在', e404.ok === false);

  const bad = await fetchRefSha(repo, 'v1', {
    fetch: fakeFetch({ '/commits/v1': { status: 200, body: { sha: 'main' } } }),
  });
  t('返回的不是 40 位 sha → 拒绝（不能拿 "main" 当指纹）', bad.ok === false && bad.error.includes('40 位'));

  const net = await fetchRefSha(repo, 'v1', { fetch: fakeFetch({ '/commits/v1': 'throw' }) });
  t('网络异常不抛，返回失败原因', net.ok === false && net.error.length > 0);

  t('无 ref 直接失败', (await fetchRefSha(repo, null, { fetch: fakeFetch({}) })).ok === false);
  t('无 fetch 时失败而非抛', (await fetchRefSha(repo, 'v1', { fetch: null })).ok === false);
}

/* ============================================================
   8. 更新判定（纯函数）
   ============================================================ */
console.log('\n--- 8. 更新判定 ---');
{
  const entry = { version: '1.0.0', fingerprint: assetFingerprint({ id: 1, size: 100, updated_at: 't1' }) };
  const newer = rel('v1.1.0', [{}]);
  const same = rel('v1.0.0', [{ id: 1, size: 100, updated_at: 't1' }]);
  const reup = rel('v1.0.0', [{ id: 1, size: 999, updated_at: 't9' }]);

  t('新版 → 有更新', resolveUpdateFor(entry, newer, 'demo').hasUpdate === true);
  t('同版同产物 → 无更新', resolveUpdateFor(entry, same, 'demo').hasUpdate === false);
  {
    const r = resolveUpdateFor(entry, reup, 'demo');
    t('同版但产物变了 → 不宣称版本更新', r.hasUpdate === false);
    t('同版但产物变了 → 标 fingerprintChanged 并说明', r.fingerprintChanged === true && r.reason.includes('重新上传'), r.reason);
  }
  t('没有 release → 无更新且说明原因', resolveUpdateFor(entry, null, 'demo').hasUpdate === false);
  {
    /* 「没有本插件产物」必须放在**仓库里托管多个插件**的场景下测：
     * release 里有别的插件的产物，但都不是 demo ——
     * 这时必须返回 null（挑不到就别挑），不能顺手拿一个别的插件的产物。 */
    const multi = rel('v2', [
      { name: 'nexus-plugin-other-2.0.0.tar.gz' },
      { name: 'nexus-plugin-another-1.0.tar.gz' },
    ]);
    const r = resolveUpdateFor(entry, multi, 'demo');
    t('release 里有别的插件产物但没本插件的 → 无更新', r.hasUpdate === false && r.reason.includes('没有可用产物'), r.reason);
  }
  {
    /* 反过来的场景也要钉住（避免上一条被「什么都不挑」掩盖）：
     * release 里**只有**一个命名不规范的产物时，pickAsset 会取它 ——
     * 这是阶段 2 刻意保留的兜底（构建侧命名不规范时不至于装不上）。
     * 它的风险由 installer 的 manifest.id 校验承接，这里不重复拦。 */
    const loose = rel('v2', [{ name: 'weird-bundle.tar.gz' }]);
    const r = resolveUpdateFor(entry, loose, 'demo');
    t('只有一个不规范产物时仍会挑它（兜底，风险由 installer 校验承接）', r.asset !== null);
    info('兜底场景说明', '包内 manifest.id 由 installer 校验，装错会在那时报错');
  }
  {
    const r = resolveUpdateFor({ version: 'not-semver' }, newer, 'demo');
    t('版本无法比较 → 不宣称有更新（宁可漏报）', r.hasUpdate === false && r.reason.includes('无法比较'));
  }
  t('未安装（无 version）→ 视为可安装', resolveUpdateFor({ version: null }, newer, 'demo').hasUpdate === true);
}

/* ============================================================
   9. 批量检查：一个失败不得拖垮其它（混入正常样本）
   ============================================================ */
console.log('\n--- 9. 批量检查更新 ---');
{
  let L = emptyLedger();
  L = recordInstall(L, { id: 'good', version: '1.0.0', repo: { owner: 'o', repo: 'good' }, asset: { id: 1, size: 1, updated_at: 't' } }).ledger;
  L = recordInstall(L, { id: 'broken', version: '1.0.0', repo: { owner: 'o', repo: 'broken' }, asset: { id: 2, size: 1, updated_at: 't' } }).ledger;
  L = recordInstall(L, { id: 'local', version: '1.0.0' }).ledger;

  const res = await checkUpdates(L, {
    fetch: fakeFetch({
      '/repos/o/good/releases/latest': { status: 200, body: rel('v1.1.0', [{}], 'good') },
      '/repos/o/broken/releases/latest': 'throw',
    }),
  });
  const byId = Object.fromEntries(res.results.map((r) => [r.id, r]));
  t('好插件查到有更新', byId.good && byId.good.checked === true && byId.good.hasUpdate === true);
  t('网络失败的插件被记下原因', byId.broken && byId.broken.checked === false && byId.broken.reason.includes('查询失败'));
  t('**一个失败不影响其它** （混入正常样本才测得出来）', byId.good && byId.good.hasUpdate === true);
  t('本地插件被跳过（不拿目录名去猜仓库）', byId.local && byId.local.checked === false && byId.local.reason.includes('非市场来源'));
  t('全部条目都有结果', res.results.length === 3);

  const none = await checkUpdates(emptyLedger(), { fetch: fakeFetch({}) });
  t('空台账不报错', none.results.length === 0);
}

/* ============================================================
   10. 与扫描器共存：台账文件不得被当成插件
   ============================================================ */
console.log('\n--- 10. 台账与扫描器共存 ---');
{
  const d = fresh('coexist');
  /* 放一个正常插件目录 */
  mkdirSync(join(d, 'demo'));
  writeFileSync(join(d, 'demo', MANIFEST_FILE), JSON.stringify({ id: 'demo', name: 'D', version: '1.0.0', entry: 'index.html', kind: 'app' }));
  writeFileSync(join(d, 'demo', 'index.html'), '<html></html>');
  /* 再放台账文件（就在同一层） */
  writeLedger(join(d, LEDGER_FILE), emptyLedger());

  const s = scanInstalledPlugins(d, {});
  t('台账文件不被当成插件目录', s.found === 1, `found=${s.found}`);
  t('正常插件仍被扫到', s.manifests.length === 1 && s.manifests[0].id === 'demo');
}

/* ============================================================
   11. 元断言：判据失效时必须喊
   ============================================================ */
console.log('\n--- 11. 元断言（判据本身要站得住）---');
{
  /* 下面每条都是「坏样本必须被拒绝」。
   * 若某条判据被清空（恒通过），这些断言会立刻红 ——
   * 这是「主断言仍绿」的假绿唯一能被抓住的地方。 */
  t('元：isSha 对 "main" 必须有反应', isSha('main') === false);
  t('元：isSha 对真 sha 必须放行', isSha(SHA) === true);
  t('元：缺字段的指纹必须为 null（不能编一个）', assetFingerprint({ id: 1 }) === null);

  const d = fresh('meta');
  const f = join(d, LEDGER_FILE);
  writeFileSync(f, '{broken');
  const r = readLedger(f);
  t('元：损坏样本确实被判损坏（否则 corrupted 判据空转）', r.corrupted === true);
  t('元：损坏时备份确实生成了', r.backup !== null);

  const fp = assetFingerprint({ id: 1, size: 1, updated_at: 't' });
  t('元：指纹判据确实区分得开重传', fp !== assetFingerprint({ id: 1, size: 1, updated_at: 't2' }));
}

/* ------------------------------------------------------------------ */
for (const d of cleanup) { try { await import('node:fs').then((fs) => fs.rmSync(d, { recursive: true, force: true })); } catch { /* 清理失败不影响结果 */ } }

console.log(`\n通过 ${pass} 项，失败 ${fail} 项${skip ? `，跳过 ${skip} 项` : ''}`);
if (note) console.log(`（另有 ${note} 条提示）`);
process.exit(fail ? 1 : 0);
