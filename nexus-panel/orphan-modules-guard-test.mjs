/**
 * 孤儿模块欠账守卫 —— 「测通了但没接进产品」的模块必须有账
 * ============================================================================
 *
 * 起因（主面板代码梳理的实测更正）：
 *   插件市场阶段 1–4 落下 9 个逻辑模块，各自 20~83 项测试全绿，
 *   但**没有任何生产代码调用它们**。零件之间互相 import 形成一个闭环：
 *   逐个看「谁引用了我」每个都有人引用，整个闭环却没连到宿主。
 *   产品里至今不存在「装插件 / 卸载 / 查更新」这个能力。
 *
 *   这不是死代码，是**等接线的在制品**（阶段 0 加载侧待本机实测）。
 *   但它最容易悄悄烂掉：没人调用的模块，后人会当设计稿改坏或删掉，
 *   而 264 个测试一个都不会红 —— 因为它们测的是模块内部，不是接线。
 *
 * ⛔ 白名单不是豁免，是欠账台账（沿用 coupling / coverage-guard 既有手法）：
 *     · 接线完成 → 模块变成「生产可达」 → ①b 红，逼你删台账条目（销账）
 *     · 新增一个只被测试引用的模块 → ①a 红，逼你先想清楚再落地
 *    两边一起对不上就红。台账条目必须带 why 与 unblock。
 *
 * ⚠️ 自证陷阱（本守卫最容易假绿的地方，刻意设计绕开）：
 *    守卫自己必然要写出这些模块的路径字符串。若把守卫/扫描器也算作
 *    「生产入口」，台账字面量就会把模块判成已接线 —— 守卫自己给自己
 *    发了通行证，永远全绿。故 isMetaRoot 排除守卫、扫描器、探针三类。
 *    ⑤ 元断言 B 用合成样本钉住「剥注释」：注释里的假 import 不算引用。
 *
 * ⚠️ 已知边界（与 coverage-guard 同形状，不藏着）：
 *    纯静态守卫挡不住「把 ① 的判据整行替换成 true」。这一层靠每次改动时
 *    人做的破坏验证兜，不靠守卫自证。判据写歪（恒真/恒假/台账清空/注释放行）
 *    则 ①⑤ 都会喊，已逐向实测（见任务清单）。
 *
 * ⚠️ 可达性判据的固有边界（破坏验证「注入 2」实测）：
 *    给 host.js 加一条 `import './plugin-market.js'`，BFS 会沿闭包把
 *    **全部 9 个市场模块一起点亮**（实际仅剩 3 条 testOnly），①b 一次点名
 *    8 条要求销账。这是对的：接线是把整组接进来，不是逐个接。
 *    但它也意味着「只接了 install、没接 uninstall」时守卫仍认为整组已接线。
 *    销账时须逐条确认能力真的可用；本守卫判断的是「整组有没有连到宿主」，
 *    不是「每个能力各自有没有被调用」。
 *
 * 本守卫刻意不 spawn 子进程：sweep-tests.mjs 会把不 spawn 的测试正常收录。
 *
 * 运行：node orphan-modules-guard-test.mjs
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  scanModuleReach, refsInCode, resolveRef, isMetaRoot, relOf, orphansOk,
} from './scripts/scan-module-reach.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

/* ---------------- 台账：11 条（9 个待接线 + 2 个测试专用工具） --------------
 * kind 不是装饰：② 会独立核对「生产引用只能来自台账内部」，
 * 把一条 wiring-pending 改成 test-tool 骗不过去。
 */
const KNOWN = {
  'js/dead-class-scan.js': {
    kind: 'test-tool',
    why: '纯扫描器，只被 5 个样式/类名守卫 import；宿主运行时不加载它。'
       + '性质合理但住在 js/（运行时目录）容易误导，属放错位置而非死代码。',
    unblock: '迁到 test-utils/ 或 tests/ 下并更新引用，或确认它确实只服务测试后在此改 kind。',
  },
  'js/theme-normalizer.js': {
    kind: 'test-tool',
    why: '主题归一化实现，当前仅被 adapt-test / adapt-sequential-test 引用；'
       + '上一轮「按 import 算零引用」的报告曾把它误列为孤儿，人工复核后确认是测试用。',
    unblock: '若主题运行时真的接入，它会变成生产可达并自动从台账销账；否则迁到测试目录。',
  },
  'js/installed-plugin-scan.js': {
    kind: 'wiring-pending',
    why: '阶段 1 的目录扫描器，29 项测试全绿，但宿主启动时没人调它 —— 装了插件也不会出现在侧边栏。',
    unblock: '阶段 0 结论出来后接入宿主启动扫描（或 IPC 命令），从台账删除本条。',
  },
  'js/plugin-manifest.js': {
    kind: 'wiring-pending',
    why: '阶段 1 的 manifest 纯函数，34 项测试全绿；当前只被台账内其他模块与生成器引用。',
    unblock: '随扫描器一并接线；接线后本条与其余 8 条一起销账。',
  },
  'js/plugin-installer.js': {
    kind: 'wiring-pending',
    why: '阶段 2 的下载/校验/原子安装，80 项测试全绿；没有任何生产入口调用 install。',
    unblock: 'store 面板的安装按钮 / IPC 命令接入 plugin-market.install 后销账。',
  },
  'js/plugin-store-client.js': {
    kind: 'wiring-pending',
    why: '阶段 2/3 的 GitHub Release 客户端，含 digest 校验；80 项测试全绿，仅被市场闭包调用。',
    unblock: '随编排层接线；注意它依赖网络，接线后要把「网络失败」与「逻辑错」分开报。',
  },
  'js/plugin-ledger.js': {
    kind: 'wiring-pending',
    why: '阶段 3 的安装台账与更新检测，83 项测试全绿；台账文件没人写也就没人读。',
    unblock: '装成功后的 saveLedger 已由 market 编排层串好，随编排层接线销账。',
  },
  'js/plugin-tarball.js': {
    kind: 'wiring-pending',
    why: '补上安装链路唯一断点的 tarball 解包器（node:zlib + USTAR），仅被 plugin-market 调用。',
    unblock: '随编排层接线；不要在这里做路径过滤（越界条目必须交给 installer 拦）。',
  },
  'js/plugin-fs-bridge.js': {
    kind: 'wiring-pending',
    why: '阶段 4.1 的 fs_op 前端桥，40 项测试全绿；真实文件读写要经 Tauri invoke，webview 里没人调。',
    unblock: '后端 IPC 命令落地、或 data-store 改走真实 invoke 后销账。',
  },
  'js/plugin-data-store.js': {
    kind: 'wiring-pending',
    why: '阶段 4.1 用户数据存储（按插件 id 分目录、原子写、卸载保留），76 项测试全绿；'
       + '当前所有测试都注入假 invoke，产品里还没有任何插件数据落盘。',
    unblock: '接线到真实 invoke 并确认 appDataDir 可写后销账。',
  },
  'js/plugin-market.js': {
    kind: 'wiring-pending',
    why: '宿主侧编排层（安装/发现/查更新/卸载/数据读写），端到端 70 项全绿，'
       + '但全仓零生产引用 —— 「产品里还不存在装插件这个能力」的唯一根因。',
    unblock: 'store 面板 / IPC 命令接入它即销账；接线落点等阶段 0 加载侧实测结论。',
  },
};
const knownKeys = Object.keys(KNOWN);

const snap = scanModuleReach(ROOT);
const actual = snap.testOnly;

/* ---------------- ① 台账与实际完全一致（销账 / 新增都喊） ---------------- */
t('①a 没有台账外的「仅测试可达」模块',
  actual.every((k) => knownKeys.includes(k)),
  actual.filter((k) => !knownKeys.includes(k)).join(' ; '));
t('①b 台账没有已失效条目（接线完成必须销账）',
  knownKeys.every((k) => actual.includes(k)),
  knownKeys.filter((k) => !actual.includes(k)).join(' ; '));
/* ①c 与元断言 D/E **共用同一份判据**：分着写两份会各改各的，
   一边敏感一边不敏感。coverage-guard 那轮就是靠这条钉住判据漂移的。 */
t('①c 集合恰为台账（与元断言共用判据）', orphansOk(actual, knownKeys),
  `实际 ${actual.length} 条 / 台账 ${knownKeys.length} 条`);

/* ---------------- ② 每条账：零外部生产引用 + 确有测试引用 ----------------
 * 「生产引用只能来自台账内部」与 ① 的可达性是两套独立判据：
 * 前者逐个看入边，后者整体做 BFS。接线到 host.js 时两条会同时红。
 */
const badEdges = [];
for (const key of knownKeys) {
  const bucket = snap.incoming.get(join(ROOT, key));
  if (!bucket) { badEdges.push(`${key}: 文件不存在`); continue; }
  const external = bucket.prod.filter((r) => !isMetaRoot(ROOT, join(ROOT, r)) && !knownKeys.includes(r));
  if (external.length) badEdges.push(`${key} ← 生产: ${external.join(' , ')}`);
  if (bucket.test.length === 0) badEdges.push(`${key}: 没有任何测试引用（空壳条目）`);
}
t('② 每条台账零外部生产引用、且确有测试引用', badEdges.length === 0, badEdges.join(' ; '));

/* ---------------- ③ 完全不可达必须为 0 ----------------
 * 新加一个 js/ 模块却连测试都没写：连台账都进不去，直接红。
 */
t('③ 没有「连测试都没引用」的 js/ 模块', snap.unreachable.length === 0,
  snap.unreachable.join(' ; '));

/* ---------------- ④ 台账本身不能是空壳 ---------------- */
const malformed = knownKeys.filter((k) => {
  const it = KNOWN[k];
  return !existsSync(join(ROOT, k))
    || !['test-tool', 'wiring-pending'].includes(it.kind)
    || typeof it.why !== 'string' || it.why.length < 20
    || typeof it.unblock !== 'string' || it.unblock.length < 20;
});
t('④ 11 条台账均有真实文件 / 合法 kind / why / unblock',
  knownKeys.length === 11 && malformed.length === 0, malformed.join(' ; '));

/* ---------------- ⑤ 元断言：判据不能是摆设 ----------------
 * 本项目反复栽的形状：判据恒真/恒假时主断言照样全绿。
 */
const sampleSet = new Set([
  join(ROOT, 'js', '__probe_a.js'), join(ROOT, 'js', '__probe_b.js'),
  join(ROOT, 'js', 'plugin-fs.js'), join(ROOT, 'js', 'plugin-fs-bridge.js'),
]);
const sampleFrom = join(ROOT, 'js', 'host.js');
const sampleCode = [
  "// import './__probe_a.js'",            // 行注释：不算
  "/* import './__probe_a.js' */",         // 块注释：不算
  "import './__probe_b.js';",              // 真引用：算
  "const DOC = 'js/__probe_a.js';",        // 无前导点的文档字样：不算
].join('\n');
const sampleRefs = refsInCode(ROOT, sampleFrom, sampleCode, sampleSet)
  .map((p) => relOf(ROOT, p)).sort();
t('⑤ 元断言 A：剥注释 + 路径解析后只剩真引用（判据不恒空）',
  JSON.stringify(sampleRefs) === JSON.stringify(['js/__probe_b.js']),
  JSON.stringify(sampleRefs));
t('⑤ 元断言 B：前缀不串（plugin-fs 不会吸收 plugin-fs-bridge 的引用）',
  JSON.stringify(refsInCode(ROOT, sampleFrom, "import './plugin-fs.js';", sampleSet)
    .map((p) => relOf(ROOT, p))) === JSON.stringify(['js/plugin-fs.js']));
t('⑤ 元断言 C：省略后缀能补 .js，无前导点文档字样不算引用',
  resolveRef(ROOT, sampleFrom, './plugin-fs', sampleSet) === join(ROOT, 'js', 'plugin-fs.js')
  && resolveRef(ROOT, sampleFrom, 'js/plugin-fs.js', sampleSet) === null);
t('⑤ 元断言 D：新增一个孤儿时判据返回 false（不是恒真）',
  orphansOk([...actual, 'js/__probe_new.js'], knownKeys) === false);
t('⑤ 元断言 E：台账清空时判据返回 false（不是恒假）',
  orphansOk(actual, []) === false);
t('⑤ 元断言 F：生产可达规模正常（BFS 没崩成空图）',
  snap.prodReach.length > 25 && snap.jsModules.length >= 40,
  `prodReach=${snap.prodReach.length} jsModules=${snap.jsModules.length}`);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
