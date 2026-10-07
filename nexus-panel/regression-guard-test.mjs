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
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative as relPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments as stripBlock, stripCommentsJs as stripJs } from './test-scan-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(HERE, p), 'utf8');
/** 绝对路径 → 相对 HERE 的路径（喂给 code() 用） */
const relativeTo = (abs) => relPath(HERE, abs).split('\\').join('/');
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

/* 遍历源码树（跳过体积巨大且与本守卫无关的目录） */
const SKIP_DIR = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.tauri', '__pycache__', '.jd2']);
function walk(dir, out = []) {
  let ents = [];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (SKIP_DIR.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/* ============================================================
 * 1. 无构建白屏：任何插件 JS 都不能 import CSS
 * ------------------------------------------------------------
 * 原生 ESM 不能 import CSS：浏览器拿到 text/css 会判成"不是 JS 模块"，
 * 整个入口 JS 加载失败 —— 插件一片空白、功能全无，
 * 控制台只有一条 MIME 报错，不看控制台根本不知道是哪一行造成的。
 *
 * 这一行在 mindmap 上**复发过 3 次**（修好又被整份覆盖回去），
 * 所以这里不只盯 mindmap，改成**全仓扫描**：任何 .js 里出现都算。
 * 全仓扫描后立刻在 color-picker/index.js 里查出同一行（已修）。
 * ============================================================ */
console.log('=== 1. 无构建白屏：JS 不许 import CSS ===');
{
  const jsFiles = walk(HERE).filter((p) => p.endsWith('.js'));
  t('能遍历到 JS 源码', jsFiles.length > 10, `实测 ${jsFiles.length} 个 .js`);

  const hits = [];
  for (const p of jsFiles) {
    const src = code(relativeTo(p));
    if (!src) continue;
    // 要的是"没有 import 任何 .css"，JS import 与 import() 都不行。
    // 判的是剥注释后的源码 —— 注释里写的路径不算（那是假绿来源）。
    const m = src.match(/^\s*import\s+[^;]*?['"][^'"]+\.css['"]/m)
      || src.match(/\bimport\s*\(\s*['"][^'"]+\.css['"]\s*\)/);
    if (m) hits.push(`${p.replace(HERE + '/', '')} → ${m[0].trim().slice(0, 50)}`);
  }
  t('全仓 .js 都不 import CSS（原生 ESM 不能 import CSS）', hits.length === 0,
    hits.length ? hits.join('；') : '');

  const css = read('plugins/mindmap/styles.css');
  t('mindmap/styles.css 存在', css !== null);
  if (css !== null) {
    // 剥注释后判，这样上方那段警告注释里写的路径不会把自己算进去
    t('styles.css 用 @import 引 dialog.css（替代 JS import）',
      /@import\s+url\(['"][^'"]*dialog\.css['"]\)/.test(stripBlock(css)));
  }
}

/* ============================================================
 * 1.5 插件间依赖方向
 * ------------------------------------------------------------
 * project-group/utils/color.ts 顶部明写：依赖方向 project-group →
 * color-picker，单向无循环（它只是 `export *` 转发回 color-picker/color）。
 * color-picker 反向去取就绕成环，且转发文件本身不含实现、只多一次跳转。
 * ============================================================ */
console.log('\n=== 1.5 插件间依赖方向 ===');
{
  const cp = code('plugins/color-picker/index.js');
  t('color-picker/index.js 存在', cp !== null);
  if (cp !== null) {
    t('color-picker 的实现不反向依赖 project-group（单向：pg → cp）',
      !/from\s+['"][^'"]*project-group/.test(cp));
    t('color-picker 从本目录 ./color 取颜色工具（唯一实现处）',
      /from\s+['"]\.\/color['"]/.test(cp));
  }
}

/* ============================================================
 * 1.6 孤儿入口文件（写了但没人加载的插件入口）
 * ------------------------------------------------------------
 * 入口文件只有被下面三条链之一指到才会真正加载：
 *   ① registry.js 的 entry（含 noBuild 三元的两边）
 *   ② 同目录 index.html 的 script src
 *   ③ 任何源码的相对 import
 *
 * 三条都够不上的就是死入口。它**不报错、不崩溃、测试也不红** ——
 * 谁都看不出来。危险在将来：哪天有人把它接上（比如给插件加个无构建
 * 分支），一个从没跑过、且与主实现漂移了很久的分叉就突然生效。
 *
 * 已实测：color-picker/index.js 就是这样一份休眠的第二实现，
 * 它的 pick 返回**颜色字符串**，而在跑的 main.tsx 返回 { hex, custom }。
 * 接上去调用方的 r.hex 会静默变成 undefined。详见该文件头部说明。
 * ============================================================ */
console.log('\n=== 1.6 孤儿入口文件 ===');
{
  const NAMES = ['index.js', 'index.tsx', 'main.js', 'main.tsx',
    'module.js', 'module.mjs', 'module.tsx'];
  /* 全仓源码（含 html），用来查引用链 */
  const srcs = new Map();
  for (const abs of walk(HERE)) {
    if (!/\.(js|mjs|ts|tsx|html|json)$/.test(abs)) continue;
    let txt;
    try { txt = readFileSync(abs, 'utf8'); } catch { continue; }
    srcs.set(relativeTo(abs), txt);
  }
  const reg = srcs.get('plugins/registry.js') || '';
  const norm = (base, r) => join(base, r).split('\\').join('/');

  const orphans = [];
  for (const dir of readdirSync(join(HERE, 'plugins'), { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const pd = 'plugins/' + dir.name;
    for (const n of NAMES) {
      const file = pd + '/' + n;
      if (!srcs.has(file)) continue;
      let ref = false;
      /* ① registry 提到这个路径 */
      if (reg.includes(file) || reg.includes('./' + file)) ref = true;
      /* ② 同目录 index.html 的 script src */
      const html = srcs.get(pd + '/index.html');
      if (html) {
        for (const m of html.matchAll(/src=["'](\.\/[^"']+)["']/g)) {
          if (norm(pd, m[1]) === file) ref = true;
        }
      }
      /* ③ 任何源码的相对 import */
      if (!ref) {
        for (const [q, txt] of srcs) {
          if (q === file) continue;
          const base = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : '';
          for (const m of txt.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]/g)) {
            if (norm(base, m[1] || m[2]) === file) { ref = true; break; }
          }
          if (ref) break;
        }
      }
      if (!ref) orphans.push(file);
    }
  }

  /* 已知清单：登记时写清为什么留着 —— 只增不减，新增立刻报红 */
  const KNOWN = ['plugins/color-picker/index.js'];
  t('孤儿入口统计范围有效', srcs.size > 50, `实测 ${srcs.size} 个源码文件`);
  t('孤儿入口不超过已知清单', orphans.length <= KNOWN.length,
    orphans.length > KNOWN.length
      ? `实测 ${orphans.length} 个：${orphans.join('、')}`
      : `${orphans.length} / ${KNOWN.length}`);
  for (const k of KNOWN) {
    t(`已知孤儿仍存在（登记未过期）：${k}`, srcs.has(k));
  }
}

/* ============================================================
 * 1.7 孤儿模块 + 汇合节点的重复实现
 * ------------------------------------------------------------
 * 孤儿模块 = 写了但没有任何文件 import 的模块。它不报错、不崩溃、
 * 测试永远绿 —— 只有扫引用链才看得见。危险在将来：谁按文件名把它接上，
 * 一个与主实现漂移了很久的分叉就突然生效（同 1.6 的死入口）。
 *
 * 范围刻意**排除两个活跃区**（plugins/mindmap、plugins/agent-flow）：
 * 那边每次拉都有新文件，纳入统计等于为一个我控制不了的数字反复报红
 * （dead-class 的内联副本基线已经吃过这个亏）。活跃区改用下面
 * 「汇合节点」那样的**定向断言**：钉具体那一个，钉得住且不吵。
 * ============================================================ */
console.log('\n=== 1.7 孤儿模块 ===');
{
  const ACTIVE = ['plugins/mindmap/', 'plugins/agent-flow/'];
  const NOISE = /(\.d\.ts$|\.min\.js$|(-test|\.test)\.(mjs|ts|tsx)$|testkit)/;
  const srcs = new Map();
  for (const abs of walk(HERE)) {
    if (!/\.(js|mjs|ts|tsx)$/.test(abs)) continue;
    const rel = relativeTo(abs);
    if (NOISE.test(rel)) continue;
    if (ACTIVE.some((a) => rel.startsWith(a))) continue;
    if (!rel.includes('/')) continue;              // 根目录脚本：手工跑的工具
    let txt;
    try { txt = readFileSync(abs, 'utf8'); } catch { continue; }
    srcs.set(rel, txt);
  }

  /* 引用方要扫**全部**源码（含测试文件）—— 只扫上面那份筛过的集合的话，
     只有测试在 import 的模块会被误判成孤儿（js/dead-class-scan.js 就是这样：
     它运行时不用，四个测试在用）。判据失效比数字难看更糟。 */
  const all = new Map();
  for (const abs of walk(HERE)) {
    if (!/\.(js|mjs|ts|tsx)$/.test(abs)) continue;
    let txt;
    try { txt = readFileSync(abs, 'utf8'); } catch { continue; }
    all.set(relativeTo(abs), txt);
  }
  const imported = new Set();
  for (const [q, txt] of all) {
    const base = q.includes('/') ? q.slice(0, q.lastIndexOf('/')) : '';
    for (const m of txt.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]|import\s+['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const r = m[1] || m[2] || m[3];
      const x = join(base, r).split('\\').join('/');
      for (const c of [x, x + '.js', x + '.mjs', x + '.ts', x + '.tsx',
        x + '/index.js', x + '/index.ts']) {
        if (srcs.has(c)) { imported.add(c); break; }
      }
    }
  }
  /* 入口文件由加载器/registry 拉起，不算孤儿（1.6 已单独守过）；
     scripts/ 是手工或 CI 跑的独立脚本，不走 import 链 */
  const orphans = [...srcs.keys()].filter((p) => !imported.has(p)
    && !p.startsWith('scripts/')
    && !/(^|\/)(index|main|module)\.(js|mjs|ts|tsx)$/.test(p));

  /* 已知清单：登记时写清为什么留着 —— 只增不减，新增立刻报红。
     · contract-scan.mjs —— 手工跑的诊断工具，头部写明 `用法：node ...`
     · src/components/Dialog.tsx —— 弹窗的 React 包装，等 React 插件用。
       刻意留着：它内部复用 js/dialog.js 同一套实现，不是第二套弹窗；
       删了将来重写会忍不住另起一份样式（该文件头部注释正是警告这点）。 */
  const KNOWN = ['plugins/project-group/contract-scan.mjs', 'src/components/Dialog.tsx'];
  t('孤儿模块统计范围有效', srcs.size > 30, `实测 ${srcs.size} 个模块`);
  t('孤儿模块不超过已知清单', orphans.length <= KNOWN.length,
    orphans.length > KNOWN.length
      ? `实测 ${orphans.length} 个：${orphans.join('、')}`
      : `${orphans.length} / ${KNOWN.length}`);
  for (const k of KNOWN) t(`已知孤儿仍存在（登记未过期）：${k}`, srcs.has(k));
}

console.log('\n=== 1.7b agent-flow 汇合节点不能有两份实现 ===');
{
  /* 实测：components/JoinNode.tsx 与 components/ControlNode.tsx 各导出一个
     JoinNode。生效的是后者（nodes/defs/join.tsx 从 ControlNode 取）；
     前者无人 import，是重构到共享 Card 之前的旧版，还带着两个装饰性
     handle。留在仓库里最坏的情况不是"多一份死代码"，而是有人按文件名
     把它接回去 —— 汇合节点会突然长出两个不参与引擎判定的入口。 */
  const def = code('plugins/agent-flow/nodes/defs/join.tsx');
  t('join 定义存在', def !== null);
  if (def !== null) {
    t('生效的 JoinNode 来自 ControlNode（共享 Card 版）',
      /from\s+['"][^'"]*components\/ControlNode['"]/.test(def)
      && /JoinNode/.test(def));
    t('不再引用独立文件 components/JoinNode',
      !/from\s+['"][^'"]*components\/JoinNode['"]/.test(def));
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
