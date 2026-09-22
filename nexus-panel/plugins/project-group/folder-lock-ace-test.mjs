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

done();
