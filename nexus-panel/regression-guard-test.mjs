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
import { readFileSync, readdirSync, existsSync } from 'node:fs';
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
 * 1.9 源码里不许写死开发机绝对路径
 * ------------------------------------------------------------
 * 已经清掉的三处（都是 /data/workspace/... 这类本机路径）：
 *   · sweep-tests.mjs  —— 明细输出目录，在别人机器上要么没权限建
 *                        （在 / 下 mkdir 直接 EACCES），要么写到找不到的地方
 *   · smoke-react.mjs  —— esbuild 的兜底加载路径
 *   · check-types.sh   —— tsc 的兜底路径，且会让报错指向一个陌生目录
 *
 * 共同症状：脚本**在自己机器上一直能用**，换台机器（或 CI）就挂，
 * 而报错指向的路径没人认识，看的人只会以为"脚本坏了"。
 * 判据只扫**代码**，注释里引用旧路径做说明是刻意保留的，不算数。
 * ============================================================ */
console.log('\n=== 1.9 不许写死开发机绝对路径 ===');
{
  /* 只盯"这台开发机"的路径 —— /data/workspace 是沙盒专用前缀，
     换台机器必然不存在。
     home / Users 那条要求用户名 ≥3 字符：测试里 'u'、'me' 这种
     单字母占位符是刻意的假数据，当成真路径会误伤一堆 fixture。 */
  const BAD = [/\/data\/workspace/, /\/home\/[A-Za-z]{3,}\//, /\/Users\/[A-Za-z]{3,}\//, /[A-Za-z]:\\(?:Users|workspace)\\/i];
  const SKIPEXT = /\.(md|txt|json|lock|svg|png|jpg|ico)$/i;
  const hits = [];
  for (const abs of walk(HERE)) {
    const rel = relativeTo(abs);
    if (SKIPEXT.test(rel)) continue;
    if (!/\.(mjs|js|cjs|ts|tsx|sh|py)$/.test(rel)) continue;
    /* 跳过构建产物与本文件：产物是生成出来的（且不入库），
       本文件里那段正则字面量必然命中自己。 */
    if (rel.startsWith('.smoke-react') || rel === 'regression-guard-test.mjs') continue;
    let txt;
    try { txt = readFileSync(abs, 'utf8'); } catch { continue; }
    /* 只扫代码：剥注释。shell 用的是 # 注释，stripJs 认的是 // 和块注释，
       .sh 必须先单独剥掉 # 行，否则整段说明都被当成代码。 */
    let code = stripJs(txt);
    if (rel.endsWith('.sh')) code = code.replace(/^\s*#[^\n]*/gm, '').replace(/[^\\s]#[^\n]*/g, '');
    for (const re of BAD) if (re.test(code)) { hits.push(rel); break; }
  }
  t('源码里没有写死的开发机绝对路径', hits.length === 0,
    hits.length ? `${hits.length} 个文件：${hits.slice(0, 5).join('、')}` : '');
  t('1.9 判据本身有效（注释里的路径不算）',
    BAD.some((re) => re.test('/data/workspace/x'))
    && !BAD.some((re) => re.test(stripJs('/* 旧路径 /data/workspace */ const a=1;'))));
}

/* ============================================================
 * 1.8 Rust 命令必须进了 generate_handler
 * ------------------------------------------------------------
 * 写了 `#[tauri::command]` 却没登记进 invoke_handler 的命令，
 * **编译得过、前端调不到**：invoke 返回一个"命令未找到"，界面上表现为
 * 点了没反应。历史上有过 rt_dep::* 四条漏登记的就是这类。
 *
 * 判据只用**一个方向**（声明 ⊆ 注册）：
 *   · 反方向（注册 ⊆ 声明）不能守 —— Rust 编译期就会报错，用不着测试；
 *     而且 invoke_handler 块里有说明性块注释，剥掉它们会把注释里点名的
 *     命令一起丢掉（tray_toggle_window 就是写在注释里说明"必须留末位"的）。
 *   所以这里**只剥行注释，保留块注释** —— 宁可把注释里的词也收进来，
 *   也不能漏掉真命令。
 * ============================================================ */
console.log('\n=== 1.8 Rust 命令登记 ===');
{
  const rsFiles = walk(HERE).filter((p) => p.endsWith('.rs'));
  const declared = new Set();
  for (const abs of rsFiles) {
    let txt;
    try { txt = readFileSync(abs, 'utf8'); } catch { continue; }
    for (const m of txt.matchAll(/#\[tauri::command[^\]]*\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/g)) {
      declared.add(m[1]);
    }
  }
  t('扫到了 Rust 命令声明', declared.size > 20, `实测 ${declared.size} 个`);

  const main = read('src-tauri/src/main.rs');
  t('main.rs 存在', typeof main === 'string' && main.length > 0);
  if (typeof main === 'string') {
    const i = main.indexOf('generate_handler![');
    t('能定位 generate_handler', i > 0);
    if (i > 0) {
      const seg = main.slice(i, main.indexOf('])', i));
      /* 只剥行注释 —— 块注释里的命令名要留着，理由见上方 */
      const noLine = seg.replace(/\/\/[^\n]*/g, '');
      const reg = new Set([...noLine.matchAll(/(?:[a-z_]+::)?\b([a-z_]\w*)\b/g)].map((m) => m[1]));
      const miss = [...declared].filter((n) => !reg.has(n));
      t('所有 #[tauri::command] 都已登记进 invoke_handler',
        miss.length === 0, miss.length ? `未登记：${miss.join('、')}` : '');
    }
  }
}

/* ============================================================
 * 1.10 .d.ts 声明必须与 JS 实现对齐（只守危险的一向）
 * ------------------------------------------------------------
 * 「d.ts 声明了值、JS 里没有」是最坏的一种漂移：
 * TS 编译得过、编辑器补全还提示你它在，运行时拿到 undefined，调用即崩。
 * 反方向（JS 有、d.ts 没写）只是 TS 侧用不了，**不会炸**，
 * 而且 host.js 有一批导出是只给 .mjs 测试用的，全部补进 d.ts 属于噪音。
 *
 * 所以这里只守危险的一向。判据只认**值导出**（function / const / class），
 * interface / type 是编译期概念、运行时本来就不存在，不能拿它们比对。
 * ============================================================ */
console.log('\n=== 1.10 .d.ts 与实现对齐 ===');
{
  /*
   * ⚠️ 这里曾经是 existsSync('js/...') —— 裸相对路径，结论由"从哪个目录
   *    敲 node"决定：换目录后 5 对全部解析不到，pairs 变 0，本节**红的**
   *    是"成对存在"这条，而紧随其后的"没有幽灵导出"会因为 pairs 为空
   *    **恒真**——真有幽灵导出也照样绿。是运行时守卫（cwd-invariant）
   *    实测 76/0 与 75/1 的差才把它逼出来，静态守卫看不见：
   *    字面量先收集进数组、再传给 fs，离 fs 调用隔着一层，第 5 节第二层
   *    只认"fs 紧跟字面量"，整批漏网。
   */
  const pairs = ['plugin-sdk', 'host', 'tauri-core', 'plugin-config', 'external-policy']
    .map((n) => [`js/${n}.d.ts`, `js/${n}.js`])
    .filter(([d, j]) => existsSync(join(HERE, d)) && existsSync(join(HERE, j)));
  t('成对存在的 d.ts / js', pairs.length >= 5, `实测 ${pairs.length} 对`);

  const ghost = [];
  for (const [d, j] of pairs) {
    const dd = stripJs(read(d));
    const jj = stripJs(read(j));
    const declV = new Set([
      ...[...dd.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]),
      ...[...dd.matchAll(/export const (\w+)/g)].map((m) => m[1]),
      ...[...dd.matchAll(/export (?:declare )?class (\w+)/g)].map((m) => m[1]),
    ]);
    const implV = new Set([
      ...[...jj.matchAll(/export (?:async )?function (\w+)/g)].map((m) => m[1]),
      ...[...jj.matchAll(/export const (\w+)/g)].map((m) => m[1]),
      ...[...jj.matchAll(/export class (\w+)/g)].map((m) => m[1]),
    ]);
    for (const m of jj.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const y of m[1].split(',')) {
        const n = y.trim().split(' as ').pop().trim();
        if (n) implV.add(n);
      }
    }
    for (const n of declV) if (!implV.has(n)) ghost.push(`${d} → ${n}`);
  }
  t('d.ts 里没有「声明了但实现不存在」的值导出',
    ghost.length === 0, ghost.length ? ghost.join('；') : '');
}

/* ============================================================
 * 1.11 两个外壳必须暴露同一套 __NEXUS__ 字段
 * ------------------------------------------------------------
 * React 外壳（src/App.tsx）与原生外壳（js/shell.js）是同一套接口的两种实现，
 * 插件不区分自己在哪个壳里。谁往一侧加字段而忘了另一侧，那个字段在另一
 * 个壳里就是 undefined —— 而 global.d.ts 里这些字段全是 optional，
 * **TS 不会报任何错**，只有运行到那一行才炸。
 *
 * 历史：React 版一度只挂了一半字段，类型却按全量声明，
 * 等于类型在撒谎（详见 src/global.d.ts 顶部说明）。
 *
 * 用 TS 解析器取键而不用正则：对象里嵌着箭头函数体（setRefreshHandler:
 * (fn) => {…}），数括号深度会把函数体的花括号算成嵌套层，
 * 实测会漏掉 / 多算好几个键 —— 我第一版就因此得出过"两边差 4 个"的假结论。
 *
 * 已知缺口：pluginCfg 只有 React 侧挂（原生侧刻意不暴露，
 * global.d.ts 里也标了原因）。哪天原生侧补上了，这条登记会报"已过期"。
 * ============================================================ */
console.log('\n=== 1.11 两个外壳的 __NEXUS__ 字段 ===');
{
  let ts = null;
  try { ts = await import('typescript'); } catch { /* 下面会判据失效 */ }
  t('能加载 typescript（否则本节的键集合取不到）', !!ts);
  if (ts) {
    const nexusKeys = (file, kind) => {
      const txt = read(file);
      const sf = ts.createSourceFile(file, txt, ts.ScriptTarget.Latest, true, kind);
      let found = null;
      (function walk(n) {
        if (found) return;
        if (ts.isExpressionStatement(n) && ts.isBinaryExpression(n.expression)
            && n.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const l = n.expression.left, r = n.expression.right;
          if (ts.isPropertyAccessExpression(l) && l.name.text === '__NEXUS__'
              && ts.isObjectLiteralExpression(r)) { found = r; return; }
        }
        ts.forEachChild(n, walk);
      })(sf);
      return found ? found.properties.map((p) => p.name && p.name.text).filter(Boolean) : null;
    };

    const a = nexusKeys('src/App.tsx', ts.ScriptKind.TSX);
    const b = nexusKeys('js/shell.js', ts.ScriptKind.JS);
    t('两个外壳都能定位到 window.__NEXUS__ 赋值', !!a && !!b,
      `React ${a ? a.length : '?'} 个 / 原生 ${b ? b.length : '?'} 个`);
    if (a && b) {
      /* 判据自检：两边都该拿到十几个键，拿到一两个说明解析漏了 */
      t('解析到的键数量合理（不是只解析出一部分）', a.length >= 10 && b.length >= 10,
        `React ${a.length} / 原生 ${b.length}`);

      const KNOWN_GAP = ['pluginCfg'];   // 已知只有 React 侧挂，原生侧刻意不暴露
      const onlyA = a.filter((x) => !b.includes(x));
      const onlyB = b.filter((x) => !a.includes(x));
      const bad = [...onlyA, ...onlyB].filter((x) => !KNOWN_GAP.includes(x));
      t('两个外壳的字段集合一致（pluginCfg 为已登记缺口）',
        bad.length === 0,
        bad.length ? `不对等：${bad.join('、')}` : `已知缺口 ${KNOWN_GAP.join('、')}`);
      t('已登记缺口确实还成立（没被悄悄补上而忘了更新这里）',
        onlyA.filter((x) => KNOWN_GAP.includes(x)).length === KNOWN_GAP.length,
        `实测 React 独有：${onlyA.join('、') || '无'}`);
    }
  }
}

/* ============================================================
 * 1.12 服务插件：广告的方法必须真的实现
 * ------------------------------------------------------------
 * 服务插件在 describe() 里用 methods:[...] 广告自己有哪些方法，
 * 调用方照着这个名单去调。**广告了却没实现**是最坏的一种：
 * 调用方写了合规的调用，运行时拿到的是"没有这个方法"——
 * 轻则 undefined，重则在调用点直接抛，而广告名单本身看起来完全正常。
 *
 * 实现侧的两种写法都要认：
 *   · bootServicePlugin({ pick, normalize, … }) —— 入口的第二参数就是分派表
 *   · methods: { … }                             —— module.js 里显式挂的对象
 *
 * 扫的是文件而不是 registry 的 entry —— 休眠的孤儿入口（color-picker/index.js
 * 就是）同样会被扫到。它**目前没人加载**，但哪天被接上，
 * 这里的错位会立刻变成真的调用失败。
 *
 * 顺带发现过的一处：color-picker/index.js 广告 normalize、
 * 实现却挂成 normalizeHex —— 已改成广告 normalizeHex，名字本身的差异
 * 记在文件头的漂移对照表里（它与现行契约 main.tsx 差一个后缀）。
 * ============================================================ */
console.log('\n=== 1.12 服务插件广告的方法 ===');
{
  let ts2 = null;
  try { ts2 = await import('typescript'); } catch { /* 下面会判据失效 */ }
  t('能加载 typescript', !!ts2);
  if (ts2) {
    const SKIPD = new Set(['node_modules', '.git', 'dist', '__pycache__']);
    const files = [];
    (function w(dir) {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (SKIPD.has(e.name)) continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) w(p);
        else if (/\.(js|mjs|ts|tsx)$/.test(e.name)) files.push(p);
      }
    })(join(HERE, 'plugins'));

    const bad = [];
    let scanned = 0;
    for (const abs of files) {
      const rel = relativeTo(abs);
      if (/kity|kityminder/.test(rel)) continue;
      let txt;
      try { txt = readFileSync(abs, 'utf8'); } catch { continue; }
      if (!/bootService\w*Plugin\(|methods:/.test(txt)) continue;
      const kind = rel.endsWith('.tsx') ? ts2.ScriptKind.TSX
        : rel.endsWith('.ts') ? ts2.ScriptKind.TS : ts2.ScriptKind.JS;
      const sf = ts2.createSourceFile(rel, txt, ts2.ScriptTarget.Latest, true, kind);
      const adv = [], impl = [];
      (function walk(n) {
        if (ts2.isCallExpression(n)) {
          const fn = n.expression.getText();
          if (/bootService\w*Plugin$/.test(fn) && n.arguments.length) {
            const a = n.arguments[n.arguments.length - 1];
            if (ts2.isObjectLiteralExpression(a)) {
              impl.push(...a.properties.map((x) => x.name && x.name.text).filter(Boolean));
            }
          }
        }
        if (ts2.isPropertyAssignment(n) && n.name && n.name.text === 'methods') {
          if (ts2.isArrayLiteralExpression(n.initializer)) {
            adv.push(...n.initializer.elements.map((e) => (ts2.isStringLiteral(e) ? e.text : '?')));
          } else if (ts2.isObjectLiteralExpression(n.initializer)) {
            impl.push(...n.initializer.properties.map((x) => x.name && x.name.text).filter(Boolean));
          }
        }
        ts2.forEachChild(n, walk);
      })(sf);
      if (!adv.length) continue;
      scanned++;
      const miss = [...new Set(adv)].filter((x) => ![...new Set(impl)].includes(x));
      if (miss.length) bad.push(`${rel} → ${miss.join('、')}`);
    }
    /* 判据自检：扫不到几个文件说明匹配方式失效了，而不是"天下太平" */
    t('扫到的带 methods 声明的服务文件数量合理', scanned >= 7, `实测 ${scanned} 个`);
    t('没有「广告了但没实现」的服务方法', bad.length === 0, bad.join('；'));
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

/* ============================================================
 * 7. 导入预设的「跳过原因」不能说假话
 * ------------------------------------------------------------
 * 「能不能拿来做预设」的判据被统一成一条之后（类型存在**且**不是老类型），
 * 提示语却还写着"本机没有「X」这种节点"。而不成立其实有两种原因：
 *   ① 这台机器真没装这种节点
 *   ② 装了，但它已并入另一个节点（老类型），不该再当新节点的起点
 * 于是 ② 会被报成 ①：用户明明装过，却被告知"没有"，他会去查安装、
 * 查版本，而真正的原因只是那条已废弃。不报错、不崩溃，只把人支到错的方向。
 *
 * 这里钉的是**通用规律**，不是某个具体函数名：
 *   判定能不能的函数拿不到"为什么不能"，所以它要么问调用方要原因，
 *   要么就只能说一句两种原因下都成立的中性话 —— 绝不能替调用方断言原因。
 * 判据将来再放宽（比如再加一条"已弃用"），原因也必须跟着走，否则又变假话。
 * ============================================================ */
console.log('\n=== 7. 导入预设的跳过原因 ===');
{
  const cp = code('plugins/agent-flow/engine/customPresets.ts');
  t('customPresets.ts 存在', cp !== null);
  if (cp !== null) {
    /* ① 支持把原因交给调用方：opts 里得有这个入口，且真的**调用**它取原因。
          注意钉的是调用形态 `opts.skipReason(...)` —— 只钉 "opts.skipReason"
          会被三元判断那一处掩盖：删掉真正取原因的调用，判据照样成立，
          破坏验证时全绿，等于没守（已实测踩到）。 */
    t('判定函数支持调用方给出跳过原因（声明了，且真的调它取原因）',
      /skipReason\s*\?\s*:/.test(cp) && /opts\.skipReason\??\s*\(/.test(cp));
    /* ② 拿不到原因时，不能替调用方断言"没有" ——
          那正是判据放宽后说假话的那句 */
    t('拿不到原因时不再断言「本机没有」（引擎不知道判据为什么不成立）',
      !/本机没有/.test(cp),
      cp !== null && /本机没有/.test(cp) ? '仍在写「本机没有」' : '');
  }
  const sb = code('plugins/agent-flow/components/Sidebar.tsx');
  t('Sidebar.tsx 存在', sb !== null);
  if (sb !== null) {
    /* ③ 调用方真的把原因传进去了 —— 只改引擎、调用方不传，等于没改 */
    t('导入处真的传了原因（分开说「没有」与「有但已废弃」）',
      /skipReason\s*:/.test(sb));
  }
}

/* ============================================================
 * 8. 静默吞异常：空的 catch 必须就近写明为什么可以吞
 * ------------------------------------------------------------
 * 这一类**在本仓库造成过真实 BUG**，证据就在被测代码自己的注释里：
 * js/theme-manager.js 开头写着 —— deleteCustomTheme() 遍历 STYLE_PARAMS
 * 清风格参数覆盖时抛了异常，被外面的 `catch {}` 吞掉，于是**清理从那行
 * 起全部中断**（基调/风格之后的偏移键一个都没删），而界面上"删除成功"
 * 照常提示。症状是"删了又出现"，排查方向却被"没有报错"整个带偏。
 *
 * 所以空 catch 本身不是错（收尾类代码大量需要），**没有交代**才是错：
 * 后来的人分不清"这里可以吞"和"这里忘了处理"，改代码时不敢动，
 * 也发现不了自己新引入的那次抛错就是从这里漏过去的。
 *
 * 为什么是"就近有注释"而不是"catch 里必须有注释"：
 *   实测 35 处里有大量把理由写在**上一行**或 try 块上方（
 *   `/* 不 await 也不抛：存不上只是下次不恢复，不该打断滚动 *​/` 紧接着
 *   `.catch(() => {})`），强行塞进大括号反而割裂。所以判据取
 *   "前面 400 字符内有注释"，代价是宽松了些（一条不相关的上方注释
 *   也能过关），换来的是**不会再有人被逼着写 `catch { /* 忽略 *​/ }`
 *   这种占位说明**——那比不写更糟，因为它看着像有理由。
 *
 * 两种形态都算：`try { … } catch {}` 与 `promise.catch(() => {})`。
 * ============================================================ */
console.log('\n=== 8. 静默吞异常：空 catch 必须有交代 ===');
{
  const SRC_EXT = /\.(ts|tsx|js|jsx|mjs)$/;
  const files = walk(HERE).filter((p) => SRC_EXT.test(p)
    && !p.endsWith('.min.js') && !/kity\.min/.test(p)
    && !p.endsWith('-test.mjs') && !p.endsWith('.test.ts')
    && !p.split('/').includes('tests'));

  /*
   * 判据只有这一处（护栏与元断言共用），写成两处必然漂移 ——
   * 这个项目已经因为"判据分两份"踩过好几次。
   *
   * 返回 true = 这处空 catch **没有交代**。
   */
  const silentCatch = (src) => {
    const out = [];
    const pats = [
      /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g,
      /\.catch\(\s*(?:\(\)\s*=>|function\s*\(\s*\))\s*\{\s*\}\s*\)/g,
    ];
    for (const re of pats) {
      for (const m of src.matchAll(re)) {
        /* 往前 400 字符内有 // 或 /* 就算交代过了 */
        const pre = src.slice(Math.max(0, m.index - 400), m.index);
        if (!/\/\/|\/\*/.test(pre)) out.push(m[0]);
      }
    }
    return out;
  };

  const bad = [];
  for (const p of files) {
    const src = readFileSync(p, 'utf8');
    const hits = silentCatch(src);
    if (hits.length) bad.push(`${relativeTo(p)}（${hits.length} 处）`);
  }
  t('能遍历到源码（判据不能空转）', files.length > 100, `实测 ${files.length} 个源文件`);
  t('没有"吞掉异常却不说明理由"的空 catch', bad.length === 0,
    bad.length ? bad.slice(0, 6).join('；') : '');
  /*
   * 元断言：判据失明比数字难看危险得多 ——
   * 把"有没有注释"写反的话，上面那条会**永远全绿**，
   * 而它要防的正是"没人看得出这里吞了异常"。
   */
  t('写了理由的空 catch 不算漏（不能误伤）',
    silentCatch('/* 存不上只是下次不恢复 */\ntry{ a(); } catch {}').length === 0
    && silentCatch('// 不 await 也不抛\np.catch(() => {})').length === 0);
  t('真·静默的空 catch 照样被抓（判据没失明）',
    silentCatch('try{ a(); } catch {}').length === 1
    && silentCatch('p.catch(() => {})').length === 1);
  t('catch 里真做了事的不算空（不能误伤）',
    silentCatch('try{ a(); } catch (e) { console.error(e); }').length === 0);
}

/* ============================================================
 * 9. 预设图标清单：三份必须一致
 * ------------------------------------------------------------
 * 同一个东西**抄了三处**：
 *   ① plugins/project-group/preseticons/*.ico  —— 唯一物理来源（122 个）
 *   ② plugins/icon-picker/iconNames.js          —— 选图标插件的清单
 *   ③ plugins/project-group/presetIcons.ts      —— 项目组预设图标网格的清单
 *
 * ②③ 当前**逐项完全一致**（本轮实测：122/122/122，零差异），
 * 所以这不是现存的 BUG，而是"随时会漂"的结构：
 *
 *   · icon-picker 加了图标、project-group 没加 —— 用户在图标选择器里
 *     能选到，在项目组预设里选不到；
 *   · 反向（project-group 多一个）—— 网格里列了一个指向不存在文件的
 *     图标，显示成破图；
 *   · 物理文件改名 / 删了一个 —— 两边清单都还写着旧名，同样破图。
 *
 * 三者都不是报错：前者是"功能少了"，后两者是"图裂了"。
 * 而这个项目已有"图标整批消失但界面不报错"的前科
 * （native-assets-test.mjs 记的 N62：dist 里 .ico 数量 = 0，
 *  122 个图标全部 404，界面上只是图标位一片空白）。
 *
 * 为什么**不合掉这两份清单**（看起来更彻底）：
 *   icon-picker 是**原生 JS 插件**，index.js 被浏览器直接加载，
 *   import 不了 presetIcons.ts（那是 TS，要靠构建）。
 *   而 icon-picker 用的物理文件本来就是 project-group/preseticons/
 *   （它自己注释里写着用 `../project-group/preseticons/` 相对路径引用，
 *   并警告"搬走要么断它的引用"）—— 跨插件引用物理资源是**既定设计**。
 *   既然物理上只有一个来源，就让两份清单都去对齐它，而不是硬造转发。
 * ============================================================ */
console.log('\n=== 9. 预设图标清单三份一致 ===');
{
  const ICON_DIR = 'plugins/project-group/preseticons';
  /* 两份文件写法不同（有无类型标注），但都是纯字符串字面量数组 */
  const listOf = (rel) => {
    const s = read(rel);
    if (s === null) return null;
    const m = s.match(/=\s*\[([\s\S]*?)\n\];/);
    if (!m) return null;
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };

  let files = [];
  try { files = readdirSync(join(HERE, ICON_DIR)); } catch { /* 目录不在就算了 */ }
  const onDisk = files.filter((f) => f.endsWith('.ico')).map((f) => f.replace(/\.ico$/, ''));
  const picker = listOf('plugins/icon-picker/iconNames.js');
  const pg = listOf('plugins/project-group/presetIcons.ts');

  t('能读到物理图标目录（判据不能空转）', onDisk.length > 100, `实测 ${onDisk.length} 个 .ico`);
  t('能解析出两份清单（判据不能空转）',
    Array.isArray(picker) && picker.length > 100 && Array.isArray(pg) && pg.length > 100,
    `icon-picker ${picker?.length ?? 'null'} / project-group ${pg?.length ?? 'null'}`);

  if (onDisk.length && picker?.length && pg?.length) {
    const diff = (a, b) => a.filter((x) => !b.includes(x)).concat(b.filter((x) => !a.includes(x)));
    const d1 = diff(onDisk, picker);
    const d2 = diff(onDisk, pg);
    const d3 = diff(picker, pg);
    t('icon-picker 清单 = 物理文件', d1.length === 0,
      d1.length ? `差异 ${d1.length} 个：${d1.slice(0, 4).join('、')}` : '');
    t('project-group 清单 = 物理文件', d2.length === 0,
      d2.length ? `差异 ${d2.length} 个：${d2.slice(0, 4).join('、')}` : '');
    t('两份清单彼此一致', d3.length === 0,
      d3.length ? `差异 ${d3.length} 个：${d3.slice(0, 4).join('、')}` : '');
    t('数量与物理文件相同（少了是漏登记，多了是破图）',
      picker.length === onDisk.length && pg.length === onDisk.length,
      `物理 ${onDisk.length} / icon-picker ${picker.length} / project-group ${pg.length}`);
  }
}

/* ============================================================
 * 10. escapeHtml 的每一份实现都必须转义满 5 个字符
 * ------------------------------------------------------------
 * 项目**已有**安全标准，不是这里另立：xss-test.mjs 第 47 条钉着
 * js/host.js 的 escapeHtml 必须把 `'` 转成 `&#39;`。
 *
 * 而全仓一度有**三份** escapeHtml，且**只有 host.js 那一份达标**：
 *   · js/host.js                    → & < > " '   ✅
 *   · plugins/md/export.js          → & < > "     ❌ 漏单引号（已修）
 *   · plugins/md-editor/index.js    → & < > "     ❌ 漏单引号（已修）
 *
 * 两份不达标的当前用法都恰好安全（一个只在 `<title>` 文本上下文，
 * 一个生成的属性全是双引号），所以那不是现存的漏洞 ——
 * 但它们是**抄开的两份实现**，且 md/export.js 那份是 export 出去的公共函数：
 * 谁将来把它用在单引号包裹的属性里（`title='…'`），漏掉的 `'` 就是注入口。
 * 而"安全的那一份"和"不安全的那一份"长得很像，挑错非常容易。
 *
 * 补上单引号对现有输出**零影响**（浏览器把 &#39; 渲染成 '），
 * 所以这里做的是"对齐既有标准"，不是改行为。
 *
 * 判据取"实现体里五个实体都在"，而不是钉某个具体写法 ——
 * 三份写法各不相同（一次 replace+映射表 / 链式 replace），
 * 钉写法会立刻误伤正在写的新实现。
 * ============================================================ */
console.log('\n=== 10. escapeHtml 实现必须转义满 5 个字符 ===');
{
  const REQUIRED = ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;'];
  /* 取函数体：从 `function escapeHtml` 起，括号配平到闭合大括号 */
  const implBody = (src) => {
    const m = src.match(/function\s+escape(?:Html|HTML)\s*\([^)]*\)\s*\{/);
    if (!m) return null;
    const st = m.index + m[0].length - 1;
    let d = 0;
    for (let i = st; i < src.length; i++) {
      if (src[i] === '{') d++;
      else if (src[i] === '}') { d--; if (d === 0) return src.slice(st, i + 1); }
    }
    return null;
  };

  /*
   * 排除测试文件：本文件（以及别的守卫）在元断言里会写
   * `function escapeHtml(s){…}` 的**样例字符串**来证明判据有效，
   * 那是"待检查的样本"不是实现 —— 扫进来会把自己判成漏转义。
   * 实测踩到：第一版没排除，本文件被自己报"缺 &#39;"
   * （取到的正是那条**故意写漏**的样例）。
   * 这与第 8 节排掉 -test.mjs 是同一个道理。
   */
  const files = walk(HERE).filter((p) => /\.(ts|tsx|js|jsx|mjs)$/.test(p)
    && !p.endsWith('.min.js') && !/kity\.min/.test(p)
    && !p.endsWith('.d.ts')
    && !p.endsWith('-test.mjs') && !p.endsWith('.test.ts')
    && !p.split('/').includes('tests'));
  const impls = [];
  for (const p of files) {
    const src = readFileSync(p, 'utf8');
    if (!/function\s+escape(?:Html|HTML)\s*\(/.test(src)) continue;
    const body = implBody(src);
    if (!body) continue;
    const missing = REQUIRED.filter((e) => !body.includes(e));
    impls.push({ rel: relativeTo(p), missing });
  }
  const bad = impls.filter((x) => x.missing.length);

  t('找得到 escapeHtml 的实现（判据不能空转）', impls.length >= 3,
    `实测 ${impls.length} 份：${impls.map((x) => x.rel).join('、')}`);
  t('每一份 escapeHtml 都转义满 & < > " \'（对齐 xss-test 钉的标准）',
    bad.length === 0,
    bad.length ? bad.map((x) => `${x.rel} 缺 ${x.missing.join(' ')}`).join('；') : '');
  /* 元断言：判据失明比数字难看危险得多 ——
     漏判的话上面那条会永远全绿，而它防的是"挑错一份不安全的实现"。 */
  t('漏了单引号的实现照样被抓（判据没失明）',
    (() => {
      const src = "function escapeHtml(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');}";
      const b = implBody(src);
      return b !== null && REQUIRED.filter((e) => !b.includes(e)).length === 1;
    })());
  t('五个都齐的不算漏（不能误伤）',
    (() => {
      const src = "function escapeHtml(s){return s.replace(/[&<>\"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));}";
      const b = implBody(src);
      return b !== null && REQUIRED.every((e) => b.includes(e));
    })());
}

/* ============================================================
 * 11. 拖拽内核：两套实现必须逐项等价
 * ------------------------------------------------------------
 * 仓库里有**两套拖拽排序内核**，各自带一份纯逻辑：
 *   A 外壳侧：js/drag-reorder.js            （+ react 层，settings 插件在用）
 *   B 插件侧：plugins/project-group/utils/dragSort.ts（项目组四套拖拽在用）
 *
 * 有 6 个函数是**同名同语义**的：
 *   movedEnough / clampIndex / deadZone /
 *   swapIndexWithDeadZone / edgeScrollSpeed / resolveMoveIndex
 * 外加常量 DRAG_THRESHOLD = 5、以及死区(8, .2)与贴边(48, 14)两组默认值
 * —— B 侧把它们写成了**字面量默认参数**（deadZone 的 fixed=8/ratio=.2、
 *    edgeScrollSpeed 的 zone=48/maxSpeed=14），所以改 A 的常量不会带动 B。
 *
 * 本轮实测：24000 组随机入参下 6 个函数**输出全部相同**，
 * 所以这不是现存 BUG，而是"随时会漂"的结构。漂了的后果：
 *   同一台机器上，设置里的列表拖动与项目组的卡片拖动**手感不一致**
 *   （阈值、死区、贴边加速、落点纠偏任一处对不上）。
 * 而**各自都有测试且都会全绿** —— drag-reorder-test 49 项只测 A，
 * drag-sort-test 145 项只测 B，谁都不会发现对面变了。
 * 这正是"两份实现 + 两份各自的测试"的经典盲区。
 *
 * 为什么**不合掉**（看起来更彻底）：
 *   B 是 .ts、A 是 .js，且 B 还有一堆 project-group 专属的东西
 *   （外部拖入判定、分框/页签/动作的 payload 解析）。
 *   让插件去 import 外壳的 js/ 也违背了插件自包含的方向。
 *   既然物理上确实有两份，就让**等价性**被钉住 —— 谁改一处，这里立刻报红。
 *
 * 判据取"同入参同输出"而不是"源码文本相同"：
 *   两份的循环写法本就不同（for vs while）、辅助函数名不同
 *   （depthToSpeed vs ratio），钉文本会立刻误伤。
 * ============================================================ */
console.log('\n=== 11. 拖拽内核两套实现等价 ===');
{
  let modA = null, modB = null;
  try { modA = await import('./js/drag-reorder.js'); } catch (e) { /* 下面判据失效 */ }
  try {
    const ts3 = await import('typescript');
    const src = read('plugins/project-group/utils/dragSort.ts');
    const out = ts3.transpileModule(src, {
      compilerOptions: { module: ts3.ModuleKind.ESNext, target: ts3.ScriptTarget.ES2020 },
    }).outputText;
    /* data: URL 直接 import，不落临时文件（本文件不该往仓库里写东西） */
    modB = await import('data:text/javascript;base64,' + Buffer.from(out).toString('base64'));
  } catch (e) { /* 下面判据失效 */ }

  t('两侧模块都能加载（判据不能空转）', !!modA && !!modB,
    `A=${!!modA} B=${!!modB}`);

  const NAMES = ['movedEnough', 'clampIndex', 'deadZone',
    'swapIndexWithDeadZone', 'edgeScrollSpeed', 'resolveMoveIndex'];

  /* 固定种子的伪随机 —— 每次跑同一批入参，报红可复现。
     注意必须**每次调用都新建**：若共用一个闭包，前面某函数提前 break
     会吃掉不同数量的随机值，后面函数拿到的入参就跟着漂 ——
     实测踩到：改坏 B 侧 deadZone 后，元断言那条也跟着假红，
     因为它拿到的随机入参变了（正好撞上 A 侧也返回 0 的情况）。 */
  const mkRnd = (seed = 20261012) => {
    let x = seed;
    return () => ((x = (x * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  };
  /** 每个函数的入参生成器（覆盖越界/负值/空列表等边界） */
  const argsOf = (n, rnd) => {
    switch (n) {
      case 'movedEnough': return [{ x: rnd() * 100, y: rnd() * 100 }, rnd() * 100, rnd() * 100, rnd() * 10];
      case 'clampIndex': return [Math.floor(rnd() * 20) - 5, Math.floor(rnd() * 10)];
      case 'deadZone': return [rnd() * 100, rnd() * 20, rnd()];
      case 'swapIndexWithDeadZone': {
        const len = 1 + Math.floor(rnd() * 6);
        const centers = [], sizes = []; let acc = 0;
        for (let i = 0; i < len; i++) { const s = 10 + rnd() * 60; centers.push(acc + s / 2); sizes.push(s); acc += s; }
        return [rnd() * acc, centers, sizes, Math.floor(rnd() * len)];
      }
      case 'edgeScrollSpeed': {
        const top = rnd() * 100, bot = top + rnd() * 400;
        return [top + rnd() * (bot - top), top, bot, 10 + rnd() * 60, 5 + rnd() * 20];
      }
      default: return [Math.floor(rnd() * 8) - 1, Math.floor(rnd() * 8) - 1, Math.floor(rnd() * 8)];
    }
  };
  /** 返回不一致的函数名列表 —— 抽成函数是为了下面做元断言 */
  const mismatches = (a, b, rounds = 800) => {
    const rnd = mkRnd();
    const bad = [];
    for (const n of NAMES) {
      if (typeof a?.[n] !== 'function' || typeof b?.[n] !== 'function') { bad.push(n + '(缺失)'); continue; }
      for (let k = 0; k < rounds; k++) {
        const args = argsOf(n, rnd);
        let ra, rb;
        try { ra = a[n](...args); } catch { ra = 'THROW'; }
        try { rb = b[n](...args); } catch { rb = 'THROW'; }
        if (ra !== rb) { bad.push(n); break; }
      }
    }
    return bad;
  };

  if (modA && modB) {
    const bad = mismatches(modA, modB);
    t('6 个共用函数同入参同输出', bad.length === 0,
      bad.length ? `不一致：${bad.join('、')}` : `实测 ${NAMES.length} 个 × 800 组入参`);
    t('DRAG_THRESHOLD 两侧相同', modA.DRAG_THRESHOLD === modB.DRAG_THRESHOLD,
      `A=${modA.DRAG_THRESHOLD} B=${modB.DRAG_THRESHOLD}`);
    /* B 侧把死区/贴边的默认值写成了字面量默认参数，拿默认调用比一次即可 */
    t('死区默认值等价（8 / .2）',
      modA.deadZone(50) === modB.deadZone(50) && modA.deadZone(0) === modB.deadZone(0),
      `A=${modA.deadZone(50)} B=${modB.deadZone(50)}`);
    t('贴边加速默认值等价（48 / 14）',
      modA.edgeScrollSpeed(10, 0, 400) === modB.edgeScrollSpeed(10, 0, 400),
      `A=${modA.edgeScrollSpeed(10, 0, 400)} B=${modB.edgeScrollSpeed(10, 0, 400)}`);

    /* 元断言：判据失明比数字难看危险得多 ——
       若比较器永远返回空数组，上面四条会一直全绿而毫无保护力。 */
    /* 假实现返回 NaN：NaN 与任何值（含它自己）都不相等，
       所以无论随机入参落在哪，都必然被判为不一致 ——
       用 `() => 0` 不行，A 侧本来就常返回 0（比如指针不在贴边区）。 */
    t('改坏一个函数照样被抓（判据没失明）',
      mismatches(modA, { ...modB, deadZone: () => NaN, edgeScrollSpeed: () => NaN }, 1)
        .sort().join(',') === 'deadZone,edgeScrollSpeed');
    t('完全一致的不算坏（不能误伤）', mismatches(modA, modA, 1).length === 0);
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
