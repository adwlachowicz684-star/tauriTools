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

console.log('\n=== 3. 反向自检：护栏本身能抓到 ===');
{
  /* 造一个"只活在注释里"的模式，护栏必须把它标出来 */
  const probe = '这条说明只存在于注释里的探针XYZ';
  t('判定函数确实认得出来', (() => {
    const fake = `// ${probe}\nlet a = 1;`;
    const fs2 = fullAll + fake;
    const ss2 = strippedAll + stripComments(fake);
    return new RegExp(probe).test(fs2) && !new RegExp(probe).test(ss2);
  })());
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exit(1);
