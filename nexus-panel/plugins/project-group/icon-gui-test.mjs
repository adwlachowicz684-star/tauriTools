/**
 * 界面专属图标（#13，零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/icon-gui-test.mjs
 *
 * #13 = 两套图标互不覆盖：
 *   · folder_icons      写 desktop.ini，资源管理器看得见
 *   · folder_gui_icons  只在界面内生效，**从不碰 desktop.ini**
 *
 * 最容易漏掉的两处（都会**静默**丢数据）：
 *   1. 搬家 / 改名换键时只挪一套 → GUI 图标静默失效
 *   2. 图标改名（#10）只同步一套 → 用作 GUI 图标的那些静默断链
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '..', '..', 'src-tauri', 'src', 'fpx');
const { t, done } = makeT();

console.log('\n=== 1. 两套独立，互不覆盖 ===');
{
  const model = fs.readFileSync(path.join(RS, 'model.rs'), 'utf8');
  t('有 folder_gui_icons 字段', /pub folder_gui_icons: IconMap/.test(model));
  t('有 serde default（老配置兼容）', /#\[serde\(default\)\]\s*\n\s*pub folder_gui_icons/.test(model));
  t('默认值已初始化', /folder_gui_icons: HashMap::new\(\)/.test(model));
  t('CardInfo 有 gui_icon', /pub gui_icon: Option<String>/.test(model));

  const mod = fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  /* set_icon 按 gui_only 选目标表 */
  t('set_icon 有 gui_only 参数', /gui_only: Option<bool>/.test(mod));
  t('gui 时写 gui 表', /if gui \{[\s\S]{0,200}?folder_gui_icons\.insert/.test(mod));
  t('非 gui 时写 explorer 表', /else \{[\s\S]{0,200}?folder_icons\.insert/.test(mod));
  /* **只清目标那套**——设 GUI 不能把 explorer 那套抹掉 */
  t('gui 时清 gui 表', /if gui \{[\s\S]{0,120}?folder_gui_icons\.retain/.test(mod));
  t('非 gui 时清 explorer 表', /\} else \{[\s\S]{0,120}?folder_icons\.retain/.test(mod));

  /* **GUI 专属绝不写 desktop.ini** —— 否则两套没区别了 */
  t('gui 时不写 desktop.ini', /if affect && !gui && cfg!\(windows\)/.test(mod));
  t('没有 affect && cfg!(windows) 的旧写法', !/if affect && cfg!\(windows\) \{/.test(mod));
}

console.log('\n=== 2. 搬家 / 改名都要挪两套（漏了静默丢失）===');
{
  const cli = fs.readFileSync(path.join(RS, 'cli.rs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const mod = fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  t('搬家挪 gui 表', /remap\(cfg\.folder_gui_icons\.clone\(\), &key, &it\.dst\)/.test(cli));
  t('搬家挪 explorer 表', /remap\(cfg\.folder_icons\.clone\(\), &key, &it\.dst\)/.test(cli));
  t('改名换键挪 gui 表', /remap_keys\(std::mem::take\(&mut cfg\.folder_gui_icons\)/.test(mod));
  t('改名换键挪 explorer 表', /remap_keys\(std::mem::take\(&mut cfg\.folder_icons\)/.test(mod));
}

console.log('\n=== 3. 图标改名要同步两套（#10 × #13）===');
{
  const mod = fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const body = mod.slice(mod.indexOf('fn core_rename_icon'));
  const seg = body.slice(0, body.indexOf('\n}\n') + 3);
  t('改名同步 explorer 表', /folder_icons\.values_mut\(\)/.test(seg));
  t('改名同步 gui 表', /folder_gui_icons\.values_mut\(\)/.test(seg));
}

console.log('\n=== 4. 显示优先界面那套 ===');
{
  const { displayIcon } = await loadTs(path.join(HERE, 'utils/icons.ts'));
  t('有 displayIcon', typeof displayIcon === 'function');
  t('gui 优先', displayIcon({ guiIcon: 'a.ico', icon: 'b.ico' }) === 'a.ico');
  t('gui 空则回退', displayIcon({ guiIcon: null, icon: 'b.ico' }) === 'b.ico');
  t('两者都空', displayIcon({ guiIcon: null, icon: null }) === null);

  /* 缩略图与兜底字形**必须都用它** —— 各写一遍的话改优先级容易只改一处 */
  const grid = fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  t('缩略图用 displayIcon', /thumbs\?\.\[displayIcon\(c\) as string\]/.test(grid));
  t('从 utils/icons 引入（不各写一份）', /import \{ displayIcon \} from '\.\.\/utils\/icons'/.test(grid));
  t('兜底字形用 displayIcon', /function iconOf[\s\S]{0,200}?displayIcon\(c\)/.test(grid));
  t('没有直接用 c.icon 取缩略图', !/thumbs\?\.\[c\.icon\]/.test(grid));
}

console.log('\n=== 5. 标签色的两套（#113）===');
{
  const model = fs.readFileSync(path.join(RS, 'model.rs'), 'utf8');
  const store = fs.readFileSync(path.join(RS, 'store.rs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const mod = fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const cli = fs.readFileSync(path.join(RS, 'cli.rs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const types = fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8');

  t('有 tag_gui_colors 字段', /pub tag_gui_colors: HashMap<String, String>/.test(model));
  t('默认值已初始化', /tag_gui_colors: HashMap::new\(\)/.test(model));
  t('types 有 tagGuiColors', /tagGuiColors/.test(types));

  /* **GUI 那套优先**，且继承也要按同一优先级 */
  t('自身 GUI 优先', /tag_gui_colors\.get\(path\)\.or_else\(\|\| cfg\.tag_colors\.get\(path\)\)/.test(store));
  t('继承先看组的 GUI 色', /cfg\.tag_gui_colors\.get\(&rec\.lib\)/.test(store));
  t('继承再看组的普通色', /if let Some\(c\) = cfg\.tag_colors\.get\(&rec\.lib\)/.test(store));

  /* 只动目标那一套 */
  t('save_style 选表', /let color_table = if gui_only \{ &mut cfg\.tag_gui_colors \} else \{ &mut cfg\.tag_colors \}/.test(mod));
  t('set_tag_color 选表', /let table = if gui_only \{ &mut cfg\.tag_gui_colors \} else \{ &mut cfg\.tag_colors \}/.test(mod));

  /* 搬家 / 改名换键两套都要挪 */
  t('搬家挪 GUI 色', /remap\(cfg\.tag_gui_colors\.clone\(\), &key, &it\.dst\)/.test(cli));
  t('改名换键挪 GUI 色', /remap_keys\(std::mem::take\(&mut cfg\.tag_gui_colors\)/.test(mod));

  /* 命令参数 */
  t('save_style 有 gui_only', /gui_only: Option<bool>/.test(mod));
  t('MCP 侧走普通那套', /, false\)\s*\n\s*\.map_err\(\|e\| err\(&e\)\)/.test(
    fs.readFileSync(path.join(RS, 'mcp.rs'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));

  const api = fs.readFileSync(path.join(HERE, 'api.ts'), 'utf8');
  t('前端 saveStyle 传 gui_only', /gui_only: guiOnly \?\? null/.test(api));
}

console.log('\n=== 6. 界面开关与参数传递 ===');
{
  const dlg = fs.readFileSync(path.join(HERE, 'components/dialogs.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const host = fs.readFileSync(path.join(HERE, 'components/Dialogs.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const api = fs.readFileSync(path.join(HERE, 'api.ts'), 'utf8');
  const types = fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8');

  t('有「仅界面内生效」开关', /仅界面内生效/.test(dlg));
  t('开关是 checkbox', /type="checkbox"/.test(dlg));
  t('默认关（保持原行为）', /useState\(false\)/.test(dlg));
  /* 必须说清改的是哪一套，否则"界面变了资源管理器没变"会被当成功能没生效 */
  t('开关有即时说明', /fpx-icongui-hint/.test(dlg));

  /* onPick 要把 guiOnly 传出去 */
  t('onPick 传出 guiOnly', /onPick: \(path: string, guiOnly: boolean\)/.test(dlg));
  t('内置图标传入', /onPick\(p, guiOnly\)/.test(dlg));
  t('我的图标传入', /onPick\(f, guiOnly\)/.test(dlg));
  t('宿主透传给 setIcon', /s\.setIcon\(iconTargetPath, p, undefined, g\)/.test(host));

  t('api 有 guiOnly 参数', /guiOnly\?: boolean/.test(api));
  t('api 传 gui_only', /gui_only: guiOnly \?\? null/.test(api));
  t('types 有 folderGuiIcons', /folderGuiIcons/.test(types));
  t('types CardInfo 有 guiIcon', /guiIcon: string \| null/.test(
    fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8')));
  /* 样式弹窗（图标+标签色）也要有同一个开关 */
  t('样式弹窗也有该开关', /仅界面内生效/.test(dlg));
  t('样式弹窗 onApply 传 guiOnly', /onApply\(ic\.trim\(\) \|\| null, cl, guiOnly\)/.test(dlg));
  t('宿主透传第三个参数', /s\.saveStyle\(dialog\.card\.path, icon, color, gui\)/.test(host));
}

done();
