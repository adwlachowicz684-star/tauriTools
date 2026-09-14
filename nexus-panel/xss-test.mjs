/**
 * XSS 转义回归测试（开发用，可删）
 *
 * 起因：js/host.js 的错误框里 `manifest.name` 直接拼进 innerHTML，
 * 而同一处的 `msg` 却做了转义 —— 同一份数据一处锁了一处没锁。
 * 审计连续三轮报出同一问题，所以补一组用例钉死它。
 *
 * 思路：直接调 host.js 导出的 renderErrorBox() —— 也就是生产代码
 * 走的那一个函数，确保"插件名进入 DOM 时不带 HTML 结构"。
 *
 * 这里**不再复刻模板**。此前本文件复制了一份 showError 的模板，
 * 源码注释还写着"改一行时这里要跟着改"：结果是源码改了而这份拷贝
 * 没跟上，测试依然全绿 —— 它验的是自己那份，不是真实渲染路径。
 * 现在模板只有 host.js 里的一份，改了就一起变。
 */
import { JSDOM } from 'jsdom';

// 必须给 url，否则是 opaque origin，localStorage 不可用
const dom = new JSDOM('<!DOCTYPE html><html><body><div id="stage"></div></body></html>', {
  url: 'http://localhost/',
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;

const { escapeHtml, renderErrorBox } = await import('./js/host.js');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const stage = document.getElementById('stage');

/** 调真实渲染函数，把结果放进 stage —— 与本文件无重复的模板。 */
function render(name, msg) {
  stage.innerHTML = renderErrorBox({ name }, msg);
  return stage;
}

console.log('\n=== 1. escapeHtml 基础字符 ===');
t('& 被转义', escapeHtml('a&b') === 'a&amp;b', escapeHtml('a&b'));
t('< 被转义', escapeHtml('<script>') === '&lt;script&gt;', escapeHtml('<script>'));
t('> 被转义', escapeHtml('a>b') === 'a&gt;b');
t('双引号被转义', escapeHtml('"') === '&quot;');
t('单引号被转义', escapeHtml("'") === '&#39;', escapeHtml("'"));
t('普通文本不受影响', escapeHtml('插件 A v1.0') === '插件 A v1.0');
t('非字符串输入不抛错', escapeHtml(undefined) === 'undefined' && escapeHtml(null) === 'null');

console.log('\n=== 2. 典型 XSS 载荷 ===');
const payloads = [
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['script 标签', '<script>alert(1)</script>'],
  ['svg onload', '<svg onload=alert(1)>'],
  ['闭合 h3 后注入', '</h3><script>alert(1)</script>'],
  ['属性闭合', '" onmouseover="alert(1)'],
  ['大小写混淆', '<ScRiPt>alert(1)</ScRiPt>'],
  ['带斜杠', '<img/src=x/onerror=alert(1)>'],
];
for (const [label, p] of payloads) {
  render(p, 'boom');
  const h3 = stage.querySelector('h3');
  // 关键断言：DOM 里没有凭空多出元素，文本就是原始字符串
  t(`${label} → 未产生元素`, stage.querySelectorAll('img,script,svg').length === 0);
  t(`${label} → 文本原样保留`, h3.textContent === `⚠ 插件「${p}」加载失败`);
}

console.log('\n=== 3. 错误消息同样安全 ===');
render('x', '<img src=x onerror=alert(1)>');
t('pre 内不产生元素', stage.querySelectorAll('pre img').length === 0);
t('pre 文本原样',
  stage.querySelector('pre').textContent === '<img src=x onerror=alert(1)>');

console.log('\n=== 4. 模拟真实攻击链（导入恶意插件） ===');
// 攻击路径：用户导入一个 name 里带 HTML 的插件 → 加载失败 → 走错误框
const evil = { id: 'evil', name: '<img src=x onerror=window.__XSS__=1>', entry: './nope.js' };
render(evil.name || evil.id, new Error('模块加载失败').stack);
t('未执行 onerror（window.__XSS__ 未定义）', globalThis.window.__XSS__ === undefined);
t('页面无 img 元素', stage.querySelectorAll('img').length === 0);
t('标题显示为纯文本',
  stage.querySelector('h3').textContent === `⚠ 插件「${evil.name}」加载失败`);

console.log('\n=== 5. 正常插件名不被破坏 ===');
for (const n of ['概览', 'Agent Flow', "O'Brien 的工具", 'a & b', '<正式版>']) {
  render(n, 'x');
  t(`「${n}」显示正确`,
    stage.querySelector('h3').textContent === `⚠ 插件「${n}」加载失败`);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
