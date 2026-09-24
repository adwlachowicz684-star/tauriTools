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

  /*
   * **只钉"文件里有这一行"是漏报** —— 改名那条路径一直有，
   * 而 `core_move_folder`（跨栏搬家触发物理搬家）**漏了这两套**，
   * 断言照样通过。必须**限定到搬家那一段**再看。
   *
   * 漏的后果：勾了「仅界面生效」的图标 / 标签色，搬完家**静默回到默认**，
   * 没有任何报错，用户只会以为搬家把设置弄丢了。
   */
  const mi = mod.indexOf('fn core_move_folder(');
  const mv = mod.slice(mi, mod.indexOf('\n}\n', mi));
  t('搬家段存在', mi >= 0 && mv.length > 0);
  t('搬家换键挪 gui 表', /remap_keys\(std::mem::take\(&mut cfg\.folder_gui_icons\)/.test(mv));
  t('搬家换键挪 explorer 表', /remap_keys\(std::mem::take\(&mut cfg\.folder_icons\)/.test(mv));
  t('搬家换键挪 GUI 色', /remap_keys\(std::mem::take\(&mut cfg\.tag_gui_colors\)/.test(mv));
  t('搬家换键挪普通色', /remap_keys\(std::mem::take\(&mut cfg\.tag_colors\)/.test(mv));
  /* 四套齐全，与改名 / cli 迁移两条路径写法一致 */
  t('搬家段四套齐全',
    (mv.match(/remap_keys\(std::mem::take\(&mut cfg\.\w+\)/g) || []).length === 4,
    '命中 ' + (mv.match(/remap_keys\(std::mem::take\(&mut cfg\.\w+\)/g) || []).length + ' 套');

  const ri = mod.indexOf('fn core_rename_folder(');
  const rn = mod.slice(ri, mod.indexOf('\n}\n', ri));
  t('改名段存在', ri >= 0 && rn.length > 0);
  t('改名换键挪 gui 表', /remap_keys\(std::mem::take\(&mut cfg\.folder_gui_icons\)/.test(rn));
  t('改名换键挪 explorer 表', /remap_keys\(std::mem::take\(&mut cfg\.folder_icons\)/.test(rn));
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
  const host = fs.readFileSync(path.join(HERE, 'components/DialogsHub.tsx'), 'utf8')
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

console.log('\n=== 第 8 节 · #77 仅界面生效：save_style 这条路径 ★★ ===');
{
  /*
   * #77 状态表写「只有『同步到资源管理器』一个开关」—— 其实那就是
   * 原版 `iconAffectExplorer`，**原版也只有这一个开关**（AppConfig.cs:272），
   * 本版 SettingsDialog 里已有。所以 #77 本身是**已做**。
   *
   * 但核对时发现一个**真 BUG**：`core_save_style` 里 gui_only 只作用于
   * **标签色**（tag_gui_colors），**图标那半边被忽略** ——
   * 无条件写 folder_icons + 无条件写 desktop.ini。
   *
   * StyleDialog（右键「图标与标签…」）走的就是这条路径，
   * 也就是用户勾「仅界面生效」设图标的那个入口。
   */
  const mod = fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx/mod.rs'), 'utf8');
  const i = mod.indexOf('pub(crate) fn core_save_style(');
  const blk = mod.slice(i, mod.indexOf('\n}\n', i));

  /* 一、图标必须按 gui_only 分流到两套表 */
  t('图标按 gui_only 分流（if gui_only）', /if gui_only \{[\s\S]{0,300}folder_gui_icons/.test(blk));
  t('gui_only 时写 folder_gui_icons',
    /if gui_only \{[\s\S]{0,200}folder_gui_icons\.insert/.test(blk));
  t('非 gui_only 时写 folder_icons',
    /\} else \{[\s\S]{0,200}folder_icons\.insert/.test(blk));

  /*
   * 二、**反面证据**：不允许再出现"无条件写 folder_icons.insert"。
   * 只钉"有 folder_gui_icons.insert"是**漏报** ——
   * 把分流删掉、只留一处无条件 folder_icons.insert，断言照样通过。
   */
  t('没有无条件写 folder_icons（反面证据）',
    !/let icon = icon[\s\S]{0,200}?folder_icons\.insert/.test(
      blk.replace(/if gui_only \{[\s\S]*?\} else \{[\s\S]*?\}/, '')),
    '分流块之外不应再有 folder_icons.insert');

  /* 三、desktop.ini 必须在 gui_only 时不写 */
  t('desktop.ini 只在非 gui_only 时写',
    /icon_affect_explorer && !gui_only && cfg!\(windows\)/.test(blk));
  t('没有无条件写 desktop.ini（反面证据）',
    !/icon_affect_explorer && cfg!\(windows\)/.test(blk));

  /* 四、清键要用归一化键：大小写/尾斜杠不同会被当成两条登记 */
  t('清键按归一化键（retain + normalize_key）',
    (blk.match(/retain\(\|k, _\| store::normalize_key\(k\) != key/g) || []).length >= 2,
    '命中 ' + (blk.match(/retain\(\|k, _\| store::normalize_key\(k\) != key/g) || []).length + ' 处');

  /* 五、与 fpx_set_icon 同写法：两条路做的是同一件事 */
  const j = mod.indexOf('pub fn fpx_set_icon(');
  const blk2 = mod.slice(j, mod.indexOf('\n}\n', j));
  t('fpx_set_icon 同样按 gui 分流', /if gui \{[\s\S]{0,300}folder_gui_icons/.test(blk2));
  t('fpx_set_icon 同样不在 gui 时写 ini', /affect && !gui && cfg!\(windows\)/.test(blk2));

  /* 六、标签色那半边本来就是对的，别改回去 */
  t('标签色按 gui_only 分流到 tag_gui_colors',
    /let color_table = if gui_only \{ &mut cfg\.tag_gui_colors \} else \{ &mut cfg\.tag_colors \}/.test(blk));

  /* 七、原版只有一个开关，本版也只有一个（不是"缺一个"） */
  const types = fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8');
  t('config 有 iconAffectExplorer 开关', /iconAffectExplorer/.test(types));
}

console.log('\n=== 第 10 节 · icon_data 白名单要收两套图标 ★★ ===');
{
  /*
   * `core_icon_data` 只允许「数据目录 icons/」+「用户已登记的图标引用」。
   * 此前**只收 `folder_icons`**，漏了 `folder_gui_icons`。
   *
   * 后果非常具体：同一个图标文件，勾「仅界面生效」设下去就**读不出来** ——
   * 而前端 `useIconThumbs` 对失败是 `catch {}` 静默处理的，
   * 卡片图标默默变回占位字符，用户点完确认看到"什么都没变"。
   * 取消勾选同一个图标又能显示，于是表现为"这个开关有毛病"。
   */
  const mod = fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8');
  const i = mod.indexOf('pub(crate) fn core_icon_data(');
  const blk = mod.slice(i, mod.indexOf('\n}\n', i));
  t('icon_data 函数段存在', i >= 0 && blk.length > 0);
  t('白名单收 explorer 那套', /for v in cfg\.folder_icons\.values\(\)/.test(blk));
  t('白名单收 gui 那套', /for v in cfg\.folder_gui_icons\.values\(\)/.test(blk));
  /* 两套都要过 icon_file_part（DLL 引用是「文件|索引」，要掐竖线前那段） */
  t('两套都过 icon_file_part',
    (blk.match(/push\(&icon_file_part\(v\)\)/g) || []).length === 2,
    '命中 ' + (blk.match(/push\(&icon_file_part\(v\)\)/g) || []).length + ' 处');
}

console.log('\n=== 第 11 节 · folder_icon_restore 要清两套 ★★ ===');
{
  /*
   * MCP `folder_icon_restore`（恢复默认图标）此前**只清 `folder_icons`**。
   *
   * 于是：勾「仅界面生效」设过图标的目录，调这个工具**还原不掉** ——
   * 回包仍旧是一句"已恢复默认图标"，而界面上图标还在。
   * 对 AI 调用方来说这就是一次假成功：它以为做完了，显示却没变，
   * 且没有任何线索指向"还有一套没清"。
   *
   * 另外原来用 `let _ =` 吞掉了 `apply_icon` 的失败：目录被自己设了
   * 「防写入」时 desktop.ini 根本没删掉，回包却照常说成功。
   */
  const mcp = fs.readFileSync(path.join(RS, 'mcp.rs'), 'utf8');
  const i = mcp.indexOf('"folder_icon_restore" => {');
  const blk = mcp.slice(i, mcp.indexOf('\n        }', i));
  t('restore 段存在', i >= 0 && blk.length > 0);
  t('清 explorer 那套', /&mut cfg\.folder_icons/.test(blk));
  t('清 gui 那套', /&mut cfg\.folder_gui_icons/.test(blk));
  t('两套一起清（同一个循环）',
    /for table in \[&mut cfg\.folder_icons, &mut cfg\.folder_gui_icons\]/.test(blk));
  /*
   * **反面证据**：不得再出现 `let _ = ...with_unlock` ——
   * 只钉"有 with_unlock"是漏报，吞掉失败的写法里也有它。
   */
  t('没有吞掉 apply_icon 的失败（反面证据）',
    !/let _ = super::with_unlock/.test(blk), '失败要写进回包，不能静默');
  t('失败写进回包', /Err\(e\) => note\.push_str/.test(blk));
  /* 没东西可清时要说清楚，而不是一律报"已恢复" */
  t('无登记时如实说明', /没有自定义图标登记/.test(blk));
}

console.log('\n=== 第 9 节 · #433 locked 账面固定并入 locks ===');
{
  const types = fs.readFileSync(path.join(HERE, 'types.ts'), 'utf8');
  /*
   * 原版 `config.Locked` 是**独立于 folderLock.items 的另一个列表**
   * （MainViewModel：`if (!IsLockedPath(key)) _config.Locked.Add(key);`）。
   * 本版用 `locks[].accountOnly` 一个标志位表达同一件事。
   *
   * 两者**等价**：都能表达"在册但无 ACL"。一个列表 + 标志位 vs 两个列表，
   * 后者反而要维护两处的一致性（搬家/改名要同时 remap 两个列表，
   * 漏一个就是"账面固定静默失效"）。所以判 ➖（有意合并，不是缺口）。
   */
  t('accountFixed 存在（卡片上的账面固定）', /accountFixed/.test(types));
  t('accountOnly 存在（后端 LockItem）', /accountOnly/.test(types));
}

done();
