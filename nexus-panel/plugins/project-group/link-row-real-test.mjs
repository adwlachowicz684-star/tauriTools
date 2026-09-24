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
  /* 两端都判（>= 0 而非 > 0：后者把"索引恰好为 0"也判成不合法） */
  t('先判项目再判组', iProj >= 0 && iGrp >= 0 && iGrp > iProj,
    `proj=${iProj} grp=${iGrp}`);
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
  /*
   * #292 之后状态点并进了链接名按钮（点标识也能编辑），
   * tip 随之挂到**按钮**上 —— 语义没变（逐行 tip 要显示出来），
   * 只是挂载点变了。钉按钮上的那处，别钉已经不存在的 dot title。
   */
  t('逐行 tip 挂在链接名按钮上', /title=\{d\.tip \|\| /.test(grid) && /编辑这条链接：\$\{d\.name\}/.test(grid));
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

console.log('\n=== 9. 「不是 junction 而是普通目录」：不删但必须显示（原版抛异常，本版不照搬）★ ===');
{
  const mod = fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx/mod.rs'), 'utf8');
  const i = mod.indexOf('pub(crate) fn core_sync_links');
  const fn = mod.slice(i, i + 9000);
  const hook = fs.readFileSync(path.join(HERE, 'hooks/useFpx.ts'), 'utf8');

  /* 一、识别出被普通目录/文件占用的名字 */
  t('识别 Conflict 的名字',
    /let occupied: Vec<String> = outside\s*\n\s*\.iter\(\)\s*\n\s*\.filter\(\|n\| junction::link_state\(project, n\) == junction::LinkState::Conflict\)/.test(fn));
  /* 二、不删（避免误删内容），但不能静默略过 */
  t('文案说明为避免误删已跳过', /为避免误删内容已跳过，请手动处理/.test(fn));
  /* 三、保留在账本里 —— 剔掉会变成账本里查不到的"静默残骸"（#202） */
  t('被占用的保留在账本里',
    /\.filter\(\|n\| !occupied\.iter\(\)\.any\(\|x\| x\.eq_ignore_ascii_case\(n\)\)\)/.test(fn));
  /* 四、说明要带回前端 —— 走 Err 会把整次成功的操作报成失败 */
  t('notices 写进快照', /snap\.link_notices = std::mem::take\(&mut notices\)/.test(fn));
  t('部分失败时也把说明并进错误', fn.includes('snap.link_notices.join(') && /let extra = if snap\.link_notices\.is_empty\(\)/.test(fn));
  /* 五、前端要真的显示出来 —— 否则后端算了也白算 */
  /*
   * 剥注释后再判：`snap.linkNotices` 这几个字也写在说明注释里，
   * 不剥的话把真实代码删掉、注释留着，断言**照样通过**（第 21 次同类）。
   * 这类空跑最危险 —— 代码没了，护栏还报绿。
   */
  const hookCode = hook.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
  t('前端读 linkNotices（代码层，不含注释）', /snap\.linkNotices/.test(hookCode));
  t('前端记日志', /pushLog\(`同步链接：\$\{msg\}`, true\)/.test(hookCode));
  /*
   * 逐行判而不是整篇 `test()` —— 注释掉那行后文本仍在，整篇匹配会**漏报**
   * （反向验证 C 就是这么空跑的）。真正要钉的是这行**活着**。
   */
  const liveToast = hook.split('\n').some((l) => /ctx\.toast\(msg, 'err'\)/.test(l) && !l.trim().startsWith('//'));
  t('前端 toast（且真在执行，不是注释）', liveToast);
}

console.log('\n=== 10. #292 链接行状态标识：可见 + 分状态 + 与名字合成一个按钮 ★★ ===');
{
  const grid = fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8');
  const css = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8');

  /* 一、状态点必须**可见**。
     给它定尺寸的原本只有 `.fpx-badge .fpx-link-dot`（徽章内的那一处），
     明细行不在徽章里 → 匹配不上 → 空 span 是 0×0，用户完全看不见。 */
  const dotRules = css.split('\n')
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /\.fpx-link-dot[\s,{:.]/.test(l) && !/^\s*\*/.test(l));
  const hasStandalone = dotRules.some(({ l }) => /^\.fpx-link-dot/.test(l.trim()));
  t('fpx-link-dot 有独立定义（不只在 .fpx-badge 下）', hasStandalone,
    dotRules.map((x) => x.l.trim()).join(' | '));

  /* 二、点必须**分状态着色**。
     CSS 里定义了 .valid/.broken/.conflict 三色，但 JSX 此前没带状态类 ——
     于是所有点永远一个颜色，看不出哪条链接失效了。 */
  const dotSpans = grid.split('\n').filter((l) => /className=\{`fpx-link-dot/.test(l) || /className="fpx-link-dot"/.test(l));
  t('明细行渲染了状态点', dotSpans.length > 0);
  const detailDots = grid.split('\n').filter((l) => /fpx-link-dot \$\{d\.state\}/.test(l));
  t('明细行的点带 state 类（颜色才分得开）', detailDots.length >= 2, `找到 ${detailDots.length} 处`);

  /* 三、#292 标识与名字合成**一个**按钮：点标识也能编辑。
     分成两个元素时，用户看到那个点会以为可点，点了却没反应。 */
  /* 按 `<button … </button>` 整块取，不能只取含 className 的那一小段：
     状态点在 className 之后若干行，窗口不够就取不到（假失败）。 */
  const bi = grid.indexOf('className="fpx-link-name edit"');
  const bStart = grid.lastIndexOf('<button', bi);
  const bEnd = grid.indexOf('</button>', bi);
  const btn = grid.slice(bStart, bEnd + 9);
  t('按钮内包含状态点', /fpx-link-dot/.test(btn));
  t('按钮内包含链接名', /\{d\.name\}/.test(btn) || /fpx-link-text/.test(btn));
  t('按钮仍走 onEditLink', /onEditLink\(c\.path, gPath\)/.test(btn));

  /* 四、行必须是 flex —— 否则 `.fpx-link-state { margin-left: auto }`
     不生效，"失效/冲突"不会被推到最右，看上去像组名的一部分。 */
  /* 按**块**取（截到第一个 `}`）—— CSS 规则是跨行写的，
     只取一行的话 display/align-items 在下一行，断言恒假（假失败）。 */
  const ri = css.indexOf('.fpx-link-row {');
  const rowRule = ri > 0 ? css.slice(ri, css.indexOf('}', ri)) : '';
  t('.fpx-link-row 有基础定义', !!rowRule, rowRule || '(缺失)');
  t('基础定义里是 flex', !!rowRule && /display:\s*flex/.test(rowRule));
  t('基础定义里有 align-items', !!rowRule && /align-items/.test(rowRule));

  /*
   * 五、为什么原有的死类扫描没抓到这两处（记下来免得再以为它守着）：
   * 它只查"CSS 里出现的类名有没有被源码引用"，而这两个类既被引用、
   * 又在（带 :not / 带 .fpx-badge 前缀的）选择器里出现过，就被当成正常。
   * **"出现在某个选择器里" ≠ "有基础定义" / "在当前上下文能匹配"**。
   * 这两个方向都值得钉，但通用扫描会误报（很多类确实只在某容器内使用），
   * 所以这里针对这两个具体点钉，不做泛化。
   */
}

console.log('\n=== 11. 链接明细容器：滚动容器与省略号（事故注释里漏补的）★★ ===');
{
  const css = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8');

  /*
   * 一、.fpx-links 必须有基础定义 —— 此前**只有滚动条伪元素规则**。
   *
   * 没有 overflow 的话，那条 8px 窄滚动条 / 悬停才显形的样式永远不生效，
   * 而一个项目可以连十几条（预设 agent 名就有 22 个），全展开会把单张卡片
   * 撑到几屏高，把别的卡片全挤出视野。
   */
  const li = css.search(/^\.fpx-links\s*\{/m);
  const linksRule = li > 0 ? css.slice(li, css.indexOf('}', li)) : '';
  t('.fpx-links 有基础定义', li > 0);
  t('明细容器可滚动（overflow）', /overflow:\s*auto/.test(linksRule), linksRule);
  t('明细容器限高（max-height）', /max-height/.test(linksRule));

  /*
   * 二、flex item 上的 ellipsis 必须配 min-width: 0。
   *
   * 三件套（overflow:hidden + text-overflow:ellipsis + white-space:nowrap）
   * 写在块级元素上就够了，但作为 flex item 时 min-width 默认 auto，
   * 不会收缩到内容以下 → 长路径把整行撑破而不是显示省略号。
   *
   * 那段事故注释点名的"长路径不省略"，补了三件套之后**依然存在** ——
   * 只是根因从"没定义"变成了"缺 min-width: 0"。同名后果，不同根因。
   */
  /*
   * 按**行首**的选择器定位，不能用 indexOf 全篇找。
   *
   * 我第一版就是 indexOf —— 而这些类名在注释里也被提到过，
   * 于是 slice 取到的是**注释块**，里面恰好也有 min-width: 0。
   * 结果：把真规则里的 min-width 删掉，断言照样通过（空跑）。
   * 反向验证时才发现。
   */
  const ruleOf = (sel) => {
    const re = new RegExp('^' + sel.replace(/[.\-]/g, '\\$&') + '\\s*\\{', 'm');
    const m = re.exec(css);
    return m ? css.slice(m.index, css.indexOf('}', m.index)) : '';
  };
  const groupRule = ruleOf('.fpx-link-group');
  t('.fpx-link-group 有 min-width: 0（省略号才生效）', /min-width:\s*0/.test(groupRule), groupRule.slice(0, 120));

  const textRule = ruleOf('.fpx-link-text');
  t('.fpx-link-text 有 min-width: 0', /min-width:\s*0/.test(textRule), textRule.slice(0, 120));

  /* 三、三件套本身也得在（min-width 只是补最后一步） */
  for (const [name, rule] of [['.fpx-link-group', groupRule], ['.fpx-link-text', textRule]]) {
    t(`${name} 有 ellipsis 三件套`,
      /overflow:\s*hidden/.test(rule) && /text-overflow:\s*ellipsis/.test(rule) && /white-space:\s*nowrap/.test(rule));
  }
}

done();
