/*
 * 令牌文件必须可达 —— 幽灵变量守卫（会跟随 @import）
 * ============================================================
 *
 * CSS 规范：var() 引用未定义变量且没有兜底值时，该声明**失效**、
 * 属性退化为初始值。不报错、不告警，控制台也没有任何提示。
 * 表现是"样式看着不对，但查不出哪错了"。
 *
 * 为什么必须**跟随 @import** 扫描：
 * 本项目的令牌与控件层不是各自单独加载的 ——
 *   neumorphism.css 第 84~88 行 @import 了 tokens / controls / dialog
 *   agent-flow/styles.css 第 6~11 行同样 @import 了这三份
 * 只看单个文件的文本，会把"通过 @import 拿到"误判成"没定义"。
 *
 * 这条守卫此前正是这么写的，于是误报出 19 个幽灵变量，
 * 还据此往 main.tsx 多加了一次 tokens.css 的 import（已还原）。
 * 不跟 @import 的扫描，比不扫描更糟 —— 它会给出确定的错误答案。
 *
 * 另外盯一件事：插件自己的 :root 若重复定义同名令牌，会把 @import 进来的
 * 值**盖掉**（同为 :root，文档顺序靠后者胜）。盖掉后插件就不跟随上游调令牌了。
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from './js/dead-class-scan.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const rd = (pp) => { try { return readFileSync(join(HERE, pp), 'utf-8'); } catch { return ''; } };

/** 入口：主文档 + 各插件自己的样式表 */
const ENTRIES = [
  'css/neumorphism.css',
  'plugins/agent-flow/styles.css',
  'plugins/mindmap/styles.css',
];

/** 跟随 @import 展开（相对路径按被引用文件所在目录解析） */
function expand(entry, seen = new Set()) {
  const abs = resolve(HERE, entry);
  if (seen.has(abs)) return '';
  seen.add(abs);
  /*
   * 先剥注释再找 @import —— 注释里的 @import 不是导入。
   * 不剥的话，把某条 @import 注释掉这种改坏方式检测不到：
   * 正则仍能在注释文本里匹配到它，于是照样展开，守卫给出假阴性。
   */
  const src = stripComments(rd(entry));
  if (!src) return '';
  let out = src + '\n';
  for (const m of src.matchAll(/@import\s+url\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const rel = join(dirname(entry), m[1]);
    out += expand(rel, seen);
  }
  return out;
}

/** 注释里出现的示例名，不算真引用 */
const ALLOW = new Set(['--xy-x-default', '--sh-out']);

/*
 * 主题引擎在运行时推的变量（js/themes.js + js/theme-manager.js）。
 * 它们不在任何 CSS 文件里定义 —— 由 JS 写到 :root 上。
 * 不排除的话每条都会被误报成幽灵变量。
 */
const THEME_PUSHED = new Set([
  '--accent', '--accent-glow', '--badge-fg', '--bg', '--bg-image', '--blur',
  '--border', '--danger', '--divider', '--edge', '--hairline', '--mask',
  '--ok', '--r-lg', '--r-md', '--r-sm', '--r-xl', '--running', '--scroll-thumb',
  '--sh-dark', '--sh-light', '--surface', '--surface-overlay', '--surface-raised',
  '--surface-sunk', '--text', '--text-dim', '--text-mute', '--text-soft', '--warn',
]);

for (const entry of ENTRIES) {
  const css = stripComments(expand(entry));
  t(`${entry} 可达`, !!css);
  if (!css) continue;

  const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].map((m) => m[1]));
  const withFb = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)\s*,/g)].map((m) => m[1]));
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const ghost = [...used].filter((v) => !defined.has(v) && !withFb.has(v)
    && !ALLOW.has(v) && !THEME_PUSHED.has(v));
  t(`${entry} 无幽灵变量`, ghost.length === 0, ghost.length ? ghost.join('、') : '');
}

/* ---- 插件 :root 不得盖掉上游令牌 ---- */
/** 只取 :root 块内的定义：选择器内的局部变量（如 .nx-btn.sm 的 --ctl-shadow）不是全局默认值。
    用花括号配对而不是正则 —— 注释里的花括号会把正则切歪。 */
function rootVars(text) {
  const out = new Map();
  const src = stripComments(text);
  let i = 0;
  while ((i = src.indexOf(':root', i)) !== -1) {
    const open = src.indexOf('{', i);
    if (open === -1) break;
    let depth = 0, end = open;
    for (let j = open; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    for (const d of src.slice(open + 1, end).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
      if (!out.has(d[1])) out.set(d[1], d[2].trim());
    }
    i = end;
  }
  return out;
}
const upVals = rootVars(['css/tokens.css', 'css/controls.css'].map(rd).join('\n'));

for (const entry of ENTRIES.slice(1)) {
  const src = rd(entry);
  if (!src) continue;
  const own = rootVars(src);
  const clash = [...own].filter(([k, v]) => {
    const u = upVals.get(k);
    return u && u.replace(/\s/g, '') !== v.replace(/\s/g, '');
  });
  t(`${entry} 不盖掉上游令牌`, clash.length === 0,
    clash.length ? clash.map(([k, v]) => `${k}: 上游 ${upVals.get(k)} vs 本地 ${v}`).join('；') : '');
}

console.log(`\n  令牌守卫：${pass} 通过 / ${fail} 失败`);
if (fail) process.exit(1);
