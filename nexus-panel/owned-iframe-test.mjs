/**
 * Owned 归属通道 —— **iframe 侧**契约兑现测试
 * ============================================================
 * 背景
 * ------------------------------------------------------------
 * `plugin-sdk.d.ts` 声明的是 `owned: Owned`（**必选**，不是 `owned?`），
 * 注释还写着"iframe 插件也会拿到（保持 ctx 形状一致）"。
 * 而实现里 `createOwned(...)` 只在**同页（module）路径**创建，
 * iframe 的 buildCtx 压根没传 —— 于是 `ctx.owned === undefined`。
 *
 * 三处注释（owned.js / buildCtx / d.ts）都承诺了，实现没兑现。
 *
 * 为什么此前一条都没红
 * ------------------------------------------------------------
 *   · d.ts 有声明        → 类型检查不报错
 *   · 现有 iframe 插件都没用这个字段 → 没人踩
 *   · owned-test.mjs 关于 iframe 的那条断言**只验注释文本**：
 *       t('注释说明 iframe 侧记了也无害', /随 iframe 一起消失/.test(dts))
 *     —— 注释在，它就绿；实现给不给，它一概不知。
 *
 * 所以本文件**只做行为层**：真跑 bootIframePlugin、真拿 ctx、真挂监听。
 * 只查字符串会漏掉真正的逻辑错误 —— 这是本项目反复栽的那一类。
 */
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p) => readFileSync(join(HERE, p), 'utf8');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* ============================================================
   1. 行为层：iframe 插件真的拿到 owned 吗（本文件存在的理由）
   ============================================================ */
console.log('=== 1. iframe 侧 owned 非空（行为层）===');

const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
  url: 'http://localhost/plugin.html',
  pretendToBeVisual: true,
});
const { window: sdkWin } = dom;

const posted = [];
sdkWin.parent = { postMessage: (msg) => posted.push(msg) };
globalThis.window = sdkWin;
globalThis.document = sdkWin.document;
globalThis.localStorage = sdkWin.localStorage;
globalThis.location = sdkWin.location;
// Node 21+ 起 globalThis.navigator 是只读 getter，直接赋值会抛 TypeError
Object.defineProperty(globalThis, 'navigator', {
  value: sdkWin.navigator, configurable: true, writable: true,
});
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { bootIframePlugin } = await import('./js/plugin-sdk.js');

let ctxGot = null;
bootIframePlugin((ctx) => { ctxGot = ctx; });

const channel = posted[0]?.channel;
// 必须带 source：SDK 用 `e.source !== window.parent` 做来源校验，
// 缺了它所有消息会被静默丢弃（表现为 ctx 一直是 null）。
const deliver = (msg) => {
  const ev = new sdkWin.MessageEvent('message', {
    data: { channel, ...msg },
    source: sdkWin.parent,
  });
  sdkWin.dispatchEvent(ev);
};

deliver({
  type: 'init',
  manifest: { id: 'demo-iframe', name: '示例' },
  theme: { '--bg': '#2b2f36' },
  view: 'main',
  isolated: false,
});
deliver({ type: 'mount' });
await new Promise((r) => setTimeout(r, 30));

t('挂载成功拿到 ctx（前置条件，否则后面全是假绿）', !!ctxGot);

/* 这三条是本文件的核心：不是"注释说有"，而是**真的有、真的能用** */
t('iframe ctx 上 owned **非空**（契约兑现）', !!ctxGot?.owned);
t('owned 带 pluginId（归属正确）', ctxGot?.owned?.pluginId === 'demo-iframe',
  String(ctxGot?.owned?.pluginId));
t('owned 是可用句柄（有 addListener）', typeof ctxGot?.owned?.addListener === 'function');

/* ============================================================
   2. 行为层：给了还得**真能用**
   —— 只验"非空"会放过"给了个空壳"的假兑现
   ============================================================ */
console.log('\n=== 2. iframe 侧 owned 真的能用（行为层）===');
{
  const owned = ctxGot?.owned;
  if (owned) {
    let hits = 0;
    const handler = () => { hits += 1; };
    owned.addListener(sdkWin, 'resize', handler);
    sdkWin.dispatchEvent(new sdkWin.Event('resize'));
    t('挂着的时候监听生效', hits === 1, `hits=${hits}`);

    t('登记后 size() 记到了（真的在记账，不是空壳）', owned.size() === 1, `size=${owned.size()}`);
    t('能力标签被记录', owned.capabilities().includes('global-listen'));

    owned.dispose();
    sdkWin.dispatchEvent(new sdkWin.Event('resize'));
    t('dispose 后监听不再触发', hits === 1, `hits=${hits}`);
    t('dispose 幂等（重复调用安全）', owned.dispose().undone === 0);
  } else {
    // owned 为空时上面的断言根本没跑 —— 必须显式记为失败，
    // 不能让它"因为前置不成立而静默通过"。
    t('owned 可用（前置为空，无法验证）', false, 'ctx.owned 为空');
    t('owned 记账（前置为空，无法验证）', false, 'ctx.owned 为空');
    t('owned 能力标签（前置为空，无法验证）', false, 'ctx.owned 为空');
    t('owned dispose 生效（前置为空）', false, 'ctx.owned 为空');
    t('owned dispose 幂等（前置为空）', false, 'ctx.owned 为空');
  }
}

/* ============================================================
   3. 行为层：__destroy 兜底 —— 插件忘了 dispose 也得撤
   ============================================================ */
console.log('\n=== 3. 卸载兜底（插件忘了也撤）===');
{
  // 重新起一份干净的 ctx：上面的已经 dispose 过了
  const dom2 = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'http://localhost/plugin2.html', pretendToBeVisual: true,
  });
  const w2 = dom2.window;
  const posted2 = [];
  w2.parent = { postMessage: (m) => posted2.push(m) };
  globalThis.window = w2;
  globalThis.document = w2.document;
  globalThis.localStorage = w2.localStorage;
  globalThis.location = w2.location;
  Object.defineProperty(globalThis, 'navigator', {
    value: w2.navigator, configurable: true, writable: true,
  });
  globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
  globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

  let ctx2 = null;
  bootIframePlugin((c) => { ctx2 = c; });
  const ch2 = posted2[0]?.channel;
  const deliver2 = (msg) => w2.dispatchEvent(new w2.MessageEvent('message', {
    data: { channel: ch2, ...msg }, source: w2.parent,
  }));
  deliver2({ type: 'init', manifest: { id: 'p2', name: 'P2' }, view: 'main' });
  deliver2({ type: 'mount' });
  await new Promise((r) => setTimeout(r, 30));

  if (ctx2?.owned) {
    let hits = 0;
    ctx2.owned.addListener(w2, 'resize', () => { hits += 1; });
    w2.dispatchEvent(new w2.Event('resize'));
    t('挂载后监听生效（前置）', hits === 1, `hits=${hits}`);

    // 插件**故意不调** owned.dispose，直接走宿主卸载路径
    await ctx2.__destroy?.();
    w2.dispatchEvent(new w2.Event('resize'));
    t('__destroy 兜底撤掉了监听（插件忘了也撤）', hits === 1, `hits=${hits}`);
    t('__destroy 后 owned 已标记 disposed', ctx2.owned.isDisposed() === true);
  } else {
    t('__destroy 兜底撤监听', false, 'ctx.owned 为空');
    t('__destroy 后 disposed 标记', false, 'ctx.owned 为空');
  }
}

/* ============================================================
   4. 源码层：防"又被整体覆盖回去"
   —— 行为层测不到"将来有人把这段删了又没跑这个测试"，
      但源码层能给出明确归因（指到文件和行）。
      本项目同类修复被并行开发线覆盖回去已不止一次。
   ============================================================ */
/* 传参两种写法都要认：独立成行 `owned,` 与行内跟随 `bindShortcut, owned,`。
   只认前一种会漏掉 module 侧（它就是行内跟随）—— 判据必须覆盖既有写法。 */
const hasOwnedArg = (block) => /[,{[ \t]owned\s*,/.test(block);

console.log('\n=== 4. 源码层（防覆盖回去）===');
{
  const sdk = src('js/plugin-sdk.js');
  // 取 iframe 的 buildCtx 调用块：以 mode: 'iframe' 为锚
  const iAnchor = sdk.indexOf("mode: 'iframe'");
  t('能定位到 iframe 的 buildCtx 调用（锚点存在）', iAnchor >= 0);
  const callBlock = iAnchor >= 0 ? sdk.slice(iAnchor, sdk.indexOf('});', iAnchor)) : '';

  t('iframe 的 buildCtx **传了** owned', hasOwnedArg(callBlock));

  // 光"传了"不够 —— 传的必须真是 createOwned 造出来的句柄。
  // 取锚点**之前最近**的一处声明：整仓第一处是 module 侧的，用它判必错。
  const iCreate = iAnchor >= 0 ? sdk.lastIndexOf('const owned = createOwned(', iAnchor) : -1;
  t('iframe 路径里真的建了 owned（不是传了个 undefined）',
    iCreate >= 0 && iAnchor - iCreate < 3000,
    iCreate >= 0 ? `距锚点 ${iAnchor - iCreate} 字符` : '未找到');

  // __destroy 里必须 dispose，否则"给了也收不回"
  const destroyBlock = sdk.slice(iAnchor, iAnchor + 900);
  t('iframe 的 __destroy 里 dispose（给了要收得回）', /owned\.dispose\(\)/.test(destroyBlock));

  /* 元断言：上面几条判据一旦被人改空，必须有人喊。
     少了这几条，把判据清空后本节照样全绿。 */
  t('元断言：判据能命中**独立成行**的写法',
    hasOwnedArg("mode: 'iframe',\n        owned,\n        openArgs,"));
  t('元断言：判据能命中**行内跟随**的写法',
    hasOwnedArg('transport, bus, theme, bindShortcut, owned,\n    services,'));
  t('元断言：判据不误伤 openArgs 等无关标识符',
    !hasOwnedArg('const x = 1;\n  openArgs,\n  bindShortcut,\n'));
}

/* ============================================================
   5. 契约层：d.ts 与实现的一致性
   ============================================================ */
console.log('\n=== 5. 契约层 ===');
{
  const dts = src('js/plugin-sdk.d.ts');
  const sdk = src('js/plugin-sdk.js');

  t('d.ts 声明 owned 为**必选**（不是 owned?）', /^\s*owned:\s*Owned;/m.test(dts));

  // 这条是 owned-test.mjs 里那条"只验注释"的缺口：
  // 注释说 iframe 也会拿到 —— 这里改验**实现**是否真的给了。
  const iAnchor = sdk.indexOf("mode: 'iframe'");
  const callBlock = iAnchor >= 0 ? sdk.slice(iAnchor, sdk.indexOf('});', iAnchor)) : '';
  t('注释承诺的"iframe 也会拿到"——实现**真的给了**（不只是注释）',
    hasOwnedArg(callBlock));

  // 两种模式给的是同一份 API（形状一致）—— 否则插件换模式就得改代码
  const moduleBlock = (() => {
    const i = sdk.indexOf("mode: 'module'");
    return i >= 0 ? sdk.slice(i, sdk.indexOf('});', i)) : '';
  })();
  t('module 侧也传了 owned（两种模式形状一致）', hasOwnedArg(moduleBlock));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
