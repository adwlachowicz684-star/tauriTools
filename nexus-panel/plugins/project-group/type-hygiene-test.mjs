/**
 * 类型卫生回归测试（对应 project-group 类型错误清单 49 处）
 *
 * 背景：沙箱里装不上 tsc（`npm install typescript` 装完 node_modules 是空的），
 * 所以这六类错误**无法靠类型检查发现**，只能写成静态断言钉住。
 *
 * 每一条都做过反向验证（把修复回退后断言必须变红）。
 * 特别注意：**断言必须限定作用域** —— 全文 replace 经常命中另一处
 * 同形态代码，造成"看着在测、其实没测到"的漏报。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * **不能用 `process.cwd()` 定位**。
 *
 * 原来写的是 `join(process.cwd(), 'plugins/project-group')`，于是这个文件的
 * 结论取决于"从哪个目录敲 node"：从 nexus-panel 跑正常，从插件目录跑就
 * `readdirSync` 抛 ENOENT —— 整个文件一条断言都没执行就挂掉。
 *
 * 这类"跑不出来"最要命：回归脚本若只看退出码非 0 会当成环境噪音略过，
 * 于是这 22 条护栏在不知不觉中全部失效。按文件自身位置定位，与本项目
 * 其它测试一致，任何 cwd 下结论都一样。
 */
const PG = dirname(fileURLToPath(import.meta.url));
const COMP = join(PG, 'components');

let pass = 0;
let fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  ❌ ' + m); } };
const head = (t) => console.log('\n── ' + t);

const rd = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
const src = (rel) => rd(join(PG, rel));
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
/** 只取某一行之后的正文，避免注释里的反例把断言带偏 */
const after = (s, needle) => { const i = s.indexOf(needle); return i < 0 ? '' : s.slice(i); };

/* ── 一、TS1261 文件名仅大小写不同 ───────────────────────────── */
head('TS1261 同目录不存在仅大小写不同的文件');
{
  const names = readdirSync(COMP).filter((n) => n.endsWith('.tsx') || n.endsWith('.ts'));
  const lower = new Map();
  const clash = [];
  for (const n of names) {
    const k = n.toLowerCase();
    if (lower.has(k)) clash.push(n + ' × ' + lower.get(k));
    else lower.set(k, n);
  }
  ok(clash.length === 0, '存在仅大小写不同的文件：' + clash.join('、'));

  // 反例：真出现两个同名不同大小写文件时必须被抓到
  const fake = ['dialogs.tsx', 'Dialogs.tsx'];
  const m2 = new Map();
  const c2 = [];
  for (const n of fake) {
    const k = n.toLowerCase();
    if (m2.has(k)) c2.push(n);
    else m2.set(k, n);
  }
  ok(c2.length === 1, '反例：大小写冲突检测器自身失效');
}

/* ── 二、TS2304 未定义标识符 setConfirmLink ──────────────────── */
head('TS2304 子组件不得引用 App 的 setConfirmLink');
{
  const app = src('App.tsx');
  ok(app.includes('const [confirmLink, setConfirmLink]'), 'App.tsx 里应当定义 setConfirmLink');

  // 只在 App.tsx 内出现；其它文件若用到，必须是**自己声明的 prop**，
  // 否则就是引用了外层不存在的标识符 → ReferenceError。
  // 注意：不能只查"是否出现过"——DialogsHub 把它声明成 prop 是正确写法。
  const others = [];
  // 注意：必须指向**真实存在**的文件。早先写的是 Column.tsx（本版没有这个文件），
  // 于是 `!col || ...` 恒为真 —— 断言空跑，反向验证才发现。
  for (const f of ['components/CardGrid.tsx', 'components/DialogsHub.tsx', 'components/dialogCards.tsx', 'components/StackedGroups.tsx']) {
    const raw = src(f);
    if (!raw) continue;
    const t = strip(raw);
    if (!/\bsetConfirmLink\b/.test(t)) continue;
    const declared = /^\s*setConfirmLink\s*[?]?\s*:/m.test(t) || /\bsetConfirmLink\s*,/m.test(t);
    if (!declared) others.push(f);
  }
  ok(others.length === 0, '子组件引用了未声明的 setConfirmLink（会 ReferenceError）：' + others.join('、'));

  // 卡片组件必须走 onEditLink prop，不能自己引用 App 的 setter
  const grid = src('components/CardGrid.tsx');
  // 必须整词匹配：`includes('onEditLink')` 会被 `onEditLinkX` 命中，等于没测
  ok(/\bonEditLink\b/.test(grid), 'CardGrid 应通过 onEditLink 回调改链接名（不得直接引用 App 的 setter）');
}

/* ── 三、TS18047 boot 判空未生效 ─────────────────────────────── */
head('TS18047 boot 不得解构，且先判空再使用');
{
  const body = strip(src('components/DialogsHub.tsx'));
  ok(!/const\s*\{\s*[^}]*\bboot\b[^}]*\}\s*=\s*s\b/.test(body),
    '不得从 s 解构 boot（解构后 s.boot 的判空窄化传递不到局部变量）');

  const decl = body.indexOf('const boot = s.boot');
  ok(decl > 0, '应当有 const boot = s.boot');
  // 守卫有两种写法：`if (!boot)` 与 `if (!selPath || !boot)`，都要认
  const gm = /if\s*\([^)]*!boot\b/.exec(body.slice(decl));
  const guard = gm ? decl + gm.index : -1;
  ok(guard > decl, 'boot 的判空必须出现在声明之后');

  // 第一次 boot.xxx 之前必须有守卫。注意不能匹配 `s.boot.xxx`——
  // 那会命中守卫自身所在的那一行，导致断言永远为真（漏报）。
  const firstUse = body.slice(decl).search(/(^|[^.\w])boot\.\w/);
  const firstUseAbs = decl + (firstUse < 0 ? 0 : firstUse);
  ok(firstUse > 0 && firstUseAbs > guard, '首次使用 boot.xxx 之前必须先判空（否则 boot 为 null 时崩）');
}

/* ── 四、TS2339 + ?? 与 ?: 优先级 ────────────────────────────── */
head('TS2339 dialog.card 必须收窄；?? 与 ?: 必须加括号');
{
  const hub = src('components/DialogsHub.tsx');
  const body = strip(hub);

  // 每一处 dialog.card 都必须处在 dialog.type === '...' 的收窄之后。
  //
  // 「限定作用域」的经验值：JSX 块形如 `{dialog.type === 'lock' && (`，
  // 块内第一个 dialog.card 距守卫最远约 550 字符（实测 style 块 547）。
  // 窗口取 700：既能覆盖真实块长，又小到"删掉某个守卫会落到上一个块的守卫之外"。
  // 早先用 140 字符窗口，把 11 处合法收窄误判成未收窄。
  const WINDOW = 700;
  const KINDS = ['lock', 'remove', 'rename', 'move', 'style', 'icons', 'create', 'pickDir'];
  let bad = 0;
  let i = -1;
  while ((i = body.indexOf('dialog.card', i + 1)) >= 0) {
    const ctx = body.slice(Math.max(0, i - WINDOW), i);
    const m = [...ctx.matchAll(/dialog\.type\s*===\s*'([^']*)'/g)];
    const last = m.length ? m[m.length - 1] : null;
    if (!last || !KINDS.includes(last[1])) bad++;
  }
  ok(bad === 0, `有 ${bad} 处 dialog.card 未收窄（或收窄成了不含 card 的 kind）`);

  // 裸 `??` 后紧跟三元且没有括号 —— 那是"条件变成字符串"的必崩写法
  const naive = /\?\?\s*[^()\n]*?\s*===\s*'[^']*'\s*\?/;
  ok(!naive.test(body), '存在未加括号的 `?? … ? :`（条件会变成字符串，选中卡片即崩）');

  // 修好的写法：?? 后的三元要用括号包住
  ok(/\?\?\s*\(dialog\.type\s*===/.test(body), '?? 后的三元应当用括号包住');
}

/* ── 五、TS2345 类型不匹配 ───────────────────────────────────── */
head('TS2345 HotkeyId 收窄 / TabItem 与 TabInfo 不得混用');
{
  const hint = strip(src('utils/hint.ts'));
  // 每一处 effectiveCombo 之前都要有 isHotkeyId 守卫
  let bad = 0;
  let i = -1;
  while ((i = hint.indexOf('effectiveCombo(', i + 1)) >= 0) {
    const ctx = hint.slice(Math.max(0, i - 160), i);
    if (!/isHotkeyId\(/.test(ctx)) bad++;
  }
  ok(bad === 0, `hint.ts 有 ${bad} 处 effectiveCombo 未经 isHotkeyId 收窄`);

  const app = strip(src('App.tsx'));
  let bad2 = 0;
  let j = -1;
  while ((j = app.indexOf('effectiveCombo(', j + 1)) >= 0) {
    const ctx = app.slice(Math.max(0, j - 160), j);
    if (!/isHotkeyId\(/.test(ctx)) bad2++;
  }
  ok(bad2 === 0, `App.tsx 有 ${bad2} 处 effectiveCombo 未经 isHotkeyId 收窄`);

  // 不允许用 as any 抹平（那会把"字段名改了"这类真问题藏起来）
  ok(!/\bas\s+any\b/.test(app), 'App.tsx 不得出现 as any');
  ok(!/\bas\s+any\b/.test(strip(src('hooks/useFpx.ts'))), 'useFpx.ts 不得出现 as any');

  // 两个页签类型必须区分清楚：TabItem=配置里的纯路径，TabInfo=带卡片详情
  const types = src('types.ts');
  const blk = (name) => {
    const k = types.indexOf('export interface ' + name);
    if (k < 0) return '';
    const e = types.indexOf('\n}', k);
    return types.slice(k, e < 0 ? types.length : e);
  };
  ok(/items:\s*string\[\]/.test(blk('TabItem')), 'TabItem.items 应为 string[]（配置里存路径）');
  ok(/items:\s*CardInfo\[\]/.test(blk('TabInfo')), 'TabInfo.items 应为 CardInfo[]（界面用的详情）');
}

/* ── 六、TS2722 可能为 undefined 的调用 ──────────────────────── */
head('TS2722 可选回调必须用 ?.()');
{
  const sd = strip(src('components/SettingsDialog.tsx'));
  // 每个可选 prop（onXxx?:）在其调用点都要用 ?.(
  const opts = [...sd.matchAll(/^\s*(on[A-Z]\w*)\?:/gm)].map((m) => m[1]);
  const plain = [];
  for (const p of opts) {
    const re = new RegExp('(?<!\\?)\\b' + p + '\\s*\\(', 'g');
    let m;
    while ((m = re.exec(sd))) {
      // 允许 ?.( 与 ?.() 之前带 ? 的形式；命中即为直接调用
      const before = sd.slice(Math.max(0, m.index - 2), m.index + p.length);
      if (!before.includes('?.')) plain.push(p);
    }
  }
  ok(plain.length === 0, '可选 prop 被直接调用（可能 undefined 时崩）：' + [...new Set(plain)].join('、'));
  ok(opts.length > 0, '应当至少有一个可选回调 prop（否则说明扫描方式失效）');
  ok(/onResetLayout\?\.\(\)/.test(sd), 'onResetLayout 应当用 ?.() 调用');
}

/* ── 七、环境产物：CSS 副作用导入不算错误 ────────────────────── */
head('TS2882 CSS 副作用导入属环境产物');
{
  const main = src('main.tsx');
  ok(main.includes("from '../../css/neumorphism.css'") || main.includes("neumorphism.css"),
    'main.tsx 应保留 CSS 副作用导入（vite 构建需要，不算类型错误）');
}

console.log(`\n类型卫生：通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
