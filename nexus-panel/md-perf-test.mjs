/**
 * md 批次 4 —— 分块 / 增量 / 虚拟滚动 / 阅读状态
 * ============================================================
 * splitBlocks 是纯函数，直接跑；visibleBlockIndex 用假 rect 喂。
 *
 * 重点验证的是"错了不报错"的那几类：
 *   · 围栏里的空行不能切成两块（会显示成垃圾文字）
 *   · 缓存上限要真生效（否则虚拟滚动省下的内存又全赔进去）
 *   · 恢复位置不能用滚动比例（高度是估算值）
 *
 * 运行：node md-perf-test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0;
let fail = 0;
function t(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${extra ? '  → ' + extra : ''}`); }
}

const { splitBlocks, createBlockCache, visibleBlockIndex } = await import('./plugins/md/blocks.js');
const app = read('plugins/md/App.tsx');
const css = read('css/neumorphism.css');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const appC = strip(app);

/* ============================================================
   1. splitBlocks —— 纯函数真跑
   ============================================================ */
console.log('\n=== 1. splitBlocks ===');

t('空输入 → 0 块（不产出一个空 div）', splitBlocks('').length === 0);
t('非字符串 → 0 块（不抛）', splitBlocks(null).length === 0 && splitBlocks(undefined).length === 0);
t('单段无空行 → 1 块', splitBlocks('一段文字').length === 1);

const b2 = splitBlocks('# 标题\n\n正文一\n\n正文二');
t('按空行切成 3 块', b2.length === 3, `→ ${b2.length}`);
t('块内容不含空行', b2.every((b) => !/^\s*$/.test(b.text)));
t('拼回去不丢内容',
  b2.map((b) => b.text).join('\n\n').replace(/\n+$/, '') === '# 标题\n\n正文一\n\n正文二');

/* 最关键的一条：围栏里的空行不能被当成边界 */
const fence = '```js\nconst a = 1;\n\nconst b = 2;\n```\n\n尾巴';
const bf = splitBlocks(fence);
t('围栏内的空行**不切块**（切了会显示成垃圾）',
  bf.length === 2, `→ ${bf.length} 块`);
t('围栏块完整（含收尾的 ```）',
  bf[0].text === '```js\nconst a = 1;\n\nconst b = 2;\n```', JSON.stringify(bf[0]?.text?.slice(0, 40)));
t('围栏闭合后正常切下一块', bf[1]?.text === '尾巴');

/* ~~~ 围栏同样处理 */
t('~~~ 围栏同样不切',
  splitBlocks('~~~\nx\n\ny\n~~~').length === 1);

/*
 * 不同标记的围栏不能互相闭合。
 *
 * （``` 里出现 ~~~ 是内容，不是闭合 —— 这是代码块里写波浪线的常见情形。
 *   反过来闭的话，后面的内容会被当成 markdown 正文渲染。）
 */
t('不同标记（``` 里的 ~~~）不互相闭合',
  splitBlocks('```\na\n~~~\n```\n\n后').length === 2,
  `→ ${splitBlocks('```\na\n~~~\n```\n\n后').length}`);
t('闭合围栏带尾随空格仍算闭合',
  splitBlocks('```\na\n```   \n\n后').length === 2,
  `→ ${splitBlocks('```\na\n```   \n\n后').length}`);

/* 多个空行不产空块 */
t('连续空行不产生空块',
  splitBlocks('a\n\n\n\nb').length === 2, `→ ${splitBlocks('a\n\n\n\nb').length}`);

/* 只有空行 → 0 块 */
t('全空行 → 0 块', splitBlocks('\n\n\n').length === 0);

/* 列表内不切（列表行之间没有空行） */
t('连续列表行保持一块', splitBlocks('- a\n- b\n- c').length === 1);

/* start/end 单调 */
const b3 = splitBlocks('a\n\nb\n\nc');
t('start/end 有值且递增',
  b3.every((b) => typeof b.start === 'number' && b.end >= b.start) &&
  b3[0].start < b3[1].start);

/* ============================================================
   2. createBlockCache —— 上限是真生效的不是摆设
   ============================================================ */
console.log('\n=== 2. createBlockCache ===');

const c = createBlockCache(3);
c.set('a', 1); c.set('b', 2); c.set('c', 3);
t('未超上限时全保留', c.size === 3, `→ ${c.size}`);
/* 淘汰断言放在**任何 get 之前**：get 会刷新 LRU 顺序，
   先取过再断言"谁被淘汰"，测的就变成顺序而不是容量了。 */
c.set('d', 4);
t('超过上限真的淘汰（否则内存只涨不落）', c.size === 3, `→ ${c.size}`);
t('淘汰的是最久没动过的 a', c.get('a') === undefined, `→ ${c.get('a')}`);
t('新的还在', c.get('d') === 4);
t('能取回存活的值', c.get('b') === 2 && c.get('c') === 3);

/* 命中要刷新位置：不刷新的话"最旧的"永远是第一批，
   翻长文档时反而把正在看的块淘汰掉 */
const c2 = createBlockCache(2);
c2.set('x', 1); c2.set('y', 2);
c2.get('x');            // 命中 x
c2.set('z', 3);
t('命中后刷新淘汰顺序（老条目不该被反复淘汰）',
  c2.get('x') !== undefined && c2.get('y') === undefined,
  `→ x=${c2.get('x')} y=${c2.get('y')}`);
t('刷新后 size 仍在上限内', c2.size === 2);

/* ============================================================
   3. visibleBlockIndex
   ============================================================ */
console.log('\n=== 3. visibleBlockIndex ===');

const mkRect = (top, h) => ({ getBoundingClientRect: () => ({ top, bottom: top + h, height: h }) });
const container = mkRect(100, 500);      // 容器顶边在 100

t('无容器 → 0（不抛）', visibleBlockIndex(null, []) === 0);
t('空块列表 → 0', visibleBlockIndex(container, []) === 0);

const blocks = [
  mkRect(100, 50),    // bottom 150 > 101 → 命中
  mkRect(150, 50),
  mkRect(200, 50),
];
t('返回第一个还没滚过去的块', visibleBlockIndex(container, blocks) === 0);

const scrolled = [
  mkRect(0, 50),      // bottom 50 < 101 → 已滚过
  mkRect(50, 50),     // bottom 100 < 101 → 已滚过
  mkRect(100, 50),    // bottom 150 → 命中
];
t('已滚过的块被跳过', visibleBlockIndex(container, scrolled) === 2, `→ ${visibleBlockIndex(container, scrolled)}`);

const allAbove = [mkRect(-100, 50), mkRect(-50, 50)];
t('全在上方 → 0（兜底，不返回 -1）', visibleBlockIndex(container, allAbove) === 0);

/* ============================================================
   4. App.tsx 接线
   ============================================================ */
console.log('\n=== 4. App.tsx 接线 ===');

t('引入 blocks.js', /import \{ splitBlocks, createBlockCache, visibleBlockIndex \} from '\.\/blocks'/.test(appC));
t('按 src 分块', /splitBlocks\(src\)/.test(appC));
t('每块包一层 .md-block', /className="md-block"/.test(appC));
t('块带 data-block-index（恢复位置要用）', /data-block-index=\{i\}/.test(appC));
t('渲染走块缓存（增量解析的本体）', /cacheRef\.current\.get\(text\)/.test(appC));
t('未命中才真正解析', /cacheRef\.current\.set\(text, el\)/.test(appC));

/* 恢复位置：不能用滚动比例 */
t('存的是块下标而不是滚动比例',
  /store\?\.set\?\.\(`pos:\$\{docKey\}`, \{ i, ts: now \}\)/.test(appC));
t('恢复时按 data-block-index 找块',
  /querySelector\?\.\(`\[data-block-index="\$\{saved\.i\}"\]`\)/.test(appC));
t('恢复只依赖 docSeq（依赖 src 会在打字时反复拽回视图）',
  /\}, \[docSeq, docKey, ctx\]\);/.test(appC));
t('docSeq 在拖入打开时自增', /setDocSeq\(\(n\) => n \+ 1\)/.test(appC));
t('docSeq 自增出现两处（拖入 + E2 传路径）',
  (appC.match(/setDocSeq\(\(n\) => n \+ 1\)/g) || []).length === 2,
  `→ ${(appC.match(/setDocSeq\(\(n\) => n \+ 1\)/g) || []).length}`);
t('未打开过文档时不恢复（docSeq 为 0）', /if \(!docSeq\) return;/.test(appC));
t('滚动保存有节流（否则把桥接/存储打满）',
  /if \(now - saveTimer\.current < 600\) return;/.test(appC));
t('存储失败不影响滚动（catch 掉）', /\.catch\(\(\) => \{\}\)/.test(appC));

/* ============================================================
   5. CSS —— 虚拟滚动
   ============================================================ */
console.log('\n=== 5. CSS 虚拟滚动 ===');

t('.md-block 有 content-visibility: auto',
  /\.md-block \{[\s\S]{0,160}?content-visibility: auto;/.test(css));
t('.md-block 有 contain-intrinsic-size（不给值滚动条会一路变长）',
  /\.md-block \{[\s\S]{0,160}?contain-intrinsic-size: auto 320px;/.test(css));

/* ============================================================
   6. 真跑：分块渲染 ≠ 渲染错乱
   ------------------------------------------------------------
   分块的副作用必须实测：切开再渲染，表格/围栏/任务列表这些
   跨行结构会不会散架。只看切分对不对看不出来，得看产物。
   ============================================================ */
console.log('\n=== 6. 真跑渲染（分块 vs 整篇）===');

let React, ReactMarkdown, render, cfg;
try {
  React = (await import('react')).default;
  ReactMarkdown = (await import('react-markdown')).default;
  render = (await import('react-dom/server')).renderToStaticMarkup;
  cfg = await import('./plugins/md/render-config.js');
} catch (e) {
  console.log('⚠ 依赖不可用，跳过渲染比对：', String(e.message).slice(0, 80));
}

if (render) {
  const md = (text) => render(React.createElement(ReactMarkdown, {
    remarkPlugins: cfg.REMARK_PLUGINS,
    rehypePlugins: cfg.REHYPE_PLUGINS,
    urlTransform: cfg.urlTransform,
  }, text));

  const docs = {
    '围栏': '```js\nconst a = 1;\n\nconst b = 2;\n```\n\n尾巴',
    '表格': '| 项 | 值 |\n| --- | --- |\n| a | 1 |\n| b | 2 |',
    '任务列表': '- [x] 做完\n- [ ] 没做',
    '标题与正文': '# 标题\n\n正文 **粗** 与 `码`',
  };

  for (const [name, text] of Object.entries(docs)) {
    const whole = md(text);
    const parts = splitBlocks(text);
    const joined = parts.map((b) => md(b.text)).join('');
    t(`${name}：分块后块数合理（${parts.length}）`, parts.length >= 1);

    /* 关键结构不能散架：这些标签在整篇里有，分块后也必须还在 */
    const must = {
      围栏: '<pre>', 表格: '<table>', 任务列表: '<input', 标题与正文: '<h1',
    }[name];
    t(`${name}：整篇有 ${must}`, whole.includes(must));
    t(`${name}：分块后 ${must} 仍在（散架 = 切开就把结构切没了）`,
      joined.includes(must), `→ ${joined.slice(0, 90)}`);
  }

  /* 围栏里的内容在分块后必须完整（a 和 b 都要在，而不是只剩一半） */
  const fenceText = '```js\nconst a = 1;\n\nconst b = 2;\n```';
  const fblocks = splitBlocks(fenceText);
  const fenceOut = fblocks.map((b) => md(b.text)).join('');
  /*
   * 必须先**剥掉标签**再查文本：
   *   highlight.js 把每个 token 包进 <span>，产物是
   *   `a = <span class="hljs-number">1</span>` ——
   *   "a = 1" 这个连续字符串在 HTML 里根本不存在。
   *   不剥标签就断言会假红，看起来像渲染坏了，其实是断言写错了。
   */
  const plain = fenceOut.replace(/<[^>]*>/g, '');
  t('围栏内两行都在（切开的话后半段会变成垃圾文字）',
    fblocks.length === 1 && plain.includes('a = 1') && plain.includes('b = 2'),
    `→ 块数 ${fblocks.length}, 纯文本 ${JSON.stringify(plain.slice(0, 60))}`);
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
if (fail) process.exitCode = 1;
