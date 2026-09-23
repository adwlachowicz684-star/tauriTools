/*
 * 令牌文件必须被加载 —— 幽灵变量守卫
 * ============================================================
 *
 * CSS 规范：var() 引用未定义变量且没有兜底值时，该声明**失效**、
 * 属性退化为初始值。不报错、不告警，控制台也没有任何提示。
 * 表现是"样式看着不对，但查不出哪错了"。
 *
 * 这个项目已经踩过两轮：
 *   ① agent-flow 的 styles.css：94 处字号、36 处圆角、22 处按钮凸起全废
 *   ② neumorphism.css 自己：--z-* / --dur-* / --font-sans 等 19 个同样失效
 *
 * 根因只有一个：tokens.css（设计令牌的权威来源）**从未被加载**。
 *
 * 为什么不能只"补变量名"：那是打地鼠 —— 补完一批，上游再引一批新的
 * 令牌又失效。而且补的时候容易顺手加兜底值，加了兜底就不算幽灵了，
 * 守卫看不见，但值其实是错的。**加载令牌文件才是根治。**
 *
 * 为什么判据是"运行时加载集"而不是"仓库里有没有这个文件"：
 * tokens.css 一直躺在仓库里，可它没被加载 —— 这才是它藏了两轮的原因。
 * 按"仓库里有"判定就会被绕过（上一版守卫正是这么写的，于是报 0 个）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './js/dead-class-scan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const rd = (pp) => { try { return readFileSync(join(HERE, pp), 'utf-8'); } catch { return ''; } };

/** 运行时真正被加载的 CSS —— 由 main.tsx 的 import 决定 */
const RUNTIME_CSS = ['css/neumorphism.css', 'css/tokens.css', 'plugins/agent-flow/styles.css'];

/** 注释里出现的示例名，不算真引用 */
const ALLOW = new Set(['--xy-x-default']);

t('main.tsx 加载了 tokens.css', (() => {
  const main = rd('src/main.tsx');
  if (!main) return false;
  return /['"]\.\.\/css\/tokens\.css['"]/.test(main);
})(), '不加载令牌文件，所有引用令牌的 var() 都会静默失效');

t('运行时加载集里没有幽灵变量', (() => {
  const all = RUNTIME_CSS.map(rd);
  if (all.some((x) => !x)) return false;          // 读不到就不算通过，避免假阴性
  const css = stripComments(all.join('\n'));
  const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]));
  const withFb = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,/g)].map((m) => m[1]));
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const ghost = [...used].filter((v) => !defined.has(v) && !withFb.has(v) && !ALLOW.has(v));
  if (ghost.length) console.log('   幽灵：' + ghost.join('、'));
  return ghost.length === 0;
})(), '引用了但没定义、也没兜底的令牌');

console.log(`\n  token 守卫：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
