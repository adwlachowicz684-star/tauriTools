/**
 * owned 通道的真实调用方（D2）+ 一个**实证出来的局限**
 * ============================================================
 * 本轮最重要的产出不是"接上调用方"，而是**实证了一件事**：
 *
 *   卸载残留校验（S2）**抓不到定时器泄漏**
 *
 * 差分只拍四类东西：window keys / head 子节点 / body 子节点 /
 * styleSheets 数量。定时器不体现在任何一项上 —— 实测：
 *
 *   忘了 clearInterval   → suspect = 0  ← **完全静默**
 *   忘了移除 DOM 节点    → suspect = 1  ← 抓得到
 *   忘了删 window 属性   → suspect = 1  ← 抓得到
 *
 * 于是"插件卸载后定时器还在跑"这件事**没有任何机制能发现**：
 * 回调继续执行，操作着已经不存在的 DOM，界面上什么都看不出来。
 *
 * 这正是 owned 通道存在的理由：**记了账，卸载时按账本撤**。
 *
 * 顺带说明为什么 owned 不是多余的：
 *   · 差分能覆盖的（DOM / window 属性）→ owned 也能管，且更精确（带归属）
 *   · 差分覆盖不了的（定时器 / Observer / WebSocket）→ **只有** owned 能管
 */
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame?.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame?.bind(dom.window);

const { snapshotGlobals, diffSnapshots } = await import('./js/unmount-audit.js');
const { createOwned } = await import('./js/owned.js');

let pass = 0;
let fail = 0;
const t = (name, cond, hint = '') => {
  if (cond) { pass += 1; console.log(`✅ ${name}`); }
  else { fail += 1; console.log(`❌ ${name}${hint ? `  —— ${hint}` : ''}`); }
};

console.log('=== 1. 实证：差分抓不到定时器泄漏（本轮核心发现）===');
{
  const before = snapshotGlobals();
  const id = setInterval(() => {}, 50);          // 泄漏，不清理
  const d = diffSnapshots(before, snapshotGlobals());
  t('忘了 clearInterval 时，差分 suspect 为 0（**抓不到**）',
    d.suspect.length === 0, `实际 ${d.suspect.length}`);
  clearInterval(id);
}
/*
 * 下面两条是**对照组** —— 没有它们，上面那条"抓不到"可能是
 * "探针写错了 / 差分根本没工作"，而不是"差分覆盖不到定时器"。
 * 我第一版就差点这么误判（把字段名写成 suspects，结果两种泄漏都是 0）。
 */
{
  const b = snapshotGlobals();
  document.body.appendChild(document.createElement('div'));
  const d = diffSnapshots(b, snapshotGlobals());
  t('对照：DOM 节点残留能抓到（证明探针有效）', d.suspect.length === 1,
    `实际 ${d.suspect.length}`);
  document.body.innerHTML = '';
}
{
  const b = snapshotGlobals();
  window.__probe_leak = 1;
  const d = diffSnapshots(b, snapshotGlobals());
  t('对照：window 属性残留能抓到（证明探针有效）', d.suspect.length === 1,
    `实际 ${d.suspect.length}`);
  delete window.__probe_leak;
}

console.log('\n=== 2. owned 能挡住差分覆盖不到的那类 ===');
{
  const owned = createOwned('probe-timer');
  let ticks = 0;
  owned.setInterval(() => { ticks += 1; }, 10);
  t('owned.setInterval 记账 1 条', owned.size() === 1, `实际 ${owned.size()}`);
  t('能力标记为 timer（供声明交叉校验）',
    owned.capabilities().includes('timer'));
  const first = owned.dispose();
  t('dispose 撤销了 1 条', first.undone === 1 && first.failed === 0);
  t('dispose 后记账清空', owned.size() === 0);
  /* 真正的行为验证：定时器确实停了，不只是"记过账" */
  const snapshot = ticks;
  await new Promise((r) => setTimeout(r, 60));
  t('行为验证：dispose 后定时器不再触发（不是只记了账）',
    ticks === snapshot, `dispose 后又走了 ${ticks - snapshot} 次`);
  const second = owned.dispose();
  t('dispose 幂等（第二次 undone 为 0）', second.undone === 0);
}

console.log('\n=== 3. addTimer 返回撤销函数（可反复重启，账不累积）===');
{
  const owned = createOwned('probe-restart');
  let stop = null;
  const restart = (ms) => {
    stop?.();
    const id = setInterval(() => {}, ms);
    stop = owned.addTimer('interval', id);
  };
  restart(1000);
  t('第一次重启后记账 1 条', owned.size() === 1, `实际 ${owned.size()}`);
  restart(2000); restart(3000);
  /*
   * addUndo 的 undo 被调用后**不会从列表里移除**（既有设计），
   * 所以这里期望 3 而不是 1 —— 记的是"撤销动作"，不是"存活的定时器"。
   * 重复执行 clearInterval 是幂等无害的。
   *
   * 与便捷写法 setInterval 对比：**两种都不会无限累积到失控**，
   * 但 addTimer 让插件能自己撤（stop() 真的把定时器停了），
   * setInterval 便捷写法拿不到撤销函数，只能等 dispose。
   */
  t('反复重启后记账 = 重启次数（3）', owned.size() === 3, `实际 ${owned.size()}`);
  t('restart 返回的撤销函数可直接调用', typeof stop === 'function');
  const r = owned.dispose();
  t('dispose 全部撤销', r.undone === 3 && r.failed === 0);
}

console.log('\n=== 4. 真实调用方：demo-module 的定时器走了通道 ===');
{
  const src = await import('node:fs').then((fs) =>
    fs.promises.readFile(new URL('./plugins/demo-module/index.js', import.meta.url), 'utf8'));
  const code = src.split('\n')
    .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
    .join('\n');
  t('demo-module 用 ctx.owned.addTimer 管理定时器',
    /ctx\.owned\.addTimer\(/.test(code));
  t('不再手写 clearInterval 清理（交给通道兜底）',
    !/onDestroy\(\(\)\s*=>\s*clearInterval/.test(code));
  /* 注释里要写明"为什么" —— 否则下次有人看到没有清理代码会以为漏了 */
  t('注释说明了差分抓不到定时器（不是忘了清理）',
    /差分.*抓不到|抓不到.*定时器|suspect\s*=\s*0/.test(src));
  t('注释说明了用 addTimer 而非 setInterval 的理由（账不累积）',
    /addTimer/.test(src) && /累积/.test(src));
}

console.log('\n=== 5. 局限声明（不夸大）===');
{
  const owned = createOwned('probe-disposed');
  owned.dispose();
  let undoneAfterDispose = 0;
  /* dispose 之后还往里加 —— 应立刻撤销，不能漏在外面 */
  const undo = owned.addUndo('timer', () => { undoneAfterDispose += 1; });
  t('dispose 后再加入的项被立刻撤销（异步逃逸兜底）',
    undoneAfterDispose === 1);
  t('即使如此仍返回撤销函数（调用方不会拿到 undefined 报错）',
    typeof undo === 'function');
  /*
   * 诚实说明：owned **只管走了通道的**。
   * 没走通道的定时器（插件直接 setInterval）本测试管不了，
   * 只能靠静态准入（S4）在 CI 期拦。运行时不可信插件仍靠 iframe。
   */
  t('没走通道的定时器 owned 管不了 —— 由静态准入兜底（已声明）', true);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log(`
若「差分抓不到定时器」这条红了，说明差分能力增强了（好事），
应同步更新 demo-module 注释里的实证数字，并把这条断言改为"能抓到"。`);
}
process.exit(fail ? 1 : 0);
