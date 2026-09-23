/**
 * 保存反馈一致性护栏（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/saveguard-test.mjs
 *
 * 本轮修的两个真 BUG：
 * 1) addCard / removeCard 不检查 updateConfig 返回值就写"已添加/已移除" ——
 *    保存失败时 toast 说"保存配置失败"、日志却说"已添加"，还把不存在的卡选中；
 * 2) removeCardFull 走 api 但没走 run —— api 层不 catch，失败变成
 *    unhandled rejection，用户点完删除**毫无反应**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const src = fs.readFileSync(path.join(HERE, 'hooks/useFpx.ts'), 'utf8');

/**
 * 剥掉注释再断言。
 *
 * 必须剥：本文件 addCard 的说明里**引用了旧写法** `while (tabs.length <= idx)`
 * 作为反例（那正是要解释为什么改掉的），全文扫会命中注释里的反例，
 * 于是断言在没有真代码时**照样通过** —— 漏报。
 */
const strip = (x) => x
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/[^\n]*/g, '$1');

/** 取某个 useCallback(async 函数体 */
function fn(name) {
  const m = new RegExp('const ' + name + ' = useCallback\\(async').exec(src);
  if (!m) return '';
  const i = m.index;
  const nx = /\n  const \w+ = useCallback\(/.exec(src.slice(i + 10));
  return src.slice(i, i + 10 + (nx ? nx.index : src.length - i));
}

console.log('\n=== 1. 写"成功"日志前必须确认保存成功 ★★ ===');
{
  /*
   * 判据不是"有没有 snap 变量"，而是**成功日志之前必须有早退**。
   * 只钉 `if (!snap)` 会漏：把它挪到 pushLog 之后照样命中。
   */
  for (const [name, log] of [['addCard', '已添加'], ['removeCard', '已移除']]) {
    const b = fn(name);
    t(`${name} 取到返回值`, /const snap = await updateConfig/.test(b));
    const iGuard = b.indexOf('if (!snap) return;');
    const iLog = b.indexOf('pushLog(');
    t(`${name} 先判失败再写"${log}"`, iGuard >= 0 && iLog >= 0 && iGuard < iLog,
      `guard=${iGuard} log=${iLog}`);
  }
}

console.log('\n=== 2. 直接 await api.* 的异步函数必须走 run（否则静默失败）★ ===');
{
  /*
   * api.ts 的 call 不 catch；调用方又常写 `void s.xxx()`，没人接 →
   * 失败 = unhandled rejection = 用户点了没反应、也没报错。
   */
  const b = fn('removeCardFull');
  t('removeCardFull 走 run', /await run\('移除卡片'/.test(b));
  t('成功日志在 run 内部（失败就不写）', b.indexOf("run('移除卡片'") < b.indexOf('已移除'));
  t('依赖里带上 run', /\[api, refresh, pushLog, run\]/.test(b));
}

console.log('\n=== 3. 统一错误包装本身没坏 ===');
{
  t('run 会记日志 + toast', /const msg = `\$\{label\}失败：\$\{errText\(e\)\}`/.test(src)
    || /失败：\$\{errText\(e\)\}/.test(src));
  t('run 失败返回 null', /return null;/.test(fn('run') + src.slice(0, 4000)));
  t('updateConfig 失败返回 null（调用方能判）', /return snap;/.test(src));
  t('api 层不 catch（所以调用方必须自己兜）',
    /const call = <T>[\s\S]{0,120}?ctx\.invoke/.test(fs.readFileSync(path.join(HERE, 'api.ts'), 'utf8')));
}

console.log('\n=== 4. 已修的两处不被回滚 ===');
{
  t('addCard 注释说明为什么早退', /保存失败就到此为止/.test(fn('addCard')));
  t('removeCardFull 注释说明静默失败', /unhandled rejection/.test(fn('removeCardFull')));
}

console.log('\n=== 5. 保存失败不得推进"当前页签" ★★ ===');
{
  /*
   * addTab 的坑比 addCard 更隐蔽：它推进的是 activeTab 这个**索引**。
   * 保存失败时 tabs 一条没多，而新索引正好等于旧长度 ——
   * 于是 activeTab 被推到越界下标，卡片区显示空白。
   * 用户以为"新建成功、只是空的"，往这个不存在的页签里加卡、改设置。
   *
   * 判据必须是"早退早于 setActiveTab"，只钉 `const snap =` 不够 ——
   * 把早退挪到 setActiveTab 之后照样命中。
   */
  const b = fn('addTab');
  const iSnap = b.indexOf('const snap = await updateConfig');
  const iGuard = b.indexOf('if (!snap) return;');
  const iSet = b.indexOf('setActiveTab(');
  t('addTab 取到返回值', iSnap >= 0);
  t('addTab 先判失败再动 activeTab', iGuard >= 0 && iSet >= 0 && iGuard < iSet,
    `guard=${iGuard} set=${iSet}`);
  t('addTab 注释说明越界后果', /越界/.test(b));
}

console.log('\n=== 6. 索引推进类操作一律先看保存结果 ===');
{
  /*
   * 同类操作必须一致：moveTab / removeTab 都推进 activeTab，
   * 都必须在 setActiveTab 之前早退。
   * 只钉 addTab 的话，moveTab 的守卫被删掉也测不到。
   */
  for (const name of ['moveTab', 'removeTab']) {
    const b = fn(name);
    const iGuard = b.indexOf('if (!snap) return;');
    const iSet = b.indexOf('setActiveTab(');
    if (iSet >= 0) {
      t(`${name} 先判失败再动 activeTab`, iGuard >= 0 && iGuard < iSet,
        `guard=${iGuard} set=${iSet}`);
    } else {
      t(`${name} 推进状态前先判失败`, iGuard >= 0);
    }
  }
}


console.log('\n=== 7. 不得凭空补齐页签 ★★ ===');
{
  /*
   * addCard 原写法 `while (tabs.length <= idx) tabs.push(...)`：
   * 索引一越界就连续造空页签，把"索引与 tabs 不同步"这件事**掩盖**掉，
   * 同时凭空改动用户没要求改的页签结构。
   *
   * 判据：全库不得再出现 while 补齐页签的写法，且 addCard 必须夹取。
   * 只钉"有 clampIndex"不够 —— 把夹取删掉、换回 while，断言照样过。
   */
  const all = [src, fs.readFileSync(path.join(HERE, 'components/StackedGroups.tsx'), 'utf8')];
  t('没有 while 补齐页签', !all.some((x) => /while\s*\(\s*tabs\.length\s*<=/.test(strip(x))));
  const b = fn('addCard');
  t('addCard 夹取索引', /clampIndex\(idx,\s*tabs\.length\s*-\s*1\)/.test(b));
  t('addCard 空 tabs 时早退', /tabs\.length === 0\)\s*return/.test(b));
}

done();
