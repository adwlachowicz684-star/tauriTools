/**
 * 添加卡片跨**所有**页签查重（对齐原版 FindDuplicate）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/addcard-cross-tab-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const hook = strip(fs.readFileSync(path.join(HERE, 'hooks/useFpx.ts'), 'utf8'));
const app = strip(fs.readFileSync(path.join(HERE, 'App.tsx'), 'utf8'));

console.log('\n=== 1. 跨所有页签查重 ===');
{
  /*
   * 原版 FindDuplicate 遍历**全部**页签；
   * 本版原来只看 `list[idx]`（当前/指定那一个）。
   *
   * 后果：同一个文件夹能被登记进两个页签，而这两份在界面上
   * 看不出是两份（切页签才看得到另一份）—— 改名/改色/删除只作用一处，
   * 用户以为改了却发现另一处没变，或者删了却在别处又冒出来。
   */
  t('不再只看当前页签', !/if \(list\[idx\]\?\.items\.some/.test(hook));
  t('遍历全部页签', /const owner = list\.findIndex\(\(t\) => t\.items\.some/.test(hook));
  t('命中则拒绝', /if \(owner >= 0\) \{/.test(hook));
}

console.log('\n=== 2. 提示要说出在哪个页签 ===');
{
  /*
   * 原版只说"已在收藏中存在"，页签一多用户根本不知道去哪儿找。
   * 说清页签名才是"告诉他下一步怎么办"。
   */
  t('提示带页签名', /该文件夹已在页签「\$\{list\[owner\]\.name\}」中/.test(hook));
  /* 与 #91 一致：大小写不敏感 —— Windows 下两条登记指向同一个目录 */
  /* 正则里反斜杠转义层数太多，直接用字符串包含判定更稳 */
  t('去尾斜杠归一', hook.includes("p.replace(/[\\\\/]+$/, '')"));
  t('归一转小写', hook.includes("p.replace(/[\\\\/]+\$/, '').toLowerCase()"));
  t('比较用归一值', /norm\(c\.path\) === norm\(path\)/.test(hook));
}

console.log('\n=== 3. 落库仍在指定页签 ===');
{
  /* 只改查重，不改落点：点哪个页签的 ＋ 就该进哪个 */
  t('仍用 idx 落库', /const idx = tabIndex \?\? activeTab\[kind\];/.test(hook));
  /*
   * 不钉 `tabs[idx]` 这个字面量：本轮把落库索引改成**夹取后的 `at`**
   * （越界时不再凭空补齐页签），钉死旧写法只会误报。
   * 真实要钉的是"push 进的那个索引来自 idx"（夹取后仍是 idx 对应的位置），
   * 以及"查重发生在落库之前"。
   */
  t('落库索引来自 idx（夹取后）',
    /const at = clampIndex\(idx, tabs\.length - 1\);/.test(hook)
    && /tabs\[at\]\.items\.push\(path\);/.test(hook));
  const iOwner = hook.indexOf('const owner = list.findIndex');
  const iPush = hook.indexOf('.items.push(path);');
  /*
   * 用 `>= 0` 而不是 `> 0`：后者把"索引恰好为 0"也判成不合法。
   * 且顺序断言**两端都要判存在** —— 只判一端的话，另一端锚点被改没了
   * 会让比较恒真/恒假，断言要么空跑要么无端报红。
   */
  t('查重在落库之前', iOwner >= 0 && iPush >= 0 && iOwner < iPush,
    `owner=${iOwner} push=${iPush}`);
}

console.log('\n=== 4. 存量重复不强行清理 ===');
{
  /*
   * 历史配置里可能已经有跨页签重复。添加时拦住新的，
   * 但不扫一遍把旧的删掉 —— 那是在用户没要求的情况下动他的登记。
   * moveCard 只从源页签摘（#9.1）已经为存量重复兜了底。
   */
  t('moveCard 仍带 fromTabIndex', /fromTabIndex\?: number,/.test(hook));
  t('moveCard 只摘一处', /tabs\[src\]\.items\.splice\(at, 1\);/.test(hook));
}

console.log('\n=== 5. 拖入/新建都走同一入口 ===');
{
  /* 外部拖入也走 addCard，否则那条路照样能造出重复 */
  t('外部拖入走 addCard', /s\.addCard\(/.test(app));
  t('新建后也走 addCard', /addCard\(/.test(app));
}

done();
