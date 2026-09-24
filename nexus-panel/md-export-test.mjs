/**
 * md F9 —— 导出
 * ============================================================
 * 纯逻辑（plugins/md/export.js）真跑；组件与后端接线用源码断言钉住。
 *
 * 运行：node md-export-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const t = (n, ok, extra = '') => {
  if (ok) { pass++; console.log(`✅ ${n}`); }
  else { fail++; console.log(`❌ ${n}${extra ? '  → ' + extra : ''}`); }
};

const {
  EXPORT_EXTS, exportPathOf, checkExportPath, buildExportHtml, escapeHtml, BASE_CSS,
} = await import('./plugins/md/export.js');

const app = read('plugins/md/App.tsx');
const caps = read('js/command-caps.js');
const policy = read('js/invoke-policy.js');
const rust = read('src-tauri/src/fpx/mod.rs');
const mainRs = read('src-tauri/src/main.rs');
const css = read('css/neumorphism.css');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const appC = strip(app);

/* ============================================================
   1. 目标路径
   ============================================================ */
console.log('\n=== 1. 目标路径 ===');

t('完整路径 → 同目录 .html', exportPathOf('D:/docs/a.md', 'html') === 'D:/docs/a.html',
  exportPathOf('D:/docs/a.md', 'html'));
t('完整路径 → 同目录 .md', exportPathOf('D:/docs/a.html', 'md') === 'D:/docs/a.md');
t('反斜杠路径同样能推（Windows）',
  exportPathOf('D:\\docs\\a.md', 'html') === 'D:/docs/a.html',
  exportPathOf('D:\\docs\\a.md', 'html'));
t('无扩展名的源文件', exportPathOf('D:/docs/README', 'html') === 'D:/docs/README.html');
t('多点文件名只去最后一段', exportPathOf('D:/docs/a.b.md', 'html') === 'D:/docs/a.b.html');
t('空路径 → 空（不能瞎挑目录）', exportPathOf('', 'html') === '');
t('相对路径也能推（不带目录）', exportPathOf('a.md', 'html') === 'a.html');

/* ============================================================
   2. 前端预判（与后端白名单同口径）
   ============================================================ */
console.log('\n=== 2. 扩展名校验（与 Rust 白名单同口径）===');

t('.html 放行', checkExportPath('a.html').ok);
t('.md 放行', checkExportPath('a.md').ok);
t('.txt 放行', checkExportPath('a.txt').ok);
t('.markdown 放行', checkExportPath('a.markdown').ok);
t('.exe 拒绝', !checkExportPath('a.exe').ok);
t('.bat 拒绝', !checkExportPath('a.bat').ok);
t('无扩展名拒绝', !checkExportPath('a').ok);
t('拒绝时**带原因**（只说失败＝用户不知道为什么）',
  !!checkExportPath('a.exe').why, JSON.stringify(checkExportPath('a.exe')));

/* 前端白名单必须与 Rust 侧一致，否则会出现"前端放行、后端拒绝" */
/*
 * 取 fpx_export_text 的**函数体**再断言。
 *
 * 直接在全文里用 `fpx_export_text[\s\S]*?ensure_path_in` 匹配是假绿：
 * `*` 会一路跨到后面任意函数（fpx_edit_file 里也有 ensure_path_in），
 * 于是删掉本函数的收口，断言照样绿 —— 实测就是这个结果。
 * 下面每条 Rust 断言都限定在函数体内。
 */
const rustFn = (rust.match(/pub fn fpx_export_text[\s\S]*?(?=\npub fn |\npub\(crate\) fn |$)/) || [''])[0];
t('能取到 fpx_export_text 函数体（否则下面全是假绿）', rustFn.length > 200, String(rustFn.length));

const rustExts = (rustFn.match(/matches!\(ext\.as_str\(\),\s*([^)]*)\)/) || [])[1] || '';
const rustList = (rustExts.match(/"[a-z]+"/g) || []).map((x) => x.replace(/"/g, ''));
t('前后端扩展名白名单**一致**（不一致＝前端放行后端拒）',
  rustList.length > 0 && rustList.every((e) => EXPORT_EXTS.includes(e)) &&
  EXPORT_EXTS.every((e) => rustList.includes(e)),
  `rust=${JSON.stringify(rustList)} js=${JSON.stringify(EXPORT_EXTS)}`);

/* ============================================================
   3. 导出的 HTML 必须自包含
   ============================================================ */
console.log('\n=== 3. 自包含 HTML ===');

const html = buildExportHtml({
  title: '我的文档',
  bodyHtml: '<h1>标题</h1><p>正文</p>',
  vars: { '--bg': '#101014', '--text': '#e8e8e8' },
});

t('含 DOCTYPE', html.startsWith('<!DOCTYPE html>'));
t('含 charset=utf-8（不含则中文乱码）', /<meta charset="utf-8">/.test(html));
/*
 * 不能只断言 <style> 标签存在：
 *   把 BASE_CSS 去掉后标签还在（只是空的），断言照样绿 ——
 *   而导出文件正是没样式的。所以断言**标签里有实际规则**。
 */
const styleBlock = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
t('含 <style> 且**里面有实际规则**（空样式＝外部打开没样式）',
  /\.markdown-body/.test(styleBlock) && styleBlock.length > 200, String(styleBlock.length));
t('正文被包进 .markdown-body', /<div class="markdown-body">\s*<h1>标题/.test(html));
t('标题进 <title>', /<title>我的文档<\/title>/.test(html));
t('主题变量**真的写进去了**（不写死色板）', /--bg: #101014;/.test(html));
t('基础样式里有表格边框（裸 HTML 没样式就没边框）',
  /\.markdown-body th,\s*\.markdown-body td\s*\{[\s\S]{0,120}?border:/.test(BASE_CSS));
t('基础样式里有代码块背景', /\.markdown-body pre \{[\s\S]{0,200}?background:/.test(BASE_CSS));
t('基础样式里有 mermaid svg 限宽', /\.md-mm svg \{/.test(BASE_CSS));

/* 兜底色：主题变量读不到时不能变成黑底黑字 */
const noVars = buildExportHtml({ title: 'x', bodyHtml: '', vars: {} });
t('无变量时有兜底色（否则导出文件可能是黑底黑字）', /--md-bg: #ffffff;/.test(noVars));

/* title 来自文件名，可能含尖括号 */
t('title 被转义（文件名含 < 不会破坏 head）',
  /<title>a&lt;b&lt;<\/title>/.test(buildExportHtml({ title: 'a<b<', bodyHtml: '', vars: {} })));
t('escapeHtml 处理 &', escapeHtml('a&b') === 'a&amp;b');

/* 变量值注入防护 */
const evil = buildExportHtml({ title: 'x', bodyHtml: '', vars: { '--bg': 'red;} </style><script>x</script>' } });
t('变量值含 </style> 时不会提前闭合 style（被过滤）',
  !/<script>/.test(evil.split('<style>')[1]?.split('</style>')[0] || ''),
  '→ 变量值注入到了 style 里');

/* ============================================================
   4. 后端接线
   ============================================================ */
console.log('\n=== 4. 后端接线 ===');

t('Rust 里有 fpx_export_text', /pub fn fpx_export_text/.test(rust));
t('已注册进 generate_handler（漏了＝静默失效）',
  /fpx::fpx_export_text/.test(mainRs));
t('有 ensure_path_in 收口（不收口＝任意路径写）',
  /ensure_path_in\(&dir, &cfg, &path\)\?/.test(rustFn));
t('有扩展名白名单（少了＝可在允许目录里写 .exe）',
  /只允许导出 html/.test(rustFn));
t('默认不覆盖（覆盖＝丢用户数据，必须显式要求）',
  /p\.exists\(\) && !overwrite\.unwrap_or\(false\)/.test(rustFn));
t('会创建父目录（否则导出到新目录必失败）',
  /create_dir_all/.test(rustFn));
t('command-caps 里定级为 W', /fpx_export_text: 'W'/.test(caps));

/* ============================================================
   5. 前端接线
   ============================================================ */
console.log('\n=== 5. 前端接线 ===');

t('md 白名单含 fpx_export_text',
  /md: \[[^\]]*'fpx_export_text'/.test(policy));
t('md 白名单含 fpx_open_path（打开所在目录）',
  /md: \[[^\]]*'fpx_open_path'/.test(policy));
t('导出调 fpx_export_text', /invoke\('fpx_export_text'/.test(appC));
t('传 overwrite: true（同一文档反复导出必然覆盖，否则第二次就报已存在）',
  /overwrite: true/.test(appC));
t('打开目录用 mode: dir —— auto 在 Windows 上对 .exe 就是执行',
  /invoke\('fpx_open_path', \{ path: exportTo, mode: 'dir' \}/.test(appC));
t('**没有** mode: auto（那是任意执行通道）',
  !/fpx_open_path[\s\S]{0,120}mode: 'auto'/.test(appC));
t('无源路径时按钮禁用而不是隐藏（隐藏＝以为漏做了）',
  /disabled=\{!srcPath \|\| exporting\}/.test(appC));
t('禁用时 title 说明原因（拖入拿不到路径）',
  /拖入的文档拿不到磁盘路径/.test(appC));
t('导出失败显示后端原因（多数是"目录未授权"，用户能自己解决）',
  /setHint\(`导出失败：/.test(appC));
t('HTML 导出从 DOM 取 innerHTML（拿到的是含已画好 Mermaid 的那一版）',
  /el\.innerHTML/.test(appC));
t('MD 导出用 src（不是渲染结果）',
  /if \(kind === 'md'\) \{\s*text = src;/.test(appC));
t('拖入/手改时清空 srcPath（否则会写到上一个文件的目录）',
  (appC.match(/setSrcPath\(''\);/g) || []).length >= 2,
  String((appC.match(/setSrcPath\(''\);/g) || []).length));

t('CSS 有 .md-export', /\.md-export \{/.test(css));
t('CSS 有 disabled 态（不给反馈＝点了没反应且不知为何）',
  /\.md-export \.md-btn:disabled/.test(css));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
