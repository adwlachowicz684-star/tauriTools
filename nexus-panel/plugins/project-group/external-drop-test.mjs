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
  t('drop 里调 onExternalDrop', /if \(onExternalDrop\) onExternalDrop\(externalDropName\(e\.dataTransfer\.files\)\);/.test(grid));
  t('App 项目栏接了', /onExternalDrop=\{\(n\) => setDialog\(\{ type: 'pickDir', kind: 'project', droppedName: n \}\)\}/.test(app));
  t('App 项目组栏接了', /onExternalDrop=\{\(n\) => setDialog\(\{ type: 'pickDir', kind: 'group', droppedName: n \}\)\}/.test(app));
  t('Column 透传', /onExternalDrop=\{onExternalDrop\}/.test(app));
  t('StackedGroups 透传', /onExternalDrop=\{onExternalDrop\}/.test(stack));
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
}

done();
