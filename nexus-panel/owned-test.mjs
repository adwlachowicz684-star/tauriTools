/**
 * Owned 归属通道 —— 行为测试
 *
 * 用 jsdom 造真实环境：真的挂监听、加节点、开定时器，
 * 然后 dispose 看撤没撤干净。**只查字符串会漏掉真正的逻辑错误。**
 */
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  url: 'https://localhost/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.navigator = dom.window.navigator;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame?.bind(dom.window)
  || ((cb) => setTimeout(cb, 16));
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame?.bind(dom.window)
  || ((id) => clearTimeout(id));

const { createOwned } = await import('./js/owned.js');

let pass = 0;
let fail = 0;
const t = (name, cond) => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}`); }
};

console.log('=== 1. 挂了监听 → dispose 后真的没了（行为验证）===');
{
  const a = createOwned('pluginA');
  let hits = 0;
  const handler = () => { hits += 1; };
  a.addListener(window, 'resize', handler);
  window.dispatchEvent(new dom.window.Event('resize'));
  t('挂着的时候监听生效', hits === 1);
  a.dispose();
  window.dispatchEvent(new dom.window.Event('resize'));
  t('dispose 后监听不再触发', hits === 1);
}

console.log('\n=== 2. 加的节点 → dispose 后真的移除 ===');
{
  const a = createOwned('pluginA');
  const el = document.createElement('div');
  el.className = 'plugin-modal';
  a.addNode(document.body, el);
  t('节点已挂上', document.body.contains(el));
  a.dispose();
  t('dispose 后节点已移除', !document.body.contains(el));
}

console.log('\n=== 3. 定时器 → dispose 后不再跑 ===');
{
  const a = createOwned('pluginA');
  let n = 0;
  a.setInterval(() => { n += 1; }, 5);
  await new Promise((r) => setTimeout(r, 30));
  t('定时器在跑', n > 0);
  a.dispose();
  const before = n;
  await new Promise((r) => setTimeout(r, 30));
  t('dispose 后定时器已停', n === before);
}

console.log('\n=== 4. 归因：只撤自己名下的（多插件核心）===');
{
  const A = createOwned('pluginA');
  const B = createOwned('pluginB');
  const elA = document.createElement('div');
  const elB = document.createElement('div');
  elA.className = 'a-modal';
  elB.className = 'b-modal';
  A.addNode(document.body, elA);
  B.addNode(document.body, elB);

  A.dispose();
  t('A 的节点被撤', !document.body.contains(elA));
  t('B 的节点**不受影响**（归因正确）', document.body.contains(elB));
  B.dispose();
  t('B 再撤自己的', !document.body.contains(elB));
}

console.log('\n=== 5. 幂等：dispose 多次安全 ===');
{
  const a = createOwned('pluginA');
  a.addNode(document.body, document.createElement('div'));
  const r1 = a.dispose();
  const r2 = a.dispose();
  t('第一次真的撤了', r1.undone === 1);
  t('第二次是空操作（不报错、不重复撤）', r2.undone === 0);
  t('isDisposed 正确', a.isDisposed() === true);
}

console.log('\n=== 6. 单项撤销失败不能中断其余清理 ===');
{
  /* 这一条很关键：一个撤销抛错就跳过后面的话，会比"漏一个"更严重 */
  let warned = 0;
  const a = createOwned('pluginA', { warn: () => { warned += 1; } });
  const el = document.createElement('div');
  /* 顺序很关键：撤销是 **LIFO**（后加的先撤）。
     要让"失败项"排在前面、从而验证它不会吃掉后续项，
     失败项必须**后**加 —— 第一版我写反了，于是破坏验证
     （撤销失败就 break）根本没被这条断言覆盖到，显示全绿。
     这是"断言没真正生效"的又一次出现。 */
  a.addNode(document.body, el);
  a.addUndo('x', () => { throw new Error('boom'); });   // 故意失败，且后加 → 先被撤
  const r = a.dispose();
  t('失败项被记下', r.failed === 1);
  t('后续项**照样执行**（不能中断）', r.undone === 1 && !document.body.contains(el));
  t('失败有告警', warned === 1);
}

console.log('\n=== 7. dispose 之后再加 → 立刻撤销（不留在外面）===');
{
  const a = createOwned('pluginA');
  a.dispose();
  const el = document.createElement('div');
  a.addNode(document.body, el);
  /* 异步代码在卸载后才跑的场景：不该让它漏着 */
  t('dispose 后加入的立刻被撤', !document.body.contains(el));
}

console.log('\n=== 8. 能力标签（供将来声明交叉校验）===');
{
  const a = createOwned('pluginA');
  a.addListener(window, 'resize', () => {});
  a.addNode(document.body, document.createElement('span'));
  t('记录了 global-listen', a.capabilities().includes('global-listen'));
  t('记录了 portal', a.capabilities().includes('portal'));
  a.dispose();
}

console.log('\n=== 9. 接线：module 插件拿到 owned，且卸载时自动 dispose ===');
const sdk = src('js/plugin-sdk.js');
t('plugin-sdk 引入 createOwned', /import \{ createOwned \} from '\.\/owned\.js'/.test(sdk));
t('module ctx 带 owned', /transport, bus, theme, bindShortcut, owned,/.test(sdk));
t('buildCtx 透传 owned', /onDestroy, owned \} = base;/.test(sdk));
t('ctx 上挂了 owned', /\n    owned,/.test(sdk));
t('__destroy 里自动 dispose（插件忘了也兜底）',
  /try \{ owned\.dispose\(\); \} catch \(e\) \{ console\.error\('\[owned dispose\]', e\); \}/.test(sdk));
t('dispose 在 baseDestroy **之前**', (() => {
  const i = sdk.indexOf('ctx.__destroy = async () => {');
  const seg = sdk.slice(i, i + 700);
  const jo = seg.indexOf('owned.dispose()');
  const jb = seg.indexOf('await baseDestroy()');
  return jo >= 0 && jb >= 0 && jo < jb;
})());

console.log('\n=== 10. 类型定义同步 ===');
const dts = src('js/plugin-sdk.d.ts');
t('导出 Owned 接口', /export interface Owned/.test(dts));
t('PluginContext 上有 owned', /owned: Owned;/.test(dts));
t('注释说明 iframe 侧记了也无害（不夸大）', /随 iframe 一起消失|iframe 自己 window/.test(dts));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
