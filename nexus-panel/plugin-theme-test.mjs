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
  /await pushTheme\(inst\.iframe,\s*inst\.manifest\?\.id\)/.test(hostSrc2)
  && /applyThemeVarsTo\(inst\.root,\s*varsForPlugin\(inst\.manifest\?\.id\)/.test(hostSrc2));

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
t('pushTheme 用 varsForPlugin', /send\(iframe, \{ type: 'theme', theme: varsForPlugin\(pluginId\)/.test(hostSrc));
t('module 容器应用了内联变量', /applyThemeVarsTo\(container,\s*varsForPlugin\(manifest\.id\)/.test(hostSrc));


/* ---------- 9. 目标主题被改基调 → 按**实际**基调判 ---------- */
console.log('\n=== 9. 目标主题改基调后 ===');
/*
 * 基调本身也是参数：用户可以把任何一套主题改成浅色或深色。
 * 若校验只看 t.base 自带值，X 被改成浅色后仍算"深色主题"，
 * 深槽里的 X 会通过校验 → 插件拿到实际为浅色的变量，
 * 深色面板上突然冒出一块浅色。
 *
 * 与 getResolvedBase（管"当前"基调）是同一处根因的两半。
 */
tm.setBaseOverride('light', darkA.id);
tm.applyTheme(darkB.id);
t('深槽里的主题被改成浅色 → 深色下不再生效',
  host.resolvePluginTheme(PID) === null,
  String(host.resolvePluginTheme(PID)?.id));
t('此时插件基调回退为全局（深色）', host.pluginThemeBase(PID) === 'dark',
  host.pluginThemeBase(PID));

tm.setBaseOverride(null, darkA.id);   // 还原
tm.setBaseOverride('light', lightA.id);   // 浅槽那套改成浅色（本来就是，验幂等）
tm.applyTheme(lightB.id);
t('浅槽主题基调未改 → 浅色下正常生效',
  host.resolvePluginTheme(PID)?.id === lightA.id,
  String(host.resolvePluginTheme(PID)?.id));
t('pluginThemeBase 取的是实际基调', host.pluginThemeBase(PID) === 'light',
  host.pluginThemeBase(PID));

/* 把浅槽那套改成深色 → 浅色下应失效 */
tm.setBaseOverride('dark', lightA.id);
tm.applyTheme(lightB.id);
t('浅槽里的主题被改成深色 → 浅色下不再生效',
  host.resolvePluginTheme(PID) === null,
  String(host.resolvePluginTheme(PID)?.id));
tm.setBaseOverride(null, lightA.id);

/*
 * ⚠️ 这个场景是上面几条的**补集**，专门用来验证 pluginThemeBase：
 * 浅槽填一套"自带深色、但被改成浅色"的主题。此时校验能过
 * （实际基调 === 全局浅色），但 t.base 原始值仍是 'dark' ——
 * 只有到了这一步，pluginThemeBase 取原始值还是取实际值才有区别。
 *
 * 第一版我漏了这个场景，破坏验证（把 resolveThemeMeta 改回 t.base）
 * 跑出来是全绿的 —— 变异体有效、测试却抓不到，等于这条断言白写。
 */
setPluginConfig(PID, { themeDark: null, themeLight: darkA.id });
tm.setBaseOverride('light', darkA.id);
tm.applyTheme(lightB.id);
t('浅槽填"自带深、被改浅"的主题 → 仍生效（实际基调匹配）',
  host.resolvePluginTheme(PID)?.id === darkA.id,
  String(host.resolvePluginTheme(PID)?.id));
t('pluginThemeBase 回**实际**基调而非自带值',
  host.pluginThemeBase(PID) === 'light',
  `返回 ${host.pluginThemeBase(PID)}，自带值是 dark`);
tm.setBaseOverride(null, darkA.id);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
