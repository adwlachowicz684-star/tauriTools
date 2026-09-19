/**
 * 图标改名回归测试（#10，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/icon-rename-test.mjs
 *
 * #10 的核心不是"多了个输入框"，而是**改名必须同步 folder_icons**：
 * 只改文件不同步引用 → 卡片图标全部显示不出来，
 * 且界面上没有任何报错（图标位置空一块）。
 * 这类"静默断链"比报错难查得多，而改名看起来毫无风险。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const RS = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx');

console.log('\n=== 1. 后端：改名核心（core_rename_icon）===');
{
  const mod = fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8');
  /* 只剥块注释，保留行注释里的关键信息 */
  const src = mod.replace(/\/\*[\s\S]*?\*\//g, '');

  t('有 core_rename_icon', /pub\(crate\) fn core_rename_icon/.test(src));
  t('有 fpx_rename_icon 命令', /pub fn fpx_rename_icon/.test(mod));
  t('已在 main.rs 注册',
    /fpx::fpx_rename_icon/.test(fs.readFileSync(path.join(RS, '..', 'main.rs'), 'utf8')));

  /* **必须同步 folder_icons** —— 这是 #10 的全部意义 */
  t('同步 folder_icons 引用', /cfg\.folder_icons\.values_mut\(\)/.test(src));
  /* 精确匹配，不能子串替换（foo.ico 与 foo2.ico 会互相污染） */
  t('按规范化路径精确匹配', /normalize_key\(v\) == old_key/.test(src));
  t('没有子串替换', !/\.contains\(&old_path\)|\.replace\(&old_path/.test(src));
  /* 计数必须回报给前端 */
  t('统计 affected', /n \+= 1/.test(src));

  /* **old 必须落在 icons/ 下** —— 否则这命令就是"重命名任意文件" */
  t('校验 old 在 icons 目录下', /guard::must_be_under/.test(src));

  /* **保留原扩展名**：PNG 改成 .ico 会显示不出来 */
  t('保留原扩展名', /old_canon\.extension\(\)/.test(src));

  /* 目标已存在时不覆盖 */
  t('目标已存在则拒绝', /if dest\.exists\(\)/.test(src));
  t('改名失败时直接返回（配置未动）', /std::fs::rename\(&old_canon, &dest\)\.map_err/.test(src));
  /* **配置写失败要把文件改名回去** —— 否则又是一次断链 */
  t('配置失败时回滚物理改名', /Err\(e\) => \{[\s\S]{0,120}?rename\(&dest, &old_canon\)/.test(src));

  /* 文件名清洗抽成共用函数（保存与改名同一套规则） */
  t('有共用清洗函数', /pub\(crate\) fn sanitize_icon_name/.test(src));
  t('保存图标也用它（不抄两份）', /let safe = sanitize_icon_name\(&name\)/.test(src));
}

console.log('\n=== 2. DTO 与跨端 ===');
{
  const model = fs.readFileSync(path.join(RS, 'model.rs'), 'utf8');
  const types = fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8');
  const api = fs.readFileSync(path.join(HERE, 'api.ts'), 'utf8');

  t('Rust 有 RenameIconResult', /pub struct RenameIconResult/.test(model));
  t('含 affected 字段', /pub affected: usize/.test(model));
  t('含 icons 字段', /pub icons: Vec<String>/.test(model));
  t('TS 有对应 interface', /export interface RenameIconResult/.test(types));
  t('TS 有 affected', /affected: number/.test(types));
  /* 前端要能调 */
  t('api.ts 有 renameIcon', /renameIcon:\s*\(oldPath: string, newName: string\)/.test(api));
  t('参数名 snake_case 对齐', /'fpx_rename_icon', \{ old_path: oldPath, new_name: newName \}/.test(api));
}

console.log('\n=== 3. 界面接线 ===');
{
  const dlg = fs.readFileSync(path.join(HERE, 'components/dialogs.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const host = fs.readFileSync(path.join(HERE, 'components/Dialogs.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const cssNC = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');

  t('tile 包了 wrap 层', /className="fpx-iconwrap"/.test(dlg));
  t('有改名按钮', /className="fpx-icon-rename"/.test(dlg));
  /* 必须阻止冒泡：tile 是"选用"，✎ 是"改名"，点 ✎ 不能顺带选用 */
  t('阻止冒泡', /e\.stopPropagation\(\)/.test(dlg));
  t('改名走 api.renameIcon', /api\.renameIcon\(full, name\)/.test(dlg));

  /* **必须报出 affected** —— 用户改一个文件名，可能有 N 张卡片跟着改 */
  t('提示里报出同步数量', /同步更新 \$\{r\.affected\} 张卡片/.test(dlg));
  t('affected=0 时不说数量', /r\.affected > 0$/m.test(dlg) || /r\.affected > 0\s*$/m.test(dlg));

  /* 宿主要把新图标列表换上，否则界面还显示旧名（文件已不在那名字下） */
  t('宿主替换图标列表', /onRenamed=\{\(icons\) => setIconFiles\(icons\)\}/.test(host));

  /* CSS：看不见的按钮不能可点 */
  t('平时 pointer-events: none', /\.fpx-icon-rename \{[^}]*pointer-events: none/.test(cssNC));
  t('hover 才恢复可点', /\.fpx-iconwrap:hover \.fpx-icon-rename,[^}]*pointer-events: auto/.test(cssNC));
  t('有键盘可见态', /\.fpx-icon-rename:focus-visible/.test(cssNC));
}

done();
