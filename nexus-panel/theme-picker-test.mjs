/**
 * 标题栏主题选择器测试（开发用，可删）
 *
 * 覆盖：打开/关闭 → 缩略图渲染 → 点击即切换并关闭 → 遮罩与 ESC 关闭
 *      → 再次点击按钮是 toggle → 外部切主题时同步高亮 → 自定义主题可删除
 *      → 主题名不会被当成 HTML（刚修过同类 XSS）
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM(
  `<!DOCTYPE html><html><body>
     <button id="btn-theme">◐</button>
   </body></html>`,
  { url: 'http://localhost/', pretendToBeVisual: true },
);
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.getComputedStyle = dom.window.getComputedStyle;
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { openThemePicker, closeThemePicker, isThemePickerOpen } = await import('./js/theme-picker.js');
const { listThemes, getThemeId, applyTheme, saveAsCustom } = await import('./js/theme-manager.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const btn = document.getElementById('btn-theme');
const picked = [];

console.log('\n=== 1. 打开与渲染 ===');
openThemePicker({ anchor: btn, onPick: (x) => picked.push(x) });
t('已打开', isThemePickerOpen());
const pop = document.querySelector('.theme-pop');
t('弹出层已插入 DOM', !!pop);
t('遮罩已插入', !!document.querySelector('.theme-pop-mask'));

const cards = () => [...document.querySelectorAll('.theme-pop .theme-card')];
t('渲染出全部主题卡片', cards().length === listThemes().length,
  `${cards().length} / ${listThemes().length}`);
t('每个卡片都有缩略图', cards().every((c) => c.querySelector('.theme-prev')));
t('分组标题存在（深色/浅色）',
  document.querySelectorAll('.theme-pop .theme-group-title').length >= 1);
t('当前主题被标记为 active',
  cards().filter((c) => c.classList.contains('active')).length === 1);

console.log('\n=== 2. 点击即切换并关闭 ===');
const target = cards().find((c) => !c.classList.contains('active'));
const targetId = target.dataset.themeId;
target.click();
t('主题已切换', getThemeId() === targetId, `${getThemeId()}`);
t('切换后自动关闭', !isThemePickerOpen());
t('onPick 收到被选中的主题', picked.at(-1)?.id === targetId);
t('弹出层已从 DOM 移除', !document.querySelector('.theme-pop'));

console.log('\n=== 3. 关闭方式 ===');
openThemePicker({ anchor: btn });
document.querySelector('.theme-pop-mask').click();
t('点遮罩关闭', !isThemePickerOpen());

openThemePicker({ anchor: btn });
document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
t('ESC 关闭', !isThemePickerOpen());

console.log('\n=== 4. 再次点击按钮 = 关闭（toggle） ===');
openThemePicker({ anchor: btn });
t('已打开', isThemePickerOpen());
openThemePicker({ anchor: btn });
t('再点一次关闭', !isThemePickerOpen());

console.log('\n=== 5. 外部切主题时同步高亮 ===');
openThemePicker({ anchor: btn });
const other = listThemes().find((x) => x.id !== getThemeId());
applyTheme(other.id);
const activeNow = document.querySelector('.theme-pop .theme-card.active');
t('高亮跟到新主题', activeNow?.dataset.themeId === other.id,
  `${activeNow?.dataset.themeId} vs ${other.id}`);
closeThemePicker();

console.log('\n=== 6. 自定义主题可删除 ===');
const custom = saveAsCustom('测试主题 🚀');
openThemePicker({ anchor: btn });
const cc = cards().find((c) => c.dataset.themeId === custom.id);
t('自定义主题出现在列表里', !!cc);
t('只有自定义主题带删除按钮',
  cards().every((c) => {
    const th = listThemes().find((x) => x.id === c.dataset.themeId);
    return !!c.querySelector('.theme-del') === !!th?.custom;
  }));
cc.querySelector('.theme-del').click();
t('删除后从列表消失', !cards().some((c) => c.dataset.themeId === custom.id));
t('删除后弹出层仍开着（可继续选）', isThemePickerOpen());
closeThemePicker();

console.log('\n=== 7. 主题名不被当作 HTML（XSS） ===');
// 自定义主题名来自用户输入，必须走 textContent
const evil = saveAsCustom('<img src=x onerror=alert(1)>');
openThemePicker({ anchor: btn });
const ec = cards().find((c) => c.dataset.themeId === evil.id);
t('卡片已渲染', !!ec);
t('未产生 img 元素', ec.querySelectorAll('img').length === 0);
t('名称原样作为文本', ec.querySelector('.theme-name').textContent === evil.name,
  ec.querySelector('.theme-name').textContent);
closeThemePicker();

console.log('\n=== 8. 卡片结构与样式契约 ===');
/* 这一节盯的是"DOM 与 CSS 各写一半"的事故：
   卡片里加了 class 但 CSS 没定义 → 元素在、样式不在，静默塌掉；
   CSS 只给弹出层写规则 → 设置页里同一个 class 变成裸 div，间距为 0。 */

const { readFileSync } = await import('node:fs');
const css = readFileSync(new URL('./css/neumorphism.css', import.meta.url), 'utf8');
const hasRule = (cls) => new RegExp(`\\.${cls}[\\s,:.{>]`).test(css);

closeThemePicker();
openThemePicker({ anchor: btn });

// 8.1 卡片用到的每个 class，CSS 里都得有定义
const used = new Set();
for (const el of document.querySelectorAll('.theme-pop .theme-card, .theme-pop .theme-card *')) {
  for (const c of el.classList) used.add(c);
}
const undef = [...used].filter((c) => !hasRule(c));
t('卡片用到的 class 都有样式定义', undef.length === 0, undef.join(', ') || `${used.size} 个全部有定义`);

// 8.2 分组标题必须有**不带** .theme-pop-body 限定的规则。
//     只写在 .theme-pop-body 下的话，设置页里的标题就是裸 div ——
//     曾被修过一次：标题上下间距为 0，卡片直接压在标题文字上。
/* 逐条取出「选择器 { 」逐个判断：只要有一条含 .theme-group-title
   且**不含** .theme-pop-body 的规则就算过。
   注意不能简单在整个文件里搜 `.theme-group-title {` ——
   `.theme-pop-body .theme-group-title {` 也能被匹配到，那样断言就永远为真。 */
const selectorsOf = (text) => [...text.matchAll(/([^{}]+)\{/g)].map((m) => m[1]);
const globalTitle = selectorsOf(css)
  .some((sel) => sel.includes('.theme-group-title') && !sel.includes('.theme-pop-body'));
t('.theme-group-title 有不限定容器的全局规则', globalTitle);

// 8.3 分组之间必须有显式间距，不能指望子元素 margin 撑开
t('.theme-group 之间有间距', /\.theme-group\s*\+\s*\.theme-group\s*\{[^}]*margin-top/.test(css));

// 8.4 主题名不再 inline 取预览主题的 --text
//     （那段历史 bug：深色面板下预览浅色主题 = 深色字压深色底 1.3:1）
const nameEls = [...document.querySelectorAll('.theme-pop .theme-name')];
t('主题名不 inline 设色', nameEls.every((n) => !n.style.color), `${nameEls.length} 张卡片`);
t('.theme-name 在 CSS 里显式给了颜色',
  /\.theme-name\s*\{[^}]*color:/.test(css));

closeThemePicker();

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
