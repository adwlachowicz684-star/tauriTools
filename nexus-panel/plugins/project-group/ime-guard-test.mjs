/**
 * 输入法（IME）组合守卫回归测试
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/ime-guard-test.mjs
 *
 * 背景：中文 / 日文输入时，回车是「把候选词上屏」、Esc 是「取消这次组合」，
 * 都不是界面上的「确定 / 取消」。组合中浏览器照样派发 keydown，
 * 不拦的后果最重的一条是**改名弹窗按回车选词 → 文件夹被改名成拼音串**，
 * 磁盘上真多出一个叫 xinmingcheng 的目录，而用户以为自己在选词。
 *
 * 这个测试分三层：
 *   1. `utils/ime.ts` **真身行为**（loadTs 加载后实跑，不是看源码形态）；
 *   2. 11 处调用点逐一钉「有守卫」且「守卫在 Enter 分支**之前**」——
 *      写在后面等于没有；
 *   3. 兜底扫描：components/ 下**任何**含 `e.key === 'Enter'` 的
 *      onKeyDown 都必须有守卫，以后新加的输入框也逃不掉。
 *
 * 每条都做了反向验证（撤掉守卫 / 挪到后面 / 只留一条判据 → 必须变红）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMP = path.join(HERE, 'components');
const { t, done } = makeT();

const rd = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
/** 剥注释：注释里写的反例会把形态断言带偏（这个项目踩过很多次） */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

/* ── 1. utils/ime.ts 真身行为 ────────────────────────────────── */
console.log('\n=== 1. isComposing 真身行为（loadTs 实跑）===');
{
  const mod = await loadTs(path.join(HERE, 'utils/ime.ts'));
  const f = mod.isComposing;
  t('导出 isComposing', typeof f === 'function');

  /*
   * 实参是**原生事件**（调用点写 `isComposing(e.nativeEvent)`），
   * 因为 React 合成键盘事件不转发 isComposing —— 传合成事件会拿到 false，
   * 也就是守卫静默失效。下面这几条同时把"传错会怎样"钉住。
   */
  t('组合中（isComposing=true）→ true', f({ isComposing: true }) === true);
  t('组合中（keyCode=229，无 isComposing）→ true', f({ keyCode: 229 }) === true);
  t('非组合（Enter，isComposing=false）→ false',
    f({ isComposing: false, keyCode: 13 }) === false);
  t('非组合（只给 keyCode=13）→ false', f({ keyCode: 13 }) === false);
  t('空对象 → false', f({}) === false);
  t('传 null → false（不抛）', f(null) === false);
  t('传 undefined → false（不抛）', f(undefined) === false);
  /* 反面：合成事件上没有这两个字段 → false（所以调用点必须传 nativeEvent） */
  t('误传合成事件形状 → false（不该误判为组合中）',
    f({ key: 'Enter', target: {} }) === false);

  /*
   * 反向验证用过的一条：只认 isComposing、丢掉 keyCode 229 的那版，
   * 在这条上会返回 false —— 而那些只给 229 的环境正是靠它才拦得住的。
   */
  /*
   * 必须**剥注释后再判**：文档注释里也写着 `keyCode === 229` 这几个字，
   * 整行删掉后按原文匹配照样命中 —— 断言看着在跑，其实永远绿。
   * （这是本项目第 N 次撞"注释里的字样把断言喂饱"。）
   */
  const imeSrc = strip(rd(path.join(HERE, 'utils/ime.ts')));
  t('两条判据都在代码里（不只剩一条）',
    /isComposing === true/.test(imeSrc) && /keyCode === 229/.test(imeSrc));
}

/* ── 2. 11 处调用点：有守卫且在前 ────────────────────────────── */
console.log('\n=== 2. 各输入框：守卫存在且在 Enter 分支之前 ===');

/** 每处给一个唯一的「Enter 分支」特征串 */
const SITES = [
  ['components/CardGrid.tsx', "if (e.key === 'Enter') endEdit(true);", '页签改名'],
  ['components/DirDialog.tsx', "if (e.key === 'Enter') load(input.trim());", '手工路径'],
  ['components/LinkPanel.tsx', "if (e.key === 'Enter') { e.currentTarget.blur(); return; }", '链接名改名行'],
  ['components/LinkPanel.tsx', "if (e.key === 'Enter') { e.preventDefault(); addCustom(); }", '自定义链接名'],
  ['components/RenameContentDialog.tsx', "if (e.key === 'Enter') void submit();", '内容改名（写盘）'],
  ['components/RenameDialog.tsx', "if (e.key === 'Enter') void submit();", '文件夹改名（写盘）'],
  ['components/StackedGroups.tsx', "if (e.key === 'Enter') e.currentTarget.blur();", '分类改名'],
  ['components/TabManagerDialog.tsx', "if (e.key === 'Enter') { e.preventDefault(); void commitEdit(); }", '页签管理改名'],
  ['components/ToolsPanel.tsx', "if (e.key === 'Enter') pick(e.currentTarget.value.trim());", '编辑器路径'],
  ['components/dialogCards.tsx', "if (e.key === 'Enter' && name.trim()) submit();", '新建目录（写盘）'],
  ['components/ChainActionsPanel.tsx', "if (e.key === 'Tab' || e.key === 'Enter') return;", '快捷键录入'],
];

/** 取包含该特征串的那个 onKeyDown 块（往前找最近的 onKeyDown={，往后切一段） */
function handlerOf(src, sig) {
  const i = src.indexOf(sig);
  if (i < 0) return '';
  const h = src.lastIndexOf('onKeyDown={', i);
  if (h < 0) return '';
  return src.slice(h, i + sig.length + 200);
}

for (const [rel, sig, label] of SITES) {
  const src = strip(rd(path.join(HERE, rel)));
  const h = handlerOf(src, sig);
  t(`${label}：找到该 onKeyDown 块`, h.length > 0, rel);
  if (!h) continue;
  const gi = h.indexOf('isComposing(e.nativeEvent)');
  const ei = h.indexOf(sig);
  /* 两端判存在：indexOf 返回 -1 时 `-1 < 正数` 恒真，会看着像"顺序正确" */
  t(`${label}：有守卫`, gi >= 0);
  t(`${label}：守卫在 Enter 分支之前`, gi >= 0 && ei >= 0 && gi < ei);
}

/* ── 3. 兜底扫描：不允许有漏网的 ─────────────────────────────── */
console.log('\n=== 3. 兜底：components/ 下所有 Enter 分支都有守卫 ===');
{
  const files = fs.readdirSync(COMP).filter((n) => n.endsWith('.tsx'));
  const missing = [];
  let checked = 0;
  for (const n of files) {
    const src = strip(rd(path.join(COMP, n)));
    /* 逐个 onKeyDown 块看：块内出现 e.key === 'Enter' 就必须有守卫 */
    let from = 0;
    for (;;) {
      const h = src.indexOf('onKeyDown={', from);
      if (h < 0) break;
      const end = src.indexOf('}}', h);
      const block = src.slice(h, end < 0 ? h + 900 : end + 2);
      from = h + 11;
      if (!block.includes("e.key === 'Enter'")) continue;
      checked++;
      const gi = block.indexOf('isComposing(e.nativeEvent)');
      const ei = block.indexOf("e.key === 'Enter'");
      if (gi < 0 || gi > ei) missing.push(`${n}@${h}`);
    }
  }
  t('扫到的 Enter 分支数 ≥ 11', checked >= 11, `实际 ${checked}`);
  t('没有漏网的（缺守卫 / 守卫写在后面）', missing.length === 0, missing.join(', '));
}

/* ── 4. 引用关系 ─────────────────────────────────────────────── */
console.log('\n=== 4. utils/ime.ts 被真正引用（不是死文件）===');
{
  const refs = [...new Set(SITES.map((s) => s[0]))];
  let imported = 0;
  for (const rel of refs) {
    const s = strip(rd(path.join(HERE, rel)));
    if (s.includes("from '../utils/ime'")) imported++;
  }
  t(`${refs.length} 个组件全部 import 了 ime`, imported === refs.length, `${imported}/${refs.length}`);
  t('utils/ime.ts 存在', fs.existsSync(path.join(HERE, 'utils/ime.ts')));
}

done();
