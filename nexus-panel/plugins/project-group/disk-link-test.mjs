/**
 * 链接的磁盘兜底回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/disk-link-test.mjs，然后
 *         node plugins/project-group/disk-link-test.mjs
 *
 * #181 #215：junction 可以在本工具之外被创建（手工 mklink、别的脚本、
 * 旧版本迁移遗漏）。那种情况下账本没有记录，卡片就显示不出
 * "链到了哪个项目组" —— 而链接明明在磁盘上好好存在着。
 *
 * 这里守四件容易做错的事：
 *   · 有账本记录时**不覆盖**（显式登记的优先于推断的）
 *   · 只认 Valid 状态（断链/占位目录不该被当成有效指向）
 *   · 组路径优先取**已登记**的那条（大小写/结尾分隔符可能与 junction 里的不同）
 *   · **跳转也要跟着兜底** —— 否则变成"名字看得见、点了却报错"，
 *     比干脆不显示更让人困惑
 *   · 组路径清单算一次、逐卡复用（每张卡重扫一遍页签是几百次无谓分配）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '../../src-tauri/src/fpx/store.rs');
const { t, done } = makeT();

const hasRs = fs.existsSync(RS);
const rs = hasRs ? fs.readFileSync(RS, 'utf8') : '';
const app = fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8');

console.log('\n=== 1. 兜底函数本身 ===');
if (!hasRs) { console.log('（跳过：未找到 store.rs）'); } else {
  t('disk_group_of 存在', /fn disk_group_of\(/.test(rs));
  const fn = rs.slice(rs.indexOf('fn disk_group_of('), rs.indexOf('#[allow(clippy::too_many_arguments)]'));
  t('只认 Valid（断链与占位不算）',
    /link_state\(project, n\) != super::junction::LinkState::Valid/.test(fn));
  t('用 resolve_target 读真实指向', /resolve_target\(&lp\)/.test(fn));
  t('读不到就跳过、不整段放弃', /else \{ continue \}/.test(fn));
  t('找到就停（不是全扫一遍再挑）', /return Some\(\(name, path\)\);/.test(fn));
  t('优先取已登记的组路径',
    /group_paths\s*\.iter\(\)\s*\.find\(\|g\| normalize_key\(g\) == tk\)/.test(fn));
  t('未登记时仍如实给出目标本身', /\.unwrap_or\(raw\)/.test(fn));
  t('去尾部分隔符后再比对', /trim_end_matches\(\|c\| c == '\\\\' \|\| c == '\/'\)/.test(fn));
}

console.log('\n=== 2. 只在账本缺记录时才兜底 ===');
{
  const bc = rs.slice(rs.indexOf('fn build_card('), rs.indexOf('fn build_link_rows'));
  t('rec 为空才扫磁盘', /if rec\.is_none\(\) \{ disk_group_of\(/.test(bc));
  t('先取账本、兜底在后（不覆盖显式登记）',
    /rec\.map\(\|r\| r\.group\.clone\(\)\)\s*\.or_else\(\|\| fb_name\.clone\(\)\)/.test(bc));
  t('组路径同理（r.lib 优先）',
    /rec\.map\(\|r\| r\.lib\.clone\(\)\)\s*\.or_else\(\|\| fb_path\.clone\(\)\)/.test(bc));
  t('创建时间不用兜底编造（磁盘读不出来）',
    /created: rec\.map\(\|r\| r\.created\.clone\(\)\)\.unwrap_or_default\(\)/.test(bc));
  t('卡片 linked_group 也用上兜底',
    /\.or_else\(\|\| fb_name\.filter\(\|s\| !s\.is_empty\(\)\)\)/.test(bc));
}

console.log('\n=== 3. 组路径清单算一次、逐卡复用 ===');
{
  t('collect_group_paths 存在', /fn collect_group_paths\(/.test(rs));
  t('在 build_tabs 里算一次', /let group_paths = collect_group_paths\(cfg\);/.test(rs));
  t('传进 build_card（不是每卡重算）',
    /build_card\(p, cfg, records, preset_names, kind, &group_paths\)/.test(rs));
  t('按 normalize_key 去重', /seen\.insert\(normalize_key\(g\)\)/.test(rs));
  t('用了 HashSet', /use std::collections::HashSet;/.test(rs));
}

console.log('\n=== 4. 跳转必须跟着兜底（否则"看得见点不动"）===');
{
  const fn = app.slice(app.indexOf('const jumpToGroup'), app.indexOf('}, [boot, ctx, s, setFocus]);'));
  t('首选仍是账本记录', /const row = boot\?\.links\.find\(/.test(fn));
  t('账本缺失时退回卡片明细里的 group',
    /card\.linkDetails\?\.find\(\(d\) => d\.state === 'valid' && d\.group\)\?\.group/.test(fn));
  t('退回的必须限定 valid 状态（断链不该能跳）', /d\.state === 'valid'/.test(fn));
  t('后续选中用的是兜底后的变量', /s\.setSelGroup\(group\);/.test(fn));
  t('滚动定位也用它', /setReveal\(\{ path: group,/.test(fn));
  t('已不再直接引用 row.group', !/row\.group/.test(fn));
  t('两处都没有时才报错', /if \(!group\) \{/.test(fn));
}

console.log('\n=== 5. 界面确有展示（改了才看得见）===');
{
  t('卡片明细在展示', /linkDetails/.test(fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8')));
  t('组名来自 linkedGroup', /card\.linkedGroup/.test(app));
}

console.log('\n=== 6. 徽章数字必须是链接总数，且异常要说出来 ===');
{
  /*
   * 原版 `LinkCount = LinkRows.Count` —— 是**所有链接名**的条数，含失效
   * 与冲突。此前算的是有效条数，于是徽章数字与展开后的行数对不上：
   * 3 条全失效时徽章显示 "0"，点开却是 3 行，而 "0" 旁边还挂着红点，
   * 两个信号互相矛盾 —— 用户既不相信 0，也不知道有 3 条要修。
   */
  const rs = fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx/store.rs'), 'utf8');
  t('link_count 取明细总条数', /link_count: details\.len\(\),/.test(rs));
  /* 反面证据：不能再是"有效条数" */
  t('link_count 不再是 has_link（反面证据）', !/link_count: has_link,/.test(rs));
  /*
   * has_link 的语义**不能跟着改**：它决定徽章显不显示，
   * 全失效时确实"没有一条是通的"，改成总数会让空徽章也挂出来。
   */
  t('has_link 仍是有效条数（语义不变）', /has_link: has_link > 0,/.test(rs));

  const cg = fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8');
  /* 光有颜色圆点不够：收起状态下"3 条里有 1 条坏了"和"3 条都好"长得一样 */
  t('可展开徽章的 title 会说出冲突', /有冲突，点击展开查看/.test(cg));
  t('可展开徽章的 title 会说出失效', /有失效，点击展开查看/.test(cg));
  t('可展开徽章的 title 带条数', /title=\{`\$\{c\.linkCount\} 条链接/.test(cg));
  t('不可展开徽章的 title 也带条数', /已建 \$\{c\.linkCount\} 条链接/.test(cg));
}


done();
