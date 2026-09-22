/**
 * 锁状态：读实际生效 + 启动自愈（对齐原版 GetState / SweepRepair）
 * ------------------------------------------------------------------
 * 用法：node plugins/project-group/lock-live-state-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT } from './testkit.mjs';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { t, done } = makeT();
const strip = (x) => x.replace(/\/\*[\s\S]*?\*\//g, '');
const F = (n) => strip(fs.readFileSync(path.join(HERE, '../../src-tauri/src/fpx', n), 'utf8'));
const sys = F('sys.rs');
const mod = F('mod.rs');
const mcp = F('mcp.rs');
const main = strip(fs.readFileSync(path.join(HERE, '../../src-tauri/src/main.rs'), 'utf8'));

const blk = (src, head) => {
  const i = src.indexOf(head);
  if (i < 0) return '';
  const ends = ['\npub fn ', '\nfn ', '\npub(crate) fn ', '\nimpl ']
    .map((p) => src.indexOf(p, i + 1)).filter((x) => x > 0);
  return src.slice(i, ends.length ? Math.min(...ends) : src.length);
};

console.log('\n=== 1. 读实际生效状态（不只看登记值）★ ===');
{
  t('有 LockState', /pub struct LockState \{/.test(sys));
  t('有 lock_state', /pub fn lock_state\(path: &str\) -> Result<LockState, String>/.test(sys));
  const b = blk(sys, 'pub fn lock_state');
  t('是只读查询不修改', !/SetAccessControl|apply_lock/.test(b));
  t('目录不存在时报错', /目录不存在/.test(b));
}

console.log('\n=== 2. icacls 解析口径（只认 Everyone + DENY + 管理范围内的位）===');
{
  const b = blk(sys, 'pub fn lock_state');
  /* 身份必须是 Everyone：把第三方 Deny 当成自己的锁会误报 */
  t('只认 Everyone 行', /line\.starts_with\("Everyone:"\)/.test(b));
  t('只认 DENY 行', /line\.contains\("\(DENY\)"\)/.test(b));
  /* 权限位在 (DENY) 之后：**继承标记 (OI)(CI) 在前**，取错位置会拿到 CI 当权限位 */
  t('取 DENY 之后的括号', /line\.split\("\(DENY\)"\)\.nth\(1\)/.test(b));
  t('D/DE → 防删除', /"D" \| "DE" => st\.deny_delete = true/.test(b));
  t('W/AD/WA/WEA → 防写入', /"W" \| "AD" \| "WA" \| "WEA" => st\.deny_write = true/.test(b));
  /* WDAC(改权限)/WO(取所有权)/RC(读控制) 非管理范围，不能当成本工具的锁 */
  t('其余位不认（_ =>）', /_ => \{\}/.test(b));
}

console.log('\n=== 3. 启动自愈（幂等重建）===');
{
  const b = blk(sys, 'pub fn sweep_repair');
  t('已符合期望则免写', /if cur\.deny_delete == \*dd && cur\.deny_write == \*dw/.test(b));
  t('不符才 apply_lock', /apply_lock\(raw, \*dd, \*dw\)/.test(b));
  /* 读不到就跳过，不能基于"不知道"去写 ACL */
  t('读不到时跳过不写', /Err\(_\) => \{ wanted\.push\(raw\.clone\(\)\); \}/.test(b));
  t('逐条错误不中断', /errors\.push/.test(b));
}

console.log('\n=== 4. bootstrap 里接上，且 account_only 必须跳过 ★ ===');
{
  const i = mod.indexOf('pub fn fpx_bootstrap');
  const b = mod.slice(i, mod.indexOf('\npub fn ', i + 1));
  t('bootstrap 调用 sweep_repair', /sys::sweep_repair\(&desired, &\[\]\)/.test(b));
  /*
   * 账面固定（account_only）明确"不动系统权限"。
   * 自愈若给它落 ACL，等于替用户取消了这个选择，
   * 而他会以为自己从没开过锁 —— 比不自愈更糟。
   */
  t('过滤 account_only', /\.filter\(\|l\| !l\.account_only\)/.test(b));
  /* 失败只进 notices，绝不阻断启动 */
  t('错误并入 notices', /notices\.push\(format!\("\[ACL 自愈\] \{e\}"\)\)/.test(b));
  t('notices 传给 Bootstrap', /config_notices: notices,/.test(b));
}

console.log('\n=== 5. MCP lock_status 三段（configured / aclLive / consistent）===');
{
  const i = mcp.indexOf('"lock_status" => {');
  const b = mcp.slice(i, mcp.indexOf('\n        "', i + 5));
  t('有 configured', /"configured": \{ "denyDelete": dd, "denyWrite": dw \}/.test(b));
  t('有 aclLive', /"aclLive": \{ "delete": ld, "write": lw \}/.test(b));
  t('有 exists', /"exists": exists,/.test(b));
  /*
   * 关键：consistent 只在"读得到实际状态"时才算数。
   * 读不到就报 false 会让调用方以为"锁没生效"，
   * 而真相是"我们不知道" —— 两种情况必须分开。
   */
  t('consistent 先判 known', /let known = exists && lerr\.is_empty\(\);/.test(b));
  t('consistent 用 known', /"consistent": known && ld == dd && lw == dw,/.test(b));
  /* 旧字段保留，别把已有调用方弄坏 */
  t('保留旧 locked/denyDelete', /"locked": dd \|\| dw, "denyDelete": dd, "denyWrite": dw,/.test(b));
}

console.log('\n=== 6. 命令注册 ===');
{
  t('fpx_lock_state 已注册', /fpx::fpx_lock_state/.test(main));
}

console.log('\n=== 7. 原有行为没被改坏 ===');
{
  t('apply_lock 仍在', /pub fn apply_lock\(/.test(sys));
  t('仍只清 Everyone 的 deny', /"\/remove:d"/.test(sys) && /"Everyone"/.test(sys));
  t('Win 下两条 ACE 仍在', /for perm in \[format!\(/.test(sys));
  t('Unix 仍用 chmod 近似', /0o555/.test(sys));
}

done();
