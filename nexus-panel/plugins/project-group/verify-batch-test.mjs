/**
 * 本轮核对 / 修复：#139 #195 #200 #201 #135 #203 #204 #209 #210
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/verify-batch-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));
const RS = (rel) => strip(fs.readFileSync(path.join(HERE, '../..', rel), 'utf8'));

const mcp = RS('src-tauri/src/fpx/mcp.rs');
const sys = RS('src-tauri/src/fpx/sys.rs');
const mod = RS('src-tauri/src/fpx/mod.rs');
const main = strip(fs.readFileSync(path.join(HERE, 'main.tsx'), 'utf8'));
const eb = R('components/ErrorBoundary.tsx');
const hub = R('components/DialogsHub.tsx');
const api = R('api.ts');
const hook = R('hooks/useFpx.ts');

console.log('\n=== 1. #139 folder_icon_get 要报"来源" ===');
{
  /* 只回一个值的话，用户分不清看到的是资源管理器那个（ini）
     还是界面里那个（GUI 映射），"界面改了、资源管理器没变"会被当 bug */
  t('有 icon_source', /pub fn icon_source\(/.test(sys));
  t('返回四个字段', /-> \(String, Option<String>, bool, bool\)/.test(sys));
  t('MCP 里调用了', /super::sys::icon_source\(/.test(mcp));
  t('返回 source', /"source": source,/.test(mcp));
  t('返回 systemAttr', /"systemAttr": system_attr,/.test(mcp));
  t('返回 iniExists', /"iniExists": ini_exists,/.test(mcp));
  /* #113 两套图标都要查：只回一套会被当成丢配置 */
  t('两套都查', /pick\(&cfg\.folder_icons\)/.test(mcp) && /pick\(&cfg\.folder_gui_icons\)/.test(mcp));
}

console.log('\n=== 2. icon_resource_in 只认 [.ShellClassInfo] 段 ===');
{
  /* 全文找 IconResource 会把别的段里的同名键当成图标来源 */
  t('有段判定', /let mut in_sec = false;/.test(sys));
  t('进入正确段', /in_sec = t\.eq_ignore_ascii_case\("\[\.ShellClassInfo\]"\)/.test(sys));
  t('不在段内跳过', /if !in_sec \{ continue; \}/.test(sys));
  /* 路径可能含逗号，所以从最后一个逗号切 */
  t('从最后一个逗号切索引', /v\.rfind\(','\)/.test(sys));
}

console.log('\n=== 3. has_system_attr 不能全文找 S ===');
{
  /* 路径里可能就有大写 S，取第一段（属性字母区）判 */
  const i = sys.indexOf('fn has_system_attr');
  const blk = sys.slice(i, sys.indexOf('\n}', i));
  t('取第一段', /split_whitespace\(\)\.next\(\)/.test(blk));
  t('用 stdout 而不是 Output 本身', /String::from_utf8_lossy\(&out\.stdout\)/.test(blk));
}

console.log('\n=== 4. #195 全局异常兜底（白屏 → 报错 + 出口）===');
{
  t('有 ErrorBoundary', /export class ErrorBoundary extends Component/.test(eb));
  t('有 getDerivedStateFromError', /static getDerivedStateFromError/.test(eb));
  t('渲染路径外只记日志', /componentDidCatch[\s\S]{0,160}?console\.error/.test(eb));
  /* 主视图与设置页是两个 iframe，只包一层的话另一边崩了照样白屏 */
  t('两边各包一层', /ErrorBoundary label="主视图"/.test(main) && /ErrorBoundary label="设置页"/.test(main));
  /* 错误状态多半在磁盘配置里，不给出口就只能关掉重开 */
  t('给重试出口', /onClick=\{\(\) => this\.setState\(\{ err: null \}\)\}/.test(eb));
  t('CSS 限高防顶开窗口', /\.fpx-crash-msg \{[\s\S]{0,200}?max-height/.test(R('style.css')));
}

console.log('\n=== 5. #200 取消勾选 = 真的删掉（sync 而非 create）===');
{
  t('有 core_sync_links', /pub\(crate\) fn core_sync_links\(/.test(mod));
  t('有命令', /pub fn fpx_sync_links\(/.test(mod));
  t('已注册', /fpx::fpx_sync_links,/.test(RS('src-tauri/src/main.rs')));
  /* 对话框必须走 sync：用 create 的话取消勾选的链接会留在磁盘上 */
  t('对话框走 sync', /void s\.syncLinks\(confirmLink\.project, confirmLink\.group, names\);/.test(hub));
  t('api 有', /syncLinks: \(project: string, group: string, names: string\[\]\)/.test(api));
  t('钩子已导出', /createLink, syncLinks, removeLink,/.test(hook));

  /* 要删的 = 不在本次名单里的 */
  t('差集用大小写不敏感比对',
    /filter\(\|n\| !names\.iter\(\)\.any\(\|x\| x\.eq_ignore_ascii_case\(n\)\)\)/.test(mod));

  /*
   * 只删**确实指向本次目标组**的（原版 ApplyLinkPick 的 ownedByThis）。
   *
   * 不能"不在名单里就全删"：同一项目的不同链接名可以指向不同的组
   * （手工建或从别处迁移过来就有）。用户这次只在乙组下加一个链接名，
   * 若把账本里所有没勾的都删掉，指向甲组的那几个会一起消失 ——
   * 而他根本没对甲组做过操作。这类"改了不该改的"没有任何报错。
   */
  const i = mod.indexOf('pub(crate) fn core_sync_links(');
  const b = mod.slice(i, mod.indexOf('\npub(crate) fn ', i + 1));
  t('逐名查磁盘实际目标', /let resolve_of = \|n: &str\| -> Option<String>/.test(b));
  /*
   * 必须钉**连续的一段**：分开钉 "有 to_remove" 和 "有 normalize_key 比对"
   * 是漏报的 —— 后者在下面的 `cancelled` 里也出现一次，
   * 把 to_remove 的收窄条件换成 `true` 后断言照样通过。
   */
  t('to_remove 确实按实际目标收窄',
    /let to_remove: Vec<String> = outside\n        \.iter\(\)\n        \.filter\(\|n\| resolve_of\(n\)/.test(b));
  t('有 cancelled（含失效旧名）', /let cancelled: Vec<String> = outside/.test(b));
  t('cancelled 含失效项（None => true）', /None => true,/.test(b));
  /* 指向别组的必须保留在账本 —— 否则成了账本里查不到的静默残骸（同 #202） */
  t('只剔 删成功的 ∪ 失效的', /\|\| resolve_of\(n\)\.is_none\(\)/.test(b));
  t('不再用 removed_ok 直接剔账本', !/if removed_ok\.iter\(\)\.any\(\|x\| x\.eq_ignore_ascii_case\(n\)\) \{ continue; \}/.test(b));
}

console.log('\n=== 6. sync 的账本要写"磁盘实际状态" ===');
{
  /* 直接写 names 的话，"删失败但记录已删"会让仍存在的链接在账本里消失（同 #202） */
  t('逐个确认是否真的删掉', /filter\(\|n\| !junction::link_path\(project, n\)\.exists\(\)/.test(mod));
  t('最后仍走并入', /merge_link_names\(&mut acc, names\.clone\(\)\);/.test(mod));
}

console.log('\n=== 7. #201 一个都不剩 → 移除整条记录 ===');
{
  /* 留一条空 names 的记录，界面会显示"已链接但 0 个链接"，很怪 */
  t('空则 retain 掉', /if final_names\.is_empty\(\) \{[\s\S]{0,120}?records\.retain\(/.test(mod));
}

console.log('\n=== 8. 已实现（本轮核对确认）===');
{
  /* #135 select_folder 后自动同步内容列表 */
  /*
   * 用 `[\s\S]{0,900}?` 那种"从锚点开始若干字符内"的写法**靠不住** ——
   * 中间有注释时长度很容易超出。改成先切出这个分支的块再测。
   */
  const iSel = mcp.indexOf('"select_folder" => {');
  const jSel = mcp.indexOf('"get_selection"', iSel);
  const selBlk = mcp.slice(iSel, jSel > iSel ? jSel : iSel + 2000);
  t('#135 select_folder 会 scan', /content::scan\(&path, "all"\)/.test(selBlk));
  t('#135 同时返回 selection', /"selection": \{ "path": path, "kind": kind \}/.test(selBlk));
  /* #204 链接名大小写不敏感查重（#91 已修） */
  t('#204 junction 里不敏感查重', /x\.eq_ignore_ascii_case\(&n\)/.test(RS('src-tauri/src/fpx/junction.rs')));
  /* #209 删除已分配卡片先确认 */
  t('#209 有保留链接勾选', /title="保留链接"/.test(R('components/dialogs.tsx')));
  /* #210 仅移除当前实例：tab_index 有值时只动那一个页签 */
  t('#210 按 tab_index 移除', /Some\(i\) => \{[\s\S]{0,160}?tabs\.get_mut\(i\)/.test(mod));
  t('#210 前端传了页签下标', /s\.removeCardFull\([\s\S]{0,220}?idx/.test(hub));
}

done();
