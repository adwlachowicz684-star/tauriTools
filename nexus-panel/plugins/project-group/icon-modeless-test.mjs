/**
 * 图标面板非模态常驻 + 换卡片换目标（#8，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/icon-modeless-test.mjs
 *
 * #8 最容易做错的三点：
 *   1. 遮罩只改样式不改"点背景关闭" —— 点背后卡片时面板直接没了，白做
 *   2. 只有显示跟随、setIcon 仍用打开时那张 —— **显示与目标不一致比不跟随更糟**
 *   3. 换目标时用 key 重建组件 —— 浏览状态全丢，每切一张卡要重新找分组
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');

console.log('\n=== 1. Modal 的非模态支持 ===');
{
  const ui = strip(fs.readFileSync(path.join(HERE, 'components/ui.tsx'), 'utf8'));
  t('Modal 有 modeless 参数', /modeless = false/.test(ui));
  /* **点遮罩不再关闭** —— 只改样式不改这个，点背后卡片时面板就没了 */
  t('非模态时点背景不关闭', /onMouseDown=\{modeless \? undefined : ask\}/.test(ui));
  t('遮罩加 modeless 类', /className=\{`mask\$\{modeless \? ' modeless' : ''\}`\}/.test(ui));
}

console.log('\n=== 2. 样式：遮罩不挡点击、面板本体可点 ===');
{
  const css = strip(fs.readFileSync(path.join(HERE, 'style.css'), 'utf8'));
  t('遮罩 pointer-events: none', /\.mask\.modeless \{[^}]*pointer-events: none/.test(css));
  /* 缺这条连面板自己都点不了 —— 成对要求，缺一不可 */
  t('面板本体恢复可点', /\.mask\.modeless \.dialog \{[^}]*pointer-events: auto/.test(css));
}

console.log('\n=== 3. 目标条：必须让用户看见当前作用于谁 ===');
{
  const dlg = strip(fs.readFileSync(path.join(HERE, 'components/dialogs.tsx'), 'utf8'));
  t('有目标条', /className="fpx-icontarget"/.test(dlg));
  t('显示目标名', /\{target\.name\}/.test(dlg));
  /* 未选中时要明确说，不能留空 */
  t('未选中时明确提示', /未选中卡片/.test(dlg));
  t('目标名带完整路径 title', /title=\{target\.path\}/.test(dlg));

  /* 跟随 / 锁定开关 */
  t('有跟随开关', /onFollowChange\(!following\)/.test(dlg));
  t('开关显示当前状态', /\{following \? '跟随中' : '已锁定'\}/.test(dlg));
  t('开关有说明 title', /title=\{following/.test(dlg));

  /* **换目标时不重置浏览状态** —— 这条是注释里的硬约束 */
  t('注释写明换目标不重置', /换目标时浏览状态一律保留/.test(
    fs.readFileSync(path.join(HERE, 'components/dialogs.tsx'), 'utf8')));
}

console.log('\n=== 4. 宿主：跟随与 setIcon 必须用同一个目标 ===');
{
  const host = strip(fs.readFileSync(path.join(HERE, 'components/DialogsHub.tsx'), 'utf8'));

  t('默认跟随', /useState\(true\)/.test(host));
  t('算了当前选中卡片', /const selCard = useMemo/.test(host));
  t('选中路径取自 selProject/selGroup', /s\.selProject \?\? s\.selGroup/.test(host));

  /* **onPick 不能用 dialog.card** —— 那是打开时那张，跟随模式下已过期 */
  /* 断言到**目标参数**而不是整个箭头函数：onPick 的签名会随功能扩展变化
     （#13 后多了一个 guiOnly 形参），写死整条会一改就误报。 */
  t('onPick 用跟随后的目标', /onPick=\{\([^)]*\) => s\.setIcon\(\s*iconTargetPath/.test(host));
  t('onPick 没有用 dialog.card.path', !/onPick=\{\([^)]*\) => s\.setIcon\(\s*dialog\.card\.path/.test(host));

  /* target 与 onPick 必须是同一个表达式，否则显示与目标不一致 */
  t('target 用同一目标路径', /target=\{\{ path: iconTargetPath/.test(host));
  t('传了 modeless', /^\s*modeless$/m.test(host));
  t('传了 following 与回调', /following=\{iconFollow\}/.test(host) && /onFollowChange=\{setIconFollow\}/.test(host));
}

console.log('\n=== 5. 不重建组件（换目标不能丢状态）===');
{
  const host = fs.readFileSync(path.join(HERE, 'components/DialogsHub.tsx'), 'utf8');
  /* 用 key={目标} 会让 React 整个重建实例，state 全丢 */
  t('没有用 key 绑目标', !/key=\{iconTarget|key=\{selCard|key=\{dialog\.card/.test(host));
}

console.log('\n=== #153 图标网格贴边自动滚动 ★★ ===');
{
  const g = fs.readFileSync(path.join(HERE, 'components/PresetIconGrid.tsx'), 'utf8');

  /* 一、得真的接上 hook。
     此前 #104 的 hook 只被 CardGrid 用，图标网格（122 个内置图标、
     限高 340px、overflow:auto）拖到边缘完全不滚 ——
     排在后面看不见的图标根本拖不到，用户只能先滚再拖来回倒腾。 */
  t('引入了 useEdgeAutoScroll', /import \{ useEdgeAutoScroll \}/.test(g));
  t('hook 绑在网格容器上', /useEdgeAutoScroll\(gridRef,/.test(g));
  t('active 只在真拖拽时为真', /useEdgeAutoScroll\(gridRef, iconDrag !== null\)/.test(g));

  /*
   * 二、**声明顺序**：hook 必须在 iconDrag 之后。
   *
   * `const` 有暂时性死区（TDZ），在 `const [iconDrag] = useState(...)`
   * 之前读 `iconDrag` 会抛 ReferenceError —— 而且是**运行时**才炸，
   * 语法检查（括号配对那套）完全看不出来。
   * 我第一版就是放在了 gridRef 旁边（靠前），语法检查全绿。
   */
  const iDrag = g.indexOf('const [iconDrag, setIconDrag]');
  const iHook = g.indexOf('useEdgeAutoScroll(gridRef,');
  t('iconDrag 已声明', iDrag > 0);
  t('hook 调用在 iconDrag 声明之后（TDZ）', iHook > iDrag && iDrag > 0,
    `iconDrag@${iDrag} hook@${iHook}`);

  /* 三、容器上要有 dragover：指针停在边缘时常常落在格子之间的空隙，
     那里没有 item 的 handler，不挂就记不到指针位置 → 不滚。 */
  const gi = g.indexOf('className="fpx-icongrid"');
  const gridBlock = g.slice(gi, g.indexOf('>', gi) + 200);
  t('网格容器挂了 onDragOver', /onDragOver/.test(gridBlock));
  t('网格容器记下了指针位置', /ptrRef\.current = \{ x: e\.clientX, y: e\.clientY \}/.test(gridBlock));
  t('指针位置交给 hook', /onGridDragOver\(e\)/.test(gridBlock));

  /*
   * 四、滚动后必须重算落点（#153 的另一半，只加滚动是不够的）。
   *
   * dragover 只在指针移动时触发，贴边滚动期间指针不动 →
   * 高亮停在滚动前那个格子上，而它已滚出视野。用户看着空处松手，
   * 图标被放到一个他没看见的位置。
   */
  t('网格容器挂了 onScroll', /onScroll=\{\(\) =>/.test(g));
  t('滚动时按当前指针重算落点', /elementFromPoint/.test(g));
  t('重算结果写回 iconOver', /setIconOver\(i\)/.test(g));
  const si = g.indexOf('onScroll={() => {');
  const scrollBlock = g.slice(si, si + 500);
  t('只在真拖拽时重算（否则普通滚动会乱标）', /if \(!iconDrag \|\| !p\) return;/.test(scrollBlock));
}

done();
