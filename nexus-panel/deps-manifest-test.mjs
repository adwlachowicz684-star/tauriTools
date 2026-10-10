/**
 * 依赖清单 + 设置页「依赖」页签
 * ============================================================
 *
 * 这里守的不是"清单长什么样"，而是**哪几处错了会静默失效**：
 *
 *   · 依赖在 package.json 里、但扫描器说没人用 —— 曾经发生过：
 *     `@tauri-apps/api` 只通过子路径 `@tauri-apps/api/core` 引入，
 *     包名校验不认子路径就把整条 import 丢了，于是它显示成"未被引用"，
 *     进而被当成可以删的依赖。
 *
 *   · @plantuml/core 的精确锁定被改成 ^ —— 1.2026.6 起才是 MIT，
 *     低版本是 GPL-3.0-or-later。npm install 不会有任何提示。
 *
 *   · 共享依赖目录（软链接）没识别出来 —— 满屏假"缺失/版本不符"，
 *     会诱使人去改根本没问题的版本号。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let pass = 0;
const fails = [];
function t(name, cond, detail = '') {
  if (cond) { pass++; return; }
  fails.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

const manifest = await import('./js/deps-manifest.js');
const M = manifest.DEPS_MANIFEST;
const STATUS = manifest.DEP_STATUS;

const pkgText = read('package.json');
const appText = read('plugins/settings/App.tsx');
const cssText = read('css/neumorphism.css');
const scanText = read('scripts/scan-deps.mjs');
const cardText = read('plugins/settings/DepsCard.tsx');

/* ---- 清单自身 ---- */
t('清单导出 DEPS_MANIFEST', !!M);
t('清单导出 DEP_STATUS', !!STATUS && typeof STATUS.ok?.label === 'string');
t('清单带生成时间', !!M.generatedAt, String(M.generatedAt));

const npmNames = (M.npm ?? []).map((d) => d.name);
const undNames = (M.undeclared ?? []).map((d) => d.name);
const crateNames = (M.crates ?? []).map((d) => d.name);

/* 关键包一个都不能从清单里消失：
   它们各自被同步覆盖丢过，丢了的表现是功能退化而不是报错。 */
for (const n of ['react-markdown', 'rehype-slug', 'rehype-highlight', 'remark-gfm', 'mermaid', '@plantuml/core', '@xyflow/react', '@tauri-apps/api']) {
  t(`清单里有 ${n}`, npmNames.includes(n), npmNames.slice(0, 40).join(','));
}

/* ---- 子路径 import 必须被认出来 ---- */
const api = (M.npm ?? []).find((d) => d.name === '@tauri-apps/api');
t('@tauri-apps/api 有人在用（子路径 @tauri-apps/api/core 要认）',
  !!api && api.usedBy.length > 0, `usedBy=${api?.usedBy?.join('|') ?? '空'}`);

const puml = (M.npm ?? []).find((d) => d.name === '@plantuml/core');
t('@plantuml/core 有人在用（viz-global.js?url 的查询串要剥掉）',
  !!puml && puml.usedBy.length > 0, `usedBy=${puml?.usedBy?.join('|') ?? '空'}`);

/* ---- 许可证：必须精确锁定 ---- */
t('@plantuml/core 是精确锁定（不能加 ^）',
  !!puml && puml.pinned === true && !/^[\^~]/.test(String(puml.declared ?? '')),
  `declared=${puml?.declared}`);
t('package.json 里 @plantuml/core 不带 ^',
  /"@plantuml\/core"\s*:\s*"1\.2026\.8"/.test(pkgText));

/* ---- 内置模块不能被当成缺失依赖 ---- */
for (const bad of ['fs', 'path', 'os', 'url']) {
  t(`内置模块 ${bad} 不在清单里`, !npmNames.includes(bad) && !undNames.includes(bad));
}

/* ---- 注释里的举例不能被当成真实 import ---- */
for (const bad of ['x', 'xx']) {
  t(`占位名 ${bad} 不在清单里`, !npmNames.includes(bad) && !undNames.includes(bad));
}

/* ---- 正则 / 字符串字面量里的 from 'x' 不能被当成真实 import ---- */
/*
 * 实例：plugin-admit-test.mjs 里那句 `!/from 'acorn'|from 'esbuild'/…`
 * 让清单凭空多出一条「未声明依赖 acorn」，而全仓**没有任何一行**真的
 * import 过 acorn。照着这条去 npm i acorn，等于给项目加一个永远没人用
 * 的依赖，而且以后谁清理依赖都会以为"还有人在用它"。
 *
 * 两条必须成对：只写下面那条、不写元断言的话，等哪天样本自己删掉了，
 * "清单里没有 acorn" 就变成**恒真** —— 样本没了自然也不会被扫出来。
 * （这里刻意用中文引号写 acorn，免得本文件自己又造出一个假样本。）
 */
const admitText = read('plugin-admit-test.mjs');
t('样本仍在：准入测试里还写着 from ‘acorn’ 的正则（元断言）',
  /from\s+['"]acorn['"]/.test(admitText));
t('正则字面量里的 from ‘acorn’ 不算真实 import',
  !undNames.includes('acorn') && !npmNames.includes('acorn'), undNames.join(','));

/* ---- esbuild：smoke-react 真 import 了，那就必须真声明 ---- */
/* 同一套路：元断言先钉住"样本还在"，否则下面那条是恒真。 */
const smokeText = read('smoke-react.mjs');
t('样本仍在：smoke-react 还在解析 esbuild（元断言）', /esbuild/.test(smokeText));
t('esbuild 已声明在 devDependencies（不是靠 vite 间接带一份）',
  npmNames.includes('esbuild') && /"esbuild"\s*:\s*"\^?[\d.]/.test(pkgText),
  `npm=[${npmNames.join(',')}]`);

/* ---- 共享依赖目录必须识别 ---- */
t('depsDir 取值合法', ['local', 'shared', 'absent'].includes(M.depsDir), String(M.depsDir));
if (M.depsDir !== 'local') {
  /* 不说明原因的话，满屏"未判定"只会被当成页签做坏了 */
  t('共享目录下必须给出说明', !!String(M.dirNote ?? '').trim());
}

/* ---- 状态都要有文案，否则界面上会直接显示状态键名 ---- */
const usedStatuses = new Set([...(M.npm ?? []), ...(M.undeclared ?? []), ...(M.crates ?? [])].map((d) => d.status));
for (const s of usedStatuses) {
  t(`状态 ${s} 有显示文案`, !!STATUS[s]?.label, Object.keys(STATUS).join(','));
}

/* ---- 去重：同一包不能既在 npm 又在 undeclared ---- */
const dup = undNames.filter((n) => npmNames.includes(n));
t('没有重复条目', dup.length === 0, dup.join(','));

/* ---- crate ---- */
for (const c of ['tauri', 'svg2pdf', 'rayon', 'pdfium-render', 'tauri-plugin-updater']) {
  t(`crate ${c} 在清单里`, crateNames.includes(c), crateNames.join(','));
}
const keyring = (M.crates ?? []).filter((c) => c.name === 'keyring');
t('keyring 按平台合并成一条（否则显示三遍）', keyring.length === 1, `实际 ${keyring.length} 条`);

/* ---- 扫描脚本 ---- */
t('package.json 有 deps:scan', /"deps:scan"\s*:\s*"node scripts\/scan-deps\.mjs"/.test(pkgText));
t('package.json 有 deps:check', /"deps:check"/.test(pkgText));
t('扫描器认子路径', /(\/[a-z0-9._~-]+)\*\$\/i/.test(scanText) || /VALID_NAME/.test(scanText));
t('扫描器会剥注释', /stripComments/.test(scanText));
t('扫描器跳过生成文件自身', /SELF/.test(scanText) && /rel === SELF/.test(scanText));

/* ---- 设置页接线：三个地方少一处都是"点了没反应" ---- */
t('TabKey 含 deps', /'deps'/.test(appText));
t("TABS 含 ['deps', '依赖']", /\['deps', '依赖'\]/.test(appText));
t('App 引入 DepsCard', /import DepsCard from '\.\/DepsCard'/.test(appText));
t('App 渲染 deps 页签', /tab === 'deps' \? <DepsCard/.test(appText));
t('DepsCard 读的是清单而不是运行时读文件',
  /deps-manifest\.js/.test(cardText) && !/fpx_read_file/.test(cardText) && !/readFileSync/.test(cardText),
  '运行时读 package.json 在打包产物里读不到，只会得到空列表');

/* ---- 样式必须进主样式表 ---- */
/*
 * 用 `includes('.' + c)` 是**假绿**：`.dep-installed-x {` 也含 `.dep-installed`
 * 这个子串，于是样式真被改名成另一个类照样报"有"。
 * 必须要求类名后面紧跟 空白 / { / , —— 即"它真的被当成选择器写了规则"。
 */
for (const c of ['dep-filters', 'dep-chip', 'dep-badge', 'dep-meta', 'dep-cmd', 'dep-tag', 'dep-note', 'dep-name', 'dep-item', 'dep-installed', 'dep-inst-row', 'dep-inst-ver']) {
  t(`主样式表有 .${c}`, new RegExp(`\\.${c}[\\s,{]`).test(cssText));
}
t('安装命令可手动选中（body 的 user-select 是 none）', /\.dep-cmd[\s\S]{0,400}user-select:\s*text/.test(cssText));

/* ---- 复制走共用实现，不各写一份 ---- */
t('DepsCard 用 js/clipboard.js', /js\/clipboard\.js/.test(cardText));
t('md 的 clipboard 改为复用共用实现', /js\/clipboard\.js/.test(read('plugins/md/clipboard.js')));
t('设置页白名单含 fpx_copy_text', /settings:[\s\S]{0,200}fpx_copy_text/.test(read('js/invoke-policy.js')));

console.log(`\n依赖清单：${pass} 通过 / ${fails.length} 失败`);
for (const f of fails) console.log('  ✗ ' + f);
process.exit(fails.length ? 1 : 0);
