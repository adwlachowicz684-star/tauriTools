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


console.log('\n=== 8. "改了 0 条"必须说出来，不能静默无操作 ★★ ===');
/*
 * 这一类比"保存失败还报成功"更隐蔽：保存**确实成功了**，
 * 只是 mutate 里一条都没匹配上 —— 快照没变，日志却照写"已移除 / 已移动"。
 *
 * 用户看到的是：点了删除、界面毫无变化、刷新后卡片仍在。
 * 没有报错，只有"没生效"，于是只能归结为"这个功能坏了"。
 *
 * 触发条件是**前后端判据不同**：后端 remove_card 按归一化键匹配
 * （Windows 下大小写不敏感 + 去尾斜杠），前端按原文精确比。
 * 配置被手改过、或路径来源不同时，后端认得的这里认不得。
 *
 * 注意：这里钉的是"要报错"，**不是"要改成归一化比较"** ——
 * 后者在 Linux 下会把 `a\\b` 与 `a/b` 判成同一个（`\\` 是合法文件名字符），
 * 删错东西比删不掉更糟。
 */
{
  const uf = fn('removeCard');
  t('removeCard 记录是否真的删掉了', /let removed = false;/.test(uf));
  t('removeCard 区分"页签不存在"与"页签里没有这条"',
    /let exists = false;/.test(uf) && /if \(!exists\)/.test(uf) && /if \(!removed\)/.test(uf));
  /* 两条提示都必须是 err 级（第二参数 true），否则用户当普通信息略过 */
  t('两条"未移除"都记为错误',
    (uf.match(/pushLog\(`未移除[^`]*`, true\)/g) || []).length === 2);

  const mf = fn('moveCard');
  t('moveCard 记录是否真的移动了', /let moved = false;/.test(mf));
  t('moveCard 取到保存结果（才有得判）', /const snap = await updateConfig/.test(mf));
  t('moveCard 没动时提示', /if \(snap && !moved\)/.test(mf) && /未移动/.test(mf));
  /*
   * src / tab **必须声明在 updateConfig 回调之外**。
   *
   * 日志里要用到它们（`源 ${src + 1} → 目标 ${tab + 1}`）。留在回调内的话，
   * 回调外的 pushLog 直接 ReferenceError —— 而语法检查（括号配对那套）
   * 报不出来，只有真拖一次卡片才炸（反向验证 2 证实了：把声明挪回去，
   * 语法检查仍然全绿）。
   */
  const iSnap = mf.indexOf('await updateConfig(');
  const iSrc = mf.indexOf('let src = -1;');
  const iTab = mf.indexOf('let tab = -1;');
  t('src 声明在回调之外', iSrc >= 0 && iSrc < iSnap, `src@${iSrc} snap@${iSnap}`);
  t('tab 声明在回调之外', iTab >= 0 && iTab < iSnap, `tab@${iTab}`);
  /* 反面证据：回调内不许再 `let src = ...` / `const tab = ...` */
  t('回调内不再重复声明 src', !/let src = fromTabIndex/.test(mf));
  t('回调内不再重复声明 tab', !/const tab = Math\.max/.test(mf));
}

console.log('\n=== 9. setState updater 里不得有副作用 ★ ===');
/*
 * `setX((cur) => { saveLayout(cur); return cur; })` 是明确的 React 反模式：
 * updater 必须是纯函数，React 有权重放它 —— StrictMode 下一定会跑两次，
 * 于是保存动作执行两次（两次跨进程文件锁、两次日志），而用户只操作了一次。
 * 将来保存动作一旦不再幂等（比如带计数），后果更直接。
 *
 * 只钉 useLayoutMemory 这一处：它是全库唯一在 updater 里做副作用的。
 * 判定要看**被赋值的名字**而不是 `set` 前缀，否则 `setTimeout` 之类会误伤。
 */
{
  const lm = fs.readFileSync(path.join(HERE, 'hooks/useLayoutMemory.ts'), 'utf8');
  const stripped = lm.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const bad = [];
  for (const m of stripped.matchAll(/set(\w+)\(\s*\(?\s*\w+\s*\)?\s*=>\s*\{/g)) {
    const varName = 'set' + m[1];
    // 副作用特征：updater 里调用了非 set* / 非纯函数
    const rest = stripped.slice(m.index, m.index + 400);
    for (const c of rest.matchAll(/\b(\w+)\(/g)) {
      const n = c[1];
      if (n === varName || n.startsWith('set')) continue;
      if (/^(Math|Number|String|Boolean)$/.test(n)) continue;
      if (n === 'if' || n === 'for' || n === 'while' || n === 'return') continue;
      bad.push(`${varName}→${n}`);
      break;
    }
  }
  t('useLayoutMemory 的 updater 里无副作用调用', bad.length === 0, bad.join('、'));
  /* 反面证据：现在应当直接读闭包值（依赖里带上它） */
  t('onColResizeEnd 依赖里带 colStars',
    /onColResizeEnd = useCallback\([\s\S]{0,220}?\}, \[saveLayout, colStars\]\)/.test(lm));
  t('onLogResizeEnd 依赖里带 logHeight',
    /onLogResizeEnd = useCallback\([\s\S]{0,220}?\}, \[saveLayout, logHeight\]\)/.test(lm));
}

console.log('\n=== 链接行数：按归一化键找，不能报出「0 个链接」===');
{
  /*
   * `snap.links.find((l) => l.project === project)` 是原文精确比，
   * 而后端按归一化键匹配（Windows 下大小写不敏感 + 去尾分隔符）。
   *
   * 配置被手改过、或拖进来的路径带尾反斜杠时 find 返回 undefined →
   * 日志写「已分配：X → Y（0 个链接）」。用户看到"分配完成"配着
   * "0 个链接"，只能以为没生效、再点一次 —— 而链接其实已经建好了。
   *
   * **报告的数字与事实不符**：不报错，但会让人做错后续判断。
   */
  const fpx = fs.readFileSync(path.join(HERE, 'hooks/useFpx.ts'), 'utf8');
  t('取到 useFpx', fpx.length > 0);
  t('createLink 按归一化键找行（反面证据）',
    !/const row: LinkRow \| undefined = snap\.links\.find\(\(l\) => l\.project === project\)/.test(fpx));
  t('两处都用了归一化键',
    (fpx.match(/normalizeKey\(l\.project, ci\)/g) || []).length === 2,
    '命中 ' + (fpx.match(/normalizeKey\(l\.project, ci\)/g) || []).length + ' 处');
  t('依赖带上了 ci', /\[api, applySnapshot, ci, ctx, pushLog, run\]/.test(fpx));
}

done();
