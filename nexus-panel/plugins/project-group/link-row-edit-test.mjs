/**
 * 点链接名编辑该条链接（#82，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/link-row-edit-test.mjs
 *
 * #82 的要点是"编辑的必须是用户点的那一条"：
 * 明细里每一行的 group 可能不同（一个项目可以有多条链接记录），
 * 只传卡片会拿到汇总的 linkedGroup，改的就不是用户点中那行。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const grid = strip(fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8'));
const app = strip(fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8'));
const css = strip(fs.readFileSync(path.join(HERE, 'style.css'), 'utf8'));
/* 弹窗渲染在 Dialogs.tsx（App 只传状态），两个文件都要看 */
const dlg = strip(fs.readFileSync(path.join(HERE, 'components/Dialogs.tsx'), 'utf8'));

console.log('\n=== 1. 链接名可点 ===');
{
  t('有 onEditLink 参数', /onEditLink\?: \(project: string, group: string\) => void/.test(grid));
  t('传进来', /onJumpToGroup, onEditLink, onAdd/.test(grid));
  t('渲染成按钮', /<button\s+className="fpx-link-name edit"/.test(grid));
  t('点击调 onEditLink', /onEditLink\(c\.path, d\.group\)/.test(grid));
  /* 不传时退回不可点的 span —— 比"点了没反应"好 */
  t('不传时渲染成 span', /\) : \(\s*\n\s*<span className="fpx-link-name"/.test(grid));
}

console.log('\n=== 2. 传的是"这一行"的 group（最关键）===');
{
  /* d.group 是这一行的；c.linkedGroup 是汇总值，改错对象 */
  t('传 d.group 而非卡片汇总值', /onEditLink\(c\.path, d\.group\)/.test(grid));
  t('没有传 linkedGroup', !/onEditLink\([^)]*linkedGroup/.test(grid));
}

console.log('\n=== 3. 阻止冒泡 ===');
{
  /* 否则点链接名会顺带把卡片选中/展开状态改掉 */
  t('onClick 里 stopPropagation', /onClick=\{\(e\) => \{\s*\n\s*e\.stopPropagation\(\);\s*\n\s*onEditLink\(/.test(grid));
}

console.log('\n=== 4. 接线 ===');
{
  t('App 传入 onEditLink', /onEditLink=\{\(project, group\) => setConfirmLink\(\{ project, group \}\)\}/.test(app));
  /* 复用已有的建链弹窗，不另起一套 */
  t('复用 confirmLink 弹窗', /confirmLink=\{confirmLink\}/.test(app));
  t('弹窗已渲染（在 Dialogs.tsx）', /\{confirmLink && \(/.test(dlg));
  t('弹窗用 confirmLink 的 project/group', /project=\{confirmLink\.project\}/.test(dlg) && /group=\{confirmLink\.group\}/.test(dlg));
}

console.log('\n=== 5. 可点性要看得出来 ===');
{
  t('有 cursor: pointer', /\.fpx-link-name\.edit \{[\s\S]*?cursor: pointer/.test(css));
  t('有 hover 反馈', /\.fpx-link-name\.edit:hover/.test(css));
  /* 键盘可达：只有鼠标能点的话，键盘用户根本触发不了 */
  t('有 focus-visible', /\.fpx-link-name\.edit:focus-visible/.test(css));
}

done();
