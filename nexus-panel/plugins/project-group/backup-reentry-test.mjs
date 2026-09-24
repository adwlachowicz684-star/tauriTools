/**
 * 备份防重入（对齐原版 _backupBusy）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/backup-reentry-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const F = (n) => strip(fs.readFileSync(
  path.join(HERE, '../../src-tauri/src/fpx', n), 'utf8'));

const bak = F('backup.rs');
const mod = F('mod.rs');
const mcp = F('mcp.rs');

console.log('\n=== 1. 三条入口都经过 run（只在一处加守卫就不会漏）===');
{
  t('手动命令走 backup::run', /backup::run\(&cfg, &dir, &kind, ao\)/.test(mod));
  t('MCP 走 backup::run', /super::backup::run\(&cfg, &dir, kind, append_only\)/.test(mcp));
  /*
   * 自动线程仍要走 run（三条入口共用一处防重入的关键）。
   *
   * 锚点**不能**钉 `let _ = run(&cfg, &dir, "project"`：
   * 那一轮为了让"备份失败不再谎报成功"，把两处 `let _ =` 改成了
   * 收集 errors 的循环 —— 钉死旧写法会在**代码变得更好之后**报错。
   * 真正要钉的是"自动线程确实调了 run 并拿到结果"，不是它怎么写。
   */
  t('自动线程走 run', /let r = run\(&cfg, &dir, k, append\)/.test(bak));
  t('自动线程不再吞掉结果', !/let _ = run\(/.test(bak));
}

console.log('\n=== 2. 进行中标志 ===');
{
  t('有 BACKUP_BUSY', /static BACKUP_BUSY: AtomicBool = AtomicBool::new\(false\);/.test(bak));
  /* compare_exchange 而不是先 load 再 store：后者两个线程同时读到 false 会一起进来 */
  t('用 compare_exchange 抢占',
    /BACKUP_BUSY\s*\n\s*\.compare_exchange\(false, true, Ordering::SeqCst, Ordering::SeqCst\)/.test(bak));
  t('有 is_busy 探测', /pub fn is_busy\(\) -> bool/.test(bak));
}

console.log('\n=== 3. 用 Drop 自动释放 ★ ===');
{
  /*
   * 靠各条返回路径手动 store(false) 的话，漏一处（中途 return / panic）
   * 标志就永久停在 true —— 之后所有备份都做不了且无报错。
   */
  t('有 BackupGuard', /pub struct BackupGuard;/.test(bak));
  t('impl Drop', /impl Drop for BackupGuard/.test(bak));
  t('Drop 里置回 false', /BACKUP_BUSY\.store\(false, Ordering::SeqCst\);/.test(bak));
}

console.log('\n=== 4. run 入口抢占，且早于任何工作 ===');
{
  const iGuard = bak.indexOf('let _guard = match try_begin()');
  const iPaths = bak.indexOf('let paths = collect_paths(tabs);');
  /*
   * 用 `>= 0` 而不是 `> 0`：后者把"索引恰好为 0"也判成不合法。
   * 且顺序断言**两端都要判存在** —— 只判一端的话，另一端锚点被改没了
   * 会让比较恒真/恒假，断言要么空跑要么无端报红。
   */
  t('run 顶部抢占', iGuard >= 0 && iPaths >= 0 && iGuard < iPaths,
    `guard=${iGuard} paths=${iPaths}`);
  /* 被占用时返回带错误的结果，而不是静默成功（原版直接 return = 点了没反应） */
  t('被占用时返回错误', /\[跳过\] 已有备份正在进行/.test(bak));
  t('结果仍带 target（不为空）', /return BackupResult \{\s*\n\s*target: target\.to_string_lossy\(\)\.to_string\(\),/.test(bak));
}

console.log('\n=== 5. 自动线程：先探再跑，不吃掉本轮 ===');
{
  /*
   * 若先把 last 推到"现在"再抢占失败，这一轮就白等一整个间隔。
   * 先探 is_busy()，被占用就 continue（last 不动，30 秒后重试）。
   */
  /*
   * `last = Some(SystemTime::now());` 在文件里有**两处**：
   * 一处在"首次进入只记起点"，一处在真正执行前。
   * 用 indexOf 拿到的是前者，顺序断言会假失败 —— 必须从探测点往后找。
   */
  const iBusy = bak.indexOf('if is_busy() { continue; }');
  const iLast = bak.indexOf('last = Some(SystemTime::now());', iBusy);
  t('先探 is_busy', iBusy >= 0);
  t('探测在更新 last 之前', iBusy >= 0 && iLast >= 0 && iLast > iBusy,
    `busy=${iBusy} last=${iLast}`);
}

console.log('\n=== 6. 原有行为没被改坏 ===');
{
  t('差异比对仍用 2 秒容差', /const MTIME_TOLERANCE_SECS: i64 = 2;/.test(bak));
  t('仍跳过链接', /fn is_link\(p: &Path\) -> bool/.test(bak));
  t('仍防自我嵌套', /fn is_nested\(a: &Path, b: &Path\) -> bool/.test(bak));
  t('原子复制仍在', /fn copy_atomic\(src: &Path, dst: &Path\)/.test(bak));
  t('自动线程仍分段睡', /for _ in 0\.\.TICK_SECS/.test(bak));
}

done();
