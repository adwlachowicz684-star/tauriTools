#!/usr/bin/env node
/**
 * manifest.repo ↔ 独立仓库名 一致性守卫（离线）
 * ============================================================
 * 守什么
 * ------------------------------------------------------------
 * 12 个插件各有一个私有 GitHub 仓库，仓库名由
 * scripts/plugin-repo-map.mjs 的 CAMEL 表唯一决定；主仓 12 份
 * plugins/<id>/nexus.plugin.json 的 repo 字段由生成器从同一张表派生。
 *
 * 这个字段写错的后果**不报错、不崩溃**：
 *   宿主按 repo 去查 release → 404 → 表现为「这个插件没有可安装版本」，
 *   用户只会以为插件还没发版，没人会想到是地址写错了。
 *
 * ⚠️ 为什么期望值必须用独立算法算，不能 import repoNameFor
 * ------------------------------------------------------------
 * 拿 repoNameFor() 的输出去验 manifest.repo，等于拿生成器的输出验
 * 生成器自己 —— CAMEL 表写错时两边一起错，测试照样全绿
 * （本项目反复栽的「自己验自己」）。
 * 所以本守卫用**标准 camelCase 算法**从 registry 的 id 反推期望值：
 * 算法是规则、CAMEL 是数据，两者独立；表写错会被算法抓到。
 *
 * 覆盖边界
 * ------------------------------------------------------------
 * 离线守卫只能验「本地两边一致」。远端 12 仓是否真的存在、是否私有、
 * 仓库里的 manifest.repo 是否与主仓一致，由联网探针
 * scripts/verify-plugin-repos.mjs 覆盖（不进 CI，网络故障单独判）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS = join(HERE, 'plugins');

let pass = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else fails.push(name + (extra ? ` — ${extra}` : ''));
}

const registry = await import('./plugins/registry.js');
const map = await import('./scripts/plugin-repo-map.mjs');
const { skeletonFiles } = await import('./scripts/build-plugin-repos.mjs');

const iframe = registry.plugins.filter((p) => p.type === 'iframe');

/* 独立期望：不查 CAMEL 表 */
const OWNER_EXPECT = 'adwlachowicz684-star';
const PREFIX_EXPECT = 'nexusPanel_plugin_';
/** 标准 camelCase：首段原样，后续段首字母大写 */
function camelOf(id) {
  return id.split('-').map((s, i) => (i ? s.charAt(0).toUpperCase() + s.slice(1) : s)).join('');
}
function expectName(id) { return PREFIX_EXPECT + camelOf(id); }
function expectRepo(id) { return `${OWNER_EXPECT}/${expectName(id)}`; }

/** 第 3 节唯一判据。刻意只判一件事，避免「禁掉一条另一条还在挡」的假绿。 */
function repoIssue(got, id) {
  if (typeof got !== 'string' || !got.trim()) return 'repo 缺失或非字符串';
  const want = expectRepo(id);
  if (got !== want) return `repo=${got} 期望=${want}`;
  return null;
}

function manifestRepo(id) {
  const f = join(PLUGINS, id, 'nexus.plugin.json');
  if (!existsSync(f)) return null;
  try { return JSON.parse(readFileSync(f, 'utf8')).repo; } catch { return null; }
}

/* ------------------------------------------------------------------ *
 * 1. 前提：常量与集合没跑偏
 * ------------------------------------------------------------------ */
t('前提：iframe 插件数为 12', iframe.length === 12, `实为 ${iframe.length}`);
t('前提：CAMEL 表恰为 12 条', Object.keys(map.CAMEL).length === 12,
  `实为 ${Object.keys(map.CAMEL).length}`);
t('前提：映射源 OWNER 与独立期望一致', map.OWNER === OWNER_EXPECT,
  `映射源=${map.OWNER} 期望=${OWNER_EXPECT}`);
t('前提：映射源 REPO_PREFIX 与独立期望一致', map.REPO_PREFIX === PREFIX_EXPECT,
  `映射源=${map.REPO_PREFIX}`);

/* ------------------------------------------------------------------ *
 * 2. 表 vs 独立算法：表写错必须喊
 * ------------------------------------------------------------------ */
const tableKeys = Object.keys(map.CAMEL).sort();
const iframeKeys = iframe.map((p) => p.id).sort();
t('映射表 key 恰为 12 个 iframe 插件 id',
  JSON.stringify(tableKeys) === JSON.stringify(iframeKeys),
  `表=${tableKeys.join(',')} registry=${iframeKeys.join(',')}`);
for (const id of iframeKeys) {
  t(`${id}: CAMEL 值等于标准 camelCase`, map.CAMEL[id] === camelOf(id),
    `表=${map.CAMEL[id]} 算法=${camelOf(id)}`);
}
{
  const names = iframeKeys.map(expectName);
  t('12 个仓库名互不重复', new Set(names).size === 12, `唯一数 ${new Set(names).size}`);
}

/* ------------------------------------------------------------------ *
 * 3. 主仓 12 份 manifest.repo（本守卫核心）
 * ------------------------------------------------------------------ */
for (const p of iframe) {
  const got = manifestRepo(p.id);
  const issue = repoIssue(got, p.id);
  t(`${p.id}: manifest.repo 指向本仓`, issue === null, issue || '');
}

/* ------------------------------------------------------------------ *
 * 4. 生成器 / 骨架：不得出现第二个会说谎的 repo 源
 * ------------------------------------------------------------------ */
/* 抽样 3 个（大仓 516 文件 / 小仓 79 文件 / 含连字符 id）；全量由
 * verify-plugin-repos.mjs 逐文件比对远端 tree 覆盖，CI 不必重复读 1872 文件。 */
for (const id of ['agent-flow', 'dupview', 'demo-iframe']) {
  /* skeletonFiles 对主仓 repo 写错是 fail-closed 抛错。守卫若跟着崩，
   * 输出就是「无汇总行 + 退出码 1」—— 比「红几条并点名」难查得多，
   * 看着还像环境坏了。转成一条点名断言（守卫崩了不等于守卫喊了）。 */
  let f;
  try {
    f = skeletonFiles(id);
  } catch (e) {
    t(`骨架 ${id}: 能生成（主仓 repo 必须已派生正确）`, false,
      String(e.message || e).slice(0, 180));
    continue;
  }
  const skel = JSON.parse(f['nexus.plugin.json'].toString('utf8'));
  t(`骨架 ${id}: manifest.repo 与主仓一致`, skel.repo === manifestRepo(id),
    `骨架=${skel.repo} 主仓=${manifestRepo(id)}`);
  t(`骨架 ${id}: repo 来自主仓而非另拼`, skel.repo === expectRepo(id),
    skel.repo);
  t(`骨架 ${id}: ref 仍由版本派生`, skel.ref === `v${skel.version}`, String(skel.ref));
}

/* ------------------------------------------------------------------ *
 * 5. 红线：仓库名 ≠ 产物名
 * ------------------------------------------------------------------ */
/* 产物前缀是宿主 pickAsset 的判据（js/plugin-store-client.js 的
 * ASSET_PREFIX）。跟着仓库名一起改 → 「装了却找不到产物」且不报原因。 */
{
  const storeSrc = readFileSync(join(HERE, 'js', 'plugin-store-client.js'), 'utf8');
  const m = storeSrc.match(/ASSET_PREFIX\s*=\s*['"]([^'"]+)['"]/);
  t('能读到 ASSET_PREFIX 常量', !!m, '没读到 → 本节判据空跑');
  const assetPrefix = m ? m[1] : '';
  t('产物前缀与仓库前缀不同（红线）', !!assetPrefix && assetPrefix !== map.REPO_PREFIX,
    `产物=${assetPrefix} 仓库=${map.REPO_PREFIX}`);
  t('manifest.repo 里没有产物前缀',
    iframe.every((p) => !String(manifestRepo(p.id)).includes(assetPrefix)),
    '有人把仓库名改成了产物名');
}

/* ------------------------------------------------------------------ *
 * 6. 元断言：判据真的在跑，且不是恒真 / 恒假
 * ------------------------------------------------------------------ */
{
  const good = expectRepo('agent-flow');
  t('元断言A：正确样本放行（判据不恒假）', repoIssue(good, 'agent-flow') === null);
  t('元断言B：改坏 owner 被点名', repoIssue('someone-else/' + expectName('agent-flow'), 'agent-flow') !== null);
  t('元断言C：改坏驼峰名被点名', repoIssue(`${OWNER_EXPECT}/${PREFIX_EXPECT}agentflow`, 'agent-flow') !== null);
  t('元断言D：repo 缺失被点名', repoIssue(undefined, 'agent-flow') !== null);
  t('元断言E：产物前缀拼进仓库名被点名',
    repoIssue(`${OWNER_EXPECT}/nexus-plugin-agentFlow`, 'agent-flow') !== null);
  t('元断言F：camelCase 算法自身有区分力',
    camelOf('agent-flow') === 'agentFlow' && camelOf('md-editor') === 'mdEditor'
    && camelOf('dupview') === 'dupview' && camelOf('a-b-c') === 'aBC',
    `实为 ${camelOf('agent-flow')}/${camelOf('md-editor')}/${camelOf('a-b-c')}`);

  /* G：把第 3 节的判据换成恒真，并注入一条坏数据 —— 必须仍能看出差别。
   * 若没人真的调 repoIssue，本节与第 3 节会一起假绿。 */
  const pairs = iframe.map((p) => [p.id, manifestRepo(p.id)]);
  const realIssues = pairs.filter(([id, got]) => repoIssue(got, id) !== null).length;
  const injected = [['agent-flow', 'wrong/repo'], ...pairs.slice(1)];
  const realOnInjected = injected.filter(([id, got]) => repoIssue(got, id) !== null).length;
  const alwaysNull = () => null;
  const fakeOnInjected = injected.filter(([id, got]) => alwaysNull(got, id) !== null).length;
  /* 不要求「真数据必须全对」：真数据本身有错时第 3 节已经在红，
   * 这里再跟着红就是噪声，且会把点名引向错误方向。只验「真判据
   * 比恒真判据多报」这一件事。 */
  t('元断言G：真判据确实被第 3 节调用（注入坏数据会多报）',
    realOnInjected > fakeOnInjected,
    `真数据红=${realIssues} 注入后红=${realOnInjected} 恒真判据红=${fakeOnInjected}`);
}

/* ------------------------------------------------------------------ *
 * 汇总（标准格式，供 sweep-tests.mjs 识别）
 * ------------------------------------------------------------------ */
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
for (const f of fails) console.error('  ❌ ' + f);
process.exit(fails.length ? 1 : 0);
