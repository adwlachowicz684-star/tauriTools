/**
 * 拖拽载荷解析回归测试（开发用，可删）
 *
 * 起因：CardGrid 的三处 onDrop 都是 `const drag = JSON.parse(raw)`，
 * 而 raw 来自 dataTransfer，可以是**任意文本**（从别的应用拖进来，或人为伪造）：
 * 解析失败会抛异常中断拖拽；解析成功但结构不对（没有 kind / path）更糟 ——
 * `drag.path` 为 undefined，卡片被静默挪到错位置。
 *
 * 思路：直接调 parseDragPayload()（现在住在 utils/dragSort.ts），也就是三个
 * onDrop 走的那一个函数。这里不另写一份校验逻辑，改了源码就一起变。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'components/CardGrid.tsx');

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

/*
 * 取函数真身：从 utils/dragSort.ts。
 *
 * 这里**曾经**打包 CardGrid.tsx 再 import 出 parseDragPayload（依赖 esbuild）。
 * 后来该函数被抽到 utils/dragSort.ts，CardGrid 只是 import 用、**没有**再导出它，
 * 于是打包产物里没有这个导出 → `parseDragPayload is not a function`。
 *
 * 失效形态值得记一笔：它不是"红几条"，而是**整份测试崩在半路** ——
 * 前面 40 多项断言跑不完、汇总行都不打印。崩 ≠ 红：看着像环境缺依赖，
 * 实际是这整份测试早就不守卫任何东西了。
 * （同类问题在本项目已多次出现：崩在第 12 组、崩在 rmSync、崩在解构空数组。）
 *
 * 改用 testkit 的 loadTs（零依赖类型剥离），与 drag-sort-test 同一套路，
 * 不再依赖 esbuild —— 没装构建工具也能跑。
 */
const ds = await loadTs(path.join(HERE, 'utils/dragSort.ts'));
const parseDragPayload = ds.parseDragPayload;

/* 取不到就**当场判红并停下**，不要往下跑。
   往下跑的下场：第 4 节有一处直接调用（没包在 safely 里），
   于是整份测试崩在半路、汇总行都不打印 —— 崩 ≠ 红，
   看着像"环境缺依赖"，实际是这整份护栏早就没了。 */
if (typeof parseDragPayload !== 'function') {
  fail++;
  console.log('❌ 取不到 parseDragPayload（utils/dragSort.ts 没导出它）—— 不往下跑');
  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(1);
}

/* 测的必须就是 onDrop 用的那一个，而不是碰巧同名的另一份实现：
   光拿到函数不够，CardGrid 得真的从这里 import（第 5 节只数调用，
   数不到"从哪来"）。 */
{
  const cg = fs.readFileSync(SRC, 'utf8');
  t('测的就是 CardGrid 用的那一个（从 utils/dragSort 引入）',
    /import\s*\{[\s\S]{0,200}?\bparseDragPayload\b[\s\S]{0,200}?\}\s*from\s*'\.\.\/utils\/dragSort'/.test(cg) &&
    typeof parseDragPayload === 'function');
}

/** 解析不得抛异常；返回 null 表示拒绝该载荷 */
const safely = (raw) => {
  try {
    return { ok: true, value: parseDragPayload(raw) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
};

console.log('\n=== 1. 合法载荷正常解析 ===');
{
  const r = safely('{"kind":"project","path":"/tmp/a"}');
  t('project 卡片', r.ok && r.value?.kind === 'project' && r.value?.path === '/tmp/a', JSON.stringify(r.value));
  const g = safely('{"kind":"group","path":"C:\\\\work\\\\g"}');
  t('group 卡片（含反斜杠路径）', g.ok && g.value?.kind === 'group', JSON.stringify(g.value));
  t('返回值恰好只有 kind + path 两个字段',
    r.ok && JSON.stringify(Object.keys(r.value).sort()) === '["kind","path"]');
  t('多余字段被丢弃（原型不带进返回值）',
    safely('{"kind":"project","path":"/a","__proto__":{"x":1}}').value?.path === '/a');
}

console.log('\n=== 2. 非 JSON 文本不抛异常（原实现会 throw 并中断拖拽）===');
for (const raw of [
  ['从浏览器地址栏拖来的文本', 'https://example.com'],
  ['从编辑器拖来的代码片段', 'function foo() {'],
  ['普通中文', '这不是 JSON'],
  ['截断的 JSON', '{"kind":"project"'],
  ['只有左括号', '{'],
  ['空对象字符串', '{}'],
  ['空串', ''],
]) {
  const r = safely(raw[1]);
  t(`${raw[0]} → null 且不抛`, r.ok && r.value === null, r.ok ? '' : r.error);
}

console.log('\n=== 3. 是 JSON 但类型不对 ===');
for (const [name, raw] of [
  ['数字', '123'],
  ['字符串', '"project"'],
  ['null', 'null'],
  ['true', 'true'],
  ['数组', '[1,2,3]'],
]) {
  const r = safely(raw);
  t(`${name} → null`, r.ok && r.value === null, r.ok ? '' : r.error);
}
t('undefined → null', parseDragPayload(undefined) === null);
t('null → null', parseDragPayload(null) === null);

console.log('\n=== 4. 结构校验：解析成功但字段不对（原实现会静默错乱）===');
for (const [name, raw] of [
  ['缺 kind', '{"path":"/tmp/a"}'],
  ['kind 是未知值', '{"kind":"folder","path":"/tmp/a"}'],
  ['kind 大小写不符', '{"kind":"Project","path":"/tmp/a"}'],
  ['kind 是数字', '{"kind":1,"path":"/tmp/a"}'],
  ['缺 path', '{"kind":"project"}'],
  ['path 是空串', '{"kind":"project","path":""}'],
  ['path 是数字', '{"kind":"project","path":123}'],
  ['path 是 null', '{"kind":"project","path":null}'],
  ['path 是对象', '{"kind":"project","path":{"a":1}}'],
  ['字段全空', '{}'],
]) {
  const r = safely(raw);
  t(`${name} → null`, r.ok && r.value === null, r.ok ? JSON.stringify(r.value) : r.error);
}

console.log('\n=== 5. 回归护栏：三处 onDrop 不得再有裸 JSON.parse ===');
{
  /* 护栏要盯**解析函数住的地方**：parse* 已搬到 utils/dragSort.ts，
     继续扫 CardGrid 只会数到 0（原来那条 `n > 0` 因此恒假 ——
     一条永远为假又要求为真的断言，等于把护栏拆了还留着牌子）。
     两件事分两处看：解析集中在 dragSort，onDrop 不得自己 parse。 */
  const src = fs.readFileSync(path.join(HERE, 'utils/dragSort.ts'), 'utf8');
  const cg = fs.readFileSync(SRC, 'utf8');
  // 修复前的写法是 `const drag: DragPayload = JSON.parse(raw)`，三处各自 parse。
  // 守的是「onDrop 里不得再有裸解析」，不是「全文件只能有一处 JSON.parse」——
  // 后来页签拖动（专用 MIME x-fpx-tab）带来了自己的载荷结构与 parseTabDrag()，
  // 那一处同样是正规校验。所以按 export function 切段，要求每处解析都在
  // parse* 函数体内；将来再新增 parseXxxDrag 也不会误红。
  const n = (src.match(/JSON\.parse\(raw\)/g) || []).length;
  /* 切段必须把**非 export 的**函数也算进来：共享的 parseJson() 就是内部函数，
     只按 `export function` 切的话它会被算进上一个导出函数的段里 →
     明明是正规解析却被判成"游离"，护栏自己开始误报。 */
  const segs = src.split(/\n(?:export )?function /).slice(1);
  const outside = segs.filter((x) => /JSON\.parse\(raw\)/.test(x) && !/^parse/.test(x)).length;
  t('JSON.parse(raw) 只出现在 parse* 载荷解析函数内', n > 0 && outside === 0,
    `共 ${n} 处，游离 ${outside} 处`);
  t('三处 onDrop 均走 parseDragPayload',
    (cg.match(/parseDragPayload\(raw\)/g) || []).length === 3);
  t('onDrop 处不再有裸 JSON.parse（都交给 parseDragPayload）',
    (cg.match(/JSON\.parse\s*\(/g) || []).length === 0);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
