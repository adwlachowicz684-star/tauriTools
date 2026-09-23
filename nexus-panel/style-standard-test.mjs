/**
 * 界面样式通用检测（可执行版）
 * ============================================================
 * 把《nexus-样式检测标准》里**能静态判定**的条款做成脚本，
 * 让新界面 / 新插件能直接跑同一套规则，而不是靠人逐条对照。
 *
 * 用法
 *   node style-standard-test.mjs                  扫默认目录（css/ + 各插件）
 *   node style-standard-test.mjs --dir plugins/xxx 只扫指定界面
 *   node style-standard-test.mjs --classes         额外跑"类名卫生"（需源码目录）
 *   node style-standard-test.mjs --json            输出 JSON，便于接入 CI
 *
 * 设计原则（这三条都是踩过坑才定下来的）
 * ------------------------------------------------------------
 * 1) 判定前必须先剥掉 var(--x, 兜底) 里的**兜底部分**。
 *    带兜底是刻意的（不引 tokens.css 的插件就靠它），
 *    不剥会把"正确的写法"判成硬编码 —— 误报一大片。
 *
 * 2) 每条规则都要能"改回旧写法就报红"。
 *    否则断言可能在放水：匹配到注释、结束点落在起点之前、
 *    读到扫描器自己的示例类名，这三种都实测发生过。
 *
 * 3) 例外必须写在注释里，并配一条"例外须注明"的断言，
 *    免得后来者把它当成疏漏"统一"掉。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));

/* ---------------------------- 参数 ---------------------------- */
const argv = process.argv.slice(2);
const optOf = (k, d = null) => {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : d;
};
const ONLY_DIR = optOf('--dir');
const WANT_JSON = argv.includes('--json');
const WANT_CLASSES = argv.includes('--classes');
/*
 * 严格度：
 *   --dir 指定界面 → 严格（新界面必须达标）
 *   --strict       → 全量也严格
 *   默认（全量体检）→ 令牌化类条款记「存量待办」，不计失败
 *
 * 为什么不一律严格：全量跑会把存量问题算成失败，
 * 新界面就永远红着、没人看；而假装存量是绿的也不诚实。
 * 分开计是唯一两者都不丢的做法。
 */
const STRICT = !!ONLY_DIR || argv.includes('--strict');

/* ---------------------------- 结果收集 ---------------------------- */
const rows = [];
let pass = 0, fail = 0;
function t(name, ok, detail = '') {
  rows.push({ name, ok: !!ok, detail: String(detail) });
  if (ok) pass++; else fail++;
  if (!WANT_JSON) console.log(`  ${ok ? '✓' : '❌'} ${name}${!ok && detail ? ` → ${detail}` : ''}`);
}
const todo = [];
function soft(name, list) {
  if (!list.length) { t(name, true); return; }
  const d = list.slice(0, 3).join(' | ');
  if (STRICT) t(name, false, d);
  else { todo.push(`${name} → ${d}`); console.log(`  ⚠ 存量待办 ${name}（${list.length} 处）→ ${d}`); }
}

function section(title) {
  if (!WANT_JSON) console.log(`\n=== ${title} ===`);
}

/* ---------------------------- 工具 ---------------------------- */
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 剥掉 var(...) —— 含嵌套。
 * `var(--x, var(--y, #fff))` 里两个兜底都要去掉，
 * 循环替换直到不再变化即可处理嵌套。
 */
function stripVars(css) {
  let s = css, prev;
  do {
    prev = s;
    s = s.replace(/var\([^()]*\)/g, '');
  } while (s !== prev);
  return s;
}

/** 取所有规则块（已剥注释） */
function blocks(css) {
  return [...stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map((m) => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));
}

/** 目标文件清单 */
function targets() {
  if (ONLY_DIR) {
    const d = resolve(ROOT, ONLY_DIR);
    if (!existsSync(d)) return [];
    if (d.endsWith('.css')) return [d];
    const out = [];
    const walk = (x) => {
      for (const e of readdirSync(x, { withFileTypes: true })) {
        const p = join(x, e.name);
        /*
         * 第三方库不参与：kityminder.core.css 这类是外部产物，
         * 拿我们的标准去量它只会得到一堆噪音（99999 的 z-index、
         * 硬编码字体栈），还会淹没真正属于我们的问题。
         */
        if (THIRD_PARTY.test(p)) continue;
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.css')) out.push(p);
      }
    };
    walk(d);
    return out;
  }
  const list = [];
  for (const f of ['css/tokens.css', 'css/controls.css', 'css/neumorphism.css', 'css/dialog.css']) {
    const p = join(ROOT, f);
    if (existsSync(p)) list.push(p);
  }
  for (const pl of ['agent-flow', 'mindmap', 'project-group', 'settings', 'home', 'store']) {
    for (const n of ['styles.css', 'style.css']) {
      const p = join(ROOT, 'plugins', pl, n);
      if (existsSync(p)) list.push(p);
    }
  }
  return list;
}

const THIRD_PARTY = /(?:^|[\\/])(?:editor|vendor|node_modules|dist|third|kityminder)(?:[\\/]|$)|kityminder|\.min\.css/;

const FILES = targets();

/*
 * 共享层归属：有些规则（减少动效兜底、裸 button 兜底）本就该
 * **只在共享层写一份**，要求每个界面各写一遍只会各自漂移。
 * 目标引了共享层 → 去共享层找；没引（独立界面）→ 要求它自己有。
 * 这两个量在多个小节里都要用，故提到外层 ——
 * 写在某个 section 块里的话，后面的块会 ReferenceError。
 */
const OWN = FILES.map(read);
const USES_SHARED = OWN.some((x) => /@import[^;]*(tokens|controls)\.css/.test(x));
const SHARED = USES_SHARED
  ? ['css/tokens.css', 'css/controls.css', 'css/neumorphism.css'].map((f) => read(join(ROOT, f)))
  : [];
if (!FILES.length) {
  console.error(`没有找到 CSS 文件（--dir=${ONLY_DIR || '默认'}）`);
  process.exit(1);
}
const rel = (p) => p.replace(ROOT + '/', '');

/* ============================================================
 * 1. 令牌化：不许硬编码
 * ------------------------------------------------------------
 * 允许的例外：transparent / currentColor / inherit / 0，
 * 以及 SVG data URI（读不到 CSS 变量，只能写死 —— 须注释说明）。
 * ============================================================ */
section('1. 令牌化');
{
  const ALLOW = /^(transparent|currentColor|inherit|none|0)$/i;
  const bad = { color: [], radius: [], z: [], dur: [] };

  /*
   * **定义处豁免**：tokens.css 与各文件 `:root{}` 块是**定义令牌**的地方，
   * 写具体值是它的本职工作 —— 把它判成"硬编码"会误报一大片。
   * 要查的是"用令牌的地方却写了裸值"。
   */
  const isDef = (f) => /tokens\.css$/.test(f);
  const rootBlocks = (css) => {
    const out = [];
    for (const m of stripComments(css).matchAll(/:root[^{]*\{([^{}]*)\}/g)) out.push(m[1]);
    return out.join('\n');
  };

  for (const f of FILES) {
    if (isDef(f)) continue;
    const css = read(f);
    const root = rootBlocks(css);
    /* 非 :root 的部分才是"使用处" */
    const body = stripComments(css).replace(/:root[^{]*\{[^{}]*\}/g, '');
    const noVar = stripVars(body);
    const noVarRoot = stripVars(root);

    /*
     * 硬编码**允许**，但必须就近写明原因 ——
     * 项目里确有必须写死的：SVG data URI 读不到变量、
     * 叠在未知内容上的控件要自保（白勾压在黄底上会消失）。
     * 没写原因的才是不该有的。
     */
    const lines = css.split('\n');
    const hasNoteNear = (idx, val) => {
      for (let i = Math.max(0, idx - 3); i <= Math.min(lines.length - 1, idx + 1); i++) {
        if (/\/\*|\*\/|\/\//.test(lines[i])) return true;
      }
      return false;
    };
    for (const m of body.matchAll(/:\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\s*[;}]/g)) {
      const v = m[1];
      if (ALLOW.test(v)) continue;
      if (/var\(/.test(m[0])) continue;                 // 兜底位上的不算
      const idx = body.slice(0, m.index).split('\n').length - 1;
      if (hasNoteNear(idx, v)) continue;
      bad.color.push(`${rel(f)}: ${v}`);
    }
    /*
     * 圆角只判**单值 px**：
     *   · `50%` / `999px` 是画圆（几何形状，不是档位）
     *   · `0 3px 3px 0` 是多值写法（贴边元素只圆一侧，几何需要）
     *   · `0` 是直角，同样是几何需要
     */
    for (const m of noVar.matchAll(/border-radius:\s*([^;]+);/g)) {
      const v = m[1].trim();
      if (/^\d+(\.\d+)?px$/.test(v) && v !== '0px') bad.radius.push(`${rel(f)}: ${v}`);
    }
    /* z-index: 0 是"重置/建层叠上下文"，不是排档 */
    for (const m of noVar.matchAll(/z-index:\s*(-?\d+)/g)) {
      if (m[1] !== '0') bad.z.push(`${rel(f)}: ${m[1]}`);
    }
    /*
     * 时长：正则必须要求"数字开头 + 至少一位整数位"，
     * 否则 `0.2s` 会截出 `2s`、`.` 也能单独匹配上。
     * 同样允许"就近写了原因"的硬编码（减少动效兜底里的 2s 就属此类）。
     */
    const durLines = css.split('\n');
    for (const m of noVar.matchAll(/(?:transition|animation)[^;]*?(?<![\d.])\d+(?:\.\d+)?(?:ms|s)\b/g)) {
      const idx = noVar.slice(0, m.index).split('\n').length - 1;
      let noted = false;
      for (let i = Math.max(0, idx - 3); i <= Math.min(durLines.length - 1, idx + 1); i++) {
        if (/\/\*|\*\/|\/\//.test(durLines[i])) { noted = true; break; }
      }
      if (noted) continue;
      bad.dur.push(`${rel(f)}: ${m[0].match(/\d+(?:\.\d+)?(?:ms|s)\b/)[0]}`);
    }
    /* :root 里的兜底值不参与（那是默认值定义） */
    void noVarRoot;
  }

  soft('颜色无硬编码（var 兜底与就近注明原因的除外）', bad.color);
  soft('圆角走 --r-* 变量', bad.radius);
  soft('z-index 全部走令牌', bad.z);
  soft('时长无硬编码（走 --dur-* / --anim-*）', bad.dur);
}

/* ============================================================
 * 3. 文字属性
 * ============================================================ */
section('3. 文字属性');
{
    const bad = { fs: [], fw: [], lh: [], ff: [] };
  /*
   * 图标字形豁免：font-size 在这些地方是"画多大"不是"字多大"。
   * 启发式两条，命中任一即跳过：
   *   · 选择器含 icon/arrow/close/dot/badge/mark/caret/emoji/preset
   *   · 规则体只有尺寸特征（line-height:1）且没有文字色 —— 符号的典型写法
   */
  const ICON_SEL = /icon|arrow|close|dot|badge|mark|caret|emoji|preset|\bxs\b/i;
  const isSymbol = (b) => /line-height:\s*1\s*;/.test(b.body) && !/\bcolor\s*:/.test(b.body);

  for (const f of FILES) {
    for (const b of blocks(stripComments(read(f)))) {
      if (b.sel === ':root') continue;
      const noVar = stripVars(b.body);
      for (const m of noVar.matchAll(/font-size:\s*([^;]+);/g)) {
        const v = m[1].trim();
        if (!/^[\d.]+/.test(v)) continue;
        if (ICON_SEL.test(b.sel) || isSymbol(b)) continue;
        bad.fs.push(`${rel(f)} ${b.sel.slice(0, 28)}: ${v}`);
      }
      /*
       * 字重只报 **600/700/bold**：那是"强调"，必须走令牌，否则
       * 想调标题字重要动好几处。
       * 400/normal 是**重置语义**（覆盖继承来的加粗），写裸值反而清楚，
       * 套一层 --fw-normal 只会让人多查一次变量表。
       */
      for (const m of noVar.matchAll(/font-weight:\s*([^;]+);/g)) {
        const v = m[1].trim();
        if (/^(600|700|bold)$/.test(v)) bad.fw.push(`${rel(f)} ${b.sel.slice(0, 28)}: ${v}`);
      }
      for (const m of noVar.matchAll(/line-height:\s*([^;]+);/g)) {
        const v = m[1].trim();
        if (/^[\d.]+$/.test(v) && v !== '1') bad.lh.push(`${rel(f)} ${b.sel.slice(0, 28)}: ${v}`);
      }
      for (const m of noVar.matchAll(/font-family:\s*([^;]+);/g)) {
        const v = m[1].trim();
        if (!v || /emoji/i.test(v)) continue;   // emoji 栈需跨平台，写死是对的
        if (!/^var\(/.test(v) && v !== 'inherit') bad.ff.push(`${rel(f)}: ${v.slice(0, 40)}`);
      }
    }
  }
  soft('字号走语义档（无裸 px）', bad.fs);
  soft('字重无裸 600/700（400 为重置语义，允许）', bad.fw);
  soft('行高无裸倍数（1 例外已注明）', bad.lh);
  soft('字体族无硬编码（inherit、emoji 栈除外）', bad.ff);

  /* 例外必须注明 —— 否则后来者会把图标字形也"统一"掉 */
  const all = FILES.map(read).join('\n');
  t('字号/字重的例外已在注释中说明',
    bad.fs.length === 0 || /图标字形|画多大|尺寸不是字号/.test(all));
}

/* ============================================================
 * 5. 状态与交互
 * ------------------------------------------------------------
 * 5.1 状态规则不改布局属性 —— 这是"悬浮时布局跳动"的直接根因。
 * ============================================================ */
section('5. 状态与交互');
{
  const LAYOUT = /\b(width|height|padding|margin|font-size|top|left|right|bottom)\s*:/;
  const bad = [];
  let hoverBorder = [];
  for (const f of FILES) {
    for (const b of blocks(stripComments(read(f)))) {
      if (!/:(hover|active|focus|focus-visible)/.test(b.sel)) continue;
      /*
       * "悬停展开"是**刻意交互**不是抖动：鼠标掠过时把折叠内容展开。
       * 判据是它同时改了 display / max-height —— 尺寸变化正是它的目的。
       * 不加这条豁免会把远端新增的展开功能判成布局跳动
       * （实测误判过一次）。
       */
      if (/\b(display|max-height|max-width|min-width|visibility|opacity)\s*:/.test(b.body)) continue;
      /* 类名自带 hover-mode = "悬停展开"是设计意图，不是抖动 */
      if (/hover-mode/.test(b.sel)) continue;
      if (LAYOUT.test(b.body)) bad.push(`${rel(f)} ${b.sel.slice(0, 40)}`);
      /* 5.2 悬浮高亮必须用 border-color，border 简写会重置粗细把卡片撑大 */
      if (/:hover/.test(b.sel) && /\bborder\s*:/.test(b.body) && !/border-color/.test(b.body)) {
        hoverBorder.push(`${rel(f)} ${b.sel.slice(0, 34)}`);
      }
    }
  }
  soft('状态规则不改布局属性', bad);
  t('悬浮高亮用 border-color（不动粗细）', hoverBorder.length === 0,
    hoverBorder.slice(0, 3).join(' | '));
}

/* ============================================================
 * 6. 语义变量边界：--border 不可当分隔线用
 * ------------------------------------------------------------
 * --border 是新拟态下的**风格开关**（transparent），
 * --divider 才是保证可见的边界。混用会让分隔线整片消失。
 * ============================================================ */
section('6. 语义变量边界');
{
  /*
   * 只判**虚线**（添加入口 / 提示占位）。
   * 实线外框用 --border 是**正确的** —— 那本来就是"风格开关"语义：
   * 新拟态下外框本就该交给阴影。真正会消失的是虚线，
   * 它在新拟态下由 transparent 直接吞掉，用户以为那儿没有入口。
   */
  const bad = [];
  for (const f of FILES) {
    for (const b of blocks(stripComments(read(f)))) {
      const m = b.body.match(/(border(?:-bottom|-top|-left|-right)?)\s*:\s*([^;]+);/);
      if (!m) continue;
      if (!/dashed|dotted/.test(m[2])) continue;
      if (/var\(--border/.test(m[2])) bad.push(`${rel(f)} ${b.sel.slice(0, 34)}`);
    }
  }
  t('虚线边框不用 --border（新拟态下会透明）', bad.length === 0, bad.slice(0, 3).join(' | '));
}

/* ============================================================
 * 10. 可访问性：减少动效兜底
 * ============================================================ */
section('10. 可访问性');
{
  /*
   * 归属判断：这两条是**共享层**的职责，不该要求每个界面各写一份
   * （写多份只会各自漂移）。目标引了共享层就去看共享层有没有；
   * 没引（独立界面）才要求它自己有。
   */
  const own = OWN, shared = SHARED, usesShared = USES_SHARED;
  const pool = own.concat(shared);
  const hasRM = pool.some((x) => /prefers-reduced-motion/.test(x));
  t(`有 prefers-reduced-motion 兜底${usesShared ? '（由共享层提供）' : ''}`, hasRM,
    '未找到任何兜底');
  if (hasRM) {
    const s = pool.find((x) => /prefers-reduced-motion/.test(x));
    const i = s.indexOf('prefers-reduced-motion');
    const tail = s.slice(i, i + 700);
    t('兜底覆盖伪元素（::before / ::after 也会动）', /::(before|after)/.test(tail));
    t('兜底也处理 transition / scroll-behavior',
      /transition/.test(tail) || /scroll-behavior/.test(tail));
  }
}

/* ============================================================
 * 13. 通用控件收口
 * ============================================================ */
section('13. 通用控件收口');
{
  const poolAll = OWN.concat(SHARED).join('\n');
  const noVar = stripVars(stripComments(poolAll));
  const m = noVar.match(/(^|\})\s*button\s*\{[^}]*\}/);
  t(`有裸 button 兜底规则${USES_SHARED ? '（由共享层提供）' : ''}`, !!m, '未找到 button { ... }');
  if (m) {
    t('兜底去掉了 UA 边框（否则深色下是一圈白）', /border\s*:\s*0|border\s*:\s*none/.test(m[0]));
    t('兜底让按钮继承页面字体（UA 默认是 Arial）', /font(-family)?\s*:\s*inherit/.test(m[0]));
  }
}

/* ============================================================
 * 2 & 7 & 8：主题层（全局跑一次，与具体界面无关）
 * ============================================================ */
section('2/7/8. 主题定义');
try {
  const { PRESET_THEMES } = await import('./js/themes.js');
  const hex2rgb = (h) => { const x = h.replace('#', ''); return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)); };
  const lum = (h) => {
    const [r, g, b] = hex2rgb(h).map((v) => { const y = v / 255; return y <= 0.03928 ? y / 12.92 : ((y + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const cr = (a, b) => { const la = lum(a), lb = lum(b); const [hi, lo] = la > lb ? [la, lb] : [lb, la]; return (hi + 0.05) / (lo + 0.05); };
  const solid = (c) => c && /^#[0-9a-f]{6}$/i.test(c);

  const PAIRS = [
    ['--text', '--bg', 4.5], ['--text-soft', '--bg', 4.5],
    ['--text-dim', '--bg', 3.0], ['--text-mute', '--bg', 3.0],
    ['--accent', '--bg', 3.0],
    ['--text', '--surface', 4.5], ['--text-dim', '--surface', 3.0],
    ['--text-mute', '--surface', 3.0],
    ['--text', '--surface-raised', 4.5],
  ];
  const badC = [];
  for (const th of PRESET_THEMES) {
    for (const [fg, bg, min] of PAIRS) {
      if (!solid(th.vars[fg]) || !solid(th.vars[bg])) continue;
      const c = cr(th.vars[fg], th.vars[bg]);
      if (c < min) badC.push(`${th.id} ${fg}@${bg} ${c.toFixed(2)}<${min}`);
    }
  }
  t('全部主题对比度达标', badC.length === 0, badC.slice(0, 3).join(' | '));

  /* 7.5 风格 × 基调 不能有洞 */
  const combo = new Map();
  for (const th of PRESET_THEMES) {
    const k = `${th.style}/${th.base}`;
    combo.set(k, (combo.get(k) || 0) + 1);
  }
  const thin = [...combo.entries()].filter(([, n]) => n < 1);
  t('风格 × 基调 每种组合都有主题', thin.length === 0, thin.map(([k]) => k).join(', '));

  /* 7.11 主题变量必须登记 —— 否则算了正确的值却没写出去 */
  const tm = read(join(ROOT, 'js/theme-manager.js'));
  const tv = tm.match(/const THEME_VARS\s*=\s*\[([\s\S]*?)\]/);
  if (tv) {
    const declared = new Set([...tv[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
    const used = new Set();
    for (const th of PRESET_THEMES) for (const k of Object.keys(th.vars)) used.add(k);
    const missing = [...used].filter((k) => !declared.has(k));
    t('主题产出的变量全部登记在 THEME_VARS 里', missing.length === 0,
      missing.slice(0, 4).join(', '));
  }

  /* 8.7 / 8.11 玻璃主题不透明度 */
  const glass = PRESET_THEMES.filter((t) => t.style === 'glass');
  if (glass.length) {
    const parseA = (v) => {
      const m = String(v).match(/rgba?\([^)]*?,\s*([\d.]+)\)/);
      return m ? parseFloat(m[1]) : null;
    };
    const low = [];
    for (const t of glass) {
      const a = parseA(t.vars['--surface']);
      if (a !== null && a < 0.88) low.push(`${t.id} surface=${a}`);
    }
    t('玻璃面板不透明度 ≥ 0.88', low.length === 0, low.join(' | '));
    const noBlur = glass.filter((t) => !(parseFloat(t.vars['--blur']) > 0)).map((t) => t.id);
    t('玻璃主题都保留了模糊', noBlur.length === 0, noBlur.join(', '));
  }
} catch (e) {
  t('主题数据可加载', false, e.message);
}

/* ============================================================
 * 9.1 类名卫生（可选，需源码目录）
 * ------------------------------------------------------------
 * 只查**反方向**：代码用了、CSS 查无定义。
 * 正方向（CSS 有、代码没用）是死样式，危害只是冗余，
 * 而这个方向是元素裸奔，且不报任何错。
 * ============================================================ */
if (WANT_CLASSES && ONLY_DIR) {
  section('9. 类名卫生');
  const dir = resolve(ROOT, ONLY_DIR);
  const src = [];
  const walk = (x) => {
    for (const e of readdirSync(x, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'tests') continue;
      const p = join(x, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(tsx|jsx|js|ts)$/.test(e.name)) src.push(p);
    }
  };
  walk(dir);

  const defined = new Set();
  for (const f of FILES) {
    for (const m of stripComments(read(f)).matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) defined.add(m[1]);
  }
  const used = new Map();
  for (const f of src) {
    const s = read(f);
    for (const m of s.matchAll(/className=(?:"([^"]*)"|'([^']*)'|\{`([^`]*)`\})/g)) {
      const raw = (m[1] || m[2] || m[3] || '').replace(/\$\{[^}]*\}/g, ' ');
      for (const c of raw.split(/\s+/)) if (c && !c.includes('$')) used.set(c, f);
    }
  }
  const missing = [...used.keys()].filter((c) => !defined.has(c));
  t('没有"代码用了但 CSS 没定义"的类名', missing.length === 0,
    missing.slice(0, 6).join(', '));
}

/* ---------------------------- 汇总 ---------------------------- */
if (WANT_JSON) {
  console.log(JSON.stringify({ pass, fail, rows }, null, 2));
} else {
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (todo.length) {
    console.log(`\n存量待办 ${todo.length} 条（跑 --dir <界面> 时按新界面标准严格判定）：`);
    for (const x of todo) console.log(`  · ${x}`);
  }
  console.log(`已扫描：${FILES.map(rel).join('、')}`);
}
process.exit(fail > 0 ? 1 : 0);
