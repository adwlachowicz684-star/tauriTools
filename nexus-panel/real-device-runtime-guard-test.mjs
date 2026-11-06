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
 * 第 58 轮新增 ⑦ 节：32 种 true/false 组合穷举、tauri 元前提优先、
 * 多项失败列全，以及 nextAction 落点实证 —— 旧的全通过指令指向一个
 * 生产 js/ 下 0 命中的概念，真机跑完仍不知道改哪一行。
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
import { stripCommentsJs } from './test-scan-utils.mjs';

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
t('⑤a 五项全通过 → wire-installed-frame-src 且 canMarkBound=true',
  ev(allOk).nextAction === 'wire-installed-frame-src' && ev(allOk).canMarkBound === true);
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
t('⑥r mock 全通 → wire-installed-frame-src / canMarkBound=true',
  mockRun.evaluated.nextAction === 'wire-installed-frame-src' && mockRun.evaluated.canMarkBound === true);
const mockBad = await runDeviceProbe({ ...mockEnv, probeIframe: async () => ({ moduleScript: undefined, contentDocument: true }) });
t('⑥s mock 返回非三态 → 归一化为 null 且不标 bound',
  mockBad.checks.find((c) => c.id === 'moduleScript').ok === null && mockBad.evaluated.canMarkBound === false);

/* ---------------- ⑦ 第58轮：分支完备性 + nextAction 落点实证 ----------------
   真机贴回 JSON 后拿的是 nextAction，不是「红几条」。指令若指向生产代码里
   不存在的概念、或把 tauri 元前提排后面、或多项失败只报第一条，用户会
   白改一轮甚至改坏产品。这里穷举组合并对落点逐条取证。 */
const ALL_FALSE = REQUIRED_CHECKS.map((id) => ({ id, ok: false }));
const combos = [];
for (let mask = 0; mask < (1 << REQUIRED_CHECKS.length); mask++) {
  combos.push(REQUIRED_CHECKS.map((id, i) => ({ id, ok: !(mask & (1 << i)) })));
}
t('⑦a 32 种 true/false 组合：只有全 true 可标 bound',
  combos.every((c) => ev(c).canMarkBound === c.every((x) => x.ok === true)), `${combos.length} 组合`);
t('⑦b 32 种组合的 nextAction 均非空',
  combos.every((c) => typeof ev(c).nextAction === 'string' && ev(c).nextAction.length > 0));
t('⑦c 五项全 false → no-tauri-runtime（元前提优先，不给改产品代码的指令）',
  ev(ALL_FALSE).nextAction === 'no-tauri-runtime', ev(ALL_FALSE).nextAction);
t('⑦d tauri=false 与任意另一项 false 并存时仍判 no-tauri-runtime',
  REQUIRED_CHECKS.filter((id) => id !== 'tauri').every((id) => {
    const c = REQUIRED_CHECKS.map((x) => ({ id: x, ok: !(x === 'tauri' || x === id) }));
    return ev(c).nextAction === 'no-tauri-runtime';
  }));
t('⑦e 多项失败 reasons 列全（不静默丢其余失败项）',
  (() => { const r = ev(REQUIRED_CHECKS.map((x) => ({ id: x, ok: x === 'tauri' })));
    const s = r.reasons.join(' | ');
    return r.nextAction === 'backend-proxy-or-copy-to-dist' && /moduleScript/.test(s) && /csp302/.test(s) && /其余失败项/.test(s); })());
t('⑦f 单项失败不产生「其余失败项」噪声',
  !ev(allOk.map((c) => c.id === 'csp302' ? { ...c, ok: false } : c)).reasons.join('').includes('其余失败项'));

/* 落点实证：每条指令文案里的锚点必须真的存在于它点名的生产文件里。
   只查「字符串在仓里出现过」会假绿 —— 旧指令名曾在探针/守卫/台账里
   出现 3 次，生产 js/ 下 0 次。 */
const LANDINGS = [
  ['wire-installed-frame-src', 'js/host.js', ['resolveFrameSrc', 'manifest.installed === true']],
  ['no-tauri-runtime', 'scripts/probe-real-device-runtime.mjs', ['no-tauri-runtime']],
  ['backend-proxy-or-copy-to-dist', 'js/installed-registry.js', ['installedEntry']],
  ['srcdoc-or-inline-bundle', 'js/host.js', ['resolveFrameSrc', 'manifest.installed === true']],
  ['bridge-fallback', 'js/host.js', ['e.source']],
  ['fix-csp', 'src-tauri/tauri.conf.json', ['connect-src']],
];
const ACTION_TO_CHECK = {
  'no-tauri-runtime':'tauri','backend-proxy-or-copy-to-dist':'appDataHtml',
  'srcdoc-or-inline-bundle':'moduleScript','bridge-fallback':'contentDocument','fix-csp':'csp302'};
/* 第 210 轮：落点实证必须看**实现**，不能看全文。
   全文 includes 会被注释喂饱 —— srcdoc 只出现在 js/host.js 的
   resolveFrameSrc 方案注释里，实现 0 命中，而 85 项全绿。
   剥注释走公共设施 stripCommentsJs，不新增内联副本（inline-strip-audit 会报）。 */
const landingOk = (txt, needles) => {
  const code = stripCommentsJs(String(txt || ''));
  return code.length > 0 && needles.every((n) => code.includes(n));
};
for (const [action, rel, needles] of LANDINGS) {
  const txt = existsSync(join(ROOT, rel)) ? read(join(ROOT, rel)) : '';
  t(`⑦g ${action} 落点文件 ${rel} 存在且锚点齐（剥注释后）`,
    landingOk(txt, needles), needles.join(','));
  const r = action === 'wire-installed-frame-src' ? ev(allOk)
    : ev(REQUIRED_CHECKS.map((x) => ({ id: x, ok: x !== ACTION_TO_CHECK[action] })));
  t(`⑦h ${action} 的 reason 点名该落点文件`,
    r.nextAction === action && r.reasons.some((x) => x.includes(rel)), r.nextAction);
}
t('⑦i 探针不再出现臆想概念 frameBase（生产 js/ 下 0 命中）', !/frameBase/.test(probe));
t('⑦j 生产 js/ 下确实没有 frameBase（反证不是拿自证当实证）',
  !readdirSync(join(ROOT, 'js')).some((f) => /\.(js|mjs)$/.test(f) && read(join(ROOT, 'js', f)).includes('frameBase')));
const debtUnblock = JSON.stringify(debt.unblock || []);
t('⑦k 台账 unblock 的 action 清单与 6 个分支一致（台账不撒谎）',
  LANDINGS.every(([a]) => debtUnblock.includes(a)) && !debtUnblock.includes('wire-frameBase'));

/* 第 210 轮：⑦g 改剥注释后，判据自身也要被验 —— 否则「改成全文 includes」
   或「改成恒假」都不会被 ⑦g 自己发现。 */
const commentOnly = '/* resolveFrameSrc manifest.installed === true */\nexport const x = 1;\n';
t('⑦l 只有注释含锚点时 landingOk 必须判 false（防注释喂饱）',
  landingOk(commentOnly, ['resolveFrameSrc']) === false);
t('⑦m 真实实现含锚点时 landingOk 必须判 true（防改恒假）',
  landingOk('export async function resolveFrameSrc(m) {}\n', ['resolveFrameSrc']) === true);
const srcdocReason = ev(allOk.map((c) => c.id === 'moduleScript' ? { ...c, ok: false } : c)).reasons.join(' | ');
t('⑦n moduleScript 分支 reason 点名真实落点 resolveFrameSrc 且说明 srcdoc 非现成实现',
  srcdocReason.includes('resolveFrameSrc') && srcdocReason.includes('js/host.js')
  && srcdocReason.includes('srcdoc') && /注释/.test(srcdocReason));
t('⑦o js/host.js 剥注释后确实没有 srcdoc 实现（反证不是拿注释当落点）',
  !stripCommentsJs(read(join(ROOT, 'js', 'host.js'))).includes('srcdoc'));
const probeNote = String(debt?.realDeviceProbe?.note || '');
t('⑦p 台账 realDeviceProbe.note 记有剥注释落点口径（台账不撒谎）',
  /剥注释/.test(probeNote) && /srcdoc/.test(probeNote));

/* ---------------- 汇总 ---------------- */
console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exit(1);
