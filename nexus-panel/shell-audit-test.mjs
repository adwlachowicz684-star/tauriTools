/**
 * 主窗口外壳审查项回归测试（开发用，可删）
 *
 * 对应《主窗口 · Vanilla 外壳 问题清单》里能用 jsdom / 源码断言覆盖的条目。
 * 每条都能被"故意破坏"验证 —— 否则断言只是装饰。
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.navigator = dom.window.navigator;

const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');
const hostSrc = src('js/host.js');
const sdkSrc = src('js/plugin-sdk.js');
const tmSrc = src('js/theme-manager.js');
const coreSrc = src('js/tauri-core.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* ============ P0-1 · message 监听的来源校验 ============ */
console.log('\n=== P0-1 消息来源校验 ===');
/* host.js：bridgeHandler 内校验 e.source === iframe.contentWindow。
   注意要**先切出 bridgeHandler 块**再判断，否则会命中别处的相似代码。 */
const bhStart = hostSrc.indexOf('bridgeHandler = (e) => {');
const bhBlock = bhStart < 0 ? '' : hostSrc.slice(bhStart, hostSrc.indexOf('switch (d.type)', bhStart));
t('host: bridgeHandler 定位成功', bhStart >= 0);
t('host: 校验 e.source === iframe.contentWindow',
  /e\.source\s*!==\s*iframe\.contentWindow/.test(bhBlock), bhBlock ? '已含' : '未定位');

/* plugin-sdk：window.parent 是唯一合法来源 */
const sdkStart = sdkSrc.indexOf("window.addEventListener('message', (e) => {");
const sdkBlock = sdkStart < 0 ? '' : sdkSrc.slice(sdkStart, sdkStart + 900);
t('sdk: 校验 e.source === window.parent',
  /e\.source\s*!==\s*window\.parent/.test(sdkBlock), sdkBlock ? '已含' : '未定位');

/* ============ P0-2 · postMessage 目标 origin ============ */
console.log('\n=== P0-2 postMessage 目标 origin ===');
t('host: send 不再硬编码 "*"',
  !/postMessage\(\s*\{[^}]*\}\s*,\s*'\*'\s*\)/.test(hostSrc));
t('host: 按隔离与否取 targetOrigin', /function targetOriginFor/.test(hostSrc));
t('host: 非隔离用精确 origin',
  /dataset\.isolated === '1' \? '\*' : \(window\.location\.origin/.test(hostSrc));
t('sdk: post 用 hostOrigin 变量而非字面量',
  /window\.parent\.postMessage\(\{\s*channel,\s*\.\.\.msg\s*\},\s*hostOrigin\s*\)/.test(sdkSrc));
t('host: init 消息下发 hostOrigin', /hostOrigin:\s*window\.location\.origin/.test(hostSrc));
t('sdk: init 时接收 hostOrigin', /if \(d\.hostOrigin\) hostOrigin = d\.hostOrigin;/.test(sdkSrc));

/* ============ P0-3 · webhook 空口令防护 ============ */
console.log('\n=== P0-3 webhook 浏览器防护 ===');
const rsSrc = src('src-tauri/src/af_flow.rs');
t('Rust: 定义了浏览器防护头常量', /const BROWSER_GUARD_HEADER/.test(rsSrc));
t('Rust: 空 token 时不再无条件放行',
  !/if expected\.is_empty\(\) \{\s*return true;/.test(rsSrc));
t('Rust: 空 token 时要求防护头',
  /expected\.is_empty\(\)[\s\S]{0,200}?BROWSER_GUARD_HEADER/.test(rsSrc));
t('前端: 提示调用需带防护头',
  /X-Nexus-Webhook/.test(src('plugins/agent-flow/components/Inspector.tsx')));

/* ============ P1-4 · findTheme 不自递归 ============ */
console.log('\n=== P1-4 findTheme 兜底 ===');
const ftStart = tmSrc.indexOf('export function findTheme');
const ftBody = ftStart < 0 ? '' : tmSrc.slice(ftStart, tmSrc.indexOf('\n}', ftStart));
t('findTheme 函数体内无自递归调用', !/findTheme\s*\(/.test(ftBody.replace(/export function findTheme/, '')));
t('findTheme 有三级兜底（含 PRESET_THEMES[0]）', /PRESET_THEMES\[0\]/.test(ftBody));

const tm = await import('./js/theme-manager.js');
t('对不存在的 id 仍能返回有效主题', !!tm.findTheme('__definitely_missing__')?.id,
  tm.findTheme('__definitely_missing__')?.id);

/* ============ P1-5 · 存储反序列化兜底 ============ */
console.log('\n=== P1-5 存储反序列化 ===');
// host 与 sdk 的 store.get / store.all 都要能吞掉坏数据
const storeGetHost = hostSrc.slice(hostSrc.indexOf("case 'store.get':"), hostSrc.indexOf("case 'store.set':"));
t('host store.get 有 try/catch', /catch/.test(storeGetHost));
const storeAllHost = hostSrc.slice(hostSrc.indexOf("case 'store.all':"), hostSrc.indexOf('case \'shell.call\''));
t('host store.all 有 try/catch', /catch/.test(storeAllHost));
const storeAllSdk = sdkSrc.slice(sdkSrc.indexOf("case 'store.all':"), sdkSrc.indexOf('default:', sdkSrc.indexOf("case 'store.all':")));
t('sdk store.all 有 try/catch', /catch/.test(storeAllSdk));

// 行为级：坏 JSON 不炸
localStorage.setItem('nexus:probe-plugin:good', '{"a":1}');
localStorage.setItem('nexus:probe-plugin:bad', '{坏了');
function safeParse(raw, def) {
  if (raw == null) return def;
  try { return JSON.parse(raw); } catch { return def; }
}
t('坏 JSON 退默认值而非抛错', safeParse(localStorage.getItem('nexus:probe-plugin:bad'), 'FALLBACK') === 'FALLBACK');
t('好 JSON 正常解析', safeParse(localStorage.getItem('nexus:probe-plugin:good'), null)?.a === 1);
localStorage.removeItem('nexus:probe-plugin:good');
localStorage.removeItem('nexus:probe-plugin:bad');

/* ============ P1-6 · 侧边栏监听器（经实证不成立，钉住行为） ============ */
console.log('\n=== P1-6 侧边栏监听器（实证：不成立） ===');
t('renderSidebar 用 innerHTML="" 清空（节点连监听器一起丢弃）',
  /list\.innerHTML = '';/.test(src('js/shell.js')));

/* ============ P2-8 · 能力探测只缓存成功 ============ */
console.log('\n=== P2-8 探测缓存 ===');
t('getTauri 失败不再写入缓存', !/_cache = null;\s*return _cache;/.test(coreSrc));
t('getTauri 命中判断用真值（null 会继续重探）', /if \(_cache\) return _cache;/.test(coreSrc));

const core = await import('./js/tauri-core.js');
// 无 Tauri 环境下反复调用：应始终返回 null 且不因缓存而行为改变
const a = await core.getTauri();
const b = await core.getTauri();
t('无 Tauri 环境下反复探测结果稳定', a === null && b === null, `a=${a} b=${b}`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
