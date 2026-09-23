/**
 * 内容树构建 + 物理路径回填 + 右键菜单的回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/content-tree-test.mjs
 *
 * 覆盖 #259（右键菜单 7 项）/ #260（按类型显隐）/ #345（目录回填物理路径）
 * #348（树排序）/ #351（FindFirstLeaf / CollectLeaves）/ #212（目录型 skill）。
 *
 * 树逻辑已从 ContentPanel.tsx 抽到 utils/contentTree.ts —— 抽的直接原因就是
 * **这里要 loadTs 加载真身来测**。留在 .tsx 里只能写"源码里有这行"的
 * 文本断言，那种断言测不到算法（掐错段数照样通过）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, loadTs } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();

const T = await loadTs(path.join(HERE, 'utils/contentTree.ts'));
const {
  buildTree, fillDirPaths, firstLeaf, collectLeaves, sortTree, splitPath,
  skillTreeRelPath, splitLast, stemExt, planSkillSegmentRename,
} = T;

const cp = fs.readFileSync(path.join(HERE, 'components/ContentPanel.tsx'), 'utf8');
const body = cp.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

/** 造一个 item */
const it = (kind, relPath, isDir = false) => ({
  kind, name: relPath.split('\\').pop(), relPath,
  path: 'D:\\grp\\' + kind + '\\' + relPath, isDir,
});

console.log('\n=== 1. 树构建：kind 不同不得合并 ===');
{
  const tree = buildTree([
    it('agent', 'foo.md'),
    it('rule', 'foo.md'),
  ]);
  t('同名不同 kind 是两个节点', tree.length === 2, String(tree.length));
  t('两者都有 item', tree.every((n) => !!n.item));

  const one = buildTree([it('agent', 'sub\\a.md'), it('agent', 'sub\\b.md')]);
  t('同目录合并成一个目录节点', one.length === 1 && one[0].children.length === 2);
  t('目录节点无 item', one[0].item === undefined);
  t('叶子 relPath 逐层累加', one[0].children[0].relPath === 'sub\\a.md');
}

console.log('\n=== 2. #345 目录回填物理路径 ★★ ===');
{
  const tree = buildTree([it('agent', 'sub\\deep\\a.md')]);
  fillDirPaths(tree);
  t('顶层目录回填到 sub', tree[0].path === 'D:\\grp\\agent\\sub', tree[0].path);
  t('二级目录回填到 sub\\deep',
    tree[0].children[0].path === 'D:\\grp\\agent\\sub\\deep', tree[0].children[0].path);
  t('叶子 path 未被改动', tree[0].children[0].children[0].path === 'D:\\grp\\agent\\sub\\deep\\a.md');

  /* 不变量（穷举）：**每个**目录节点的 path 必须是其后代叶子 path 的目录前缀。
     只测一层的话，掐错段数（比如少掐一段）在多层结构下才会暴露。 */
  const tree2 = buildTree([
    it('agent', 'a\\b\\c\\x.md'),
    it('skill', 'p\\q.md'),
  ]);
  fillDirPaths(tree2);
  let bad = [];
  const check = (n) => {
    if (!n.item && n.path) {
      const leaf = firstLeaf(n);
      if (leaf && !leaf.path.startsWith(n.path + '\\')) bad.push(n.relPath + ' -> ' + n.path);
    }
    n.children.forEach(check);
  };
  tree2.forEach(check);
  t('每个目录节点都是后代叶子 path 的目录前缀', bad.length === 0, bad.join('、'));

  // 反例：不回填则目录 path 为空（这正是"点目录没反应"的成因）
  const bare = buildTree([it('agent', 'sub\\a.md')]);
  t('（反例基线）未回填时目录 path 为空串', bare[0].path === '');

  /*
   * 上面几条测的是**算法**本身（`loadTs` 直接调 fillDirPaths），
   * 测不到 ContentPanel 到底调没调它 —— 反向验证时发现：
   * 把组件里的 `fillDirPaths(t)` 删掉，这节照样全绿（因为测试自己调了）。
   *
   * 所以必须再钉一条"组件真的调了"。算法对 + 没接上 = 功能等于没做。
   */
  /*
   * 上面几条测的是**算法**本身（loadTs 直接调 fillDirPaths），
   * 测不到 ContentPanel 到底调没调它 —— 反向验证时发现：
   * 把组件里的 `fillDirPaths(t)` 删掉，这节照样全绿（因为测试自己调了）。
   *
   * 所以必须再钉一条"组件真的调了"。算法对 + 没接上 = 功能等于没做。
   * 窗口放宽到 400：#342 之后 useMemo 里多了一段 skill 换名逻辑。
   */
  t('组件 tree useMemo 里真的调用了 fillDirPaths',
    /const tree = useMemo\(\(\) => \{[\s\S]{0,400}buildTree\(src\)[\s\S]{0,120}fillDirPaths\(t\)/.test(body));
}

console.log('\n=== 3. #351 firstLeaf / collectLeaves ===');
{
  const tree = buildTree([
    it('agent', 'z\\a.md'),
    it('agent', 'z\\b.md'),
    it('agent', 'y.md'),
  ]);
  sortTree(tree);
  const f = firstLeaf(tree[0]);
  t('firstLeaf 取到叶子', !!f && !!f.item);
  t('collectLeaves 收全部叶子', collectLeaves(tree[0]).length === 2, String(collectLeaves(tree[0]).length));

  t('splitPath 兼容两种分隔符', splitPath('a/b\\c').length === 3);
  t('splitPath 去空段', splitPath('a\\\\b').length === 2);
}

console.log('\n=== 4. #348 排序：目录在前 ===');
{
  const tree = buildTree([
    it('agent', 'zzz.md'),
    it('agent', 'aaa\\x.md'),
  ]);
  t('目录排在文件前', !tree[0].item && !!tree[1].item, tree[0].name + ' / ' + tree[1].name);
}

console.log('\n=== 5. #259 右键菜单七项 ===');
{
  const want = ['复制名称', '复制文件名', '复制路径', '打开文件', '打开 SKILL.md', '打开所在文件夹', '重命名'];
  for (const label of want) {
    t(`菜单含「${label}」`, body.includes(`'${label}'`));
  }
  t('onContextMenu 已挂到节点上', /onContextMenu=\{\(?e\)? =>/.test(body));
  t('右键要 preventDefault（否则系统菜单一起弹）', /e\.preventDefault\(\)/.test(body));
  t('渲染了 ContextMenu', /<ContextMenu/.test(body));
}

console.log('\n=== 6. #260 按类型显隐 ★ ===');
{
  /* 关键：不能只钉"有 '打开文件'"——那第 5 节已钉过。
     要钉的是**显隐条件**：打开文件仅当 isFile（有 item 且非目录型）。 */
  const seg = (from, to) => body.slice(body.indexOf(from), body.indexOf(to, body.indexOf(from)));

  const openBlk = seg("if (isFile && n.item)", "if (isDirSkill && n.item)");
  t('「打开文件」受 isFile 守卫', /isFile/.test(openBlk) && /openPath/.test(openBlk));
  t('isFile = 有 item 且非 isDir', /const isFile = !!n\.item && !n\.item\.isDir;/.test(body));

  const mdBlk = seg("if (isDirSkill && n.item)", "// 6 打开所在文件夹");
  t('「打开 SKILL.md」受 isDirSkill 守卫', /isDirSkill/.test(mdBlk));
  t('走 editFile（后端做目录→SKILL.md 解析）', /api\.editFile/.test(mdBlk));
  t('isDirSkill = 有 item 且 isDir', /const isDirSkill = !!n\.item && n\.item\.isDir;/.test(body));

  /*
   * 重命名仅叶子：必须钉「在 if (n.item) 内」这一整段，只钉 label 会漏报。
   *
   * 锚点不能用注释 `// 7 重命名` —— body 已剥掉注释，indexOf 返回 -1，
   * slice(-1) 只剩一个字符，断言恒假。改成从 label 往前取 160 字符。
   */
  const ri = body.indexOf("label: '重命名'");
  const renBlk = body.slice(Math.max(0, ri - 160), ri);
  t('「重命名」受 n.item 守卫（目录没有 ContentItem）',
    /if \(n\.item\) \{/.test(renBlk) && ri > 0);

  // 复制文件名/路径 需要物理路径
  t('「复制路径」受 phys 守卫', /if \(phys\) \{[\s\S]{0,200}复制路径/.test(body));
}

console.log('\n=== 7. 右键不得触发选中副作用（原版 RightClickCommand 语义）===');
{
  /* 原版明确"仅高亮节点，不触发展开切换/预览副作用"。
     若右键里调 onSelect/read，会走一次网络读文件 —— 右键一下卡一下，
     且预览区莫名跳到别的文件。 */
  /*
   * 只取 onContextMenu 这一段本身。
   * 早先取到 onDoubleClick 为止 —— 中间夹着 onClick（里面有 read(n.item)），
   * 于是断言恒假。这是"断言范围取宽了"造成的假失败，不是源码问题。
   */
  const ci = body.indexOf('onContextMenu=');
  const ctxBlk = body.slice(ci, ci + 260);
  t('右键块内不调 read(', !/read\(/.test(ctxBlk));
  t('右键块内不调 onSelect(', !/onSelect\(/.test(ctxBlk));

  // 反例：加上 onSelect 必须被抓到
  t('（反例基线）块内确实有 setMenu', /setMenu/.test(ctxBlk));
}

console.log('\n=== 8. #342 skill 名按 `_` 拆分层级 ===');
{
  t('下划线换成分隔符', skillTreeRelPath('a_b_c.md') === 'a\\b\\c.md', skillTreeRelPath('a_b_c.md'));
  t('无下划线时不变', skillTreeRelPath('foo.md') === 'foo.md');

  /* 整树验证：目录型 skill `a_b_c` 应展开成 a → b → c 三层 */
  const tree = buildTree([{
    kind: 'skill', name: 'a_b_c', relPath: skillTreeRelPath('a_b_c'),
    path: 'D:\\grp\\skill\\a_b_c', isDir: true,
  }]);
  t('目录型 skill 展开成三层', tree.length === 1 && tree[0].name === 'a'
    && tree[0].children[0].name === 'b'
    && tree[0].children[0].children[0].name === 'c');
  t('只有末层是叶子', !tree[0].item && !!tree[0].children[0].children[0].item);
}

console.log('\n=== 9. #345（更正）skill 虚拟层不回填物理路径 ★ ===');
{
  const tree = buildTree([{
    kind: 'skill', name: 'a_b', relPath: skillTreeRelPath('a_b'),
    path: 'D:\\grp\\skill\\a_b', isDir: true,
  }]);
  fillDirPaths(tree);
  /* 反例：若回填了，节点 a 会得到 skill 根目录 —— 点「打开所在文件夹」
     打开的是整个 skill 目录而不是那一层，且没有任何报错。 */
  t('skill 虚拟层目录 path 仍为空', tree[0].path === '', tree[0].path);

  // agent 目录仍要回填（不能一刀切关掉）
  const ag = buildTree([{
    kind: 'agent', name: 'x.md', relPath: 'sub\\x.md',
    path: 'D:\\grp\\agent\\sub\\x.md', isDir: false,
  }]);
  fillDirPaths(ag);
  t('agent 目录仍回填', ag[0].path === 'D:\\grp\\agent\\sub', ag[0].path);
}

console.log('\n=== 10. #213 虚拟层改名计划（段下标 / 扩展名 / 跳过）★★ ===');
{
  const L = (p, isDir = false) => ({ path: p, isDir });

  // 段下标：根层文件夹（depth 0）改第 0 段
  {
    const { moves, skipped } = planSkillSegmentRename(
      [L('D:\\s\\a_b.md'), L('D:\\s\\a_c.md')], 0, 'a', 'x');
    t('根层：改第 0 段', moves.length === 2 && skipped === 0, `${moves.length}/${skipped}`);
    t('新名正确', moves[0].to === 'D:\\s\\x_b.md', moves[0].to);
    t('第 2 条同步', moves[1].to === 'D:\\s\\x_c.md', moves[1].to);
  }
  // 第 2 层文件夹（depth 1）改第 1 段 —— 段下标算错会改到别的段
  {
    const { moves } = planSkillSegmentRename(
      [L('D:\\s\\a_b_c.md')], 1, 'b', 'x');
    t('第二层：改第 1 段', moves[0].to === 'D:\\s\\a_x_c.md', moves[0] && moves[0].to);
  }
  // 扩展名必须保留
  {
    const { moves } = planSkillSegmentRename([L('D:\\s\\a_b.md')], 0, 'a', 'x');
    t('文件保留扩展名', moves[0].to.endsWith('.md'), moves[0].to);
  }
  // 目录型 skill：整名替换，无扩展名
  {
    const { moves } = planSkillSegmentRename([L('D:\\s\\a_b', true)], 0, 'a', 'x');
    t('目录型无扩展名', moves[0].to === 'D:\\s\\x_b', moves[0].to);
  }
  // 段数不够 / 段名不符 → 跳过（不是静默丢弃，调用方要能报出来）
  {
    const r1 = planSkillSegmentRename([L('D:\\s\\z.md')], 1, 'a', 'x');
    t('段数不够时跳过', r1.moves.length === 0 && r1.skipped === 1);
    const r2 = planSkillSegmentRename([L('D:\\s\\q_b.md')], 0, 'a', 'x');
    t('段名不符时跳过', r2.moves.length === 0 && r2.skipped === 1);
  }
  // 穷举不变量：to 与 from 必须同父目录、且只改一个段
  {
    const leaves = [L('D:\\s\\a_b.md'), L('D:\\s\\a_b_c.md'), L('D:\\s\\a\\b.md')];
    const bad = [];
    for (let d = 0; d < 3; d++) {
      for (const { moves } of [planSkillSegmentRename(leaves, d, 'a', 'x'),
        planSkillSegmentRename(leaves, d, 'b', 'y')]) {
        for (const m of moves) {
          const [df] = splitLast(m.from); const [dt] = splitLast(m.to);
          if (df !== dt) bad.push('父目录变了: ' + m.to);
          const [sf] = stemExt(splitLast(m.from)[1], m.isDir);
          const [st] = stemExt(splitLast(m.to)[1], m.isDir);
          if (sf.split('_').length !== st.split('_').length) bad.push('段数变了: ' + m.to);
        }
      }
    }
    t('穷举：from/to 同父目录且段数不变', bad.length === 0, bad.join('、'));
  }
  t('splitLast 兼容两种分隔符', splitLast('a/b\\c')[1] === 'c');
  t('stemExt 去扩展名', stemExt('a.b.md', false)[0] === 'a.b');
}

console.log('\n=== 11. #344 冲突整体取消（在 Rust 侧）★★ ===');
{
  const mod = fs.readFileSync(
    path.join(HERE, '../../src-tauri/src/fpx/mod.rs'), 'utf8');
  const i = mod.indexOf('pub fn fpx_rename_skill_segment');
  const fnBody = mod.slice(i, mod.indexOf('\n}', i));
  t('命令存在', i > 0);
  /* 关键：先全量检查再动手。边查边改会"改了一半才发现冲突"。
     必须钉「冲突检查在改名循环之前」这个**次序**，只钉"有检查"会漏报。 */
  /*
   * 锚点不能用注释里的"冲突整体取消" —— 反向验证实测：把检查代码整体
   * 挪到执行循环之后、**注释留在原地**，断言照样通过（测的是注释位置）。
   * 这已经是第二次踩"锚点落在注释上"，必须钉真正的代码。
   */
  const ci = fnBody.indexOf('std::path::Path::new(to).exists()');
  const mi = fnBody.indexOf('let mut moved');
  t('冲突检查早于执行循环', ci > 0 && mi > ci, `${ci} / ${mi}`);
  t('冲突时明确说未做改动', /未做任何改动/.test(fnBody));
  t('要求 from / to 同父目录', /from\.parent\(\) != to\.parent\(\)/.test(fnBody));
  t('层级名禁止下划线', /contains\('_'\)/.test(fnBody));
  t('逐条走 with_unlock', /with_unlock\(&dir, from/.test(fnBody));
}

console.log('\n=== 12. #343 分派四路（组件侧）★★ ===');
{
  t('skill 虚拟层走「重命名层级…」', body.includes("'重命名层级…'"));
  t('isSkillFolder = skill 且无 item', /const isSkillFolder = !n\.item && n\.kind === 'skill';/.test(body));
  t('叶子仍走「重命名」', body.includes("key: 'rename'"));
  t('agent/rule 文件夹也能改名', /n\.kind !== 'skill'[\s\S]{0,120}onRename/.test(body));
  t('单条改名传 path+name（不再是整个 item）',
    /onRename\(\{ path: n\.item!\.path, name: n\.item!\.name \}\)/.test(body));
  t('弹窗已登记 renameSegment', /type: 'renameSegment'/.test(
    fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8')));
  /*
   * 层级名禁 `_` 的守卫在**对话框**里（提交前挡），后端也有同款。
   * 只钉后端那份会漏：前端这份被删掉后，用户仍能提交含 `_` 的名字，
   * 然后拿到一条后端错误 —— 体验差一档，而测试全绿。
   */
  const dlg = fs.readFileSync(path.join(HERE, 'components/RenameContentDialog.tsx'), 'utf8');
  t('对话框也挡下划线（提交前）', /segment && next\.includes\('_'\)/.test(dlg));
}

console.log('\n=== 13. 抽到 utils 后不得在组件里重抄一份 ===');
{
  t('组件内无 buildTree 定义', !/^function buildTree/m.test(cp));
  t('组件内无 fillDirPaths 定义', !/^function fillDirPaths/m.test(cp));
  t('组件内无 firstLeaf 定义', !/^function firstLeaf/m.test(cp));
  t('组件从 utils 导入', /from '\.\.\/utils\/contentTree'/.test(cp));
}

done();
