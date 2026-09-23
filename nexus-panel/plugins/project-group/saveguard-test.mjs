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

done();
