#!/usr/bin/env node
/**
 * 联网商店 · 结果展示格式层守卫
 * ============================================================================
 *
 * 为什么单独做这个守卫
 * ------------------------------------------------------------
 * 第 51 轮查出 12 个私有仓的共享镜像里 `js/market-binding.js` 是 220 行，
 * 主仓只有 134 行：并行窗口往 12 仓刷了 4 个 format* 纯函数（面板结果
 * 汇总），而主仓**没有调用点**，仍是旧写法：
 *   · checkUpdates 只数 hasUpdate，失败 / 没查成 / 同版本产物被重传
 *     一律显示「所有已安装插件均为最新」
 *   · install 吞掉 warnings、version 缺失时拼出 vundefined
 *   · uninstall 写死「用户数据已保留」，而编排层真实返回 purgeUserData
 *   · list 只报数量，skipped / errors 整段消失
 * 把「没查成」报成「查过且干净」是本项目第 203 轮已在别处修过的形状。
 *
 * 于是「12 仓漂移的权威方向」不需要人拍板：220 行版是 134 行版的严格
 * 超集（原 134 行一字未改），字段契约与编排层返回逐项吻合，但**只把文件
 * 提上主仓而不接调用点，等于注释撒谎 + 4 个孤儿 export**。本守卫把两件事
 * 钉在一起，且钉住主仓与 12 仓共享镜像的 blob sha 必须相同。
 *
 * 判据只有一份：行为断言集中在 evaluateFormat(m)，元断言直接把假模块喂给
 * 同一个函数，确认「判据恒真 / 空集合恒真」当场喊出来，不用第二套正则去
 * 猜判据长什么样。
 *
 * 已知边界：纯静态守卫挡不住「把主断言整行删掉或改成 true」，靠每轮
 * 破坏验证兜，不假装能自证。
 *
 * 零外部依赖，按 import.meta.url 定位根，从任意 cwd 可跑。
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');
const strip = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const blobSha = (buf) => {
  const h = createHash('sha1');
  h.update('blob ' + buf.length + '\0');
  h.update(buf);
  return h.digest('hex');
};

let pass = 0;
const fails = [];
const t = (name, ok) => {
  if (ok) pass++;
  else fails.push(name);
};

/* ---------------------------------------------------------------------------
 * 唯一的行为判据。喂任意模块实现，返回逐项结果 —— 元断言复用同一份。
 * ------------------------------------------------------------------------- */
export function evaluateFormat(m) {
  const rows = [];
  const t2 = (name, ok) => rows.push({ name, ok: !!ok });
  const has = (s, w) => typeof s === 'string' && s.includes(w);

  const fns = ['formatMarketList', 'formatCheckUpdates', 'formatInstall', 'formatUninstall'];
  for (const f of fns) t2(`①a 导出 ${f}`, typeof m[f] === 'function');
  if (fns.some((f) => typeof m[f] !== 'function')) return rows;

  const [list, upd, ins, uns] = fns.map((f) => m[f]);

  /* 列表：skipped / errors 不能被数量淹没 */
  const l1 = list({ plugins: [{ builtin: true }, { builtin: false }], skipped: [], errors: [] });
  t2('②a 正常列表 tone=ok 且带数量', l1.tone === 'ok' && has(l1.text, '1 个'));
  const l2 = list({ plugins: [{ builtin: false }], skipped: [{ id: 'x', reason: '缺 manifest' }], errors: [] });
  t2('②b skipped → tone=err 且报「没生效」', l2.tone === 'err' && has(l2.text, '没生效'));
  const l3 = list({ plugins: [], skipped: [], errors: ['台账读取失败'] });
  t2('②c errors → tone=err 且报「扫描出错」', l3.tone === 'err' && has(l3.text, '扫描出错'));
  const l4 = list(null);
  t2('②d 空输入不抛异常且 tone=ok', l4.tone === 'ok');

  /* 查更新：三种「没查成 / 有变化」不许冒充「均为最新」 */
  const u1 = upd({ results: [], errors: ['台账读取失败'] });
  t2('③a 台账读失败 → err 且不报「均为最新」', u1.tone === 'err' && !has(u1.text, '均为最新'));
  const u2 = upd({ results: [{ id: 'a', checked: false, hasUpdate: false }], errors: [] });
  t2('③b checked=false → err 且报「没查成」', u2.tone === 'err' && has(u2.text, '没查成') && !has(u2.text, '均为最新'));
  const u3 = upd({ results: [{ id: 'a', checked: true, hasUpdate: false, fingerprintChanged: true }], errors: [] });
  t2('③c fingerprintChanged → err 且报「重新上传」', u3.tone === 'err' && has(u3.text, '重新上传'));
  const u4 = upd({ results: [{ id: 'a', checked: true, hasUpdate: true }], errors: [] });
  t2('④a 真有更新 → ok 且报「有更新」', u4.tone === 'ok' && has(u4.text, '有更新'));
  const u5 = upd({ results: [{ id: 'a', checked: true, hasUpdate: false, fingerprintChanged: false }], errors: [] });
  t2('④b 全部检查过且无变化 → ok 且报「均为最新」', u5.tone === 'ok' && has(u5.text, '均为最新'));
  const u6 = upd({ results: [], errors: [] });
  t2('④c 空台账 → 不假称「均为最新」', !has(u6.text, '均为最新'));

  /* 安装：告警与失败阶段必须出现，不许拼 undefined */
  const i1 = ins({ ok: false, stage: 'digest', error: 'sha 不匹配' });
  t2('⑤a 失败带阶段与原因', i1.tone === 'err' && has(i1.text, '阶段：digest') && has(i1.text, 'sha 不匹配'));
  const i2 = ins({ ok: true, id: 'x', version: '1.2.3', warnings: ['解包跳过条目 a'] });
  t2('⑤b 告警条目出现', i2.tone === 'ok' && has(i2.text, '1 项告警') && has(i2.text, '解包跳过条目 a'));
  const i3 = ins({ ok: true, id: 'x' });
  t2('⑤c 缺 version 不拼 undefined', !has(i3.text, 'undefined'));

  /* 卸载：清了数据不许写「已保留」 */
  const d1 = uns({ ok: true, id: 'x', purgeUserData: true, kept: [] });
  t2('⑥a purgeUserData=true → 报「清除」且不报「已保留」', d1.tone === 'ok' && has(d1.text, '清除') && !has(d1.text, '已保留'));
  const d2 = uns({ ok: true, id: 'x', purgeUserData: false, kept: ['store.json'] });
  t2('⑥b 未清数据 → 报「已保留」', d2.tone === 'ok' && has(d2.text, '已保留'));
  const d3 = uns({ ok: false, id: 'x', error: '插件未安装' });
  t2('⑥c 失败 → err 且带原因', d3.tone === 'err' && has(d3.text, '插件未安装'));

  return rows;
}

/* ---------------------------------------------------------------------------
 * 主流程
 * ------------------------------------------------------------------------- */
let mod = {};
let loadOk = false;
let loadErr = '';
try {
  mod = await import(pathToFileURL(join(ROOT, 'js/market-binding.js')).href);
  loadOk = true;
} catch (e) {
  loadErr = String((e && e.message) || e);
}
t('⓪ 装配层可被加载（不静默跳过）', loadOk);
if (!loadOk) {
  console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
  for (const f of fails) console.log('  FAIL ' + f);
  console.log('  装载错误: ' + loadErr);
  process.exit(1);
}

for (const r of evaluateFormat(mod)) t(r.name, r.ok);

/* 元断言：把同一份判据喂一个「全部报一切正常」的假模块，必须红。 */
const liar = {
  formatMarketList: () => ({ tone: 'ok', text: '联网安装已就绪 · 已安装 0 个市场插件' }),
  formatCheckUpdates: () => ({ tone: 'ok', text: '所有已安装插件均为最新' }),
  formatInstall: () => ({ tone: 'ok', text: '已安装' }),
  formatUninstall: () => ({ tone: 'ok', text: '已卸载（用户数据已保留）' }),
};
const liarRows = evaluateFormat(liar);
const liarFails = liarRows.filter((r) => !r.ok);
t('⑦a 假模块被判据抓出（≥8 项红）', liarFails.length >= 8);
t('⑦b 假模块没把「均为最新」判据蒙混过去', liarFails.some((r) => r.name.includes('③a') || r.name.includes('③b')));
t('⑦c 判据对空模块 fail-closed（不是空集合恒真）', evaluateFormat({}).some((r) => !r.ok));

/* 生产调用点：文件提上来了不等于用上了。 */
const panelRaw = rd('plugins/store/index.js');
const panel = strip(panelRaw);
const panelImports = (panel.match(/import\s*\{[^}]*\}\s*from\s*['"][^'"]*market-binding\.js['"]/g) || [])[0] || '';
for (const f of ['formatMarketList', 'formatCheckUpdates', 'formatInstall', 'formatUninstall']) {
  t(`⑧a 面板 import 了 ${f}`, panelImports.includes(f));
  const calls = (panel.match(new RegExp('\\b' + f + '\\s*\\(', 'g')) || []).length;
  t(`⑧b 面板有 ${f} 的真实调用点`, calls >= 1);
}
t('⑧c 旧写法「hits.length ? … : 均为最新」已消失', !/hits\.length/.test(panel) && !/'所有已安装插件均为最新'/.test(panel));
t('⑧d 旧写法「（用户数据已保留）」写死已消失', !/'已卸载「\$\{[^}]*\}」（用户数据已保留）'/.test(panelRaw));
t('⑧e 旧写法 v${r.version} 拼装已消失', !/v\$\{r\.version\}/.test(panelRaw));
/* 不能只判「存在一处 view.tone」：三个按钮里坏一个照样绿，
 * 而坏的那个恰好会把失败显示成成功。改成全覆盖计数判据。 */
const toastCalls = (panel.match(/ctx\.toast\?\.\(\s*\w+\.text\s*,/g) || []).length;
const toneCalls = (panel.match(/ctx\.toast\?\.\(\s*\w+\.text\s*,\s*\w+\.tone\s*\)/g) || []).length;
t('⑧f 3 处 toast 全部把 tone 传进去（不是「存在一处」）',
  toastCalls === 3 && toneCalls === 3 && !/ctx\.toast\?\.\(\s*\w+\.text\s*,\s*'ok'/.test(panel));
/* 状态行也必须吃 tone：只取 .text 会把「装了但没生效 / 扫描出错」
   用成功样式显示，文案对了但视觉把人往干净那一侧带。 */
t('⑧h 状态行用到 tone（不丢 .tone）', /netState\.style\.color\s*=/.test(panel) && /view\.tone/.test(panel));
/* 这条判的是注释内容，必须用未剥注释的原文：拿 panel 判等于恒真。 */
t('⑧i 注释不再写「把数量写进状态行」', !/把「已联网安装」的数量写进状态行/.test(panelRaw));
t('⑧g 状态行也走 formatMarketList（不是只数数量）', /formatMarketList\(/.test(panel) && !/const n = \(listed\?\.plugins/.test(panel));

/* 字段契约：format 读的字段必须真的由编排层返回，不是凭想象写的。 */
const binding = strip(rd('js/market-binding.js'));
const marketJs = strip(rd('js/plugin-market.js'));
const ledgerJs = strip(rd('js/plugin-ledger.js'));
const scanJs = strip(rd('js/installed-plugin-scan.js'));
const pairs = [
  ['o.purgeUserData', marketJs, /purgeUserData\s*:/],
  ['o.kept', marketJs, /kept\s*:/],
  ['x.fingerprintChanged', ledgerJs, /fingerprintChanged\s*:/],
  ['x.checked', ledgerJs, /checked\s*:/],
  ['x.hasUpdate', ledgerJs, /hasUpdate\s*:/],
  ['o.skipped', scanJs, /skipped/],
  ['o.errors', scanJs, /errors/],
  ['o.plugins', scanJs, /plugins\s*:/],
];
for (const [read, src, emitted] of pairs) {
  t(`⑨a 格式层读 ${read}，编排层确实返回`, binding.includes(read) && emitted.test(src));
}

/* 共享镜像：主仓是权威源，12 仓那份必须与它逐字节相同。
 *
 * ⚠️ 原来 ⑩c 的名字叫「== 12 仓镜像 sha」，实现却只比「主仓文件 vs
 *    台账里手写的 sharedBlobSha」。台账是 JSON 文本，不是 12 仓实测：
 *    · 报红时最省事的「修法」就是改台账 sha —— 正是台账 why 里点名禁止
 *      的「把漂移洗白成基线」；
 *    · 12 仓任何一仓被自治提交改了，离线守卫全绿；
 *    · 台账填 12 个任意仓名也全绿（⑩a 只数条数）。
 *    所以台账升级成逐仓实测快照（perRepo）：离线把「主仓文件 / 台账 /
 *    唯一真值源的 12 仓名」三方钉自洽，联网由 verify-plugin-repos.mjs ⑦ 节
 *    逐仓拿 API 实测复核台账。判据只有一份 evaluateMirror(m,...)，元断言
 *    把坏台账喂给同一个函数，确认不是恒真 / 空集合恒真。 */
let mirror;
try {
  mirror = JSON.parse(rd('scripts/market-result-mirror.json'));
} catch (e) {
  console.log('⛔ 镜像台账解析失败，守卫拒绝空跑：' + String((e && e.message) || e));
  process.exit(1);
}
const localSha = blobSha(readFileSync(join(ROOT, 'js/market-binding.js')));
let expectedRepos = [];
let mapErr = '';
try {
  const rm = await import(pathToFileURL(join(ROOT, 'scripts/plugin-repo-map.mjs')).href);
  expectedRepos = Object.keys(rm.CAMEL).map((id) => rm.repoNameFor(id)).sort();
} catch (e) { mapErr = String((e && e.message) || e); }

function evaluateMirror(m, masterSha, repos) {
  const rows = [];
  const t2 = (name, ok) => rows.push({ name, ok: !!ok });
  const hex = (s) => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
  const keys = m && m.perRepo && typeof m.perRepo === 'object' && !Array.isArray(m.perRepo)
    ? Object.keys(m.perRepo).sort() : [];
  const want = [...repos].sort();
  t2('⑩a 台账 12 仓恰好 12 条', Array.isArray(m.repos) && m.repos.length === 12);
  t2('⑩b 台账 sha 是 40 位 hex', hex(m.sharedBlobSha));
  t2('⑩c 主仓装配层 blob sha == 台账记录的共享镜像 sha', masterSha === m.sharedBlobSha);
  t2('⑩d 台账说明写清「改主仓必须同步刷 12 仓」', /同步|刷新|12/.test(m.why || ''));
  t2('⑩e 唯一真值源可取（12 个可安装仓）', repos.length === 12 && !mapErr);
  t2('⑩f perRepo 键集合 == 唯一真值源 12 仓',
    keys.length === 12 && keys.every((k, i) => k === want[i]));
  t2('⑩g perRepo 与 repos 两份名单一致',
    Array.isArray(m.repos) && [...m.repos].sort().join('|') === keys.join('|'));
  t2('⑩h perRepo 每仓 sha 合法且 == sharedBlobSha',
    keys.length > 0 && keys.every((k) => hex(m.perRepo[k]) && m.perRepo[k] === m.sharedBlobSha));
  t2('⑩i 不含第 13 仓 githubManager（它不进共享镜像）',
    keys.length > 0 && keys.every((k) => !/githubManager/i.test(k)));
  return rows;
}
for (const r of evaluateMirror(mirror, localSha, expectedRepos)) t(r.name, r.ok);

/* 元断言：坏台账必须被同一份判据抓出。变体对空 / 损坏台账也要能构造 ——
 * 否则台账一坏守卫先崩在半路，连「自己没在干活」都不会说。 */
const badMirrors = [
  ['删掉 perRepo', (m) => ({ ...m, perRepo: undefined })],
  ['某仓 sha 改成旧值', (m) => {
    const keys = Object.keys(m.perRepo || {});
    const k = keys[0] || '__none__';
    return { ...m, perRepo: { ...(m.perRepo || {}), [k]: '0'.repeat(40) } };
  }],
  ['某仓名填错', (m) => {
    const p = { ...(m.perRepo || {}) };
    const k = Object.keys(p)[0];
    if (k) { const v = p[k]; delete p[k]; p['nexusPanel_plugin_typo'] = v; }
    else p['nexusPanel_plugin_typo'] = '0'.repeat(40);
    return { ...m, perRepo: p };
  }],
  ['sharedBlobSha 改掉', (m) => ({ ...m, sharedBlobSha: 'f'.repeat(40) })],
];
for (const [name, mutate] of badMirrors) {
  const rows = evaluateMirror(mutate(mirror), localSha, expectedRepos);
  t(`⑪a 坏台账「${name}」被抓出`, rows.some((r) => !r.ok));
}
t('⑪b 判据对空台账 fail-closed',
  evaluateMirror({}, localSha, expectedRepos).some((r) => !r.ok));

console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
for (const f of fails) console.log('  FAIL ' + f);
if (fails.length) process.exit(1);
