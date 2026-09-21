/**
 * 可用高度自适应 #146 / #147（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/avail-height-test.mjs
 *
 * 两处原本各写死一个数（图标网格 340px、模板框 rows=6），
 * 面板拉高时不会跟着变高。两者是同一件事，故合用一个 hook。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const hook = R('hooks/useAvailableHeight.ts');
const grid = R('components/PresetIconGrid.tsx');
const panel = R('components/ChainActionsPanel.tsx');
const css = strip(fs.readFileSync(path.join(HERE, 'style.css'), 'utf8'));

console.log('\n=== 1. hook 本身 ===');
{
  t('用 rect 差算上方占用', /elRect\.top - boxRect\.top/.test(hook));
  /* offsetTop 参照的是 offsetParent，中间有 position 就会算错 */
  t('没用 offsetTop', !/offsetTop/.test(hook));
  t('减底部留白', /box\.clientHeight - used - bottomGap/.test(hook));
  t('有 minHeight 兜底', /Math\.max\(minHeight, /.test(hook));
}

console.log('\n=== 2. 必须防 ResizeObserver 循环 ===');
{
  /*
   * 观察的是外层弹窗体，改的是内容块高度。
   * 外层若是自适应高度，可能形成"改高度 → 触发观察 → 再改"的环。
   */
  t('观察外层', /ro\.observe\(box\)/.test(hook));
  t('也观察内容块', /ro\.observe\(el\)/.test(hook));
  t('值没变就不 setState', /if \(lastRef\.current !== null && Math\.abs\(lastRef\.current - next\) < 1\) return;/.test(hook));
  t('卸载时 disconnect', /return \(\) => ro\.disconnect\(\)/.test(hook));
}

console.log('\n=== 3. 量不到时返回 null，不能返回 0 ===');
{
  /* 返回 0 会把内容压没，表现为"图标列表空白一下" */
  t('初始为 null', /useState<number \| null>\(null\)/.test(hook));
  t('找不到容器就 return', /if \(!box\) return;/.test(hook));
  t('首帧不应用：调用方用了三元', /gridH \? \{ maxHeight: gridH \} : undefined/.test(grid));
}

console.log('\n=== 4. 两处都接了，且共用同一个 hook ===');
{
  t('图标网格接了', /useAvailableHeight\(gridRef/.test(grid));
  t('模板框接了（项目）', /useAvailableHeight\(projectTplRef/.test(panel));
  t('模板框接了（项目组）', /useAvailableHeight\(groupTplRef/.test(panel));
  t('两处 import 同一个', /from '\.\.\/hooks\/useAvailableHeight'/.test(grid)
    && /from '\.\.\/hooks\/useAvailableHeight'/.test(panel));
}

console.log('\n=== 5. hook 必须在 ref 声明之后（TDZ）===');
{
  /*
   * hook 里读的是 projectTplRef 这个 const。写在它之前会撞 TDZ：
   * "Cannot access 'projectTplRef' before initialization"。
   * 这是**运行时**报错，tsc 未必抓得到，所以专门断言顺序。
   */
  for (const [name, refn, hookn] of [
    ['项目模板框', 'const projectTplRef', 'const projectTplH'],
    ['项目组模板框', 'const groupTplRef', 'const groupTplH'],
  ]) {
    t(`${name}：hook 在 ref 之后`, panel.indexOf(refn) < panel.indexOf(hookn));
  }
  t('图标网格：hook 在 ref 之后', grid.indexOf('const gridRef') < grid.indexOf('const gridH'));
}

console.log('\n=== 6. CSS 兜底要留着 ===');
{
  /* 不在弹窗里 / 首帧没量到时仍要有限高，否则撑出外层滚动条 */
  const g = css.slice(css.indexOf('.fpx-icongrid {'));
  const seg = g.slice(0, g.indexOf('}'));
  t('网格仍有 max-height 兜底', /max-height: 340px/.test(seg));
  t('网格仍有 overflow auto（只保留内层滚动条）', /overflow: auto/.test(seg));
}

console.log('\n=== 7. #147 最扁不低于 140 ===');
{
  t('模板框给了 minHeight 140', /useAvailableHeight\(projectTplRef, \{ minHeight: 140/.test(panel));
}

done();
