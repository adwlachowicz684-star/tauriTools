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
const isRingOrGlow = (v) => /^inset 0 0 0 /.test(v) || /^0 0 \d+px var\(--accent/.test(v)
  || /^0 0 \d+px currentColor/.test(v) || /^inset 0 1px 0 /.test(v)
  || /^inset -?\d+px 0 0 /.test(v) || v === 'none';
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
   '--af-z-mask', '--af-z-modal'].every((v) => new RegExp(`\\${v}\\s*:`).test(af)));

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
t('过渡时长不再写死', strayDur.length === 0, strayDur.slice(0, 4).join(', ') || '均走 --dur-* / --t');

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

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
