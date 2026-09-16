/**
 * 自跟随主题插件（agent-flow）不施加反转滤镜。
 *
 * 现象（本测试要防的回归）：
 *   切到浅色主题 → 变量推过去，agent-flow 自己已变浅（白）
 *   → 适配系统照旧采样，判"插件深色 / 面板浅色"→ 施加 invert
 *   → 已变浅的部分被二次翻转成深色（黑）
 *   且 reAdapt 先 teardown 再异步采样，中间约 790ms 无滤镜，
 *   于是看到"变白一秒后又变黑"，像切换了好几次。
 */
import { readFileSync } from 'node:fs';

let pass = 0;
const fails = [];
const t = (name, cond, extra = '') => {
  if (cond) pass++;
  else fails.push(`${name}${extra ? ' → ' + extra : ''}`);
};
const read = (p) => readFileSync(p, 'utf8');

const registry = read('plugins/registry.js');
const host = read('js/host.js');
const sdk = read('js/plugin-sdk.js');
const af = read('plugins/agent-flow/styles.css');

console.log('=== 1. 清单声明 ===');
/* 先切出 agent-flow 那一段，再在里面找 —— 直接用 {0,600} 跨段匹配
   会被后面其它插件的内容干扰（注释里也出现了这个词）。 */
const afEntry = registry.slice(registry.indexOf("id: 'agent-flow'"));
t('agent-flow 声明了 followsTheme',
  /followsTheme:\s*true/.test(afEntry.slice(0, afEntry.indexOf('},'))));
t('followsTheme 有注释说明为什么需要它',
  /followsTheme[\s\S]{0,80}?\*\/|自己跟随面板主题/.test(registry));

console.log('=== 2. 自报基调用途扩展 ===');
/* 原来只有 isolated 才上报。followsTheme 插件也要上报 ——
   它自己会跟随主题，基调该由它说了算，外壳采样反而会误判。 */
t('reportBase 覆盖 isolated 与 followsTheme 两种场景',
  /reportBase:\s*\(isolated\s*\|\|\s*!!manifest\.followsTheme\)/.test(host));
t('注释说明了为什么 followsTheme 也要上报',
  /followsTheme[\s\S]{0,300}误判|外壳采样反而会误判/.test(host));

console.log('=== 3. 主题更新时重报基调 ===');
/* 只在 init 报一次是不够的：切主题后插件颜色已变，
   reportedBase 还是旧值 → 按旧基调判定 → 滤镜加反。 */
t('SDK 记住了宿主是否要求上报', /let needReportBase = false/.test(sdk));
t('init 时置位', /needReportBase = true/.test(sdk));
t('收到 theme 更新时重报',
  /needReportBase && d\.type === 'theme'[\s\S]{0,120}base-report/.test(sdk));
/* 顺序很关键：必须在 theme-applied 之前发出。
   外壳等 theme-applied 才采样，先收到新基调那次采样才会用对。 */
const iReport = sdk.indexOf('base-report', sdk.indexOf("d.type === 'theme'"));
const iApplied = sdk.indexOf("post({ type: 'theme-applied' })");
t('重报排在 theme-applied 之前（否则白等一轮还得多闪一次）',
  iReport > 0 && iApplied > 0 && iReport < iApplied,
  `report@${iReport} vs applied@${iApplied}`);

console.log('=== 4. 插件文档标记基调 ===');
t('SDK 把基调写成 data-nexus-base', /dataset\.nexusBase = base/.test(sdk));
t('注释说明 colorScheme 不够（CSS 选择器读不到）',
  /colorScheme 不够|CSS 选择器读不到/.test(sdk));

console.log('=== 5. 品牌色按基调切两档 ===');
/* 这些色是"浅色变体"，深底上 7:1 以上，浅底上掉到 1.1~2.5。
   不能换主题变量（失去品牌识别度），只能切两档。 */
t('定义了 --af-t-* 双档色（深色档）', /--af-t-err:\s*#/.test(af) && /--af-t-file:\s*#/.test(af));
t('有浅色档覆盖', /data-af-mode="follow"\]\[data-nexus-base="light"\]/.test(af));
/* native 模式固定深色，不该吃浅档 */
t('浅档限定在 follow 模式（native 不该切档）',
  !/\[data-nexus-base="light"\]\s*\{/.test(af.replace(/\[data-af-mode="follow"\]\[data-nexus-base="light"\]/g, '')));

const tones = ['--af-t-err', '--af-t-err2', '--af-t-code', '--af-t-warn',
  '--af-t-close', '--af-t-loop', '--af-t-loop-b', '--af-t-loop-d',
  '--af-t-cond-s', '--af-t-cond-v', '--af-t-file'];
const darkBlock = af.slice(af.indexOf('--af-t-err:'), af.indexOf('--af-t-file:') + 30);
const lightBlock = af.slice(af.indexOf('data-nexus-base="light"]'));
const missing = tones.filter((v) => !new RegExp(`${v}:`).test(darkBlock)
  || !new RegExp(`${v}:`).test(lightBlock));
t('两档都齐（深色 11 + 浅色 11）', missing.length === 0, missing.join(','));

/* 裸前景色不该再硬编码 —— 有自带底色的徽章除外。
   必须按**规则块**判断而不是按行：background 常常写在下一行，
   按行看会把它当成裸色（.toolbar button.primary 就是这样被误报的）。 */
const bareBlocks = [];
for (const m of af.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1], body = m[2];
  if (/--af-t-/.test(body) || /--af-t-/.test(sel)) continue;        // 变量定义块
  if (!/(^|[;\s])color:\s*#[0-9a-fA-F]{3,6}/i.test(body)) continue;
  const hasOwn = /background(?:-color)?:\s*(#|var\(|rgb)/i.test(body);
  if (hasOwn) continue;                                             // 自带底色 → 成对徽章
  bareBlocks.push(sel.trim().slice(0, 48));
}
/* #fff 的 4 处都叠在 accent / 彩色底上，属"叠在内容上"，不跟随主题才对 */
const realBare = bareBlocks.filter((sel) => !/primary|trg-btn|view-switch|dot/i.test(sel));
t('裸硬编码前景色已改为变量（自带底色的徽章与叠在彩色底上的 #fff 除外）',
  realBare.length === 0, realBare.join(' | '));

/* 顺带确认：那几处 #fff 确实都有底色，否则就成了真裸色 */
const whiteOk = [...af.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => /(^|[;\s])color:\s*#fff\b/i.test(m[2]))
  .every((m) => /background(?:-color)?:\s*(#|var\(|rgb)/i.test(m[2]));
t('所有 color:#fff 都叠在底色上（否则浅色下会消失）', whiteOk);

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) { fails.forEach((f) => console.log('  ❌ ' + f)); process.exit(1); }
