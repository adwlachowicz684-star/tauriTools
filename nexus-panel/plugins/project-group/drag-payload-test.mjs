/**
 * 拖拽载荷解析回归测试（开发用，可删）
 *
 * 起因：CardGrid 的三处 onDrop 都是 `const drag = JSON.parse(raw)`，
 * 而 raw 来自 dataTransfer，可以是**任意文本**（从别的应用拖进来，或人为伪造）：
 * 解析失败会抛异常中断拖拽；解析成功但结构不对（没有 kind / path）更糟 ——
 * `drag.path` 为 undefined，卡片被静默挪到错位置。
 *
 * 思路：直接调 CardGrid.tsx 导出的 parseDragPayload()，也就是三个 onDrop
 * 现在走的那一个函数。这里不另写一份校验逻辑，改了源码就一起变。
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);

/** esbuild 可能在本地 node_modules，也可能只有全局副本（沙盒 / CI），逐个试 */
function resolveEsbuild() {
  for (const c of [process.env.ESBUILD_PATH, 'esbuild',
                   '/data/workspace/.deps/node_modules/esbuild',
                   '/usr/local/lib/node_modules/esbuild'].filter(Boolean)) {
    try { return require.resolve(c); } catch { /* 换下一个候选 */ }
  }
  throw new Error('找不到 esbuild：请先 npm install，或用 ESBUILD_PATH 指定路径');
}
const esbuild = require(resolveEsbuild());

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'components/CardGrid.tsx');
/* 产物落在源码同目录：esbuild 打包 react 时按此位置解析，放 /tmp 会解析到别的副本 */
const OUT = path.join(HERE, '.drag-payload-test.cjs');

await esbuild.build({
  entryPoints: [SRC],
  bundle: true,
  outfile: OUT,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  loader: { '.css': 'empty' },
  logLevel: 'silent',
  /* 只有全局副本时，让 esbuild 也能解析到 react 等依赖（本地装了则优先本地） */
  nodePaths: ['/usr/local/lib/node_modules'],
});

const { parseDragPayload } = await import(pathToFileURL(OUT).href);
fs.rmSync(OUT, { force: true });

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};

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
  const src = fs.readFileSync(SRC, 'utf8');
  // 修复前的写法是 `const drag: DragPayload = JSON.parse(raw)`，三处各自 parse。
  // 现在只允许 parseDragPayload 内部那一处。
  const n = (src.match(/JSON\.parse\(raw\)/g) || []).length;
  t('JSON.parse(raw) 在源码中仅剩 1 处（parseDragPayload 内）', n === 1, `实际 ${n} 处`);
  t('三处 onDrop 均走 parseDragPayload',
    (src.match(/parseDragPayload\(raw\)/g) || []).length === 3);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
