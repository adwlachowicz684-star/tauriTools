/**
 * 监控器抑制的回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/watch-suppress-test.mjs，然后
 *         node plugins/project-group/watch-suppress-test.mjs
 *
 * #411：搬家 / 改名会改变**自己正在监控**的目录，于是监控器把
 * "你刚做的事"当成"有人动了受保护的文件夹"，弹一堆告警。
 * 用户改个名就被自己吓一次，久了只能把告警整个关掉 —— 那监控就形同虚设。
 *
 * 这里守几件容易做错的事：
 *   · **抑制期间必须照常更新指纹**（最容易错的一处）
 *   · 必须在**动手之前**登记，事后补会漏掉中间那次轮询
 *   · 新旧路径都要登记（改名后监控的是新路径）
 *   · 过期项要清理，否则列表无限增长
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, sliceWithDoc } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '../../src-tauri/src/fpx');
const { t, done } = makeT();

const watch = fs.readFileSync(path.join(RS, 'watch.rs'), 'utf8');
const mod = fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8');

console.log('\n=== 1. 机制存在 ===');
{
  t('定义 SUPPRESSED', /static SUPPRESSED: Mutex<Vec<\(String, Instant\)>>/.test(watch));
  t('定义 INTERVAL_SECS', /static INTERVAL_SECS: AtomicU64/.test(watch));
  t('导入 Instant', /use std::time::\{Duration, Instant, UNIX_EPOCH\}/.test(watch));
  t('有 pub fn suppress', /pub fn suppress\(paths: &\[String\]\)/.test(watch));
  t('有 fn suppressed 查询', /fn suppressed\(p: &str\) -> bool/.test(watch));
  t('轮询间隔被记下来（抑制时长按它推算）',
    /INTERVAL_SECS\.store\(interval\.as_secs\(\)\.max\(1\)/.test(watch));
}

console.log('\n=== 2. 抑制时长要盖住一次轮询（核心）===');
{
  const fn = sliceWithDoc(watch, 'pub fn suppress', '/// 取走待处理事件');
  t('时长 = 间隔 + 10 秒余量', /saturating_add\(10\)/.test(fn));
  t('注释说明"目的是盖住下一次轮询"', /盖住\*\*下一次轮询\*\*/.test(fn));
  t('空列表直接返回', /if paths\.is_empty\(\) \{ return; \}/.test(fn));
  /* 事件是在轮询那一刻比对出来的，所以抑制必须 >= 一个周期 */
  t('注释说明事件在轮询那一刻产生', /事件是在轮询那一刻比对出来的/.test(fn));
}

console.log('\n=== 3. 抑制期间照常更新指纹（最容易错的一处）===');
{
  const loop = watch.slice(watch.indexOf('let mut changed: Vec<WatchEvent>'), watch.indexOf('// 配置里删掉的目录不再监控'));
  t('命中抑制时走独立分支', /if suppressed\(p\) \{/.test(loop));
  t('存在则更新指纹', /last\.insert\(p\.clone\(\), fingerprint\(path\)\);/.test(loop));
  t('不存在则移除（与正常分支一致）', /last\.remove\(p\);/.test(loop));
  t('抑制分支 continue（不产生事件）', /continue;/.test(loop));
  /* 注释必须说清"为什么不能跳过不更新" */
  /* 这段注释写**在循环内部**（抑制分支上方），不在 `let mut changed` 之前，
     所以直接切整个循环体 —— 它自然包含注释。 */
  const note = loop;
  t('注释写明"照常更新指纹，只是不报事件"',
    /照常更新指纹，只是不报事件/.test(note));
  t('注释写明"跳过不更新只是把误报推迟"', /只是把误报推迟/.test(note));
}

console.log('\n=== 4. 过期与清理 ===');
{
  const fn2 = sliceWithDoc(watch, 'pub fn suppress', '/// 取走待处理事件');
  t('登记时顺手清过期项', /v\.retain\(\|\(_, u\)\| \*u > Instant::now\(\)\)/.test(fn2));
  t('重复登记按最后一次顺延', /Some\(e\) => e\.1 = until/.test(fn2));
  const q = watch.slice(watch.indexOf('/// 该路径当前是否处于抑制窗口内'), watch.indexOf('fn mtime_secs'));
  t('查询时按未过期才算抑制', /\*u > Instant::now\(\)/.test(q));
  t('锁中毒时不阻塞（返回 false）', /Err\(_\) => false/.test(q));
  t('按归一化键匹配（路径写法不同也能命中）',
    /super::store::normalize_key/.test(watch));
}

console.log('\n=== 5. 两个入口都登记了 ===');
{
  t('改名处调用 suppress', /watch::suppress\(&\[path\.to_string\(\), new_path\.clone\(\)\]\)/.test(mod));
  t('搬家处调用 suppress',
    (mod.match(/watch::suppress\(&\[path\.to_string\(\), new_path\.clone\(\)\]\)/g) || []).length === 2);
  t('改名处注释说明"必须在动手之前"', /必须在动手之前/.test(mod));
  t('搬家处注释指向同一理由', /抑制监控器（#411），理由同上/.test(mod));
}

console.log('\n=== 6. 顺序：抑制在物理移动之前 ===');
{
  /*
   * 断言**不绑具体写法**：摘锁那行的配置来源此前是事务里的 `cfg`，
   * 改为事务外 `cfg0` 后就找不到了（绑源码形态的断言在重构后必然误报）。
   * 真正要钉的是"抑制早于摘锁"这个**次序**，所以按块定位、用宽松串匹配。
   */
  const guardIdxIn = (blk) => {
    const i = blk.indexOf('LockGuard::new(path, store::lock_of(');
    return i;
  };
  const supIdxIn = (blk) => blk.indexOf('watch::suppress(&[path.to_string()');

  const renBlk = (() => {
    const i = mod.indexOf('pub(crate) fn core_rename_folder');
    const ends = ['\nfn ', '\npub fn ', '\npub(crate) fn ']
      .map((p) => mod.indexOf(p, i + 1)).filter((x) => x > 0);
    return mod.slice(i, Math.min(...ends));
  })();
  const movBlk = (() => {
    const i = mod.indexOf('fn core_move_folder');
    const ends = ['\nfn ', '\npub fn ', '\npub(crate) fn ']
      .map((p) => mod.indexOf(p, i + 1)).filter((x) => x > 0);
    return mod.slice(i, Math.min(...ends));
  })();
  const ra = supIdxIn(renBlk), rg = guardIdxIn(renBlk);
  t('改名：抑制在摘锁之前', ra > -1 && rg > -1 && ra < rg, `sup=${ra} guard=${rg}`);
  const ma = supIdxIn(movBlk), mg = guardIdxIn(movBlk);
  t('搬家：抑制在摘锁之前', ma > -1 && mg > -1 && ma < mg, `sup=${ma} guard=${mg}`);
}

console.log('\n=== 7. 原有行为没被改坏 ===');
{
  t('代次机制仍在（防两个线程重复上报）', /static GEN: AtomicU64/.test(watch));
  t('PULL_LIMIT 仍在', /const PULL_LIMIT/.test(watch));
  t('解除保护后不再盯着（retain）', /last\.retain\(\|k, _\| cfg_paths\.contains\(k\)\)/.test(watch));
}

done();
