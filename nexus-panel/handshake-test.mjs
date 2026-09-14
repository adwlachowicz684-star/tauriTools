/**
 * iframe 握手协议测试（开发用，可删）
 *
 * 这个 bug 反复出现：握手修复被并行开发线整体覆盖回去，已经第三轮。
 * 症状是所有 iframe 插件挂载失败（10s 超时），表现为"只看得见标题、看不见内容"。
 *
 * 死锁链条（修复前的写法）：
 *   外壳：await ready  →  才发 mount
 *   ready 只由 mounted / error 解决
 *   SDK ：收到 mount   →  才发 mounted
 *   SDK ：收到 init    →  才发 ready          ← 环在这里闭合
 *   外壳：收到 ready   →  才发 init
 *   结果：谁也等不到谁，10 秒后统一超时。
 *
 * 正确顺序：
 *   SDK 脚本就绪 → 主动发 ready → 外壳回 init + mount → SDK 挂载 → 发 mounted
 *
 * 本测试分两层：
 *   1. 行为层：把真实 plugin-sdk.js 跑起来，断言它在**没收到任何消息**时就发出 ready
 *   2. 源码层：断言外壳在 ready 分支内连发 init + mount，且 await ready 之后不再发
 *      （源码层是给"又被整体覆盖"这种情况兜底的 —— 行为层测不到 host.js）
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* ============ 1. 行为层：真实 SDK 是否主动发 ready ============ */
console.log('\n=== 1. SDK 主动上报（行为层） ===');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
  url: 'http://localhost/plugin.html',
  pretendToBeVisual: true,
});
const { window: sdkWin } = dom;

// SDK 是 ESM 且 import 了 tauri-core；这里给它一个最小全局环境
const posted = [];
sdkWin.parent = { postMessage: (msg) => posted.push(msg) };
globalThis.window = sdkWin;
globalThis.document = sdkWin.document;
globalThis.localStorage = sdkWin.localStorage;
globalThis.location = sdkWin.location;
// Node 21+ 起 globalThis.navigator 是只读 getter，直接赋值会抛 TypeError
Object.defineProperty(globalThis, 'navigator', { value: sdkWin.navigator, configurable: true, writable: true });
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { bootIframePlugin } = await import('./js/plugin-sdk.js');

// 主视图 + 设置视图都提供，验证 hasSettings 上报
const seen = [];
bootIframePlugin(
  (ctx) => { seen.push('main'); ctx.root.appendChild(document.createElement('div')); },
  (ctx) => { seen.push('settings'); },
);

// 关键断言：还没收到任何 init，SDK 就该已经发出 ready
t('未收到 init 就主动发了 ready', posted.some((m) => m.type === 'ready'));
t('ready 里上报了 hasSettings',
  posted.find((m) => m.type === 'ready')?.hasSettings === true);

/* 模拟外壳回发 init + mount（这正是修复后的顺序） */
const channel = posted[0]?.channel;
const deliver = (msg) => {
  // 必须带 source：SDK 用 `e.source !== window.parent` 做来源校验，
  // 缺了它所有消息都会被静默丢弃（表现为 mount 不执行、握手"死锁"）。
  const ev = new sdkWin.MessageEvent('message', {
    data: { channel, ...msg },
    source: sdkWin.parent,
  });
  sdkWin.dispatchEvent(ev);
};

deliver({
  type: 'init',
  manifest: { id: 'demo', name: '示例' },
  theme: { '--bg': '#2b2f36' },
  view: 'main',
  isolated: false,
  reportBase: false,
});

t('收到 init 不再重复发 ready（否则 ready↔init 无限往返）',
  posted.filter((m) => m.type === 'ready').length === 1,
  `${posted.filter((m) => m.type === 'ready').length} 次`);

deliver({ type: 'mount' });
await new Promise((r) => setTimeout(r, 30));
t('收到 mount 后执行了挂载', seen.includes('main'), seen.join(','));
t('挂载后回发 mounted', posted.some((m) => m.type === 'mounted'));

/* 重复 mount 不应该二次挂载 */
deliver({ type: 'mount' });
await new Promise((r) => setTimeout(r, 30));
t('重复 mount 不会二次挂载（幂等）',
  seen.filter((x) => x === 'main').length === 1,
  `main 执行了 ${seen.filter((x) => x === 'main').length} 次`);

/* ============ 2. 源码层：外壳的发送时机 ============ */
console.log('\n=== 2. 外壳发送时机（源码层） ===');
const host = readFileSync('./js/host.js', 'utf8');

// 取 mountIframeView 函数体
const fnStart = host.indexOf('async function mountIframeView');
const fnBody = host.slice(fnStart, host.indexOf('\n  }', fnStart));

const readyIdx = fnBody.indexOf("case 'ready'");
const readyBlock = fnBody.slice(readyIdx, fnBody.indexOf("case 'base-report'", readyIdx));
t('ready 分支内发了 init', /type:\s*'init'/.test(readyBlock));
t('ready 分支内发了 mount', /type:\s*'mount'/.test(readyBlock));
t('ready 分支有单次握手保护（handshaked）', /handshaked/.test(readyBlock));

// await ready 之后不应再发 mount —— 那就是死锁写法
// 注意按"整行就是 await ready;"来匹配：注释里也提到过这个词，
// 用 indexOf 会命中注释，导致检查的是错误位置。
const awaitM = /(?:^|\n)[ \t]*await ready[ \t]*;/m.exec(fnBody);
const afterAwait = awaitM
  ? fnBody.slice(awaitM.index + awaitM[0].length, awaitM.index + awaitM[0].length + 900)
  : '';
t('能定位到 await ready 语句', !!awaitM);
t('await ready 之后不再发 mount（否则互等死锁）',
  !/send\(\s*iframe\s*,\s*\{\s*type:\s*'mount'\s*\}\s*\)/.test(afterAwait));

/* ============ 3. 完整协议推演 ============ */
console.log('\n=== 3. 协议推演（不应死锁） ===');
/* 用状态机模拟：SDK 只在收到 mount 后发 mounted；
   外壳只在收到 ready 后发 init+mount。看能否在有限步内到达 mounted。 */
let gotReady = false, gotInit = false, gotMount = false, gotMounted = false;
const step = () => {
  if (!gotReady) { gotReady = true; return 'ready'; }        // SDK 脚本就绪
  if (gotReady && !gotInit) { gotInit = true; return 'init'; } // 外壳回 init
  if (gotInit && !gotMount) { gotMount = true; return 'mount'; } // 连发 mount
  if (gotMount && !gotMounted) { gotMounted = true; return 'mounted'; }
  return 'stuck';
};
const seq = [];
for (let i = 0; i < 6; i++) {
  const m = step();
  seq.push(m);
  if (m === 'mounted' || m === 'stuck') break;
}
t('协议在有限步内完成', gotMounted, seq.join(' → '));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
