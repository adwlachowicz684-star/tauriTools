/**
 * 样式审计测试
 * ============================================================
 * 盯两件事：
 *   1. 规则本身对不对 —— 给一段"踩了坑"的 CSS 必须报出来，
 *      给一段"正确"的 CSS 不能误报（误报多了这个面板就没人看了）
 *   2. 现有插件是否干净 —— 直接扫仓库里的 CSS 文本
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditCss, summarize, LEVEL_ORDER, SHELL_VARS, TOKEN_VARS } from './js/style-audit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const has = (issues, rule) => issues.some((x) => x.rule === rule);

console.log('=== 1. 规则：踩坑的 CSS 必须被报出来 ===');

/* E1：风格开关当分隔线 —— 新拟态下 --border 是 transparent */
{
  const css = '.side { border-right: 1px solid var(--border); }';
  const r = auditCss(css, 'a.css');
  t('单边 border 用 --border 被判为错误',
    has(r, 'border-风格开关') && r.find((x) => x.rule === 'border-风格开关').level === 'error');
}
{
  /* 卡片描边用 --border 是**对的**，不能误报 */
  const css = '.card { border: 1px solid var(--border); }';
  t('卡片四边描边用 --border 不报错（那是风格开关的正当用法）',
    !has(auditCss(css, 'a.css'), 'border-风格开关'));
}
{
  const css = '.side { border-right: 1px solid var(--divider); }';
  t('改用 --divider 后不再报错', !has(auditCss(css, 'a.css'), 'border-风格开关'));
}

/* E2：变量未定义 */
{
  const css = '.x { color: var(--text-mute-typo); }';
  const r = auditCss(css, 'a.css');
  t('未定义且无兜底 → error',
    has(r, 'var-未定义') && r.find((x) => x.rule === 'var-未定义').level === 'error');
}
{
  const css = '.x { color: var(--text-mute-typo, #888); }';
  const r = auditCss(css, 'a.css');
  t('未定义但有兜底 → warn（降级，因为还有兜底在生效）',
    has(r, 'var-未定义(有兜底)'));
}
{
  /* 这正是 agent-flow 真实踩过的：--af-text-mute 引用 23 处却从未定义 */
  const css = '.x { --af-dim: #888; color: var(--af-text-mute); }';
  t('私有变量拼错也能查出来', has(auditCss(css, 'a.css'), 'var-未定义'));
}
{
  const css = '.x { --my-var: #888; color: var(--my-var); }';
  t('本文件自己定义的变量不算未定义', !has(auditCss(css, 'a.css'), 'var-未定义'));
}
{
  const css = '.x { color: var(--text-dim); background: var(--surface); }';
  t('外壳变量认得（不误报未定义）', auditCss(css, 'a.css').length === 0);
}
{
  /* 令牌变量认得，且配了 @import —— 这才是"用了令牌"的正确写法 */
  const css = `@import url('../../css/tokens.css');
    .x { box-shadow: var(--sh-out-md); border-radius: var(--r-xs); }`;
  t('令牌变量 + 有 @import = 干净', auditCss(css, 'plugins/demo/styles.css').length === 0);
}

/* E3：阴影写死色值 */
{
  const css = '.card { box-shadow: 4px 4px 9px rgba(0,0,0,.3), -4px -4px 9px #fff; }';
  t('立体阴影写死颜色 → error', has(auditCss(css, 'a.css'), '阴影写死色值'));
}
{
  /* 描边环 / 辉光 / 单方向投影都是合法用法 */
  const css = `.a { box-shadow: var(--sh-out-md); }
    .b { box-shadow: 0 0 0 2px var(--accent); }
    .c { box-shadow: var(--glow-sm); }
    .d { box-shadow: 0 4px 10px var(--sh-dark); }
    .e { box-shadow: inset 0 1px 0 var(--sh-light); }`;
  t('描边环/辉光/单方向投影不误报', !has(auditCss(css, 'a.css'), '阴影写死色值'));
}

/* W2：缺 @import */
{
  const css = '.x { box-shadow: var(--sh-out-md); border-radius: var(--r-xs); }';
  const r = auditCss(css, 'plugins/demo/styles.css');
  t('用了令牌却没 @import tokens.css → warn', has(r, '缺-tokens-import'));
}
{
  const css = `@import url('../../css/tokens.css');
    .x { box-shadow: var(--sh-out-md); }`;
  t('有 @import 就不报', !has(auditCss(css, 'plugins/demo/styles.css'), '缺-tokens-import'));
}

/* W3：覆盖主题变量 */
{
  const css = '.x { --text: #fff; --surface: #000; }';
  t('重新定义主题变量 → warn', has(auditCss(css, 'plugins/demo/styles.css'), '覆盖主题变量'));
}
{
  const css = '.x { --my-local: #fff; }';
  t('定义自己的私有变量不报', !has(auditCss(css, 'plugins/demo/styles.css'), '覆盖主题变量'));
}

console.log('\n=== 2. 规则：不能误报（误报多了面板就没人看）===');
{
  /* 一段「教科书式正确」的插件 CSS */
  const css = `@import url('../../css/tokens.css');
    .p { background: var(--surface); color: var(--text); }
    .p .bar { border-bottom: 1px solid var(--divider); }
    .p .btn { box-shadow: var(--sh-out-md); border-radius: var(--r-sm); }
    .p .in  { box-shadow: var(--sh-in-sm); transition: background var(--dur-fast); }`;
  const r = auditCss(css, 'plugins/demo/styles.css');
  t('干净的插件 CSS 零 error 零 warn',
    summarize(r).error === 0 && summarize(r).warn === 0,
    JSON.stringify(summarize(r)));
}
{
  /* 结构色（节点色板这类）允许硬编码，只给 info 不给 error */
  const css = '.node-a { background: #38bdf8; } .node-b { background: #f472b6; }';
  const r = auditCss(css, 'plugins/demo/styles.css');
  t('结构色只记 info，不打断人', summarize(r).error === 0 && summarize(r).warn === 0);
}

console.log('\n=== 3. 现有插件是否干净 ===');
const pluginCss = [];
for (const d of readdirSync(join(HERE, 'plugins'), { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const n of ['styles.css', 'style.css', 'settings.css']) {
    const p = join(HERE, 'plugins', d.name, n);
    if (existsSync(p)) pluginCss.push([`plugins/${d.name}/${n}`, p]);
  }
}
t('至少扫描到 3 个插件样式', pluginCss.length >= 3, `${pluginCss.length} 个`);
for (const [rel, abs] of pluginCss) {
  const r = auditCss(readFileSync(abs, 'utf8'), rel);
  const c = summarize(r);
  t(`${rel} 无 error/warn`, c.error === 0 && c.warn === 0,
    `error ${c.error} / warn ${c.warn}` + (c.error + c.warn
      ? ' | ' + r.filter((x) => x.level !== 'info').slice(0, 2)
        .map((x) => `${x.rule}@L${x.line}`).join('; ')
      : ''));
}

console.log('\n=== 4. 对外契约 ===');
t('SHELL_VARS 含主题推送的核心变量',
  ['--bg', '--text', '--surface', '--accent', '--sh-dark', '--border'].every(
    (v) => SHELL_VARS.includes(v)));
t('TOKEN_VARS 含全部阴影档位',
  ['--sh-out-sm', '--sh-out-md', '--sh-out-lg', '--sh-out-xl',
   '--sh-in-xs', '--sh-in-sm', '--sh-in-md', '--sh-in-lg'].every(
    (v) => TOKEN_VARS.includes(v)));
t('LEVEL_ORDER 能把 error 排在最前', LEVEL_ORDER.error < LEVEL_ORDER.warn
  && LEVEL_ORDER.warn < LEVEL_ORDER.info);
t('summarize 支持任意 level 键（不会 TS7053）',
  summarize([{ level: 'error' }, { level: 'warn' }]).warn === 1);

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
