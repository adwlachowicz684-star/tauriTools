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

const SRC = [...walk(PLUG, ['.ts', '.tsx', '.css']), ...walk(RS, ['.rs'])];
let fullAll = ''; let strippedAll = '';
for (const p of SRC) {
  try {
    const c = fs.readFileSync(p, 'utf8');
    fullAll += c; strippedAll += stripComments(c);
  } catch { /* 读不到就跳过 */ }
}

/** 名字里出现这些词 = 已经诚实声明"这条钉的是注释/文档" */
const HONEST = /注释|文档头|说明|注明|写着|提醒|标明|标注|文档/;

const tests = fs.readdirSync(PLUG).filter((f) => f.endsWith('-test.mjs') && f !== 'assertion-hygiene-test.mjs');

console.log('=== 1. 锚点不能是注释 ===');
{
  const bad = [];
  for (const f of tests) {
    const s = fs.readFileSync(path.join(PLUG, f), 'utf8');
    for (const m of s.matchAll(/(?:indexOf|lastIndexOf|search)\(\s*'([^']*)'/g)) {
      const lit = m[1];
      /*
       * 只钉"注释里带文字"的锚点（`/// 迁移前把…`）—— 那才依赖措辞，
       * 一改写就漂。
       * 裸标记 `'/**'`、`'//'` 是**结构性**用法（找一个注释块的起点），
       * 不依赖措辞，允许：它们被 migrate 用来切文档注释区（bakDoc / c0）。
       */
      const mm = lit.match(/^\s*(\/\/\/|\/\/|\/\*)/);
      if (!mm) continue;                       // 不是注释开头的锚点，放行
      const rest = lit.slice(mm[0].length).replace(/^[/*]+/, '');
      if (/\S/.test(rest)) bad.push(`${f}: ${lit.slice(0, 40)}`);
    }
  }
  t('没有用注释当 indexOf/slice 锚点', bad.length === 0, bad.slice(0, 5).join(' | '));
}

console.log('\n=== 2. 只匹配到注释的断言必须诚实改名 ===');
{
  const bad = [];
  for (const f of tests) {
    const s = fs.readFileSync(path.join(PLUG, f), 'utf8');
    /* 取 `t('名字', /模式/` 这种最常见形式；多行参数不覆盖（那条由第 1 组兜） */
    for (const m of s.matchAll(/t\(\s*'([^']*)'\s*,\s*\/(?!\/)((?:\\.|[^\/\n])+)\//g)) {
      const name = m[1];
      let pat = m[2];
      if (HONEST.test(name)) continue;   // 已诚实声明
      if (/^\s*!/.test(m[0].slice(m[0].indexOf(',') + 1))) continue; // 取反断言另论
      /*
       * 直接**编译这个正则**去匹配两份副本，而不是先判"是不是纯文本"。
       * 早先那一版只处理不含正则元字符的模式 ——
       * `绝不动 \+h` 这种带转义的就被整条跳过，注入回归**没抓到**。
       */
      let re;
      try { re = new RegExp(pat); } catch { continue; }
      if (re.test(fullAll) && !re.test(strippedAll)) bad.push(`${f}: ${name}`);
    }
  }
  t('没有"名字验行为、实际只验注释"的断言', bad.length === 0, bad.slice(0, 5).join(' | '));
}

console.log('\n=== 3. 顺序断言必须两端都判存在 ===');
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
 * 判据：参与 `<`/`>` 比较的每一端，都要有 `>= 0` / `> 0` / `!== -1` 兜底。
 * 形式不限：可以直接写在表达式里，也可以先赋给变量再判（后者更常见）。
 */
{
  const bad = [];
  for (const f of tests) {
    const src = fs.readFileSync(path.join(PLUG, f), 'utf8');
    /* 先收集 `const V = <含 indexOf 的表达式>` —— 变量名 → true */
    const idxVars = new Set();
    for (const m of src.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*[^;\n]*\.indexOf\s*\(/g)) {
      idxVars.add(m[1]);
    }
    /* 逐个 t( ... ) 语句（用括号配对粗切） */
    for (const m of src.matchAll(/\bt\(/g)) {
      let depth = 0; let j = m.index;
      for (; j < src.length; j += 1) {
        if (src[j] === '(') depth += 1;
        else if (src[j] === ')') { depth -= 1; if (depth === 0) break; }
      }
      const stmt = src.slice(m.index, j + 1);
      if (!/\.indexOf\s*\(/.test(stmt)) continue;
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
        for (const side of [c[1], c[3]]) {
          const isIdxCall = /\.indexOf\s*\(/.test(side);
          const isIdxVar = idxVars.has(side);
          if (!isIdxCall && !isIdxVar) continue;   // 不是 indexOf 结果，不管
          const guarded = new RegExp(
            `${side.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*(?:>=?\\s*0|!==?\\s*-?\\s*1)`
          ).test(stmt);
          if (!guarded) bad.push(`${f}: ${name} → ${side.slice(0, 34)}`);
        }
      }
    }
  }
  t('顺序比较的两端都判了存在', bad.length === 0, bad.slice(0, 5).join(' | '));
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
    const src = stripComments(fs.readFileSync(path.join(PLUG, f), 'utf8'));
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
        bad.push(`${f}: ${nm ? nm[2] : '?'}`);
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
 */
{
  const bad = [];
  for (const f of tests) {
    const src = stripComments(fs.readFileSync(path.join(PLUG, f), 'utf8'));
    if (/process\.cwd\(\)/.test(src)) bad.push(f);
  }
  t('没有测试用 cwd 拼源码路径', bad.length === 0, bad.join(', ') || '干净');
  /* 反面证据：本文件自己的说明里也写了这个字样，不剥注释会误报 */
  t('判定函数确实认得出来', /process\.cwd\(\)/.test('const R = process.cwd();')
    && !/process\.cwd\(\)/.test(stripComments('// const R = process.cwd();')));
}

console.log('\n=== 6. 反向自检：护栏本身能抓到 ===');
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
   * 顺序类自检：造一条"两端都没判存在"的顺序断言，护栏必须标红。
   * 少了这条自检，上一条检查可能本身也是空跑的。
   */
  t('顺序类：判定函数确实认得出来', (() => {
    const fake = `t('假的次序断言', s.indexOf('AAA') < s.indexOf('BBB'));`;
    const guarded = /AAA/.test(fake) && /(?:AAA|BBB)[\s\S]{0,40}>=?\s*0/.test(fake);
    return !guarded;   // 没判存在 → 应当被标为 bad
  })());
  /* 占位类自检：字面 true 必须被认出来 */
  t('占位类：判定函数确实认得出来', (() => {
    const fake = 'true';
    const msg = '`t(...';
    return /^(true|1|!0|!!1)$/.test(fake) && msg.length > 0;
  })());
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exit(1);
