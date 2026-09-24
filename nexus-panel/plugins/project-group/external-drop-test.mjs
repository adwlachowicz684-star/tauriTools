/**
 * #14 从文件管理器拖入文件夹（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/external-drop-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const ds = R('utils/dragSort.ts');
const grid = R('components/CardGrid.tsx');
const stack = R('components/StackedGroups.tsx');
const hub = R('components/DialogsHub.tsx');
const dlg = R('components/DirDialog.tsx');
const app = R('App.tsx');
const cg = R('components/CardGrid.tsx');
const css = R('style.css');

console.log('\n=== 1. 判定要认"拖文件夹" ===');
{
  /*
   * 判据是"一个内部类型都没有"，而不是"有 Files"：
   * 拖**文件夹**时部分平台只给 text/uri-list，不给 Files。
   * 用"有 Files"判的话，恰恰会把 #14 要支持的那种漏掉。
   */
  t('有 isExternalDrag', /export function isExternalDrag\(/.test(ds));
  t('判据是三种内部类型都没有', /!list\.some\(\s*\(t\) => t === DRAG_MIME \|\| t === TAB_DRAG_MIME \|\| t === BOX_DRAG_MIME,/.test(ds));
  t('不是只认 Files', !/types\.includes\('Files'\)/.test(ds));
  t('有取名字的函数', /export function externalDropName\(/.test(ds));
  t('没文件时返回空串', /files && files\.length > 0 \? files\[0\]\.name : ''/.test(ds));
}

console.log('\n=== 2. 卡片区：整区高亮，不画竖条 ===');
{
  t('dragover 里判外部', /if \(isExternalDrag\(e\.dataTransfer\.types\)\) \{/.test(grid));
  /* 竖条表达"插在两张之间"，而外面的文件夹没有这一说 */
  t('外部时设整区高亮', /setExternalOver\(true\);/.test(grid));
  t('dropEffect 用 copy', /e\.dataTransfer\.dropEffect = 'copy';/.test(grid));
  t('外部时直接 return（不走卡片逻辑）', /setExternalOver\(true\);\s*\n\s*return;/.test(grid));
  t('有 external-over 类', /externalOver \? ' external-over' : ''/.test(grid));
  t('CSS 有该样式', /\.fpx-cards\.external-over \{/.test(css));
  t('用虚线整区', /outline: 2px dashed var\(--accent\);/.test(css));
  /* 清状态要一起清，否则拖走后高亮残留 */
  t('dragleave 一起清', /if \(!e\.currentTarget\.contains\(e\.relatedTarget as Node\)\) \{\s*\n\s*clearDropWithScroll\(\);\s*\n\s*setExternalOver\(false\);/.test(grid));
  /*
   * 直接匹配整行会**漏报**：把 `setExternalOver(false);` 从 clearDrop 里删掉后，
   * 正则还能在下方的 setExternalOver(false) 之外凑不出来……实测仍命中，
   * 原因是 `setExternalOver(false);` 在文件里还有另一处。
   * 改成取 clearDrop 的**函数块**再断言。
   */
  const clearBlock = (() => {
    const i = grid.indexOf('const clearDrop = () => {');
    return i < 0 ? '' : grid.slice(i, grid.indexOf('};', i));
  })();
  t('clearDrop 里也清', /setExternalOver\(false\)/.test(clearBlock));
}

console.log('\n=== 3. 接到正规流程，而不是静默 ===');
{
  /* 现状是"拖外部文件进来没反应" —— 用户拖了、松手了、毫无变化 */
    /*
   * 契约变更：拖入文件夹要**直接导入**，不再弹对话框。
   *
   * 下面钉的是新的接线方式：拿到绝对路径 → 调 onExternalDrop(target, true)；
   * 不是文件夹 → 只提示，不弹框。
   */
  /*
   * 这两条**此前钉的是内联写法**（classifyExternalDrop / dirPathOf 直接出现在
   * CardGrid 里）。#360 把那段抽成了共享函数 `resolveExternalDrop`
   * （页签条要用同一份），旧锚点就全部失配 —— 是过期断言，不是回归。
   *
   * 改成钉**语义仍在**：卡片区仍区分文件夹/非文件夹、仍把 direct 传出去，
   * 只是分类逻辑现在住在 dragSort 里。
   * 若只改成"存在 resolveExternalDrop"，就测不到卡片区是否还做区分。
   */
  t('drop 里区分了文件夹与非文件夹',
    /out\.kind !== 'dir'[\s\S]{0,200}onExternalNotice\?\.\(out\.kind, out\.name\)/.test(grid));
  t('拿到路径就标记 direct（调用方据此决定要不要弹框）',
    /onExternalDrop\?\.\(out\.target, out\.direct\)/.test(grid));
  /* 分类逻辑本身在共享函数里，direct 由"有没有拿到路径"决定 */
  t('direct 由有无路径决定', /direct: !!path/.test(ds));
  t('App 项目栏接了', /onExternalDrop=\{externalDrop\('project'\)\}/.test(app));
  t('App 项目组栏接了', /onExternalDrop=\{externalDrop\('group'\)\}/.test(app));
  t('Column 透传', /onExternalDrop=\{onExternalDrop\}/.test(app));
  t('StackedGroups 透传时带上分类索引',
    /onExternalDrop\?\.\(target, direct, i\)/.test(stack));
  /* 非文件夹时提示"请拖入文件夹即可" —— 不弹框 */
  t('提示语直接说要拖文件夹', /请拖入文件夹即可/.test(app));
  /* 直接导入走 addCard，且带 tabIndex（项目组堆叠时落到拖中的那个分类） */
  t('直接导入走 addCard 并带 tabIndex',
    /s\.addCard\(kind, target, tabIndex\)/.test(app));
  /*
   * 宿主侧的两个前置（开 dragDropEnabled + 装文档级拖放守卫）。
   *
   * 2026-09-22 **恢复为断言**：宿主已开 `dragDropEnabled: true`、
   * 已装文档级守卫（host.js 的 installDropGuard）。
   *
   * 此前一度改成"状态报告"是因为宿主未就绪 —— 那时钉断言会让套件长期红灯，
   * 红灯久了会被当噪音忽略（比不测更糟）。现在前置齐了，就必须钉死：
   * 这两个开关任一被回退，#14 会**静默退化**成"总是弹选目录框"，
   * 而功能看起来还在（能加卡片），只是每次都要多一步，没人会报 bug。
   */
  const conf = R('../../src-tauri/tauri.conf.json');
  const host = R('../../js/host.js');
  t('宿主已开启 dragDropEnabled（否则拿不到路径）', /"dragDropEnabled"\s*:\s*true/.test(conf));
  t('宿主装了文档级拖放守卫', /addEventListener\('drop', stop\)/.test(host));
  /* 调用点必须在 createHost 内、且在插件挂载之前；找不到调用点直接判失败而不是跳过 */
  const gi = host.indexOf('installDropGuard();');
  const ci = host.indexOf('const bus = createBus();');
  t('守卫在插件挂载前安装（createHost 内）', gi > 0 && ci > 0 && gi > ci && gi - ci < 400,
    `gi=${gi} ci=${ci}`);
  /* 开配置不装守卫比不开更糟：不开至少什么都不发生，开了不拦则整个界面导航走 */
  t('守卫同时拦 dragover', /addEventListener\('dragover', stop\)/.test(host));

  /*
   * 同上：这两条钉的是 `path || name` 这个内联表达式，抽出后失配。
   * 真正要钉的语义 —— 拿不到路径时仍走对话框（不静默），
   * 现在由 `out.target` 兜底成名字 + `out.direct=false` 表达。
   */
  t('拿不到路径时退回对话框（不静默）', /target: path \|\| name/.test(ds));
  t('有路径才标记为直接导入', /direct: !!path/.test(ds));
}

console.log('\n=== 4. 提示要解释"为什么还要再选一次" ===');
{
  t('DirDialog 有 hint', /hint\?: string;/.test(dlg));
  t('渲染了 hint', /\{hint && \(\s*\n\s*<div className="fpx-dirhint">/.test(dlg));
  t('Dialog 类型带 droppedName', /droppedName\?: string/.test(hub));
  t('pickDir 传了 hint', /hint=\{dialog\.droppedName/.test(hub));
  /* 关键是说出原因，只说"请再选一次"会让人以为刚才拖失败了 */
  t('提示里说明了原因', /浏览器安全限制下拿不到它的磁盘路径/.test(hub));
  t('提示带上拖入的名字', /已收到拖入的「\$\{dialog\.droppedName\}」/.test(hub));
}

console.log('\n=== 5. 行为 ===');
{
  const { isExternalDrag, externalDropName } = await loadTs(path.join(HERE, 'utils/dragSort.ts'));
  t('内部卡片拖拽不判为外部', isExternalDrag(['application/x-fpx-card']) === false);
  t('页签拖拽不判为外部', isExternalDrag(['application/x-fpx-tab']) === false);
  t('分类框拖拽不判为外部', isExternalDrag(['application/x-fpx-box']) === false);
  /* 拖文件夹：只有 uri-list，没有 Files —— 这是最关键的一条 */
  t('只有 uri-list 也算外部', isExternalDrag(['text/uri-list']) === true);
  t('Files 也算外部', isExternalDrag(['Files']) === true);
  t('空表不误判', isExternalDrag([]) === false);
  t('null 不误判', isExternalDrag(null) === false);
  t('取名字', externalDropName([{ name: 'MyFolder' }]) === 'MyFolder');
  t('没文件返回空', externalDropName([]) === '');
  t('null 返回空', externalDropName(null) === '');

  /*
   * 分类与路径 —— **真跑函数**，不查字符串。
   * "拖文件夹能不能直接导入"是运行期行为，字符串匹配证明不了。
   */
  const { classifyExternalDrop, dirPathOf, entriesOf } = await loadTs(path.join(HERE, 'utils/dragSort.ts'));
  const dirEn = [{ isDirectory: true }];
  const fileEn = [{ isDirectory: false }];
  t('文件夹 → dir', classifyExternalDrop([{ name: 'A' }], dirEn) === 'dir');
  t('文件 → file', classifyExternalDrop([{ name: 'a.txt' }], fileEn) === 'file');
  t('拖文字（无 files）→ empty', classifyExternalDrop([], null) === 'empty');
  t('拖文字（null files）→ empty', classifyExternalDrop(null, null) === 'empty');
  t('拿不到 entry 信息仍按目录（宁可多试，不误杀文件夹）',
    classifyExternalDrop([{ name: 'A' }], null) === 'dir');

  t('有 path 的目录 → 返回绝对路径',
    dirPathOf([{ name: 'A', path: '/home/u/A' }], dirEn) === '/home/u/A');
  t('明确是文件 → 不给路径（不能把文件路径当目录导入）',
    dirPathOf([{ name: 'a.txt', path: '/home/u/a.txt' }], fileEn) === '');
  t('没 path → 空（调用方退回对话框，而不是静默）',
    dirPathOf([{ name: 'A', path: null }], dirEn) === '');
  t('没文件 → 空', dirPathOf([], dirEn) === '');

  /* entriesOf：方法不存在时返回空数组，不抛 */
  t('entriesOf 遇无 webkitGetAsEntry 的环境返回空、不抛',
    entriesOf([{}]).length === 0);
  t('entriesOf 正常取出 isDirectory',
    entriesOf([{ webkitGetAsEntry: () => ({ isDirectory: true }) }])[0].isDirectory === true);
  t('entriesOf 对 null 返回空', entriesOf(null).length === 0);
}

console.log('\n=== #360 拖到页签上 → 落到**那个**页签 ★★ ===');
{
  const css = R('style.css');

  /*
   * 原版 `MainWindow.xaml.cs: OnTabDrop`：
   *   int idx = GetTabIndexAt(projectTabsHost, e.GetPosition(projectTabsHost));
   *   foreach (var f in files) if (Directory.Exists(f2)) vm.AddFavoriteToTab("project", idx, f2);
   *
   * 即**拖到哪个页签就加到哪个页签**（OnTabDragOver 还会顺带切过去）。
   *
   * 本版此前：TabBar 有 `onExternalDrop` 这个 prop，**声明了却从没被调用** ——
   * onDragOver / onDrop 里只有 TAB_DRAG_MIME 与 DRAG_MIME 两个分支，
   * 拖文件夹到页签上不 preventDefault → 浏览器回弹、界面毫无变化。
   *
   * 而外层 `externalDrop` 早就把 tabIndex 一路传到 `addCard` 了 ——
   * **能力铺好了、入口没接上**（同 #486 / #138 那类"存在但不可发现"）。
   *
   * 用户要加到第 3 个页签，只能先切过去再拖，否则加到当前页签，
   * 而他看不出为什么。
   */

  /* 一、TabBar 的 onDragOver 要有外部分支并 preventDefault */
  t('页签 onDragOver 有外部分支',
    /isExternalDrag\(e\.dataTransfer\.types\)[\s\S]{0,300}setExternalTab\(i\)/.test(grid));
  t('外部分支 preventDefault（不阻止会回弹）',
    /isExternalDrag\(e\.dataTransfer\.types\)\s*\)\s*\{[\s\S]{0,200}e\.preventDefault\(\)/.test(grid));
  t('外部分支用 copy 语义（是新增不是搬走）',
    /e\.dataTransfer\.dropEffect = 'copy'/.test(grid));
  t('外部分支 stopPropagation（页签在卡片区之上）',
    /setExternalTab\(i\);\s*\n\s*return;/.test(grid));

  /* 二、onDrop 里外部分支必须**最先** */
  t('页签 onDrop 有外部分支',
    /onDrop=\{\(e\) => \{[\s\S]{0,400}isExternalDrag\(e\.dataTransfer\.types\)/.test(grid));
  /*
   * 顺序关键：若放在 `if (onMoveTab)` 之后，会被 `rawTab` 判空挡住
   * （取不到内部数据 → 直接 return，外部分支永远走不到）。
   * 钉"外部分支出现在 onMoveTab 之前"。
   */
  /*
   * **第一版这条是漏报**：用 `grid.indexOf('isExternalDrag(...)')` 取的是
   * **卡片区**那处（它排在前面），于是"外部分支在重排分支之前"恒真 ——
   * 把页签的外部分支整体挪到后面，断言照样通过。
   * 反向验证（B）才发现。
   *
   * 改成只在 **TabBar 组件那一段**里比较：本文件有两个 onDrop，
   * 卡片区那个也用同样的 isExternalDrag，不限制范围必然取错。
   */
  const tabStart = grid.indexOf('export function TabBar({');
  const tabEnd = grid.indexOf('\nexport function ', tabStart + 10);
  const tabBlk = grid.slice(tabStart, tabEnd > 0 ? tabEnd : undefined);
  const dropIdx = tabBlk.indexOf('isExternalDrag(e.dataTransfer.types)');
  /* 锚点用**代码**：原先用的是注释 `// 先看是不是页签重排`，
     注释改写后 moveIdx 变 -1、这条顺序断言恒假（假失败），
     而真正的"外部分支被挡住"回归却可能照样悄悄发生。 */
  const moveIdx = tabBlk.indexOf('const rawTab = e.dataTransfer.getData(TAB_DRAG_MIME);');
  /* 两端都要判存在：moveIdx 变 -1 时 `-1 > dropIdx` 恒假（脆断），
     而 dropIdx 变 -1 时若少了左端判断则恒真（空跑）。 */
  t('外部分支在页签重排分支之前（顺序）',
    dropIdx >= 0 && moveIdx >= 0 && moveIdx > dropIdx,
    `external@${dropIdx} move@${moveIdx}`);
  t('外部分支把 tabIndex 传出去',
    /onExternalDrop\?\.\(out\.target, out\.direct, i\)/.test(grid));

  /* 三、分类逻辑与卡片区共用一份（两处各写一套就会漂移） */
  t('有共享的 resolveExternalDrop', /export function resolveExternalDrop/.test(ds));
  t('页签用共享函数', /resolveExternalDrop\(files, entriesOf/.test(grid));
  t('卡片区也用共享函数',
    (grid.match(/resolveExternalDrop\(files, entriesOf/g) || []).length >= 2,
    '命中 ' + (grid.match(/resolveExternalDrop\(files, entriesOf/g) || []).length + ' 处');
  t('卡片区不再内联分类（反面证据）',
    !/const kind = classifyExternalDrop\(files, entries\)/.test(grid));

  /* 四、非文件夹仍要一句话说清，不弹误导的选目录框 */
  t('页签上拖文件也给提示', /onExternalNotice\?\.\(out\.kind, out\.name\)/.test(grid));

  /* 五、外层 Column 要把回调接过去（漏了就是"页签上没反应"） */
  t('Column 的 prop 带 tabIndex',
    /onExternalDrop\?: \(target: string, direct: boolean, tabIndex\?: number\) => void;/.test(app));
  t('TabBar 接到 onExternalDrop',
    /onMoveTab=\{onMoveTab\}[\s\S]{0,300}onExternalDrop=\{onExternalDrop\}/.test(app));

  /* 六、高亮类要有基础定义，且与内部移动高亮区分 */
  t('页签有 external 高亮类', /fpx-tab\.external/.test(css));
  t('external 高亮有基础定义（虚线，区别于实线发光）',
    /\.fpx-tab\.external\s*\{[\s\S]{0,200}border-style: dashed/.test(css));
  t('externalTab 是独立状态（不复用 dropTarget）',
    /const \[externalTab, setExternalTab\] = useState\(-1\)/.test(grid));
  t('className 里用到 externalTab',
    /externalTab === i \? 'external' : ''/.test(grid));
  t('dragLeave 清 externalTab',
    /setDropTarget\(-1\); setTabOver\(-1\); setExternalTab\(-1\)/.test(grid));
}

done();
