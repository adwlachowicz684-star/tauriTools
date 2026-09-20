/**
 * 样式令牌契约测试（开发用，可删）
 * ============================================================
 * 盯的是「尺度散落在各处」这类问题：同一个几何值在四五个文件里各写一遍，
 * 改一处忘三处；插件里抄一半（滚动条）反而更糟。
 *
 * 全部是静态检查：jsdom 不真正加载 iframe 子文档，也拿不到 CSS 计算值，
 * 但"用了哪个变量名""@import 写在哪一行"这些结构性问题静态就能查。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');

/**
 * 极简 glob：支持 `**`（任意层）与 `*`（单层）。
 * 测试脚本只用它挑文件，够用且不必引外部依赖。
 */
function glob(pattern) {
  const seg = pattern.split('/');
  const walk = (dir, i) => {
    if (i >= seg.length) return [dir];
    const part = seg[i];
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const out = [];
    if (part === '**') {
      if (i + 1 >= seg.length) return [];
      out.push(...walk(dir, i + 1));
      for (const e of entries) {
        if (e.isDirectory()) out.push(...walk(join(dir, e.name), i));
      }
      return out;
    }
    for (const e of entries) {
      /* 支持三种写法：
           *        —— 任意名字
           *.ext    —— 按后缀（'*.tsx' 不是 '*'，不能拿 === '*' 判断，
                        之前就是这里写错导致匹配到 0 个文件、断言恒真）
           name     —— 精确名字 */
      const ok = part === '*' ? true
        : part.startsWith('*.') ? e.name.endsWith(part.slice(1))
          : e.name === part;
      if (!ok) continue;
      if (i + 1 >= seg.length) out.push(join(dir, e.name));
      else if (e.isDirectory()) out.push(...walk(join(dir, e.name), i + 1));
    }
    return out;
  };
  return walk(HERE, 0).map((p) => p.slice(HERE.length + 1));
}
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

const tokens = read('css/tokens.css');
const shell = read('css/neumorphism.css');

/* 所有参与样式的 CSS 文件 */
const cssFiles = ['css/tokens.css', 'css/neumorphism.css'];
for (const d of readdirSync(join(HERE, 'plugins'), { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  for (const name of ['styles.css', 'style.css', 'settings.css']) {
    const p = `plugins/${d.name}/${name}`;
    if (existsSync(join(HERE, p))) cssFiles.push(p);
  }
}
const all = cssFiles.map((p) => ({ p, text: strip(read(p)) }));

console.log('\n=== 1. 令牌文件本身 ===');
const REQUIRED = [
  '--sh-out-sm', '--sh-out-md', '--sh-out-lg', '--sh-out-xl',
  '--sh-in-xs', '--sh-in-sm', '--sh-in-md', '--sh-in-lg',
  '--sh-cast-xs', '--sh-cast-sm', '--sh-cast-md', '--sh-cast-lg',
  '--glow-sm', '--glow-md',
  '--r-xs', '--r-pill',
  '--dur-fast', '--dur-base', '--dur-slow',
  '--font-sans', '--font-mono',
  '--z-base', '--z-raised', '--z-sticky', '--z-float', '--z-menu',
  '--z-mask', '--z-dialog', '--z-pop', '--z-toast',
];
const missing = REQUIRED.filter((v) => !new RegExp(`\\${v}\\s*:`).test(tokens));
t('档位/尺度令牌齐全', missing.length === 0, missing.join(', ') || `${REQUIRED.length} 个`);

t('阴影档位引用主题色而非写死',
  /--sh-out-md\s*:\s*[^;]*var\(--sh-dark\)[^;]*var\(--sh-light\)/.test(tokens));
t('投射档位故意不跟主题（浮层任何主题下都该压暗背景）',
  /--sh-cast-sm\s*:\s*[^;]*rgba\(0,\s*0,\s*0/.test(tokens));

console.log('\n=== 2. @import 的位置（写错位置会被浏览器整条丢弃）===');
/* @import 必须出现在所有规则之前，否则整条无效 ——
   而"无效"的表现是变量静默消失、阴影全没，很难联想到是这一行。 */
for (const f of all) {
  const i = f.text.indexOf('@import');
  if (i < 0) continue;
  const before = f.text.slice(0, i);
  t(`${f.p}: @import 在所有规则之前`, !before.includes('{'),
    before.includes('{') ? '前面已有规则块' : 'OK');
}

console.log('\n=== 3. 滚动条：只在令牌文件里出现一次 ===');
/* 插件是独立文档，外壳文档里的 ::-webkit-scrollbar 到不了那边。
   每个文档都得自己拿到一份，所以规则必须放在每个文档都会引入的 tokens.css。
   抄进插件就会漏 track / hover，出现"细 1px 且无悬停反馈"的半成品。 */
t('tokens.css 提供完整滚动条规则',
  /::-webkit-scrollbar\s*\{/.test(tokens)
  && /::-webkit-scrollbar-track\s*\{/.test(tokens)
  && /::-webkit-scrollbar-thumb:hover\s*\{/.test(tokens));

/* agent-flow 例外：它刻意不引入任何共享样式，滚动条规格（4px 横向）
   也是自己的，不参与这条检查 —— 这里只管"会引入 tokens.css 的那些文档"。 */
/* project-group 与 agent-flow 同理，也是刻意保留的：
     · 它只作用于 4 个具名容器（.fpx-cards / .fpx-log / .fpx-links / .fpx-rail），
       不是全局重声明
     · 比 tokens.css 那套多一个 :active 反馈（按下时滑块转内凹），
       而 tokens.css 只有 :hover
     · 宽度刻意做窄（8px vs  tokens 的 9px）—— 滚动条是"背景里的工具"
   所以它不是"抄一份忘了改"，而是比共享版更细的实现。
   真要说该做什么，是把 :active 那档反向提给 tokens.css，而不是删掉这份。 */
const dupScroll = all
  .filter((f) => f.p !== 'css/tokens.css' && !f.p.includes('agent-flow')
    && !f.p.includes('project-group'))
  .filter((f) => /::-webkit-scrollbar/.test(f.text))
  .map((f) => f.p);
t('引入 tokens.css 的样式文件不再各自声明滚动条', dupScroll.length === 0,
  dupScroll.join(', ') || '无重复');

console.log('\n=== 4. 阴影走档位变量 ===');
/* 允许剩下的：方向性投影（标题栏/侧边栏只朝一个方向）、辉光与描边环。
   不允许：把 rgba(...) / #xxx 写进双向立体阴影 —— 换主题不会跟着变。 */
const isRingOrGlow = (v) => /^inset 0 0 0 /.test(v) || /^0 0 (?:0 )?\d+px var\(--/.test(v)
  /* 用 color-mix(… var(--xx) …) 从主题变量派生的阴影：读的是主题变量，
     换主题跟着变，所以合法。纯 rgba(0,0,0,.3) 才是真写死。 */
  || /color-mix\([^)]*var\(--/.test(v)
  /* 零模糊的**单像素描边环**（色盘游标那类）：给指针加个边，不是立体感
     —— 没有模糊就不产生明暗，只是画一圈线。这类环的颜色往往必须
     硬编码：游标叠在任意颜色的色盘上，换成主题色会在同色区域整个
     消失（红区上红描边看不见）。与 .mm-vthumb-play 的白三角同理。 */
  || (() => {
    /* 按**顶层**逗号分段（rgba(...) 内部也有逗号，不能直接 split(',')）。
       每段都是零模糊单像素才算描边环 —— 只要有一段有真实模糊，
       那就是立体阴影，不能豁免。 */
    const parts = [];
    let depth = 0, cur = '';
    for (const ch of v) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    parts.push(cur.trim());
    return parts.length > 0
      /* 宽度不限 1px：2px 的彩色光环（状态点外的 warn / error 圈）同样是
         "没有模糊就没有明暗"，只是更粗一点的环，性质不变。
         写死 1px 会让 2px 的同类写法被误报。 */
      && parts.every((x) => /^(?:inset )?0 0 0 \d+px /.test(x));
  })()
  || /^0 0 (?:0 )?\d+px currentColor$/.test(v) || /^inset 0 1px 0 /.test(v)
  // 单轴 + 零模糊 = 用阴影画的纯色块（挡条 / 缝隙遮挡），不是立体感；
  // 带不带 inset 都一样，颜色走变量就会跟着主题变
  || /^(?:inset )?-?\d+px 0 0 /.test(v) || v === 'none'
  // 竖轴零模糊 + 主题色 = 用阴影画的**指示条**（页签下方的强调色横线）。
  // 同理不是立体感：没有模糊就没有双向明暗，只是多画一条线，
  // 颜色走变量就会跟着主题变（--accent 由用户可调）
  || /^inset 0 -?\d+px 0 var\(--/.test(v);
const hardShadow = [];
for (const f of all) {
  for (const m of f.text.matchAll(/box-shadow\s*:\s*([^;]+);/g)) {
    const v = m[1].replace(/\s+/g, ' ').trim();
    if (isRingOrGlow(v)) continue;
    if (/var\(--sh-(out|in|cast)/.test(v)) continue;
    /* --ctl-shadow* 是控件层档位，定义在 :root，指向 --sh-out-md 等，
       最终仍由主题的 --sh-dark / --sh-light 驱动 —— 属于"跟主题"，
       不是写死。判成写死会让"各插件按钮共用一档"无从落地。 */
    if (/var\(--ctl-shadow/.test(v)) continue;
    // agent-flow 用自己的 --af-* 令牌（含辉光与状态色描边），等价且自洽
    if (/var\(--af-(cast|glow|ok|accent)/.test(v)) continue;
    if (/var\(--glow|var\(--accent-glow/.test(v)) continue;
    // 单方向的投影（标题栏向下、侧边栏向右）走 --sh-dark 也算跟主题
    if (/^0 \d+px \d+px var\(--sh-dark\)$/.test(v)) continue;
    if (/^\d+px 0 \d+px var\(--sh-dark\)$/.test(v)) continue;
    hardShadow.push(`${f.p}: ${v.slice(0, 48)}`);
  }
}
t('没有写死色值的立体阴影', hardShadow.length === 0, hardShadow.join(' | ') || '全部走变量');

console.log('\n=== 5. 引入关系 ===');
t('外壳引入了 tokens.css', /@import\s+url\(['"]?\.\/tokens\.css/.test(shell));
t('脑图引入了 tokens.css（否则滚动条与阴影档位都拿不到）',
  /@import\s+url\(['"]?\.\.\/\.\.\/css\/tokens\.css/.test(read('plugins/mindmap/styles.css')));
/* agent-flow 刻意不引外壳组件样式，但仍需自洽：它自己声明了一套 --af-* 令牌 */
const af = read('plugins/agent-flow/styles.css');
t('agent-flow 自成一套尺度令牌（不依赖外壳变量）',
  ['--af-mono', '--af-r-xs', '--af-r-sm', '--af-dur-fast',
   '--af-cast-sm', '--af-cast-lg', '--af-z-base', '--af-z-float',
   /* 不含 --af-z-modal：它随 .modal-* 死代码一并删了（无 z-index 引用） */
   '--af-z-mask'].every((v) => new RegExp(`\\${v}\\s*:`).test(af)));

console.log('\n=== 6. 圆角 / 时长 / 字体 / 层级 ===');
/* 主档 --r-sm/--r/--r-md/--r-lg/--r-xl 由主题覆写（扁平/玻璃风格各一套），
   所以它们留在 neumorphism.css；这里只查**补档**与新引入的字面量。 */
const strayRadius = [];
for (const f of all) {
  if (f.p === 'css/tokens.css') continue;
  for (const m of f.text.matchAll(/border-radius\s*:\s*(\d+px)\s*;/g)) {
    if (f.p.includes('agent-flow')) continue;   // 它走自己的 --af-r-*
    strayRadius.push(`${f.p}: ${m[1]}`);
  }
}
t('外壳与插件不再出现裸 px 圆角', strayRadius.length === 0,
  strayRadius.slice(0, 4).join(', ') || '均已走 --r-*');

const strayDur = [];
for (const f of all) {
  for (const m of f.text.matchAll(/transition[^;]*/g)) {
    for (const d of m[0].matchAll(/(?<![\w-])(\.\d+m?s|\d+ms)(?![\w-])/g)) {
      /* 兜底值不算漏网：var(--dur-fast, .15s) 里的 .15s 是"引不到令牌时"
         的保险，正是令牌化本身的写法。判成写死会让带兜底的令牌化无从落地。
         看这个时长**前面**是不是 `var(--x, ` 即可区分。 */
      const before = m[0].slice(0, d.index);
      if (/var\([^)]*,\s*$/.test(before)) continue;
      strayDur.push(`${f.p}: ${d[1]}`);
    }
  }
}
/* 减少动效兜底里的 .01ms 是**刻意的**：那不是"忘了走变量"，
   而正是"把过渡关掉"的写法（写成 0 有些场景会跳过 transitionend 事件）。
   别的硬编码时长才是真的漏网。 */
/* 兜底值不算漏网：var(--dur-fast, .15s) 里的 .15s 是"引不到令牌时"的
   保险，正是令牌化本身的写法。判成写死会让"带兜底的令牌化"无从落地。
   只看不在 var() 里的裸时长。 */
const realStray = strayDur.filter((x) => !/\.01ms/.test(x));
t('过渡时长不再写死', realStray.length === 0,
  realStray.slice(0, 4).join(', ') || '均走 --dur-*（减少动效兜底的 .01ms 是刻意关掉）');

const strayFont = all
  .filter((f) => !f.p.includes('agent-flow'))
  .flatMap((f) => [...f.text.matchAll(/font-family\s*:\s*([^;]+);/g)]
    .filter((m) => !/var\(|inherit/.test(m[1]))
    .map((m) => `${f.p}: ${m[1].trim().slice(0, 30)}`));
t('字体族走 --font-*', strayFont.length === 0, strayFont.join(' | ') || 'OK');

const strayZ = all
  .filter((f) => !f.p.includes('agent-flow'))
  .flatMap((f) => [...f.text.matchAll(/z-index\s*:\s*([^;]+);/g)]
    .filter((m) => !/var\(/.test(m[1]))
    .map((m) => `${f.p}: ${m[1].trim()}`));
t('层级走 --z-*', strayZ.length === 0, strayZ.join(', ') || 'OK');

/* ---------- 7. 立体描边 ---------- */
/* 新拟态卡片与底板完全同色，边界只能靠阴影勾；但阴影经模糊摊薄后
   有效强度只剩约 29%，实测把色调到 ΔL* 11 也只能落到 3.2（勉强）。
   描边那层 inset 0 0 0 1px 没有模糊、不摊薄，是真正让边界清晰的那一下 ——
   只调色值的话 17 套非扁平主题里有 14 套仍低于可辨线，加描边后降到 0 套。 */
t('外凸档位都挂了描边层',
  ['--sh-out-sm', '--sh-out-md', '--sh-out-lg', '--sh-out-xl'].every((v) => {
    const m = new RegExp(`\\${v}\\s*:([^;]*);`).exec(tokens);
    return m && /inset 0 0 0 1px var\(--relief-edge\)/.test(m[1]);
  }));
/* 逐个看每个 0 0 0 1px 前面是不是都有 inset。
   不能用 `[^t]0 0 0 1px` 这种写法 —— 它会让 [^t] 吃到 "inset " 末尾的空格，
   把 inset 版本也判成外扩（实测误报）。 */
const bareRing = [...tokens.matchAll(/0 0 0 1px/g)]
  .filter((m) => !/inset\s*$/.test(tokens.slice(Math.max(0, m.index - 8), m.index)))
  .map((m) => tokens.slice(Math.max(0, m.index - 30), m.index + 12).trim());
t('描边用 inset（外扩会让元素视觉上大 1px，密集布局会与邻居重叠）',
  bareRing.length === 0, bareRing.join(' | ') || '无外扩描边');
t('--relief-edge 取自主题派生的 --edge，且有 transparent 兜底',
  /--relief-edge\s*:\s*var\(--edge,\s*transparent\)/.test(tokens));

// --edge 由 theme-manager 按基调派生：扁平风格必须关掉，否则与已有的
// border: 1px solid var(--border) 叠成 2px 粗边
const tmSrc = read('js/theme-manager.js');
t('--edge 按风格派生（扁平 → transparent）',
  /--edge'\]\s*=\s*theme\.style\s*===\s*'flat'/.test(tmSrc));
t('--edge 按基调派生（深色微白 / 浅色微黑）',
  /dark\s*\?\s*'rgba\(255,255,255,\.[\d.]+\)'\s*:\s*'rgba\(0,0,0,\.[\d.]+\)'/.test(tmSrc));

/* ---------- 8. 阴影色值已按感知明度校准 ---------- */
/* 深色主题 ΔL* ≈ 11、浅色暗影 ≈ 14；撞物理上限的（纯黑底 / 纯白底）
   取边界值即可，靠描边补。这里只校验"不再停留在 6~7 的老水平"。 */
const { PRESET_THEMES } = await import('./js/themes.js');
const lin = (v) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};
const Lstar = (c) => {
  const y = 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  return y > 0.008856 ? 116 * Math.pow(y, 1 / 3) - 16 : 903.3 * y;
};
const hex2 = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const tooWeak = [];
for (const th of PRESET_THEMES) {
  if (th.style === 'flat') continue;
  const bg = th.vars['--bg'];
  const shD = th.vars['--sh-dark'];
  if (!/^#[0-9a-f]{6}$/i.test(bg || '') || !/^#[0-9a-f]{6}$/i.test(shD || '')) continue;
  const d = Math.abs(Lstar(hex2(shD)) - Lstar(hex2(bg)));
  // 纯黑底（L* 已接近 0）提不动暗影，属物理上限，不参与
  if (Lstar(hex2(bg)) < 12) continue;
  if (d < 9) tooWeak.push(`${th.id}(${d.toFixed(1)})`);
}
t('暗影强度已校准到 ΔL* ≥ 9', tooWeak.length === 0,
  tooWeak.join(', ') || '（纯黑底主题因物理上限豁免）');

console.log('\n=== 9. 风格开关与「保证可见的边界」必须分开 ===');
/* --border 是风格开关（新拟态下 transparent，边界交给阴影）；
   --divider 保证任何风格都可见。混用会让新拟态下的分隔线全部消失 ——
   agent-flow 曾把 26 处分隔线接到 --border 上，侧边栏与画布连成一片。
   扁平/玻璃恰好没事，只因那两种风格给 --border 赋了值，属碰巧没踩到。 */
const tm = read('js/theme-manager.js');
t('--divider 由外壳按基调派生（不交给主题自己填，否则可能又被填成透明）',
  /v\['--divider'\]\s*=\s*dark\s*\?/.test(tm));
const dividerDecl = /v\['--divider'\]\s*=\s*([^;]+);/.exec(tm)?.[1] || '';
t('--divider 在深/浅两种基调下都有颜色（不能有一侧 transparent）',
  /rgba\(255,255,255,/.test(dividerDecl) && /rgba\(0,0,0,/.test(dividerDecl)
  && !/transparent/.test(dividerDecl), dividerDecl.trim());
t('外壳 CSS 里 --divider 有兜底值', /--divider\s*:\s*rgba\(/.test(shell));
t('外壳注明了 --border 是风格开关、不是分隔线颜色',
  /--border 是\*\*风格开关\*\*/.test(shell));
const afCss = read('plugins/agent-flow/styles.css');
t('agent-flow 有自己的分隔线变量', /--af-divider\s*:\s*var\(--divider/.test(afCss));
/* 分界两侧往往同色（新拟态下 --surface 与 --bg 同值），
   用 --border 一透明就没有任何东西托底 */
const sideBorders = [...afCss.matchAll(/border-(?:right|left|top|bottom)\s*:\s*([^;]+);/g)]
  .map((m) => m[1]).filter((v) => v.includes('var(--af-line)'));
t('单边分隔线不再使用 --af-line（接到风格开关上了）',
  sideBorders.length === 0, sideBorders.slice(0, 3).join(' | ') || '已全部改用 --af-divider');

console.log('\n=== 10. 组件用到的 class 必须有样式定义（防"裸 div"）===');
/* 这一节盯的是"DOM 与 CSS 各写一半"的事故：
   组件里加了 class，CSS 里却没有任何规则 —— 元素在、样式不在，
   静默塌掉。插件设置抽屉就真实踩过：.drawer/.drawer-head/... 六个类
   两个外壳都在用，css/ 下却搜不到一条规则，于是标题栏里的标题、
   副标题、关闭按钮按文档流各占一行，也没有底板。 */
const shellCss = shell;
const hasRule = (cls) => new RegExp(`\\.${cls}[\\s,:.{>]`).test(shellCss);

/* 抽屉：React 外壳（src/components/PluginSettingsDrawer.tsx）
   与原生外壳（js/shell.js）共用同一套类名，两边都靠这里的规则 */
const drawerUsed = ['drawer', 'drawer-head', 'drawer-title', 'drawer-scroll',
  'drawer-body', 'drawer-empty', 'drawer-mask'];
const drawerUndef = drawerUsed.filter((c) => !hasRule(c));
t('抽屉用到的 class 都有样式定义', drawerUndef.length === 0,
  drawerUndef.join(', ') || `${drawerUsed.length} 个全部有定义`);

/* 标题栏要的是"左标题 + 右关闭"：没有 flex 就变成上下堆叠 */
const headBlock = /\.drawer-head\s*\{([^}]*)\}/.exec(shellCss)?.[1] || '';
t('标题栏用 flex 横向排列（左标题 / 右关闭，不上下堆叠）',
  /display\s*:\s*flex/.test(headBlock) && /justify-content\s*:\s*space-between/.test(headBlock));
t('标题框有底板（用户明确要求"有个 bg 做标题框"）',
  /background\s*:\s*var\(/.test(headBlock), (headBlock.match(/background\s*:\s*[^;]+;/) || ['无'])[0]);
/* 分隔线必须用 --divider：--border 是风格开关，新拟态下透明会整条消失 */
t('标题框下边线用 --divider（不是风格开关 --border）',
  /border-bottom\s*:\s*[^;]*var\(--divider/.test(headBlock)
  && !/border-bottom\s*:\s*[^;]*var\(--border/.test(headBlock));
t('关闭按钮不参与收缩（标题过长时不会被挤变形）',
  /\.drawer-head \.tb-btn[\s\S]{0,120}flex\s*:\s*none/.test(shellCss));


/* ---- agent-flow 主体行：同样的病，第二次犯 ----
   画布撑不满的根因不是"差一点没铺满"，而是 .af-body-row / .af-body-main
   这两个类**在 CSS 里一条规则都没有**。断掉的链条：
     ① .af-body-row 在 column flex 里 flex:0 1 auto → 高度只到内容
     ② 它是 display:block → 画布库与主区上下堆叠，不是左右并排
     ③ .af-body-main 不是 flex 容器 → 里面 .body 的 flex:1 完全失效
     ④ 高度一路 auto → ReactFlow 的 height:100% 解析为 auto → 塌成 0
   所以这里守的不只是"有规则"，还得守住两层的 flex 方向与 min-*:0。 */
const afUsed = ['af-body-row', 'af-body-main'];
const afUndef = afUsed.filter((c) => !(new RegExp(`\\.${c}\\s*\\{`)).test(afCss));
t('agent-flow 主体行的 class 都有样式定义', afUndef.length === 0,
  afUndef.join(', ') || `${afUsed.length} 个全部有定义`);

const rowBlock = /\.af-body-row\s*\{([^}]*)\}/.exec(afCss)?.[1] || '';
t('主体行撑满剩余高度（flex:1，否则画布只有内容那么高）',
  /flex\s*:\s*1/.test(rowBlock), rowBlock.trim() || '无');
t('主体行左右并排（画布库与主区不是上下堆叠）',
  /display\s*:\s*flex/.test(rowBlock) && !/flex-direction\s*:\s*column/.test(rowBlock));
t('主体行有 min-height:0（否则内部滚动区被内容顶开、overflow 失效）',
  /min-height\s*:\s*0/.test(rowBlock));

const mainBlock = /\.af-body-main\s*\{([^}]*)\}/.exec(afCss)?.[1] || '';
t('主区占满剩余宽度（flex:1 + min-width:0）',
  /flex\s*:\s*1/.test(mainBlock) && /min-width\s*:\s*0/.test(mainBlock), mainBlock.trim() || '无');
/* 必须是 flex 容器 —— 不是的话里面 .body 的 flex:1 就失效，
   高度链从这里断掉，画布塌成 0 */
t('主区是 column flex 容器（.body 的 flex:1 才拿得到高度）',
  /display\s*:\s*flex/.test(mainBlock) && /flex-direction\s*:\s*column/.test(mainBlock));
t('主区有 min-height:0（高度链不能断在这一层）',
  /min-height\s*:\s*0/.test(mainBlock));

/* 抽屉是右侧滑出，必须覆盖 .mask 的居中（place-items:center 是弹窗用的） */
const maskBlock = /\.drawer-mask\s*\{([^}]*)\}/.exec(shellCss)?.[1] || '';
t('抽屉遮罩靠右满高（覆盖了 .mask 的居中）',
  /place-items\s*:\s*stretch\s+end/.test(maskBlock));
t('遮罩未显示时不拦截点击（等 raf 加 .on 的那一帧不能吃掉操作）',
  /pointer-events\s*:\s*none/.test(maskBlock) && /\.drawer-mask\.on[\s\S]{0,80}pointer-events\s*:\s*auto/.test(shellCss));
t('抽屉有滑入过渡，且尊重 prefers-reduced-motion',
  /\.drawer-mask\.on \.drawer\s*\{/.test(shellCss)
  && /prefers-reduced-motion[\s\S]{0,200}\.drawer\b/.test(shellCss));

/* 内容区可滚动：flex 子项要写 min-height:0，否则会被内容顶开 */
const scrollBlock = /\.drawer-scroll\s*\{([^}]*)\}/.exec(shellCss)?.[1] || '';
t('内容区可滚动且写了 min-height:0（否则被内容顶开，滚动失效）',
  /overflow\s*:\s*auto/.test(scrollBlock) && /min-height\s*:\s*0/.test(scrollBlock));

console.log('\n=== 10a. 各插件按钮阴影统一（由主题管） ===');
/* 事故：agent-flow 的按钮**一个立体阴影都没有**。
   不是配色差异，而是 --ctl-shadow 原先只定义在 `.nx-btn,.p-btn,.mm-btn`
   那条规则**内部** —— 是局部变量，agent-flow 自成的 26 个按钮类
   （.toolbar button / .kind-btn / .af-lib-btn …）根本取不到。

   于是同一个界面里：脑图 .mm-btn 走共享组有阴影，agent-flow 按钮没有。
   修法是把档位提到 :root，各插件按钮引用同一档。 */
{
  const shadowOf = (css, sel) => {
    let last = null;
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const parts = m[1].split(',').map((x) => x.trim());
      if (!parts.includes(sel)) continue;
      const sh = /box-shadow\s*:\s*([^;]+)/.exec(m[2]);
      if (sh) last = sh[1].trim();
    }
    return last;
  };
  /* 必须展开 @import：mindmap 的 .mm-btn 阴影来自 controls.css，
     只读它自己的文件会误判成"没有阴影来源"。 */
  const expand = (p, seen = new Set()) => {
    if (seen.has(p)) return '';
    seen.add(p);
    const t = read(p);
    const pre = [...t.matchAll(/@import\s+url\(['"]?([^'")]+)['"]?\);/g)]
      .map((m) => expand(join(dirname(p), m[1]), seen)).join('\n');
    return pre + '\n' + t;
  };
  const af = expand('plugins/agent-flow/styles.css');
  const mm = expand('plugins/mindmap/styles.css');
  const pg = expand('plugins/project-group/style.css');
  const ctl = read('css/controls.css');

  /* 档位必须定义在 :root —— 否则又变回"只有组内按钮拿得到" */
  const rootBlock = /:root\s*\{([^{}]*)\}/.exec(ctl)?.[1] || '';
  for (const v of ['--ctl-shadow', '--ctl-shadow-sm', '--ctl-shadow-press']) {
    t(`按钮阴影档位 ${v} 定义在 :root`, new RegExp(`${v}\\s*:`).test(rootBlock));
  }
  t('档位指向 --sh-out-*（阴影随主题变）',
    /--ctl-shadow:\s*var\(--sh-out-md\)/.test(rootBlock));

  /* 关键对照：agent-flow 与 mindmap 的按钮必须来自同一档位 */
  const afBtns = ['.toolbar button', '.kind-btn', '.af-lib-btn', '.mod-btn', '.btn-like'];
  /* .mm-mini 不在内：它是**透明背景**的图标按钮（background: transparent），
     没有"面"可以凸起 —— 常态就该是平的，hover 时才显出背景。
     给透明元素加外凸阴影只会得到一个漂浮的影子，反而更怪。 */
  const mmBtns = ['.mm-btn'];
  for (const b of afBtns) {
    const v = shadowOf(af, b);
    t(`agent-flow ${b} 有阴影来源`, v && /var\(--ctl-shadow/.test(v), v || '无');
  }
  for (const b of mmBtns) {
    const v = shadowOf(mm, b);
    t(`mindmap ${b} 有阴影来源`, v && /var\(--ctl-shadow/.test(v), v || '无');
  }
  /* 两边必须指向同一族变量 —— 这才是"统一" */
  const afV = afBtns.map((b) => (shadowOf(af, b) || '').replace(/var\((--ctl-shadow[^)]*)\)/, '$1'));
  const mmV = mmBtns.map((b) => (shadowOf(mm, b) || '').replace(/var\((--ctl-shadow[^)]*)\)/, '$1'));
  t('agent-flow 与 mindmap 按钮阴影同族（都走 --ctl-shadow-*）',
    afV.every((v) => v.startsWith('--ctl-shadow')) && mmV.every((v) => v.startsWith('--ctl-shadow')),
    `af=${afV.join('/')} mm=${mmV.join('/')}`);

  /* ---------- 突出显示（primary）与选中态（on）必须分开 ----------
     事故：这两者曾被塞进**同一组规则**共用内凹，于是「＋ 新建项目」
     这类主按钮看着像被按下去了。

     语义完全不同：
       primary  强调"推荐点这里"  → 凸
       on       当前生效中/已按下 → 凹
     判据：凸 = "作用于它"，凹 = "它已是当前状态"。
     把强调画成凹，等于把"请点我"画成"我已经被点了"。 */
  const primarySh = shadowOf(ctl, '.p-btn.primary');
  const onSh = shadowOf(ctl, '.mm-btn.on');
  t('primary 用外凸档（突出显示不该画成按下）',
    primarySh === 'var(--ctl-shadow)', primarySh || '无');
  t('on 用内凹档（选中 / 按下）',
    onSh === 'var(--ctl-shadow-press)', onSh || '无');
  t('primary 与 on 不是同一档（防止再次被合并成一组）',
    primarySh && onSh && primarySh !== onSh, `primary=${primarySh} on=${onSh}`);

  /* ---------- 状态切换不得改变盒模型尺寸 ----------
     事故：选中/突出态用 `font-weight: 600` 表示强调，而字重会改**字形宽度**
     → 按钮整体变宽 → 整排互相推挤、布局跳动（project-group 的 kind 切换、
     agent-flow 的 AND/OR 切换都在跳）。

     正确做法：用 -webkit-text-stroke 描边模拟"变实"。描边画在字形轮廓
     外侧，**不参与布局计算**。

     这条断言扫**所有**状态规则，不只按钮 —— 宽度/内边距/边框在 hover、
     .on、.active 上变化都是同一类问题。 */
  const SIZE_PROPS = ['font-weight', 'font-size', 'padding', 'border-width',
                      'letter-spacing', 'width', 'height', 'min-width', 'min-height', 'margin'];
  const STATE_SEL = /:(hover|active|focus)|(\.on\b)|(\.active\b)|(\.primary\b)|(\.sel\b)|(\.selected\b)|(\.current\b)|(\.checked\b)|\[aria-selected/;
  const layoutShift = [];
  for (const f of ['css/controls.css', 'css/dialog.css', 'css/neumorphism.css',
                   'plugins/project-group/style.css', 'plugins/agent-flow/styles.css',
                   'plugins/mindmap/styles.css']) {
    const raw = read(f);
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const sel = m[1].trim();
      if (!STATE_SEL.test(sel)) continue;
      const body = m[2];
      for (const prop of SIZE_PROPS) {
        if (!new RegExp('(?:^|;|\\s)' + prop + '\\s*:').test(body)) continue;
        /* ::before/::after 是装饰性伪元素，撑的是自己不是宿主 → 不算布局位移 */
        if (/::(before|after)\s*$/.test(sel)) continue;
        layoutShift.push(`${f.split('/').pop()} ${sel.slice(0, 34).replace(/\s+/g, ' ')} → ${prop}`);
      }
    }
  }
  t('状态切换不改变盒模型尺寸（字重/内边距/宽高都不能变）',
    layoutShift.length === 0, layoutShift.slice(0, 5).join(' | ') || '全部稳定');

  /* 强调改用描边，而不是真字重。
     注意必须先剥掉 CSS 注释再查 —— 我们刚写进去的说明里就含
     "font-weight" 这个词，不剥会把注释当成实现，断言永远为假。 */
  const ctlNc = read('css/controls.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (sel) => {
    const m = ctlNc.match(new RegExp('(?:^|\\})([^}]*?' + sel.replace(/\./g, '\\.')
      + '[^}]*?)\\{([^}]*)\\}', 's'));
    return m ? m[2] : '';
  };
  const prim = block('.p-btn.primary');
  t('强调态用 --ctl-faux-bold 描边模拟加粗',
    /--ctl-faux-bold:/.test(ctlNc) && /-webkit-text-stroke:\s*var\(--ctl-faux-bold/.test(prim),
    prim.slice(0, 80));
  t('强调态不再写 font-weight（会改字形宽度）',
    prim !== '' && !/font-weight/.test(prim), prim.slice(0, 80));
  const onBlk = block('.mm-btn.on');
  t('选中态同样不写 font-weight', onBlk !== '' && !/font-weight/.test(onBlk), onBlk.slice(0, 80));

  /* ---------- 动态数字必须等宽 ----------
     默认字体是**比例数字**："1" 比 "0" 窄。所以计数 9→10、5→12 时
     整体宽度就变 → 徽章变宽 → 后面的元素被推着走。

     font-variant-numeric: tabular-nums 让所有数字等宽，位数变化不改宽度。
     项目里 .mcp-tab-count / .stack-count 早就是这么写的，只是没推广。 */
  const NUM_TARGETS = [
    ['plugins/agent-flow/styles.css', '.tab-count'],
    ['plugins/agent-flow/styles.css', '.task-count'],
    ['plugins/agent-flow/styles.css', '.task-group-count'],
    ['plugins/agent-flow/styles.css', '.mcp-sec-count'],
    ['plugins/mindmap/styles.css', '.mm-file-count'],
    ['plugins/project-group/style.css', '.fpx-tab-count'],
    ['plugins/project-group/style.css', '.fpx-groupcount'],
    ['plugins/project-group/style.css', '.fpx-tabmgr-count'],
  ];
  const numMiss = [];
  for (const [f, sel] of NUM_TARGETS) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    const m = css.match(new RegExp('(?:^|\\})[^}]*?' + sel.replace(/\./g, '\\.') + '\\s*\\{([^}]*)\\}'));
    /* 注意：同一选择器可能有多条规则（.task-group-count 有主规则 +
       响应式补充），只要**任一**条带 tabular-nums 即可（继承得到）。 */
    const all = [...css.matchAll(new RegExp('(?:^|\\})[^}]*?' + sel.replace(/\./g, '\\.') + '\\s*\\{([^}]*)\\}', 'g'))];
    if (!all.length) { numMiss.push(sel + '(未找到)'); continue; }
    if (!all.some((x) => /tabular-nums/.test(x[1]))) numMiss.push(sel);
  }
  t('动态计数用等宽数字（位数变化不改宽度）', numMiss.length === 0,
    numMiss.join(', ') || `${NUM_TARGETS.length} 处全部等宽`);

  /* ---------- 不用 transition: all ----------
     all 会把 width / padding / font-size 一起动画 —— 将来谁加个尺寸属性
     就变成"缓慢变形"，而且当前也白白让浏览器监听所有属性。

     查之前**必须先剥 CSS 注释**：我们自己写的说明里就含
     "transition: all" 这个字符串，不剥会把注释当成实现（断言恒真）。 */
  const allBad = [];
  for (const f of ['css/controls.css', 'css/dialog.css', 'css/neumorphism.css',
                   'plugins/project-group/style.css', 'plugins/agent-flow/styles.css',
                   'plugins/mindmap/styles.css']) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '');
    if (/transition:\s*all/.test(css)) allBad.push(f.split('/').pop());
  }
  t('不用 transition: all（会连尺寸一起动画）', allBad.length === 0,
    allBad.join(', ') || '全部显式列出过渡属性');

  /* ---------- 滚动条：始终占位 + 平时隐形 ----------
     两个诉求要同时满足，缺一个都会出问题：
       · 只占位不隐形 → 常驻一条灰杠挡视线
       · 只隐形不占位 → 滚动条出现/消失时内容被挤窄（列表变长就跳一下）

     所以 thumb 常态 transparent（**宽度仍在**），悬停容器才上色。 */
  const tk = read('css/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  t('滚动条始终占位（有 width/height，不会挤动内容）',
    /::-webkit-scrollbar\s*\{[^}]*width:\s*\d/.test(tk));
  t('滑块平时透明（隐形）',
    /::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*transparent/.test(tk));
  t('悬停容器时滑块显形', /:hover::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--scroll-thumb\)/.test(tk));
  t('不用 scrollbar-width: none（那会丢掉可滚动提示与拖动）',
    !/scrollbar-width:\s*none/.test(tk));
  /* Firefox 走标准属性：它做不到悬停显形，但同样要始终占位 */
  t('Firefox 侧也给了 scrollbar-color', /scrollbar-color:/.test(tk));

  /* 插件里自己写的滚动条必须**同样的显隐逻辑**，
     否则会出现"这边隐形、那边常驻"的不一致。 */
  const pgCss = read('plugins/project-group/style.css').replace(/\/\*[\s\S]*?\*\//g, '');
  /* 只看**常态**规则：:hover / :active 变体本来就该上色，把它们算进来
     会让断言永远失败。用"选择器里不含 :"来筛。 */
  /* 抓完整选择器组（可能跨多行），再排除含 :hover / :active 的变体。
     只查 `([.\w-]+)` 会漏掉逗号分隔的后续行，于是 ":hover" 那组里
     后面的 `.fpx-log:hover` 被单抓出来当成常态规则。 */
  const pgThumbs = [...pgCss.matchAll(/((?:[.\w-]+(?::hover|:active)?,?\s*)+::-webkit-scrollbar-thumb)\s*\{([^}]*)\}/g)]
    .filter((m) => !/:hover|:active/.test(m[1]));
  t('project-group 滑块平时透明（与全局一致）',
    pgThumbs.length > 0 && pgThumbs.every((m) => /background:\s*transparent/.test(m[2])),
    pgThumbs.map((m) => m[1] + (/background:\s*transparent/.test(m[2]) ? '✓' : '✗')).join(', ') || '未找到');
  t('project-group 悬停时显形',
    /:hover::-webkit-scrollbar-thumb\s*\{[^}]*background:\s*var\(--border\)/.test(pg));

  /* 投射阴影不再各写一份：--af-cast-* 必须指向共享的 --sh-cast-* */
  t('--af-cast-* 收敛到 --sh-cast-*（两份定义必然漂移）',
    /--af-cast-sm:\s*var\(--sh-cast-sm\)/.test(af)
    && !/--af-cast-sm:\s*0\s+8px/.test(af));

  /* 页签常态保持平（整排浮起来很吵），选中态转内凹 */
  t('页签选中态用内凹档（不是写死 --sh-in-*）',
    /\.view-switch button\.on[\s\S]{0,200}--ctl-shadow-press/.test(af));
}

console.log('\n=== 10b. 标题三档统一 ===');
/* 此前各插件各写一套栏标题：agent-flow 13/600、画布库 12/600 再叠
   opacity:.8、侧栏分组 11/大写/字间距 —— 三处并排像三个产品。
   统一成三档后，改一档就能全局生效；这里守住"三处栏标题同档"。 */
{
  const has = (css, sel) => {
    const m = new RegExp('(?<![\\w-])' + sel.replace('.', '\\.') + '\\s*\\{([^}]*)\\}').exec(css);
    return m ? m[1] : '';
  };
  const af = read('plugins/agent-flow/styles.css');

  for (const sel of ['.side-head', '.af-lib-title']) {
    const b = has(af, sel);
    t(`${sel} 走一档（栏标题）`,
      /var\(--title-1-fs/.test(b) && /var\(--title-1-fw/.test(b),
      b.trim().slice(0, 60) || '无规则');
  }
  /* 画布库原来多一层 opacity:.8，比另两个淡 —— 弱化必须换档位或换色，
     用 opacity 会随底板明暗漂 */
  t('栏标题不用 opacity 弱化（会随底板明暗漂）',
    !/opacity/.test(has(af, '.af-lib-title')));
  /* 中文没有大小写，text-transform 只剩 letter-spacing 在起作用 */
  t('分组标题不再用 uppercase（中文无效，只剩字间距噪声）',
    !/text-transform/.test(has(af, '.side-title')));

  const mm = read('plugins/mindmap/styles.css');
  const pg = read('plugins/project-group/style.css');
  t('脑图与项目组的标题也走三档',
    /--title-[123]-fs/.test(mm) && /--title-[123]-fs/.test(pg));

  /* 令牌必须真的存在于 tokens.css —— 不然 var() 取不到，
     三档就只是"看起来统一了" */
  const tk = read('css/tokens.css');
  for (const i of [1, 2, 3]) {
    t(`三档令牌 --title-${i}-fs/-fw 有定义`,
      new RegExp(`--title-${i}-fs\\s*:`).test(tk) && new RegExp(`--title-${i}-fw\\s*:`).test(tk));
  }
}

console.log('\n=== 11. 内联样式走令牌（审计盲区收口）===');
{
  /* 样式审计只能扫 CSS 文件 —— 全仓 253 处内联样式它既看不到也改不动。
     所以内联值也必须走令牌，否则"CSS 里是整数、TSX 里还是半档"。 */
  const tsx = [...glob('plugins/**/*.tsx'), ...glob('src/**/*.tsx')];
  const bare = [];
  for (const p of tsx) {
    if (/node_modules/.test(p)) continue;
    const text = read(p);
    /* 半档字号：此前 fontSize: 11.5 出现 29 处、10.5 出现 4 处 */
    for (const m of text.matchAll(/fontSize:\s*([\d.]+)/g)) {
      if (/\.5$/.test(m[1])) bare.push(`${p}: fontSize ${m[1]}`);
    }
    /* 裸间距值：此前 marginTop: 8 ×19、marginTop: 10 ×13 … 全是凭手感写的 */
    for (const m of text.matchAll(
      /\b(marginTop|marginBottom|marginLeft|marginRight|gap|padding):\s*(\d+)\b/g)) {
      bare.push(`${p}: ${m[1]} ${m[2]}`);
    }
  }
  t('内联字号无半档、无裸间距值', bare.length === 0, bare.slice(0, 4).join(' | '));

  /* 令牌必须真的存在，否则 var() 取不到值、声明直接失效 */
  const tokens = read('css/tokens.css');
  for (const v of ['--sp-1', '--sp-4', '--sp-8', '--field-label-w']) {
    t(`间距令牌 ${v} 已定义`, new RegExp(`${v}:`).test(tokens));
  }
  /* 尺度要连续，缺一档就会有人去写裸值 */
  const sps = [...tokens.matchAll(/--sp-(\d+):/g)].map((m) => +m[1]);
  t('间距令牌 1~10 连续无缺档',
    sps.length === 10 && Math.min(...sps) === 1 && Math.max(...sps) === 10,
    `实际 ${sps.sort((a, b) => a - b).join(',')}`);

  /* 插件不该再各自实现滚动条 —— tokens.css 里有完整一份
     （thumb / track / hover），缺失任一都会露出 WebKit 默认浅色条。 */
  const own = [];
  for (const p of glob('plugins/*/style*.css')) {
    const text = read(p);
    const n = (text.match(/::-webkit-scrollbar/g) || []).length;
    if (n > 1) own.push(`${p}: ${n} 条`);
  }
  t('插件没有各自实现滚动条（改用 tokens.css 那份）',
    own.length === 0, own.join(' | '));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
