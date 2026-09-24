/**
 * md-render 服务（md 插件 E3 入口）测试
 * ============================================================
 * 两类断言：
 *   ① 行为 —— **真跑渲染**看产物，不是查源码里有没有写对。
 *      只查源码会放过"配置传了但没生效"这类错。
 *   ② 契约 —— registry 条目与文件布局。
 *      这类错了不报错（服务静默调不到 / 闪浮层），只能靠断言钉住。
 *
 * 运行：node md-service-test.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, ok) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

const src = read('plugins/md-render/module.js');
const reg = read('plugins/registry.js');

/* ============================================================
   1. registry 契约
   ============================================================ */
console.log('\n=== 1. registry 条目 ===');

/*
 * 精确切出 md-render **这一条**的区块。
 *
 * 不能用"前后各取 N 字符"的窗口：往后取 900 会盖到后面 color-picker 那条，
 * 而它上方的注释里写着 "interactive:true —— 调用时宿主会把它临时显示成
 * 居中浮层" —— 正则会把**注释里的文字**当成真标记，于是
 * "未标 interactive" 这条永远判失败（假红）。
 */
const mdIdx = reg.indexOf("id: 'md-render'");
const block = reg.slice(reg.lastIndexOf('  {', mdIdx), reg.indexOf('\n  },', mdIdx));

t('registry 里有 md-render', /id:\s*'md-render'/.test(reg));
t('kind 是 service（否则进侧边栏，且 services.call 找不到）',
  /kind:\s*'service'/.test(block));
t('type 是 module（与宿主同文档，才能和 app 共用渲染配置）',
  /type:\s*'module'/.test(block));
/*
 * 这条防的是"调一下闪一下空白浮层"：
 * 标了 interactive，宿主 callService 会先 showServiceUi(true)
 * 把服务容器弹成居中浮层 —— 纯计算服务不需要，只会闪一下空白。
 */
t('未标 interactive（纯计算，标了会闪空白浮层）',
  /kind:\s*'service'/.test(block) && !/interactive:\s*true/.test(block));
t('builtin: true（内置插件，与宿主同文档不引入不可信代码）',
  /builtin:\s*true/.test(block));
t('requiresBuild: true（依赖 react-markdown 裸模块名，无构建不可用）',
  /requiresBuild:\s*true/.test(block));

/* ============================================================
   2. 文件布局 —— 错了是运行时 404，查不到哪错了
   ============================================================ */
console.log('\n=== 2. 文件布局 ===');

t('入口文件存在：plugins/md-render/module.js',
  existsSync(join(ROOT, 'plugins/md-render/module.js')));
/*
 * plugin-entries.js 的 glob 只匹配 plugins/<id>/module.{js,mjs,ts,tsx}。
 * 改成 index.js / render.js / service.js 都会**静默不被收录**，
 * 表现为调用时 404 —— 服务调不到，但错误信息指向不到这里。
 */
t('文件名是 module.*（glob 只认这个命名）',
  /entry:\s*'\.\/plugins\/md-render\/module\.js'/.test(block));
t('服务目录与 app 目录分开（一个目录只能有一个同页入口）',
  existsSync(join(ROOT, 'plugins/md/module.tsx')) &&
  existsSync(join(ROOT, 'plugins/md-render/module.js')));

/* ============================================================
   3. 共用同一份渲染配置 —— 防配置漂移
   ============================================================ */
console.log('\n=== 3. 与 app 入口共用渲染配置 ===');

t('服务 import 的是 md/render-config.js（不是自己抄一份）',
  /from\s+'\.\.\/md\/render-config\.js'/.test(src));
t('app 入口也用同一份 render-config',
  /render-config/.test(read('plugins/md/App.tsx')));

/* ============================================================
   4. 行为：真跑渲染
   ============================================================ */
console.log('\n=== 4. 渲染行为（真跑） ===');

let def;
try {
  def = (await import('./plugins/md-render/module.js')).default;
} catch (e) {
  console.log(`❌ 无法加载服务模块：${e.message}`);
  fail++;
}

if (def) {
  const render = (text) => def.methods.renderToHtml({ text });

  t('methods 暴露 renderToHtml', typeof def.methods?.renderToHtml === 'function');
  t('methods 暴露 renderConfig（同页调用方可自己渲染）',
    typeof def.methods?.renderConfig === 'function');
  t('mount 返回 cleanup 函数（mountModule 的显式契约）',
    typeof def.mount({}) === 'function');

  /* 外层必须包 markdown-body：调用方靠这个类接样式。
     少了它，同页调用方拿到 HTML 也没有任何样式（变成"只有文字"）。 */
  t('外层包 .markdown-body（调用方靠它接样式）',
    render('# x').startsWith('<div class="markdown-body">'));

  /* ---- GFM ---- */
  t('表格渲染成 <table>',
    /<table>/.test(render('| a | b |\n|---|---|\n| 1 | 2 |')));
  t('任务列表渲染成 checkbox',
    /type="checkbox"/.test(render('- [ ] 待办')));

  /* ---- singleTilde: false（三态里最容易被当成冗余的那条）----
     注意用**成对单波浪** `~单~`：单个不闭合的波浪本来就不触发删除线，
     拿它当用例，配置删了照样绿 —— 是假断言。 */
  const delHtml = render('~~删~~ 与 ~单~');
  t('成对双波浪 → <del>', /<del>删<\/del>/.test(delHtml));
  t('成对单波浪 → 原样（singleTilde:false 生效）',
    /~单~/.test(delHtml) && !/<del>单<\/del>/.test(delHtml));

  /* ---- slug（TOC 锚点）---- */
  t('标题带 id（rehype-slug 生效，TOC 才有锚点）',
    /<h2 id="[^"]+"/.test(render('## 标题一')));

  /* ---- 代码高亮 ---- */
  t('代码块带 hljs 类（rehype-highlight 生效）',
    /class="hljs/.test(render('```js\nconst a=1;\n```')));

  /* ---- 安全 ---- */
  t('<script> 被转义（不装 rehype-raw 的默认行为）',
    render('<script>alert(1)</script>').includes('&lt;script&gt;'));
  /*
   * urlTransform 是独立于 sanitize 的第二道关卡。
   * 这里验证它真的把 javascript: 剥掉了 —— 自研版把这原样输出成了 href。
   */
  const jsHtml = render('[x](javascript:alert(1))');
  t('javascript: 协议被 urlTransform 剥掉',
    /<a href="">/.test(jsHtml) && !/javascript:/.test(jsHtml));
  t('data:image/ 被放行（base64 内嵌图不被剥空）',
    /src="data:image\/png;base64,AAA"/.test(render('![x](data:image/png;base64,AAA)')));

  /* ---- 边界 ---- */
  t('空文本不抛，返回空的 markdown-body',
    def.methods.renderToHtml({}) === '<div class="markdown-body"></div>');
  t('非字符串输入不抛', typeof def.methods.renderToHtml({ text: 123 }) === 'string');

  /* ---- renderConfig ---- */
  const cfg = def.methods.renderConfig();
  t('renderConfig 返回 remark/rehype 插件数组与 urlTransform',
    Array.isArray(cfg.remarkPlugins) && Array.isArray(cfg.rehypePlugins) &&
    typeof cfg.urlTransform === 'function');
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
