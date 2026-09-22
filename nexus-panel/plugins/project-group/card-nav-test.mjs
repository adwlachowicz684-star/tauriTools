/**
 * 上下键在卡片间移动选中（对齐原版 NavigateAdjacent）+ 分隔条让路
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/card-nav-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const R = (p) => fs.readFileSync(path.join(HERE, p), 'utf8');
const app = R('App.tsx');
const hk = R('hooks/useCardHotkeys.ts');
const hot = R('utils/hotkeys.ts');

console.log('\n=== 1. 注册表要有这两条 ===');
{
  t('HotkeyId 含 navUp', /\| 'navUp' \| 'navDown'/.test(hot));
  t('navUp 已注册（↑）', /\{ id: 'navUp', label: '选中上一张', combo: 'arrowup'/.test(hot));
  t('navDown 已注册（↓）', /\{ id: 'navDown', label: '选中下一张', combo: 'arrowdown'/.test(hot));
  t('归到项目操作组', /group: 'card'/.test(hot));
  t('动作接口有 navigate', /navigate: \(delta: number\) => void;/.test(hk));
  t('App 传了 navigate', /\n    navigate,\n/.test(app));
}

console.log('\n=== 2. 越界不动 + 未选中落第一张（原版语义）★ ===');
{
  const i = app.indexOf('const navigate = (delta: number) => {');
  const b = app.slice(i, app.indexOf('\n  };', i));
  /* list.Count == 0 → return */
  t('空列表直接返回', /if \(list\.length === 0\) return;/.test(b));
  /* idx < 0 → 0：第一次按键必须有反应，否则永远选不中 */
  t('未选中时落第一张', /const next = idx < 0 \? 0 : idx \+ delta;/.test(b));
  /* 越界 return，不循环 */
  t('越界不动（不循环）', /if \(next < 0 \|\| next >= list\.length\) return;/.test(b));
  /* 按当前栏取列表 */
  t('按 focus 取列表', /const list = focus === 'project' \? projectCards : groupCards;/.test(b));
  t('按 focus 写回选中', /if \(focus === 'project'\) s\.setSelProject\(target\.path\);/.test(b));
}

console.log('\n=== 3. 选完要滚动到可视区（原版 BringIntoView）★ ===');
{
  const i = app.indexOf('const navigate = (delta: number) => {');
  const b = app.slice(i, app.indexOf('\n  };', i));
  /*
   * 不滚动的话：选中的卡在滚动区外时界面毫无变化，
   * 用户以为按键没生效 —— 这是"按了没反应"类里最容易被当成 bug 的一种。
   */
  t('有 scrollIntoView', /scrollIntoView\(/.test(b));
  /* 必须等渲染完：同一帧里 DOM 还没更新 */
  t('等渲染完（rAF）', /requestAnimationFrame\(/.test(b));
  /* 路径要转义，否则含引号/特殊字符的路径会让选择器语法错误 */
  t('路径用 CSS.escape', /CSS\.escape\(target\.path\)/.test(b));
  /* block:'nearest' —— 已可见时不要整页跳 */
  t("block: 'nearest'", /block: 'nearest'/.test(b));
}

console.log('\n=== 4. 分隔条聚焦时方向键归分隔条 ★ ===');
{
  /*
   * 分隔条 tabIndex=0、方向键调宽度。若导航也响应，
   * 按一下会"调宽度 + 移动选中"双触发 —— 用户在调布局，
   * 却看到选中莫名其妙跳走，那是他没要求过的改动。
   */
  t('有 isOnSplitter 判定', /function isOnSplitter\(target: EventTarget \| null\): boolean/.test(hk));
  t('认 role=separator', /getAttribute\('role'\) === 'separator'/.test(hk));
  t('认 aria-orientation', /getAttribute\('aria-orientation'\) != null/.test(hk));
  /* 只有声明了 yieldSplitter 的才让路 —— 整组让路会让分隔条上快捷键全失灵 */
  t('按 yieldSplitter 才让路', /if \(opts\?\.yieldSplitter && isOnSplitter\(e\.target\)\) return;/.test(hk));
  /*
   * 必须钉**整句**：只钉 `{ yieldSplitter: true }` 是漏报的 ——
   * 文件里 navDown 那行也带着同样的片段，删掉 navUp 的之后
   * navDown 仍会命中，断言照样通过（等于没测）。
   */
  t('navUp 声明让路',
    /bind\(map\.navUp, \(\) => ref\.current\.navigate\(-1\), \{ yieldSplitter: true \}\);/.test(hk));
  t('navDown 声明让路',
    /bind\(map\.navDown, \(\) => ref\.current\.navigate\(1\), \{ yieldSplitter: true \}\);/.test(hk));
  t('两条导航都用了 bind 而非 run（run 不带 yieldSplitter 选项）',
    (hk.match(/bind\(map\.nav(Up|Down)/g) || []).length === 2);
  /* 其它快捷键不受影响：不能出现"整组都让路" */
  t('没有整组让路', !/if \(isOnSplitter\(e\.target\)\) return;/.test(hk));
}

console.log('\n=== 5. 切页签要清掉该栏的选中（原版 SwitchProjectTab）★ ===');
{
  /*
   * 原版：SwitchProjectTab 后 `vm.SelectedCard == null`。
   *
   * 不清的后果：选中的卡不在新页签里、界面上看不见它，
   * 但左栏操作与快捷键仍作用于它 —— 用户以为"没选中任何东西"，
   * 按 F2 却改了另一页签里的卡。没有任何提示。
   */
  const i = app.indexOf('onTab={(i) => {');
  const b = app.slice(i, i + 700);
  t('切页签时清选中', /s\.setSelProject\(null\);/.test(b));
  /* 只清这一栏：项目组栏是堆叠的，所有分类同时在界面上，
     清它只会让用户平白失去对另一栏的选择 */
  t('不动项目组栏的选中', !/s\.setSelGroup\(null\);/.test(b));
  /* 页签切换本身不能丢 */
  t('仍在切页签', /s\.setActiveTab\(\(prev\) => \(\{ \.\.\.prev, project: i \}\)\);/.test(b));
}

console.log('\n=== 6. 原有行为没被改坏 ===');
{
  t('cycleTab 仍在', /const cycleTab = \(kind: CardKind, delta: number\)/.test(app));
  t('focus 仍在', /\n    focus: setFocus,\n/.test(app));
  t('打字仍让路', /if \(isTyping\(e\.target\)\) return;/.test(hk));
  t('ALWAYS_ON 仍在', /const ALWAYS_ON: ReadonlySet<HotkeyId>/.test(hk));
  t('remove 仍在', /run\('remove', \(\) => ref\.current\.remove\(\)\);/.test(hk));
  t('projectCards 仍在', /const projectCards = useMemo\(/.test(app));
  t('groupCards 仍平铺', /boot\?\.groupTabs\.flatMap\(\(t\) => t\.items\)/.test(app));
  t('卡片有 data-card-path', /data-card-path=\{c\.path\}/.test(R('components/CardGrid.tsx')));
}

done();
