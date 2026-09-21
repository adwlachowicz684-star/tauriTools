/**
 * #156 / #157 图标弹窗剪贴板页签（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/icon-clip-test.mjs
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
const css = R('style.css');

console.log('\n=== 1. #156 页签 ===');
{
  t('有页签状态', /useState<'preset' \| 'clip'>\('preset'\)/.test(grid));
  t('预设库页签', /onClick=\{\(\) => setTab\('preset'\)\}>预设库/.test(grid));
  t('剪贴板页签', /onClick=\{\(\) => setTab\('clip'\)\}>剪贴板/.test(grid));
  /* 选中态要看得出来 */
  t('选中态样式', /className=\{tab === 'preset' \? 'on' : ''\}/.test(grid));
}

console.log('\n=== 2. #157 应用后不清空（非模态配套）===');
{
  /*
   * 核心：clipBlob 在应用成功后**不被清空**。
   * 清空的话，非模态下给第二张卡贴同一张图要重新复制一次 ——
   * 而非模态的意义本来就是"连着贴好几张"。
   */
  const apply = grid.slice(grid.indexOf('const applyClipboard'), grid.indexOf('return (\n    <div className={`fpx-preset'));
  t('应用函数存在', /const applyClipboard/.test(grid));
  t('成功后不 setClipBlob(null)', !/setClipBlob\(null\)/.test(apply));
  t('成功后不清 URL', !/setClipUrl\(null\)/.test(apply));
  /* 预览仍在 → 用户看得出"还是那张图" */
  t('保留预览', /clipUrl \? \(/.test(grid));
}

console.log('\n=== 3. 两条粘贴入口 ===');
{
  /* 按钮：navigator.clipboard.read（部分浏览器/权限下会失败，要报出来） */
  t('按钮读剪贴板', /navigator\.clipboard\.read\(\)/.test(grid));
  t('读失败要报错', /读取剪贴板失败/.test(grid));
  /* Ctrl+V：只给按钮的话最反直觉 —— "粘贴"的默认操作就是 Ctrl+V */
  t('支持 paste 事件', /onPaste=\{\(e\) => \{/.test(grid));
  t('paste 里取图片', /it\.type\.startsWith\('image\/'\)/.test(grid));
  t('paste 后阻止默认', /e\.preventDefault\(\);/.test(grid));
  t('没有图时说明', /剪贴板里没有图片/.test(grid));
}

console.log('\n=== 4. 转 ICO 再入库 ===');
{
  /* 后端文件名固定 .ico，PNG 原样写盘会得到"叫 .ico 实为 PNG"的文件 */
  t('走 imageToIcoBase64', /await imageToIcoBase64\(clipBlob\)/.test(grid));
  t('复用同一份转换', /import \{ imageToIcoBase64 \} from '\.\.\/utils\/ico';/.test(grid));
  /* 名字用「剪贴板」（原版 baseName），重名由后端加 (1) */
  t('名字用剪贴板', /api\.saveIconData\('剪贴板', b64\)/.test(grid));
  /* 显示名从返回路径取 —— 后端可能加了 (1)，显示必须与实际一致 */
  t('显示名取返回路径', /\.replace\(\/\\\.ico\$\/, ''\)/.test(grid));
}

console.log('\n=== 5. 目标分组（含"不加入"）===');
{
  t('有不加入选项', /<option value="">（仅应用，不加入分组）<\/option>/.test(grid));
  t('列出各分组', /effective\.map\(\(g\) => \(\s*\n\s*<option key=\{g\.name\} value=\{g\.name\}>/.test(grid));
  /* 空串 = 不加入，不能误判成"默认组" */
  t('按空串判断', /if \(clipGroup\) \{/.test(grid));
  /* 去重：同一图连点两次不该在分组里出现两项 */
  t('加入前查重', /!g\.icons\.includes\(nm\)/.test(grid));
}

console.log('\n=== 6. 剪贴板页签下隐藏预设库 ===');
{
  t('容器带 clip 类', /className=\{`fpx-preset\$\{tab === 'clip' \? ' clip' : ''\}`\}/.test(grid));
  /*
   * 用 :not() 排除而不是逐列名 —— 以后往预设区加一块，忘了同步就会露出半截。
   */
  t('CSS 用 :not 隐藏其余', /\.fpx-preset\.clip > :not\(\.fpx-prestab\):not\(\.fpx-clip\) \{ display: none; \}/.test(css));
}

done();
