/**
 * OPML 文档名（`<head><title>`）读取测试 —— BUG 193
 * ------------------------------------------------------------
 * 为什么单独成文件而不是塞进 mindmap-test.mjs：
 *   那份已经 1MB，且 import 的是 index.js（要 mock 一堆宿主接口）。
 *   这里验的是 workbook.js 的**纯函数**（只要注入 DOMParser 就能跑），
 *   独立跑更快，也避免"想验个标题却要把整个插件环境搭起来"。
 *
 * 背景（改这里之前务必先读）：
 *   `toOpml` 把画布标题写进 `<head><title>`，导入侧却一律用文件名
 *   （`baseTitle(f.name)`）—— 于是「导出 → 导入」往返一次画布就被改名：
 *   「产品规划」→ 落盘名「产品规划-20261102-1430.opml」→ 导入后叫
 *   「产品规划-20261102-1430」。名字就在文件里，只是没读。
 */
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { opmlHeadTitle } from './workbook.js';
import { toOpml } from './formats.js';

const dom = new JSDOM('<!doctype html><html><body></body>');
globalThis.DOMParser = dom.window.DOMParser;

let pass = 0, fail = 0;
const t = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${detail ? ' → ' + detail : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' → ' + detail : ''}`); }
};

const wrap = (head, body = '<outline text="根"/>') =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n${head}\n<body>${body}</body>\n</opml>`;

console.log('\n=== 1. 基本读取 ===');

t('取到 <head><title>',
  opmlHeadTitle(wrap('<head><title>产品规划</title></head>')) === '产品规划',
  JSON.stringify(opmlHeadTitle(wrap('<head><title>产品规划</title></head>'))));

t('首尾空白要削（画布名不该带缩进空白）',
  opmlHeadTitle(wrap('<head>\n    <title>  项目 A  </title>\n  </head>')) === '项目 A',
  JSON.stringify(opmlHeadTitle(wrap('<head>\n    <title>  项目 A  </title>\n  </head>'))));

t('XML 实体要还原（&amp; 不能原样留着）',
  opmlHeadTitle(wrap('<head><title>甲 &amp; 乙</title></head>')) === '甲 & 乙',
  JSON.stringify(opmlHeadTitle(wrap('<head><title>甲 &amp; 乙</title></head>'))));

console.log('\n=== 2. 取不到时返回空串（让调用方回落文件名） ===');

t('没有 <head> → 空串',
  opmlHeadTitle(wrap('')) === '', JSON.stringify(opmlHeadTitle(wrap(''))));

t('<head> 里没有 <title> → 空串',
  opmlHeadTitle(wrap('<head><ownerName>Nexus</ownerName></head>')) === '',
  JSON.stringify(opmlHeadTitle(wrap('<head><ownerName>Nexus</ownerName></head>'))));

t('<title> 是空的 → 空串',
  opmlHeadTitle(wrap('<head><title></title></head>')) === '',
  JSON.stringify(opmlHeadTitle(wrap('<head><title></title></head>'))));

t('纯空白的 <title> → 空串',
  opmlHeadTitle(wrap('<head><title>   </title></head>')) === '',
  JSON.stringify(opmlHeadTitle(wrap('<head><title>   </title></head>'))));

t('空输入 → 空串', opmlHeadTitle('') === '');

t('坏 XML → 空串（不能抛，导入不该被它拦住）',
  opmlHeadTitle('<opml><head><title>未闭合') === '',
  JSON.stringify(opmlHeadTitle('<opml><head><title>未闭合')));

console.log('\n=== 3. ★ 只认 <head> 里的 <title> ===');

/*
 * OPML 1.0 的 `<outline>` 允许用 `<title>` **子元素**写节点文字。
 * 取"文档里第一个 title"的话，节点的名字会盖掉文档名 —— 那才是更离谱
 * 的误读（画布会叫成某个子节点的名字）。
 */
{
  const doc = wrap('<head><title>文档名</title></head>',
    '<outline><title>节点名</title></outline>');
  t('节点里的 <title> 不抢文档名',
    opmlHeadTitle(doc) === '文档名', JSON.stringify(opmlHeadTitle(doc)));
}
{
  // 反过来：文档没有 title、只有节点的 —— 不该把节点名当文档名
  const doc = wrap('<head><ownerName>x</ownerName></head>',
    '<outline><title>节点名</title></outline>');
  t('无文档名时也不许拿节点名顶替',
    opmlHeadTitle(doc) === '', JSON.stringify(opmlHeadTitle(doc)));
}
{
  /*
   * 连 `<head>` 都没有（OPML 1.0 允许不写 head）时同样不许拿节点名顶替 ——
   * 这条专门守"判据写成 head 缺失就退回整个文档"那种写法：
   * 那时 `head` 是 undefined，一退回 doc 就把节点的 `<title>` 读成文档名了。
   */
  const doc = wrap('', '<outline><title>节点名</title></outline>');
  t('★ 连 <head> 都没有时也不许拿节点名顶替',
    opmlHeadTitle(doc) === '', JSON.stringify(opmlHeadTitle(doc)));
}

console.log('\n=== 4. 本工具自己导出的 OPML 往返 ===');

{
  const content = JSON.stringify({ root: { data: { text: '根', id: 'r' }, children: [] } });
  const out = toOpml(content, '产品规划');
  t('toOpml 写的标题能被读回（往返不改名）',
    opmlHeadTitle(out) === '产品规划', JSON.stringify(opmlHeadTitle(out)));
}
{
  const content = JSON.stringify({ root: { data: { text: '根', id: 'r' }, children: [] } });
  // 标题里带需要转义的字符：写侧转义、读侧还原，两边必须对得上
  const out = toOpml(content, '甲 & 乙 <组>');
  t('带特殊字符的标题往返一致',
    opmlHeadTitle(out) === '甲 & 乙 <组>', JSON.stringify(opmlHeadTitle(out)));
}

console.log('\n=== 5. 源码契约：导入侧真的用了它 ===');

let idx = '';
try {
  idx = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
} catch { /* 读不到就让下面几条失败 */ }

t('导入侧调用了 opmlHeadTitle',
  /wb\.opmlHeadTitle\(text\)/.test(idx), idx ? '已找到调用' : '未读到 index.js');
t('只在 opml 这一种格式上取（别的格式没有这个字段）',
  /if \(kind === 'opml'\)[\s\S]{0,120}wb\.opmlHeadTitle\(text\)/.test(idx));
t('★ 取不到时必须仍是文件名（空串不许当画布名）',
  /if \(docTitle\) one\.title = docTitle;/.test(idx));
t('文件名仍是画布名的默认来源（不能被整段替换掉）',
  /title: fmt\.baseTitle\(f\.name\)/.test(idx));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
