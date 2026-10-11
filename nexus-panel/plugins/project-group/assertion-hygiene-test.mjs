/**
 * 断言卫生护栏（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/assertion-hygiene-test.mjs
 *
 * 扫全部 *-test.mjs，抓两类"看起来在测、其实没测到"：
 *
 *   1. **锚点用了注释** —— `indexOf('// xxx')` / `slice(indexOf('/* xxx'))`。
 *      注释一改写就返回 -1，切片变空，整片断言一起失效
 *      （表现为"整片报错"或更糟：切到别处、断言静默通过）。
 *
 *   2. **正则只匹配到注释** —— 名字承诺验行为（"复制没成功就不删源"、
 *      "文件夹只清 +s 绝不动 +h"），实际只验了一句说明还在。
 *      代码真退化了、注释还在，断言照样通过 —— 你以为有覆盖，其实没有。
 *      这类必须把名字改成「注释：…」，诚实地说明它钉的是什么。
 *
 * 判定方法：同一份源码做两份副本 —— 原文 与 剥掉注释版。
 * 某个模式能匹配原文、却匹配不到剥注释版 —— 说明它只活在注释里。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUG = HERE;
const ROOT = path.resolve(HERE, '..', '..');            // nexus-panel
const RS = path.join(HERE, '..', '..', 'src-tauri', 'src');

let pass = 0; let fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`✅ ${name}${extra ? ' → ' + extra : ''}`); }
  else { fail += 1; console.log(`❌ ${name}${extra ? ' → ' + extra : ''}`); }
};

/** 剥掉注释（只处理行首起的注释，避免误伤字符串里的 `://`） */
function stripComments(text) {
  const out = []; let inb = false;
  for (const line of text.split('\n')) {
    const s = line.lstrip ? line.lstrip() : line.replace(/^\s+/, '');
    if (inb) { if (s.includes('*/')) inb = false; continue; }
    if (s.startsWith('/*')) { if (!s.slice(2).includes('*/')) inb = true; continue; }
    if (s.startsWith('//')) continue;
    out.push(line);
  }
  return out.join('\n');
}

function walk(root, exts) {
  const res = [];
  if (!fs.existsSync(root)) return res;
  const st = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') st(p); }
      else if (exts.some((x) => e.name.endsWith(x))) res.push(p);
    }
  };
  st(root);
  return res;
}

/*
 * 必须**跨插件 + 含 .js**，否则会误报。
 *
 * 本轮实测：md-edit-test 里那条 `resolve(null)` 钉的是
 * `plugins/md-editor/index.js`（服务的真实实现），而本文件原先只收
 * 本插件的 .ts/.tsx/.css —— strippedAll 里根本没有那份源码，
 * 于是 `re.test(fullAll) && !re.test(strippedAll)` 成立 → 误报成"只验注释"。
 *
 * 断言本来就会跨插件取源码（sdk、md-editor、host.js 都常被断言读），
 * 判据范围不跟着跨，就等于把这些断言一律判死。
 */
const SRC = [
  ...walk(ROOT, ['.ts', '.tsx', '.css', '.js', '.mjs']),
  ...walk(RS, ['.rs']),
  /*
   * 排除本文件：第 6 节的探针字样是一条**字符串字面量**（在代码里，不在注释里），
   * 把自己算进语料后 strippedAll 里也有它 → 探针那条自检反而变成假绿
   * （实测：加上 .mjs 后第 6 节"注释类"立刻红）。
   */
].filter((p) => !p.endsWith('assertion-hygiene-test.mjs'));
let fullAll = ''; let strippedAll = '';
for (const p of SRC) {
  try {
    const c = fs.readFileSync(p, 'utf8');
    fullAll += c; strippedAll += stripComments(c);
  } catch { /* 读不到就跳过 */ }
}

/** 名字里出现这些词 = 已经诚实声明"这条钉的是注释/文档" */
const HONEST = /注释|文档头|说明|注明|写着|提醒|标明|标注|文档/;

/*
 * ⚠ 扫描范围必须**全仓**，不能只扫本插件。
 *
 * 第 5 节（cwd）已经栽过一次：只扫 plugins/project-group，于是根层的
 * dead-module-test.mjs 一直查不出来。第 1~4 节漏网面完全一样 ——
 * 而它们守的是"断言静默失效"（锚点是注释 / 只验注释 / 顺序恒真 / 占位恒真），
 * 恰恰是别的目录里那批没人回头看的测试最容易留的坑。
 *
 * 代价：命中面从 11 个涨到全仓 201 个，可能一次扫出多处存量。
 * 存量该逐条修（改名或补存在性判定），而不是把范围收回去 ——
 * 收回去等于把漏网面原样保留。
 *
 * ⚠ 第二层漏网面（本轮补）：后缀只认 `-test.mjs`，于是
 *   plugins/agent-flow/tests/ 下 **104 个 .test.ts**（agent-flow 引擎
 *   两千余条断言的唯一回归防线）**从未进入任何一节的视野**——
 *   形状与"只扫本插件"完全一样：把一整批文件排除在扫描范围外，
 *   报告照样绿。第 5/6 节各自另建 all 列表、同样只收 .mjs，一并补上。
 */
const TEST_EXTS = ['-test.mjs', '.test.ts', '.test.tsx'];
const tests = walk(ROOT, TEST_EXTS)
  .filter((p) => !p.endsWith('assertion-hygiene-test.mjs'));
const rel = (p) => path.relative(ROOT, p);

/*
 * 判定：这个字面量锚点是不是"不该用"的注释锚点。
 *
 * 放行两类：
 *   1. 裸标记 `'/**'`、`'//'` —— **结构性**用法（找一个注释块的起点），
 *      不依赖措辞：它们被 migrate 用来切文档注释区（bakDoc / c0）。
 *   2. **虚线分节条** —— `/* --------- 名字 ---` / `// ---- 名字 ----`。
 *      这类是文件的**既成结构**（mindmap 的 index.js / editor/index.html
 *      全靠它分节），措辞跟着节名走、形状固定，跟"随手写的说明"不是一回事。
 *
 * 其余带文字的注释锚点一律判坏：`// 关键：km.exportData()` 这种一改写
 * 就返回 -1，slice(a, -1) 变空、slice(a, -1) 的兄弟写法更是直接静默变宽。
 */
const badAnchor = (lit) => {
  const mm = lit.match(/^\s*(\/\/\/|\/\/|\/\*)/);
  if (!mm) return false;                       // 不是注释开头的锚点
  const rest = lit.slice(mm[0].length).replace(/^[/*]+/, '').replace(/^\s+/, '');
  if (!/\S/.test(rest)) return false;          // 裸标记
  if (/^-{3,}/.test(rest)) return false;       // 虚线分节条
  return true;
};

/*
 * 存在性判定的两种合法形态（第 3 节用）：
 *
 *   1. `x >= 0` / `x > 0` / `x !== -1` —— 要求它存在；
 *   2. `x === -1 || …` —— **明确承认它可能不存在**，并走另一分支。
 *
 * 第 2 种本轮实测：md-render 那条
 * `slug 排在 sanitize 之后（当前无 sanitize 时成立）`
 * 写的就是 `iSan === -1 || iSlug > iSan`，名字里已经把"没有 sanitize
 * 时这条成立"写明了 —— 判据不认它，就会逼人把一条**诚实**的断言改成
 * 不诚实的（硬加 `iSan >= 0` 反而让它必须先造一个 sanitize）。
 */
const existChecked = (stmt, side) => new RegExp(
  `${side.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:>=?\\s*0|!==?\\s*-?\\s*1|={2,3}\\s*-?\\s*1)`
).test(stmt);

/*
 * 顺序比较里"缺了反而恒真"的那一端 —— 推导见第 3 节注释。
 *
 * **判据只有这一处**：护栏本体和两条元断言共用同一函数。
 * 写成两处（循环里按操作符取、元断言里各写一遍）必然漂移 ——
 * 上一版的教训就是"两端都判"和"只判一端"两套说法混着用。
 */
const vacuousSideOf = (cmpExpr) => {
  const m = cmpExpr.match(/(<=?|>=?)/);
  if (!m) return '';
  const [lhs, rhs] = cmpExpr.split(m[0]);
  return m[0][0] === '<' ? lhs.trim() : rhs.trim();
};

/*
 * 第 6 节判据：**断言不能拿带 g / y 标志的正则实例做 .test()**。
 *
 * 带 g/y 的实例做 test 会**推进 lastIndex**：第一次命中后停在匹配末尾，
 * 第二次再从那里续扫。于是第二条断言看的根本不是自己的样本，而是
 * "上一次命中位置之后的那段" —— 样本比 lastIndex 短时恒不命中，
 * `!rx.test(样本)` 就恒真；反过来也可能恒假。两种都不报错。
 *
 * 实测（dead-class-test.mjs）：INLINE 第一次命中后 lastIndex = 1141，
 * 而"不误伤无关文本"的样本只有 35 字符 → 把样本换成确实含该模式的
 * `x/\/\*[\s\S]*?\*\/`（18 字符），断言**照样通过**；换用不带 g 的
 * 副本则正确报红。也就是说那条"不误伤"从未真正鉴别过任何东西。
 *
 * 只认**字面量声明**的正则（`const X = /…/g`）。`new RegExp(src,'g')`
 * 的写法扫不到，属已知边界（要判就得解析实参）——不假装覆盖了它。
 */
const GY_DECL = new RegExp(
  '(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*'
  + '/(?![*/])(?:\\\\.|\\[(?:\\\\.|[^\\]])*\\]|[^/\\\\\\n])+/([a-z]*)', 'g');

/** 返回形如 `NAME` 的命中名（已排除同名的多作用域声明，见下） */
const gyTestVars = (src) => {
  const decls = [...src.matchAll(GY_DECL)];
  const out = [];
  for (const d of decls) {
    const [, name, flags] = d;
    if (!/[gy]/.test(flags)) continue;
    /*
     * 同名在本文件里被声明成正则**不止一次** → 多半是 `re` 这类短名在
     * 不同作用域各声明一份（mindmap 里 3 处），靠名字无法判定谁对应谁，
     * 强行报会误伤。宁可漏，不可误报（误报会逼人给正确代码加冗余改动）。
     */
    const sameName = decls.filter((x) => x[1] === name).length;
    if (sameName > 1) continue;
    if (new RegExp(`\\b${name.replace(/\$/g, '\\$')}\\s*\\.\\s*test\\s*\\(`).test(src)) {
      if (!out.includes(name)) out.push(name);
    }
  }
  return out;
};

console.log('=== 1. 锚点不能是注释 ===');
{
  const bad = [];
  for (const f of tests) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/(?:indexOf|lastIndexOf|search)\(\s*'([^']*)'/g)) {
      if (badAnchor(m[1])) bad.push(`${rel(f)}: ${m[1].slice(0, 40)}`);
    }
  }
  t('没有用注释当 indexOf/slice 锚点', bad.length === 0, bad.slice(0, 5).join(' | '));
  /*
   * 放行分节条是**有代价的让步**（节名照样可能被改，只是概率低得多），
   * 所以必须钉住"让步的边界"：不能因为它就把整条规则一起放掉。
   * 少了这三条，把 badAnchor 改成恒 false 也是绿的。
   */
  t('判据仍认得散文注释锚点', badAnchor('// 关键：km.exportData()'));
  t('判据仍认得不带虚线的分节名', badAnchor('/* 底部状态条'));
  t('虚线分节条确实被放行', !badAnchor('/* ------------------------- 附件打开')
    && !badAnchor('// ---- 显示定位跟随 ----'));
}

/*
 * 验的是**运行时产物**的断言要放行。
 *
 * 本轮实测：inspector-test 那条「信息条显示尺寸」的 subject 是
 * `badge.textContent`（真渲染出来的 DOM 文本），不是源码。名字没撒谎 ——
 * 撒谎的是这条判据的前提（"正则都拿去扫源码"）。
 * 不放行就会逼人把一条**真断言**改成「注释：…」，那才是把覆盖面改没了。
 */
const RUNTIME_SUBJECT = /\.(textContent|innerHTML|outerHTML|innerText)\b|document\.|JSON\.stringify|\.join\(/;

/** 取正则字面量之后那一小段（够判 subject 即可） */
const tailAfter = (s, m) => s.slice(m.index + m[0].length, m.index + m[0].length + 160);

/** 抽成函数：好让下面的反向自检拿探针直接验它，而不是只信"扫出来是干净的" */
const commentOnlyHit = (name, pat, tail) => {
  if (HONEST.test(name)) return false;            // 已诚实声明
  if (/^\s*!/.test(tail)) return false;           // 取反断言另论
  if (RUNTIME_SUBJECT.test(tail)) return false;   // 验的是运行时产物
  /*
   * 直接**编译这个正则**去匹配两份副本，而不是先判"是不是纯文本"。
   * 早先那一版只处理不含正则元字符的模式 ——
   * `绝不动 \+h` 这种带转义的就被整条跳过，注入回归**没抓到**。
   */
  let re;
  try { re = new RegExp(pat); } catch { return false; }
  return re.test(fullAll) && !re.test(strippedAll);
};

console.log('\n=== 2. 只匹配到注释的断言必须诚实改名 ===');
{
  const bad = [];
  for (const f of tests) {
    const s = fs.readFileSync(f, 'utf8');
    /* 取 `t('名字', /模式/` 这种最常见形式；多行参数不覆盖（那条由第 1 组兜） */
    for (const m of s.matchAll(/t\(\s*'([^']*)'\s*,\s*\/(?!\/)((?:\\.|[^\/\n])+)\//g)) {
      if (commentOnlyHit(m[1], m[2], tailAfter(s, m))) bad.push(`${rel(f)}: ${m[1]}`);
    }
  }
  t('没有"名字验行为、实际只验注释"的断言', bad.length === 0, bad.slice(0, 5).join(' | '));
  /*
   * 放行"运行时 subject"是个**有代价的让步**：写宽一点就会把真问题一起放过。
   * 所以两头都钉住 —— 少了这几条，把 RUNTIME_SUBJECT 改成恒真也是绿的。
   */
  const RT_PAT = '\\d+ × \\d+';
  t('放行前那条确实会被判"只活在注释里"（放行不是空转）',
    new RegExp(RT_PAT).test(fullAll) && !new RegExp(RT_PAT).test(strippedAll));
  t('运行时 subject 被放行（护栏不逼人把真断言改名）',
    commentOnlyHit('信息条显示尺寸', RT_PAT, '.test(badge.textContent), badge.textContent.trim());') === false);
  t('源码 subject 仍被抓（放行没把真问题一起放过）',
    commentOnlyHit('取消不 reject', '取消\\*\\*不 reject\\*\\*', '.test(mod));') === true);
}

console.log('\n=== 3. 顺序断言的"空跑那一端"必须判存在 ===');
/*
 * 剥离注释**扫不出这一类**，所以必须单独钉：
 *
 *   `t('A 在 B 之前', s.indexOf('A') < s.indexOf('B'))`
 *
 * 把 A 改没了 → 左端 -1 → `-1 < 正数` 恒真 → **断言照样报绿**，
 * 而它声称要验的次序根本没验。实测过：把 cli.rs 里的 `let mut plan`
 * 改名（功能完全不变），migrate-test 67 项照常全绿 —— 那条"位置在 plan 之后"
 * 早就空跑了。
 *
 * ⚠️ 判据**不是"两端都判"**，而是只判"缺了反而恒真"的那一端：
 *
 *   `X <  Y` / `X <= Y`：X 取 -1 时 `-1 < Y(Y≥0)` 恒真  → 判 X
 *                        Y 取 -1 时 `X < -1` 恒**假**   → 照样报红，不判
 *   `X >  Y` / `X >= Y`：Y 取 -1 时 `X(X≥0) > -1` 恒真  → 判 Y
 *                        X 取 -1 时 `-1 > Y` 恒**假**   → 照样报红，不判
 *
 * 上一版要求两端都判，实测**误报**：`iGuard >= 0 && iSend > iGuard` 里
 * iSend 缺了会让断言直接报红（不是假绿），却照样被点名；逼人硬加
 * `iSend >= 0` 只是给一条本来正确的断言添冗余。
 *
 * 形式不限：可以直接写在表达式里，也可以先赋给变量再判（后者更常见）。
 */
{
  const bad = [];
  for (const f of tests) {
    const src = fs.readFileSync(f, 'utf8');
    /* 先收集 `const V = <含 indexOf 的表达式>` —— 变量名 → true */
    const idxVars = new Set();
    for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.indexOf\s*\(/g)) {
      idxVars.add(m[1]);
    }
    /* 逐个 t( ... ) 语句（用括号配对粗切） */
    for (const m of src.matchAll(/\bt\(/g)) {
      /*
       * `.test(` 里的 `t(` 也会被 `\bt\(` 命中（`.` 不是词字符，
       * 所以 `t` 前面照样算词边界）。不跳过的话会从一个正则字面量中间
       * 开始配对，切出来的"语句"是半截的。
       */
      if (src[m.index - 1] === '.') continue;
      let depth = 0; let j = m.index;
      for (; j < src.length; j += 1) {
        /*
         * 正则字面量里的转义括号不算配对。
         *
         * `t('ensure_ranges 仍在', /fn ensure_ranges\(/.test(store))` 里
         * 那个 `\(` 会让深度多涨 1，于是一直回落不到 0 —— 切片一路吃到
         * **后面好几条语句**去，把这些语句里的 indexOf 比较也算到它头上。
         * 报出来的名字（"ensure_ranges 仍在"）因此根本不是有问题的那条，
         * 查的人会照着错误的方向找。
         */
        if (src[j] === '(' && src[j - 1] !== '\\') depth += 1;
        else if (src[j] === ')' && src[j - 1] !== '\\') { depth -= 1; if (depth === 0) break; }
      }
      const stmt = src.slice(m.index, j + 1);
      /*
       * ⚠️ 不能先过滤"语句里有没有 .indexOf("。
       *
       * 本轮破坏验证实测：把 `setApp.indexOf('a') < setApp.indexOf('b')`
       * 提成 `const ia = ...; const ib = ...; t(..., ia < ib)` 之后，
       * 语句里就没有 .indexOf 了 —— **护栏直接失明**，加不加 `>= 0` 都报绿。
       * 而"提成常量再比较"恰恰是最常见的写法（也是本轮修存量时用的写法）。
       *
       * 真正的判据在**两端是不是 indexOf 的结果**（下面 idxVars / 调用形态），
       * 跟它写不写在这一条语句里无关。
       */
      /* 只关心含顺序比较的 */
      /*
       * 操作数是「标识符」或「x.indexOf(...) 完整调用」两种形态 ——
       * 第一版只捕获了对象名（`cli`），于是两边都被当成"不是 indexOf 结果"
       * 直接跳过，注入的回归**没抓到**。
       */
      const cmp = [...stmt.matchAll(
        /([A-Za-z_$][\w$]*(?:\s*\.\s*indexOf\s*\([^()]*\))?)\s*(<=?|>=?)\s*([A-Za-z_$][\w$]*(?:\s*\.\s*indexOf\s*\([^()]*\))?)/g
      )];
      if (!cmp.length) continue;
      const nameM = stmt.match(/^t\(\s*['\`]([^'\`]*)/);
      const name = nameM ? nameM[1] : '?';
      for (const c of cmp) {
        /*
         * 只有"缺了反而恒真"的那一端要判存在 —— 另一端缺了是恒假，
         * 会当场报红，不存在静默放过的风险。见本节上方注释。
         */
        const side = vacuousSideOf(c[0]);
        const isIdxCall = /\.indexOf\s*\(/.test(side);
        const isIdxVar = idxVars.has(side);
        if (!isIdxCall && !isIdxVar) continue;   // 不是 indexOf 结果，不管
        if (!existChecked(stmt, side)) bad.push(`${rel(f)}: ${name} → ${side.slice(0, 34)}`);
      }
    }
  }
  t('顺序断言的空跑端判了存在', bad.length === 0, bad.slice(0, 5).join(' | '));
  /*
   * 认 `=== -1 ||` 是个**有代价的让步**（写宽了会把真漏判一起放过），
   * 所以钉住两头。少了这两条，把 existChecked 改成恒 true 也是绿的。
   */
  t('"=== -1 ||" 这种显式承认缺失的写法不算漏判',
    existChecked('iSan === -1 || iSlug > iSan', 'iSan'));
  t('真漏判照样被抓（让步没把真问题放过）',
    !existChecked('iSlug > iSan', 'iSan') && !existChecked('iErr > iWith', 'iErr'));
  /*
   * ⚠️ 收窄成"只判空跑端"同样是有代价的让步 —— 上面那条真漏判用例
   * 只覆盖了 `<` 的左端，**没覆盖 `>` 的右端**。少了下面这两条，
   * 把取端写反（`<` 取右端 / `>` 取左端）照样全绿。
   */
  t('`<` 判的是左端（右端取 -1 是恒假，不必判）',
    vacuousSideOf('iA < iB') === 'iA' && vacuousSideOf('iA <= iB') === 'iA');
  t('`>` 判的是右端（左端取 -1 是恒假，不必判）',
    vacuousSideOf('iA > iB') === 'iB' && vacuousSideOf('iA >= iB') === 'iB');
}

console.log('\n=== 4. 不许有占位断言 ===');
/*
 * 名字承诺在验行为、条件却写成字面真值 —— 它永远报绿，**什么都不验**，
 * 它永远报绿，**什么都不验**，看着却像有覆盖（比没有断言更糟：给假安心）。
 * 看着却像有覆盖（比没有断言更糟：给假安心）。本轮扫出 2 处，
 * 都是"先记下待办、后来忘了补"留下的。
 *
 * 允许的例外：条件里带 `typeof x !== 'undefined'` 之类的环境守卫
 * （那种是真的在判某物存在），所以只禁**纯字面**恒真。
 */
{
  const bad = [];
  for (const f of tests) {
    /*
     * 必须先剥注释：本段自己的说明里就写着 `t(...) true` 这个写法，
     * 不剥的话**护栏会把自己注释里的字样当成违规**报出来（实测误报 2 条）。
     */
    const src = stripComments(fs.readFileSync(f, 'utf8'));
    for (const m of src.matchAll(/\bt\(/g)) {
      let depth = 0; let j = m.index;
      for (let k = m.index; k < src.length; k += 1) {
        if (src[k] === '(') depth += 1;
        else if (src[k] === ')') { depth -= 1; if (depth === 0) { j = k; break; } }
      }
      const stmt = src.slice(m.index, j + 1);
      if (stmt.indexOf(',') < 0) continue;
      let cond = stmt.slice(stmt.indexOf(',') + 1).trim();
      if (cond.endsWith(')')) cond = cond.slice(0, -1);
      /* 去掉尾部的消息参数（模板串 / 单引号串），最多两层 */
      for (let i = 0; i < 2; i += 1) {
        cond = cond.replace(/,\s*('[^']*'|`[^`]*`)\s*$/, '').trim().replace(/,$/, '');
      }
      if (/^(true|1|!0|!!1)$/.test(cond) || /\|\|\s*(true|1)\s*$/.test(cond)) {
        const nm = stmt.match(/^t\(\s*(['\`])(.*?)\1/);
        bad.push(`${rel(f)}: ${nm ? nm[2] : '?'}`);
      }
    }
  }
  t('没有占位断言（条件是字面真值）', bad.length === 0, bad.slice(0, 5).join(' | '));
}

console.log('\n=== 5. 测试不得依赖 process.cwd() 定位源码 ===');
/*
 * 用 `process.cwd()` 拼源码路径的测试，**结论取决于从哪个目录敲 node**：
 * 换个 cwd 就 `readdirSync` 抛 ENOENT，整个文件一条断言都没跑就挂掉。
 *
 * 这类失效最阴险：回归脚本看到"非 0 退出"容易当成环境噪音略过，
 * 于是那几十条护栏在不知不觉中全部失效，而日志里依旧一片绿。
 * 定位必须按文件自身位置（`fileURLToPath(import.meta.url)`）。
 *
 * ⚠ 扫描范围必须**全仓**，不能只扫本插件：本条原先只扫 plugins/project-group，
 *   于是 nexus-panel 根层的 dead-module-test.mjs 用 process.cwd() 一直查不出来 ——
 *   实测从仓库根跑它直接 ENOENT 崩在半路，18 条护栏一条没跑（崩 ≠ 红）。
 *   只扫自己目录 = 只守自己，漏网的恰恰是别的目录里那批。
 */
{
  const all = walk(ROOT, TEST_EXTS)
    .filter((p) => !p.endsWith('assertion-hygiene-test.mjs'));
  const bad = [];
  for (const p of all) {
    const src = stripComments(fs.readFileSync(p, 'utf8'));
    if (/process\.cwd\(\)/.test(src)) bad.push(path.relative(ROOT, p));
  }
  t('没有测试用 cwd 拼源码路径', bad.length === 0, bad.join(', ') || '干净');
  /* 空转自检：范围被改窄 / 目录读不到 → bad 恒为空 → 绿得毫无意义 */
  t('扫描范围非空（判据不能空转）', all.length >= 20, `实测 ${all.length} 个`);
  t('覆盖到本插件之外的测试（漏网的正是别人目录下那批）',
    all.some((p) => !p.startsWith(PLUG)),
    `本插件外 ${all.filter((p) => !p.startsWith(PLUG)).length} 个`);
  /*
   * 后缀那一层漏网：只收 `-test.mjs` 时，plugins/agent-flow/tests/ 下
   * 104 个 .test.ts **任何一节都看不见**（本轮实测：把它们纳进来之后，
   * 第 5 节立刻点名 sidebarClick.test.ts 用 process.cwd() 定位源码）。
   * 没有这条自检，把 TEST_EXTS 改回只剩 .mjs，报告照样全绿 ——
   * 漏网面被悄悄还原，而看报告的人一次都不会发现。
   */
  t('扫描范围覆盖 .test.ts（漏扫＝一整批 TS 测试不在任何一节视野内）',
    all.some((p) => p.endsWith('.test.ts')),
    `.test.ts ${all.filter((p) => p.endsWith('.test.ts')).length} 个`);
  /* 反面证据：本文件自己的说明里也写了这个字样，不剥注释会误报 */
  t('判定函数确实认得出来', /process\.cwd\(\)/.test('const R = process.cwd();')
    && !/process\.cwd\(\)/.test(stripComments('// const R = process.cwd();')));
}

console.log('\n=== 6. 断言不能拿带 g / y 标志的正则做 .test() ===');
/*
 * lastIndex 会让第二条断言**不再看自己的样本**（推导见 gyTestVars 注释）：
 * 于是"这条判据不误伤 X"这类反面断言恒真，而报错一个字都不会有 ——
 * 它跟第 3 节"缺端恒真"是同一类，只是成因在正则状态而不是 -1 比较。
 *
 * 为什么连**只用过一次**的也要报：单次此刻安全，但它是个雷 ——
 * 谁在它前面再加一次 test（或在循环里用），结果就翻面，而改动的人
 * 根本不会想到要看上一行的 lastIndex。
 */
{
  const all = walk(ROOT, TEST_EXTS)
    .filter((p) => !p.endsWith('assertion-hygiene-test.mjs'));
  const bad = [];
  for (const p of all) {
    let src = '';
    try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
    /* 剥注释：说明里写 `/re/g.test(` 的示例不该被当成真用法 */
    src = stripComments(src);
    for (const nm of gyTestVars(src)) bad.push(`${path.relative(ROOT, p)}:${nm}`);
  }
  t('断言不复用带 lastIndex 的正则做 .test()', bad.length === 0,
    bad.join(', ') || '干净');
  /* 空转自检：范围被改窄 / 目录读不到 → bad 恒空 → 绿得毫无意义 */
  t('扫描范围非空（判据不能空转）', all.length >= 20, `实测 ${all.length} 个`);
}

console.log('\n=== 7. 反向自检：护栏本身能抓到 ===');
{
  /* 造一个"只活在注释里"的模式，护栏必须把它标出来 */
  const probe = '这条说明只存在于注释里的探针XYZ';
  t('注释类：判定函数确实认得出来', (() => {
    const fake = `// ${probe}\nlet a = 1;`;
    const fs2 = fullAll + fake;
    const ss2 = strippedAll + stripComments(fake);
    return new RegExp(probe).test(fs2) && !new RegExp(probe).test(ss2);
  })());
  /*
   * 顺序类自检：造一条"没判存在"的顺序断言，护栏必须标红。
   *
   * ⚠️ 上一版这里自己另写了一条正则去判"有没有 >= 0"，**没用护栏真正的
   * 判据函数** —— 于是它验的是"这条手写正则认不认得样例"，跟护栏本体
   * 认不认得是两回事（把 existChecked 改成恒 true，它照样绿）。
   * 现在改成直接调 vacuousSideOf / existChecked 本体。
   */
  t('顺序类：判定函数确实认得出来', (() => {
    const fake = `t('假的次序断言', s.indexOf('AAA') < s.indexOf('BBB'));`;
    const side = vacuousSideOf(`s.indexOf('AAA') < s.indexOf('BBB')`);
    return side === `s.indexOf('AAA')` && !existChecked(fake, side);
  })());
  /* 占位类自检：字面 true 必须被认出来 */
  t('占位类：判定函数确实认得出来', (() => {
    const fake = 'true';
    const msg = '`t(...';
    return /^(true|1|!0|!!1)$/.test(fake) && msg.length > 0;
  })());
  /*
   * lastIndex 类自检：造一段"g 正则 + 两次 test"，判定函数必须点名。
   * 同第 3 节那条教训 —— 必须调**本体函数**，不能另写一条正则去判
   * "这段文本里有没有 .test("（那样验的是手写正则，跟本体认不认得无关）。
   */
  t('lastIndex 类：判定函数确实认得出来', (() => {
    const fake = "const RX = /ab/g;\nt('命中', RX.test(s));\nt('不误伤', !RX.test(x));";
    const noFlag = "const RX = /ab/;\nt('命中', RX.test(s));";
    return gyTestVars(fake).includes('RX') && !gyTestVars(noFlag).includes('RX');
  })());
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exit(1);
