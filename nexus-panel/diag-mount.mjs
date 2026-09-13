/**
 * 诊断：模拟真实 index.html 的加载与插件挂载，看内容到底有没有渲染出来。
 * 目的是复现"只看见标题、看不见内容"，不是常规断言测试。
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

const html = readFileSync('./index.html', 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
globalThis.localStorage = window.localStorage;
globalThis.getComputedStyle = window.getComputedStyle;
globalThis.navigator = window.navigator;
globalThis.HTMLElement = window.HTMLElement;
globalThis.self = window;
globalThis.location = window.location;
globalThis.URL = window.URL;
globalThis.CustomEvent = window.CustomEvent;
globalThis.Event = window.Event;
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = clearTimeout;
globalThis.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener(){}, removeEventListener(){} }));

const errors = [];
window.addEventListener('error', (e) => errors.push('window error: ' + e.message));
const origErr = console.error;
console.error = (...a) => { errors.push('console.error: ' + a.join(' ')); origErr(...a); };
console.warn = () => {};

console.log('=== DOM 结构检查 ===');
for (const id of ['app', 'titlebar', 'sidebar', 'plugin-list', 'main', 'stage', 'stage-scroll', 'bar-title']) {
  const el = window.document.getElementById(id);
  console.log(`  #${id}: ${el ? '存在' : '❌ 不存在'}`);
}

console.log('\n=== 加载 shell.js ===');
try {
  const shellSrc = readFileSync('./js/shell.js', 'utf8');
  // shell.js 是 ESM，jsdom 无法直接跑；这里只做静态检查
  console.log('  shell.js 大小:', shellSrc.length);
} catch (e) {
  console.log('  读取失败:', e.message);
}

console.log('\n=== 直接驱动 host 引擎挂载插件 ===');
try {
  const host = await import('./js/host.js');
  const reg = await import('./plugins/registry.js');
  console.log('  注册表插件数:', (reg.plugins || []).length);

  const stage = window.document.getElementById('stage-scroll');
  console.log('  stage-scroll 存在:', !!stage);

  const log = [];
  const h = host.createHost({
    getStage: () => window.document.getElementById('stage-scroll'),
    hooks: {
      onTitle: (t) => log.push('onTitle: ' + t),
      onSubtitle: (s) => log.push('onSubtitle: ' + s),
      onActive: (id) => log.push('onActive: ' + id),
      onBadges: () => {},
      onSettingsAvailable: (v) => log.push('onSettingsAvailable: ' + v),
      onAdaptInfo: (i) => log.push('onAdaptInfo: ' + JSON.stringify(i)),
    },
  });

  const list = await h.refresh();
  console.log('  refresh 后插件数:', list.length);
  console.log('  回调:', log);

  // 逐个挂载所有插件，看每个的结果
  for (const p of (reg.plugins || [])) {
    const before = stage.innerHTML.length;
    await h.mount(p.id);
    const after = stage.innerHTML;
    const kind = after.includes('<iframe') ? 'iframe'
      : after.includes('class="loader"') ? 'loader(卡住)'
      : after.includes('error-box') || after.includes('class="err') ? '错误态'
      : after.length > 50 ? '有内容' : '空白';
    console.log(`  [${p.id}] type=${p.type} → ${kind} (${after.length} 字节, 原 ${before})`);
    if (kind === '错误态' || kind === 'loader(卡住)') {
      console.log('     片段:', after.slice(0, 200).replace(/\s+/g, ' '));
    }
  }
} catch (e) {
  console.log('  ❌ 异常:', e.message);
  console.log(e.stack?.split('\n').slice(0, 5).join('\n'));
}

console.log('\n=== 捕获到的错误 ===');
console.log(errors.length ? errors.slice(0, 10).join('\n') : '  无');
