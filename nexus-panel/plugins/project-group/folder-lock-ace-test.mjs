/**
 * ACL 保护要下两条 ACE（对齐原版 FolderLockService.Apply）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/folder-lock-ace-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const sys = strip(fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx/sys.rs'), 'utf8'));

console.log('\n=== 1. 两条 ACE 都要下（目录自身那条此前缺失）★ ===');
{
  /* 定位 windows 分支：apply_lock 函数块 */
  const i = sys.indexOf('pub fn apply_lock');
  const j = sys.indexOf('\npub fn ', i + 1);
  const k = sys.indexOf('\nfn ', i + 1);
  const ends = [j, k].filter((x) => x > 0);
  const blk = sys.slice(i, Math.min(...ends));
  console.log(`（apply_lock 块 ${blk.length} 字符）`);

  t('循环下多条 ACE', /for perm in \[format!\(/.test(blk));
  /* 继承到子对象的那条 */
  t('有继承 ACE', /format!\("Everyone:\(OI\)\(CI\)\(\{rights\}\)"\)/.test(blk));
  /* 目录自身的那条：不带继承标记 */
  t('有目录自身 ACE', /format!\("Everyone:\(\{rights\}\)"\)/.test(blk));
  /* 顺序：先继承后自身，与原版一致 */
  const iInh = blk.indexOf('Everyone:(OI)(CI)({rights})');
  const iSelf = blk.indexOf('Everyone:({rights})', iInh);
  t('先继承后自身', iInh > -1 && iSelf > iInh, `inh=${iInh} self=${iSelf}`);
  /* 每条都要检查失败：只跑一次 status 判断的话第二条静默失败 */
  t('每条都校验 status', (blk.match(/if !out\.status\.success\(\)/g) || []).length >= 1);
}

console.log('\n=== 2. 解除保护要能清掉两条 ===');
{
  /* /remove:d Everyone 移除该身份的**全部** deny，两条都在范围内 */
  t('解除走 /remove:d', /"\/remove:d"/.test(sys));
  t('解除目标是 Everyone', /"Everyone"/.test(sys));
  /* 两条都在应用之前清，否则叠加 */
  const iRem = sys.indexOf('/remove:d');
  const iDeny = sys.indexOf('/deny');
  t('先清后加', iRem > -1 && iRem < iDeny, `remove=${iRem} deny=${iDeny}`);
}

console.log('\n=== 3. 非 Windows 分支没被改坏 ===');
{
  t('Unix 仍用 chmod 近似', /0o555/.test(sys));
  t('Unix 消息与实际一致', /当前平台不支持单独的防删除档/.test(sys));
}

console.log('\n=== 2. #211 内容浏览不需要摘锁（清单误判）★ ===');
{
  /*
   * 状态表此前写「211 · 内容浏览受 ACL 保护时摘锁执行 / content.rs 无 unlock」。
   * 回原版核对后判**不适用（➖）**：
   *
   * 原版 FolderLockService 只有两类 deny ——
   *   DeleteRights = Delete | DeleteSubdirectoriesAndFiles
   *   WriteRights  = WriteData | AppendData | WriteAttributes | WriteExtendedAttributes
   * **没有任何读位**（ReadData / ReadAttributes / ListDirectory / Traverse 都没 deny）。
   *
   * 所以"读目录 / 读文件"根本不在被挡之列 —— content.rs 里全是
   * `read_dir` / `read_to_string`，不需要摘锁，摘了反而是多余的权限操作。
   *
   * 这不是"还没做"，是**不该做**。判 ⬜ 会让它一直挂着假装是个缺口。
   */
  const i = sys.indexOf('pub fn apply_lock');
  const ends = [sys.indexOf('\npub fn ', i + 1), sys.indexOf('\nfn ', i + 1)].filter((x) => x > 0);
  const blk = sys.slice(i, Math.min(...ends));

  /*
   * 真正要钉的契约：**权限位集合里永远不能出现读位**。
   *
   * 哪天有人往里加一个 `R`，内容浏览就会在受保护目录下静默失败 ——
   * 那时 #211 才真的变成缺口。所以钉的是"只可能有 D 和 W"，
   * 而不是"content.rs 里有没有 unlock"。
   */
  t('rights 只由 D/W 两个位拼出',
    /if deny_delete \{ rights\.push\('D'\); \}/.test(blk)
    && /if deny_write \{ rights\.push\('W'\); \}/.test(blk), blk.slice(blk.indexOf('let mut rights'), blk.indexOf('let mut rights') + 200));
  /* 反面证据：不允许再出现第三个 push（那多半就是读位） */
  t('没有第三个权限位（读位）', !/rights\.push\('[^DW]'\)/.test(blk));

  /*
   * 状态解析同口径：只认 D/DE/W/AD/WA/WEA，
   * 读位（R/GR 等）与 WDAC/WO/RC 一样属非管理范围，不当成本工具的锁。
   * 认错的话"用户手动加了读 deny"会被当成我们上的锁，解除时一并清掉 ——
   * 动了用户没要求动的东西。
   */
  t('解析只认删除位', /"D" \| "DE" => st\.deny_delete = true/.test(sys));
  t('解析只认写入位', /"W" \| "AD" \| "WA" \| "WEA" => st\.deny_write = true/.test(sys));
  t('锁状态只有 deny_delete / deny_write 两个字段',
    /pub struct LockState[\s\S]{0,200}deny_delete: bool,[\s\S]{0,120}deny_write: bool/.test(sys));

  /*
   * 顺带确认**写**路径已经接了摘锁（#427）—— 那才是真正需要它的地方。
   * 读不用摘、写必须摘，两边都确认完，#211 的判定才站得住。
   */
  const mod = strip(fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx/mod.rs'), 'utf8'));
  const wi = mod.indexOf('pub fn fpx_write_text');
  const wblk = mod.slice(wi, mod.indexOf('\npub fn ', wi + 1));
  t('写正文（SKILL.md / rule）走了 with_unlock', /with_unlock\(&dir, &target,/.test(wblk), wblk.slice(-260));
}

console.log('\n=== 3. #181 数据自检要有 ACL 用例 ★ ===');
{
  const cli = strip(fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx/cli.rs'), 'utf8'));
  const i = cli.indexOf('pub fn self_check(');
  const blk = cli.slice(i, cli.indexOf('\npub fn ', i + 1));

  t('self_check 里有 ACL 段', /ACL 系统级往返/.test(blk));

  /*
   * 一、**必须**用临时探针目录，不能用 config 里的真实路径。
   *
   * 后者会在自检期间真的去改用户的目录权限 ——
   * 用户跑一次自检，自己的目录被上锁又解锁一遍，而报告里看不出来。
   */
  t('用探针目录（_acl-probe）', /out\.join\("_acl-probe"\)/.test(blk));
  /*
   * 必须钉**两处**：开头清残留一处、跑完删除一处。
   * 只钉"存在"的话，删掉跑完那处、留下开头那处，断言照样通过（漏报）——
   * 本轮反向验证就踩到了。
   */
  t('探针目录跑完删除（共两处：清残留 + 收尾）',
    (blk.match(/remove_dir_all\(&probe\)/g) || []).length >= 2,
    '出现 ' + (blk.match(/remove_dir_all\(&probe\)/g) || []).length + ' 次');
  t('没用 config 里的真实路径做 ACL 用例', !/locks\.iter\(\)\s*\n\s*\{\s*apply_lock/.test(blk));

  /*
   * 二、**不能**直接调 `with_unlock`。
   *
   * 它按 `config.locks` 查覆盖该路径的祖先锁，而探针目录不在配置里 →
   * `covering` 为空 → 直接透传，什么也测不到。
   * 若"简化"成调它，测试会永远通过且毫无意义。
   */
  t('没有在自检里调 with_unlock（会空跑）', !/with_unlock\(/.test(blk));

  /*
   * 三、用 `cfg!(windows)` 而不是 `#[cfg(windows)]`。
   *
   * 后者会让非 Windows 下这段**根本不参与编译**，
   * 语法错了也发现不了（上次那个多写分号的事故就是这么来的）。
   */
  t('用 cfg!(windows) 布尔常量', /if !cfg!\(windows\)/.test(blk));
  t('非 Windows 时明说跳过（不是默默不测）', /跳过 ACL 用例/.test(blk));

  /* 四、六步往返：Protect → 拒删 → 窗口内可删 → 恢复 → 防写入 → Unprotect */
  t('Protect 后读回校验', /Protect\(防删除\) 后读回不一致/.test(blk));
  t('验"拒删"且失败时报"等于没锁住"', /防删除档下删除子文件未被拒绝/.test(blk));
  t('验"窗口内可删"', /摘锁窗口内仍删不掉/.test(blk));
  t('验"窗口结束恢复"', /解锁窗口结束后 denyDelete 未恢复/.test(blk));
  t('验"防写入档拒新建"', /防写入档下新建文件未被拒绝/.test(blk));
  t('验 Unprotect 无残留', /Unprotect 后仍有残留/.test(blk));
  /*
   * 每一条失败都必须进 check（否则只是打日志，自检仍报"全部通过"——
   * 那正是"看起来做完了"的样子）。
   */
  t('用例结果进 check（不是只打日志）', /match acl[\s\S]{0,400}check\(/.test(blk));
  /*
   * 必须钉 **match acl 块内**的 Err 分支。
   * 只钉 `Err(e) => check(false,` 的话，self_check 前几节也有同形代码 ——
   * 把 ACL 这条改成丢弃后，断言仍被别处命中（漏报，本轮踩到）。
   */
  const mi = blk.indexOf('match acl {');
  const mblk = blk.slice(mi, mi + 400);
  t('失败时 pass 会被置 false（在 match acl 块内）',
    /Err\(e\) => check\(false,/.test(mblk), mblk.slice(0, 200));
}

done();
