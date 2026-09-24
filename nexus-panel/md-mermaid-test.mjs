/**
 * md F10 —— Mermaid 图表
 * ============================================================
 * 只跑**纯逻辑**部分（mermaid.js）：
 *   队列串行 / 失败不卡死 / 主题映射 / 判定 / 缓存键 / 不二次消毒
 *
 * mermaid 本身体积大且需要浏览器，这里不加载；
 * 组件接线用源码断言钉住。
 *
 * 运行：node md-mermaid-test.mjs
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
  createRenderQueue, themeVarsOf, isMermaid, cacheKeyOf, needsExtraSanitize,
} = await import('./plugins/md/mermaid.js');

const app = read('plugins/md/App.tsx');
const blk = read('plugins/md/MermaidBlock.tsx');
const css = read('css/neumorphism.css');
const pkg = JSON.parse(read('package.json'));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const appC = strip(app), blkC = strip(blk);

/* ============================================================
   1. 串行队列
   ============================================================ */
console.log('\n=== 1. 串行队列（并发会串色）===');

(async () => {
  const q = createRenderQueue();
  const order = [];

  /* 快慢交替：并发的话慢的会落在快的后面产出 */
  const r = await Promise.all([
    q.run(async () => { order.push('A-start'); await new Promise((s) => setTimeout(s, 30)); order.push('A-end'); return 'A'; }),
    q.run(async () => { order.push('B-start'); order.push('B-end'); return 'B'; }),
  ]);

  t('两个任务都完成', r[0] === 'A' && r[1] === 'B', JSON.stringify(r));
  t('真串行（A 结束后 B 才开始）',
    JSON.stringify(order) === JSON.stringify(['A-start', 'A-end', 'B-start', 'B-end']),
    JSON.stringify(order));

  /* ---- 最关键：前一个失败不能卡死队列 ---- */
  const q2 = createRenderQueue();
  /*
   * 用 allSettled 而不是 all：
   *   all 在第一个 reject 时直接抛，测试进程崩掉 ——
   *   崩了不等于"失败被抓到"，反而看不到第二个任务到底有没有跑。
   *   这里要验的正是"第一个失败后第二个还能不能跑"。
   */
  const r2 = (await Promise.allSettled([
    q2.run(async () => { throw new Error('坏图'); }),
    q2.run(async () => '第二个'),
  ])).map((x) => (x.status === 'fulfilled' ? x.value : x.reason));

  t('第一个失败被如实返回（不被吞成 undefined）',
    r2[0] instanceof Error && r2[0].message === '坏图', String(r2[0]));
  t('**前一个失败后，后续仍能渲染**（否则一篇里一个坏图拖死全部）',
    r2[1] === '第二个', String(r2[1]));

  /*
   * 行为断言测的是"两层防护合起来的效果"，
   * 少一层**照样全绿**（另一层兜住了）—— 所以两层都要单独钉住源码形式。
   * 这是本轮唯一一个"行为断言抓不到"的点，靠形式断言补。
   */
  const mmSrc = read('plugins/md/mermaid.js');
  t('队列：then 双参数（chain rejected 时任务仍执行）',
    /const p = chain\.then\(task, task\);/.test(mmSrc));
  t('队列：chain 带 catch（不产生 unhandled rejection）',
    /chain = p\.then\(/s.test(mmSrc) && /\(\) => undefined/.test(mmSrc));

  /* 失败之后再来一轮，确认队列没进入永久 rejected */
  const r3 = await q2.run(async () => '第三个');
  t('失败后队列仍可用（不进入永久 rejected）', r3 === '第三个', String(r3));

  /* ============================================================
     2. 主题映射
     ============================================================ */
  console.log('\n=== 2. 主题映射（不写死色板）===');

  const vars = { '--bg': '#101014', '--text': '#e8e8e8', '--border': '#333' };
  const got = themeVarsOf((n) => vars[n] || '');
  t('background 从宿主变量来', got.background === '#101014', JSON.stringify(got));
  t('primaryTextColor 从宿主变量来', got.primaryTextColor === '#e8e8e8');
  t('读不到的**不填兜底色**（填了则切主题时该元素不变）',
    !got.primaryColor, JSON.stringify(got.primaryColor));

  const empty = themeVarsOf(() => '');
  t('全读不到 → 空对象（交给 mermaid 默认，整图仍跟 theme 走）',
    Object.keys(empty).length === 0);

  /* 同名的多个候选：按优先级取第一个有值的 */
  const multi = themeVarsOf((n) => (n === '--nm-surface' ? '#abc' : (n === '--surface' ? '#def' : '')));
  t('候选按优先级取（--nm-surface 优先于 --surface）',
    multi.primaryColor === '#abc', JSON.stringify(multi));

  /* ============================================================
     3. 判定与缓存键
     ============================================================ */
  console.log('\n=== 3. 判定与缓存键 ===');

  t('认 language-mermaid', isMermaid('language-mermaid'));
  t('认 hljs 组合类名', isMermaid('hljs language-mermaid'));
  t('不认 mermaid 子串（language-mermaid-x 不是）', !isMermaid('language-mermaid-x'));
  t('不认普通代码块', !isMermaid('language-js'));
  t('不认无语言（可能是任何东西）', !isMermaid('') && !isMermaid(undefined));

  const k1 = cacheKeyOf('graph TD', 'dark');
  const k2 = cacheKeyOf('graph TD', 'light');
  t('**同源码不同主题 → 不同键**（否则切主题后图不重画）', k1 !== k2);
  /* 形式断言补位：键里必须真出现 themeTag。
     行为断言 k1 !== k2 只测了结果，换成别的唯一化方式也会绿，
     但那可能不是"按主题区分"。 */
  t('缓存键含 themeTag（形式）', /\$\{themeTag/.test(read('plugins/md/mermaid.js')));
  t('同源码同主题 → 同键', k1 === cacheKeyOf('graph TD', 'dark'));
  t('不同源码 → 不同键', k1 !== cacheKeyOf('graph LR', 'dark'));

  /* ============================================================
     4. 不二次消毒
     ============================================================ */
  console.log('\n=== 4. 不二次消毒 ===');

  t('needsExtraSanitize 返回 false（二次消毒会剥掉节点文字）',
    needsExtraSanitize() === false);
  /* 组件里不能出现任何消毒调用 */
  t('组件内无 DOMPurify / sanitize 调用',
    !/DOMPurify|sanitize/i.test(blkC), '→ 组件里出现了消毒调用');

  /* ============================================================
     5. 组件与接线
     ============================================================ */
  console.log('\n=== 5. 组件与接线 ===');

  t('依赖里有 mermaid', !!pkg.dependencies?.mermaid);
  t('mermaid 是动态 import（不进首屏）', /await import\('mermaid'\)/.test(blkC));
  t('无静态 import mermaid', !/^import .*'mermaid'/m.test(blkC));

  t('securityLevel 是 strict', /securityLevel: 'strict'/.test(blkC));
  t('startOnLoad 关掉（否则会扫全页重复渲染）', /startOnLoad: false/.test(blkC));
  t('themeVariables 来自 themeVarsOf', /themeVariables: Object\.keys\(vars\)\.length \? vars : undefined/.test(blkC));

  /* 队列必须是模块级单例 —— 放组件里就完全没串行效果了 */
  t('队列是模块级单例（每个块一个 = 没串行）',
    /^const queue = createRenderQueue\(\);/m.test(blkC));

  t('渲染失败要显示出来（静默=用户以为插件坏了）',
    /setErr\(`图表渲染失败：/.test(blkC));
  t('失败时把源码一起显示（否则没法对照改）',
    /<pre className="md-mm-src">/.test(blkC));
  t('占位给高度（不然图画出来把内容顶得跳一下）', /md-mm-loading/.test(blkC));
  t('卸载后不 setState（alive 守卫）', /alive\.current/.test(blkC));

  /* App.tsx 接线：mermaid 必须被分流，否则被 hljs 着色成彩色文本 */
  t('CodeBlock 里分流 mermaid（不然显示成彩色文本，不报错）',
    /if \(isMermaid\(codeClass\)\) \{\s*return <MermaidBlock/.test(appC));
  t('App 引入了 MermaidBlock 与 isMermaid',
    /import MermaidBlock from '\.\/MermaidBlock';/.test(appC) &&
    /import \{ isMermaid \} from '\.\/mermaid';/.test(appC));

  /* ============================================================
     6. CSS
     ============================================================ */
  console.log('\n=== 6. CSS ===');

  t('.md-mm svg 限制宽度（否则窄栏溢出被裁且无提示）',
    /\.md-mm svg \{[\s\S]{0,120}?max-width: 100%;/.test(css));
  t('.md-mm 容器可横向滚动', /\.md-mm \{[\s\S]{0,120}?overflow-x: auto;/.test(css));
  t('.md-mm 不写死图配色（配色由 themeVariables 映射）',
    !/\.md-mm[^{]*\{[^}]*background:\s*#[0-9a-fA-F]{3,8}/.test(css));

  console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
  if (fail) process.exitCode = 1;
})();
