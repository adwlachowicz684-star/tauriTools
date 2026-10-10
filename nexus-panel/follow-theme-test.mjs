/**
 * 自跟随主题插件（agent-flow）相关的配色约定。
 * ============================================================
 * 【本测试在 2026-10 被整体改写过一次，原因值得记下来】
 *
 * 它原先钉的是**另一套设计**：注册表声明 `followsTheme`、宿主下发
 * `reportBase`、SDK 回发 `base-report` 自报基调，外壳据此决定要不要加
 * 反转滤镜。那套已经**整体废弃并删除**了（理由见 js/host.js init 处
 * 与 js/themes.js 顶部的注释）：现在宿主把变量推到哪、插件就渲染到哪，
 * 不做反转也不做覆盖。
 *
 * 于是这文件出现过一种很难看的状态：**7 项红，但红的是"被删掉的东西
 * 没被实现"** —— 断言把"已废弃设计"当成了规格。照着它去"修"，就得把
 * 一套没人读的死机制请回来（reportedBase 在全仓本来就没有读取方，
 * 只有写入）。
 *
 * 现在改为钉**当前**设计：
 *   · 注册表里不再有基调声明字段；
 *   · 宿主不再要求自报、也不再收 base-report；
 *   · SDK 不再回传基调（宿主已通过 themeBase 下发权威值）；
 *   并且钉住"若哪天要加回来，必须连读取方一起实现"这个约束。
 *
 * 第 4、5 节是**仍然生效**的部分（data-nexus-base 与品牌色双档），保留原样。
 */
import { readFileSync } from 'node:fs';
import { stripCommentsJs } from './test-scan-utils.mjs';

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
/* 判"某样东西不存在"时必须先剥注释：host.js 与 plugin-sdk.js 里保留着
   **解释为什么删掉**的大段注释，注释里自然会出现 `reportBase:`、
   `case 'base-report'` 这些字面量。不剥注释的话，"不存在"永远判不出来
   （恒假），而"存在"又会被注释喂饱（恒真）—— 两个方向都是空跑。 */
const hostCode = stripCommentsJs(host);
const sdkCode = stripCommentsJs(sdk);
const registryCode = stripCommentsJs(registry);

console.log('=== 1. 清单里不再有基调声明字段 ===');
/* 当前约定：插件配色一律走外壳推过来的变量，没有第二套机制，
   因此注册表里不再有基调声明字段（见 registry.js 顶部）。 */
t('registry.js 顶部写明了"不再有基调声明字段"',
  /不再有.*基调声明字段|没有.*基调声明字段/.test(registry));
/* 先切出 agent-flow 那一段再判，避免被后面其它插件的注释干扰。 */
const afEntry = registryCode.slice(registryCode.indexOf("id: 'agent-flow'"));
t('agent-flow 条目里没有 followsTheme（声明字段已取消）',
  !/followsTheme/.test(afEntry.slice(0, afEntry.indexOf('},'))),
  afEntry.slice(0, afEntry.indexOf('},')).match(/followsTheme[^\n]*/)?.[0] || '');
t('agent-flow 仍标注"跟随面板主题"（说明文字里，不是字段）',
  /跟随面板主题/.test(registry));

console.log('=== 2. 宿主不再要求/接收自报基调 ===');
t('host.js 不下发 reportBase',
  !/reportBase/.test(hostCode),
  hostCode.match(/reportBase[^\n]*/)?.[0] || '');
t('host.js 不再有 base-report 这个 case',
  !/base-report/.test(hostCode),
  hostCode.match(/base-report[^\n]*/)?.[0] || '');
/* 删掉不是"随手删"，理由必须留在代码里，否则下一个人会当成遗漏补回去。 */
t('删掉的理由写在代码里（没有滤镜 → 不存在二次翻转）',
  /没有滤镜|不做反转/.test(host) && /已废弃|整套删除|整套删掉/.test(host));
t('并写明 reportedBase 曾是没有读取方的死写入',
  /reportedBase/.test(host) && /没有任何一处读|死机制|死写入/.test(host));

console.log('=== 3. SDK 不再回传基调 ===');
t('plugin-sdk.js 没有 needReportBase', !/needReportBase/.test(sdkCode));
t('plugin-sdk.js 不再发送 base-report', !/base-report/.test(sdkCode),
  sdkCode.match(/base-report[^\n]*/)?.[0] || '');
t('注释说明基调由宿主 themeBase 下发、无需回传',
  /themeBase/.test(sdk) && /不再需要回传|不再.*回传/.test(sdk));
/* 若哪天要加回来，host.js 里已经写死了约束：必须连"谁来读"一起实现。
   这条钉的是约束本身还在（防止后人只把写入加回来）。 */
t('复活的前提条件仍写在 host.js（必须连读取方一起实现）',
  /必须连/.test(host) && /谁来读|读取方/.test(host));

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
