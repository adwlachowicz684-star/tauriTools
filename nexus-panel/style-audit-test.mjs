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
import { stripComments as strip, stripCommentsKeep } from './test-scan-utils.mjs';

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
  const pg = strip(readFileSync(join(HERE, 'plugins/project-group/style.css'), 'utf8'));
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
  const shell = strip(readFileSync(join(HERE, 'css/neumorphism.css'), 'utf8'));
  const hits = audit.auditCss(shell, 'x')
    .filter((x) => /var\(--[xywh]\)/.test(x.msg));
  t('--x/--y/--w/--h 不再被判成未定义', hits.length === 0,
    hits.map((x) => x.msg.slice(0, 40)).join(' | '));

  const insp = existsSync(join(HERE, 'js/inspector.js'))
    ? strip(readFileSync(join(HERE, 'js/inspector.js'), 'utf8')) : '';
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
      if (['node_modules', '.git', 'target', 'dist', 'runtime-plugins', 'build'].includes(e.name)) continue;
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

  /*
   * ⚠️ 不能"只要任一值含 var() 就跳过比较"。
   *
   * 此前正是这么写的（`!/\bvar\(/.test(a+b)`），后果是**令牌化越彻底、守卫越瞎**：
   * 把间距收口到 --sp-* 之后，`.p-row` 的 `12px ↔ 8px` 变成
   * `var(--sp-6) ↔ var(--sp-4)`，两边都带 var()，守卫直接判"不冲突"，
   * 三条真实冲突从清单里消失了（表现为"已知清单里有已消失的选择器"报红）。
   *
   * 正确做法：--sp-* / --fs-* / --dur-* / --anim-* / --z-* 是**静态尺度**
   * （定义在 tokens.css，不随主题变），可以求值后比较；
   * --surface / --accent / --r-sm 这类才是**主题相关**，值随主题变，
   * 无法静态判定，只能跳过。
   */
  const STATIC = /^--(sp|fs|dur|anim|z)-/;
  const staticTok = new Map();
  {
    const tk = strip(readFileSync(join(HERE, 'css/tokens.css'), 'utf8'));
    for (const m of tk.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (STATIC.test(m[1])) staticTok.set(m[1], m[2].trim());
    }
  }
  /* 递归求值；遇到主题相关令牌就放弃（返回 null） */
  const resolve = (v, depth = 0) => {
    if (depth > 4 || !/\bvar\(/.test(v)) return v;
    let out = v;
    for (const m of [...v.matchAll(/var\(\s*(--[\w-]+)\s*(?:,\s*([^)]*))?\)/g)]) {
      const def = staticTok.get(m[1]);
      const lit = def !== undefined ? def : (m[2] || '').trim();
      if (!lit || /\bvar\(/.test(lit)) return null;   /* 主题相关，无法静态比较 */
      out = out.split(m[0]).join(lit);
    }
    return /\bvar\(/.test(out) ? null : out.replace(/\s+/g, ' ').trim();
  };

  const conflicts = [];
  for (const [sel, list] of seen) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [fa, pa] = list[i], [fb, pb] = list[j];
        if (fa === fb) continue;
        const clash = Object.keys(pa).filter((k) => {
          if (!(k in pb)) return false;
          const ra = resolve(pa[k]), rb = resolve(pb[k]);
          /* 有一边求不出值（主题相关）→ 无法判定，不报 */
          if (ra === null || rb === null) return false;
          return ra !== rb;
        });
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
    /*
     * ⚠️ 这里**曾**有 '.tp-row'，已移出：它不是"分层覆盖"，而是**撞名**。
     *   controls.css 的 .tp-row 是主题参数面板的「参数行」；
     *   neumorphism.css 曾另有一条 .tp-row，是主题缩略图里那排小色条
     *   —— 同名不同物，二者同现于设置页，互相污染（详见 neumorphism.css）。
     *   缩略图那条已改名 .tp-bars，冲突随之消失。
     * 别把它加回来：加回来等于把一次撞名当成"基础值 + override"记档。
     */
    '.p-input', '.p-tag', '.p-row', '.upd-notes', '.fpx-busy-dot',
    '.mm-field',   /* controls 8px/center；mindmap 覆盖成 5px/stretch */
    '.mm-chip',    /* controls 给 22px 标签形态；mindmap 覆盖成 26px 按钮形态 */
    /*
     * ⚠️ 这两条是**陷阱**，不是"两边都对"：
     * dialog.css 在文件里**完整重写**了 .nx-btn / .nx-input 的基础形态
     * （按钮 32px + 描边、输入框 13px），而所有入口的加载顺序都是
     * controls.css → dialog.css，同级同权重下**后者胜**。
     * 于是 controls.css 里那份基础定义在任何文档里都不生效 ——
     * 谁去 controls.css 改按钮高度都会发现"改了没反应"。
     *
     * 之所以登记而不是直接删掉 dialog.css 那份：
     * 有入口只引 dialog.css、不引 controls.css（color-picker/index.js），
     * 删了那份会让那些文档里的按钮/输入框变成裸元素。
     * 真要收拾，得先把 dialog.css 那份收窄成 `.nx-dlg .nx-btn` 之类的
     * 作用域写法 —— 那会改变观感，属于需要产品拍板的事。
     */
    '.nx-btn', '.nx-input',
    /*
     * .fpx-busy 在 neumorphism.css（外壳主文档）与 project-group/style.css
     * 各有一份。project-group 在 Vite 模式下两份都加载（main.tsx 先引
     * neumorphism 再引 style.css），所以这里不是"永不共现" —— 登记备查。
     */
    '.fpx-busy',
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

  /*
   * 元断言 4：清单里每一条都必须有**跨文件出处说明**。
   *
   * 光登记"这两处冲突"是不够的：后人打开其中一个文件，看不见另一个
   * 文件的存在，就会照着"改了没反应"去查缓存 / 查构建 / 查浏览器，
   * 而真相只是同权重下另一份在后。说明必须**点名另一个文件**
   * （不是泛泛写"别处也有"），否则等于没写。
   *
   * 判定方式：在定义处的上下文里（前 12 行到块末）找 .css 文件名，
   * 且那个文件名**不是当前文件自己** —— 只提自己不算出处。
   */
  {
    const miss = [];
    for (const k of KNOWN) {
      let cited = false;
      for (const f of cssFiles) {
        const base = f.split(/[\\/]/).pop();
        const raw = readFileSync(f, 'utf8');
        const lines = raw.split('\n');
        const stripped = stripCommentsKeep(raw);   /* 保偏移：位置能映回原文行号，才能取到注释 */
        /* 只需转义点号：KNOWN 里都是 `.类名` 形态（含 `:disabled` 等后缀，
           冒号/连字符在正则里无特殊含义）。
           别用 `k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` 那套通用转义 ——
           替换串里的 `$&` 会被当成"整个匹配"展开，实际得到的是 `$\\.`，
           正则变成 `$\\.mm-chip` 这种永远不匹配的式子，断言**永远绿**。 */
        const re = new RegExp('(^|[\\s,])' + k.replaceAll('.', '\\.')
          + '(\\s|,|\\{|\\.|$)', 'g');
        for (const m of stripped.matchAll(re)) {
          const ln = stripped.slice(0, m.index).split('\n').length;   /* 1-based 行号 */
          /* 窗口取前 25 行：注释块常在定义上方十几行（.fpx-busy 那份
             撞名说明距定义 20 行），取窄了会把真说明判成"没写"。 */
          const ctx = lines.slice(Math.max(0, ln - 25), ln + 15).join('\n');
          for (const cm of ctx.matchAll(/([\w./-]+\.css)/g)) {
            if (cm[1].split(/[\\/]/).pop() !== base) { cited = true; break; }
          }
          if (cited) break;
        }
        if (cited) break;
      }
      if (!cited) miss.push(k);
    }
    t('已知清单每条都点名了另一个文件（否则后人看不见冲突的另一半）',
      miss.length === 0, miss.join(', ') || `已知 ${KNOWN.length} 处全部有出处`);
  }

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

    /* 元断言 5：出处判据不能失明 —— 把注释里的文件名抹掉，必须报红。
       这条防的是"窗口/正则写错，于是每条都被判成有出处"。 */
    {
      const probe = '.zz-cite-probe';
      const bare = [`a.css`, `b.css`];
      const mk = (name, withCite) => {
        const body = `${probe} { height: ${withCite ? '1px' : '2px'}; }`;
        return withCite
          ? `/* 另一份在 ${bare[1]} —— 点名了 */\n${body}`
          : `${body}`;
      };
      /* 有出处 → 判有；无出处 → 判无。两端都验，避免判据恒真 */
      const citedOk = /[\w./-]+\.css/.test(mk('a', true));
      const bareOk = !/[\w./-]+\.css/.test(mk('a', false));
      t('出处判据本身有效（探针）', citedOk && bareOk,
        `有出处=${citedOk} 无出处=${bareOk}`);
    }
  }
}

console.log('\n=== 9. 块注释里不得再开一个块注释 ===');
/*
 * 删注释时只删掉"后半截"（从注释体的某一行删到规则末尾）会在原处留下
 * 一个**孤儿开头**。它的危险在于：
 *   - 浏览器照样解析 —— 从那个开头一直吃到下一个结束符，
 *     于是夹在中间的规则**整条失效**（界面上看不出报错，只是样式没了）
 *   - 按个数统计开头与结束符是配平的，**查不出来**
 *   - 剥注释类扫描器把被吞的规则一起剥掉，"样式在不在"的断言也跟着假绿
 *
 * 实测就是这个形状：删一条重复规则时留下孤儿开头，把 `.fpx-ca-item.dragging`
 * 整条吞掉 —— 拖连锁动作时"被拖项压暗"消失，界面上出现两个"当前项"
 * （原位置与拖影）。唯一报红的是 action-sort 的源码守卫。
 *
 * ⚠️ 判据不能是"注释里不得出现规则"：仓库里有一批**刻意停用**的幽灵规则
 * （`/*` 单独一行、规则整段、结束符单独一行），那是正常的停用手段。
 * 真正**永远**是错的只有一种：注释内部又出现一个开头 ——
 * CSS 没有嵌套块注释，内层那个开头会被忽略，而它的结束符**提前闭合了外层**，
 * 于是作者的意图必然被打断。
 */
{
  /** 逐字符扫，返回嵌套开头所在行 */
  function nestedOpeners(src) {
    const out = [];
    let inC = false, line = 1, startLine = 0;
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (c === '\n') { line++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        if (inC) out.push(`L${line}（外层始于 L${startLine}）`);
        else { inC = true; startLine = line; }
        i++; continue;
      }
      if (inC && c === '*' && src[i + 1] === '/') { inC = false; i++; continue; }
    }
    return out;
  }

  const cssFiles = [
    ...['controls.css', 'neumorphism.css', 'dialog.css', 'tokens.css']
      .map((n) => [`css/${n}`, join(HERE, 'css', n)]).filter(([, p]) => existsSync(p)),
    ...pluginCss,
  ];
  t('扫描范围有效（共享 + 插件 CSS）', cssFiles.length >= 5, `${cssFiles.length} 个`);
  for (const [rel, abs] of cssFiles) {
    const bad = nestedOpeners(readFileSync(abs, 'utf8'));
    t(`${rel} 无嵌套块注释`, bad.length === 0, bad.slice(0, 2).join(' | '));
  }
  t('判据本身有效（探针：嵌套必须报出来）',
    nestedOpeners('/* 外层\n/* 内层\n*/\n').length === 1);
  /* 反方向：刻意停用的幽灵规则（整段注释）不能被误报 */
  t('判据不误报刻意停用的规则段',
    nestedOpeners('/*\n.ghost { color: red; }\n*/\n').length === 0);
}


/* 第 10 节要全仓扫一遍定义点（800+ 文件，约 40 秒），第 11 节要用同一份
   结果 —— 扫两次太慢，故提到外层共享。 */
let repoDefined = null;
let repoFiles = null;

console.log('\n=== 10. 清单条目不得是幽灵（登记了却全仓无人定义）===');
/* 这三份清单是**免死金牌**：进了 SHELL_VARS / TOKEN_VARS / CONTROLS_VARS 的
   名字，E2 判据就对它闭嘴。所以里面躺着一个全仓无人定义的名字是危险的 ——
   谁写了 var(--xxx) 不会被报，而它取到空值（色块/进度条是空的，且不报错）。

   --accent-2 与 --info 就是这样被清掉的：前者在 settings/index.js 的注释里
   被点名"旧名已废弃，取到 undefined 会画出空条"，后者全仓零引用。留着它们
   等于给这两类写法发免死金牌。 */
{
  const audit = await import('./js/style-audit.js');
  /* 与第 6 节那个 walk 同一份跳过名单 —— runtime-plugins/ 与 dist/ 同类
     （构建产物，.gitignore 里躺着）：里面的 CSS 是打包结果，
     var() 兜底、压缩变量名全是机器生成的，扫进去只有假报。
     两份名单各写一份迟早漂移（本次就是第 10 节漏了 runtime-plugins，
     本地一构建就红）。 */
  const SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'runtime-plugins', 'build', '.tool_output']);
  const EXTS = ['.css', '.js', '.ts', '.tsx', '.mjs', '.html'];
  const files = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (SKIP.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!EXTS.some((x) => e.name.endsWith(x))) continue;
      /* 测试文件里的 CSS 片段是**探针**（故意写错的 --surface-2、
         --text-mute-typo 之类），不是真用法 —— 扫进去会假报。
         插件 tests/ 目录同理。 */
      if (/(-test\.mjs|\.test\.tsx?)$/.test(e.name)) continue;
      if (/(^|\/)tests\//.test(p)) continue;
      files.push(p);
    }
  })(HERE);
  t('扫描范围有效（全仓样式与脚本）', files.length >= 200, `${files.length} 个文件`);
  repoFiles = files;

  const defined = new Set();
  /* 既认 CSS 的 `--x: v`，也认 JS 对象/内联样式里的 `'--x': v` ——
     后者在 tsx 的 style={{ '--x': v }} 里很常见，漏了就会假报幽灵。 */
  const DEF_RE = /(--[a-z0-9-]+)\s*['"]?\s*:/gi;
  for (const p of files) {
    /* 剥注释：注释里提到的名字不算定义，否则"不该报的没报"这类断言会假绿 */
    const s = strip(readFileSync(p, 'utf8'));
    for (const m of s.matchAll(DEF_RE)) defined.add(m[1]);
    for (const m of s.matchAll(/setProperty\(\s*['"`](--[a-z0-9-]+)/gi)) defined.add(m[1]);
  }

  const LISTS = { SHELL_VARS: audit.SHELL_VARS, TOKEN_VARS: audit.TOKEN_VARS,
                  CONTROLS_VARS: audit.CONTROLS_VARS };
  const ghosts = [];
  for (const [n, list] of Object.entries(LISTS)) {
    for (const v of list) if (!defined.has(v)) ghosts.push(`${n}:${v}`);
  }
  t('清单里没有幽灵条目', ghosts.length === 0, ghosts.join(', '));

  /* 判据失明比报红危险：若一个拼错的名字被当成"已定义"，这条断言就永远绿 */
  t('判据本身有效（探针：无人定义的名字必须被判幽灵）',
    !defined.has('--probe-ghost-zzz'));
  t('判据不误报（确有定义的名字不算幽灵）', defined.has('--text-mute'));

  repoDefined = defined;
}

console.log('\n=== 11. 变量名拼错：存在近似令牌却全仓无人定义 ===');
/*
 * 这是"幽灵条目"的另一半：名字不在清单里，但**长得像某个真实令牌**
 * （--warning ↔ --warn、--radius-sm ↔ --r-sm、--mono ↔ --font-mono）。
 * 与幽灵条目相比它更隐蔽 —— 因为 var() 带字面兜底时**什么都不报**：
 * 样式生效、界面正常，只是那个令牌从来没被用上，观感恒定等于兜底值。
 * 实测三处都是这个形状：
 *   --warning    → 兜底 --accent，警告色边框一直是强调色
 *   --radius-sm  → 兜底 4px，圆角不跟随主题（--r-sm 实为 9px）
 *   --mono       → 兜底字体串，等宽不跟随设计系统（--font-mono）
 *
 * 判据取"前缀/后缀近似"而不是编辑距离：上面三处的距离分别是 3 / 5 / 5，
 * 任何距离阈值都卡不住；而它们都满足"与某个已定义名字首尾相接"。
 * 实测 15 个未定义变量命中 10 个，其中 4 个是真拼错（另 4 个是预留钩子、
 * 2 个是尚未定档的缺口），误报率可接受。
 *
 * ⚠️ 豁免项必须写明理由 —— 否则这份清单会变成"先报了再豁免"的垃圾桶。
 */
{
  const defined = repoDefined;
  t('复用第 10 节的定义点扫描结果', !!defined && defined.size > 100,
    defined ? `${defined.size} 个变量` : 'null');

  /* 动态拼名的变量（brushVars 的 --grp-* / inspector 的 --x/--y）在运行时注入，
     静态扫不到定义点，必须先排除，否则全是假报。 */
  const audit = await import('./js/style-audit.js');
  const dynamic = new Set([...audit.BRUSH_VARS, ...audit.RUNTIME_POSITION_VARS]);
  const isKnown = (v) => defined.has(v) || dynamic.has(v);

  const EXEMPT = new Map([
    /* agent-flow 的框体钩子：壳侧不注入，兜底恒生效是设计意图（见 styles.css） */
    ['--af-frame-', '前缀：agent-flow 预留钩子，壳侧不注入'],
    ['--dlg-edge', '弹窗的覆盖钩子（controls-test 第 2521 行钉着这个写法）'],
    ['--md-code-bg', 'md/export.js 生成的独立 HTML，自带一套 --md-*，不引主题变量'],
    /* 下面两条是**真缺口**（名字从来没被定义），不修是因为补了会改观感：
       已在各自的定义处就地写明，这里只登记名字与去处。 */
    ['--accent-soft', '缺口：补定义会让"已选"标签长出底色（css/neumorphism.css 已标注）'],
    ['--r-card', '缺口：圆角档位里没有 card 这一档（css/neumorphism.css 已标注）'],
  ]);
  const exemptOf = (v) =>
    EXEMPT.get(v) || [...EXEMPT.keys()].find((k) => k.endsWith('-') && v.startsWith(k));

  /* 复用第 10 节的文件列表再取一遍使用点 */
  const files = repoFiles;
  t('复用第 10 节的文件列表', !!files && files.length >= 200, files ? `${files.length} 个` : 'null');
  const used = new Map();
  for (const p of files) {
    const s = strip(readFileSync(p, 'utf8'));
    for (const m of s.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      if (!used.has(m[1])) used.set(m[1], p);
    }
  }
  const name = (v) => v.slice(2);
  const suspects = [];
  for (const [v, where] of used) {
    if (isKnown(v)) continue;
    if (exemptOf(v)) continue;
    const nv = name(v);
    const near = [...defined].filter((d) => {
      const nd = name(d);
      return d !== v && nd &&
        (nv.startsWith(nd) || nv.endsWith(nd) || nd.startsWith(nv) || nd.endsWith(nv));
    });
    if (near.length) suspects.push(`${v}(近似 ${near.slice(0, 2).join('/')}) @ ${where}`);
  }
  t('没有拼错的变量名', suspects.length === 0, suspects.slice(0, 3).join(' | '));

  /* 判据失明比报红危险：下面两条钉住它两端 */
  const rel = (a, b) => {
    const [x, y] = [name(a), name(b)];
    return x.startsWith(y) || x.endsWith(y) || y.startsWith(x) || y.endsWith(x);
  };
  t('判据本身有效（探针：--warning 与 --warn 必须判为近似）',
    rel('--warning', '--warn') && !rel('--bg', '--sh-dark'));
  for (const k of ['--accent-soft', '--r-card']) {
    t(`豁免项 ${k} 仍未定义（若已补上请移除豁免并删除就地标注）`, !defined.has(k));
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
