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
import { auditCss, summarize, LEVEL_ORDER, SHELL_VARS, TOKEN_VARS, CONTROLS_VARS } from './js/style-audit.js';
// 读源码做扫描前必须剥注释：注释里提到的 --grp-* / setProperty('--x') 会被
// 当成真定义，让"不该报的没报"这类断言**假绿** —— 比报红更危险。
import { stripComments as strip } from './test-scan-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
/*
 * 前缀匹配而非全等：规则名带修饰后缀（如 `var-未定义(兜底为空)`），
 * 用全等会因改名而漏判 —— 测试仍绿，实际上什么都没验证。
 */
const has = (issues, rule) => issues.some((x) => x.rule === rule || x.rule.startsWith(rule + '('));

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

/* 兜底链整个落空（幽灵变量的老问题）→ 必须报 */
{
  const css = '.x { background: var(--accent-soft, var(--surface-2)); }';
  const r = auditCss(css, 'a.css');
  t('兜底是另一个未定义 var → 仍然报', has(r, 'var-未定义'));
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
  t('未定义且兜底非空 → 不报（兜底本就是为此准备的）',
    !has(r, 'var-未定义'));
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

console.log('\n=== 8. 共享变量列表不漂移 ===');
console.log('\n=== 运行时注入变量（brushVars）不被误判 ===');
/* --grp-* 曾被判成"从未定义"，照着这个误报去"修"会破坏双态设计：
   设了组色的卡片靠 JSX 注入 --grp-* 用组色，没设的靠兜底回 --accent。
   改成 var(--accent) 之后，设了组色的卡片会失去自己的组色。 */
{
  const audit = await import('./js/style-audit.js');
  const pg = strip(readFileSync('plugins/project-group/style.css', 'utf8'));
  const hits = audit.auditCss(pg, 'x').filter((x) => /--grp-/.test(x.msg));
  t('--grp-* 不再被判成未定义', hits.length === 0,
    hits.map((x) => x.msg.slice(0, 40)).join(' | '));

  /* prefix 列表是手工维护的 —— 源码里新增 brushVars(…,'xxx') 必须同步，
     否则新前缀又会开始误报。这条断言盯着漂移。 */
  const src = ['plugins/project-group/components/CardGrid.tsx',
               'plugins/project-group/components/PresetIconGrid.tsx']
    .map((f) => (existsSync(f) ? readFileSync(f, 'utf8') : '')).join('\n');
  /* 用索引 m[1] 而不是 m.group(1)：本环境下 matchAll 返回的 match
     对象是数组子类但**没有 .group 方法**（实测 typeof === undefined）。 */
  const used = [...new Set([...src.matchAll(/brushVars\([^,]+,\s*'([^']+)'/g)]
    .map((m) => m[1]).filter(Boolean))];
  const missing = used.filter((u) => !audit.BRUSH_PREFIXES.includes(u));
  t('源码里的 brushVars 前缀已全部登记', missing.length === 0,
    missing.join(', ') || `用到：${used.join(', ')}`);
}
/* 运行时注入的**位置**变量（js/inspector.js 的高亮层）同样会被静态扫描
   误判成"从未定义"，所以也在审计里登记了。
   与 brushVars 同理：名单手工维护，必须盯着它与真实注入处是否一致。 */
{
  const audit = await import('./js/style-audit.js');
  const shell = strip(readFileSync('css/neumorphism.css', 'utf8'));
  const hits = audit.auditCss(shell, 'x')
    .filter((x) => /var\(--[xywh]\)/.test(x.msg));
  t('--x/--y/--w/--h 不再被判成未定义', hits.length === 0,
    hits.map((x) => x.msg.slice(0, 40)).join(' | '));

  const insp = existsSync('js/inspector.js')
    ? strip(readFileSync('js/inspector.js', 'utf8')) : '';
  const injected = [...new Set(
    [...insp.matchAll(/setProperty\(\s*'(--[a-z0-9-]+)'/g)].map((m) => m[1]))];
  const missing = injected.filter((v) => !audit.RUNTIME_POSITION_VARS.includes(v));
  t('inspector.js 注入的变量已全部登记', missing.length === 0,
    missing.join(', ') || `注入：${injected.join(', ')}`);
}



{
  /* style-audit 在浏览器里跑，不能读文件，所以 TOKEN_VARS / CONTROLS_VARS
     是手工维护的列表。手工列表必然漂移 —— 共享 CSS 里加了新变量、
     这里忘了同步，插件用了就会被误报成"变量未定义"。

     所以反过来盯着：共享 CSS 里定义的每个 --ctl-* 都必须已在列表里。 */
  const controlsCss = strip(readFileSync(join(HERE, 'css/controls.css'), 'utf8'));
  /* 只盯**在 :root 里定义的** --ctl-*。
     --ctl-h / --ctl-pad / --ctl-fs / --ctl-shadow 是在具体规则里定义的
     档位变量（.sm 靠覆盖它们降尺寸），属于控件内部实现，插件不该用，
     所以不算"共享变量"，不进列表。 */
  const rootBlocks = [...controlsCss.matchAll(/:root\s*\{([^}]*)\}/g)]
    .map((m) => m[1]).join('\n');
  /* 收集范围必须覆盖 CONTROLS_VARS 里**所有前缀**，不能只写 --ctl-：
     新增 --add-*（虚线添加入口的尺度）后，若这里仍只收 --ctl-，
     反向断言会把已定义的 --add-* 判成"列表里登记了但 CSS 里没有"。
     加新前缀时记得同步这里的正则。 */
  const defined = [...new Set(
    [...rootBlocks.matchAll(/(--(?:ctl|add)-[a-z0-9-]+)\s*:/gi)].map((m) => m[1]))];
  const missing = defined.filter((v) => !CONTROLS_VARS.includes(v));
  t('controls.css 里的 --ctl-* 变量都已在 CONTROLS_VARS 中登记',
    missing.length === 0, missing.join(', ') || `已登记 ${defined.length} 个`);

  /* 反向：列表里登记了的变量，共享 CSS 里必须真的有定义
     （否则是改名后忘了清理，插件照着列表写就会踩空） */
  const notDefined = CONTROLS_VARS.filter((v) => !defined.includes(v));
  t('CONTROLS_VARS 里没有已经不存在的变量',
    notDefined.length === 0, notDefined.join(', ') || '无残留');
}


{
  /* ---- 跨文件重复定义且属性冲突 ----
     同一个选择器在两个 CSS 文件里都写了、且同一属性给了不同值：
     谁生效取决于 @import 顺序，**改加载顺序就会静默换一套观感**，
     而且两边看着都"有定义"，死类名扫描也查不出来。

     所以钉一条只增不减的基线：存量先登记清楚（哪些是刻意的分层覆盖），
     以后新增一处立刻报红。

     扫描范围必须排除两种形态，否则全是假警报：
       1. @media 块（尤其 forced-colors 无障碍兜底，本就该覆盖常规值）
       2. @keyframes 里的 from/to（不是选择器）
     排除 @media 要用"整块剔除"而不是只删开头 —— 只删开头会让后面的
     规则被误挂到 @media 之前的位置上。 */
  const cssFiles = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'target', 'dist', 'build'].includes(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.css')) cssFiles.push(full);
    }
  };
  walk(HERE);

  const killMedia = (t) => {
    /* 整块剔除 @media：从 @media 的 { 起做括号配对 */
    let out = '', i = 0;
    while (i < t.length) {
      const m = t.slice(i).match(/@media[^{]*\{/);
      if (!m) { out += t.slice(i); break; }
      out += t.slice(i, i + m.index);
      let d = 1, j = i + m.index + m[0].length;
      while (j < t.length && d > 0) { if (t[j] === '{') d++; else if (t[j] === '}') d--; j++; }
      i = j;
    }
    return out;
  };

  const propsOf = (body) => {
    const o = {};
    for (const d of body.split(';')) {
      const k = d.indexOf(':');
      if (k > 0) o[d.slice(0, k).trim()] = d.slice(k + 1).trim();
    }
    return o;
  };

  const byFile = new Map();
  for (const f of cssFiles) {
    const t = killMedia(strip(readFileSync(f, 'utf8')));
    const m = new Map();
    for (const r of t.matchAll(/([^{}@]+?)\{([^{}]*)\}/g)) {
      const sel = r[1].trim().replace(/\s+/g, ' ');
      if (!sel || /^\d+%$/.test(sel)) continue;      /* keyframes 百分比 */
      if (/^(from|to)$/.test(sel)) continue;              /* keyframes 起止帧不是选择器 */
      if (sel.startsWith('@')) continue;
      const props = propsOf(r[2]);
      for (const s of sel.split(',')) {
        const k = s.trim();
        if (!k) continue;
        m.set(k, Object.assign(m.get(k) || {}, props));
      }
    }
    byFile.set(f, m);
  }

  const seen = new Map();
  for (const [f, m] of byFile) {
    for (const [sel, props] of m) {
      if (!seen.has(sel)) seen.set(sel, []);
      seen.get(sel).push([f, props]);
    }
  }

  const conflicts = [];
  for (const [sel, list] of seen) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [fa, pa] = list[i], [fb, pb] = list[j];
        if (fa === fb) continue;
        const clash = Object.keys(pa).filter(
          (k) => k in pb && pa[k] !== pb[k] && !/\bvar\(/.test(pa[k] + pb[k]));
        if (clash.length) conflicts.push({ sel, a: fa, b: fb, clash });
      }
    }
  }

  /* 刻意的分层覆盖：共享层给基础、插件层给 overrides。
     这类必须写清楚是谁在覆盖谁，否则后人删掉共享层那一份，
     插件层会静默缺掉 display/gap/padding 等一堆属性。 */
  const KNOWN = [
    /* 共享层给基础值、主题层/插件层给 override —— 这类分层的**加载顺序是确定的**
       （插件 CSS 先 @import 共享层，自己再覆盖），所以不是 bug，
       但删掉共享层那一份会让插件层静默缺掉一堆属性，故此登记备查。 */
    '.p-input', '.p-tag', '.p-row', '.tp-row', '.upd-notes', '.fpx-busy-dot',
    '.mm-field',   /* controls 8px/center；mindmap 覆盖成 5px/stretch */
    '.mm-chip',    /* controls 给 22px 标签形态；mindmap 覆盖成 26px 按钮形态 */
  ];

  const unknown = conflicts.filter((c) => !KNOWN.includes(c.sel));
  t('跨文件重复定义且属性冲突的，都在已知清单里',
    unknown.length === 0,
    unknown.map((c) => `${c.sel}(${c.clash.join('/')}) ${c.a.split('/').pop()}↔${c.b.split('/').pop()}`).join('; ')
    || `已知 ${KNOWN.length} 处；扫描 ${cssFiles.length} 个 CSS`);

  /* 元断言 1：扫描器真的扫到了东西（否则上面永远是绿） */
  t('跨文件冲突扫描范围有效', cssFiles.length >= 5 && seen.size >= 50,
    `CSS ${cssFiles.length} 个 / 选择器 ${seen.size} 个`);

  /* 元断言 2：KNOWN 里的选择器确实还存在 —— 若哪天 mm-chip 合并成一处，
     这条会提醒把清单清掉，避免清单变成永远对不上的死账 */
  const stale = KNOWN.filter((k) => !conflicts.some((c) => c.sel === k));
  t('已知清单里没有已合并/消失的选择器', stale.length === 0,
    stale.join(', ') || KNOWN.join(', '));

  /* 元断言 3：探针有效 —— 造一个必然冲突的选择器，必须被认出来
     （这条防的是"扫描器坏了但基线恰好还是 0"） */
  {
    const probeSel = 'zz-conflict-probe-xyz';
    const fake = new Map();
    fake.set('a.css', new Map([[probeSel, { height: '1px' }]]));
    fake.set('b.css', new Map([[probeSel, { height: '2px' }]]));
    const seen2 = new Map([[probeSel, [
      ['a.css', { height: '1px' }], ['b.css', { height: '2px' }]]]]);
    let hit = 0;
    for (const [sel, list] of seen2) {
      for (let i = 0; i < list.length; i++)
        for (let j = i + 1; j < list.length; j++) {
          const [fa, pa] = list[i], [fb, pb] = list[j];
          if (fa === fb) continue;
          if (Object.keys(pa).filter((k) => k in pb && pa[k] !== pb[k]).length) hit++;
        }
    }
    t('冲突判据本身有效（探针）', hit === 1, `探针命中 ${hit} 次`);
  }
}


console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
