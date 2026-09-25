/**
 * 插件自选主题回归测试（开发用，可删）
 *
 * 覆盖本次需求：插件各选一套深色 / 浅色主题，之后
 *   · 只跟随整体主题的**深浅**在自己这两套之间切换
 *   · 不跟随用户在同基调里换哪套主题
 *
 * 另外钉住两个已修的坑：
 *   1. 基调不匹配的配置不能生效（浅色面板上不能冒出深色主题）
 *   2. 主题适配用的基调要取插件自己的，否则滤镜会加反
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
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

const tm = await import('./js/theme-manager.js');
const { setPluginConfig, getPluginConfig, DEFAULTS } = await import('./js/plugin-config.js');
const host = await import('./js/host.js');

/* 找两个不同基调的预设主题做样本 */
const all = tm.listThemes();
const darkA = all.find((x) => x.base === 'dark');
const darkB = all.filter((x) => x.base === 'dark').find((x) => x.id !== darkA.id);
const lightA = all.find((x) => x.base === 'light');
const lightB = all.filter((x) => x.base === 'light').find((x) => x.id !== lightA.id);
t('取到样本主题（深2 浅2）', !!(darkA && darkB && lightA && lightB),
  [darkA?.id, darkB?.id, lightA?.id, lightB?.id].join(' / '));

const PID = 'probe-plugin';

/* ---------- 1. 配置默认值 ---------- */
console.log('\n=== 1. 配置 ===');
t('DEFAULTS 含 themeDark / themeLight', 'themeDark' in DEFAULTS && 'themeLight' in DEFAULTS);
t('默认为 null（跟随全局）', DEFAULTS.themeDark === null && DEFAULTS.themeLight === null);

/* ---------- 2. 未配置时跟随全局 ---------- */
console.log('\n=== 2. 未配置 → 跟随全局 ===');
localStorage.clear();
tm.applyTheme(darkA.id);
t('全局深色时未配置 → resolvePluginTheme 为 null', host.resolvePluginTheme(PID) === null);
t('varsForPlugin 等同全局',
  JSON.stringify(host.varsForPlugin(PID)) === JSON.stringify(tm.exportVars()));

/* ---------- 3. 只跟随深浅，不跟随同基调换主题 ---------- */
console.log('\n=== 3. 只跟随深浅 ===');
setPluginConfig(PID, { themeDark: darkA.id, themeLight: lightA.id });

// 3a. 全局在深色系列里换主题 → 插件不变，仍是 darkA
tm.applyTheme(darkA.id);
const v1 = host.resolvePluginTheme(PID)?.id;
tm.applyTheme(darkB.id);
const v2 = host.resolvePluginTheme(PID)?.id;
t('全局深色内部换主题，插件保持不变', v1 === darkA.id && v2 === darkA.id, `${v1} → ${v2}`);
t('此时全局已是另一套深色，插件仍用自己那套', tm.getThemeId() === darkB.id && v2 === darkA.id);

// 3b. 全局切到浅色 → 插件跟着切到 lightA
tm.applyTheme(lightB.id);
const v3 = host.resolvePluginTheme(PID)?.id;
t('全局切浅色 → 插件切到自己的浅色套', v3 === lightA.id, `${v3}（期望 ${lightA.id}）`);
t('不跟随全局浅色内部选的是哪套', tm.getThemeId() === lightB.id && v3 === lightA.id);

// 3c. 再切回深色
tm.applyTheme(darkB.id);
t('切回深色 → 回到自己的深色套', host.resolvePluginTheme(PID)?.id === darkA.id);

/* ---------- 4. 基调不匹配的配置不能生效 ---------- */
console.log('\n=== 4. 基调不匹配 → 不生效 ===');
setPluginConfig(PID, { themeDark: lightA.id, themeLight: null });  // 深槽误填浅色主题
tm.applyTheme(darkB.id);
t('深槽填了浅色主题 → 深色下不生效（跟随全局）', host.resolvePluginTheme(PID) === null,
  String(host.resolvePluginTheme(PID)?.id));

/* ---------- 5. 只填一个基调 ---------- */
console.log('\n=== 5. 只填一个基调 ===');
setPluginConfig(PID, { themeDark: darkA.id, themeLight: null });
tm.applyTheme(darkB.id);
t('填了深色 → 深色下生效', host.resolvePluginTheme(PID)?.id === darkA.id);
tm.applyTheme(lightB.id);
t('没填浅色 → 浅色下跟随全局', host.resolvePluginTheme(PID) === null);

/* ---------- 7. 变量确实不同（不是空壳） ---------- */
console.log('\n=== 7. 变量内容 ===');
setPluginConfig(PID, { themeDark: darkA.id, themeLight: lightA.id });
tm.applyTheme(darkB.id);
const mine = host.varsForPlugin(PID);
const globalVars = tm.exportVars();
t('插件变量与全局变量确实不同', JSON.stringify(mine) !== JSON.stringify(globalVars),
  `插件 --bg=${mine['--bg']} / 全局 --bg=${globalVars['--bg']}`);
t('插件变量非空且有底色', !!mine['--bg']);
t('插件变量带上了用户强调色（不因自选主题而丢）',
  tm.getAccent() ? mine['--accent'] === tm.getAccent() : true);

/* ---------- 8. 改配置即生效（不必重载） ---------- */
console.log('\n=== 8. 即时生效 ===');
const hostSrc2 = src('js/host.js');
t('host 订阅了插件配置变更', /pluginConfig\.onPluginConfigChange\?\.\(/.test(hostSrc2));
t('订阅里只对**当前活跃插件**生效', /inst\.manifest\?\.id !== id\) return;/.test(hostSrc2));
t('同步逻辑抽成了函数（主题变化与配置变化共用）',
  /async function syncThemeToInstance\(inst\)/.test(hostSrc2));
t('onThemeChange 也走同一个函数',
  /onThemeChange\(\(\) => syncThemeToInstance\(state\.instance\)\)/.test(hostSrc2));
t('推送两条路都覆盖（iframe 推消息 / module 重写内联变量）',
  /await pushTheme\(inst\.iframe, inst\.manifest\?\.id\)/.test(hostSrc2)
  && /applyThemeVarsTo\(inst\.root, varsForPlugin\(inst\.manifest\?\.id\)\)/.test(hostSrc2));

/* 文案：主题改动不应再提示"重载" */
const shellSrc = src('js/shell.js');
const sb = shellSrc.slice(shellSrc.indexOf('插件自选主题'));
t('主题下拉的提示不再要求重载',
  /setPluginConfig\(manifest\.id, \{ \[key\]: sel\.value \|\| null \}\);[\s\S]{0,220}?toast\('已保存', 'ok'\)/.test(sb));
t('沙箱开关仍保留重载提示（isolated 确实要重载）',
  /toast\('已保存，重载插件后生效', 'ok'\)/.test(shellSrc));
t('React 版说明标注立即生效', /立即生效/.test(src('src/components/SandboxSection.tsx')));

/* ---------- 8. 源码级：调用点确实接上了 ---------- */
console.log('\n=== 8. 调用点接线 ===');
const hostSrc = src('js/host.js');
t('init 消息用 varsForPlugin', /type: 'init', manifest, theme: varsForPlugin\(manifest\.id\)/.test(hostSrc));
t('pushTheme 用 varsForPlugin', /send\(iframe, \{ type: 'theme', theme: varsForPlugin\(pluginId\) \}\)/.test(hostSrc));
t('module 容器应用了内联变量', /applyThemeVarsTo\(container, varsForPlugin\(manifest\.id\)\)/.test(hostSrc));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
