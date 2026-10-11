/**
 * 页签名重名测试
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/tab-name-dup-test.mjs
 *
 * 背景（本轮修的两处）：
 *
 * 页签名**不是纯显示文本** —— 后端 `sys::resolve_new_target` 把它 join 进
 * 目标路径（`父目录/页签名/项目名`），也就是它会变成真实的目录名。
 * 两个同名页签于是共用同一个物理目录：在第二个里面新建项目必撞
 * 「目标已存在」，而界面上两个分类长得一模一样，用户只会以为新建坏了。
 *
 *   ① addTab 的默认名按 `页签${长度+1}` 算 —— 删掉中间一个之后再新建，
 *      算出来的名字必然与现存的重合（[页签1,页签2] 删 页签1 → 再新建得
 *      「页签2」）。不需要任何刻意输入就会撞上。
 *   ② renameTab 此前是**无条件赋值**：改名框一 blur 就写进 config，
 *      界面立刻显示新名字，看着是成功了；等他往里加项目，才在**另一个地方**
 *      冒出「目标已存在」。错在 A、炸在 B，是最难查的一类。
 *
 * 判据（isTabNameTaken / uniqueTabName）走 loadTs 加载真身实跑，
 * 不是看源码里有没有这几个字 —— 后者证明不了"重名时真的被挡住"。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTs, makeT } from './testkit.mjs';
import { stripComments as strip } from '../../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUG = HERE;

const { t, done } = makeT();
const T = await loadTs(path.join(HERE, 'utils/tabs.ts'));
const { isTabNameTaken, uniqueTabName } = T;

/* ---------------- 1. isTabNameTaken 真身 ---------------- */
console.log('\n=== 1. 重名判据（trim + 大小写不敏感，可跳过自己）===');
{
  const names = ['创作', '游戏设计', 'Design'];
  t('同名命中', isTabNameTaken(names, '创作') === true);
  t('不同名不命中', isTabNameTaken(names, '财务') === false);
  t('两端空白归一', isTabNameTaken(names, ' 创作 ') === true);
  t('大小写不敏感（Windows 上同目录）', isTabNameTaken(names, 'design') === true);
  t('改名时跳过自己（index=1 改同名）', isTabNameTaken(names, '游戏设计', 1) === false);
  t('改名时仍查别人', isTabNameTaken(names, '创作', 1) === true);
  t('空名不算占用', isTabNameTaken(names, '   ') === false);
}

/* ---------------- 2. uniqueTabName 真身 ---------------- */
console.log('\n=== 2. 默认名必须避开重名（删一个再新建这条路径）===');
{
  /* [页签1, 页签2] 删掉 页签1 → 只剩 [页签2]；再新建按旧算法得 页签2 */
  const after = ['页签2'];
  const r = uniqueTabName(after, `页签${after.length + 1}`);
  t('撞车时递增数字后缀（页签2 → 页签3）', r === '页签3', r);
  t('结果确实不重名', isTabNameTaken(after, r) === false);

  t('不撞车时原样返回', uniqueTabName(['页签1'], '页签2') === '页签2');
  t('连续占用继续加一', uniqueTabName(['页签2', '页签3'], '页签2') === '页签4',
    uniqueTabName(['页签2', '页签3'], '页签2'));
  t('末尾非数字时改用 (2)', uniqueTabName(['创作'], '创作') === '创作(2)',
    uniqueTabName(['创作'], '创作'));
  t('(2) 也被占就到 (3)', uniqueTabName(['创作', '创作(2)'], '创作') === '创作(3)',
    uniqueTabName(['创作', '创作(2)'], '创作'));
  t('空名兜底为「页签」', uniqueTabName([], '   ') === '页签', uniqueTabName([], '   '));
  t('大小写不同也算占用', uniqueTabName(['Design'], 'design') === 'design(2)',
    uniqueTabName(['Design'], 'design'));
}

/* ---------------- 3. addTab 走兜底 ---------------- */
console.log('\n=== 3. addTab：新建必须过 uniqueTabName ===');
{
  const src = strip(fs.readFileSync(path.join(PLUG, 'hooks/useFpx.ts'), 'utf8'));
  const at = src.indexOf('const addTab');
  const seg = at >= 0 ? src.slice(at, at + 1200) : '';
  t('取到 addTab 段', seg.length > 0, seg.length ? '' : '未取到段');

  /* 锚定**调用**，不钉注释里的字样（注释里也提到这两个名字） */
  const call = /uniqueTabName\(/.test(seg);
  t('addTab 调用 uniqueTabName', call, call ? '' : '未调用');

  /* 判据必须用在 push 进去的那个 name 上，而不是别处 */
  const onPushed = /name:\s*uniqueTabName\(/.test(seg);
  t('判据作用在写入的 name 上', onPushed, onPushed ? '' : '未作用在 name 上');

  /* 旧写法是裸的 `name.trim() || \`页签${...}\``——必须已经不存在 */
  const bare = /name:\s*name\.trim\(\)/.test(seg);
  t('不再直接写入未经处理的名字', !bare, bare ? '仍是裸写' : '');
}

/* ---------------- 4. renameTab 有重名守卫 ---------------- */
console.log('\n=== 4. renameTab：重名必须挡在改名这一刻 ===');
{
  const src = strip(fs.readFileSync(path.join(PLUG, 'hooks/useFpx.ts'), 'utf8'));
  const at = src.indexOf('const renameTab');
  const seg = at >= 0 ? src.slice(at, at + 1400) : '';
  t('取到 renameTab 段', seg.length > 0, seg.length ? '' : '未取到段');

  const guard = /isTabNameTaken\(/.test(seg);
  t('有重名判据', guard, guard ? '' : '没有判据');

  /* 守卫必须在写盘之前：先 updateConfig 再判等于没判 */
  const iGuard = seg.indexOf('isTabNameTaken(');
  const iSave = seg.indexOf('updateConfig(');
  t('判据在写盘之前', iGuard >= 0 && iSave >= 0 && iGuard < iSave,
    `guard@${iGuard} save@${iSave}`);

  /* 被挡住时必须**说出来**：静默 return 等于"点了没反应" */
  t('被挡住时会报错', /pushLog\(/.test(seg) && /toast\(/.test(seg));
  const msg = /msg\s*=/.test(seg) && /next/.test(seg);
  t('报错里带上那个名字', msg, msg ? '' : '未带名字');

  /*
   * 改名传 exceptIndex：不跳过自己的话，"只改大小写"会被**自己**挡住
   * （改完还是同名 → 判据命中自己 → 永远改不了大小写）。
   *
   * 这里按**括号配平**把整条调用取出来再判，不能用 `[^)]*` ——
   * 实参里有 `(tabs ?? []).map((t) => t.name)` 这种带括号的写法，
   * `[^)]*` 会在第一个内层 `)` 处截断，于是永远匹配不上，
   * 断言变成**恒假**（看着在跑，其实从没验到）。
   */
  const gi = seg.indexOf('isTabNameTaken(');
  let callTxt = '';
  if (gi >= 0) {
    let depth = 0, end = -1;
    for (let k = gi + 'isTabNameTaken'.length; k < seg.length; k++) {
      const c = seg[k];
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) { end = k; break; } }
    }
    if (end > 0) callTxt = seg.slice(gi, end + 1);
  }
  const passesIdx = callTxt.length > 0 && /,\s*next\s*,\s*index\s*\)$/.test(callTxt);
  t('判据跳过自己（传 index）', passesIdx, callTxt ? callTxt.slice(-40) : '未取到调用');

  /* 旧写法：无条件赋值 */
  const bare = /ts\[index\]\.name\s*=\s*name\.trim\(\)/.test(seg);
  t('不再无条件赋值', !bare, bare ? '仍是裸赋值' : '');
}

/* ---------------- 5. 兜底扫描：别处不得再裸建页签 ---------------- */
console.log('\n=== 5. 兜底：新建页签的名字不再由调用方裸算 ===');
{
  for (const f of ['App.tsx', 'components/TabManagerDialog.tsx', 'components/DialogsHub.tsx']) {
    const p = path.join(PLUG, f);
    if (!fs.existsSync(p)) continue;
    const s = strip(fs.readFileSync(p, 'utf8'));
    /* 调用方仍可以传 `页签${n+1}`（那是"建议名"，兜底在 addTab 里），
       所以这里不禁止这个写法 —— 只确认它们确实走 s.addTab，
       没有自己 push 进 tabs。 */
    const selfPush = /projectTabs\.push\(|groupTabs\.push\(/.test(s);
    t(`${f} 不自行 push 页签`, !selfPush, selfPush ? '有自行 push' : '');
  }
}

done();
