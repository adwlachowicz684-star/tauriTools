/**
 * 软件图标：两步确认 / 拖放 / 粘贴（#110 #111 #112，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/win-icon-test.mjs
 *
 * #110 为什么要两步：换软件图标是**窗口级**操作。
 *   点了就换的话，用户想试几个图标时窗口一直在闪，且没有取消余地。
 * #111/#112 共用一个入口：拖放与粘贴在前端拿到的都是**文件内容**，
 *   落盘后处理完全一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const dlg = strip(fs.readFileSync(path.join(HERE, 'components/SettingsDialog.tsx'), 'utf8'));
const css = strip(fs.readFileSync(path.join(HERE, 'style.css'), 'utf8'));

console.log('\n=== 1. #110 两步确认 ===');
{
  t('有暂存状态 pendingIcon', /useState<\{ path: string; thumb\?: string \} \| null>\(null\)/.test(dlg));
  t('点图标只是暂存', /onClick=\{\(\) => stageWindowIcon\(abs, iconThumbs\[n\]\)\}/.test(dlg));
  /* **点击不能直接应用** —— 这是 #110 的全部意义 */
  t('点击不调 setWindowIcon', !/onClick=\{\(\) => void applyWindowIcon\(n\)\}/.test(dlg));
  t('应用走独立的 applyWindowIcon', /const applyWindowIcon = async \(\) =>/.test(dlg));
  t('应用时才调 api.setWindowIcon', /await api\.setWindowIcon\(pendingIcon\.path\)/.test(dlg));
  t('有取消', /onClick=\{\(\) => setPendingIcon\(null\)\}/.test(dlg));
  t('选中态标 pending 而非 applied', /className=\{`fpx-settings-iconbtn\$\{on \? ' pending' : ''\}`\}/.test(dlg));
  t('待应用条显示名字', /待应用：\{pendingIcon\.path\.split/.test(dlg));
  t('应用成功后清空暂存', /setPendingIcon\(null\);?\s*\n\s*\} catch/.test(dlg)
    || /onLog\(`已更换软件图标[\s\S]{0,80}?setPendingIcon\(null\)/.test(dlg));
}

console.log('\n=== 2. #111 拖放 ===');
{
  t('有拖放区', /className=\{`fpx-windrop\$/.test(dlg));
  t('dragOver 阻止默认', /onDragOver=\{\(e\) => \{ e\.preventDefault\(\); setWinDropOver\(true\); \}\}/.test(dlg));
  /* **必须 preventDefault**，否则浏览器直接打开这个文件，页面跳走 */
  t('drop 阻止默认', /onDrop=\{\(e\) => \{\s*\n\s*e\.preventDefault\(\);/.test(dlg));
  t('取第一个文件', /e\.dataTransfer\?\.files\?\.\[0\]/.test(dlg));
  t('拖到上面才高亮', /winDropOver \? ' over' : ''/.test(dlg));
  t('离开时取消高亮', /onDragLeave=\{\(\) => setWinDropOver\(false\)\}/.test(dlg));
  t('拖放高亮有样式', /\.fpx-windrop\.over \{/.test(css));
  t('拖放区可聚焦（键盘可达）', /tabIndex=\{0\}/.test(dlg));
}

console.log('\n=== 3. #112 粘贴 ===');
{
  t('有 onPaste', /onPaste=\{\(e\) => \{/.test(dlg));
  /* 只认图片类型，否则复制路径时也会往这里塞 */
  t('只取 image 类型', /it\.type\.startsWith\('image\/'\)/.test(dlg));
  t('转成 File', /item\.getAsFile\(\)/.test(dlg));
  /* 限定在软件图标这一区，不用 window 级监听 */
  t('不挂在 window 上', !/window\.addEventListener\('paste'/.test(dlg));
}

console.log('\n=== 4. 收入图片（拖放/粘贴共用）===');
{
  t('有共用入口 ingestImage', /const ingestImage = async \(file: File, srcLabel: string\)/.test(dlg));
  t('拖放走它', /void ingestImage\(f, '拖入'\)/.test(dlg));
  t('粘贴走它', /void ingestImage\(f, '粘贴'\)/.test(dlg));

  /* **先校验扩展名**：把非图片传后端会得到一条看不懂的报错 */
  t('校验图片扩展名', /\\\.\(ico\|png\|jpe\?g\|bmp\)\$\/\.test\(lower\)/.test(dlg));
  t('非图片时明确提示', /不是图片（只支持/.test(dlg));

  /* dataURL 要剥掉前缀 —— 后端要的是纯 base64 */
  t('剥掉 dataURL 前缀', /split\(','\)\[1\]/.test(dlg));

  /* 先落盘到 icons/，再拿返回路径 */
  t('落盘走 saveIconData', /await api\.saveIconData\(file\.name, b64\)/.test(dlg));
  t('用返回的绝对路径', /stageWindowIcon\(saved/.test(dlg));
  /* 顺带成为"我的图标"的一员 */
  t('并入图标列表（去重）', /setIconFiles\(\(prev\) => \(prev\.includes\(saved\) \? prev : \[...prev, saved\]\)\)/.test(dlg));

  t('失败有日志', /失败：\$\{errText\(e\)\}/.test(dlg));
  t('busy 状态会复位', /finally \{\s*\n\s*setWinBusy\(''\);/.test(dlg));
}

console.log('\n=== 5. 提示语义 ===');
{
  /* 重启恢复默认这件事必须说 —— 用户会以为永久生效 */
  t('应用后提示重启恢复默认', /重启后恢复默认/.test(dlg));
  t('拖放区有说明 title', /title="把 \.ico \/ \.png 拖到这里/.test(dlg));
  t('待应用条有说明', /点「应用」生效/.test(dlg));
}

done();
