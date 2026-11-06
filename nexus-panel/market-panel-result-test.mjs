#!/usr/bin/env node
/**
 * 联网商店面板「结果如实汇总」守卫（第 51 轮）
 * ============================================================================
 *
 * 补的是第 50 轮接线守卫的空缺。market-binding-guard-test.mjs ⑦ 只判
 * 「生产入口有没有调用四个能力」，market-binding-runtime-test.mjs 只判
 * 「能不能真跑、PAT 有没有进请求头」，都没问过一件要紧的事：
 *
 *   调用之后，返回值里的失败信号有没有被如实告诉用户？
 *
 * 原面板只数 hasUpdate 为真的条数，于是台账读不到、某个仓库查询失败、
 * 同版本产物被重新上传，统统报「所有已安装插件均为最新」并带成功样式；
 * 安装告警被整段吞掉；卸载按来源策略真的清了数据，界面还写死「已保留」。
 * 这是本项目第 203 轮在别处修过的形状，刚接线的面板又把它引了回来。
 *
 * 本守卫三层：
 *   ① 行为层：真 import 四个汇总纯函数，喂编排层真实返回形状
 *   ② 红线层：汇总函数不许变成第二份编排（不调市场方法、不 await）
 *   ③ 接线层：剥注释后扫生产入口，四个函数各有消费点、旧字面量已消失、
 *      按钮异常有统一兜底
 *   ④ 元断言：判据必须能区分旧形态，且不被注释里的字样喂饱
 *
 * 反向验证：node market-panel-result-test.mjs --against <旧版面板文件>
 * 会对指定文件跑接线判据并断言「必须报未接线」。
 *
 * 剥注释一律走共用模块：本项目多次栽在「注释里的字被当成依据」和
 * 「内联剥注释实现未登台账」上。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { stripCommentsFlatJs } from './test-scan-utils.mjs';
import {
  formatMarketList, formatCheckUpdates, formatInstall, formatUninstall,
} from './js/market-binding.js';

const ROOT = process.cwd();
const STORE = join(ROOT, 'plugins/store/index.js');
const ASM = join(ROOT, 'js/market-binding.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const has = (s, sub) => String(s).includes(sub);

/* ────────────────────────────────────────────────────────────────
 * ① 行为层：编排层真实返回形状 → 界面文案
 * ──────────────────────────────────────────────────────────────── */
{
  const ok = formatMarketList({
    plugins: [{ id: 'a' }, { id: 'b' }, { id: 'home', builtin: true }],
    skipped: [], errors: [],
  });
  t('①a 列表正常：只数非内置，成功样式', ok.tone === 'ok' && has(ok.text, '已安装 2 个市场插件'), ok.text);

  const dirty = formatMarketList({
    plugins: [{ id: 'a' }],
    skipped: [{ name: 'x' }, { name: 'y' }],
    errors: ['目标不是目录'],
  });
  t('①b 列表有装了没生效 / 扫描出错：不许只报数量',
    dirty.tone === 'err' && has(dirty.text, '2 项装了但没生效') && has(dirty.text, '扫描出错'), dirty.text);
}

{
  const allFresh = formatCheckUpdates({
    results: [
      { id: 'a', checked: true, hasUpdate: false },
      { id: 'b', checked: true, hasUpdate: false },
    ], errors: [],
  });
  t('②a 全部已检查且无更新：成功样式 + 已检查字样',
    allFresh.tone === 'ok' && has(allFresh.text, '均为最新') && has(allFresh.text, '已检查'), allFresh.text);

  /* 台账读取失败是 plugin-market.js 的真实返回：空 results + errors。 */
  const ledgerBroken = formatCheckUpdates({ results: [], errors: ['台账读取失败: bad json'] });
  t('②b 台账读不到不许报「均为最新」',
    ledgerBroken.tone === 'err' && has(ledgerBroken.text, '检查失败')
    && !has(ledgerBroken.text, '均为最新'), ledgerBroken.text);

  const partial = formatCheckUpdates({
    results: [
      { id: 'a', checked: false, hasUpdate: false, reason: '查询失败' },
      { id: 'b', checked: true, hasUpdate: false },
    ], errors: ['a: 404'],
  });
  t('②c 部分仓库没查成：单独说「没查成」，不混入「均为最新」',
    partial.tone === 'err' && has(partial.text, '没查成') && !has(partial.text, '均为最新'), partial.text);

  const repacked = formatCheckUpdates({
    results: [{ id: 'a', checked: true, hasUpdate: false, fingerprintChanged: true }],
    errors: [],
  });
  t('②d 同版本产物被重传：必须提示核对来源（ledger 注释明确要求）',
    repacked.tone === 'err' && has(repacked.text, '重新上传') && has(repacked.text, '核对来源'), repacked.text);

  const hits = formatCheckUpdates({
    results: [
      { id: 'a', checked: true, hasUpdate: true },
      { id: 'b', checked: true, hasUpdate: false },
    ], errors: [],
  });
  t('②e 真有更新：成功样式且列出 id',
    hits.tone === 'ok' && has(hits.text, '1 个插件有更新') && has(hits.text, 'a'), hits.text);

  const empty = formatCheckUpdates({ results: [], errors: [] });
  t('②f 台账里没有市场插件：不谎称「均已最新」',
    empty.tone === 'ok' && has(empty.text, '没有可检查'), empty.text);

  const mixed = formatCheckUpdates({
    results: [{ id: 'a', checked: true, hasUpdate: true }],
    errors: ['b: 网络中断'],
  });
  t('②g 有更新也有失败：整体按失败报，不许被「有更新」带成成功',
    mixed.tone === 'err' && has(mixed.text, '检查失败'), mixed.text);
}

{
  const good = formatInstall({ ok: true, id: 'demo', version: '1.2.3' });
  t('③a 安装成功带版本', good.tone === 'ok' && has(good.text, 'v1.2.3'), good.text);

  const noVer = formatInstall({ ok: true, id: 'demo' });
  t('③b 缺版本不拼 undefined', noVer.tone === 'ok' && !has(noVer.text, 'undefined'), noVer.text);

  const warned = formatInstall({ ok: true, id: 'demo', version: '1.0.0', warnings: ['该 release 产物没有 digest'] });
  t('③c 安装告警要出现在文案里',
    warned.tone === 'ok' && has(warned.text, '告警') && has(warned.text, 'digest'), warned.text);

  const failed = formatInstall({ ok: false, stage: 'digest', error: 'sha256 不匹配' });
  t('③d 安装失败带原因与阶段',
    failed.tone === 'err' && has(failed.text, 'sha256') && has(failed.text, 'digest'), failed.text);
}

{
  const kept = formatUninstall({ ok: true, id: 'demo', purgeUserData: false, kept: ['store.json'] });
  t('④a 默认保留数据：说保留', kept.tone === 'ok' && has(kept.text, '已保留'), kept.text);

  /* source=custom 时 plugin-data-policy.js 判清数据，这是不可逆动作。 */
  const purged = formatUninstall({ ok: true, id: 'demo', purgeUserData: true, kept: [] });
  t('④b 按来源策略清了数据：绝不许再说「已保留」',
    purged.tone === 'ok' && !has(purged.text, '已保留') && has(purged.text, '清除了'), purged.text);

  const failed = formatUninstall({ ok: false, id: 'demo', error: '插件未安装' });
  t('④c 卸载失败带原因', failed.tone === 'err' && has(failed.text, '插件未安装'), failed.text);
}

/* ────────────────────────────────────────────────────────────────
 * ② 红线层：汇总函数不是第二份编排
 * ──────────────────────────────────────────────────────────────── */
const asmRaw = readFileSync(ASM, 'utf8');
const asm = stripCommentsFlatJs(asmRaw);
const FN_NAMES = ['formatMarketList', 'formatCheckUpdates', 'formatInstall', 'formatUninstall'];
function sliceFn(code, name) {
  const start = code.indexOf(`export function ${name}(`);
  if (start < 0) return '';
  const next = code.indexOf('export function ', start + 1);
  return code.slice(start, next < 0 ? code.length : next);
}
for (const name of FN_NAMES) {
  const body = sliceFn(asm, name);
  t(`⑤ 红线：${name} 存在`, body.length > 40);
  t(`⑤ 红线：${name} 不调市场方法、不 await`,
    !/\bmarket\s*\./.test(body) && !/\bawait\b/.test(body)
    && !/\bcreatePluginMarket\s*\(/.test(body));
}
t('⑤ 红线：装配层只有一个编排层实例化（汇总函数没再造一份）',
  (asm.match(/\bcreatePluginMarket\s*\(/g) || []).length === 1,
  String((asm.match(/\bcreatePluginMarket\s*\(/g) || []).length));

/* ────────────────────────────────────────────────────────────────
 * ③ 接线层：生产入口真的消费了这些汇总
 * ──────────────────────────────────────────────────────────────── */
function wiringReport(raw) {
  const src = stripCommentsFlatJs(String(raw));
  const misses = [];
  for (const name of FN_NAMES) {
    if (!new RegExp(`\\b${name}\\s*\\(`).test(src)) misses.push(`未消费 ${name}`);
  }
  /* 旧版只数 hits 的三处写死文案必须消失 */
  if (has(src, '所有已安装插件均为最新')) misses.push('仍写死「均为最新」');
  if (has(src, '用户数据已保留')) misses.push('仍写死「用户数据已保留」');
  if (/v\$\{r\.version\}/.test(src)) misses.push('仍直接拼 r.version');
  /* 三个按钮的形态：汇总结果连同 tone 一起交给 toast */
  const toneCalls = (src.match(/ctx\.toast\?\.\(\s*m\.text\s*,\s*m\.tone\s*\)/g) || []).length;
  if (toneCalls < 3) misses.push(`带 tone 的 toast 仅 ${toneCalls} 处（应 ≥3）`);
  /* 状态行用汇总函数，不再自己数 plugins */
  if (!/formatMarketList\s*\(\s*listed\s*\)/.test(src)) misses.push('状态行未用 formatMarketList');
  /* 按钮统一异常兜底：netBtn 包装里 try / catch / err toast 三者齐全 */
  const btnStart = src.indexOf('const netBtn');
  const btnEnd = btnStart < 0 ? -1 : src.indexOf('}, label);', btnStart);
  const btn = btnEnd < 0 ? '' : src.slice(btnStart, btnEnd);
  if (!/\btry\s*\{/.test(btn) || !/\bcatch\s*\(/.test(btn) || !/'err'/.test(btn)) {
    misses.push('netBtn 缺统一异常兜底');
  }
  return { ok: misses.length === 0, misses, toneCalls };
}

const storeRaw = existsSync(STORE) ? readFileSync(STORE, 'utf8') : '';
const wiring = wiringReport(storeRaw);
t('⑥a 生产入口四个汇总函数全部接线', wiring.ok, wiring.misses.join(' / '));
t('⑥b 带 tone 的 toast 恰好覆盖三个动作', wiring.toneCalls >= 3, String(wiring.toneCalls));

/* ────────────────────────────────────────────────────────────────
 * ④ 元断言：判据不恒真、不被注释喂饱
 * ──────────────────────────────────────────────────────────────── */
const LEGACY_PANEL = `
const netBtn = (label, fn) => h('button', { onclick: fn }, label);
netBtn('检查更新', async () => {
  const r = await market.checkUpdates();
  const hits = (r.results || []).filter(x => x.hasUpdate);
  ctx.toast?.(hits.length ? hits.length + ' 个有更新' : '所有已安装插件均为最新', 'ok');
});
netBtn('卸载', async () => {
  const r = await market.uninstall(id);
  ctx.toast?.(r.ok ? '已卸载（用户数据已保留）' : '卸载失败', r.ok ? 'ok' : 'err');
});
`;
const legacy = wiringReport(LEGACY_PANEL);
t('⑦a 旧版面板形态必须报未接线（判据不恒真）', !legacy.ok, legacy.misses.join(' / '));
t('⑦b 旧版报告点名「均为最新」与异常兜底',
  legacy.misses.some((x) => x.includes('均为最新'))
  && legacy.misses.some((x) => x.includes('兜底')), legacy.misses.join(' / '));

const COMMENT_ONLY = `
/* const m = formatCheckUpdates(r); ctx.toast?.(m.text, m.tone); */
// formatInstall(r); formatUninstall(r); formatMarketList(listed);
const netState = formatMarketList(listed);
`;
const commentRep = wiringReport(COMMENT_ONLY);
t('⑦c 注释里的假调用不计入接线',
  !commentRep.ok && commentRep.misses.some((x) => x.includes('未消费 formatCheckUpdates')),
  commentRep.misses.join(' / '));
t('⑦d 空文本不许判为已接线', !wiringReport('').ok);

/* 行为判据也不恒真：拿旧版「只数 hits」的实现跑 ② 的四条关键断言，
   必须至少 3 条报红 —— 少一条都说明断言盯的是别的东西。 */
function legacyCheckUpdates(r) {
  const hits = ((r && r.results) || []).filter((x) => x.hasUpdate);
  return { tone: 'ok', text: hits.length ? '有更新' : '所有已安装插件均为最新' };
}
let legacyRed = 0;
for (const sample of [
  { results: [], errors: ['台账读取失败'] },
  { results: [{ checked: false, hasUpdate: false }], errors: ['a: 404'] },
  { results: [{ checked: true, hasUpdate: false, fingerprintChanged: true }], errors: [] },
  { results: [{ checked: true, hasUpdate: true }], errors: ['b: 断网'] },
]) {
  const m = legacyCheckUpdates(sample);
  if (!(m.tone === 'err' || !has(m.text, '均为最新'))) legacyRed++;
}
t('⑦e 旧版只数 hits 的实现在本守卫四条关键样本下会报红', legacyRed >= 3, String(legacyRed));

/* ────────────────────────────────────────────────────────────────
 * 反向验证入口：--against <旧版面板文件> 必须报未接线
 * ──────────────────────────────────────────────────────────────── */
const ai = process.argv.indexOf('--against');
if (ai >= 0) {
  const p = process.argv[ai + 1];
  const old = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const rep = wiringReport(old);
  t('⑧ 把生产入口换回旧版必须报未接线', !!old && !rep.ok, rep.misses.join(' / '));
  t('⑧ 旧版红单包含失败信号被吞', rep.misses.some((x) => x.includes('均为最新')), rep.misses.join(' / '));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
