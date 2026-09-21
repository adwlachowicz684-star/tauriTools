/**
 * 「展开 / 收回」契约测试
 * ------------------------------------------------------------------
 * 起因（用户报的）：点一个按钮展开东西，再点同一个按钮**不会收回去**，
 * 面板就一直挂在界面上。典型是思维导图的导出按钮 ——
 * 点开导出格式列表后再点，列表不收，只能去别处乱点才能关掉。
 *
 * 这类问题难在**没报错**：功能看起来是好的（能展开），
 * 只是再也收不回去。手测时点一次就走了，根本不会点第二次。
 *
 * 所以扫**全仓**的"只开不关"按钮，逐个要求它给出收回路径。
 *
 * ==================================================================
 * 排查结论（2026-09）
 * ==================================================================
 *
 * 全仓 `onClick` 里直接 `setXxx(true)` 的共 6 处，分三类：
 *
 *   A. 整页替换 / 模态 —— 打开后原按钮不可见，由弹窗自己关闭
 *      · setManaging / setClientsOpen（SettingsDialog，`if (x) return <...>`）
 *      · setPicking（dialogs.tsx，渲染 <DirDialog>，自带取消）
 *      · setHelp（project-group，覆盖态，打开时别的快捷键都禁用）
 *
 *   B. 模式类 —— 按钮展开后**自身 disabled**，靠 Esc 退出
 *      · setArmed（吸管取色）
 *      为什么按钮要 disabled 而不是"再点取消"：armed 时点击页面任意处
 *      = 取样。若按钮仍可点，点它会同时触发"取样"和"取消"，
 *      两个意图打架。Esc 才是这里正确的退出手势。
 *
 *   C. 折叠展开（▾/▸）—— 6 处，已全部是 `setX(!x)` toggle，正确
 *
 * 思维导图导出按钮：顶栏那 7 个（导入/导出▾/XMIND/TXT/MD/SVG/PNG）
 * 已收进侧栏「导入导出」页，不再是展开式按钮 —— 该问题已随重构消失。
 *
 * 这个测试守的是：**以后新增的展开按钮不能再犯**。
 */

import { readFileSync } from 'node:fs';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 递归收集文件（不依赖 glob，node:fs 的 globSync 要更高版本才有） */
function walk(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist') continue;
    const p = join(dir, e);
    try {
      if (statSync(p).isDirectory()) walk(p, out);
      else out.push(p);
    } catch { /* 忽略权限等异常 */ }
  }
  return out;
}

let pass = 0;
const fails = [];
function t(name, cond, detail = '') {
  if (cond) { pass++; console.log(`✅ ${name}${detail ? ` → ${detail}` : ''}`); }
  else { fails.push(name); console.log(`❌ ${name}${detail ? ` → ${detail}` : ''}`); }
}

/* 收集所有前端源文件 */
const files = [...walk('plugins'), ...walk('src')]
  .filter((f) => /\.(tsx|jsx|js|ts)$/.test(f))
  .filter((f) => !f.includes('-test.') && !f.endsWith('.d.ts'));

console.log(`\n扫描 ${files.length} 个源文件\n`);
console.log('=== 1. 「只开不关」的按钮必须给出收回路径 ===');

const offenders = [];
const classified = [];

for (const f of files) {
  let s;
  try { s = readFileSync(f, 'utf8'); } catch { continue; }

  /* 找 onClick={ ... setX(true) } —— 这类按钮点第二次不会收回 */
  for (const m of s.matchAll(/onClick=\{[^}]{0,200}?set(\w+)\(\s*true\s*\)/g)) {
    const name = m[1];
    const lower = name.charAt(0).toLowerCase() + name.slice(1);
    const bodyStart = m.index;

    /* ① 同一次 onClick 里就有 toggle / 三目 → 已经是"再点收回" */
    if (/set\w+\(\s*!/.test(m[0])) continue;

    /* ② 同文件里有 setX(false) → 别处能关（弹窗的取消/关闭） */
    const hasFalse = new RegExp('set' + name + '\\(\\s*false\\s*\\)').test(s);

    /* ②b setter 作为 props 下传（如 `setHelp={setHelp}`）→
       关闭逻辑在子组件里，本文件当然搜不到 setX(false)。
       漏了这条会把「子组件能关」误判成「关不掉」（实测误报过一次）。 */
    const passedAsProp = new RegExp('set' + name + '=\\{').test(s);

    /* ③ 该 state 是 early-return（整页替换，打开后原按钮不存在） */
    const earlyReturn = new RegExp(
      'if\\s*\\(\\s*' + lower + '\\s*\\)\\s*\\{?\\s*\\n?\\s*return').test(s);

    /* ④ 按钮在该 state 下 disabled → 模式类（如吸管 armed），点不到第二次 */
    /*    就近看这个 onClick 所在元素的 disabled 属性 */
    const near = s.slice(Math.max(0, bodyStart - 400), bodyStart + 200);
    const selfDisabled = /disabled=\{[^}]{0,80}\|\|?\s*\w*armed\w*/.test(near)
      || /disabled=\{[^}]{0,80}armed/.test(near);

    /* ⑤ Esc 退出（模式类的正规退出口） */
    const hasEsc = /Escape/.test(s);

    if (hasFalse || earlyReturn || passedAsProp) {
      const how = hasFalse ? '别处可关(false)'
        : earlyReturn ? '整页替换' : 'setter 下传子组件';
      classified.push({ f, name, how });
    } else if (selfDisabled && hasEsc) {
      classified.push({ f, name, how: '模式类(disabled+Esc)' });
    } else {
      offenders.push(`${f}  set${name}(true)`);
    }
  }
}

t('没有「点了展开却收不回去」的按钮', offenders.length === 0,
  offenders.length ? offenders.join(' | ') : `${classified.length} 处都有收回路径`);

console.log('\n  已分类（都有退路）：');
for (const c of classified) {
  console.log(`    · ${c.f.split('/').pop()}  set${c.name}  → ${c.how}`);
}

console.log('\n=== 2. 折叠展开（▾/▸）必须是 toggle，不是只设 true ===');
/*
 * 有 ▾/▸ 就说明这是个**就地展开**的区域：按钮一直在那儿，
 * 用户自然会点第二下。此时只设 true 就是 bug。
 */
const caretFiles = [];
for (const f of files) {
  let s;
  try { s = readFileSync(f, 'utf8'); } catch { continue; }
  if (!/[▾▸▼▶]/.test(s)) continue;
  caretFiles.push(f);
}
t('存在折叠展开的界面（说明这条规则有实际管辖对象）', caretFiles.length > 0,
  `${caretFiles.length} 个文件带展开箭头`);

const caretBad = [];
for (const f of caretFiles) {
  const s = readFileSync(f, 'utf8');
  /* 找形如 open ? '▾' : '▸' 的箭头，抓出那个状态名 */
  for (const m of s.matchAll(/(\w+)\s*\?\s*'▾'\s*:\s*'▸'/g)) {
    const v = m[1];
    const setter = 'set' + v.charAt(0).toUpperCase() + v.slice(1);
    /* a) 直接 toggle：setOpen(!open) —— 最常见的正确写法 */
    if (new RegExp(setter + '\\(\\s*!').test(s)) continue;
    if (new RegExp(setter + '\\(\\s*[^)]*\\?').test(s)) continue;

    /* b) 派生自「折叠集合」：open = !collapsed.has(key)
       ------------------------------------------------------------------
       多项可同时展开时，展开态存在 **Set** 里而不是单个 boolean，
       于是切换是 toggle(key) → setCollapsed(...)，而不是 setOpen(!open)。
       只看变量名会把它误判成"收不回去"（实测误报过一次）。
       两向的证明：对集合既有 .add（折叠）又有 .delete（展开）。 */
    const derived = s.match(new RegExp('const\\s+' + v + '\\s*=\\s*!(\\w+)\\.has\\('));
    if (derived) {
      const cs = 'set' + derived[1].charAt(0).toUpperCase() + derived[1].slice(1);
      const hasSetter = new RegExp(cs + '\\s*\\(').test(s);
      const twoWay = /\.delete\(/.test(s) && /\.add\(/.test(s);
      if (hasSetter && twoWay) continue;
    }

    /* c) 箭头变量**本身就是集合**（expanded.has(id)），切换走回调 onToggle。
       与 b) 的差别：b) 里 open 是从「折叠集合」取反派生出来的局部变量，
       这里 expanded 直接就是那个集合，且开关由父组件给的回调负责。
       判据：以 .has() 使用 + 存在 toggle 语义的回调。 */
    const usedAsSet = new RegExp(v + '\\.has\\(').test(s);
    const hasToggleCb = /onToggle/.test(s) || /toggle/i.test(s);
    if (usedAsSet && hasToggleCb) continue;

    caretBad.push(`${f.split('/').pop()}  ${v}`);
  }
}
t('带展开箭头的区域都支持再点收回', caretBad.length === 0,
  caretBad.length ? caretBad.join(' | ') : '全部为 toggle');

console.log(`\n${'='.repeat(52)}`);
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败项：' + fails.join('、'));
  process.exit(1);
}
