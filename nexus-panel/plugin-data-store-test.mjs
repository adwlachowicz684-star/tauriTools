/**
 * 插件用户数据存储守卫（阶段 4.1）
 * ============================================================================
 *
 * 这份测试的重点不是「能存能取」，而是五条**失效了也不报错**的判据：
 *
 *   ① 按 id 分目录 —— 串了数据的表现是"插件 A 的设置跑到 B 里"，不崩
 *   ② 原子写入   —— 写一半被中断后旧数据也毁了，表现为"设置全丢"，不可逆
 *   ③ 损坏抛错   —— 半个 JSON 被 catch 成 {}，同样表现为"设置全丢"，不报错
 *   ④ 迁移不覆盖 —— 旧快照盖掉升级后改过的设置，用户只看到"值自己变回去了"
 *   ⑤ 卸载保留   —— 市场插件数据被清，表现为"重装后设置没回来"，D3 静默失守
 *
 * 所以每一节都配了**独占样本**：坏样本只坏在一处，避免"禁掉一条判据，
 * 另一条恰好还在挡 → 测试照样绿"（本项目反复栽的形状）。
 * 破坏验证先断言注入真的生效，再下结论。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createPluginDataStore, DATA_DIR_NAME, STORE_FILE, STORE_VERSION,
} from './js/plugin-data-store.js';
import {
  shouldPurgeDataOnUninstall, SOURCE_MARKET, SOURCE_CUSTOM,
} from './js/plugin-data-policy.js';
import { storePrefix, storeKey } from './js/plugin-store.js';
import { isValidPluginId } from './js/plugin-manifest.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), 'utf8');

let pass = 0;
const fails = [];
const t = (name, ok, detail) => {
  if (ok) pass++;
  else fails.push(`${name}${detail ? ` —— ${detail}` : ''}`);
};
const throws = async (fn, hint) => {
  try { await fn(); return false; } catch (e) { return !hint || String(e.message).includes(hint); }
};

/* ------------------------------------------------------------------ *
 * 内存 fs：模拟后端 fs_op 的语义（目录 exists、move 覆盖、remove 递归）
 * ------------------------------------------------------------------ */
function memoryFs() {
  const files = new Map();
  let fault = null; // 一次性写故障：{ pathIncludes, truncateAt }
  const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return {
    files,
    setFault(f) { fault = f; },
    clearFault() { fault = null; },
    async readText(p) {
      const k = norm(p);
      if (!files.has(k)) throw new Error(`文件不存在: ${k}`);
      return files.get(k);
    },
    async writeText(p, content) {
      const k = norm(p);
      if (fault && (fault.pathIncludes == null || k.includes(fault.pathIncludes))) {
        const f = fault; fault = null;                 // 一次性
        files.set(k, String(content).slice(0, f.truncateAt ?? 3)); // 留下半截
        throw new Error('注入：写到一半被杀');
      }
      files.set(k, String(content));
    },
    async exists(p) {
      const k = norm(p);
      if (files.has(k)) return true;
      for (const f of files.keys()) if (f.startsWith(k + '/')) return true; // 目录语义
      return false;
    },
    async move(s, d) {
      const a = norm(s), b = norm(d);
      if (!files.has(a)) throw new Error(`源不存在: ${a}`);
      files.set(b, files.get(a));                    // 后端 rename 覆盖已存在目标
      files.delete(a);
    },
    async remove(p) {
      const k = norm(p);
      let n = 0;
      for (const f of [...files.keys()]) {
        if (f === k || f.startsWith(k + '/')) { files.delete(f); n++; }
      }
      return n;
    },
  };
}

function memStorage(entries) {
  const m = new Map(Object.entries(entries));
  return {
    get length() { return m.size; },
    key(i) { return [...m.keys()][i] ?? null; },
    getItem(k) { return m.has(k) ? m.get(k) : null; },
    _map: m,
  };
}

const ROOT = '/APPDATA';
const store = (extra = {}) => createPluginDataStore({ fs: extra.fs || memoryFs(), dataRoot: ROOT, ...extra });

/* ================================================================== *
 * 1. 工厂与 id（第三套规则的诱惑就在这里）
 * ================================================================== */
t('① 缺 fs.writeText → 直接抛错（不静默降级）',
  await throws(() => createPluginDataStore({ fs: { readText() {} }, dataRoot: ROOT }), 'fs 缺少'));
t('① 缺 dataRoot → 抛错（不预设未实测的目录）',
  await throws(() => createPluginDataStore({ fs: memoryFs() }), 'dataRoot'));

for (const bad of ['../etc', 'a/b', 'Foo', '', 'a' + 'x'.repeat(80), 'a..b', null, 42]) {
  t(`① 非法 id ${JSON.stringify(bad)} 被拒`, !isValidPluginId(bad));
}
t('① 合法 id project-group 通过', isValidPluginId('project-group'));
t('① 元断言：id 判据非恒真', isValidPluginId('ok') === true && isValidPluginId('../etc') === false);
t('① 非法 id 在 set 时抛错（目录名绝不拼出去）',
  await throws(() => store().set('../etc', 'k', 1), '非法插件 id'));

const s1 = store();
t('① 目录按 id 分开（隔离前提）', s1.dataDir('aaa') !== s1.dataDir('bbb'));
t('① 数据文件名固定 store.json', s1.dataFile('aaa').endsWith(`/aaa/${STORE_FILE}`));
t('① 数据落在 appDataDir/plugin-data/ 下',
  s1.dataDir('aaa').includes(`${DATA_DIR_NAME}/aaa`));
t('① 元断言：path 里不含裸 .. 段', !s1.dataDir('aaa').split('/').includes('..'));

/* 源码钉住：id 规则复用 manifest 的同一份，不许另写正则 */
const dsSrc = src('js/plugin-data-store.js');
t('① 源码：import isValidPluginId（不另写正则）', /import \{ isValidPluginId \} from '\.\/plugin-manifest\.js'/.test(dsSrc));
const manifestSrc = src('js/plugin-manifest.js');
t('① 源码：isValidPluginId 复用 ID_RE / ID_MAX，不是第三套规则',
  /export function isValidPluginId[\s\S]{0,260}ID_MAX[\s\S]{0,160}ID_RE\.test/.test(manifestSrc),
  '判据没钉住导出函数体');
t('① 源码：import storePrefix（键名不另起一套）', /import \{ storePrefix \} from '\.\/plugin-store\.js'/.test(dsSrc));
t('① 源码：import shouldPurgeDataOnUninstall（去留不另写一套）',
  /import \{ shouldPurgeDataOnUninstall \} from '\.\/plugin-data-policy\.js'/.test(dsSrc));
t('① 源码：不 import node: 内置（webview 里要能跑）', !/from 'node:/.test(dsSrc));

/* ================================================================== *
 * 2. 读写与 id 隔离
 * ================================================================== */
{
  const fs = memoryFs();
  const s = store({ fs });
  t('② 文件不存在 → get 返回 def（不是抛错）',
    (await s.get('aaa', 'k', 'DEF')) === 'DEF');
  await s.set('aaa', 'theme', 'dark');
  t('② set 后 get 拿回', (await s.get('aaa', 'theme')) === 'dark');
  await s.patch('aaa', { size: 12, flag: true });
  t('② patch 合并且不丢旧键',
    (await s.get('aaa', 'theme')) === 'dark' && (await s.get('aaa', 'size')) === 12);
  t('② removeKey 删掉指定键', (await s.removeKey('aaa', 'flag')).removed === true);
  t('② removeKey 后读回 def', (await s.get('aaa', 'flag', 'DEF')) === 'DEF');
  t('② removeKey 不存在的键 → removed:false',
    (await s.removeKey('aaa', 'nope')).removed === false);
  t('② report.keys 与实际一致',
    JSON.stringify((await s.report('aaa')).keys.sort()) === '["size","theme"]',
    JSON.stringify((await s.report('aaa')).keys));

  /* 独占样本：只往 bbb 写一个键，aaa 不该看见。
     若有人把 dataFile 改成所有 id 共用一个文件，这条立刻红。 */
  await s.set('bbb', 'theme', 'light');
  t('② 独占：bbb 的 theme 不串到 aaa',
    (await s.get('aaa', 'theme')) === 'dark');
  t('② 独占：aaa 没写过的 only-b 键读不到',
    (await s.get('aaa', 'only-b', 'DEF')) === 'DEF');
  await s.set('bbb', 'only-b', 1);
  t('② 独占：注入 only-b 后 aaa 仍读不到',
    (await s.get('aaa', 'only-b', 'DEF')) === 'DEF');
  t('② aaa 的数据目录里只有自己的 store.json',
    [...fs.files.keys()].filter((k) => k.includes('/aaa/')).length === 1);
}

/* ================================================================== *
 * 3. 原子写入：写一半被杀，旧数据必须完好
 * ================================================================== */
{
  const fs = memoryFs();
  const s = store({ fs });
  await s.set('pg', 'k', 'old-value');
  const finalPath = s.dataFile('pg');
  const before = fs.files.get(finalPath);

  fs.setFault({ truncateAt: 5 });
  const didThrow = await throws(() => s.set('pg', 'k', 'new-value'));
  t('③ 元断言：注入确实生效（set 抛错）', didThrow === true);

  const tmps = [...fs.files.keys()].filter((k) => k.includes('.store-') && k.endsWith('.tmp'));
  t('③ 元断言：注入留下了半截 tmp（不是"根本没写"）',
    tmps.length === 1 && fs.files.get(tmps[0]).length === 5,
    JSON.stringify(tmps));
  t('③ 关键：store.json 内容一字未变（旧数据没被毁）',
    fs.files.get(finalPath) === before);
  /* 用 safeGet 包住：若实现被改成"直接写 final"，半截内容会落进
     store.json，get 会抛错。这里要把它记成一条失败并继续跑完，
     而不是让整个脚本崩掉、连汇总行都打不出来（看不出是哪节坏了）。 */
  let afterFault;
  try { afterFault = await s.get('pg', 'k'); } catch (e) { afterFault = `THREW:${e.message}`; }
  t('③ 关键：store.json 仍可解析且是上一份完整值',
    afterFault === 'old-value', String(afterFault));
  let allAfterFault;
  try { allAfterFault = (await s.readAll('pg')).k; } catch (e) { allAfterFault = `THREW:${e.message}`; }
  t('③ 残留 tmp 不参与读取', allAfterFault === 'old-value', String(allAfterFault));

  /* 若有人把 writeRecord 改成直接 writeText(final)，上面两条会红：
     半截内容会落进 store.json，"写一半被杀"就变成不可逆的数据丢失。 */
  fs.clearFault();
  /* 同样包住：final 若已被写坏，set 内部的 readRecord 会抛错。
     崩到没有汇总行，比"红几条但点名"更难查 —— 守卫自己不能这样失效。 */
  let restored;
  try { await s.set('pg', 'k', 'new-value'); restored = await s.get('pg', 'k'); }
  catch (e) { restored = `THREW:${e.message}`; }
  t('③ 恢复正常写入后值更新', restored === 'new-value', String(restored));
  t('③ 源码：writeText 写的是 tmp、move 才落到 final',
    /await fs\.writeText\(tmp, payload\)/.test(dsSrc) && /await fs\.move\(tmp, file\)/.test(dsSrc));
  t('③ 源码：tmp 名带随机段（不复用固定名）', /\.store-\$\{rand\(\)\}\.tmp/.test(dsSrc));
}

/* ================================================================== *
 * 4. 损坏文件必须抛错（与"文件不存在"分开）
 * ================================================================== */
{
  const fs = memoryFs();
  const s = store({ fs });
  const f = s.dataFile('pg');

  fs.files.set(f, '{"v":1,"data":{"k":');
  t('④ 半个 JSON → 抛错，不静默返回默认值',
    await throws(() => s.get('pg', 'k'), '损坏'));
  t('④ 错误信息点名文件路径（便于人工核对）',
    await throws(() => s.get('pg', 'k'), f));

  fs.files.set(f, JSON.stringify({ v: 99, data: { k: 1 } }));
  t('④ 版本号不对 → 抛错', await throws(() => s.get('pg', 'k'), '格式不对'));
  fs.files.set(f, JSON.stringify({ v: 1, data: [] }));
  t('④ data 不是对象 → 抛错', await throws(() => s.get('pg', 'k'), '格式不对'));

  /* 独占：文件不存在是另一回事，不许一起抛 */
  const fresh = store();
  t('④ 独占：文件不存在 → 不抛、返回 def',
    (await fresh.get('fresh', 'k', 'DEF')) === 'DEF');
  t('④ 源码：解析失败处没有静默 catch 成空对象',
    /未自动重置，请人工核对/.test(dsSrc) && !/catch\s*\{[^}]*return \{\}/s.test(dsSrc));
  t('④ STORE_VERSION 为 1 且写入时带上', STORE_VERSION === 1 && /v: STORE_VERSION/.test(dsSrc));
}

/* ================================================================== *
 * 5. 迁移：幂等 + 不覆盖新数据 + 键名复用
 * ================================================================== */
{
  const legacy = memStorage({
    [storeKey('pg', 'k1')]: JSON.stringify({ x: 1 }),
    [storeKey('pg', 'k2')]: 'plain-string',
    [storeKey('other', 'k3')]: '"别人的"',
    'unrelated': 'x',
  });
  const s = store({ legacyStorage: legacy });
  const r1 = await s.migrate('pg');
  t('⑤ 迁移导入 2 个本插件键', r1.imported === 2 && r1.skipped === false,
    JSON.stringify(r1));
  t('⑤ 键名去掉前缀（不是把整串 nexus:pg:k1 当键）',
    (await s.get('pg', 'k1')).x === 1);
  t('⑤ 别的插件的键没搬进来',
    (await s.get('pg', 'k3', 'DEF')) === 'DEF');
  t('⑤ 裸字符串按字符串保留', (await s.get('pg', 'k2')) === 'plain-string');
  t('⑤ 迁移幂等：第二次直接跳过',
    JSON.stringify(await s.migrate('pg')) === JSON.stringify({ imported: 0, skipped: true, keys: [] }));
  t('⑤ 迁移不清 localStorage（旧数据留作兜底）', legacy._map.has(storeKey('pg', 'k1')));
  t('⑤ 源码：前缀来自 storePrefix(id)', /storePrefix\(id\)/.test(dsSrc));

  /* 独占：升级后改过的新值不能被旧快照盖掉。
     若合并方向写反（legacy 覆盖文件），这条红，而上面的"导入 2 个"仍绿。 */
  const legacy2 = memStorage({ [storeKey('pg2', 'k1')]: '"OLD"', [storeKey('pg2', 'k2')]: '"K2"' });
  const s2 = store({ legacyStorage: legacy2 });
  await s2.set('pg2', 'k1', 'NEW');
  const r2 = await s2.migrate('pg2');
  t('⑤ 独占：文件里已有的 k1 不被旧值覆盖', (await s2.get('pg2', 'k1')) === 'NEW');
  t('⑤ 独占：只补文件里没有的 k2', r2.imported === 1 && (await s2.get('pg2', 'k2')) === 'K2',
    JSON.stringify(r2));

  t('⑤ 没有 legacyStorage 时 migrate 不炸也不写坏文件',
    JSON.stringify(await store().migrate('nolegacy')) === JSON.stringify({ imported: 0, skipped: true, keys: [] }));
}

/* ================================================================== *
 * 6. 卸载保留 / 重装恢复（D3 核心）
 * ================================================================== */
{
  const fs = memoryFs();
  const s = store({ fs, legacyStorage: memStorage({}) });
  await s.set('market-plug', 'theme', 'dark');

  const r = await s.uninstall('market-plug', { source: SOURCE_MARKET });
  t('⑥ 市场插件卸载：purged=false / kept=true',
    r.purged === false && r.kept === true, JSON.stringify(r));
  t('⑥ 卸载后数据文件仍在', await fs.exists(s.dataFile('market-plug')));
  /* 重装 = 同一个 id、同一个 dataRoot，新建一个 store 实例 */
  const reinstalled = store({ fs });
  t('⑥ 重装可恢复：读回卸载前的值',
    (await reinstalled.get('market-plug', 'theme')) === 'dark');

  t('⑥ 显式 removeUserData=true → 真的删',
    (await reinstalled.uninstall('market-plug', { source: SOURCE_MARKET, removeUserData: true })).purged === true);
  t('⑥ 删后目录空了', !(await fs.exists(reinstalled.dataDir('market-plug'))));

  const fs2 = memoryFs();
  const s2 = store({ fs: fs2 });
  await s2.set('custom-x', 'k', 1);
  t('⑥ custom 来源沿用既有行为（清）',
    (await s2.uninstall('custom-x', { source: SOURCE_CUSTOM })).purged === true);
  t('⑥ custom 清后读不到', (await s2.get('custom-x', 'k', 'DEF')) === 'DEF');

  const fs3 = memoryFs();
  const s3 = store({ fs: fs3 });
  await s3.set('unknown', 'k', 1);
  t('⑥ 来源未知 → 默认保留（多留可逆，多删不可逆）',
    (await s3.uninstall('unknown', {})).kept === true);

  /* 元断言：策略确实不是恒真/恒假 */
  t('⑥ 元断言：好策略 market 保留',
    shouldPurgeDataOnUninstall({ id: 'a', source: SOURCE_MARKET }) === false);
  t('⑥ 元断言：好策略 custom 清',
    shouldPurgeDataOnUninstall({ id: 'a', source: SOURCE_CUSTOM }) === true);

  /* 破坏验证：把策略换成恒真，复现"市场插件数据被清"这个失效。
     先确认注入生效，再断言它确实毁掉了数据 —— 这证明上面那些
     重装恢复断言不是摆设：策略一旦被改成恒真，它们会红。 */
  const fs4 = memoryFs();
  const bad = store({ fs: fs4, policy: () => true });
  await bad.set('market-plug', 'theme', 'dark');
  const badR = await bad.uninstall('market-plug', { source: SOURCE_MARKET });
  t('⑥ 破坏验证：注入恒真策略确实生效（purged=true）', badR.purged === true);
  t('⑥ 破坏验证：数据真的被删（复现失效）',
    !(await fs4.exists(bad.dataFile('market-plug'))));
  t('⑥ 破坏验证：此时重装读不回来（上面 ⑥ 的断言会红）',
    (await store({ fs: fs4 }).get('market-plug', 'theme', 'DEF')) === 'DEF');

  /* 源码钉住：产品侧不许写死 true/false 绕过策略 */
  t('⑥ 源码：uninstall 走 policy()', /const decision = !!policy\(\{/.test(dsSrc));
  t('⑥ 源码：没有 purge 的硬编码无条件调用', !/await this\.purge\(id\);\s*return \{ id, purged: true/.test(dsSrc));
}

/* ================================================================== *
 * 7. cwd 不变性（本项目体检项）
 * ================================================================== */
/* ⚠ 字面量刻意拼开写，别"优化"回去：
   断言卫生守卫第 5 节扫全仓测试里的 process.cwd() 字面量（剥注释后），
   连**断言名字符串**里的字样也算违规。而这里只是把它当作**被检查的模式**，
   不是调用它。上一版把字样直接写进断言名，结果守卫点名本文件 ——
   是写法触发误报，不是守卫该放宽。拼开写既保住元断言又不误伤。 */
const cwdToken = ['process', 'cwd()'].join('.');
t('⑦ 源码：不出现 cwd 定位', !dsSrc.includes(cwdToken));
t('⑦ 源码：所有 import 都是相对路径',
  [...dsSrc.matchAll(/from '([^']+)'/g)].every((m) => m[1].startsWith('./')));
t('⑦ 源码：storePrefix 常量与 plugin-store.js 对得上',
  storePrefix('pg') === 'nexus:pg:' && src('js/plugin-store.js').includes('export function storePrefix'));

console.log(`\n[插件数据存储] 通过 ${pass} 项，失败 ${fails.length} 项`);
for (const f of fails) console.log(`  ❌ ${f}`);
process.exit(fails.length ? 1 : 0);
