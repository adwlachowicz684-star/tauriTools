/**
 * 不规整护栏：死代码 / 文档冲突标记（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/deadcode-test.mjs
 *
 * 为什么需要它：本轮清理时发现三个"定义了但全库无人引用"的导出，
 * 其中一个（PRESET_COLORS）我一度误判为死代码 —— 它其实被另一个
 * 插件 import 了。**扫描范围必须跨插件，否则会误删正在用的东西。**
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');          // nexus-panel
const PG = HERE;                                  // plugins/project-group
const { t, done } = makeT();

/** 收集所有源码文本（跨插件，用于判"有没有人用"） */
function allSources() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|mjs)$/.test(e.name)) out.push(p);
    }
  };
  walk(path.join(ROOT, 'plugins'));
  return out;
}

const files = allSources();
const texts = new Map(files.map((f) => [f, fs.readFileSync(f, 'utf8')]));

console.log('\n=== 1. utils / hooks 的导出不得是死代码 ===');
{
  const targets = ['utils', 'hooks']
    .flatMap((d) => fs.readdirSync(path.join(PG, d))
      .filter((n) => /\.(ts|tsx)$/.test(n))
      .map((n) => path.join(PG, d, n)));

  const dead = [];
  for (const f of targets) {
    const s = texts.get(f) ?? fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/export (?:async )?function (\w+)|export const (\w+)/g)) {
      const n = m[1] || m[2];
      if (!n) continue;
      /* 跨全部插件找引用，排除本文件（定义处） */
      let uses = 0;
      for (const [p, txt] of texts) {
        if (p === f) continue;
        uses += (txt.match(new RegExp('\\b' + n + '\\b', 'g')) || []).length;
      }
      if (uses === 0) dead.push(`${path.relative(PG, f)}:${n}`);
    }
  }
  t('无死代码导出', dead.length === 0, dead.join(', ') || '干净');
  /* 反面证据：PRESET_COLORS 曾被误判为死代码 —— 它其实被 color-picker import */
  const cp = path.join(ROOT, 'plugins/color-picker/ColorPicker.tsx');
  const cpText = fs.existsSync(cp) ? fs.readFileSync(cp, 'utf8') : '';
  t('PRESET_COLORS 被共享色盘引用（防误删）', /PRESET_COLORS/.test(cpText));
}

console.log('\n=== 2. 已删常量不得复活 ===');
{
  const layout = fs.readFileSync(path.join(PG, 'utils/layout.ts'), 'utf8');
  /*
   * 这两个常量全库无人引用，真正在生效的是 CSS 里的值。
   * 留着两个"真源"才最坏：以后改手感的人改了 JS 常量、界面纹丝不动。
   */
  t('SPLITTER_HIT 已删（真源在 CSS）', !/export const SPLITTER_HIT/.test(layout));
  t('LAYOUT_SAVE_DEBOUNCE_MS 已删', !/export const LAYOUT_SAVE_DEBOUNCE_MS/.test(layout));
  t('注释写明为什么删（防后人加回）', /此前这里另有一个/.test(layout) && /不设防抖常量/.test(layout));
  const css = fs.readFileSync(path.join(PG, 'style.css'), 'utf8');
  t('CSS 里 8px 标为唯一真源', /唯一真源/.test(css));
  t('CSS 分隔条仍是 8px', /\.fpx-splitter\.horizontal \{ width: 8px;/.test(css));
}

console.log('\n=== 3. 文档不得残留 merge 冲突标记 ★★ ===');
{
  /*
   * 本轮发现 核对状态表.md 首行残留 `<<<<<<< 本地`、
   * 末尾还粘着一整段 base64（远端把整份文件编码后塞了进来）。
   * 文档一旦带上冲突标记就**整段不可读**，而它不会报错、
   * 也不会被任何编译/测试发现 —— 只能靠这条护栏。
   */
  const docsDir = path.resolve(ROOT, '../docs');
  const bad = [];
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(md|ts|tsx|rs|mjs|css|json)$/.test(e.name)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      if (/^<<<<<<< |^>>>>>>> |^=======\s*$/m.test(txt)) bad.push(path.relative(ROOT, p));
    }
  };
  walk(docsDir); walk(path.join(ROOT, 'plugins')); walk(path.join(ROOT, 'src-tauri/src'));
  t('无冲突标记残留', bad.length === 0, bad.join(', '));
}

console.log('\n=== 4. 状态表自身可用 ===');
{
  const p = path.resolve(ROOT, '../docs/核对状态表.md');
  const s = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  t('状态表存在且非空', s.length > 1000);
  t('首行是标题（不是冲突标记）', /^# /.test(s.trim()));
  t('无整段 base64 混入', !/[A-Za-z0-9+/]{500,}={0,2}/.test(s));
}


console.log('\n=== 5. base64 转换只有一份实现 ★ ===');
{
  /*
   * 本轮合并：PresetIconGrid 里另有一份"逐字节拼接"的 toBase64(url)，
   * utils/ico.ts 里那份是**分块**的（注释写明大数组一次性展开会爆调用栈）。
   * 两份并存 = 改一处漏一处，且说不清该信哪个。
   *
   * 判据：全插件内 `fromCharCode` 只允许出现在 utils/ico.ts。
   * 只钉"PresetIconGrid 没有 toBase64"不够 —— 换个文件再写一份就漏了。
   */
  const files = [];
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const full = path.join(d, n);
      if (fs.statSync(full).isDirectory()) { if (n !== 'preseticons') walk(full); continue; }
      if (/\.(ts|tsx)$/.test(n) && !n.includes('test')) files.push(full);
    }
  })(HERE);
  const offenders = files.filter((f) => {
    const rel = path.relative(HERE, f).replace(/\\/g, '/');
    if (rel === 'utils/ico.ts') return false;
    return /fromCharCode/.test(fs.readFileSync(f, 'utf8'));
  }).map((f) => path.relative(HERE, f).replace(/\\/g, '/'));
  t('fromCharCode 只在 utils/ico.ts', offenders.length === 0, offenders.join('、'));

  t('ico.ts 导出 urlToBase64', /export async function urlToBase64/.test(
    fs.readFileSync(path.join(HERE, 'utils/ico.ts'), 'utf8')));
  t('PresetIconGrid 走 urlToBase64', /urlToBase64\(presetIconUrl\(/.test(
    fs.readFileSync(path.join(HERE, 'components/PresetIconGrid.tsx'), 'utf8')));
}

console.log('\n=== 6. CSS 类不得是死代码（跨插件）★ ===');
{
  /*
   * style.css 被 color-picker 等共享插件**共用**，所以扫描必须跨插件。
   *
   * 本轮差点误删 fpx-mini / fpx-picker / fpx-preview-def 三个类：
   * 它们在 project-group 内部确实无人引用，但 color-picker 在用。
   * 只在插件内扫描 = 误删正在用的东西 —— 与 PRESET_COLORS 是同一个坑。
   *
   * 整词匹配：`fpx-color` 不能命中 `fpx-color-dot`（后者仍在用）。
   */
  const css = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8');
  const classes = new Set();
  for (const m of css.matchAll(/\.(fpx-[\w-]+)/g)) classes.add(m[1]);

  /*
   * 引用扫描**只算真实源码（.ts/.tsx），必须排除 .mjs 测试文件**。
   *
   * 原因（本轮实测踩到）：allSources() 会收 .mjs，而本文件注释里
   * 写着"差点误删 fpx-mini / fpx-picker / fpx-preview-def"——
   * 于是这三个类被自己的注释判定为"在用"，断言恒真 = 空跑。
   * 反向验证（把 color-picker 里唯一的 fpx-mini 引用删掉）才发现。
   *
   * 测试文件里的类名只出现在断言字符串里，不代表真实使用；
   * 真实引用只在 .tsx 的 className 中。
   */
  const src = [...texts.entries()]
    .filter(([f]) => /\.tsx?$/.test(f))
    .map(([, v]) => v)
    .join('\n');
  const dead = [];
  for (const c of classes) {
    const re = new RegExp('(?<![\\w-])' + c + '(?![\\w-])');
    if (re.test(src)) continue;
    dead.push(c);
  }
  t('style.css 无未被任何插件引用的死类', dead.length === 0, dead.join('、'));
  // 反例护栏：类名集合若为空，说明正则失效（断言恒真 = 空跑）
  t('扫描到了足量类名（正则有效）', classes.size > 50, String(classes.size));
}

done();
