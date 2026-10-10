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
import { stripCommentsFlatJs } from './test-scan-utils.mjs';

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

/*
 * ⚠️ 1~3 节原本测的是「插件自报基调（followsTheme + reportBase + base-report）」
 * 那一整套，而它**已被论证废弃并删除**。理由写在 js/host.js init 处那段注释里：
 *   ① 它服务于「外壳采样 → 加滤镜反转」那套适配；上游已把 theme / followsTheme
 *      收成单一约定（外壳把变量推到哪、插件就渲染到哪，不做反转也不做覆盖）。
 *      没有滤镜，就不存在"二次翻转成黑" —— 自报基调要修的 bug 在新方案下
 *      压根不会发生；
 *   ② reportedBase 全仓没有任何一处读它，只有写入没有读取，是死机制。
 *
 * 于是本文件一度**红 7 项**。而最要命的恰恰是当时**唯一还绿的那条**
 * （'reportBase 覆盖 isolated 与 followsTheme 两种场景'）：
 *   它匹配到的是 host.js 注释里**引用被删代码**的那一行 ——
 *   注释原文就写着 `reportBase: (isolated || !!manifest.followsTheme)`，
 *   正则照样命中。于是一个已删除的特性在测试报告上看着**还在**。
 *   这正是本项目反复栽的「断言查存在性、不查那一处存在」：
 *   这次不是错在被测代码，而是错在**注释里恰好留了那串字符**。
 *
 * 因此：下面凡是判「没有 / 已删」的断言，一律先剥注释再判（见 codeOf）。
 */
const codeOf = (s) => stripCommentsFlatJs(s);

console.log('=== 1. 基调改由宿主下发权威值 ===');
t('init 消息下发权威基调 themeBase',
  /themeBase:\s*pluginThemeBase\(manifest\.id\)/.test(codeOf(host)));
t('切主题时同样下发 themeBase（否则插件停在旧基调）',
  /type:\s*'theme'[\s\S]{0,80}themeBase:\s*pluginThemeBase\(/.test(codeOf(host)));
/* 必须取**实际**基调：返回声明值的话，用户把主题改成浅色后插件仍按深色档
   渲染，深色文字压在浅底上对比度掉到 1.x，不报错。 */
t('pluginThemeBase 取实际基调（resolveThemeMeta），不是声明值',
  /function pluginThemeBase[\s\S]{0,400}resolveThemeMeta\(t\)\.base/.test(codeOf(host)));

console.log('=== 2. SDK 优先采用宿主下发的权威值 ===');
/* 不能只按 --bg 亮度推断：用户可以只改基调、不动底色，此时 --bg 仍是深色值，
   推断判成 dark，插件 CSS 里 [data-nexus-base="light"] 那一档永远匹配不上。 */
t('SDK 优先采用宿主下发的 hostBase',
  /hostBase === 'light' \|\| hostBase === 'dark'[\s\S]{0,60}\?\s*hostBase/.test(codeOf(sdk)));

console.log('=== 3. 死机制不得复辟（剥注释后必须是真的没有）===');
/*
 * 反向断言的价值就在上面那个假绿：只看"字符串在不在"会被注释骗过去，
 * 剥掉注释之后这几条才是真判据 —— 谁把 followsTheme / reportBase /
 * needReportBase / base-report 加回来，这里立刻红。
 */
t('注册表不再有 followsTheme 声明字段', !/followsTheme/.test(codeOf(registry)));
t('host 不再下发 reportBase 字段', !/reportBase/.test(codeOf(host)));
t('host 不再处理 base-report 消息', !/base-report/.test(codeOf(host)));
t('SDK 不再有 needReportBase', !/needReportBase/.test(codeOf(sdk)));
t('SDK 不再回发 base-report', !/base-report/.test(codeOf(sdk)));
/* 元断言：上面 5 条"没有"必须建立在**文件没被整体改写**的前提下。
   否则哪天 host.js / plugin-sdk.js 被重命名或重写，5 条全部恒真 —— 又是假绿。 */
t('样本仍在：host.js 仍引用 pluginThemeBase（元断言）',
  /pluginThemeBase/.test(host));
t('样本仍在：plugin-sdk.js 仍写 nexusBase（元断言）',
  /nexusBase/.test(sdk));
/* 这条专门钉住"为什么必须剥注释"：原文里那段引用被删代码的注释还在，
   所以不剥注释的写法现在**仍然**会被骗。它一旦转红，说明那段说明被删了，
   上面 5 条反向断言的"没有"就不再能证明什么。 */
t('元断言：原文仍引用着被删代码（故判"没有"必须先剥注释）',
  /reportBase:\s*\(isolated\s*\|\|\s*!!manifest\.followsTheme\)/.test(host));

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
/* 刻意不跟随主题的三类：
   - #fff：叠在 accent / 彩色底上，属"叠在内容上"
   - primary / trg-btn / view-switch / dot：成对徽章或已选中态
   - mod-btn：模块编辑条上的按钮。上面 1642 行的注释写明了刻意用**固定琥珀色**——
     它是一条临时状态条（借用主画布编辑模块内部时提示"你不在流程画布上"），
     混进主题色会不够醒目。此处随设计意图豁免，不是漏改。
     注意 mod-bar 本体因为有 background: rgba(...) 已被上面的 hasOwn 自动豁免。 */
const realBare = bareBlocks.filter((sel) => !/primary|trg-btn|view-switch|dot|mod-btn/i.test(sel));
t('裸硬编码前景色已改为变量（自带底色的徽章与叠在彩色底上的 #fff 除外）',
  realBare.length === 0, realBare.join(' | '));

/* 顺带确认：那几处 #fff 确实都有底色，否则就成了真裸色 */
const whiteOk = [...af.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter((m) => /(^|[;\s])color:\s*#fff\b/i.test(m[2]))
  .every((m) => /background(?:-color)?:\s*(#|var\(|rgb)/i.test(m[2]));
t('所有 color:#fff 都叠在底色上（否则浅色下会消失）', whiteOk);

console.log(`\n通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) { fails.forEach((f) => console.log('  ❌ ' + f)); process.exit(1); }
