/**
 * md 插件 · 批次 3（交互）测试
 * ============================================================
 * 覆盖 F3 代码块复制、F4 目录、F5 右键菜单。
 *
 * 两类断言：
 *   ① 行为 —— jsdom **真跑**（headingsOf / activeIdOf / targetOf /
 *      menuItemsFor / reactTextOf / copyText 都是纯函数，能直接跑）
 *   ② 契约 —— App.tsx 的接线、CSS、白名单。
 *      这类错了不报错（"点了没反应"），只能靠断言钉住。
 *
 * 运行：node md-interact-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${extra ? '  → ' + extra : ''}`); }
}

/* jsdom：toc.js / ctx-menu.js 要操作真实 DOM 节点 */
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;

const app = read('plugins/md/App.tsx');
const css = read('css/neumorphism.css');
const policy = read('js/invoke-policy.js');

/* 剥注释：注释里会写这些标识符，不剥会造成假绿 */
const strip = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const appC = strip(app);
const cssC = strip(css);

const { headingsOf, activeIdOf } = await import('./plugins/md/toc.js');
const { targetOf, menuItemsFor } = await import('./plugins/md/ctx-menu.js');
const { reactTextOf } = await import('./plugins/md/text-of.js');
const { copyText } = await import('./plugins/md/clipboard.js');

/* ============================================================
   1. F4 目录：真跑
   ============================================================ */
console.log('\n=== 1. F4 目录（jsdom 真跑） ===');

const mkRoot = (html) => {
  const el = dom.window.document.createElement('div');
  el.innerHTML = html;
  dom.window.document.body.appendChild(el);
  return el;
};

const r1 = mkRoot(`
  <h1 id="a">标题 A</h1><p>x</p>
  <h2 id="b">标题 B</h2><p>x</p>
  <h3 id="c-c">标题 C</h3>
`);
const h1 = headingsOf(r1);
t('抽出 3 个标题', h1.length === 3, `→ ${h1.length}`);
t('级别正确', h1.map((x) => x.level).join(',') === '1,2,3');
t('文本正确（含子元素时取 textContent）', h1[0].text === '标题 A');
t('id 原样保留（不自己算 slug）', h1[2].id === 'c-c');

const r2 = mkRoot(`<h2 id="d"></h2><h2>无 id</h2><h3 id="e">E</h3>`);
const h2 = headingsOf(r2);
t('跳过无 id 的（点了会没反应）', h2.length === 1 && h2[0].id === 'e', `→ ${h2.length}`);

const r3 = mkRoot(`<h2 id="f"><code>code</code> 文本</h2>`);
t('标题内含行内元素时取拼接纯文本', headingsOf(r3)[0].text === 'code 文本');

t('root 为 null 时返回空（不抛）', headingsOf(null).length === 0);

/* activeIdOf */
const r4 = mkRoot(`<h2 id="g">G</h2><h2 id="h">H</h2>`);
const items4 = [{ id: 'g' }, { id: 'h' }];
/* jsdom 里 getBoundingClientRect 恒为 0，两个标题都"贴顶" → 取最后一个 */
t('都在顶部之上时取最后一个滚过的', activeIdOf(items4, r4) === 'h');
t('items 为空时返回 null', activeIdOf([], r4) === null);
t('root 为 null 时返回 null', activeIdOf(items4, null) === null);

/* ============================================================
   2. F5 右键菜单：真跑
   ============================================================ */
console.log('\n=== 2. F5 右键菜单（jsdom 真跑） ===');

const r5 = mkRoot(`
  <a href="https://x.com">链接文字</a>
  <img src="./pic.png" alt="图注">
  <a href="https://wrap.com"><img src="./in.png" alt="内"></a>
  <p id="plain">正文</p>
`);
t('落在链接上 → kind=link', targetOf(r5.querySelector('a')).kind === 'link');
t('链接 value 取 href', targetOf(r5.querySelector('a')).value === 'https://x.com');
t('落在图片上 → kind=img', targetOf(r5.querySelector('img')).kind === 'img');

/* 关键：图片即链接时，落在 img 上要给 img（否则图永远拿不到） */
const inner = r5.querySelector('a[href="https://wrap.com"] img');
const ti = targetOf(inner);
t('图片在链接内时优先给 img', ti.kind === 'img' && ti.value === './in.png',
  `→ ${ti.kind}/${ti.value}`);

t('落在正文上 → null（该让浏览器原生菜单出来）',
  targetOf(r5.querySelector('#plain')) === null);
t('null 输入不抛', targetOf(null) === null);

const mLink = menuItemsFor({ kind: 'link', value: 'https://x.com' });
t('链接菜单：只有"复制链接地址"', mLink.length === 1 && mLink[0].value === 'https://x.com');

const mImg = menuItemsFor({ kind: 'img', value: './p.png', text: '注' });
t('图片菜单 2 项', mImg.length === 2);
t('第二项是 Markdown 写法', mImg[1].value === '![注](./p.png)');
t('alt 缺失时不留空方括号占位符错误', menuItemsFor({ kind: 'img', value: 'p' })[1].value === '![](p)');
t('value 为空 → 不给任何项（复制空串=点了没反应）',
  menuItemsFor({ kind: 'link', value: '' }).length === 0);

/* ============================================================
   3. F3 复制：真跑
   ============================================================ */
console.log('\n=== 3. F3 复制（真跑） ===');

/* reactTextOf：模拟 rehype-highlight 切出的 span 树 */
const fake = {
  props: {
    children: [
      { props: { children: 'const ' } },
      { props: { children: [{ props: { children: 'a' } }, ' = 1'] } },
    ],
  },
};
t('递归取出被 span 切碎的原始代码', reactTextOf(fake) === 'const a = 1',
  `→ "${reactTextOf(fake)}"`);
t('字符串直接返回', reactTextOf('abc') === 'abc');
t('null/undefined/boolean → 空', reactTextOf(null) === '' && reactTextOf(true) === '');
t('数字转字符串', reactTextOf(12) === '12');
t('无 children 的元素 → 空（不是 [object Object]）',
  reactTextOf({ props: {} }) === '');

/*
 * copyText：后端优先。
 * 用假 ctx 记下调用，验证"后端可用时不去碰前端"。
 */
let invoked = null;
const ctxOk = { invoke: async (cmd, args) => { invoked = { cmd, args }; return true; } };
t('后端可用时返回 true', await copyText(ctxOk, 'x') === true);
t('走的是 fpx_copy_text', invoked?.cmd === 'fpx_copy_text');
t('参数名是 text', invoked?.args?.text === 'x');

/* 后端失败 → 必须退回前端，而不是直接判死 */
let frontUsed = false;
globalThis.navigator = {
  clipboard: { writeText: async () => { frontUsed = true; } },
};
const ctxBad = { invoke: async () => { throw new Error('no'); } };
t('后端失败时退回前端剪贴板', await copyText(ctxBad, 'x') === true && frontUsed);

/* 两条都不行 → 明确 false，由调用方提示，不允许静默 */
globalThis.navigator = {
  clipboard: { writeText: async () => { throw new Error('denied'); } },
};
t('两条都失败 → 返回 false（不静默）', await copyText(ctxBad, 'x') === false);
t('无 ctx 且前端失败 → false', await copyText(null, 'x') === false);
t('空文本不复制（复制空串=点了没反应）', await copyText(ctxOk, '') === false);

/* ============================================================
   4. App.tsx 接线（契约）
   ============================================================ */
console.log('\n=== 4. App.tsx 接线 ===');

t('覆盖 pre 而不是 code（pre 天然只命中块级，不误伤行内）',
  /pre: \(props: any\) => <CodeBlock/.test(appC));
t('CodeBlock 用 reactTextOf 取原始代码（否则复制出 [object Object]）',
  /reactTextOf\(codeEl\?\.props\?\.children\)/.test(appC));
t('有复制成功/失败的状态反馈', /state === 'ok' \? '已复制'/.test(appC));

t('渲染区挂了 ref（TOC/菜单都要 DOM）', /ref=\{outRef\}/.test(appC));
t('滚动高亮挂在容器上（挂 window 永不触发）', /onScroll=\{onOutScroll\}/.test(appC));
t('TOC 从 DOM 读（headingsOf）', /headingsOf\(outRef\.current\)/.test(appC));
t('TOC effect 依赖 body 而不是 src（依赖 src 会读上一帧）',
  /setActiveId\(null\);\s*\}, \[body\]\)/.test(appC));
t('没有标题时不渲染整栏', /toc\.length \? \(/.test(appC));
t('目录项有 is-on 高亮', /is-on' : ''\}/.test(appC));

t('右键菜单接管 onContextMenu', /onContextMenu=\{onContextMenu\}/.test(appC));
t('不是链接/图片时不接管（让原生菜单出来）', /if \(!t\) \{ setMenu\(null\); return; \}/.test(appC));
t('Esc 关闭菜单', /ev\.key === 'Escape'/.test(appC));
t('菜单点击后关闭', /setMenu\(null\);/.test(appC));
t('复制失败有提示（不静默）', /复制失败：剪贴板不可用/.test(appC));

/* ============================================================
   5. 样式与白名单
   ============================================================ */
console.log('\n=== 5. 样式与白名单 ===');

t('CSS 有 .md-code-bar', /\.md-code-bar \{/.test(cssC));
t('CSS 有 .md-toc', /\.md-toc \{/.test(cssC));
t('CSS 有 .md-menu 且是 fixed（不定会被引流区裁掉）',
  /\.md-menu \{[\s\S]{0,120}?position: fixed;/.test(cssC));
t('CSS 有 .md-menu-item', /\.md-menu-item \{/.test(cssC));
/* md 段全部走令牌：写死色值切主题时不跟随，且不报错 */
const mdCss = cssC.slice(cssC.indexOf('.md-code-bar'));
t('md 交互样式不写死色值（走 var()）',
  !/#[0-9a-fA-F]{3,6}\b/.test(mdCss.replace(/rgba?\([^)]*\)/g, '')),
  (mdCss.match(/#[0-9a-fA-F]{3,6}\b/g) || []).join(','));

t('白名单登记了 fpx_copy_text', /md: \['fpx_read_file', 'fpx_copy_text'\]/.test(policy));
t('md 仍未登记 M 类能力',
  !/md: \[[^\]]*(run_node|webhook_start|window_action|shell_open)/.test(policy));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
