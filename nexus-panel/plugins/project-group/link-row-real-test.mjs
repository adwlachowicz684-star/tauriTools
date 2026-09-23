/**
 * 链接明细逐行反查真实目标（对齐原版 ScanProjectCard 的 row 级 ResolveTarget）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/link-row-real-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const R = (n) => strip(fs.readFileSync(path.join(HERE, n), 'utf8'));

const rs = R('../../src-tauri/src/fpx/store.rs');
const model = R('../../src-tauri/src/fpx/model.rs');
const grid = R('components/CardGrid.tsx');
const types = R('types.ts');

console.log('\n=== 1. 后端逐行反查 ===');
{
  /*
   * 一个项目可以有多个链接名指向**不同的组**。
   * 整卡共用一个 group 时，必然有行是错的 —— 而它看起来完全正常。
   */
  t('逐名解析链接路径', /junction::link_path\(path, n\)/.test(rs));
  t('解析真实目标', /junction::resolve_target\(/.test(rs));
  /*
   * 只在"读得到且确实存在"时才覆盖。
   * 否则读不到（权限/损坏）会被显示成"没连" —— 那是编造信息。
   */
  t('目标要存在才采信', /filter\(\|t\| !t\.is_empty\(\) && std::path::Path::new\(t\)\.exists\(\)\)/.test(rs));
  /* 组名从真实路径末级取，不是照抄账本 */
  t('组名取自真实路径', /std::path::Path::new\(t\)\s*\n\s*\.file_name\(\)/.test(rs));
}

console.log('\n=== 2. 四种情况要分得清 ===');
{
  /*
   * "项目文件夹没了"和"项目组文件夹没了"是两种**完全不同的补救方式**，
   * 只给笼统的"链接异常"，用户看不出区别就只能瞎试。
   */
  t('项目文件夹不存在', /项目文件夹不存在/.test(rs));
  t('项目组文件夹不存在', /项目组文件夹不存在/.test(rs));
  t('链接冲突带名字', /链接冲突: \{n\} 被普通目录\/文件占用/.test(rs));
  t('链接已破坏带名字', /链接已破坏: \{n\}/.test(rs));
  t('正常时带组名', /链接项目组: \{gname\}（\{n\}）/.test(rs));
  /* 顺序：先判项目本身，再判组 —— 项目都没了就别谈组了 */
  const iProj = rs.indexOf('项目文件夹不存在');
  const iGrp = rs.indexOf('项目组文件夹不存在');
  t('先判项目再判组', iProj > 0 && iGrp > iProj, `proj=${iProj} grp=${iGrp}`);
}

console.log('\n=== 3. 新增字段（跨端一致）===');
{
  t('Rust 有 real_group_name', /pub real_group_name: String,/.test(model));
  t('Rust 有 real_group', /pub real_group: String,/.test(model));
  t('Rust 有 project_exists', /pub project_exists: bool,/.test(model));
  t('Rust 有 group_exists', /pub group_exists: bool,/.test(model));
  t('Rust 有 tip', /pub tip: String,/.test(model));
  t('前端有 realGroupName', /realGroupName: string;/.test(types));
  t('前端有 realGroup', /realGroup: string;/.test(types));
  t('前端有 projectExists', /projectExists: boolean;/.test(types));
  t('前端有 groupExists', /groupExists: boolean;/.test(types));
  t('前端有 tip', /tip: string;/.test(types));
}

console.log('\n=== 4. 前端用真实值（#82 的编辑目标）===');
{
  /*
   * #82「点链接名编辑那一条」传的 group 必须是**这一行真实指向**的组。
   * 用整卡共用的 group 会改到另一条 —— 改了不该改的地方，且没提示。
   */
  t('显示组名用真实值', /const gName = d\.realGroupName \|\| d\.groupName;/.test(grid));
  t('显示路径用真实值', /const gPath = d\.realGroup \|\| d\.group;/.test(grid));
  t('编辑传真实路径', /onEditLink\(c\.path, gPath\);/.test(grid));
  /* 真实值缺失时退回账本值："当初登记到哪"仍比空着有用 */
  t('编辑不再用整卡 group', !/onEditLink\(c\.path, d\.group\)/.test(grid));
  /* 去重 key 也要跟着真实值，否则两行同名字不同组会撞 key */
  t('key 用真实路径', /key=\{d\.name \+ gPath\}/.test(grid));
}

console.log('\n=== 5. 提示接到界面 ===');
{
  t('状态点用逐行 tip', /title=\{d\.tip \|\| STATE_TITLE\[d\.state\]\}/.test(grid));
  t('链接名悬停用 tip', /title=\{d\.tip \|\| d\.name\}/.test(grid));
  /*
   * 组文件夹没了要单独标 —— 它与"链接失效"是两回事：
   * 前者是目标被删，后者是链接断了。
   */
  t('组缺失单独标', /d\.groupExists === false && gPath/.test(grid));
  t('组缺失文案', /组缺失/.test(grid));
}

console.log('\n=== 8. #198 链接名勾选：换绑提示要按磁盘实际，且他组占用默认不勾选 ★★ ===');
{
  const dlg = fs.readFileSync(path.join(HERE, 'components/LinkPickDialog.tsx'), 'utf8');
  const hub = fs.readFileSync(path.join(HERE, 'components/DialogsHub.tsx'), 'utf8');

  /* 一、判定依据必须是逐名**磁盘实际**指向，不是账本的整条 group。
     账本一条记录只有一个 group，多链接名指向不同组时必然有行是错的（#202）。
     钉死"用 realGroup"而不是"用 row.group"。 */
  t('不再用账本整条 group 判定', !/row\.group/.test(dlg));
  t('改用逐名 realGroup', /d\.realGroup/.test(dlg));
  t('读不到目标时不进表（避免误判成别组）',
    /if \(d\.realGroup && d\.realGroup\.length > 0\) m\.set/.test(dlg));
  t('对话框接收逐名明细而非账本', /details\?: LinkDetail\[\]/.test(dlg));
  t('Hub 从卡片 linkDetails 取', /return c\.linkDetails/.test(hub));
  t('Hub 传的是 details 而非 links', /details=\{cardDetails\(boot/.test(hub));

  /* 二、路径比对不能直接用 ===：后端反查的目标可能带尾反斜杠。
     不等就会把"已连本组"误判成"要换绑" —— 提示错 + 默认不勾选 → 一取消就被删。 */
  t('有尾分隔符归一化比对', /replace\(\/\[\\\\\/\]\+\$\/, ''\)/.test(dlg));
  t('比对大小写不敏感', /toLowerCase\(\)/.test(dlg));
  t('rebind 用 samePath 判定', /const rebind = target !== undefined && !samePath\(target, group\)/.test(dlg));

  /* 三、他组占用的名字**默认不勾选**（原版 MakeCheck 明写）。
     默认勾上的话，用户直接点确定就把别组链接抢过来了 ——
     而他根本没打算动那边。 */
  t('初始勾选排除他组占用',
    /useState<Set<string>>\(\s*\(\) => new Set\(enabled\.filter\(\(n\) => !ownedElsewhere\.has\(n\)\)\)/.test(dlg));
  t('「回到默认」同样排除', /reset = \(\) => setPicked\(new Set\(enabled\.filter\(\(n\) => !ownedElsewhere\.has\(n\)\)\)\)/.test(dlg));
  t('界面说明为何默认不勾', /默认<b>不勾选<\/b>/.test(dlg));
}

done();
