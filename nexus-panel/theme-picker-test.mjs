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

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
