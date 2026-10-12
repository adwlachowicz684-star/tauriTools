/**
 * 外链策略「说了保存其实没保存」测试
 * ============================================================
 * 三类断言：
 *   ① 行为 —— 真跑 js/external-policy.js（把 localStorage 换成会抛错的桩），
 *      验证 savePolicy / setHostStatus / removeHost **如实带回**存没存成。
 *      只做源码断言会放过"返回值根本没带 saved"这类错。
 *   ② 界面 —— 两版设置页（无构建版 index.js / React 版 ExternalCard.tsx）
 *      都必须在**说了「已更新」之前**先看结果。
 *   ③ 一致性 —— 两版行为必须同一套说法，不能一个提示一个不提示。
 *
 * 运行：node external-save-report-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripComments as strip } from './test-scan-utils.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0; let fail = 0;
const t = (name, cond, extra) => {
  if (cond) { pass++; console.log('✅ ' + name); }
  else { fail++; console.log('❌ ' + name + (extra ? ' → ' + extra : '')); }
};
const group = (s) => console.log('\n── ' + s + ' ──');

/** 以锚点为中心取一段窗口（锚点可能被改写，不能锚在待验的写法上） */
function window(src, anchor, before, after) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  return src.slice(Math.max(0, i - before), i + after);
}

/** 取一段：从锚点起、括号配平 */
function sliceAfter(src, anchor, open = '{', close = '}') {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  let d = 0; let started = false;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === open) { d++; started = true; }
    else if (c === close) { d--; if (started && d === 0) return src.slice(i, k + 1); }
  }
  return '';
}

/* ==================== ① 行为：真跑判据 ==================== */

group('① savePolicy 必须如实回答「存没存成」');

const store = new Map();
let throwOnWrite = false;
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => {
    if (throwOnWrite) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    store.set(k, String(v));
  },
  removeItem: (k) => { store.delete(k); },
};
globalThis.dispatchEvent = () => true;

const ext = await import('./js/external-policy.js');

store.clear(); throwOnWrite = false;
t('存储可用时返回 true', ext.savePolicy({ mode: 'smart', hosts: {} }) === true);

throwOnWrite = true;
t('★ 存储写不进去时返回 false（不能静默）', ext.savePolicy({ mode: 'deny-all', hosts: {} }) === false);

const r1 = ext.setHostStatus('a.example.com', 'trusted');
t('★ 写不进去时 setHostStatus 的 saved=false', r1.saved === false, JSON.stringify(r1.saved));
t('setHostStatus 仍带回 policy（调用方要看内容）', !!r1.policy && r1.policy.hosts['a.example.com']?.status === 'trusted');

const r2 = ext.removeHost('a.example.com');
t('★ 写不进去时 removeHost 的 saved=false', r2.saved === false, JSON.stringify(r2.saved));

throwOnWrite = false;
const r3 = ext.setHostStatus('b.example.com', 'blocked');
t('存储可用时 setHostStatus 的 saved=true', r3.saved === true);
t('确实落盘了（能读回来）', ext.loadPolicy().hosts['b.example.com']?.status === 'blocked');
const r4 = ext.removeHost('b.example.com');
t('存储可用时 removeHost 的 saved=true', r4.saved === true);
t('移除确实落盘了', ext.loadPolicy().hosts['b.example.com'] === undefined);

/* ==================== ② 无构建版设置页 ==================== */

group('② 无构建版：说了「已更新」之前必须先看结果');

const idxRaw = read('plugins/settings/index.js');
const idx = strip(idxRaw);

/* 锚在 `ext.savePolicy(` 上而不是 `onchange: (e) => {`：
   本文件里有一大堆 onchange（主题参数页全是），锚通用写法会落到别的段上，
   于是"取到了"恒真、后面几条全在验一段无关的代码。 */
const seg = window(idx, 'ext.savePolicy(', 200, 600);
t('（前置）取到全局策略的保存段', seg.length > 0 && seg.includes('外链策略'), seg.slice(0, 80));
t('★ 保存结果被接住了（有 const … = ext.savePolicy）', /const\s+\w+\s*=\s*ext\.savePolicy\(/.test(seg), seg.slice(0, 120));
t('★ 存不下时不再说「已更新」：真成了才 toast ok',
  /saved\s*===\s*false/.test(seg) && /else\s*\{/.test(seg) && /外链策略已更新/.test(seg)
      // 顺序断言的两端都要先判存在：撤掉修复后左端取 -1，-1 < 任意值 恒真，
      // 这条就会"没修好也通过" —— 顺序类空跑是最会伪装的一类
      && seg.indexOf('saved === false') >= 0 && seg.indexOf('外链策略已更新') >= 0
      && seg.indexOf('saved === false') < seg.indexOf('外链策略已更新'),
  seg.slice(0, 400));

const mk = sliceAfter(idx, 'const mk = (label, status, cls) => h(');
const hostSeg = mk || sliceAfter(idx, 'ext.setHostStatus(x.host, status);');
t('（前置）取到逐条放行 / 禁止的点击段', hostSeg.length > 0, hostSeg.slice(0, 60));
t('★ 逐条设置必须检查 .saved', /\.saved\s*===\s*false/.test(hostSeg), hostSeg.slice(0, 200));
t('★ 存不下时有提示（不能靠"列表没变"暗示）', /toast\(/.test(hostSeg), hostSeg.slice(0, 200));

const rmSeg = sliceAfter(idx, 'ext.removeHost(x.host);');
t('★ 移除也必须检查 .saved', /r\.saved\s*===\s*false/.test(rmSeg), rmSeg.slice(0, 200));

const scanSeg = window(idx, 'rescanAll', 300, 300);
t('（前置）取到「重新检查」段', scanSeg.length > 0 && /重新检查/.test(scanSeg), scanSeg.slice(0, 80));
t('★ 重新检查不再丢掉 Promise（有 .catch）', /\.catch\(/.test(scanSeg), scanSeg.slice(0, 240));
t('★ 失败时要说出来', /重新检查失败/.test(scanSeg), scanSeg.slice(0, 240));

/* ==================== ③ React 版 ==================== */

group('③ React 版：两版必须同一套说法');

const card = strip(read('plugins/settings/ExternalCard.tsx'));

const actSeg = sliceAfter(card, 'const act = async (fn: () => Promise<any>, okMsg?: string) => {');
t('（前置）取到 act 段', actSeg.length > 0, actSeg.slice(0, 60));
t('★ act 不再把异常丢给 onClick（有 try）', /try\s*\{/.test(actSeg), actSeg.slice(0, 120));
t('★ act 失败时有可见反馈（catch 里落 err）', /catch\s*\(/.test(actSeg) && /setErr\(/.test(actSeg), actSeg.slice(0, 400));
t('★ 存不下时不弹成功提示（saved === false 分支在 okMsg 之前）',
  /saved\s*===\s*false/.test(actSeg)
  && actSeg.indexOf('saved === false') >= 0 && actSeg.indexOf('ctx.toast(okMsg') >= 0
  && actSeg.indexOf('saved === false') < actSeg.indexOf('ctx.toast(okMsg'),
  actSeg.slice(0, 400));
t('★ 错误提示排在 refresh 之后（否则会被清掉）',
  actSeg.indexOf('await refresh()') >= 0 && actSeg.indexOf('setErr(msg)') >= 0
  && actSeg.indexOf('await refresh()') < actSeg.lastIndexOf('setErr(msg)'),
  actSeg.slice(0, 400));

t('★ setStatus 包装器带回 saved 判定', /setStatus[\s\S]{0,200}?\.saved\s*!==\s*false/.test(card), '');
t('★ removeHost 包装器带回 saved 判定', /removeHost[\s\S]{0,200}?\.saved\s*!==\s*false/.test(card), '');

t('★ 两版都不许出现"无条件说已更新"', !/savePolicy\([^)]*\)\s*;\s*\n?\s*ctx\.toast\('外链策略已更新'/.test(idx), '');

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exit(1);
console.log('外链策略落盘提示测试全部通过');
