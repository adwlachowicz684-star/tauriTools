/**
 * d.ts → 运行时 兑现测试
 * ============================================================
 * 为什么要这个测试
 * ------------------------------------------------------------
 * 现有 `dts-drift-test.mjs` 查的是 **TSX → d.ts** 这一个方向
 * （TSX import 了、而 d.ts 没声明 → tsc 会红，它替人提前发现）。
 * **反方向此前没有一道守卫**：
 *
 *   d.ts 声明了 `export declare const rescanAll`，
 *   而 `js/external-policy.js` 里**根本没有这个导出** ——
 *   它是外壳在挂 `window.__NEXUS__.external` 时注入的（js/shell.js、
 *   src/App.tsx 各有同名同形的一份）。
 *
 * 后果是那类最难查的漂移，与 plugin-config.d.ts 里被清掉的
 * `adaptTheme` / `shouldAdaptTheme` 完全同形（那里的注释写得明白）：
 *
 *   · `import { rescanAll } from '../js/external-policy.js'`
 *     —— **类型检查顺利通过**（d.ts 白纸黑字声明了）；
 *   · 运行时拿到 `undefined`，调用即崩；
 *   · 比"两边都没有"更难查：自动补全给得出来、跳转能跳到声明，
 *     只有真跑起来才发现是空的。
 *
 * dts-drift 查不到它（没人 import 就不报），ctx-contract 也查不到
 * （那个只管 PluginContext 的字段，不管模块导出）。
 *
 * 判据：d.ts 里 `export … function|const|class` 的每个名字，
 * 对应 .js 里必须有同名导出（`export … X` 或 `export { X }`）。
 *
 * 刻意只做"值导出"这一个方向
 * ------------------------------------------------------------
 * `export interface` / `export type` **不验**：类型是编译期概念，
 * 运行时本来就不存在，验了就是全量误报。
 * 反方向（js 有导出、d.ts 没声明）也**不验**：本项目 d.ts 是
 * **有意裁剪**的公开面（host.d.ts 手写 178 行，js 里还有几十个
 * 内部导出刻意不声明），按"实现有的都必须声明"扫会一片误报 ——
 * 而**误报的下场是守卫被删**，那比没有守卫更糟。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const p = (rel) => join(HERE, rel);

let pass = 0, fail = 0, skip = 0, note = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const info = (name, extra = '') => { note++; console.log(`ℹ️ ${name}${extra ? ' → ' + extra : ''}`); };

/** 剥注释：注释里若留着 `export …` 字样会被当成真声明（本项目真发生过） */
function stripComments(src) {
  let out = '', i = 0;
  while (i < src.length) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      i = e < 0 ? src.length : e + 2;
      out += '\n';
      continue;
    }
    if (src[i] === '/' && src[i + 1] === '/') {
      const e = src.indexOf('\n', i);
      i = e < 0 ? src.length : e;
      continue;
    }
    out += src[i++];
  }
  return out;
}

const DECL_RE = /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

function declaredNames(dtsText) {
  return [...stripComments(dtsText).matchAll(DECL_RE)].map((m) => m[1]);
}

function exportedNames(jsText) {
  const names = new Set();
  const clean = stripComments(jsText);
  for (const m of clean.matchAll(/^\s*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of clean.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      // `A as B` → 对外名字是 B
      const nm = part.trim().split(/\s+as\s+/).pop().trim();
      if (nm) names.add(nm);
    }
  }
  return names;
}

const PAIRS = [
  ['js/host.d.ts', 'js/host.js'],
  ['js/plugin-sdk.d.ts', 'js/plugin-sdk.js'],
  ['js/plugin-config.d.ts', 'js/plugin-config.js'],
  ['js/external-policy.d.ts', 'js/external-policy.js'],
  ['js/tauri-core.d.ts', 'js/tauri-core.js'],
];

/* ============================================================
   1. 元断言：判据必须真的解析出东西
   —— 少了这一节，把 DECL_RE 改坏（或 PAIRS 写空）时，
      第 2 节的循环一次都不执行，而"没有一条失败"会让报告全绿。
      正是本项目反复撞的"判据空转而报告全绿"。
   ============================================================ */
console.log('=== 1. 判据自检（解析不出东西 = 空转，必须判失败）===');

const hostDts = readFileSync(p('js/host.d.ts'), 'utf8');
const hostNames = declaredNames(hostDts);
t('host.d.ts 解析出声明（≥10 个）', hostNames.length >= 10, `${hostNames.length} 个`);
t('判据认得出 saveCloseAction（防空转）', hostNames.includes('saveCloseAction'));
t('剥注释生效：注释里的字样不算声明',
  !hostNames.includes('THIS_IS_ONLY_IN_A_COMMENT'));

console.log('\n=== 2. 每个 d.ts 声明 → 对应 .js 真导出 ===');
const missing = [];
for (const [dtsRel, jsRel] of PAIRS) {
  if (!existsSync(p(dtsRel)) || !existsSync(p(jsRel))) {
    skip++;
    t(`文件齐备：${dtsRel}`, false, '缺失');
    continue;
  }
  const decl = declaredNames(readFileSync(p(dtsRel), 'utf8'));
  const exp = exportedNames(readFileSync(p(jsRel), 'utf8'));
  const miss = decl.filter((n) => !exp.has(n));
  t(`${dtsRel} → ${jsRel}（${decl.length} 条声明全部兑现）`, miss.length === 0,
    miss.length ? `未导出: ${miss.join(', ')}` : '');
  for (const m of miss) missing.push(`${dtsRel}:${m}`);
}
t('汇总：无"类型说有、运行时没有"', missing.length === 0, missing.join(' | '));

/* ============================================================
   3. 判据反向自检（防判据失明）
   —— 拿一份"声明了但 js 没导出"的合成样本喂给同一套判据，
      必须报得出。少了这一节，判据改成恒通过也照样绿。
      样本走内存，不落盘、不改真实文件。
   ============================================================ */
console.log('\n=== 3. 判据反向自检（合成样本，判据必须抓得住）===');
{
  const fakeDts = `
export function realOne(a: string): void;
/** export function onlyInComment(): void; */
export const ghostFn: () => void;
export interface SomeType { a: number }
`;
  const fakeJs = `
export function realOne(a) { return a; }
export const other = 1;
`;
  const decl = declaredNames(fakeDts);
  const exp = exportedNames(fakeJs);
  const miss = decl.filter((n) => !exp.has(n));
  t('合成样本：抓得出 ghostFn（声明了但没导出）', miss.includes('ghostFn'), miss.join(','));
  t('合成样本：不误报 realOne（真导出了的）', !miss.includes('realOne'));
  t('合成样本：interface 不当值导出（SomeType 不在声明表里）', !decl.includes('SomeType'));
  t('合成样本：注释里的 export 不算声明（onlyInComment 不在表里）',
    !decl.includes('onlyInComment'));
}

/* ============================================================
   4. 已知的分层：外壳注入项不在本模块声明（告知）
   —— 这三个曾经错写在 external-policy.d.ts 里，现已移到
      src/global.d.ts 的 `typeof extPolicy & { … }`。
      这里钉住"它们确实不在本模块"，防止有人照旧写法补回来。
   ============================================================ */
console.log('\n=== 4. 外壳注入项不在模块 d.ts 里声明（防补回来）===');
{
  const extDts = readFileSync(p('js/external-policy.d.ts'), 'utf8');
  const decl = declaredNames(extDts);
  const injected = ['rescanAll', 'scanPlugin', 'setRefreshHandler'];
  for (const n of injected) {
    t(`external-policy.d.ts 不再声明 ${n}`, !decl.includes(n));
  }
  const globalDts = existsSync(p('src/global.d.ts'))
    ? readFileSync(p('src/global.d.ts'), 'utf8') : '';
  t('三个注入项在 src/global.d.ts 有声明（不是凭空删掉）',
    injected.every((n) => globalDts.includes(n)),
    injected.filter((n) => !globalDts.includes(n)).join(', ') || '都有');
  info('注入项的真正声明处', 'src/global.d.ts 的 `typeof extPolicy & { … }`');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项，跳过 ${skip} 项，告知 ${note} 条`);
process.exit(fail ? 1 : 0);
