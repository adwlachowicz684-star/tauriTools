#!/usr/bin/env node
/**
 * 阶段 0 加载侧 · 真机运行时守卫
 * ============================================================================
 *
 * 为什么单独做这个守卫
 * ------------------------------------------------------------
 * 第 50 轮把两个 blocker 都标成 pending-real-device，台账 note 里写着
 * 「CSP 资产重定向」和「installed-plugins/ → 侧边栏」一起等真机。实测
 * 拆开：CSP 域名是确定性配置缺口（资产 302 真实落点是
 * release-assets.githubusercontent.com，不是台账沿用 50 轮的
 * objects.githubusercontent.com），配置已修；真正只剩 asset 协议下
 * ES module / iframe 同源那三项必须真机判。
 *
 * 于是本守卫钉住三件事，防止「改完配置又悄悄退回含糊态」：
 *   ① 台账状态不被自查自封（仍 wired / runtimeVerified=false，
 *      csp-asset=resolved-in-code，runtime-load=pending-real-device）
 *   ② tauri.conf.json 的 CSP 补的是**实测域名**，且没把原有指令弄丢；
 *      assetProtocol.scope 仍含 $APPDATA/**（阶段 0 的配置前提）
 *   ③ 生产入口不再留「未来接联网」这类与实现不符的注释；真机探针
 *      判据只有一份，devtools 片段里不许长出第二份判定逻辑
 *
 * 元断言直接 import 探针的 evaluate()/runDeviceProbe() 喂真输入，
 * 不是拿正则去猜判据长什么样 —— 判据恒真 / 空集合恒真 / 缺项冒充通过
 * 这三类假绿必须当场喊出来。
 *
 * 第 57 轮新增 ⑥ 节：抓两个会让「真机白跑一次」的缺陷
 *   · evaluate() 原来只认 ok === false，非三态值会被当成全通过并
 *     canMarkBound=true —— 自查自封转 bound 的唯一口子。
 *   · devtools 片段查 documentElement.dataset.probeReady，实测 12/12
 *     产物 0 命中；产物真实信号是 nexus-bridge-v1/ready postMessage。
 *     ⑥ 节对真实产物逐份实证，防止判据再锚到臆想约定。
 *
 * 已知边界：纯静态守卫挡不住「把主断言整行删掉或改成 true」，靠每轮
 * 破坏验证兜，不假装能自证。
 *
 * 零外部依赖，按 import.meta.url 定位根，从任意 cwd 可跑。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  evaluate, runDeviceProbe, REQUIRED_CHECKS, DEVTOOLS_SNIPPET,
} from './scripts/probe-real-device-runtime.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)));
const CONF = join(ROOT, 'src-tauri', 'tauri.conf.json');
const DEBT = join(ROOT, 'scripts', 'market-binding-debt.json');
const STORE = join(ROOT, 'plugins', 'store', 'index.js');
const PROBE = join(ROOT, 'scripts', 'probe-real-device-runtime.mjs');
const BUILT = join(ROOT, 'runtime-plugins');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const read = (p) => readFileSync(p, 'utf8');
const conf = JSON.parse(read(CONF));
const debt = JSON.parse(read(DEBT));
const store = read(STORE);
const probe = read(PROBE);
const csp = conf?.app?.security?.csp || '';
const scope = conf?.app?.security?.assetProtocol?.scope || [];
const blocker = (id) => (debt.blockers || []).find((b) => b.id === id) || {};

/* ---------------- ① 台账状态：不许自查自封 ---------------- */
t('①a status 仍为 wired（不是 bound）', debt.status === 'wired', `status=${debt.status}`);
t('①b runtimeVerified 仍为 false', debt.runtimeVerified === false);
t('①c csp-asset 已按需修正为 resolved-in-code', blocker('csp-asset').status === 'resolved-in-code',
  `status=${blocker('csp-asset').status}`);
t('①d runtime-load 仍为 pending-real-device', blocker('runtime-load').status === 'pending-real-device');
const realDomain = JSON.stringify(debt);
t('①e 台账记有实测 302 域名 release-assets.githubusercontent.com',
  realDomain.includes('release-assets.githubusercontent.com'));
t('①f 台账不再把 objects.githubusercontent.com 当作待补域名',
  !/objects\.githubusercontent\.com[^\n]{0,80}(放行|补入|待补|connect-src)/.test(realDomain));

/* ---------------- ② CSP：补实测域名，不弄丢既有指令 ---------------- */
const connect = (csp.match(/connect-src\s+([^;]*);/) || [])[1] || '';
t('②a connect-src 含 api.github.com（原有，不能弄丢）', connect.includes('https://api.github.com'));
t('②b connect-src 含 github.com（browser_download_url 回退起点）', connect.includes('https://github.com'));
t('②c connect-src 含 *.githubusercontent.com（覆盖实测 302 CDN 及子域漂移）',
  connect.includes('https://*.githubusercontent.com'));
t('②d connect-src 仍含 self / ipc:', connect.includes("'self'") && connect.includes('ipc:'));
t('②e 只放行通配 CDN，不是照旧台账补错的具体域名',
  !connect.includes('https://objects.githubusercontent.com'));
for (const dir of ['script-src', 'style-src', 'img-src', 'media-src', 'frame-src']) {
  /* frame-src 是 csp 最后一段、结尾没有分号；强制 `;` 会把它误判成丢失。 */
  const seg = (csp.match(new RegExp(dir + '\\s+([^;]*)')) || [])[1] || '';
  t(`②f ${dir} 未丢`, seg.length > 0);
}
t('②g asset 协议仍启用', conf?.app?.security?.assetProtocol?.enable === true);
t('②h asset scope 仍含 $APPDATA/**（阶段 0 配置前提）', scope.includes('$APPDATA/**'));
t('②i asset scope 仍含 $RESOURCE/**（内置 runtime 插件）', scope.includes('$RESOURCE/**'));
t('②j script-src / frame-src 仍放行 asset:',
  /script-src[^;]*asset:/.test(csp) && /frame-src[^;]*asset:/.test(csp));

/* ---------------- ③ 生产入口注释不撒谎 ---------------- */
t('③a 商店面板不再写「未来接联网安装与卸载」', !/未来接联网安装与卸载/.test(store));
t('③b 添加插件区不再写「未来这里会接联网商店」', !/未来这里会接联网商店/.test(store));
t('③c 面板仍真有联网安装卡片与三个动作',
  /联网安装/.test(store) && /market\.checkUpdates\(/.test(store)
  && /market\.install\(/.test(store) && /market\.uninstall\(/.test(store));

/* ---------------- ④ 探针：判据只有一份、不内嵌凭据 ---------------- */
t('④a 探针导出 evaluate / runDeviceProbe / DEVTOOLS_SNIPPET',
  /export function evaluate/.test(probe) && /export async function runDeviceProbe/.test(probe)
  && /export const DEVTOOLS_SNIPPET/.test(probe));
t('④b devtools 片段不含判定逻辑（防第二份判据）',
  !/evaluate|nextAction|canMarkBound|conclusion/.test(DEVTOOLS_SNIPPET));
t('④c devtools 片段采集项与 REQUIRED_CHECKS 完全一致',
  REQUIRED_CHECKS.every((id) => DEVTOOLS_SNIPPET.includes(`'${id}'`)));
t('④d 探针不含凭据字面量', !/github_pat_|ghp_[A-Za-z0-9]{20}|Bearer\s+[A-Za-z0-9_]{20}/.test(probe));
t('④e 探针显式标注不进 CI', /不进 CI|不登记 npm script/.test(probe));

/* ---------------- ⑤ 元断言：真判据不是恒真 / 空集合不冒充通过 ---------------- */
const allOk = REQUIRED_CHECKS.map((id) => ({ id, ok: true }));
const ev = (arr) => evaluate(arr);
t('⑤a 五项全通过 → wire-frameBase 且 canMarkBound=true',
  ev(allOk).nextAction === 'wire-frameBase' && ev(allOk).canMarkBound === true);
t('⑤b appDataHtml=false → backend-proxy-or-copy-to-dist',
  ev(allOk.map((c) => c.id === 'appDataHtml' ? { ...c, ok: false } : c)).nextAction === 'backend-proxy-or-copy-to-dist');
t('⑤c moduleScript=false → srcdoc-or-inline-bundle',
  ev(allOk.map((c) => c.id === 'moduleScript' ? { ...c, ok: false } : c)).nextAction === 'srcdoc-or-inline-bundle');
t('⑤d contentDocument=false → bridge-fallback',
  ev(allOk.map((c) => c.id === 'contentDocument' ? { ...c, ok: false } : c)).nextAction === 'bridge-fallback');
t('⑤e csp302=false → fix-csp',
  ev(allOk.map((c) => c.id === 'csp302' ? { ...c, ok: false } : c)).nextAction === 'fix-csp');
t('⑤f 有一项 ok=null → inconclusive 且 canMarkBound=false',
  (() => { const r = ev(allOk.map((c) => c.id === 'moduleScript' ? { ...c, ok: null } : c)); return r.conclusion === 'inconclusive' && r.canMarkBound === false; })());
t('⑤g 空数组 → inconclusive（fail-closed，不恒真）',
  (() => { const r = ev([]); return r.conclusion === 'inconclusive' && r.canMarkBound === false; })());
t('⑤h 缺采集项 → inconclusive',
  (() => { const r = ev(allOk.slice(0, 3)); return r.conclusion === 'inconclusive'; })());
const noEnv = await runDeviceProbe({});
t('⑤i 无 Tauri 环境 → cannot-run，不抛异常、不恒真',
  noEnv.canRun === false && noEnv.reason === 'no-tauri-runtime');

/* ---------------- ⑥ 第57轮：值域 fail-closed + 采集信号实证 ---------------- */
const TRI = 'ok === true ? true : ok === false ? false : null';
t('⑥a Node 侧 push 有三态归一化', probe.includes(TRI));
t('⑥b devtools 片段 push 同样有三态归一化（两侧语义一致）', DEVTOOLS_SNIPPET.includes(TRI));
t('⑥c devtools 片段不再引用臆想标记 probeReady', !/probeReady/.test(DEVTOOLS_SNIPPET));
t('⑥d devtools 片段采集 nexus-bridge-v1 / ready',
  /nexus-bridge-v1/.test(DEVTOOLS_SNIPPET) && /'ready'/.test(DEVTOOLS_SNIPPET));
t('⑥e moduleScript 采集依赖 readySeen 与 module 标签，不是常量',
  /push\('moduleScript'[\s\S]{0,200}readySeen/.test(DEVTOOLS_SNIPPET)
  && /push\('moduleScript'[\s\S]{0,200}script\[type=module\]/.test(DEVTOOLS_SNIPPET));

/* 产物实证：判据所依赖的信号必须真的存在于构建产物里，不能靠注释自证。 */
const probeId = 'demo-iframe';
const probeHtml = read(join(BUILT, probeId, 'index.html'));
t('⑥f demo-iframe 产物含 nexus-bridge-v1', probeHtml.includes('nexus-bridge-v1'));
t('⑥g demo-iframe 产物含 type:"ready"', probeHtml.includes('type:"ready"'));
t('⑥h demo-iframe 产物不含 probeReady', !probeHtml.includes('probeReady'));
const builtDirs = readdirSync(BUILT).filter((d) => existsSync(join(BUILT, d, 'index.html')));
const withSignal = builtDirs.filter((d) => {
  const h = read(join(BUILT, d, 'index.html'));
  const hasReady = (s) => s.includes('nexus-bridge-v1') && s.includes('type:"ready"');
  /* 只认实际会被执行的那份脚本：内联 module 查 html 本身；
     外链 module 查 src 指向的那一个 js。早期版本遍历整个 assets/，
     demo-iframe 里一份未被加载的第二份 bundle 含该信号就把
     「html 里的信号被抹掉」洗白了 —— F 向破坏验证只红 1 条才查出。 */
  const modSrc = (h.match(/<script[^>]*type=["']module["'][^>]*\bsrc=["']([^"']+)["']/) || [])[1];
  if (!modSrc) return hasReady(h);
  const jsPath = join(BUILT, d, modSrc.replace(/^\.\//, ''));
  return existsSync(jsPath) && hasReady(read(jsPath));
});
t('⑥i 12 份产物全部实证含 ready 信号（含外链 bundle）',
  builtDirs.length === 12 && withSignal.length === builtDirs.length,
  `${withSignal.length}/${builtDirs.length}`);

/* 值域：非三态值既不进 unknown 也不进 failed，旧判据会当成全通过。 */
const withOk = (v) => ev(allOk.map((c) => c.id === 'moduleScript' ? { ...c, ok: v } : c));
for (const [label, v] of [['undefined', undefined], ['字符串false', 'false'], ['数字0', 0], ['字符串true', 'true'], ['空串', '']]) {
  const r = withOk(v);
  t(`⑥j ${label} → inconclusive 且 canMarkBound=false`,
    r.conclusion === 'inconclusive' && r.canMarkBound === false);
  t(`⑥k ${label} 点名到具体 id moduleScript`, r.reasons.some((x) => x.includes('moduleScript')));
}
const dupArr = [...allOk, { id: 'moduleScript', ok: true }];
t('⑥l 重复 id → inconclusive（防 false 被后写 true 洗掉）', ev(dupArr).conclusion === 'inconclusive');
t('⑥m 重复 id 点名', ev(dupArr).reasons.some((x) => x.includes('重复')));
t('⑥n 合法三态全 true 仍可标 bound（没有修过头）', ev(allOk).canMarkBound === true);

/* 沙盒可模拟部分穷尽：mock env 走完整采集链，真机只剩「提供真实 env」。 */
const gzipBuf = new Uint8Array([0x1f, 0x8b, 8, 0]).buffer;
const mkFetch = async () => ({ status: 200, text: async () => '<!doctype html><html></html>', arrayBuffer: async () => gzipBuf });
const mockEnv = {
  tauri: {}, convertFileSrc: () => 'asset://probe', appDataDir: '/appdata',
  joinPath: (...p) => p.join('/'), fetch: mkFetch,
  assetApiUrl: 'https://api.github.com/assets/1', headers: {},
  probeIframe: async () => ({ moduleScript: true, contentDocument: true, note: 'mock' }),
};
const mockRun = await runDeviceProbe(mockEnv);
t('⑥o mock 环境下采集链跑通（canRun=true）', mockRun.canRun === true);
t('⑥p mock 产出恰好 5 项', mockRun.checks.length === 5);
t('⑥q mock 五项均 ok=true', mockRun.checks.every((c) => c.ok === true));
t('⑥r mock 全通 → wire-frameBase / canMarkBound=true',
  mockRun.evaluated.nextAction === 'wire-frameBase' && mockRun.evaluated.canMarkBound === true);
const mockBad = await runDeviceProbe({ ...mockEnv, probeIframe: async () => ({ moduleScript: undefined, contentDocument: true }) });
t('⑥s mock 返回非三态 → 归一化为 null 且不标 bound',
  mockBad.checks.find((c) => c.id === 'moduleScript').ok === null && mockBad.evaluated.canMarkBound === false);

/* ---------------- 汇总 ---------------- */
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exit(1);
