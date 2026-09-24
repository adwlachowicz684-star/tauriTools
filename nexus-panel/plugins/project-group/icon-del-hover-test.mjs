/**
 * 图标分组标题 hover 才显删除（#151），零依赖
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/icon-del-hover-test.mjs
 *
 * #152（图标列表项）经核对**早已实现**（同 #116），本次一并更正状态表。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const grid = R('components/PresetIconGrid.tsx');
const css = strip(fs.readFileSync(path.join(HERE, 'style.css'), 'utf8'));

console.log('\n=== 1. × 删的是用户点的那一组，不是"当前活动组" ===');
{
  t('有 removeGroupAt', /const removeGroupAt = async \(i: number\)/.test(grid));
  t('按下标取组', /const g = effective\[i\];/.test(grid));
  t('按名字过滤（不是按 active）', /effective\.filter\(\(x\) => x\.name !== g\.name\)/.test(grid));
  /* 删的是"当前组"的话，点 A 的 × 可能删掉 B —— 与 #82 同一类错误 */
  t('没再用 current.name 过滤', !/filter\(\(g\) => g\.name !== current\.name\)/.test(grid));
}

console.log('\n=== 2. 不能嵌套 button ===');
{
  /* button 套 button 是无效 HTML，浏览器会把内层提到外面去 */
  t('用 wrap 承载', /className="fpx-groupwrap"/.test(grid));
  t('× 是兄弟元素（同缩进层的 button）', /className="fpx-groupdel"/.test(grid));
  /*
   * 顺序断言必须**两端都判存在**：
   * 某端找不到时 indexOf 返回 -1，而 `-1 < 任意正数` 恒真 ——
   * 断言会**空跑**：锚点被改没了，它照样报绿，你以为在验次序，其实什么都没验。
   * 这类空跑靠"剥注释"扫不出来（锚点是代码不是注释），只能显式判 >= 0。
   */
  const iWrap = grid.indexOf('fpx-groupwrap');
  const iDel2 = grid.indexOf('fpx-groupdel');
  t('wrap 在 button 之前', iWrap >= 0 && iDel2 >= 0 && iWrap < iDel2);
}

console.log('\n=== 3. 只剩一个组时不给删 ===');
{
  t('渲染条件 length > 1', /effective\.length > 1 && \(/.test(grid));
  t('函数里也兜一层', /if \(effective\.length <= 1\) \{ onLog\('至少保留一个分组', true\); return; \}/.test(grid));
}

console.log('\n=== 4. hover 显形必须连 pointer-events 一起关（关键）===');
{
  /*
   * 只压 opacity 的话，看不见的按钮**仍然可以点** ——
   * 用户以为点的是标题（切换分组），实际删掉了分组。
   */
  const d = css.slice(css.indexOf('.fpx-groupdel {'));
  const seg = d.slice(0, d.indexOf('.fpx-groupdel:hover'));
  t('默认 opacity 0', /opacity: 0;/.test(seg));
  t('默认 pointer-events none', /pointer-events: none;/.test(seg));
  t('hover 恢复 pointer-events', /\.fpx-groupwrap:hover \.fpx-groupdel,\s*\n\.fpx-groupdel:focus-visible \{ opacity: 1; pointer-events: auto; \}/.test(css));
  /* 键盘用户：否则 tab 到不可见按钮上按回车删了东西却不知道删的是谁 */
  t('focus-visible 也显形', /\.fpx-groupdel:focus-visible \{ opacity: 1; pointer-events: auto; \}/.test(css));
}

console.log('\n=== 5. 常显的那个按钮已移除 ===');
{
  t('没有常显的删除分组按钮', !/onClick=\{deleteGroup\}/.test(grid));
  t('deleteGroup 已删干净', !/deleteGroup/.test(grid));
}

console.log('\n=== 6. 删除前要确认 ===');
{
  t('走 confirm', /await confirm\(\{/.test(grid));
  t('标 danger', /danger: true,/.test(grid));
}

done();
