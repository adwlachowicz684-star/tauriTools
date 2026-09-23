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
  t('组件 tree useMemo 里真的调用了 fillDirPaths',
    /const tree = useMemo\(\(\) => \{[\s\S]{0,240}buildTree\(items\)[\s\S]{0,120}fillDirPaths\(t\)/.test(body));
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

console.log('\n=== 8. 抽到 utils 后不得在组件里重抄一份 ===');
{
  t('组件内无 buildTree 定义', !/^function buildTree/m.test(cp));
  t('组件内无 fillDirPaths 定义', !/^function fillDirPaths/m.test(cp));
  t('组件内无 firstLeaf 定义', !/^function firstLeaf/m.test(cp));
  t('组件从 utils 导入', /from '\.\.\/utils\/contentTree'/.test(cp));
}

done();
