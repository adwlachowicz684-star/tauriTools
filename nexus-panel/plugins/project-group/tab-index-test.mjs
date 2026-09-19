/**
 * 页签索引计算回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/tab-index-test.mjs，然后
 *         node plugins/project-group/tab-index-test.mjs
 *
 * 测的是 #23 页签管理面板里那段最容易写错的纯算术：
 * 重排 / 删除之后"当前停在哪一页"。写错的表现是"拖完停在别处"或
 * "删完落到越界位置白屏"，而在界面上复现要连点好几次、还得页签够多，
 * 所以抽成纯函数后用一张表把所有方向穷举一遍。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const stripTS = (src) => {
  let s = src;
  s = s.replace(/^export type [\s\S]*?;\n/gm, '');
  s = s.replace(/^export interface [\s\S]*?^\}\n/gm, '');
  s = s.replace(/^(\s*)(export )?const (\w+)\s*:\s*[^=\n]*=/gm, '$1$2const $3 =');
  s = s.replace(/:\s*Record<[^<>]*>\s*(?:\|\s*(?:null|undefined)\s*)*/g, '');
  const T = '(?:[A-Z][\\w.]*|string|number|boolean|null|undefined|void|any|unknown|never)';
  s = s.replace(new RegExp('(\\b\\w+)\\s*:\\s*' + T + '[\\w.\\[\\]| ]*?(?=\\s*[,)])', 'g'), '$1');
  s = s.replace(/\s*\w+>\s*(?=\))/g, '');
  s = s.replace(/\s*\|\s*[\w.]+\s*(?=\))/g, '');
  s = s.replace(/\)\s*:\s*\{[^{}\n]*\}\s*(?:\[\])?\s*\{/g, ') {');
  s = s.replace(/\)\s*:\s*[^{\n]*\{/g, ') {');
  s = s.replace(/new (\w+)<[^<>]*>\(/g, 'new $1(');
  s = s.replace(/\s+as\s+[\w.\[\]<>|]+/g, '');
  s = s.replace(/\breadonly\s+/g, '');
  return s;
};

const T = await loadTs(path.join(HERE, 'utils/tabs.ts'));
const { t, done } = makeT();

const { activeAfterMove, activeAfterRemove, canMove, canRemove } = T;

console.log('\n=== 1. activeAfterMove：拖的就是当前页签 ===');
t('0→2，活动跟着到 2', activeAfterMove(0, 0, 2) === 2, String(activeAfterMove(0, 0, 2)));
t('3→0，活动跟着到 0', activeAfterMove(3, 3, 0) === 0, String(activeAfterMove(3, 3, 0)));
t('1→1（原地）不动', activeAfterMove(1, 1, 1) === 1);

console.log('\n=== 2. activeAfterMove：从左往右拖，中间的整体左移 ===');
/* 5 个页签 [A B C D E]，把 B(1) 拖到 D 的位置(3)：
   结果 [A C D B E]。原本活动在 C(2) → 现在 C 在 1；D(3) → 2。
   A(0) 不受影响，E(4) 不受影响，B 自己 → 3。 */
t('活动在 C(2) → 1', activeAfterMove(2, 1, 3) === 1, String(activeAfterMove(2, 1, 3)));
t('活动在 D(3) → 2', activeAfterMove(3, 1, 3) === 2, String(activeAfterMove(3, 1, 3)));
t('活动在 A(0) 不动', activeAfterMove(0, 1, 3) === 0, String(activeAfterMove(0, 1, 3)));
t('活动在 E(4) 不动', activeAfterMove(4, 1, 3) === 4, String(activeAfterMove(4, 1, 3)));

console.log('\n=== 3. activeAfterMove：从右往左拖，中间的整体右移 ===');
/* 反向：把 D(3) 拖到 B 的位置(1)：结果 [A D B C E]。
   原本 B(1) → 2；C(2) → 3。A(0)、E(4) 不动。 */
t('活动在 B(1) → 2', activeAfterMove(1, 3, 1) === 2, String(activeAfterMove(1, 3, 1)));
t('活动在 C(2) → 3', activeAfterMove(2, 3, 1) === 3, String(activeAfterMove(2, 3, 1)));
t('活动在 A(0) 不动', activeAfterMove(0, 3, 1) === 0, String(activeAfterMove(0, 3, 1)));
t('活动在 E(4) 不动', activeAfterMove(4, 3, 1) === 4, String(activeAfterMove(4, 3, 1)));

console.log('\n=== 4. activeAfterMove：相邻移动（常见边界）===');
t('相邻右移 1→2，活动在 1 → 2', activeAfterMove(1, 1, 2) === 2);
t('相邻右移 1→2，活动在 2 → 1', activeAfterMove(2, 1, 2) === 1, String(activeAfterMove(2, 1, 2)));
t('相邻左移 2→1，活动在 2 → 1', activeAfterMove(2, 2, 1) === 1);
t('相邻左移 2→1，活动在 1 → 2', activeAfterMove(1, 2, 1) === 2, String(activeAfterMove(1, 2, 1)));

console.log('\n=== 5. activeAfterMove：穷举不变量（结果必须仍在合法范围）===');
{
  let bad = 0, moved = 0;
  const N = 6;
  for (let n = 1; n <= N; n++) {
    for (let from = 0; from < n; from++) {
      for (let to = 0; to < n; to++) {
        for (let a = 0; a < n; a++) {
          const r = activeAfterMove(a, from, to);
          if (!(r >= 0 && r < n)) bad++;
          if (r !== a) moved++;
        }
      }
    }
  }
  t('所有组合的结果都落在 [0, n)', bad === 0, `越界 ${bad} 例`);
  t('确实有发生平移（不是恒等函数）', moved > 0, `${moved} 例发生平移`);
  /* 不动点性质：把自己拖到自己，任何活动索引都不该变 */
  let idOk = true;
  for (let n = 1; n <= N; n++) {
    for (let a = 0; a < n; a++) {
      for (let i = 0; i < n; i++) {
        if (activeAfterMove(a, i, i) !== a) idOk = false;
      }
    }
  }
  t('from==to 时一律不变', idOk);
}

console.log('\n=== 6. activeAfterRemove ===');
{
  // 5 个删掉下标 2：[A B D E]，原本 C(2) 没了
  t('删的是当前(2) → 停在 2（原本的 D 顶上来）',
    activeAfterRemove(2, 2, 5) === 2, String(activeAfterRemove(2, 2, 5)));
  t('当前在被删之后(4) → 左移一位到 3',
    activeAfterRemove(4, 2, 5) === 3, String(activeAfterRemove(4, 2, 5)));
  t('当前在被删之前(0) → 不动',
    activeAfterRemove(0, 2, 5) === 0, String(activeAfterRemove(0, 2, 5)));
}
{
  // 删最后一个：当前就在末尾(4)，删完只剩 4 个，最大下标 3
  t('删末尾且当前在末尾 → 收敛到 3',
    activeAfterRemove(4, 4, 5) === 3, String(activeAfterRemove(4, 4, 5)));
  t('删末尾(4)但当前在 1 → 不动',
    activeAfterRemove(1, 4, 5) === 1, String(activeAfterRemove(1, 4, 5)));
}
{
  // 只剩 2 个删 1 个 → 结果只能是 0
  t('2 删 1，当前 1 → 0', activeAfterRemove(1, 1, 2) === 0, String(activeAfterRemove(1, 1, 2)));
  t('2 删 1，当前 0 → 0', activeAfterRemove(0, 1, 2) === 0, String(activeAfterRemove(0, 1, 2)));
  t('2 删 0，当前 1 → 0', activeAfterRemove(1, 0, 2) === 0, String(activeAfterRemove(1, 0, 2)));
}

console.log('\n=== 7. activeAfterRemove：穷举不变量 ===');
{
  let bad = 0;
  const N = 6;
  for (let n = 2; n <= N; n++) {
    for (let rm = 0; rm < n; rm++) {
      for (let a = 0; a < n; a++) {
        const r = activeAfterRemove(a, rm, n);
        // 删完剩 n-1 个，合法下标 [0, n-2]
        if (!(r >= 0 && r <= n - 2)) bad++;
      }
    }
  }
  t('所有组合都落在删后合法范围 [0, n-2]', bad === 0, `越界 ${bad} 例`);
  // 极端：n=1 不该发生（UI 层已禁用），但要保证不产生负数
  t('n=1 时也非负', activeAfterRemove(0, 0, 1) >= 0, String(activeAfterRemove(0, 0, 1)));
}

console.log('\n=== 8. canMove / canRemove（按钮禁用规则）===');
t('首项不能上移', canMove(0, 3, -1) === false);
t('末项不能下移', canMove(2, 3, 1) === false);
t('中间项可上移', canMove(1, 3, -1) === true);
t('中间项可下移', canMove(1, 3, 1) === true);
t('只有一个页签时不能移', canMove(0, 1, 1) === false);
t('越界下标不能移', canMove(5, 3, 1) === false);
t('负下标不能移', canMove(-1, 3, 1) === false);
t('两个及以上可删', canRemove(2) === true);
t('只剩一个不能删', canRemove(1) === false);
/* 与界面一致性：末项下移被禁用，正是 canMove 的用途 ——
   界面对函数两套判断会漂移，这里给唯一答案 */
t('canMove 与 activeAfterMove 的边界一致（末项下移无意义）',
  canMove(2, 3, 1) === false && canMove(0, 3, -1) === false);


console.log('\n=== #27 页签 × 关闭按钮 ===');
{
  const g = fs.readFileSync(path.join(HERE, 'components/CardGrid.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const cssNC = fs.readFileSync(path.join(HERE, 'style.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const { canRemove } = await loadTs(path.join(HERE, 'utils/tabs.ts'));

  t('页签上有 × 按钮', /fpx-tab-x/.test(g));
  /* 必须走同一个 onRemoveTab（带 tabRemoveCheck 保护），不能自己删 */
  t('走 onRemoveTab（受保护）', /onClick=\{\(e\) => \{[\s\S]{0,200}?onRemoveTab\(i\)/.test(g));
  /* 阻止冒泡：否则点击会先触发页签选中，双击时还会和重命名抢 */
  t('阻止冒泡', /e\.stopPropagation\(\);[\s\S]{0,120}?onRemoveTab\(i\)/.test(g));

  /* 只剩一个页签时不显示 —— 点了会失败，按钮却在那儿，像是坏了 */
  t('用 canRemove 判定', /canRemove\(tabs\.length\)/.test(g));
  t('canRemove(1) = false', canRemove(1) === false);
  t('canRemove(2) = true', canRemove(2) === true);
  /* 编辑中不显示（会和输入框抢） */
  t('编辑中不显示', /editing !== i/.test(g));
  /* 拖动中不删：拖拽期间误触会把页签连同卡片一起删掉 */
  t('阻止 × 自身被拖动', /onDragStart=\{\(e\) => e\.preventDefault\(\)\}/.test(g));

  /* 提示要说明会连带删掉多少项 —— 删页签的代价比看起来大 */
  t('title 说明连带项数', /连同里面 \$\{t\.items\.length\} 项/.test(g));

  /* 样式：平时不可见、也不可点 */
  t('默认 opacity 0', /\.fpx-tab-x\s*\{[^}]*opacity: 0/.test(cssNC));
  t('默认不可点击（pointer-events: none）',
    /\.fpx-tab-x\s*\{[^}]*pointer-events: none/.test(cssNC));
  t('hover 才恢复', /\.fpx-tab:hover \.fpx-tab-x[^}]*pointer-events: auto/.test(cssNC));
  t('键盘聚焦也显形', /\.fpx-tab-x:focus-visible[^}]*opacity: 1/.test(cssNC));
}

done();
