/**
 * 输入法（IME）组合守卫：其余插件的同类输入框
 * ============================================================
 * 运行：node ime-guard-cross-plugin-test.mjs
 *
 * 背景（project-group 已经修过并留了 ime-guard-test）：
 * 中文 / 日文输入时，回车是「把候选词上屏」、Esc 是「取消这次组合」，
 * 都不是界面上的「确定 / 取消」。组合中浏览器照样派发 keydown。
 *
 * 那一轮的守卫只装在 **project-group 一个插件里**（11 处调用点 +
 * components/ 兜底扫描）。其余插件里形状完全一样的输入框全部裸奔，
 * 其中会**写盘 / 改名字 / 改授权范围**的有：
 *
 *   1. folder-picker 的「新建子目录」：拼音打完按回车 → 真建出一个叫拼音的
 *      目录，而用户以为自己在选词，全程没有报错。
 *   2. folder-picker 的文件夹改名：同上，落盘改名。
 *   3. agent-flow 画布页签 / 库分组改名：名字被写成拼音串并落盘。
 *   4. 设置页（两版）的授权目录、常用文件夹路径：中文路径打到一半按回车
 *      → 加进去的是拼音路径。**它不报错**：授权范围静默多一个不存在的
 *      目录，等真去读写才撞「路径越权」（错在 A、炸在 B）。
 *   5. Esc：组合期按 Esc 只是取消候选词，界面却当成「取消整个操作」。
 *
 * 本测试分四层：
 *   1. `js/ime.js` **真身行为**（import 后实跑，不是看源码形态）；
 *   2. 漂移：与 project-group 的 `utils/ime.ts` 在同一张输入表上结果一致
 *      （两份是同判据的两种写法，TS 测试加载器引不了 js，故钉行为一致）；
 *   3. 各调用点：有守卫、且守卫在 Enter / Escape 分支**之前**；
 *   4. 兜底扫描：plugins/ 下（project-group 除外，它有自己的测试）
 *      任何含 `'Enter'` 的 keydown 块都必须有守卫。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { stripCommentsJs as strip } from './test-scan-utils.mjs';
import { isComposing } from './js/ime.js';
import { loadTs } from './plugins/project-group/testkit.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const rd = (p) => { try { return readFileSync(join(ROOT, p), 'utf8'); } catch { return ''; } };
const code = (p) => strip(rd(p));

let pass = 0;
let fail = 0;
function t(name, ok) {
  if (ok) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}`); }
}

/* ── 1. js/ime.js 真身行为 ───────────────────────────────────── */
console.log('\n=== 1. js/ime.js 真身行为 ===');
{
  const f = isComposing;
  t('导出 isComposing', typeof f === 'function');
  t('组合中（isComposing=true）→ true', f({ isComposing: true }) === true);
  t('组合中（keyCode=229，无 isComposing）→ true', f({ keyCode: 229 }) === true);
  t('非组合（Enter，isComposing=false）→ false', f({ isComposing: false, keyCode: 13 }) === false);
  t('非组合（只给 keyCode=13）→ false', f({ keyCode: 13 }) === false);
  t('空对象 → false', f({}) === false);
  t('传 null → false（不抛）', f(null) === false);
  t('传 undefined → false（不抛）', f(undefined) === false);
  /* 传合成事件形状 → false：React 侧必须传 nativeEvent，否则守卫静默失效 */
  t('误传合成事件形状 → false（不该误判为组合中）', f({ key: 'Enter', target: {} }) === false);

  const src = code('js/ime.js');
  t('两条判据都在代码里（不只剩一条）',
    /isComposing === true/.test(src) && /keyCode === 229/.test(src));
}

/* ── 2. 漂移：与 project-group 的 utils/ime.ts 行为一致 ───────── */
console.log('\n=== 2. 漂移守卫：与 utils/ime.ts 同表同结果 ===');
{
  const mod = await loadTs(join(ROOT, 'plugins/project-group/utils/ime.ts'));
  const g = mod.isComposing;
  t('TS 版导出 isComposing', typeof g === 'function');
  const table = [
    { isComposing: true }, { keyCode: 229 }, { isComposing: false, keyCode: 13 },
    { keyCode: 13 }, {}, null, undefined, { key: 'Enter', target: {} },
    { isComposing: true, keyCode: 13 }, { isComposing: false, keyCode: 229 },
  ];
  const same = table.every((x) => isComposing(x) === g(x));
  t('同一张输入表结果完全一致（两份只是写法不同）★', same);
  t('表本身有区分力（不是全 false）',
    table.some((x) => isComposing(x) === true) && table.some((x) => isComposing(x) === false));
}

/* ── 3. 各调用点：有守卫且在 Enter / Escape 分支之前 ──────────── */
console.log('\n=== 3. 各输入框：守卫存在且在 Enter 之前 ===');

/** [文件, Enter 分支特征串, 说明] —— 特征串必须是**剥注释后**仍存在的代码 */
const SITES = [
  ['plugins/folder-picker/module.js', "if (e.key === 'Enter') { commitName(nameInput.value); }", '选择器：文件夹改名（写盘）'],
  ['plugins/folder-picker/module.js', "if (e.key === 'Enter') createChild(newNameEl.value);", '选择器：新建子目录（真建目录）★'],
  ['plugins/folder-picker/module.js', "if (e.key === 'Enter') go(inputEl.value.trim());", '选择器：路径回车前往'],
  ['plugins/settings/index.js', "if (e.key === 'Enter') add();", '设置页（无构建）：授权目录'],
  ['plugins/settings/index.js', "if (e.key === 'Enter') add(draftInput.value);", '设置页（无构建）：常用文件夹'],
  ['plugins/settings/FilesCard.tsx', "if (e.key === 'Enter') add();", '设置页 React：授权目录'],
  ['plugins/settings/FavDirsCard.tsx', "if (e.key === 'Enter') commitName();", '设置页 React：收藏改名'],
  ['plugins/settings/FavDirsCard.tsx', "if (e.key === 'Enter') add(draft);", '设置页 React：常用文件夹'],
  ['plugins/agent-flow/components/CanvasTabs.tsx', "if (e.key === 'Enter') commit();", '画布页签改名（写盘）'],
  ['plugins/agent-flow/components/CanvasLibrary.tsx', "if (ev.key === 'Enter') {", '库分组改名（写盘）'],
  ['plugins/agent-flow/components/DirPicker.tsx', "if (e.key === 'Enter') void load(cwd);", 'agent-flow 目录选择器'],
  ['plugins/agent-flow/components/CredentialPanel.tsx', "if (e.key === 'Enter' && unlockPass && onUnlock) onUnlock(unlockPass);", '凭据解锁'],
];

/** 取包含该特征串的那个 keydown 块：往前找最近的三种写法之一 */
function handlerOf(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  const marks = ['onKeyDown={', 'onkeydown:', "addEventListener('keydown'"];
  let best = -1;
  for (const m of marks) {
    const h = src.lastIndexOf(m, i);
    if (h > best) best = h;
  }
  if (best < 0) return '';
  return src.slice(best, i + sig.length + 120);
}

for (const [rel, sig, label] of SITES) {
  const src = code(rel);
  const h = handlerOf(src, sig);
  t(`${label}：找到该 keydown 块`, h.length > 0, rel);
  if (!h) continue;
  /* React 侧必须传 nativeEvent；原生侧直接传 e */
  const isReact = rel.endsWith('.tsx');
  const gi = h.indexOf(isReact ? 'nativeEvent)' : 'isComposing(e)');
  const ei = h.indexOf(sig);
  /* 两端判存在：indexOf 返回 -1 时 `-1 < 正数` 恒真，会看着像"顺序正确" */
  t(`${label}：有守卫（${isReact ? '传 nativeEvent' : '传原生事件'}）`, gi >= 0);
  t(`${label}：守卫在 Enter 分支之前`, gi >= 0 && ei >= 0 && gi < ei);
}

/* ── 4. 兜底扫描：plugins/ 下没有漏网的 ──────────────────────── */
console.log('\n=== 4. 兜底：plugins/ 下所有 Enter 分支都有守卫 ===');
{
  /*
   * 豁免：**非输入元素**（div[role=button] 用 Enter/Space 激活）。
   * 输入法只在可编辑元素上进入组合态，焦点在这个 div 上时不可能在组合，
   * 加守卫是死代码。不禁的话它会报假红 —— 而"让红消失"最省事的做法
   * 恰恰是去给不该动的地方加一行守卫，那比假红本身更像真的修好了。
   */
  const EXEMPT = [{ sig: "if (e.key === 'Enter' || e.key === ' ') {", why: 'div[role=button]，非输入元素' }];
  const missing = [];
  let checked = 0;
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${name.name}`;
      if (name.isDirectory()) {
        if (name.name === 'node_modules' || name.name === 'project-group') continue;
        walk(rel);
        continue;
      }
      if (!/\.(tsx|jsx)$/.test(name.name)) continue;   /* 只扫 React 组件：形态一致才判得准 */
      const src = code(rel);
      let from = 0;
      for (;;) {
        const h = src.indexOf('onKeyDown={', from);
        if (h < 0) break;
        const end = src.indexOf('}}', h);
        const block = src.slice(h, end < 0 ? h + 900 : end + 2);
        from = h + 11;
        if (!block.includes("'Enter'")) continue;
        checked++;
        const gi = block.indexOf('isComposing(');
        const ei = block.indexOf("'Enter'");
        if (gi >= 0 && gi <= ei) continue;
        if (EXEMPT.some((x) => block.includes(x.sig))) continue;
        missing.push(`${relative(ROOT, join(ROOT, rel))}@${h}`);
      }
    }
  };
  walk('plugins');
  t('扫到的 Enter 分支数 ≥ 6', checked >= 6, `实际 ${checked}`);
  t('没有漏网的（缺守卫 / 守卫写在后面）★', missing.length === 0, missing.join(', '));
}

/* ── 5. 引用关系：js/ime.js 被真正引用（不是死文件）──────────── */
console.log('\n=== 5. js/ime.js 被引用 ===');
{
  const files = [...new Set(SITES.map((s) => s[0]))];
  let imported = 0;
  for (const rel of files) {
    const s = code(rel);
    if (/from '(\.\.\/)+js\/ime\.js'/.test(s) || /from '\.\.\/\.\.\/\.\.\/js\/ime\.js'/.test(s)) imported++;
  }
  t(`${files.length} 个文件全部 import 了 js/ime.js`, imported === files.length, `${imported}/${files.length}`);
  t('js/ime.js 存在', existsSync(join(ROOT, 'js/ime.js')));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);
