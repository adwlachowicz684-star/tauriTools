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
const dupScroll = all
  .filter((f) => f.p !== 'css/tokens.css' && !f.p.includes('agent-flow'))
  .filter((f) => /::-webkit-scrollbar/.test(f.text))
  .map((f) => f.p);
t('引入 tokens.css 的样式文件不再各自声明滚动条', dupScroll.length === 0,
  dupScroll.join(', ') || '无重复');

console.log('\n=== 4. 阴影走档位变量 ===');
/* 允许剩下的：方向性投影（标题栏/侧边栏只朝一个方向）、辉光与描边环。
   不允许：把 rgba(...) / #xxx 写进双向立体阴影 —— 换主题不会跟着变。 */
const isRingOrGlow = (v) => /^inset 0 0 0 /.test(v) || /^0 0 (?:0 )?\d+px var\(--/.test(v)
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
      strayDur.push(`${f.p}: ${d[1]}`);
    }
  }
}
/* 减少动效兜底里的 .01ms 是**刻意的**：那不是"忘了走变量"，
   而正是"把过渡关掉"的写法（写成 0 有些场景会跳过 transitionend 事件）。
   别的硬编码时长才是真的漏网。 */
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

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
