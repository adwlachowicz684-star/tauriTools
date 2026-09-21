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
  t('drop 里区分了文件夹与非文件夹',
    /classifyExternalDrop\(/.test(grid) && /onExternalNotice\?\./.test(grid));
  t('拿到路径就标记 direct（调用方据此决定要不要弹框）',
    /dirPathOf\(/.test(grid) && /onExternalDrop\?\.\(path \|\| name, !!path\)/.test(grid));
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

  t('拿不到路径时退回对话框（不静默）', /onExternalDrop\?\.\(path \|\| name, !!path\)/.test(cg));
  t('有路径才标记为直接导入', /!!path/.test(cg));
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

done();
