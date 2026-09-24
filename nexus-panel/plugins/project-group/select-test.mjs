/**
 * 选中语义的回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/select-test.mjs
 *
 * 两件小事，都是"不报错、只是看起来不对"那类：
 *
 *   #261 右键必须先选中再弹菜单 —— 否则菜单作用于用户没打算动的卡片
 *   #262 只有叶子该高亮 —— 目录节点不该高亮
 *
 * #262 的坑尤其隐蔽：判断式写成 `selected?.path === n.item?.path` 时，
 * **还没选中任何东西**的情况下两边都是 undefined，`undefined === undefined`
 * 为真 → 整棵树的目录节点一起被判为选中。
 * 只在"刚打开、什么都没选"时出现，而那时用户最容易以为界面本来就这样。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const grid = fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8');
const contentRaw = fs.readFileSync(path.join(HERE, 'components/ContentPanel.tsx'), 'utf8');
/* 规则类断言必须看**剥掉注释**的源码：
   我在注释里写了旧的错误写法作为反例，直接拿原文匹配会命中自己的注释。
   这是第三次踩同一个坑，故在此写明。 */
const content = contentRaw.replace(/\/\*[\s\S]*?\*\//g, '');
const css = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8');

console.log('\n=== 1. #261 右键先选中再弹菜单 ===');
{
  /* **必须取全部 onContextMenu**：只取第一个会匹配到页签那个，
     卡片那个就被漏掉了 —— 而两处都要遵守这条规则。
     这和我此前"全局正则在有多个同名元素时是无效证据"是同一类坑。 */
  const bodies = [...grid.matchAll(/onContextMenu=\{\(e\) => \{([\s\S]*?)\n?\s*\}\}/g)]
    .map((m) => m[1]);
  t('存在 onContextMenu（页签 + 卡片）', bodies.length >= 2, `${bodies.length} 处`);

  for (const [i, body] of bodies.entries()) {
    t(`第 ${i + 1} 处阻止了默认菜单`, /e\.preventDefault\(\)/.test(body));
    /* 关键：先选中再弹菜单 */
    t(`第 ${i + 1} 处先调用 onSelect`, /onSelect\(/.test(body));
    /* 顺序不能反：先弹菜单再选中的话，菜单关闭时选中态才变 */
    const iSel = body.indexOf('onSelect(');
    const iMenu = body.indexOf('setMenu(');
    /* 两端都判：iMenu 找不到时 `iSel < iMenu` 恒真（空跑），
       iSel 找不到时恒假（脆断）—— 两种都要挡住 */
    t(`第 ${i + 1} 处顺序正确（先 select 后 menu）`,
      iSel >= 0 && iMenu >= 0 && iSel < iMenu);
  }
}

console.log('\n=== 2. #262 仅叶子高亮 ===');
{
  /* 必须是"显式要求 selected 存在"的写法，不能用 ?. 短路 */
  t('显式判断 selected 存在', /selected && n\.item && selected\.path === n\.item\.path/.test(content));
  t('没有裸的 selected?.path === n.item?.path 比较',
    !/selected\?\.path === n\.item\?\.path/.test(content));
  t('目录节点（无 item）不会被判为选中',
    /n\.item &&/.test(content));
}

console.log('\n=== 3. 未选中时整棵树不该高亮（真 bug 的回归护栏）===');
{
  /* 直接验证那个判定式：selected 为 null 时的行为 */
  const isSel = (selected, nItem) =>
    Boolean(selected && nItem && selected.path === nItem.path);
  t('未选中 + 目录节点 → 不高亮', isSel(null, null) === false);
  t('未选中 + 叶子节点 → 不高亮', isSel(null, { path: '/a' }) === false);
  t('选中叶子 + 该叶子 → 高亮', isSel({ path: '/a' }, { path: '/a' }) === true);
  t('选中叶子 + 别的叶子 → 不高亮', isSel({ path: '/a' }, { path: '/b' }) === false);
  t('选中叶子 + 目录节点 → 不高亮', isSel({ path: '/a' }, null) === false);

  /* 反向证明旧写法是错的 —— 这条断言就是那个 bug 的现场 */
  const oldIsSel = (selected, nItem) => selected?.path === nItem?.path;
  t('（反向）旧写法下未选中时目录节点会被判为选中',
    oldIsSel(null, null) === true);
}

console.log('\n=== 4. 样式层面：选中态有可见表现 ===');
{
  t('卡片选中态有样式', /\.fpx-card\.selected/.test(css));
  t('树节点选中态有样式', /\.fpx-node\.selected/.test(css));
}


console.log('\n=== 5. #297 页签显示条目数 ===');
{
  const cssNC = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const gridNC = grid.replace(/\/\*[\s\S]*?\*\//g, '');
  t('页签渲染条目数', /fpx-tab-count/.test(gridNC));
  t('取的是 items.length（不是写死的）', /\{t\.items\.length\}/.test(gridNC));
  /* 空页签要能一眼看出来，否则点进去只有一句空提示，白点一次 */
  t('空页签有单独样式', /fpx-tab-count\.zero/.test(cssNC));
  t('zero 类按数量切换', /t\.items\.length === 0 \? ' zero'/.test(gridNC));
  t('数字用等宽（与类别徽标区分）', /\.fpx-tab-count\s*\{[^}]*font-mono/.test(cssNC));
  t('类别标记 P/G 仍在', /kind === 'project' \? 'P' : 'G'/.test(gridNC));
}

done();
