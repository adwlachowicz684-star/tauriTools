/**
 * 隔离态下的桥接能力测试（开发用，可删）
 * ------------------------------------------------------------
 * 要证明的核心命题：
 *   「严格沙箱」切断的是**直连通道**，不是**能力**。
 *
 * 隔离（sandbox 无 allow-same-origin）后插件变成 opaque origin：
 *   ✗ 碰不到 parent.document / parent.localStorage / Tauri IPC
 *   ✓ 但 postMessage 桥接照常工作，而桥接服务端跑在**主平台侧**，
 *     所以 ctx.invoke / store / 事件 / 通知 / 主题 全部照常可用。
 *
 * 本测试用 jsdom 模拟隔离 iframe（contentWindow 受限 + localStorage 抛错），
 * 逐项验证每个 ctx 能力是否仍通过桥接正常工作。
 */
import { JSDOM } from 'jsdom';

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 构造一个「隔离」的 iframe 环境 ---------- */
const dom = new JSDOM(
  '<!doctype html><html><body><div id="plugin-mount"></div></body></html>',
  { url: 'http://localhost/plugin/index.html' },
);
const win = dom.window;

// 模拟 opaque origin：访问 parent / localStorage 都抛 SecurityError
Object.defineProperty(win, 'parent', {
  get() { throw new win.DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError'); },
  configurable: true,
});
const throwingStorage = new Proxy({}, {
  get() { throw new win.DOMException('localStorage is not available for opaque origins', 'SecurityError'); },
});
Object.defineProperty(win, 'localStorage', { get: () => throwingStorage, configurable: true });

globalThis.window = win;
globalThis.document = win.document;
globalThis.Node = win.Node;
globalThis.HTMLElement = win.HTMLElement;
globalThis.KeyboardEvent = win.KeyboardEvent;
globalThis.MessageEvent = win.MessageEvent;
globalThis.getComputedStyle = win.getComputedStyle;
globalThis.DOMException = win.DOMException;

// 模拟 Tauri IPC 在隔离 iframe 里不可达
win.__TAURI_INTERNALS__ = undefined;

/* ---------- 主平台侧：记录插件发来的桥接请求 ---------- */
const shellGot = [];
const shellState = {
  store: {},            // 模拟主平台的 localStorage
  invoked: [],
  notified: [],
  subscribed: [],
  published: [],
  theme: { '--bg': '#2b2f36' },
};

// 拦截插件 postMessage（插件用 window.parent.postMessage，但 parent 被我们改成抛错了，
// 所以这里直接劫持插件侧的发送通道：替换 window.parent 前先保存原始 postMessage 行为）
// 实际插件代码里 post(msg) 调用的是 window.parent.postMessage(...)。
// 为了让测试能跑通，我们给 win 挂一个可写的 parent（非抛错），但标记 isolated。
Object.defineProperty(win, 'parent', {
  get() {
    return {
      postMessage: (msg) => {
        shellGot.push(msg);
        // 主平台侧应答
        setTimeout(() => handleOnShell(msg), 0);
      },
    };
  },
  configurable: true,
});

/** 主平台侧桥接服务端（对应 host.js 的 handleBridgeRequest） */
function handleOnShell(msg) {
  const reply = (ok, data, error) => {
    win.dispatchEvent(new win.MessageEvent('message', {
      data: { channel: 'nexus-bridge-v1', type: 'res', id: msg.id, ok, data, error },
    }));
  };
  if (msg.type === 'req') {
    const { method, payload } = msg;
    switch (method) {
      case 'invoke':
        shellState.invoked.push(payload);
        return reply(true, 'rust-result:' + payload.cmd);
      case 'store.get':
        return reply(true, shellState.store[payload.k] ?? payload.def);
      case 'store.set':
        shellState.store[payload.k] = payload.v;
        return reply(true, true);
      case 'store.all':
        return reply(true, { ...shellState.store });
      case 'shell.call': {
        const { ns, method: m, args } = payload;
        shellGot.push({ shellCall: `${ns}.${m}` });
        if (ns === 'external' && m === 'listHosts') return reply(true, [{ host: 'a.example.com', status: 'pending', kind: 'script' }]);
        if (ns === 'pluginConfig' && m === 'getPluginConfig') return reply(true, { isolated: true, adaptTheme: true });
        return reply(true, null);
      }
      case 'shell.isIsolated':
        return reply(true, true);
      default:
        return reply(false, null, '未知方法 ' + method);
    }
  }
  if (msg.type === 'notify') {
    shellState.notified.push({ type: msg.notifyType, payload: msg.payload });
  }
  if (msg.type === 'subscribe') shellState.subscribed.push(msg.event);
  if (msg.type === 'publish') shellState.published.push({ event: msg.event, payload: msg.payload });
}

const { bootIframePlugin } = await import('./js/plugin-sdk.js');

let ctx = null;
bootIframePlugin(async (c) => { ctx = c; });

const deliver = (data) => win.dispatchEvent(new win.MessageEvent('message', { data }));

// init 时告知插件：你处于隔离态
deliver({
  channel: 'nexus-bridge-v1',
  type: 'init',
  manifest: { id: 'iso-plugin', name: '隔离插件', version: '1.0.0' },
  theme: shellState.theme,
  view: 'main',
  isolated: true,
  reportBase: true,
});
await sleep(80);
deliver({ channel: 'nexus-bridge-v1', type: 'mount' });
await sleep(120);

console.log('--- 隔离态下的能力验证 ---');
t('插件已挂载并拿到 ctx', !!ctx);

/* 1. 调 Rust：桥接在主平台侧执行，不依赖插件自己的 __TAURI_INTERNALS__ */
let r;
try {
  r = await ctx.invoke('rust_ping', { payload: 'x' });
} catch (e) { r = 'ERR ' + e.message; }
t('ctx.invoke 调 Rust 可用', r === 'rust-result:rust_ping', String(r));
t('  └ IPC 确实由主平台侧执行', shellState.invoked.some((x) => x.cmd === 'rust_ping'));

/* 2. 持久化：localStorage 在隔离态抛错，但 store 走桥接 → 由主平台代存 */
let storeOk = true, storeVal = null;
try {
  await ctx.store.set('k1', { a: 1 });
  storeVal = await ctx.store.get('k1', null);
} catch (e) { storeOk = false; }
t('ctx.store 读写可用（绕过不可用的 localStorage）',
  storeOk && storeVal && storeVal.a === 1, JSON.stringify(storeVal));
t('  └ 数据落在主平台侧', shellState.store.k1?.a === 1);

/* 3. 事件总线：跨插件通信经主平台中转，不直连 */
ctx.emit('demo:ping', { from: 'iso' });
await sleep(60);
t('ctx.emit 广播经主平台中转',
  shellState.published.some((x) => x.event === 'demo:ping'),
  JSON.stringify(shellState.published));

const off = ctx.on('other:event', () => {});
await sleep(40);
t('ctx.on 订阅可达主平台总线',
  shellState.subscribed.includes('other:event'), shellState.subscribed.join(','));
off?.();

/* 4. 通知类能力 */
ctx.setTitle('新标题');
ctx.setBadge(3);
ctx.toast('来自隔离插件');
await sleep(60);
const kinds = shellState.notified.map((x) => x.type);
t('setTitle / setBadge / toast 均可用',
  ['title', 'badge', 'toast'].every((k) => kinds.includes(k)), kinds.join(','));

/* 5. 外壳能力桥接（新增的 ctx.shell） */
let hosts = null, cfg = null, iso = null;
try {
  hosts = await ctx.shell.external.list();
  cfg = await ctx.shell.pluginConfig.get('iso-plugin');
  iso = await ctx.shell.isIsolated();
} catch (e) { /* 见下方断言 */ }
t('ctx.shell.external 可用（隔离下仍可管理外链）',
  Array.isArray(hosts) && hosts[0]?.host === 'a.example.com', JSON.stringify(hosts));
t('ctx.shell.pluginConfig 可用', cfg && cfg.isolated === true, JSON.stringify(cfg));
t('ctx.shell.isIsolated 如实报告隔离态', iso === true, String(iso));

/* 6. 主题：由主平台推送，不依赖插件自己读 */
t('主题变量已注入插件（init 时推送）',
  win.document.getElementById('nexus-theme-vars')?.textContent?.includes('--bg') === true,
  win.document.getElementById('nexus-theme-vars')?.textContent?.slice(0, 40));

// 主平台切换主题 → 推送 → 插件即时换肤
deliver({ channel: 'nexus-bridge-v1', type: 'theme', theme: { '--bg': '#f0ece4' } });
await sleep(60);
t('运行时主题切换可推送（无需重载）',
  win.document.getElementById('nexus-theme-vars')?.textContent?.includes('#f0ece4') === true);
t('主题应用后回执 theme-applied（外壳据此才去采样，避免读到旧色）',
  shellGot.some((m) => m.type === 'theme-applied'),
  `收到 ${shellGot.filter((m) => m.type === 'theme-applied').length} 次回执`);

/* 7. 隔离态自报基调（主题适配的兜底通道） */
const baseReports = shellGot.filter((m) => m.type === 'base-report');
t('隔离态下插件自报了基调（否则主题适配会静默失效）',
  baseReports.length > 0, `上报 ${baseReports.length} 次，base=${baseReports[0]?.base}`);

/* 8. 直连通道确实被切断（这是隔离的目的） */
let directBlocked = false;
try {
  // eslint-disable-next-line no-unused-expressions
  win.localStorage.getItem('x');
} catch { directBlocked = true; }
t('（对照）直连 localStorage 确实被切断', directBlocked);
t('（对照）插件内无 Tauri IPC 全局', win.__TAURI_INTERNALS__ === undefined);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
console.log('\n结论：隔离切断直连通道，ctx.* 能力经主平台侧桥接完整保留。');
process.exit(fail ? 1 : 0);
