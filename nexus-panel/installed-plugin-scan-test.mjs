/**
 * 已安装插件扫描测试
 * ============================================================
 * 用**真实临时目录**（不用 mock fs）
 * ------------------------------------------------------------
 * 扫描器的失效形状是「目录扫了但一个都没认出来」，mock 文件系统
 * 测不出这类问题 —— 它连真实路径分隔符、隐藏目录行为都不走。
 * 所以本测试在 os.tmpdir() 下真建目录、真写文件、真扫。
 *
 * 第 46 轮：扫描器改成注入式异步 fs 后，这里注入
 * scripts/node-fs-adapter.mjs 的 createNodeFs()（仍是真盘），
 * 所有调用点 await。**漏一个 await 就是拿 Promise 当结果对象**，
 * 表现为「一个插件都没有」且不报错 —— 全仓 async 守卫专盯这个。
 *
 * 元断言（第 4、7 节）是本文件的重点
 * ------------------------------------------------------------
 * 「扫到 0 个」既可能是「确实没装」，也可能是「扫描器坏了」。
 * 两者在界面上表现完全一样（侧边栏没有插件），必须靠断言区分。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanInstalledPlugins, pluginsWithInstalled } from './js/installed-plugin-scan.js';
import { MANIFEST_FILE } from './js/plugin-manifest.js';
import { createNodeFs } from './scripts/node-fs-adapter.mjs';

const fs = createNodeFs();

let pass = 0, fail = 0, skip = 0, note = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const info = (name, extra = '') => { note++; console.log(`ℹ️ ${name}${extra ? ' → ' + extra : ''}`); };

/** 建一个干净的临时插件根目录 */
function freshRoot(tag) {
  return mkdtempSync(join(tmpdir(), `nx-plug-${tag}-`));
}

/** 在根目录下造一个插件目录 */
function makePlugin(root, id, opts = {}) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  if (opts.manifest !== null) {
    const mf = opts.manifest || {
      id, name: `插件 ${id}`, version: '1.0.0', entry: opts.entry || 'index.html',
    };
    writeFileSync(join(dir, MANIFEST_FILE),
      typeof opts.raw === 'string' ? opts.raw : JSON.stringify(mf), 'utf8');
  }
  if (opts.entry !== false) {
    writeFileSync(join(dir, opts.entry || 'index.html'), '<html></html>', 'utf8');
  }
  return dir;
}

const cleanup = [];
const root1 = freshRoot('main');
cleanup.push(root1);

/* ============================================================
   1. 边界：目录不存在 / 空目录 —— 都不许崩
   ============================================================ */
console.log('\n--- 1. 边界 ---');
{
  const r = await scanInstalledPlugins(join(root1, 'not-exist-yet'), { fs });
  t('目录不存在不抛异常（首次启动属正常态）', Array.isArray(r.errors) && r.errors.length === 1, r.errors.join(';'));
  t('目录不存在时 found=0', r.found === 0);
  t('目录不存在时 manifests 为空', r.manifests.length === 0);

  const empty = freshRoot('empty'); cleanup.push(empty);
  const r2 = await scanInstalledPlugins(empty, { fs });
  t('空目录不报错', r2.errors.length === 0, r2.errors.join(';'));
  t('空目录 found=0', r2.found === 0);

  const r3 = await scanInstalledPlugins('', { fs });
  t('未指定目录 → 报出（不静默返回空）', r3.errors.length === 1, r3.errors.join(';'));
}

/* ============================================================
   2. 正常扫描
   ============================================================ */
console.log('\n--- 2. 正常扫描 ---');
{
  const root = freshRoot('ok'); cleanup.push(root);
  makePlugin(root, 'alpha');
  makePlugin(root, 'beta', { entry: 'main.js' });
  const r = await scanInstalledPlugins(root, { fs });
  t('扫到 2 个插件目录', r.found === 2, String(r.found));
  t('2 个都校验通过', r.manifests.length === 2, String(r.manifests.length));
  t('无跳过项', r.skipped.length === 0, JSON.stringify(r.skipped));
  t('id 完整', r.manifests.map((m) => m.id).sort().join(',') === 'alpha,beta');
}

/* ============================================================
   3. 各类异常都必须「带原因地跳过」，不静默
   ============================================================ */
console.log('\n--- 3. 异常项 ---');
{
  const root = freshRoot('bad'); cleanup.push(root);

  /*
   * 混一个**正常插件**进去 —— 验证「坏插件不拖垮整批扫描」。
   * 这条是一次破坏验证挖出来的：statSync 在 entry 缺失时抛 ENOENT，
   * 会让整个扫描崩掉，连这个好插件也一起扫不出来。
   * 只放坏插件的话，这个缺陷测不出来（扫出 0 个看起来很合理）。
   */
  makePlugin(root, 'good-one');

  const noMf = join(root, 'no-manifest');
  mkdirSync(noMf, { recursive: true });

  const badJson = join(root, 'bad-json');
  mkdirSync(badJson, { recursive: true });
  writeFileSync(join(badJson, MANIFEST_FILE), '{ id: ', 'utf8');

  makePlugin(root, 'no-entry', { entry: false });

  const hidden = join(root, '.hidden');
  mkdirSync(hidden, { recursive: true });

  writeFileSync(join(root, 'stray-file.txt'), 'x', 'utf8');

  const r = await scanInstalledPlugins(root, { fs });
  const reasons = r.skipped.map((s) => `${s.id}:${s.reason}`);

  t('缺 manifest → 跳过并说明', reasons.some((x) => x.startsWith('no-manifest:') && x.includes(MANIFEST_FILE)), reasons.join(' | '));
  t('坏 JSON → 跳过并说明', reasons.some((x) => x.startsWith('bad-json:') && x.includes('解析失败')), reasons.join(' | '));
  t('entry 文件不存在 → 跳过（否则装完白屏且无从查）',
    reasons.some((x) => x.startsWith('no-entry:') && x.includes('entry 文件不存在')), reasons.join(' | '));
  t('点开头目录被跳过（不计入 found）', r.found === 4, `found=${r.found}`);
  t('散落文件被跳过（不计入 found）', !reasons.some((x) => x.startsWith('stray-file')), reasons.join(' | '));
  /* 坏插件不得拖垮整批：好插件必须照样被扫出来 */
  t('坏插件不影响其它插件（好插件仍被扫出）',
    r.manifests.length === 1 && r.manifests[0].id === 'good-one',
    `扫出 ${r.manifests.length} 个: ${r.manifests.map((m) => m.id).join(',')}`);

  /* 冲突：id 与内置重复 */
  const root2 = freshRoot('clash'); cleanup.push(root2);
  makePlugin(root2, 'settings');
  const r2 = await scanInstalledPlugins(root2, { fs, reservedIds: ['settings', 'home'] });
  t('id 与内置冲突 → 跳过', r2.manifests.length === 0 && r2.skipped.length === 1,
    JSON.stringify(r2.skipped));
}

/* ============================================================
   4. 元断言：扫描器确实扫到了（防「空跑」假绿）
   ------------------------------------------------------------
   把「扫到 0 个」当成通过是这类守卫最经典的失效：
   目录路径写错、readdir 抛错被 catch 掉、filter 条件写反 ——
   全都表现为 manifests=[]，而「确实没装插件」也是 manifests=[]。
   ============================================================ */
console.log('\n--- 4. 元断言：不得空跑 ---');
{
  const root = freshRoot('meta'); cleanup.push(root);
  makePlugin(root, 'one');
  const r = await scanInstalledPlugins(root, { fs });
  t('元断言：确实扫到了目录（found > 0）', r.found > 0, `found=${r.found}`);
  t('元断言：确实产出了 manifest（非空跑）', r.manifests.length > 0, String(r.manifests.length));
  t('元断言：扫描结果与目录内容一致（1 个目录 → 1 个插件）',
    r.found === 1 && r.manifests.length === 1);

  /* 反向：不该认出来的不能认出来（防止判据放宽到「什么都收」） */
  const badRoot = freshRoot('meta-bad'); cleanup.push(badRoot);
  const d = join(badRoot, 'broken');
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, MANIFEST_FILE), '{"id":"broken","name":"x","version":"1.0.0","entry":"../../evil.html"}', 'utf8');
  writeFileSync(join(d, 'evil.html'), 'x', 'utf8');
  const r2 = await scanInstalledPlugins(badRoot, { fs });
  t('元断言：路径穿越的 entry 不被接受', r2.manifests.length === 0, JSON.stringify(r2.manifests.map((m) => m.entry)));
  t('元断言：路径穿越被记为跳过（不是静默消失）', r2.skipped.length === 1, JSON.stringify(r2.skipped));
}

/* ============================================================
   5. 合并
   ============================================================ */
console.log('\n--- 5. 扫描 + 合并 ---');
{
  const root = freshRoot('merge'); cleanup.push(root);
  makePlugin(root, 'gamma');
  const statics = [{ id: 'home', name: '概览', type: 'module' }];
  const r = await pluginsWithInstalled(statics, root, { fs });
  t('合并后 = 静态 1 + 安装 1', r.plugins.length === 2, String(r.plugins.length));
  const g = r.plugins.find((p) => p.id === 'gamma');
  t('安装插件带 installed:true', g && g.installed === true);
  t('安装插件一律 iframe', g && g.type === 'iframe');
  t('found 被带出（供界面显示"扫到几个"）', r.found === 1, String(r.found));

  /* 目录不存在时合并仍要能用（不能因为没装插件就连内置也没了） */
  const r2 = await pluginsWithInstalled(statics, join(root, 'nope'), { fs });
  t('目录不存在时内置插件照常返回', r2.plugins.length === 1 && r2.plugins[0].id === 'home');
  t('目录不存在时 errors 有说明', r2.errors.length === 1, r2.errors.join(';'));
}

/* ============================================================
   6. 目录不可读时不能崩
   ============================================================ */
console.log('\n--- 6. 读目录失败 ---');
{
  /* 破坏验证 G 向揪出的假绿：原用例传了一个**根本不存在**的路径，
     于是走的是「目录不存在」分支，readdir 一次都没被调用；
     而断言写的是 `errors>=1 || found===0`，即使 readdir 被静默吞成
     空目录也照样绿。现在真建一个文件当路径，exists=true、readdir 抛
     ENOTDIR，并精确断言必须是「读目录失败」这一条。 */
  const stray = join(root1, 'stray-file.txt');
  writeFileSync(stray, 'x', 'utf8');
  const r = await scanInstalledPlugins(stray, { fs });
  t('传入的是文件路径而非目录 → 明确报「读目录失败」且不崩',
    r.errors.length === 1 && r.found === 0 && r.errors[0].includes('读目录失败'),
    `errors=${r.errors.join(';')} found=${r.found}`);
}

/* ============================================================
   7. 注入式 fs 的契约（第 46 轮新增）
   ------------------------------------------------------------
   这一节钉住改造最容易悄悄丢掉的三条：
     · 没注入 fs 不能静默降级成「空列表」
     · statSync(entryPath).isFile() 那条主判据必须一比一保住
     · 扫描器必须真的走注入的 fs（不能绕过它返回固定结果）
   ============================================================ */
console.log('\n--- 7. 注入式 fs 契约 ---');
{
  let threw = null;
  try { await scanInstalledPlugins(root1, {}); } catch (e) { threw = String((e && e.message) || e); }
  t('缺 fs 时明确 throw（不把「没接文件能力」伪装成「没装插件」）',
    !!threw && threw.includes('未注入 fs'), String(threw));

  const root = freshRoot('direntry'); cleanup.push(root);
  makePlugin(root, 'healthy');
  /* entry 必须是 .html/.js/.mjs（validateManifest 会先挡），否则还没走到
     isFile 主判据就被拒 —— 那样测的是另一条判据，且会假绿。 */
  const d = join(root, 'dir-entry');
  mkdirSync(join(d, 'sub.html'), { recursive: true });
  writeFileSync(join(d, MANIFEST_FILE),
    JSON.stringify({ id: 'dir-entry', name: 'x', version: '1.0.0', entry: 'sub.html' }), 'utf8');

  const r = await scanInstalledPlugins(root, { fs });
  t('entry 指向目录 → 主判据拦住并说明「entry 不是文件」',
    r.skipped.some((s) => s.id === 'dir-entry' && s.reason.includes('entry 不是文件')),
    JSON.stringify(r.skipped));
  t('entry 是目录的插件不进 manifests', !r.manifests.some((m) => m.id === 'dir-entry'),
    r.manifests.map((m) => m.id).join(','));
  t('同批正常插件仍被扫出（主判据不拖垮整批）',
    r.manifests.some((m) => m.id === 'healthy'), r.manifests.map((m) => m.id).join(','));

  /* 计数包装：证明四类能力都真的被调用过，不是绕过去返回固定值 */
  const calls = { exists: 0, readdir: 0, readText: 0, isFile: 0 };
  const counted = {};
  for (const k of Object.keys(calls)) {
    counted[k] = async (...a) => { calls[k]++; return fs[k](...a); };
  }
  const r2 = await scanInstalledPlugins(root, { fs: counted });
  t('元断言：注入 fs 的四类能力都真的被调用（防空跑假绿）',
    Object.values(calls).every((n) => n > 0) && r2.manifests.length >= 1,
    JSON.stringify(calls));

  /* readdir 失败必须报出且不影响调用方（不能伪装成空目录） */
  const brokenFs = { ...counted, readdir: async () => { throw new Error('模拟读目录失败'); } };
  const r3 = await scanInstalledPlugins(root, { fs: brokenFs });
  t('readdir 抛错 → errors 一条且 found=0（不崩、不静默）',
    r3.errors.length === 1 && r3.found === 0 && r3.errors[0].includes('读目录失败'),
    JSON.stringify(r3.errors));
}

for (const d of cleanup) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录，清不掉无所谓 */ }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项，跳过 ${skip} 项，告知 ${note} 条`);
process.exit(fail ? 1 : 0);
