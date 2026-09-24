/**
 * md 插件测试（批次 1）
 * ============================================================
 * 分两类断言：
 *
 *   ① 真跑渲染 —— 用 react-dom/server 把 md 渲染成 HTML 再看结果。
 *      只查源码字符串是不够的：插件数组写对了但没传进去、
 *      传进去了却被 urlTransform 剥掉，都只在**结果**里才看得见。
 *   ② 静态断言 —— registry 登记、CSS 变量、user-select。
 *
 * 破坏验证见文件末尾 BREAK 注释：每条断言都要能被"改坏后报红"，
 * 否则它绿着也没意义（这类假绿在这个项目里已经出现过多次）。
 */

import { readFileSync } from 'fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import {
  REMARK_PLUGINS,
  REHYPE_PLUGINS,
  urlTransform,
} from './plugins/md/render-config.js';

let pass = 0;
const fails = [];

function t(name, cond, detail) {
  if (cond) {
    pass++;
  } else {
    fails.push(name + (detail ? `  → ${detail}` : ''));
  }
}

// ── 渲染辅助 ──────────────────────────────────────────────
function render(md) {
  return renderToStaticMarkup(
    React.createElement(
      ReactMarkdown,
      {
        remarkPlugins: REMARK_PLUGINS,
        rehypePlugins: REHYPE_PLUGINS,
        urlTransform,
      },
      md,
    ),
  );
}

// ── ① 真跑渲染 ────────────────────────────────────────────
console.log('=== 1. 渲染行为（真跑） ===');

// F1 基础语法
t('标题渲染', render('# 标题').includes('<h1'));
t('表格渲染', render('| a | b |\n|---|---|\n| 1 | 2 |').includes('<table'));
t('任务列表渲染 checkbox',
  render('- [x] 完成').includes('type="checkbox"'));
t('删除线 ~~x~~ 生效',
  render('这是 ~~删除~~ 文本').includes('<del>删除</del>'));

/*
 * singleTilde:false —— 必须**真跑**才测得到。
 *
 * 用例得用**成对**单波浪 `~x~`。第一版我用了 `约 ~200ms`（只有一个波浪），
 * 结果：配置去掉了照样全绿 —— 因为单个不闭合的波浪本来就不会触发删除线，
 * 无论 singleTilde 是 true 还是 false。那是假绿。
 *
 * 实测三态（remark-gfm 4.0.1）：
 *   默认（不传配置）    ~x~ → <del>    ← 默认其实是 true
 *   singleTilde: false  ~x~ → 原样     ← 我们要的
 *   singleTilde: true   ~x~ → <del>
 * 即这条配置**不是冗余**，默认行为恰好相反。
 */
t('成对单波浪 ~x~ 不变成删除线（singleTilde:false 生效）',
  !render('这是 ~单波浪~ 文本').includes('<del>'),
  render('这是 ~单波浪~ 文本'));

t('双波浪 ~~x~~ 仍是删除线（关单波浪不能连双波浪一起关掉）',
  render('这是 ~~删除~~ 文本').includes('<del>删除</del>'));

// rehype-slug：TOC 锚点依赖它
t('标题带 id（rehype-slug 生效）',
  /<h1[^>]*id="/.test(render('# 标题')),
  render('# 标题'));

// rehype-highlight
t('代码块高亮（rehype-highlight 生效）',
  render('```js\nconst a = 1;\n```').includes('class="hljs'));

// 安全：不装 rehype-raw，原始 HTML 应被转义
const xss = render('<script>alert(1)</script>');
t('原始 HTML 被转义（不装 rehype-raw）',
  xss.includes('&lt;script&gt;') && !xss.includes('<script>'));

/*
 * 注意：不装 rehype-raw 时整段 HTML 被**转义成文本**输出，
 * 所以结果里照样有 "onerror" 这几个字符 —— 但它是纯文本，不是属性。
 * 断言写 `!includes('onerror')` 会**假红**（转义文本里也有这串字符），
 * 真正要盯的是"有没有出现**未转义的** <img 标签"。
 */
const imgRaw = render('<img src=x onerror=alert(1)>');
t('img 标签未生效（整段被转义为文本）',
  imgRaw.includes('&lt;img') && !imgRaw.includes('<img'),
  imgRaw);

/*
 * javascript: 协议被 defaultUrlTransform 剥成空串。
 * 这条正是自研渲染器那个洞的答案 —— 自研版会原样输出 href="javascript:..."
 */
const jsLink = render('[x](javascript:alert(1))');
t('javascript: 协议被拦截',
  !jsLink.includes('javascript:'),
  jsLink);

/*
 * urlTransform 放行 data:image —— 两道关卡里的第二道。
 * 只放行 sanitize（我们没装）不放行这里，图照样变空白且不报错。
 */
const dataImg = render('![x](data:image/png;base64,AAAA)');
t('data:image 图片不被剥成空串（urlTransform 放行）',
  dataImg.includes('data:image/png;base64,AAAA'),
  dataImg);

// 非 image 的 data: 不应放行（避免开太大的口子）
t('非图片的 data: 不放行',
  !render('![x](data:text/html;base64,AAAA)').includes('data:text/html'));

// ── ② 配置结构 ────────────────────────────────────────────
console.log('=== 2. 配置结构 ===');

const cfgSrc = readFileSync('plugins/md/render-config.js', 'utf8');

t('remark-gfm 带 singleTilde:false',
  /singleTilde:\s*false/.test(cfgSrc));

t('rehype 插件数组含 slug',
  REHYPE_PLUGINS.length > 0);

/*
 * slug 必须排在 sanitize 之后。
 *
 * 这里解析 **REHYPE_PLUGINS 数组的实际元素顺序**，不能用 indexOf：
 * 注释里也写着 rehypeSanitize 这个词，indexOf 命中的是注释位置 ——
 * 第一次写就踩了这个假红（slug@513 sanitize@930，其实两个都在注释/import 里）。
 *
 * 顺序错了不报错，只是 TOC 点了不跳转，所以必须有断言钉住。
 */
const arrM = cfgSrc.match(
  /REHYPE_PLUGINS\s*=\s*\[([\s\S]*?)\]/,
);
t('REHYPE_PLUGINS 是数组字面量', !!arrM);
if (arrM) {
  const items = arrM[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const iSlug = items.indexOf('rehypeSlug');
  const iSan = items.indexOf('rehypeSanitize');
  t('slug 在数组里', iSlug >= 0, items.join(' | '));
  t('slug 排在 sanitize 之后（当前无 sanitize 时成立）',
    iSan === -1 || iSlug > iSan,
    `slug@${iSlug} sanitize@${iSan} · ${items.join(' | ')}`);
}

t('urlTransform 放行 data:image/', cfgSrc.includes("startsWith('data:image/'"));
t('urlTransform 其余走 defaultUrlTransform',
  cfgSrc.includes('defaultUrlTransform(url)'));

// ── ③ registry 登记 ───────────────────────────────────────
console.log('=== 3. registry 登记 ===');

const reg = readFileSync('plugins/registry.js', 'utf8');
const mdEntry = reg.match(/id:\s*'md',[\s\S]{0,600}?\n  \},/);

t('registry 里有 md 条目', !!mdEntry);
if (mdEntry) {
  const e = mdEntry[0];
  t("md 是 module 类型（同页，才能继承宿主主题变量）",
    /type:\s*'module'/.test(e));
  t('md 是内置插件 builtin:true', /builtin:\s*true/.test(e));
  /*
   * followsTheme —— 少了它，切浅色主题时"变白一秒后又变黑"，
   * 像切换了好几次。它错了不报错，只能靠断言钉。
   */
  t('md 标了 followsTheme', /followsTheme:\s*true/.test(e));
  t('md 入口指向 module.tsx（glob 只匹配这个命名）',
    /entry:\s*'\.\/plugins\/md\/module\.tsx'/.test(e));
}

// ── ④ CSS：主题跟随 + 可选中 ──────────────────────────────
console.log('=== 4. CSS ===');

const css = readFileSync('css/neumorphism.css', 'utf8');
/*
 * 只取 md 插件那一段来查，否则会命中文件里别处的 user-select。
 * 之前踩过：裸子串匹配会被 tb-card-top 之类命中，造成假绿。
 */
const mdCssRaw = css.slice(css.indexOf('.md-wrap'));

/*
 * 先剥掉注释再匹配。
 * 不剥会**假红**：CSS 里那段说明注释本身就写了 "user-select" 这个词，
 * 且它出现在真正声明之前；正则一旦在注释里对上 "user-select" 就往下找
 * `:\s*text`，而注释里后面跟的是中文，匹配失败。
 */
const mdCss = mdCssRaw.replace(/\/\*[\s\S]*?\*\//g, '');

t('md 源文本框可选中', /\.md-src\s*\{[\s\S]{0,400}?user-select:\s*text/.test(mdCss));
t('md 渲染区可选中', /\.md-out\s*\{[\s\S]{0,400}?user-select:\s*text/.test(mdCss));

/*
 * 主题跟随：md 段内不得出现硬编码色值。
 * 写死色板的后果是切主题时这片不变，看起来像"插件坏了"。
 */
/*
 * 只查 **var() 之外**的字面色。
 *
 * `var(--danger, #ff6b6b)` 这种兜底写法不算写死色板 ——
 * 主题跟着变量走，兜底只在变量缺失时才生效，是合法且必要的写法
 * （本文件里 `var(--sp-4, 8px)` 也是同一类）。
 * 不先剥掉 var(...) 就查，会把这类正当写法全部判成违规，
 * 逼着人去掉兜底 —— 那才是真的埋隐患。
 */
const mdCssNoVar = mdCss.replace(/var\([^)]*\)/g, 'var()');
const hardColors = mdCssNoVar.match(/#[0-9a-fA-F]{3,8}\b|rgba?\(/g) || [];
t('md 样式不写死色板（全部走变量）',
  hardColors.length === 0,
  hardColors.join(','));

t('md 样式用宿主变量 --surface-sunk', mdCss.includes('var(--surface-sunk)'));
t('md 样式用宿主变量 --accent（引用块左边框）',
  /blockquote[\s\S]{0,200}?var\(--accent\)/.test(mdCss));

// ── 结果 ──────────────────────────────────────────────────
console.log('');
if (fails.length) {
  console.log('❌ 失败 ' + fails.length + ' 项：');
  fails.forEach((f) => console.log('   ' + f));
} else {
  console.log('✅ 全部 ' + pass + ' 项通过');
}
console.log(`通过 ${pass} / 失败 ${fails.length}`);
process.exit(fails.length ? 1 : 0);

/*
 * BREAK —— 破坏验证清单（改坏后必须报红，否则断言无效）
 * ------------------------------------------------------------
 * 1. render-config.js 去掉 singleTilde:false
 *      → 应红「单个 ~ 不变成删除线」
 * 2. REHYPE_PLUGINS 去掉 rehypeSlug
 *      → 应红「标题带 id」
 * 3. REHYPE_PLUGINS 去掉 rehypeHighlight
 *      → 应红「代码块高亮」
 * 4. urlTransform 改成直接 return url（全放行）
 *      → 应红「javascript: 协议被拦截」
 * 5. urlTransform 去掉 data:image 放行
 *      → 应红「data:image 图片不被剥成空串」
 * 6. registry 去掉 followsTheme
 *      → 应红「md 标了 followsTheme」
 * 7. CSS 去掉 .md-src 的 user-select
 *      → 应红「md 源文本框可选中」
 * 8. CSS 里把 var(--surface-sunk) 换成 #222
 *      → 应红「md 样式不写死色板」
 */
