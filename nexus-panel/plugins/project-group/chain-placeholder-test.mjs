/**
 * 连锁模板占位符回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/chain-placeholder-test.mjs，然后
 *         node plugins/project-group/chain-placeholder-test.mjs
 *
 * 钉住 #501 最容易腐化的一处：**界面能插入的** 与 **后端会替换的** 必须一一对应。
 * 早先这两者是分开写的（界面一句提示文字、后端 fill_all 里逐个 replace），
 * 加一个占位符要改两处，漏改后端就会出现"按钮插进去、发出去却是原样花括号"。
 *
 * 另外覆盖插入函数的光标行为：有选中时替换选中、插入后光标位置正确。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');

const stripTS = (src) => {
  let s = src;
  s = s.replace(/^export type [\s\S]*?;\n/gm, '');
  s = s.replace(/^export interface [\s\S]*?^\}\n/gm, '');
  s = s.replace(/^(\s*)(export )?const (\w+)\s*:\s*[^=\n]*=/gm, '$1$2const $3 =');
  s = s.replace(/:\s*Record<[^<>]*>\s*(?:\|\s*(?:null|undefined)\s*)*/g, '');
  const T = '(?:[A-Z][\\w.]*|string|number|boolean|null|undefined|void|any|unknown|never)';
  s = s.replace(new RegExp('(\\b\\w+)\\s*:\\s*' + T + '[\\w.\\[\\]| ]*?(?=\\s*[,)])', 'g'), '$1');
  s = s.replace(/\s*\w+>\s*(?=\))/g, '');
  s = s.replace(/\s*\|\s*[\w.]+\s*(?=\))/g, '');
  s = s.replace(/\)\s*:\s*\{[^{}\n]*\}\s*(?:\[\])?\s*\{/g, ') {');
  s = s.replace(/\)\s*:\s*[^{\n]*\{/g, ') {');
  s = s.replace(/new (\w+)<[^<>]*>\(/g, 'new $1(');
  s = s.replace(/\s+as\s+[\w.\[\]<>|]+/g, '');
  s = s.replace(/\breadonly\s+/g, '');
  return s;
};

const P = await loadTs(path.join(HERE, 'utils/placeholders.ts'));
const { t, done } = makeT();

const { PLACEHOLDERS, GROUP_TITLE, GROUP_ORDER, placeholdersByGroup, insertAtCursor } = P;

console.log('\n=== 1. 清单本身 ===');
/* #45 补齐原版最后两个（{路径} / {文件夹名}）后是 9 个：
   本插件 2 个 + 原版兼容 4 个 + 工具 3 个 */
t('共 9 个占位符', PLACEHOLDERS.length === 9, `${PLACEHOLDERS.length} 个`);
t('token 无重复', new Set(PLACEHOLDERS.map((p) => p.token)).size === PLACEHOLDERS.length);
t('token 都带花括号', PLACEHOLDERS.every((p) => /^\{.+\}$/.test(p.token)));
t('每条都有说明', PLACEHOLDERS.every((p) => p.hint && p.label));
t('group 取值合法',
  PLACEHOLDERS.every((p) => ['own', 'legacy', 'tool'].includes(p.group)));

console.log('\n=== 2. 分组渲染 ===');
const grouped = placeholdersByGroup();
t('分成三组', grouped.length === 3, grouped.map((g) => g.group).join('/'));
t('分组后不丢不重',
  grouped.reduce((n, g) => n + g.items.length, 0) === PLACEHOLDERS.length);
t('每组都有标题', grouped.every((g) => GROUP_TITLE[g.group]));
t('组序 own→legacy→tool', GROUP_ORDER.join(',') === 'own,legacy,tool');

console.log('\n=== 3. 与后端 fill_all 一一对应（核心护栏）===');
const rsPath = path.join(ROOT, 'src-tauri/src/fpx/chain.rs');
if (!fs.existsSync(rsPath)) {
  console.log('（跳过：未找到 chain.rs）');
} else {
  const rs = fs.readFileSync(rsPath, 'utf8');
  // 抓 fill_all 里所有 .replace("{...}" 的字面量
  const body = rs.slice(rs.indexOf('pub fn fill_all'));
  const replaced = new Set(
    [...body.matchAll(/\.replace\("(\{[^"]+\})"/g)].map((m) => m[1]),
  );
  const declared = new Set(PLACEHOLDERS.map((p) => p.token));

  const notInBackend = [...declared].filter((x) => !replaced.has(x));
  const notInFrontend = [...replaced].filter((x) => !declared.has(x));

  t('界面能插的，后端都会替换', notInBackend.length === 0,
    notInBackend.join(' ') || '无');
  t('后端会替换的，界面都列了出来', notInFrontend.length === 0,
    notInFrontend.join(' ') || '无');
  t('后端替换数量与清单一致', replaced.size === declared.size,
    `后端 ${replaced.size} / 前端 ${declared.size}`);
  t('{工具文件名} 在后端替换为宿主名', /\{工具文件名\}",\s*"nexus-panel"/.test(body));

  /*
   * fill_all 是一串顺序敏感的 replace：**若某个 token 是另一个的子串，
   * 先替换短的会把长的拆坏**（例如有 `{路径}` 与 `{项目路径}` 时，
   * 前者若在后者之前替换且互为子串，长 token 就被截掉一半）。
   *
   * 现在这 9 个互不为子串，所以顺序安全。但**以后每加一个都要重查** ——
   * 这类 bug 的表现是"某个占位符没被替换、原样发给 AI"，没有任何报错，
   * 只会让 AI 收到一句带花括号的话。
   */
  const toks = [...replaced];
  const clashes = toks.flatMap((a) => toks.filter((b) => b !== a && a.includes(b)).map((b) => `${b} ⊂ ${a}`));
  t('占位符互不为子串（顺序安全）', clashes.length === 0, clashes.join(' / ') || '无');

  /* #45：原版那两个与既有的是同值别名，hint 里要写清，
     否则用户以为有区别、挑错也看不出发错了什么 */
  const alias = PLACEHOLDERS.filter((p) => ['{路径}', '{文件夹名}'].includes(p.token));
  t('两个新占位符都在清单里', alias.length === 2);
  t('说明里点明同值', alias.every((p) => /同值/.test(p.hint)));
}

console.log('\n=== 4. 插入行为：光标处插入 ===');
{
  const r = insertAtCursor('AB', 1, 1, '{path}');
  t('中间插入', r.next === 'A{path}B', r.next);
  t('光标停在插入内容之后', r.caret === 1 + '{path}'.length, String(r.caret));
}
{
  const r = insertAtCursor('AB', 0, 0, '{name}');
  t('行首插入', r.next === '{name}AB' && r.caret === 6, r.next);
}
{
  const r = insertAtCursor('AB', 2, 2, '{name}');
  t('行尾插入', r.next === 'AB{name}' && r.caret === 8, r.next);
}

console.log('\n=== 5. 插入行为：有选中时替换选中 ===');
{
  const r = insertAtCursor('hello world', 0, 5, '{path}');
  t('替换选中部分', r.next === '{path} world', r.next);
  t('光标位置正确', r.caret === 6, String(r.caret));
}
{
  // 选中"world"，应被替换而不是插在它前面
  const r = insertAtCursor('hello world', 6, 11, '{name}');
  t('替换末尾选中段', r.next === 'hello {name}', r.next);
}

console.log('\n=== 6. 边界与异常输入 ===');
{
  const r = insertAtCursor('', 0, 0, '{path}');
  t('空文本插入', r.next === '{path}' && r.caret === 6, r.next);
}
{
  // 光标位置为 null（元素未聚焦）→ 当作行尾
  const r = insertAtCursor('AB', null, null, '{path}');
  t('无光标信息时插到末尾', r.next === 'AB{path}', r.next);
  t('末尾插入的光标位置', r.caret === 8, String(r.caret));
}
{
  // 越界下标要夹回来，不能产生 undefined
  const r = insertAtCursor('AB', 99, 99, '{path}');
  t('越界起点夹到末尾', r.next === 'AB{path}', r.next);
  t('越界时无 undefined', !r.next.includes('undefined'), r.next);
}
{
  const r = insertAtCursor('AB', -5, -5, '{path}');
  t('负数起点夹到 0', r.next === '{path}AB', r.next);
}
{
  // end < start（反选）不应产生负长度切片
  const r = insertAtCursor('ABCD', 3, 1, '{path}');
  t('反选区间按 start 处理', !r.next.includes('undefined'), r.next);
}

done();
