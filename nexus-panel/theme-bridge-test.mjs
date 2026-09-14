/**
 * 主题桥接契约测试（开发用，可删）
 *
 * 背景：设置页是 iframe 插件，有自己的 document。它本地 import 一份
 * theme-manager 去 applyTheme，改的只是 iframe 内的 :root —— 表现为
 * 「设置页自己变了、主面板没变」。修法是让写操作经 ctx.shell.theme
 * 桥接到主平台侧执行。
 *
 * 本测试钉住这条链路两端不漂移：
 *   A. plugin-sdk 里 ctx.shell.theme 引用的每个方法名，都在 host 的
 *      白名单 THEME_API_METHODS 里 —— 否则宿主回"未知方法"，
 *      而调用方只看得到静默失败
 *   B. 白名单里的每个方法在 theme-manager 上真实存在
 *   C. 主平台侧执行确实会改主文档的 :root
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

const { THEME_API_METHODS } = await import('./js/host.js');
const themeManager = await import('./js/theme-manager.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* ---------- A. plugin-sdk 引用的方法 ⊆ host 白名单 ---------- */
const sdkSrc = fs.readFileSync(path.join(HERE, 'js/plugin-sdk.js'), 'utf8');
const start = sdkSrc.indexOf('theme: {');
if (start < 0) {
  t('在 plugin-sdk 中定位到 ctx.shell.theme', false, '未找到 theme 块');
} else {
  // theme 块以 6 空格缩进的 `},` 收尾；external / pluginConfig 块同缩进，
  // 所以取**之后**的第一个即为 theme 块结束。
  const end = sdkSrc.indexOf('\n      },', start);
  const block = sdkSrc.slice(start, end < 0 ? start + 3000 : end);
  const used = [...block.matchAll(/method:\s*'([A-Za-z]+)'/g)].map((m) => m[1]);
  t('解析到 ctx.shell.theme 的桥接方法', used.length >= 15, `${used.length} 个：${used.join(',')}`);

  const notInHost = used.filter((m) => !THEME_API_METHODS.includes(m));
  t('桥接用到的方法都在 host 白名单里', notInHost.length === 0, notInHost.join(',') || '全部命中');
}

/* ---------- B. 白名单 ⊆ theme-manager 实际方法 ---------- */
const missing = THEME_API_METHODS.filter((m) => typeof themeManager[m] !== 'function');
t('白名单方法在 theme-manager 上都存在', missing.length === 0, missing.join(',') || '全部存在');

/* ---------- C. 主平台侧执行改的是主文档 :root ---------- */
const root = document.documentElement;
themeManager.applyTheme('neumorph-dark');
const dark = root.style.getPropertyValue('--bg').trim();
themeManager.applyTheme('neumorph-light');
const light = root.style.getPropertyValue('--bg').trim();
t('主平台侧 applyTheme 改变主文档 :root', !!dark && !!light && dark !== light,
  `dark=${dark} light=${light}`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
