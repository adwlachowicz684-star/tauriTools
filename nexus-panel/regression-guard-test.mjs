/**
 * 历史修复存活守卫
 * ============================================================
 * 这个文件只盯一件事：**以前修好过、后来又被覆盖掉的 BUG**。
 *
 * 为什么需要它
 * ------------------------------------------------------------
 * 远端推进很快，同一个文件常被整份覆盖。已实测复发过的：
 *   · mindmap/index.js 里那行 `import '../../css/dialog.css'` —— 复发 3 次
 *   · mindmap 的「浮层 vs 挤窄」断言 —— 被覆盖回旧版
 *   · mcp-tab-index 的解析判据 —— 双方同时改同一行
 * 这类回退**不报错、不崩溃**：要么只在无构建模式下白屏，要么只是
 * 断言假红把人引向错误方向。只有专门盯着才能发现。
 *
 * 写法约定（踩过的坑，务必遵守）
 * ------------------------------------------------------------
 * 1. **钉语义不钉写法**。钉 `and_then(|v| v.as_u64())` 这种调用点写法，
 *    上游把解析抽成共用闭包后立刻假红，功能却没变（mcp-tab-index 教训）。
 *    所以这里每条都说明"要的是什么"，判据尽量宽松、只排除坏情况。
 * 2. **注释里不要写块注释结束符**。写了会把块注释提前闭合、
 *    整个文件语法错（已栽过不止一次）。
 * 3. 读源码前先剥注释，否则说明性注释会把自己算进去
 *    —— 那正是"删掉实现、断言照样全绿"的假绿来源。
 * 4. 嵌套正则的转义极易写错，能用字符串包含判就别套正则。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments as stripBlock, stripCommentsJs as stripJs } from './test-scan-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');
/** 读 + 剥注释。剥完才谈"代码里有没有"，注释里的同名文本不算。 */
const code = (p) => {
  let txt;
  try { txt = read(p); } catch { return null; }
  return p.endsWith('.css') ? stripBlock(txt) : stripJs(txt);
};

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/* ============================================================
 * 1. mindmap 无构建白屏（复发 3 次，最高危）
 * ------------------------------------------------------------
 * 原生 ESM 不能 import CSS：浏览器拿到 text/css 会判成"不是 JS 模块"，
 * 整个 index.js 加载失败 —— mindmap 一片空白、功能全无，
 * 控制台只有一条 MIME 报错。而它的 entry 没有 noBuild 分支，
 * 两种模式都加载它，**只有无构建模式会挂**。
 * ============================================================ */
console.log('=== 1. mindmap 无构建白屏 ===');
{
  const idx = code('plugins/mindmap/index.js');
  t('mindmap/index.js 存在', idx !== null);
  if (idx !== null) {
    // 要的是"没有 import 任何 .css"，JS import 与 import() 都不行
    const bad = idx.match(/^\s*import\s+[^;]*?['"][^'"]+\.css['"]/m);
    t('index.js 不 import 任何 CSS（原生 ESM 不能 import CSS）', !bad,
      bad ? `发现：${bad[0].trim().slice(0, 60)}` : '');
  }
  const css = read('plugins/mindmap/styles.css');
  t('mindmap/styles.css 存在', css !== null);
  if (css !== null) {
    // 剥注释后判，这样上方那段警告注释里写的路径不会把自己算进去
    t('styles.css 用 @import 引 dialog.css（替代 JS import）',
      /@import\s+url\(['"][^'"]*dialog\.css['"]\)/.test(stripBlock(css)));
  }
}

/* ============================================================
 * 2. 画布假描边框必须真的被创建
 * ------------------------------------------------------------
 * 此前 styles.css 里整套规则都写好了，但全仓 JS **没有任何地方
 * 创建这个元素** —— 那道边从未出现过，文件库浮层直接盖在画布上，
 * 正是这个设计要避免的样子。CSS 有规则 ≠ 界面上有这个元素。
 * ============================================================ */
console.log('\n=== 2. mindmap 画布假描边框 ===');
{
  const files = ['plugins/mindmap/index.js', 'plugins/mindmap/filelist.js'];
  const src = files.map((f) => code(f)).filter(Boolean).join('\n');
  t('能读到 mindmap 的 JS 源码', src.length > 0);
  // 要的是"真的往 DOM 里挂"，判创建这一动作，不判具体变量名
  t('JS 里真的创建了 .mm-canvas-frame 元素（不只是 CSS 有规则）',
    /mm-canvas-frame/.test(src) && /createElement|innerHTML|insertAdjacentHTML/.test(src));
}

/* ============================================================
 * 3. 跨插件内嵌组件的样式表
 * ------------------------------------------------------------
 * project-group 直接 import color-picker 的组件，但 ColorPicker.tsx
 * 自己不引样式表（由 color-picker 的 main.tsx 引）。project-group 是
 * 另一个 iframe 文档，只加载自己的 style.css —— 那份里色盘需要的
 * 二十多个类一个都没有，于是色盘**没有布局、渲染成一坨文字**。
 * 不报错不崩溃，只有肉眼能发现。
 * ============================================================ */
console.log('\n=== 3. 跨插件内嵌组件的样式表 ===');
{
  const dlg = code('plugins/project-group/components/dialogCards.tsx');
  t('dialogCards.tsx 存在', dlg !== null);
  if (dlg !== null) {
    // 只认真正的 import 语句：说明注释里写着这个路径不算（假绿教训）
    t('dialogCards.tsx 真的 import 了 color-picker 的样式表',
      /import\s+['"][^'"]*color-picker\/style\.css['"]/.test(dlg));
  }
}

/* ============================================================
 * 4. 三个"加载即崩"的修复
 * ============================================================ */
console.log('\n=== 4. 运行时崩溃修复 ===');
{
  // 4.1 声明必须在使用之前：此前它写在文件后半段，
  //     前面两个回调在它之前就要读 —— 严格模式下首渲染即崩
  const fp = code('plugins/project-group/hooks/useFpx.ts');
  t('useFpx.ts 存在', fp !== null);
  if (fp !== null) {
    const decl = fp.search(/\bconst\s+ci\b/);
    const uses = [...fp.matchAll(/\bci\b/g)].map((m) => m.index).filter((i) => i !== decl);
    const early = uses.filter((i) => i < decl);
    t('useFpx 的 ci 声明在所有使用之前（否则首渲染 ReferenceError）',
      decl >= 0 && early.length === 0,
      decl < 0 ? '没找到声明' : `${early.length} 处使用在声明之前`);
  }

  // 4.2 拖文件到页签：prop 声明了却从没被调用，拖入后界面毫无变化
  const cg = code('plugins/project-group/components/CardGrid.tsx');
  t('CardGrid.tsx 存在', cg !== null);
  if (cg !== null) {
    const call = cg.match(/onExternalDrop\s*\?\.\s*\(/);
    t('CardGrid 的 onExternalDrop 真的被调用（不只是声明了）', !!call,
      call ? call[0] : '只找到声明，没找到调用');
  }

  // 4.3 同一条 import 里重复绑定 → 语法错 → 设置插件加载不起来
  const app = code('plugins/settings/App.tsx');
  t('settings/App.tsx 存在', app !== null);
  if (app !== null) {
    const dups = [...app.matchAll(/^\s*import\s*\{([^}]*)\}/gm)]
      .map((m) => m[1])
      .filter((body) => {
        const names = body.split(',').map((s) => s.trim()).filter(Boolean)
          .map((s) => s.split(/\s+as\s+/)[0].trim());
        return new Set(names).size !== names.length;
      });
    t('settings/App.tsx 没有重复绑定的 import', dups.length === 0,
      dups.length ? `重复：${dups[0].slice(0, 60)}` : '');
  }
}

/* ============================================================
 * 5. 共享令牌与幽灵变量
 * ============================================================ */
console.log('\n=== 5. 令牌与幽灵变量 ===');
{
  const neo = stripBlock(read('css/neumorphism.css'));
  t('--z-flat 令牌仍在用（磨砂层靠它压住层级）', /var\(--z-flat\)/.test(neo),
    `实测 ${(neo.match(/var\(--z-flat\)/g) || []).length} 处引用`);

  /* --muted 从未在主文档定义过，此前 6 处裸用导致 color 整条声明失效、
     文字退成继承色（该显示弱化灰的地方显示成正文色）。
     守卫按"每一次引用"判，不能按"文件里有没有兜底"判 —— 后者会被
     别处的兜底背书洗白（已踩过）。 */
  const bare = [...neo.matchAll(/var\(--muted\)/g)];
  t('--muted 不再裸用（它未定义，整条声明会失效）', bare.length === 0,
    bare.length ? `实测 ${bare.length} 处裸引用` : '');
}

/* ============================================================
 * 6. 守卫自身不能失明
 * ------------------------------------------------------------
 * 跨文件冲突判据曾写成"任一侧含 var() 就不算冲突"，于是令牌化
 * 做得越彻底、守卫越看不见问题。这里钉住：尺度类令牌要求值后比较。
 * ============================================================ */
console.log('\n=== 6. 守卫自身 ===');
{
  const audit = code('style-audit-test.mjs');
  t('style-audit-test.mjs 存在', audit !== null);
  if (audit !== null) {
    /* 要的是"尺度类令牌能静态求值"。源码里写的是分组形式
       `^--(sp|fs|dur|anim|z)-`，不是字面 --sp-，所以按分组形态判。 */
    t('冲突判据定义了静态尺度令牌集合',
      /STATIC\s*=\s*\/\^--\(sp\|fs\|dur\|anim\|z\)-/.test(audit));
    /* 反向钉容易误伤：求值函数内部用同样的正则判断"还有没有嵌套 var"
       是完全合理的，坏的是**比较之前**就因见到 var 而跳过整次比较。
       所以正向钉：比较处必须走求值后的结果。 */
    t('冲突比较走的是求值后的结果（resolve 被比较处调用）',
      /const\s+resolve\s*=/.test(audit)
      && /resolve\(\s*p[ab]\[k\]\s*\)/.test(audit));
  }
  const utils = code('test-scan-utils.mjs');
  t('剥注释共用模块仍在（不该被整文件覆盖掉）', utils !== null && /stripComments/.test(utils));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
