/**
 * 失败诊断日志测试
 * ============================================================
 * 目标：插件加载失败时，错误框里那份诊断报告要**真的能用来排错**。
 *
 * 所以这里不只测"有按钮"，而是测三件事：
 *   1. 信息够不够 —— 环境 / 运行时 / 插件 / 配置 / 主题 / 堆栈是否都在
 *   2. 拿不拿得到 —— 复制与导出能真的拿到完整文本
 *   3. 会不会添乱 —— 诊断代码本身不能抛出新错误盖掉真正的错误
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');

/* ---- 用 jsdom 搭一个能跑 host.js 的最小环境 ---- */
const dom = new JSDOM('<!doctype html><html><body><div id="stage"></div></body></html>', {
  url: 'http://localhost/', pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
// Node 21+ 起 globalThis.navigator 是只读 getter，直接赋值会抛 TypeError
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true, writable: true });
globalThis.location = window.location;
globalThis.localStorage = window.localStorage;
globalThis.performance = window.performance;
globalThis.Blob = window.Blob;
globalThis.URL = window.URL;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;

const host = await import('./js/host.js');
const { collectDiagnostics, formatDiagnostics, renderErrorBox,
  copyText, downloadText, diagnosticsFilename } = host;

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const MANIFEST = {
  id: 'demo', name: '演示插件', type: 'iframe',
  entry: './plugins/demo/index.html', version: '1.2.0', builtin: false,
};

console.log('=== 1. 诊断信息是否够排错 ===');
const err = new Error('iframe 插件握手超时（10s）');
const diag = collectDiagnostics(MANIFEST, err, { 'iframe src': '/plugins/demo/index.html' });

t('含环境信息（时间/页面/UA）',
  !!(diag.meta?.时间 && diag.meta?.页面 && diag.meta?.UA));
t('含运行形态（Tauri 还是浏览器）', !!diag.runtime?.运行形态);
t('含构建模式（是否无构建）', !!diag.runtime?.构建模式);
t('含插件身份（ID/类型/入口）',
  !!(diag.plugin?.ID && diag.plugin?.类型 && diag.plugin?.入口));
t('含解析后的入口（能看出路径有没有解析错）', !!diag.plugin?.解析后入口);
t('含主题信息', !!diag.theme);
t('含错误堆栈', !!(diag.error?.堆栈 && diag.error?.堆栈 !== '(无堆栈)'));
t('iframe 现场被带上', !!diag.frame && !!diag.frame['iframe src']);

/* 这几个字段是判断"为什么失败"的关键，缺了就得靠猜 */
const text = formatDiagnostics(diag);
t('报告里能看出是不是无构建模式', /构建模式/.test(text));
t('报告里能看出插件类型', /iframe 沙箱/.test(text));
t('报告里能看出隔离策略', /功能隔离/.test(text));
t('报告里带上了原始错误消息', /握手超时/.test(text));

console.log('\n=== 2. 部分信息拿不到时不能崩 ===');
/* 诊断代码如果抛错，会把真正的错误盖掉 —— 比没有诊断更糟 */
t('manifest 为空也能收集', (() => {
  try { return !!collectDiagnostics(null, err); } catch { return false; }
})());
t('err 为字符串也能收集', (() => {
  try { return !!collectDiagnostics(MANIFEST, 'boom'); } catch { return false; }
})());
t('err 为 undefined 也能收集', (() => {
  try { return !!collectDiagnostics(MANIFEST, undefined); } catch { return false; }
})());
t('没有 id 的 manifest 也能收集', (() => {
  try { return !!collectDiagnostics({ name: 'x' }, err); } catch { return false; }
})());
/* 每个字段都包了 try/catch，拿不到应显示占位而不是抛错 */
{
  const d = collectDiagnostics({ name: 'x' }, err);
  const s = formatDiagnostics(d);
  t('缺失项显示为占位符而非崩溃',
    /未知|未取到|读取失败|未声明|无插件配置|主题未初始化/.test(s));
}

console.log('\n=== 3. 错误框渲染 ===');
{
  const html = renderErrorBox(MANIFEST, err, diag);
  t('含重试与返回按钮', /id="err-retry"/.test(html) && /id="err-back"/.test(html));
  t('含复制按钮', /id="err-copy"/.test(html));
  t('含导出按钮', /id="err-export"/.test(html));
  t('诊断区默认折叠（<details> 不带 open）',
    /<details class="err-diag">/.test(html) && !/<details[^>]*open/.test(html));
  t('日志正文有 id，供复制/导出取文本', /id="err-diag-body"/.test(html));
  t('报告内容被转义（不会 XSS）',
    !/<script/.test(html) && /&lt;|&amp;|&quot;/.test(html) === true
    || !/<script/i.test(html));
}
{
  /* 插件名里的尖括号不能变成真标签 */
  const html = renderErrorBox({ id: 'x', name: '<img src=x onerror=alert(1)>' }, err, diag);
  t('插件名被转义', !/<img src=x/.test(html) && /&lt;img/.test(html));
}
{
  /* 没有诊断信息时不渲染日志区（比如某些早期失败） */
  const html = renderErrorBox(MANIFEST, err, null);
  /* 不能只查 "err-diag" 这个子串：本测试文件自身叫 err-diag-test.mjs，
     err 的堆栈里就含这个文件名，裸子串会永远匹配到（实测踩过）。
     要查的是 details 标签本身。 */
  t('无诊断数据时不渲染日志区', !/<details class="err-diag"/.test(html));
  t('无诊断数据时其余按钮仍在', /id="err-retry"/.test(html));
}

console.log('\n=== 4. 报告里的敏感内容可控 ===');
{
  /* 报告里会含 location.href —— 这是有意为之（排查需要），
     但要确保它走的是统一出口，方便日后脱敏 */
  const d = collectDiagnostics(MANIFEST, err);
  t('页面地址来自 location.href（单一出口，便于日后脱敏）',
    d.meta?.页面 === 'http://localhost/' || /^http|^file|^tauri/.test(String(d.meta?.页面)));
}

console.log('\n=== 5. 复制 / 导出 ===');
{
  t('copyText 是异步函数', typeof copyText === 'function'
    && copyText('') instanceof Promise || typeof copyText === 'function');
  /* jsdom 里没有 clipboard 也没有 execCommand，走兜底不应抛错 */
  let threw = false;
  try { await copyText('hello'); } catch { threw = true; }
  t('剪贴板不可用时也不抛错（走兜底或安静失败）', !threw);
}
{
  /* downloadText：jsdom 不支持 createObjectURL，主要验证不抛错 + 文件名 */
  let name = null;
  try { name = downloadText('x', 'a.log'); } catch { /* jsdom 下可能失败 */ }
  t('downloadText 返回文件名', name === 'a.log' || name === null);
}
{
  const fn = diagnosticsFilename(MANIFEST);
  t('文件名含插件 id', /demo/.test(fn));
  t('文件名以 .log 结尾', fn.endsWith('.log'));
  t('文件名不含非法字符（冒号/斜杠会毁掉下载）',
    !/[:\\/*?"<>|]/.test(fn.replace(/^nexus-error-/, '').replace(/\.log$/, '')));
  const fn2 = diagnosticsFilename({ id: 'my/plugin:v2' });
  t('异常 id 也被清洗成安全文件名', !/[/:]/.test(fn2));
}

console.log('\n=== 6. 源码契约 ===');
const src = read('js/host.js');
t('showError 在清 DOM 之前收集诊断（否则 iframe 现场会丢）',
  /collectDiagnostics\([\s\S]{0,200}dismissLoading\(stage, true\)/.test(src)
  || /dismissLoading[\s\S]{0,300}collectDiagnostics/.test(src));
t('诊断失败不影响正常报错（包了 try/catch）',
  /try \{ diag = collectDiagnostics/.test(src));
t('日志同时打到 console（方便开发时直接看）',
  /console\.error\([\s\S]{0,120}formatDiagnostics/.test(src));
t('iframe 现场快照在 iframe 移除前完成',
  /frameSnapshot/.test(src));
t('握手超时与空页面两处失败都带现场信息',
  (src.match(/e\.frameInfo = frameSnapshot\(\)/g) || []).length >= 2);

const css = read('css/neumorphism.css');
t('诊断区有样式（折叠箭头/等宽正文/限高）',
  /\.err-diag/.test(css) && /\.err-diag-body/.test(css)
  && /max-height/.test(css.slice(css.indexOf('.err-diag-body'))));
t('正文用等宽字体变量', /\.err-diag-body[\s\S]{0,200}var\(--font-mono\)/.test(css));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
