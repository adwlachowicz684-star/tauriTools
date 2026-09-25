/**
 * 跨进程文件锁回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/file-lock-token-test.mjs
 *
 * 这把锁保护的是"两个进程同时 load→改→save"——后写的会把先写的整份覆盖，
 * 且没有任何提示。所以锁本身的**失效**是灾难性的：互斥没了，
 * 而界面和日志都看不出来。
 *
 * 这里钉的是 `fsutil::try_lock` 写 owner token 的那一步。
 * 它看着只是"往锁文件里写两行诊断信息"，实际是释放时认领这把锁的
 * **唯一凭据**（见 `FileLockGuard::drop` 的 token 比对）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, sliceWithDoc } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '../..');
const { t, done } = makeT();

const rsPath = path.join(ROOT, 'src-tauri/src/fpx/fsutil.rs');
if (!fs.existsSync(rsPath)) {
  console.log('（跳过：未找到 fsutil.rs）');
  done();
}

const rs = fs.readFileSync(rsPath, 'utf8');

console.log('\n=== 1. token 必须真的写成功 ===');
{
  /*
   * `let _ = writeln!(f, "token={token}")` 吞掉写失败的话：
   *   1. 本次照样返回 Ok(Some) —— 调用方以为拿到锁，照常写数据；
   *   2. drop 时 read_owner_token 读到 None → 判定"不是我的锁" → **不删**；
   *   3. 锁文件留在那儿且 mtime 很新 → 后续每个实例都判为"未过期"，
   *      一路等到 LOCK_WAIT_MS 超时，报「另一个实例可能正在写入」。
   *
   * 于是从这一刻起每次保存都挂满等待上限再失败，而报错指向
   * "是不是还有个实例没关" —— 完全指向错了地方。
   * 真相只是那一次 writeln! 失败（磁盘满 / 权限），而它被吞了。
   */
  t('取到 fsutil.rs', rs.length > 0);
  /* 反面证据：不再有 let _ = 吞掉 token 写入 */
  t('不再有 let _ = writeln!(f, "token=...")（反面证据）',
    !/let _ = writeln!\(f, "token=/.test(rs));
  t('token 写失败会返回错误',
    /if let Err\(e\) = writeln!\(f, "token=\{token\}"\)/.test(rs));
  t('token 写失败会删掉刚建的锁文件',
    /writeln!\(f, "token=\{token\}"\)[\s\S]{0,120}?fs::remove_file\(path\)/.test(rs));
  /* 注释里会提到这行代码，所以要在**代码层面**判，不能整份匹配 */
  t('代码层面确实 return Err（剥注释后仍命中）',
    /if let Err\(e\) = writeln!\(f, "token=\{token\}"\)[\s\S]{0,160}?return Err\(e\)/
      .test(sliceWithDoc(rs, 'fn try_lock') || rs));
}

console.log('\n=== 2. flush 同样不能吞 ===');
{
  /*
   * token 只在页缓存里、而进程随后崩溃的话，drop 读回来的就是空文件，
   * 后果与写失败完全一样（锁永不释放）。
   */
  t('不再有 let _ = f.flush()（反面证据）', !/let _ = f\.flush\(\)/.test(rs));
  t('flush 失败也返回错误并删文件',
    /if let Err\(e\) = f\.flush\(\)[\s\S]{0,120}?fs::remove_file\(path\)/.test(rs));
}

console.log('\n=== 3. 诊断信息可以吞（不影响互斥）===');
{
  /*
   * pid / 时间那一行只是给人看的：判定一律看 mtime（注释里明写）。
   * 所以这里保留 let _ = 是**对的**，不该被上面两条一并改掉 ——
   * 改了反而会让"诊断信息写失败"变成"拿不到锁"，把无关问题升级成故障。
   */
  t('pid 诊断行仍是 Best-effort', /let _ = writeln!\([\s\S]{0,120}?pid=\{\}/.test(rs));
  t('判定确实只看 mtime（注释里有说明）',
    /内容可能写到一半、也可能被别的[\s\S]{0,80}?不如直接信 mtime/.test(rs));
}

console.log('\n=== 4. drop 必须比对 token 再删 ===');
{
  /*
   * 早先只判"锁文件是否 stale"就删，会把"别人刚建的锁"当成自己的删掉
   * —— 两个进程同时持锁，互斥失效，代价是整份登记被覆盖。
   */
  const drop = rs.slice(rs.indexOf('impl Drop for FileLockGuard'));
  t('取到 Drop 实现', drop.length > 0);
  t('drop 里比对 token', /Some\(t\) if t == self\.token/.test(drop));
  t('read_owner_token 只认第一行 token=', /strip_prefix\("token="\)/.test(rs));
}

done();
