/**
 * 插件市场客户端测试
 * ============================================================
 * 全程**不发真实网络请求**
 * ------------------------------------------------------------
 * 用注入的假 fetch：GitHub 挂了/没网都不能让测试变红，
 * 而且真发请求会把「网络失败」和「逻辑错」混在一起，查不出来。
 * 代价是测不到真实 API 形态变化 —— 这点如实记录，靠联调补。
 *
 * 元断言（第 7 节）
 * ------------------------------------------------------------
 * 「挑不到产物」既可能是「确实没有」，也可能是「挑选逻辑坏了」。
 * 必须靠「构造一个必然该挑到的样本，断言它**真的被挑到**」来区分。
 */

import {
  parseRepoInput, compareVersion, assetNameFor, pickAsset,
  fetchRelease, resolveUpdate, downloadAsset, ASSET_PREFIX, ASSET_SUFFIX,
} from './js/plugin-store-client.js';

let pass = 0, fail = 0, skip = 0, note = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const info = (name, extra = '') => { note++; console.log(`ℹ️ ${name}${extra ? ' → ' + extra : ''}`); };

/** 假 fetch：按 url 返回预设响应 */
function fakeFetch(map) {
  return async (url) => {
    const rec = map[url] || map['*'];
    if (!rec) return { status: 404, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
    if (rec.throw) throw new Error(rec.throw);
    return {
      status: rec.status || 200,
      json: async () => rec.body,
      arrayBuffer: async () => {
        const b = Buffer.from(rec.bytes || '');
        return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
      },
    };
  };
}

const ASSET = (id, v) => ({ name: assetNameFor(id, v), browser_download_url: `https://dl/${id}-${v}.tar.gz` });

/* ============================================================
   1. 地址解析
   ============================================================ */
console.log('\n--- 1. 地址解析 ---');
{
  const a = parseRepoInput('owner/repo');
  t('owner/repo', a && a.owner === 'owner' && a.repo === 'repo' && a.ref === null, JSON.stringify(a));
  const b = parseRepoInput('https://github.com/owner/repo.git');
  t('完整 https + .git', b && b.owner === 'owner' && b.repo === 'repo', JSON.stringify(b));
  const c = parseRepoInput('github.com/owner/repo/tree/main');
  t('带 /tree/main 尾巴', c && c.repo === 'repo', JSON.stringify(c));
  const d = parseRepoInput('owner/repo#v1.2.0');
  t('带 #ref', d && d.ref === 'v1.2.0', JSON.stringify(d));
  t('空串 → null', parseRepoInput('') === null);
  t('只有一段 → null', parseRepoInput('owner') === null);
  t('非字符串 → null', parseRepoInput(null) === null);
  t('非法字符 → null', parseRepoInput('own er/repo') === null);
  /* 默认 ref 必须是 null（不追 main）—— 追分支等于让上游静默改用户本地代码 */
  t('默认 ref 是 null（不追 main）', parseRepoInput('owner/repo').ref === null);
}

/* ============================================================
   2. 版本比较
   ============================================================ */
console.log('\n--- 2. 版本比较 ---');
{
  t('1.0.0 < 1.0.1', compareVersion('1.0.0', '1.0.1') === -1);
  t('1.0.0 < 1.1.0', compareVersion('1.0.0', '1.1.0') === -1);
  t('1.0.0 < 2.0.0', compareVersion('1.0.0', '2.0.0') === -1);
  t('相等 → 0', compareVersion('1.2.3', '1.2.3') === 0);
  t('大于 → 1', compareVersion('2.0.0', '1.9.9') === 1);
  t('v 前缀不影响', compareVersion('1.0.0', 'v1.0.1') === -1);
  t('预发布 < 正式版', compareVersion('1.0.0-beta', '1.0.0') === -1);
  t('解析不出 → null（不硬比）', compareVersion('abc', '1.0.0') === null);
  t('缺段 → null', compareVersion('1.0', '1.0.0') === null);
  /* 9.10 > 9.9：字符串比较会得出 9.10 < 9.9，这里必须数字比较 */
  t('9.9.0 < 9.10.0（数字比较，非字符串比较）', compareVersion('9.9.0', '9.10.0') === -1);
}

/* ============================================================
   3. 产物挑选
   ============================================================ */
console.log('\n--- 3. 产物挑选 ---');
{
  t('产物名格式固定', assetNameFor('demo', '1.2.0') === `${ASSET_PREFIX}demo-1.2.0${ASSET_SUFFIX}`, assetNameFor('demo', '1.2.0'));
  t('完全匹配优先', pickAsset([ASSET('demo', '1.2.0')], 'demo', '1.2.0').name === assetNameFor('demo', '1.2.0'));
  t('版本不同步时也认（同 id）', pickAsset([ASSET('demo', '1.1.9')], 'demo', '1.2.0') !== null);
  t('认错 id 的产物不挑', pickAsset([ASSET('other', '1.2.0')], 'demo', '1.2.0') === null);
  t('只有一个 .tar.gz 时兜底取它', pickAsset([{ name: 'whatever.tar.gz', browser_download_url: 'u' }], 'demo', '1.0.0') !== null);
  t('多个无关 .tar.gz 时不兜底（不瞎猜）', pickAsset([{ name: 'a.tar.gz' }, { name: 'b.tar.gz' }], 'demo', '1.0.0') === null);
  t('存在别 id 的规范产物时不兜底（防装错包）', pickAsset([ASSET('other', '1.0.0'), { name: 'x.tar.gz' }], 'demo', '1.0.0') === null);
  t('源码包（.zip / Source code）不认', pickAsset([{ name: 'Source code (zip)' }], 'demo', '1.0.0') === null);
  t('assets 不是数组 → null', pickAsset(null, 'demo', '1.0.0') === null);
}

/* ============================================================
   4. 取 release（注入 fetch）
   ============================================================ */
console.log('\n--- 4. 取 release ---');
{
  const rel = { tag_name: 'v1.2.0', assets: [ASSET('demo', '1.2.0')] };
  const f = fakeFetch({ '*': { status: 200, body: rel } });
  const r = await fetchRelease({ owner: 'o', repo: 'r' }, { fetch: f });
  t('成功取到 release', r.ok === true, String(r.error));
  t('release 内容透传', r.release && r.release.tag_name === 'v1.2.0');

  const r404 = await fetchRelease({ owner: 'o', repo: 'r' }, { fetch: fakeFetch({ '*': { status: 404 } }) });
  t('404 → ok=false 且不抛', r404.ok === false, String(r404.error));
  t('404 的原因为「找不到 release」', String(r404.error).includes('找不到 release'), String(r404.error));

  const r500 = await fetchRelease({ owner: 'o', repo: 'r' }, { fetch: fakeFetch({ '*': { status: 500 } }) });
  t('500 → ok=false 且不抛', r500.ok === false, String(r500.error));

  const rThrow = await fetchRelease({ owner: 'o', repo: 'r' }, { fetch: fakeFetch({ '*': { throw: 'network down' } }) });
  t('网络异常 → ok=false 且不抛（装不上要能告诉用户原因）', rThrow.ok === false, String(rThrow.error));

  const rNo = await fetchRelease({ owner: '', repo: '' }, { fetch: f });
  t('仓库地址不完整 → 直接拒（不发请求）', rNo.ok === false, String(rNo.error));
}

/* ============================================================
   5. 更新判定
   ============================================================ */
console.log('\n--- 5. 更新判定 ---');
{
  const rel = { tag_name: 'v1.2.0', assets: [ASSET('demo', '1.2.0')] };
  const u1 = resolveUpdate('1.0.0', rel, 'demo');
  t('已装 1.0.0、远端 1.2.0 → 有更新', u1.hasUpdate === true, u1.reason);
  t('from/to 正确', u1.from === '1.0.0' && u1.to === '1.2.0', `${u1.from}→${u1.to}`);
  t('带上产物', u1.asset !== null);

  const u2 = resolveUpdate('1.2.0', rel, 'demo');
  t('已是最新 → 无更新', u2.hasUpdate === false, u2.reason);
  const u3 = resolveUpdate('2.0.0', rel, 'demo');
  t('本地更高 → 无更新（不倒退）', u3.hasUpdate === false, u3.reason);

  const u4 = resolveUpdate(null, rel, 'demo');
  t('未安装 → 有更新（即可安装）', u4.hasUpdate === true, u4.reason);

  const u5 = resolveUpdate('1.0.0', { tag_name: 'v1.2.0', assets: [{ name: 'Source code (zip)' }] }, 'demo');
  t('release 里没有产物 → 无更新', u5.hasUpdate === false, u5.reason);

  const u6 = resolveUpdate('1.0.0', { tag_name: 'not-a-version', assets: [ASSET('demo', 'not-a-version')] }, 'demo');
  t('版本解析不出 → 不宣称有更新', u6.hasUpdate === false, u6.reason);
  /* 这条独占：产物是有的，只有「版本号判不了就不报」这条拦得住 */

  t('没有 release 信息 → 无更新', resolveUpdate('1.0.0', null, 'demo').hasUpdate === false);
}

/* ============================================================
   6. 下载
   ============================================================ */
console.log('\n--- 6. 下载 ---');
{
  const a = ASSET('demo', '1.2.0');
  const f = fakeFetch({ 'https://dl/demo-1.2.0.tar.gz': { status: 200, bytes: 'PK\x03\x04hello' } });
  const d = await downloadAsset(a, { fetch: f });
  t('下载成功', d.ok === true, String(d.error));
  t('拿到字节', d.buffer && d.buffer.length === 9, String(d.bytes));
  t('魔数可被嗅探', d.buffer[0] === 0x50 && d.buffer[1] === 0x4b);

  const d404 = await downloadAsset(a, { fetch: fakeFetch({ '*': { status: 404 } }) });
  t('404 → ok=false 不抛', d404.ok === false, String(d404.error));
  const dThrow = await downloadAsset(a, { fetch: fakeFetch({ '*': { throw: 'reset' } }) });
  t('异常 → ok=false 不抛', dThrow.ok === false, String(dThrow.error));
  t('产物没有下载链接 → 拒', (await downloadAsset({ name: 'x' }, { fetch: f })).ok === false);
}

/* ============================================================
   7. 元断言：判据不能空转
   ============================================================ */
console.log('\n--- 7. 元断言 ---');
{
  /* 「能挑到」：证明挑选逻辑没坏 */
  const hit = pickAsset([ASSET('demo', '1.0.0')], 'demo', '1.0.0');
  t('该挑到的样本确实被挑到（判据没空转）', hit !== null && hit.name === assetNameFor('demo', '1.0.0'));
  /* 「能拒绝」：证明挑选逻辑没变成「什么都挑」 */
  t('不该挑到的样本确实挑不到（判据没恒真）', pickAsset([{ name: 'README.md' }], 'demo', '1.0.0') === null);
  /* 版本比较两个方向都成立 */
  t('compareVersion 能判小', compareVersion('1.0.0', '1.0.1') === -1);
  t('compareVersion 能判大', compareVersion('1.0.1', '1.0.0') === 1);
  t('compareVersion 能判等', compareVersion('1.0.0', '1.0.0') === 0);
  /* 地址解析两个方向都成立 */
  t('parseRepoInput 能解析', parseRepoInput('a/b') !== null);
  t('parseRepoInput 能拒绝', parseRepoInput('nope') === null);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项，跳过 ${skip} 项，告知 ${note} 条`);
process.exit(fail ? 1 : 0);
