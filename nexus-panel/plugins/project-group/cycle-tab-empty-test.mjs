/**
 * 翻分类（Ctrl/⌘+Tab）翻到空目标时必须飘字提示
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/cycle-tab-empty-test.mjs
 *
 * 为什么值得单开一个文件：
 *   项目组栏改成纵向堆叠后，所有分类同时在屏幕上，切「当前页签」没有
 *   可见效果 —— 翻页是靠"把选中项移到下一个分类的第一张卡片"来体现的。
 *   于是翻到一个**空分类**时什么都设不上，界面毫无变化，而用户最自然的
 *   归因是"这个快捷键坏了"。
 *
 * 跑真身：把 cycleTab 从 App.tsx 里切出来实际执行，不是断言"源码里有
 * ctx.toast 这几个字" —— 后者证明不了空分类时它真的会被调到。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
import { stripCommentsJs } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const app = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8');

/** 剥注释：断言必须落在真实代码上，注释里的字样会把断言喂饱 */
/* 走全仓共用的 test-scan-utils，别再在本文件内联一份（有守卫盯着内联副本数）。
   注意它剥行注释用的是更严格的 `(^|\s)//` 判据 —— 不会误伤 URL 里的斜杠。 */
const stripComments = (s) => stripCommentsJs(s);

const FN = 'const cycleTab = (kind: CardKind, delta: number) => {';
const i = app.indexOf(FN);
if (i < 0) {
  console.error('找不到 cycleTab，测试无法进行');
  process.exit(1);
}
const raw = app.slice(i, app.indexOf('\n  };', i) + 5);
const code = stripComments(raw)
  .replace('(kind: CardKind, delta: number) =>', '(kind, delta) =>');

/**
 * 造一份环境并实例化 cycleTab。
 * tabs 传给当前 kind 那一侧；另一侧留空（cycleTab 只读 kind 对应的那一份）。
 */
function makeEnv(kind, tabs, activeTab = 0) {
  const calls = { toast: [], setActiveTab: [], setSelGroup: [], setFocus: [] };
  const boot = {
    projectTabs: kind === 'project' ? tabs : [],
    groupTabs: kind === 'group' ? tabs : [],
  };
  const s = {
    activeTab: { project: 0, group: 0, [kind]: activeTab },
    /*
     * 必须真的把新状态写回 s.activeTab —— 真实 React 里下一次调用读到的
     * 是更新后的值。只 push 不更新的话，连按两下会一直从同一个起点算，
     * 于是"回环"永远验不到（替身行为与框架不符，比写错的断言更隐蔽）。
     */
    setActiveTab: (f) => {
      s.activeTab = f(s.activeTab);
      calls.setActiveTab.push(s.activeTab);
    },
    setSelGroup: (p) => calls.setSelGroup.push(p),
  };
  const ctx = { toast: (m, k) => calls.toast.push({ m, k }) };
  const fn = new Function(
    'boot', 's', 'ctx', 'setFocus',
    `${code}\n return cycleTab;`,
  )(boot, s, ctx, (v) => calls.setFocus.push(v));
  return { fn, calls };
}

const tab = (name, items) => ({ name, items });

console.log('\n=== 1. 翻到空分类必须飘字 ★ ===');
{
  const { fn, calls } = makeEnv('group', [
    tab('在用', [{ path: 'D:/a' }]),
    tab('归档', []),
  ], 0);
  fn('group', 1);
  t('空分类时飘字了', calls.toast.length === 1);
  t('飘的是 info（不是失败）', calls.toast[0]?.k === 'info');
  t('文案点名是哪个分类', /归档/.test(calls.toast[0]?.m ?? ''));
  t('文案说明是空的', /没有项目组/.test(calls.toast[0]?.m ?? ''));
}

console.log('\n=== 2. 空分类不能当成"选中了" ★ ===');
{
  const { fn, calls } = makeEnv('group', [tab('归档', [])], 0);
  fn('group', 1);
  /* 设不上就不许设：否则选中项与"翻到的分类"对不上，
     之后的改名 / 改色 / 删除会作用到别的卡片上 */
  t('没有设选中', calls.setSelGroup.length === 0);
  t('没有抢焦点', calls.setFocus.length === 0);
}

console.log('\n=== 3. 非空分类照常跳，且不多嘴 ★ ===');
{
  const { fn, calls } = makeEnv('group', [
    tab('在用', [{ path: 'D:/a' }, { path: 'D:/b' }]),
    tab('归档', []),
  ], 0);
  fn('group', 1); // 0 → 1（归档，空）→ 飘字
  fn('group', 1); // 1 → 0（回环到「在用」）
  t('落到该分类的第一张', calls.setSelGroup[calls.setSelGroup.length - 1] === 'D:/a');
  t('把焦点带过去了', calls.setFocus.includes('group'));
  /* 反过来也要成立：能跳的时候弹提示，等于每次翻页都闪一下 */
  t('只飘了空分类那一次', calls.toast.length === 1);
  t('飘的是空分类，不是能跳的那个', /归档/.test(calls.toast[0]?.m ?? ''));
}

console.log('\n=== 4. 只有一个分类也要说清楚 ★ ===');
{
  const { fn, calls } = makeEnv('group', [tab('在用', [{ path: 'D:/a' }])], 0);
  fn('group', 1);
  /*
   * 与"翻到空分类"是同一类：按下去毫无反应。只修其中一个，
   * 等于留一半"快捷键失灵"的场景。
   */
  t('飘字了', calls.toast.length === 1);
  t('文案说明只有一个', /只有一个/.test(calls.toast[0]?.m ?? ''));
  t('既然没得翻就不动页签', calls.setActiveTab.length === 0);
}

console.log('\n=== 5. 项目栏不额外提示（切页签本身可见）★ ===');
{
  const { fn, calls } = makeEnv('project', [
    tab('第一页', [{ path: 'D:/a' }]),
    tab('第二页', []),
  ], 0);
  fn('project', 1);
  /*
   * 项目栏切页签有高亮变化、列表也跟着变，空页签也看得见是空的 ——
   * 在这里飘字是噪音，会把"翻到空分类"那句真正有用的提示稀释掉。
   */
  t('项目栏翻到空页签不飘字', calls.toast.length === 0);
  t('页签确实切了', calls.setActiveTab.length === 1);
}

console.log('\n=== 6. 回环（到头绕回）★ ===');
{
  const tabs = [tab('A', [{ path: 'D:/a' }]), tab('B', [{ path: 'D:/b' }]), tab('C', [{ path: 'D:/c' }])];
  const { fn: f1, calls: c1 } = makeEnv('group', tabs, 2);
  f1('group', 1); // 末 → 首
  t('末位再往后回到第一张', c1.setSelGroup[0] === 'D:/a');

  const { fn: f2, calls: c2 } = makeEnv('group', tabs, 0);
  f2('group', -1); // 首 → 末
  t('首位再往前到最后一分类', c2.setSelGroup[0] === 'D:/c');
}

console.log('\n=== 7. 源码结构（剥注释后判，避免被注释喂饱）===');
{
  const c = stripComments(raw);
  t('翻不动的两处都有 ctx.toast', (c.match(/ctx\.toast\(/g) ?? []).length === 2);
  /*
   * 必须是 info：这不是失败，只是"没东西可翻"。
   * 用 err 会让人以为刚才那一下操作出了问题。
   */
  t('两处都用 info', (c.match(/, 'info'\);/g) ?? []).length === 2);
  /* 提示必须在 return 之前 —— 写在后面就成了死代码 */
  t('n<=1 的提示在 return 之前', /if \(n <= 1\) \{\s*\n\s*ctx\.toast\([\s\S]*?\n\s*return;/.test(c));
  /* 空分类那处：先尝试取第一张，取不到才提示 */
  t('先尝试选中再提示', /if \(first\) \{ setFocus\('group'\); s\.setSelGroup\(first\); return; \}\s*\n\s*ctx\.toast\(/.test(c));
}

done();
