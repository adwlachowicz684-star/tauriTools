/**
 * 设置页显示数据目录实际路径（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/settings-datadir-test.mjs
 *
 * 为什么要在设置里显示**路径本身**：
 * 出问题时（发日志、手改 config、告诉别人配置在哪），
 * 用户需要的是这个路径字符串 —— 光有"打开"按钮他还是不知道在哪。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const src = strip(fs.readFileSync(path.join(HERE, 'components/SettingsDialog.tsx'), 'utf8'));
const css = strip(fs.readFileSync(path.join(HERE, 'style.css'), 'utf8'));
const app = strip(fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8'));

console.log('\n=== 1. 显示路径本身（不是只有按钮）===');
{
  t('有数据目录展示块', /className="fpx-settings-datadir"/.test(src));
  /* **路径文本**是重点 —— 只有按钮的话用户还是不知道在哪 */
  t('渲染 dataDir 文本', /fpx-settings-datadir-path" title=\{dataDir\}>\{dataDir\}</.test(src));
  t('有标签', /fpx-settings-datadir-label">数据目录</.test(src));
  t('用 code 标签（等宽）', /<code className="fpx-settings-datadir-path"/.test(src));
}

console.log('\n=== 2. 长路径要能完整看到 ===');
{
  /* title 供悬停查看完整值 */
  t('title 带完整路径', /title=\{dataDir\}/.test(src));
  t('有省略号截断样式', /text-overflow: ellipsis/.test(css) && /white-space: nowrap/.test(css));
  t('可复制（user-select: text）', /user-select: text/.test(css));
}

console.log('\n=== 3. 只读，不是输入框 ===');
{
  /* 数据目录由 app_data_dir 决定，不可改 —— 做成输入框会让人以为能改 */
  t('没有数据目录输入框', !/<input[^>]*dataDir/.test(src));
  t('路径容器不是 input', /<code className="fpx-settings-datadir-path"/.test(src));
}

console.log('\n=== 4. 取不到时给明确占位 ===');
{
  /* 留空会被当成"加载失败"，不如明确说未取到 */
  t('空时显示占位文案', /（未取到）/.test(src));
  t('空时不渲染 code', /dataDir \? \([\s\S]{0,200}?\) : \(/.test(src));
}

console.log('\n=== 5. 打开 / 复制仍在 ===');
{
  t('打开按钮仍在', /onClick=\{\(\) => api\.openPath\(dataDir, 'dir'\)/.test(src));
  t('复制按钮仍在', /api\.copyText\(dataDir\)/.test(src));
  t('复制有反馈', /已复制数据目录路径/.test(src));
}

console.log('\n=== 6. 主界面那行保留（"也"放到设置，不是搬走）===');
{
  t('主界面仍显示数据目录', /数据：\{boot\.dataDir\}/.test(app));
}

done();
