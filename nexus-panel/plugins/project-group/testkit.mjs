/**
 * 测试公用件（零依赖）
 * ------------------------------------------------------------------
 * 六个测试文件都要"直接吃 .ts 源码"来测真身（不另抄一份清单，抄的那份
 * 改天就与源码脱节）。做法是用一个极简 TS 类型剥离器把 .ts 转成 ESM 再 import，
 * 这样就不需要 esbuild 之类的构建工具 —— 用户不装任何东西也能跑。
 *
 * 剥离器原本在每个测试文件里各复制一份。**抽出来的直接原因**是它出了 bug
 * （处理不了箭头函数返回类型 `(v): number =>`），而修一次要改六个文件 ——
 * 这正是"复制六遍"的代价。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** 本文件所在目录（产物名要按相对它的路径派生） */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * 极简 TS 类型剥离。
 *
 * 只覆盖本项目源码实际用到的写法，**不是通用编译器**。
 * 遇到没覆盖的写法宁可让 import 直接报错（SyntaxError），
 * 也不要静默产出坏代码 —— 静默产出会得到一个"测试全绿但测的是坏代码"的结果。
 */
export function stripTS(src) {
  let s = src;
  /* `import type` 必须整句删掉：它是**纯类型**导入，运行时不存在，
     留着会变成 `import type { X } from '...'` —— 浏览器不认 `type` 关键字，
     直接 SyntaxError（而括号平衡检查抓不到）。 */
  s = s.replace(/^import type [\s\S]*?from\s+'[^']+';\s*\n/gm, '');
  // 类型别名与接口：整块删除
  s = s.replace(/^export type [\s\S]*?;\n/gm, '');
  s = s.replace(/^export interface [\s\S]*?^\}\n/gm, '');
  // 变量声明的类型注解（必须早于参数规则，否则 Record<...> 会被当成参数）
  s = s.replace(/^(\s*)(export )?const (\w+)\s*:\s*[^=\n]*=/gm, '$1$2const $3 =');
  s = s.replace(/:\s*Record<[^<>]*>\s*(?:\|\s*(?:null|undefined)\s*)*/g, '');
  const T = '(?:[A-Z][\\w.]*|string|number|boolean|null|undefined|void|any|unknown|never)';

  /* **内联对象类型注解**：`rect: { left: number; width: number }` 这种
     此前没处理，会原样留下一句 `rect: { left: number, ... }`
     —— import 时 SyntaxError。
     不能误伤对象**值**（`{ left: r.left, width: r.width }`），
     区分办法是看冒号后是不是类型关键字：`r.left` 不是，`number` 是。 */
  {
    /* 元素类型要允许 `string[]` / `Record<...>` 之类：
       只认裸关键字的话 `{ items: string[] }` 会漏过去，
       import 时同样 SyntaxError。方括号与尖括号都要算进类型里。 */
    const BASE = '(?:[A-Z][\\w.]*|string|number|boolean|null|undefined|void|any|unknown|never)';
    const TYPE = BASE + '(?:\\[\\]|\\s*<[^<>]*>)?';
    const F = '\\s*\\w+\\??\\s*:\\s*(?:' + TYPE + ')';
    const re = new RegExp('(\\b\\w+)\\??\\s*:\\s*\\{' + F + '(?:[;,]' + F + ')*[;,]?\\s*\\}(?:\\[\\])?', 'g');
    s = s.replace(re, '$1');
  }
  /* **三元的冒号不能被当成类型注解**：
     `x ? A : B` 里的 `A : B` 会命中上面这条规则，被删成 `A`，
     产出 `x ? A` —— import 时 SyntaxError。

     区分办法：往回看，若在同一个表达式里先遇到 `?` 才遇到 `(` `{` `;` 或换行，
     说明这个冒号是三元的分支符，不是类型注解。 */
  s = s.replace(
    new RegExp('(\\b\\w+)\\s*:\\s*' + T + '[\\w.\\[\\]| ]*?(?=\\s*[,)])', 'g'),
    (m, name, offset, whole) => {
      const before = whole.slice(0, offset);
      const q = before.lastIndexOf('?');
      const stop = Math.max(
        before.lastIndexOf('('), before.lastIndexOf('{'),
        before.lastIndexOf(';'), before.lastIndexOf('\n'),
        before.lastIndexOf('='),
      );
      // `?` 出现在这些分隔符之后 → 它是三元的一部分
      return q > stop ? m : name;
    },
  );
  s = s.replace(/\s*\w+>\s*(?=\))/g, '');
  /* 只剥**单个** `|`（类型联合），绝不能碰到 `||`（逻辑或）：
     `Math.round(n) || 0` 会被剥成 `Math.round(n) |` ——
     多出一个竖线，import 时 SyntaxError。
     用前后断言排除 `||`。 */
  s = s.replace(/\s*(?<!\|)\|(?!\|)\s*[\w.]+\s*(?=\))/g, '');
  // 箭头函数返回类型 `(v): number =>` —— 必须早于下面的 `{` 规则，
  // 否则会被当成对象类型。这是抽成本文件时要修的那个 bug。
  s = s.replace(/\)\s*:\s*[^{=>\n]*=>/g, ') =>');
  // 函数返回值类型：对象类型 `{...}[]` 先处理，再处理普通类型
  /* **对象类型 + 联合**：`): { a: boolean } | null {`
     下面两条都吃不下（一个要求紧跟 `{`，一个不许含 `{`），
     漏过去就会剩下 `| null {` —— import 时 SyntaxError。 */
  s = s.replace(/\)\s*:\s*\{[^{}\n]*\}\s*(?:\|\s*[\w.]+\s*)*\{/g, ') {');
  s = s.replace(/\)\s*:\s*\{[^{}\n]*\}\s*(?:\[\])?\s*\{/g, ') {');
  s = s.replace(/\)\s*:\s*[^{\n]*\{/g, ') {');
  // 泛型实例化 new Map<string, X>() → new Map()
  s = s.replace(/new (\w+)<[^<>]*>\(/g, 'new $1(');
  s = s.replace(/\s+as\s+[\w.\[\]<>|]+/g, '');
  s = s.replace(/\breadonly\s+/g, '');
  return s;
}

/**
 * 把 .ts 源码当 ESM 加载，返回其导出。
 * 产物写在系统临时目录、文件名带 pid：既不进仓库也不与别的进程互相干扰。
 *
 * **相对 import 会一并处理**：源码里的 `from './hotkeys'` 在产物里指向
 * /tmp，直接 import 会找不到。所以先把被依赖的模块也生成到同一目录，
 * 再把 import 路径改写成绝对 file:// URL（递归，依赖的依赖也能带走）。
 */
export async function loadTs(tsPath) {
  const out = await emit(tsPath, new Set());
  return await import(pathToFileURL(out).href);
}

/** 生成一份可直接 import 的产物，返回其路径（依赖递归生成到同目录） */
async function emit(tsPath, seen) {
  /* 产物名必须按**完整路径**派生，不能只用 basename：
     本插件有 `utils/color.ts`（转发）与 `color-picker/color.ts`（真身），
     basename 都是 `color` —— 后者会把前者的产物覆盖掉，
     而前者内容恰好是 `export * from` 后者，于是变成自我引用、导出全空。
     表现是 "does not provide an export named 'isDark'"，
     很难想到是文件名撞了。 */
  const rel = path.relative(path.join(HERE, '..'), tsPath).replace(/[^\w.-]/g, '_');
  const name = rel.replace(/\.tsx?$/, '');
  const out = path.join(os.tmpdir(), `.ts-${name}.${process.pid}.mjs`);
  if (seen.has(out)) return out;
  seen.add(out);

  let code = stripTS(fs.readFileSync(tsPath, 'utf8'));
  // 相对 import → 先递归生成依赖，再改写成绝对 URL
  const dir = path.dirname(tsPath);
  /* 同时支持 './x' 与 '../x'：utils/ 下的模块引用 ../types 是常态，
     只认 './' 的话这类模块根本测不了 —— 产物在 /tmp 下，'../types' 会指到别处。 */
  const refs = [...code.matchAll(/from\s+'(\.\.?\/[^']+)'/g)].map((m) => m[1]);
  for (const ref of refs) {
    const dep = await emit(path.join(dir, `${ref}.ts`), seen);
    code = code.split(`from '${ref}'`).join(`from '${pathToFileURL(dep).href}'`);
  }
  fs.writeFileSync(out, code);
  return out;
}

/**
 * 切出「连同上方的文档注释」的一段源码：从锚点往上回溯到注释块起点，
 * 一直切到 endAt 为止。
 *
 * **为什么要有它**：断言"注释里写了某句话"时，从 `fn xxx` 起切会把
 * 写在函数**上方**的文档注释整个切掉，断言于是**静默失败** ——
 * 不是报错，而是永远匹配不到、永远绿。这个坑我在三个测试里踩了三次。
 *
 * 兼容两种注释：块注释（/** 开头）与连续的行注释（/// 开头），
 * 取离锚点更近的那个（更可能是本函数的注释）。
 * 距离超过 3000 字符的注释视为无关（多半是上一个函数的），不采纳。
 */
export function sliceWithDoc(src, anchor, endAt) {
  const i = src.indexOf(anchor);
  if (i < 0) return '';
  const j = src.indexOf(endAt, i);
  if (j < 0) return src.slice(i);

  const up = src.slice(0, i);
  // 候选一：块注释 /** … */
  const block = up.lastIndexOf('/**');
  // 候选二：连续的 /// 行注释块（往上逐行退到块首）
  let lineDoc = -1;
  const lines = up.split('\n');
  let k = lines.length - 1;
  while (k >= 0 && lines[k].trim() === '') k--;
  if (k >= 0 && lines[k].trim().startsWith('///')) {
    while (k >= 0 && lines[k].trim().startsWith('///')) k--;
    lineDoc = lines.slice(0, k + 1).join('\n').length + 1;
  }
  let start = Math.max(block, lineDoc);
  if (start < 0 || i - start > 3000) start = i;
  return src.slice(start, j);
}

/** 极简断言器：统计并打印，最后 process.exit(fail ? 1 : 0) */
export function makeT() {
  const st = { pass: 0, fail: 0 };
  const t = (name, cond, extra = '') => {
    cond ? st.pass++ : st.fail++;
    console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
  };
  const done = () => {
    console.log(`\n通过 ${st.pass} 项，失败 ${st.fail} 项`);
    process.exit(st.fail ? 1 : 0);
  };
  return { t, done };
}
