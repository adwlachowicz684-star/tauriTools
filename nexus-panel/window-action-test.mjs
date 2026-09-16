/**
 * 关闭窗口行为回归测试（B13）
 * ------------------------------------------------------------
 * 两件事：
 *   ① 点标题栏 ✕ 是"藏到托盘"（默认）还是"真正退出"，设置里可选
 *   ② 标题栏多一个 ⇲ 按钮，随时直接藏到托盘
 *
 * 纯前端改动，但**没有浏览器可跑**，所以做的是源码级接线检查
 * + 少量可执行的逻辑验证（把 host.js 的纯逻辑段抽出来跑）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

const hostSrc = src('js/host.js');
const sdkSrc = src('js/plugin-sdk.js');
const shellSrc = src('js/shell.js');
const htmlSrc = src('index.html');
const tbSrc = src('src/components/Titlebar.tsx');
const appSrc = src('src/App.tsx');
const setJs = src('plugins/settings/index.js');
const setTsx = src('plugins/settings/App.tsx');
const winCard = src('plugins/settings/WindowCard.tsx');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

console.log('\n=== 1. 宿主持有这个状态（不能由插件各存一份）===');
t('host.js 有 getCloseAction', /export function getCloseAction\(\)/.test(hostSrc));
t('host.js 有 setCloseAction', /export function setCloseAction\(/.test(hostSrc));
t('host.js 有变更订阅', /export function onCloseActionChange\(/.test(hostSrc));
/* 外壳是在**点击时**取值的，所以必须挂到 createHost 返回的对象上，
   否则 shell.js 里 host.getCloseAction() 是 undefined。 */
t('挂到了 createHost 返回对象', /    getCloseAction,\n    setCloseAction,\n    onCloseActionChange,/.test(hostSrc));

console.log('\n=== 2. 默认是「藏到托盘」===');
/* 装了托盘之后 ✕ 还杀进程，就与托盘的存在相矛盾。
   值只认 hide/close 两种，其它（含手改坏的数据）回退 hide ——
   不然按钮会变哑：点下去什么都不发生。 */
t('默认值是 hide', /return localStorage\.getItem\(CLOSE_ACTION_KEY\) === 'close' \? 'close' : 'hide';/.test(hostSrc));
t('读取失败时回退 hide', /catch \{ return 'hide'; \}/.test(hostSrc));
t('写入只接受两种值', /const next = v === 'close' \? 'close' : 'hide';/.test(hostSrc));

console.log('\n=== 3. 改完立即生效（不用重启）===');
t('setCloseAction 会通知订阅者', /for \(const fn of closeActionHooks\)/.test(hostSrc));
t('原生外壳订阅并刷新 ✕ 文案', /host\.onCloseActionChange\(syncCloseBtn\);/.test(shellSrc));
/* ✕ 的点击处理必须**每次现取**，不能挂载时读一次存起来 */
t('✕ 点击时现取（不是挂载时读一次）',
  /\$\('#btn-close'\)\.onclick = \(\) => \{\s*\n\s*const act = host\.getCloseAction\(\);/.test(shellSrc));
t('✕ 文案跟着设置变', /host\.getCloseAction\(\) === 'hide' \? '隐藏到托盘' : '退出'/.test(shellSrc));
t('React 版订阅并更新 state',
  /useEffect\(\(\) => onCloseActionChange\(\(v\) => setCloseAction\(v\)\), \[\]\);/.test(appSrc));

console.log('\n=== 4. 藏起来必须告诉用户怎么回来 ===');
/* 窗口隐藏后收不到键盘事件，托盘是唯一回路。
   不提示的话窗口凭空消失、任务栏也没有，用户只会以为崩了。 */
t('原生版隐藏后提示', /已隐藏到托盘/.test(shellSrc));
t('React 版隐藏后提示', /已隐藏到托盘/.test(appSrc));
t('提示里说明点托盘图标', /点击托盘图标可唤回/.test(shellSrc) && /点击托盘图标可唤回/.test(appSrc));

console.log('\n=== 5. ⇲ 按钮 ===');
t('index.html 有 btn-hide', /id="btn-hide"/.test(htmlSrc));
t('原生外壳接了 btn-hide', /\$\('#btn-hide'\)\.onclick/.test(shellSrc));
t('React 标题栏有 hide 按钮', /onClick=\{\(\) => onWin\('hide'\)\}/.test(tbSrc));
t('React 的 WinAction 类型含 hide', /'topmost' \| 'hide'/.test(tbSrc));

console.log('\n=== 6. 按钮位置：主题 与 最小化 之间 ===');
/* 只取标题栏那一块：页面后面还有 btn-add / btn-settings / btn-inspect
   等侧边栏按钮，在整份 HTML 上取会让"✕ 在最右"这条恒假。
   —— 与 theme-bridge / tray-test 那几次是同一类坑：断言要先切出范围。 */
const tbBlock = htmlSrc.slice(htmlSrc.indexOf('id="titlebar"'), htmlSrc.indexOf('</header>'));
const btns = [...tbBlock.matchAll(/id="(btn-[a-z]+)"/g)].map((m) => m[1]);
const iTheme = btns.indexOf('btn-theme');
const iHide = btns.indexOf('btn-hide');
const iMin = btns.indexOf('btn-min');
t('顺序为 主题 → … → 隐藏 → 最小化', iTheme >= 0 && iHide > iTheme && iMin > iHide,
  btns.join(' → '));
t('✕ 仍在最右（危险操作单独一档）', btns[btns.length - 1] === 'btn-close', btns[btns.length - 1]);

console.log('\n=== 7. 设置页：走桥接而非直接写 localStorage ===');
/* 设置页在 Vite 模式下是 iframe，隔离态（opaque origin）下 localStorage
   不可用 —— 直接写会落空。与主题/适配策略同一类问题。 */
t('宿主暴露 window 命名空间', /: ns === 'window' \? windowApi/.test(hostSrc));
t('sdk 有 ctx.shell.window', /      window: \{[\s\S]{0,200}getCloseAction/.test(sdkSrc));
t('原生设置页调 setCloseAction', /ctx\.shell\.window\.setCloseAction/.test(setJs));
t('原生设置页初值走桥接读', /ctx\.shell\.window\.getCloseAction\(\)/.test(setJs));
t('React 设置页同样走桥接',
  /\(ctx as any\)\?\.shell\?\.window/.test(winCard) && /sh\?\.setCloseAction/.test(winCard));
t('两个设置页都没直接写 localStorage 存这个值',
  !/localStorage\.setItem\('nexus:close-action'/.test(setJs)
  && !/localStorage\.setItem\('nexus:close-action'/.test(winCard));

console.log('\n=== 8. 两个技术栈的分栏都加了 ===');
t('原生设置页有 window 分页', /window: h\('div', \{\}\),/.test(setJs));
t('原生设置页有「窗口」标签', /\['window', '窗口'\]/.test(setJs));
t('React 设置页有「窗口」标签', /\['window', '窗口'\]/.test(setTsx));
t('React 的 TabKey 含 window', /'files' \| 'window' \| 'about'/.test(setTsx));
t('React 设置页渲染 WindowCard', /tab === 'window' \? <WindowCard \/>/.test(setTsx));

console.log('\n=== 9. 文案要让用户看懂差别 ===');
t('hide 选项说明"程序还在"', /程序还在/.test(setJs) || /程序还在/.test(winCard));
t('close 选项说明"结束进程"', /真正结束进程|结束进程/.test(setJs) || /结束进程/.test(winCard));
t('说明 ⇲ 与此设置无关', /随时可以直接藏到托盘/.test(setJs) && /随时可以直接藏到托盘/.test(winCard));

console.log('\n=== 10. 结构（用 node --check，权威）===');
/* 不再自己数花括号：JS 里有正则字面量、模板串里的 ${} 等，
   手写扫描器会误判（我这次就得到 host.js=-1、plugin-sdk.js=+2 的假结果）。
   语法正确性交给 node 自己判断。 */
/* 只列纯 JS：.tsx 含类型标注，node --check 解析不了（恒假）。
   TSX 的正确性由 tsc 负责，已单独跑过。 */
for (const f of ['js/host.js', 'js/plugin-sdk.js', 'js/shell.js',
  'plugins/settings/index.js']) {
  let ok = true;
  try { execSync(`node --check ${JSON.stringify(f)}`, { cwd: HERE, stdio: 'pipe' }); }
  catch { ok = false; }
  t(`${f} 语法正确`, ok);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
console.log('注意：只检查接线，**不能**替代真实点击验证（无浏览器）。');
process.exit(fail ? 1 : 0);
