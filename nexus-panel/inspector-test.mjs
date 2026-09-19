/**
 * 开发者模式 · 元素检查器回归测试（开发用，可删）
 * ------------------------------------------------------------
 * 覆盖：悬浮高亮、名称生成、iframe 穿透与坐标换算、
 *       隔离降级、点击锁定 + 复制、快捷键、状态持久化。
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const dom = new JSDOM(
  `<!DOCTYPE html><html><body>
     <div id="app">
       <aside id="sidebar"><nav id="plugin-list">
         <button class="nav-item active" id="nav-home">home</button>
       </nav></aside>
       <main id="main"><div id="plugin-bar">
         <button class="bar-btn" id="bar-reload">↻</button>
       </div></main>
     </div>
   </body></html>`,
  { url: 'http://localhost/', pretendToBeVisual: true },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.innerWidth = 1200;
globalThis.innerHeight = 800;
// Node 21+ 起 globalThis.navigator 是只读 getter，直接赋值会抛 TypeError
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true, writable: true });

const insp = await import('./js/inspector.js');
const uninstall = insp.installInspector();

/* ---------- 1. 开关 ---------- */
console.log('\n=== 1. 开关 ===');
t('初始为关', insp.isInspectorOn() === false);
insp.setInspector(true);
t('可开启', insp.isInspectorOn() === true);
t('开启后 body 挂上标记', document.body.classList.contains('nx-inspecting'));
t('高亮层已插入', !!document.querySelector('.nx-insp-overlay'));
t('信息条已插入', !!document.querySelector('.nx-insp-badge'));
t('状态写入 localStorage', localStorage.getItem('nexus:dev-inspector') === '1');
insp.toggleInspector();
t('可切换关闭', insp.isInspectorOn() === false);
t('关闭后移除标记', !document.body.classList.contains('nx-inspecting'));

/* ---------- 2. 标识生成 ---------- */
console.log('\n=== 2. 标识 ===');
insp.setInspector(true);
const reload = document.getElementById('bar-reload');
t('标签 + id + class', insp.labelOf(reload) === 'button#bar-reload.bar-btn', insp.labelOf(reload));
t('标签 + class', insp.labelOf(document.getElementById('plugin-list')) === 'nav#plugin-list');

const wide = document.createElement('div');
wide.className = 'a b c d e f';
t('class 只取前两个（否则长串工具类没法读）', insp.labelOf(wide) === 'div.a.b', insp.labelOf(wide));

const p1 = insp.pathOf(reload);
t('路径含自身', p1.includes('button#bar-reload'), p1);
t('路径含祖先', p1.includes('main#main') || p1.includes('div#plugin-bar'), p1);
t('路径不超过 5 段', p1.split(' > ').length <= 5, String(p1.split(' > ').length));

/* ---------- 3. 悬浮高亮 ---------- */
console.log('\n=== 3. 高亮 ===');
insp.__inspect(reload);
t('高亮层已激活', insp.__debug().overlayOn === true);
t('信息条已激活', insp.__debug().badgeOn === true);
const badge = document.querySelector('.nx-insp-badge');
t('信息条显示元素名', badge.textContent.includes('button#bar-reload'), badge.textContent.trim());
t('信息条显示尺寸', /\d+ × \d+/.test(badge.textContent), badge.textContent.trim());
t('高亮层用 CSS 变量定位',
  /setProperty\('--x'/.test(src('js/inspector.js')));

/* ---------- 4. 插件归属 ---------- */
console.log('\n=== 4. 插件归属 ===');
const wrap = document.createElement('div');
wrap.className = 'plugin-wrap';
wrap.dataset.pluginId = 'mindmap';
const inner = document.createElement('span');
wrap.appendChild(inner);
document.body.appendChild(wrap);
t('能向上找到所属插件', insp.pluginOf(inner) === 'mindmap', String(insp.pluginOf(inner)));
insp.__inspect(inner);
t('信息条标出插件 id',
  document.querySelector('.nx-insp-badge').textContent.includes('mindmap'));
wrap.remove();

/* ---------- 5. 隔离 iframe 降级 ---------- */
console.log('\n=== 5. 隔离降级 ===');
const iframe = document.createElement('iframe');
document.body.appendChild(iframe);
// 模拟"严格沙箱"：contentDocument 直接抛异常（opaque origin 的真实表现）。
// 这里验证的是**降级行为**而不是源码长相 —— 抛异常时必须不崩，
// 并且要能在信息条上说明"进不去"，而不是静默什么都不显示。
Object.defineProperty(iframe, 'contentDocument', {
  get() { throw new Error('opaque origin'); },
});
let threw = false;
try {
  insp.__inspect(iframe);
} catch { threw = true; }
const t5 = document.querySelector('.nx-insp-badge').textContent;
t('隔离 iframe 不会让检查器崩溃', threw === false);
t('隔离 iframe 仍能高亮到自身', insp.__debug().overlayOn === true);
t('并标注「隔离·无法深入」', t5.includes('隔离'), t5.trim());
iframe.remove();

/* ---------- 6. 穿透与坐标换算（源码级） ---------- */
console.log('\n=== 6. 穿透 ===');
const isrc = src('js/inspector.js');
t('elementFromPoint 会递归进 iframe',
  /while \(el && el\.tagName === 'IFRAME' && guard\+\+ < 5\)/.test(isrc));
t('取文档做了 try/catch（严格沙箱会抛）',
  /function docOf\(iframe\) \{[\s\S]{0,200}?catch \{[\s\S]{0,60}?return null;/.test(isrc));
t('坐标逐级累加父 iframe 偏移',
  /while \(win && win !== window && guard\+\+ < 5\)/.test(isrc)
  && /left \+= r\.left;/.test(isrc));
t('有防死循环上限', (isrc.match(/guard\+\+ < 5/g) || []).length >= 2);

/* ---------- 7. 关键设计（源码级） ---------- */
console.log('\n=== 7. 设计 ===');
const css = src('css/neumorphism.css');
t('高亮层 pointer-events:none（否则抢 hover 导致闪烁）',
  /\.nx-insp-overlay \{[\s\S]{0,400}?pointer-events: none;/.test(css));
t('信息条 pointer-events:none',
  /\.nx-insp-badge \{[\s\S]{0,500}?pointer-events: none;/.test(css));
t('点击在捕获阶段拦截（顺手阻止误触发按钮）',
  /document\.addEventListener\('click', onClick, true\)/.test(isrc)
  && /e\.preventDefault\(\);/.test(isrc));
/*
 * ESC 必须是**两级**退出：
 *   已锁定 → 解锁（回悬停）
 *   没锁定 → 关闭检查器
 *
 * 此前只有"解锁"那一半（旧断言 `if (e.key === 'Escape' && locked)`），
 * 于是悬停态下 ESC 毫无反应 —— 而悬停恰恰是最常用的状态，
 * 用户开着扫完想退却退不掉，只能再按快捷键或点侧边栏按钮。
 *
 * 旧断言钉的是**旧契约**，功能一改就该跟着改，否则它会一直告诉
 * 你"没变化"，把回归挡在门外。
 */
t('Esc 两级退出：先解锁', /if \(locked\) \{[\s\S]{0,80}locked = null;[\s\S]{0,60}clear\(\);/.test(isrc));
t('Esc 两级退出：没锁定时关闭检查器',
  /\} else \{[\s\S]{0,80}setInspector\(false\);/.test(isrc));
t('Esc 消费后阻止继续传播', /if \(escInspector\(\)\) e\.stopPropagation\(\);/.test(isrc));
/* 抽成导出函数：主文档 + iframe 转发两个入口共用，避免两边逻辑走偏 */
t('退出逻辑抽成 escInspector 导出（供 iframe 转发复用）',
  /export function escInspector\(\)/.test(isrc));
t('escInspector 未开启时不消费', /if \(!on\) return false;/.test(isrc));
t('复制有 execCommand 降级（file:// 下没有 clipboard API）',
  /document\.execCommand\('copy'\)/.test(isrc));

/* ---------- 8. 入口接线 ---------- */
console.log('\n=== 8. 入口 ===');
t('无构建版：shell.js 已安装', /installInspector\(\);/.test(src('js/shell.js')));
t('无构建版：侧边栏有按钮', /id="btn-inspect"/.test(src('index.html')));
t('Vite 版：App.tsx 已安装', /installInspector\(\)/.test(src('src/App.tsx')));
t('Vite 版：Sidebar 有按钮', /onInspect/.test(src('src/components/Sidebar.tsx')));

/* ---------- 9. 焦点在 iframe 里时 ESC 也要能退 ----------
 * 鼠标扫过 iframe 插件里的控件会把焦点带进插件，
 * 而键盘事件不跨文档冒泡 —— 外壳的 window keydown 收不到，ESC 彻底失效。
 */
console.log('\n=== 9. iframe 内的 ESC ===');
const sdk = src('js/plugin-sdk.js');
t('SHELL_SHORTCUTS 含 esc（否则 iframe 内 ESC 传不回来）',
  /SHELL_SHORTCUTS = \[[^\]]*'esc'/.test(sdk));
t('宿主侧只在检查器开着时消费 esc（不抢插件自己的 ESC）',
  /esc: \(\) => \{[\s\S]{0,120}if \(!isInspectorOn\(\)\) return false;/.test(src('js/shell.js')));
t('宿主侧 esc 走同一个 escInspector',
  /esc: \(\) => \{[\s\S]{0,200}escInspector\(\);/.test(src('js/shell.js')));
t('shell.js 已 import escInspector',
  /import \{[^}]*escInspector[^}]*\} from '\.\/inspector\.js'/.test(src('js/shell.js')));
/* 两个技术栈都要接 —— 只修一个的话，用另一个外壳的人照样退不掉 */
const appSrc = src('src/App.tsx');
t('React 侧也接了 onShellShortcut',
  /onShellShortcut: \(combo\) => \{[\s\S]{0,300}escInspector\(\);/.test(appSrc));
t('React 侧同样是"只在检查器开着时消费"',
  /if \(!isInspectorOn\(\)\) return false;/.test(appSrc));
t('React 侧已 import escInspector',
  /import \{[^}]*escInspector[^}]*\} from '\.\.\/js\/inspector\.js'/.test(appSrc));
t('快捷键是 Ctrl/Cmd+Shift+D（避开 webview 的 Ctrl+Shift+I）',
  /e\.key\.toLowerCase\(\) !== 'd'/.test(isrc) && /e\.shiftKey/.test(isrc));

/* ---------- 9. iframe 插件内部的鼠标 ---------- */
console.log('\n=== 9. iframe 内的鼠标（转发回来）===');
/*
 * 根因：鼠标移到 iframe 上方时，事件**归 iframe 内部文档所有**，
 * 主文档既收不到 mousemove 也收不到 click（事件不跨文档冒泡）。
 *
 * 于是 elementAt() 里那段"穿透 iframe"的递归**永远没机会执行** ——
 * elementFromPoint 压根拿不到 iframe 元素，因为压根没触发过。
 *
 * 表现：外壳自己的控件（标题栏/侧边栏）都能选中，
 * 而 iframe 插件（含设置页面板）里的一切都选不中 ——
 * 看着像"有些控件坏了"，其实是整个 iframe 区域都够不着。
 */
const hostSrc = src('js/host.js');
const sdkSrc2 = src('js/plugin-sdk.js');

t('inspector 导出 moveInIframe（供宿主转发进来）',
  /export function moveInIframe/.test(isrc));
t('inspector 导出 clickInIframe', /export function clickInIframe/.test(isrc));
/* 隔离插件（opaque origin）进不去，必须降级到 iframe 本身并标注，
   而不是什么都不显示 —— 静默失败比报错更难排查。 */
t('隔离 iframe 降级到 iframe 本身',
  /function innerEl\(iframe, x, y\)[\s\S]{0,320}return iframe;/.test(isrc));

t('宿主登记 iframe', /liveFrames\.add\(iframe\)/.test(hostSrc));
t('宿主在 iframe 卸载时注销（否则泄漏 + 给空窗口发消息）',
  /liveFrames\.delete\(iframe\)/.test(hostSrc));
t('宿主监听检查器开关并广播给所有 iframe',
  /nexus:inspector-toggle/.test(hostSrc) && /function broadcastInspect/.test(hostSrc));
t('新挂载的 iframe 立刻同步检查器状态',
  /if \(isInspectorOn\(\)\) \{[\s\S]{0,140}type: 'inspect', on: true/.test(hostSrc));
t('宿主处理 inspect-move', /case 'inspect-move':/.test(hostSrc));
t('宿主处理 inspect-click', /case 'inspect-click':/.test(hostSrc));

t('插件侧接收 inspect 开关', /d\.type === 'inspect'/.test(sdkSrc2));
t('插件侧转发 mousemove 坐标', /type: 'inspect-move', x, y/.test(sdkSrc2));
t('插件侧转发 click 坐标', /type: 'inspect-click', x: e\.clientX/.test(sdkSrc2));
/* mousemove 每秒上百次，不节流会白白吃掉主线程 */
t('转发有节流（rAF）', /requestAnimationFrame/.test(sdkSrc2));
/* 点击必须**同步**阻止：宿主回包是异步的，等它回来按钮早被触发了 */
t('插件侧同步阻止 click（不等宿主异步回包）',
  /const onClick = \(e\) => \{[\s\S]{0,140}e\.preventDefault\(\);/.test(sdkSrc2));
t('插件卸载时停掉转发', /stopInspectRelay\?\.\(\);/.test(sdkSrc2));

/* ---------- 10. 锁定后的一键复制按钮 ---------- */
console.log('\n=== 10. 一键复制完整路径 ===');
/*
 * 背景：点元素时**已经**复制过一次路径，但那次是静默的 ——
 * 用户拿不准到底成功了没有。而"再点一下"是**解锁**，路径反而丢了。
 * 所以给一个显式按钮，点完还能看到 ✓ / ✗。
 *
 * 三个不做就会错的点，都在下面的断言里：
 *   1. 捕获阶段的点击拦截必须放行这个按钮，否则"看得见、点了没反应"
 *   2. 按钮要 pointer-events:auto（信息条整体是 none）
 *   3. 光标要压过 `body.nx-inspecting *` 的 crosshair !important
 */
insp.setInspector(true);
insp.__lock(reload);
const badgeLocked = document.querySelector('.nx-insp-badge');
const copyBtn = badgeLocked.querySelector('.nx-insp-copy');
t('锁定后出现复制按钮', !!copyBtn);

{
  // 按钮必须紧跟在"已锁定"文字**后面**，不是塞在别的位置
  const kids = [...badgeLocked.children];
  const li = kids.findIndex((n) => n.classList.contains('nx-insp-locked'));
  t('信息条上有「已锁定·再点解锁」', li >= 0);
  t('按钮就在锁定文字右侧（紧邻其后）',
    li >= 0 && kids[li + 1] === copyBtn);
  t('按钮有说明性 title', copyBtn?.title === '复制控件完整路径');
}

t('未锁定时不显示按钮（此时没什么可复制）', (() => {
  insp.setInspector(false);          // 关掉会清掉 locked
  insp.setInspector(true);
  const other = document.getElementById('nav-home');
  insp.__inspect(other);
  const has = !!document.querySelector('.nx-insp-badge .nx-insp-copy');
  return has === false;
})());

/* 行为验证：走真实事件路径，确认捕获阶段的拦截确实放行了按钮 */
insp.setInspector(false);
insp.setInspector(true);
insp.__lock(reload);
{
  const btn = document.querySelector('.nx-insp-badge .nx-insp-copy');
  /*
   * 验证"捕获阶段的拦截放行了按钮"。
   *
   * 两种看起来合理但**测不出东西**的写法，都试过了：
   *   · 看 defaultPrevented —— 按钮自己的处理器也调了 preventDefault，恒为 true
   *   · document 上挂冒泡监听 —— 按钮处理器调了 stopPropagation，收不到
   *
   * 真正能证明的是**按钮自己的处理器跑了**：事件若真被捕获阶段掐断，
   * 根本到不了 target，也就不会有下面的复制结果与 ✓/✗ 反馈。
   */
  const ev = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
  btn.dispatchEvent(ev);
  t('点按钮不会顺手解锁（锁定状态保持）',
    insp.__debug().locked === insp.labelOf(reload), String(insp.__debug().locked));
  // 复制是异步的，等一拍再看结果
  await new Promise((r) => setTimeout(r, 0));
  const rec = globalThis.__NEXUS_INSPECTOR_COPY__;
  t('复制的内容就是该元素的完整路径',
    rec?.text === insp.pathOf(reload), String(rec?.text));
  t('按钮自己收到点击并给出反馈（✓ 或 ✗）',
    btn.textContent === '✓' || btn.textContent === '✗', btn.textContent);
}

/* 源码级 */
t('onClick 放行 .nx-insp-copy（不放行就永远点不动）',
  /if \(e\.target\?\.closest\?\('\.'?nx-insp-copy'\)\) return;/.test(isrc)
  || /nx-insp-copy'\)\) return;/.test(isrc));
t('按钮复用 copyPath，不另写一份路径生成',
  /copyPath\(el\)\.then/.test(isrc)
  && /function copyPath\(target\)/.test(isrc));
t('pickAt 也走同一个 copyPath（两处不会复制出不一样的东西）',
  /locked = el;\s*\n\s*highlight\(el\);\s*\n\s*copyPath\(el\);/.test(isrc));
t('复制后有 ✓ / ✗ 反馈（用户才知道成功没有）',
  /btn\.textContent = ok \? '✓' : '✗';/.test(isrc));
t('反馈会复原（isConnected 保护，防止信息条已重渲染）',
  /if \(btn\.isConnected\) btn\.textContent = '⧉';/.test(isrc));
t('onMove 忽略信息条的后代（按钮是 auto，会被 elementFromPoint 命中）',
  /el === badge \|\| badge\?\.contains\(el\)/.test(isrc));

/* CSS：两个类的选择器才压得过 crosshair !important */
const cssCopy = css.slice(css.indexOf('.nx-insp-badge .nx-insp-copy {'));
t('按钮 pointer-events:auto（信息条整体是 none）',
  /pointer-events: auto;/.test(cssCopy.slice(0, 400)));
t('光标带 !important（否则被 crosshair 覆盖，看着不像能点）',
  /cursor: pointer !important;/.test(cssCopy.slice(0, 400)));
t('选择器是两个类（单个类压不过 body.nx-inspecting *）',
  /\.nx-insp-badge \.nx-insp-copy \{/.test(css));
insp.setInspector(false);

/* ---------- 11. 卸载 ---------- */
console.log('\n=== 11. 卸载 ===');
insp.setInspector(false);
uninstall();
t('卸载后关闭', insp.isInspectorOn() === false);
t('卸载后移除高亮层', !document.querySelector('.nx-insp-overlay'));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
