/**
 * 「防写入档下自身写点不被自己拦住」的回归测试（零依赖）
 * ------------------------------------------------------------------
 * 用法：存成 nexus-panel/plugins/project-group/self-write-test.mjs，然后
 *         node plugins/project-group/self-write-test.mjs
 *
 * #427（清单标 `[险]`）：防写入的 ACL 会把**工具自己**也拦在外面。
 * 写 SKILL.md、写 desktop.ini 都是往受保护目录里写点，于是操作失败 ——
 * 用户看到的是"我明明是自己设的锁，却连自己也改不动了"，
 * 而报错信息（"拒绝访问"）完全指向不了原因。
 *
 * 这里守几件容易做错的事：
 *   · 按**祖先**摘锁，不是精确相等（ACL 靠继承传播，要写的常是子孙）
 *   · 摘锁窗口要盖住**全部写点**，不能只盖住第一个
 *   · 窗口不能盖住 spawn 出去的外部进程（否则期间目录无保护）
 *   · **恢复失败绝不静默** —— 摘了没恢复 = 目录永久失去保护
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeT, sliceWithDoc } from './testkit.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RS = path.join(HERE, '../../src-tauri/src/fpx');
const { t, done } = makeT();

const mod = fs.readFileSync(path.join(RS, 'mod.rs'), 'utf8');
const mcp = fs.readFileSync(path.join(RS, 'mcp.rs'), 'utf8');
const store = fs.readFileSync(path.join(RS, 'store.rs'), 'utf8');

console.log('\n=== 1. 按祖先摘锁（核心）===');
{
  const fn = sliceWithDoc(store, 'pub fn locks_covering', '/// Windows 下路径比较');
  t('定义了 locks_covering', /pub fn locks_covering<'a>/.test(store));
  t('返回 Vec（可能有多个祖先锁）', /-> Vec<&'a super::model::LockItem>/.test(fn));
  t('命中自身', /lk == key/.test(fn));
  /* 必须用分隔符边界，否则 /foo 会被当成 /foobar 的祖先 —— 误摘别人的锁 */
  t('命中子孙且按分隔符边界（防 /foo 误配 /foobar）',
    /key\.starts_with\(&format!\("\{lk\}\/"\)\)/.test(fn));
  t('注释说明"不能只用精确相等"', /为什么不能只用/.test(fn));
  t('注释说明 ACL 靠继承传播', /靠继承传播/.test(fn));
  t('用 normalize_key 比较', /normalize_key/.test(fn));
}

console.log('\n=== 2. with_unlock 存在且语义正确 ===');
{
  /* anchor 必须是**字面量**：indexOf 不吃正则，
     写成 `pub\(crate\)` 会永远找不到、切片变空、断言静默失败。 */
  const fn = sliceWithDoc(mod, 'fn with_unlock', 'fn upsert_record');
  t('定义了 with_unlock', /pub\(crate\) fn with_unlock/.test(mod));
  t('无保护时直接执行（不白跑一次 icacls）',
    /if covering\.is_empty\(\) \{\s*return f\(\);\s*\}/.test(fn));
  t('摘锁失败时把已摘的恢复回去', /for d in taken\.iter\(\)\.rev\(\) \{/.test(fn));
  t('摘锁失败的错误明说"保护未被改动"', /保护未被改动/.test(fn));
  t('恢复有重试一次', /重试一次/.test(fn));
  t('重试前短暂等待（资源管理器可能持有句柄）',
    /std::thread::sleep\(std::time::Duration::from_millis\(120\)\)/.test(fn));
  /* 写成功但恢复失败：必须报，且要说清"内容已写入" */
  t('恢复失败返回 Err（不静默）', /内容已写入，但 ACL 保护未能恢复/.test(fn));
  t('错误里提示去重新加锁', /重新加锁/.test(fn));
  t('注释说明"窗口要小"', /窗口要小/.test(fn));
  t('注释说明"恢复失败比写入失败严重"', /比写入失败严重得多/.test(fn));
}

console.log('\n=== 3. 所有写 desktop.ini 的点都进了窗口 ===');
{
  /* 裸调用 = 漏网。逐条列出 apply_icon 的调用，检查是否都被包裹 */
  const calls = (mod.match(/sys::apply_icon\(/g) || []).length
              + (mcp.match(/sys::apply_icon\(/g) || []).length;
  const wrapped = (mod.match(/with_unlock\([^;]*?sys::apply_icon\(/g) || []).length
                + (mcp.match(/with_unlock\([^;]*?sys::apply_icon\(/g) || []).length;
  t('apply_icon 调用总数 = 4', calls === 4, `${calls} 处`);
  t('全部被 with_unlock 包裹', wrapped === calls, `${wrapped}/${calls}`);

  /* 逐条点名，防止将来新增的第五处漏掉 */
  t('core_save_style 已包裹', /with_unlock\(dir, path, \|\| sys::apply_icon/.test(mod));
  t('fpx_set_icon 已包裹', /with_unlock\(&dir, &path, \|\| sys::apply_icon/.test(mod));
  t('MCP folder_icon_set 已包裹', /super::with_unlock\(&dir, &path, \|\| super::sys::apply_icon/.test(mcp));
  t('MCP folder_icon_restore 已包裹',
    /super::with_unlock\(&dir, &path, \|\| super::sys::apply_icon\(&path, ""\)\)/.test(mcp));
}

console.log('\n=== 4. 写 SKILL.md 也进了窗口（#33 那条路径）===');
{
  t('fpx_write_text 的原子写被包裹',
    /with_unlock\(&dir, &target, \|\| \{\s*std::fs::write\(&tmp/.test(mod));
  t('注释说明"保护的是 <组>/skill/ 而要写更深层"', /ACL 靠继承生效/.test(mod));
}

console.log('\n=== 5. deploy_skill 的摘锁窗口（最容易错的一处）===');
{
  /* endAt 不能用 "folder_icon_get"：它在本文档里出现过，
     且位置可能早于起点，slice 会得到空串、断言全部静默失败。
     用只出现在分支处的 "other =>"，且从起点往后找。 */
  const anchor427 = mcp.indexOf('摘锁窗口（#427）');
  const seg = mcp.slice(anchor427, mcp.indexOf('other =>', anchor427));
  /* 窗口要盖住 CreateDir 和写请求文件，但不能盖住 spawn */
  t('窗口在 create_dir_all 之前开始', /_guard = super::LockGuard::new/.test(seg));
  t('create_dir_all 在窗口内', /std::fs::create_dir_all\(&deploy_base\)/.test(seg));
  t('写请求文件在窗口内', /std::fs::write\(&req/.test(seg));
  /* 必须用**实际调用点**而不是裸 `send_command` ——
     后者第一次出现是在注释里（"注意用 send_command 而非 send"），
     位置比 drop 早，会让这条断言永远失败。
     这和"注释里出现某个词 ≠ 用户能看到"是同一类坑。 */
  t('spawn 之前恢复（drop 在真正调用之前）',
    seg.indexOf('drop(_guard)') < seg.indexOf('let r = super::chain::send_command'));
  t('注释说明"只盖 CreateDir 的话写请求文件时照样自伤"',
    /只盖 CreateDir 的话/.test(seg));
  t('注释说明"不能盖住 spawn"', /不能\*\*盖住后面 spawn/.test(seg));
  t('本地骨架分支也在窗口内', /本地骨架同样要写文件/.test(seg));
}

console.log('\n=== 6. 模块路径（语法检查抓不到的坑）===');
{
  /* mod.rs 就是 fpx/mod.rs，它的 super 是 crate 根，那里没有 model */
  t('mod.rs 里用 model::LockItem 而非 super::model', !/super::model::LockItem/.test(mod));
  t('store.rs 里用 super::model 是对的（它不在 mod.rs）',
    /super::model::LockItem/.test(store));
  t('mcp.rs 用 super::with_unlock（同级模块）', /super::with_unlock/.test(mcp));
}

console.log('\n=== 7. 原有的锁机制没被改坏 ===');
{
  t('LockGuard 仍在（rename/移动用精确相等那条）', /pub\(crate\) struct LockGuard/.test(mod));
  t('lock_of 仍在', /pub fn lock_of/.test(store));
  t('apply_lock 仍只清自己的 deny', /\/remove:d/.test(fs.readFileSync(path.join(RS, 'sys.rs'), 'utf8')));
}

done();
