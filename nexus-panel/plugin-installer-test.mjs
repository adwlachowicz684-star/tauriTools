/**
 * 插件安装器测试
 * ============================================================
 * 用**真实临时目录**（不用 mock fs）
 * ------------------------------------------------------------
 * 本模块最要紧的失效形状是「文件写到了插件目录外面」——
 * mock 文件系统测不出这类问题（它连真实路径分隔符都不走）。
 * 所以这里真建目录、真写文件、真去目标目录外查有没有被写到。
 *
 * 元断言（第 9 节）是本文件的重点
 * ------------------------------------------------------------
 * 「没写出界」既可能是「守卫拦住了」，也可能是「压根没执行到」。
 * 必须靠「构造一个必然越界的输入，断言它**真的被判为越界**」来区分。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import {
  sniffArchive, normalizeRelPath, safeJoin, commonRootDir,
  extractEntries, verifyPluginDir, installPlugin,
  uninstallPlan, uninstallPlugin, STAGING_PREFIX, BACKUP_PREFIX,
} from './js/plugin-installer.js';
import { MANIFEST_FILE } from './js/plugin-manifest.js';

let pass = 0, fail = 0, skip = 0, note = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const info = (name, extra = '') => { note++; console.log(`ℹ️ ${name}${extra ? ' → ' + extra : ''}`); };

const cleanup = [];
function fresh(tag) { const d = mkdtempSync(join(tmpdir(), `nx-inst-${tag}-`)); cleanup.push(d); return d; }

/** 一个能通过校验的最小插件条目集 */
function goodEntries(id = 'demo', version = '1.0.0') {
  return [
    { name: `${id}-${version}/${MANIFEST_FILE}`, content: JSON.stringify({ id, name: `插件 ${id}`, version, entry: 'index.html', kind: 'app' }) },
    { name: `${id}-${version}/index.html`, content: `<html>${id}</html>` },
  ];
}

/* ============================================================
   1. 归档识别
   ============================================================ */
console.log('\n--- 1. 归档识别（看魔数，不看扩展名）---');
{
  t('gzip 魔数识别', sniffArchive(Buffer.from([0x1f, 0x8b, 0x08])) === 'gzip');
  t('zip 魔数识别', sniffArchive(Buffer.from([0x50, 0x4b, 0x03, 0x04])) === 'zip');
  t('伪装成 .tar.gz 的 HTML 不认', sniffArchive(Buffer.from('<html>')) === null);
  t('太短的输入不认', sniffArchive(Buffer.from([0x1f])) === null);
  t('空输入不认', sniffArchive(null) === null);
}

/* ============================================================
   2. 条目名归一化（安全关键）
   ============================================================ */
console.log('\n--- 2. 条目名归一化 ---');
{
  /* 每条拒绝理由都要有**独占样本**：只被这一条拦住，别的判据拦不住。
   * 否则判据互相掩护，坏掉一条测试照样绿（阶段 1 教训）。 */
  const cases = [
    ['../../../evil.html', '路径穿越', '..'],          // 扩展名合法 → 只有穿越判据拦得住
    ['/etc/passwd.html', '绝对路径', '绝对路径'],       // 扩展名合法
    ['C:\\evil.html', '盘符绝对路径', '盘符'],          // 扩展名合法
    ['a\\b.html', '反斜杠归一化为目录分隔符', null],
    ['a/./b.html', '含 . 段', '.'],
    ['a/../../evil.html', '中间穿越', '..'],
    ['', '空名', '非空字符串'],
    ['bad\0name.html', '含 NUL', 'NUL'],
  ];
  for (const [input, label, must] of cases) {
    const r = normalizeRelPath(input);
    if (must) {
      t(`${label} 被拒`, r.unsafe !== null && r.rel === null, String(r.unsafe));
      t(`${label} 的理由含「${must}」`, String(r.unsafe).includes(must), String(r.unsafe));
    } else if (label.includes('反斜杠')) {
      t('反斜杠被归一化为 /', r.rel === 'a/b.html', String(r.rel));
    } else {
      t(`${label} 被拒`, r.unsafe !== null, String(r.unsafe));
    }
  }
  t('正常相对名放行', normalizeRelPath('assets/app.js').rel === 'assets/app.js');
  t('前导 ./ 被去掉', normalizeRelPath('./index.html').rel === 'index.html');
  t('目录条目被标记 isDir', normalizeRelPath('assets/').isDir === true);
}

/* ============================================================
   3. safeJoin
   ============================================================ */
console.log('\n--- 3. safeJoin（越界返回 null）---');
{
  const root = '/data/plugins';
  t('正常相对路径放行', safeJoin(root, 'demo/index.html') === resolve(root, 'demo/index.html'));
  t('.. 越界返回 null', safeJoin(root, '../evil') === null);
  t('根目录自身允许', safeJoin(root, '.') === resolve(root));
  t('同名前缀目录不算在里面', safeJoin('/data/plugins', '../plugins-foo/x') === null);
  t('空 rel 返回 null', safeJoin(root, '') === null);
  t('非字符串 rel 返回 null', safeJoin(root, null) === null);
}

/* ============================================================
   4. commonRootDir
   ============================================================ */
console.log('\n--- 4. 公共顶层目录 ---');
{
  t('全在同一顶层目录下 → 返回它', commonRootDir(['a/b', 'a/c/d']) === 'a');
  t('顶层不同 → null', commonRootDir(['a/b', 'c/d']) === null);
  t('顶层是文件（单段）→ null', commonRootDir(['index.html']) === null);
  t('混有顶层文件 → null', commonRootDir(['a/b', 'index.html']) === null);
  t('空数组 → null', commonRootDir([]) === null);
  t('非数组 → null', commonRootDir(null) === null);
}

/* ============================================================
   5. 条目落盘（含脱壳与越界拦截）
   ============================================================ */
console.log('\n--- 5. 条目落盘 ---');
{
  const dest = join(fresh('ex'), 'out');
  /* 故意把 dest 放在一个「外面」能查的父目录里，便于验证没写出界 */
  const outside = resolve(dirname(dest), 'OUTSIDE.txt');

  const r = extractEntries([
    ...goodEntries('demo', '1.0.0'),
    { name: 'demo-1.0.0/assets/app.js', content: 'console.log(1)' },
    { name: '../OUTSIDE.txt', content: 'PWNED' },
    { name: '/abs.html', content: 'x' },
  ], dest);

  t('脱掉公共顶层目录', r.files.includes('index.html'), r.files.join(','));
  t('子目录文件也落盘', r.files.includes('assets/app.js'));
  t('manifest 落盘', r.files.includes(MANIFEST_FILE));
  const trav = r.skipped.find((s) => String(s.reason).includes('路径穿越'));
  t('越界条目被记原因（不是静默丢）', !!trav, JSON.stringify(r.skipped));
  t('越界条目真的没写到外面', !existsSync(outside));
  const absSkipped = r.skipped.find((s) => String(s.reason).includes('绝对路径'));
  t('绝对路径条目被拒', !!absSkipped);
  t('落盘后 index.html 内容正确', readFileSync(join(dest, 'index.html'), 'utf8').includes('demo'));
}

/* ============================================================
   6. 落盘后校验
   ============================================================ */
console.log('\n--- 6. verifyPluginDir ---');
{
  const base = fresh('vf');
  const ok = join(base, 'ok');
  mkdirSync(ok, { recursive: true });
  writeFileSync(join(ok, MANIFEST_FILE), JSON.stringify({ id: 'ok', name: 'x', version: '1.0.0', entry: 'index.html' }));
  writeFileSync(join(ok, 'index.html'), '<html></html>');
  t('完整插件校验通过', verifyPluginDir(ok).ok === true);

  const noEntry = join(base, 'noentry');
  mkdirSync(noEntry, { recursive: true });
  writeFileSync(join(noEntry, MANIFEST_FILE), JSON.stringify({ id: 'noentry', name: 'x', version: '1.0.0', entry: 'index.html' }));
  const v2 = verifyPluginDir(noEntry);
  t('manifest 漂亮但 entry 不存在 → 不通过', v2.ok === false);
  t('且原因为「entry 文件不存在」', v2.errors.some((e) => e.includes('entry 文件不存在')), v2.errors.join(';'));
  /* 这条独占：manifest 本身合法，只有「entry 真存在」这条拦得住 */

  const badJson = join(base, 'badjson');
  mkdirSync(badJson, { recursive: true });
  writeFileSync(join(badJson, MANIFEST_FILE), '{ nope');
  t('manifest 不是合法 JSON → 不通过', verifyPluginDir(badJson).ok === false);

  const mismatch = join(base, 'mismatch');
  mkdirSync(mismatch, { recursive: true });
  writeFileSync(join(mismatch, MANIFEST_FILE), JSON.stringify({ id: 'other', name: 'x', version: '1.0.0', entry: 'index.html' }));
  writeFileSync(join(mismatch, 'index.html'), 'x');
  t('目录名与 id 不一致 → 不通过（防顶替）', verifyPluginDir(mismatch).ok === false);

  t('目录不存在 → 不通过', verifyPluginDir(join(base, 'nope')).ok === false);
}

/* ============================================================
   7. 原子安装（含失败回滚）
   ============================================================ */
console.log('\n--- 7. 原子安装 ---');
{
  const root = fresh('inst');

  const r1 = installPlugin({ root, id: 'demo', entries: goodEntries('demo', '1.0.0') });
  t('首次安装成功', r1.ok === true, r1.errors.join(';'));
  t('版本被读出', r1.version === '1.0.0', String(r1.version));
  t('replaced=false（首次）', r1.replaced === false);
  t('落盘在 root/<id>', existsSync(join(root, 'demo', 'index.html')));

  const r2 = installPlugin({ root, id: 'demo', entries: goodEntries('demo', '2.0.0') });
  t('覆盖安装成功', r2.ok === true, r2.errors.join(';'));
  t('replaced=true（覆盖）', r2.replaced === true);
  t('内容已更新为 2.0.0', readFileSync(join(root, 'demo', MANIFEST_FILE), 'utf8').includes('2.0.0'));

  /* --- 失败回滚：装一个坏包，旧版本必须原样还在 --- */
  const r3 = installPlugin({
    root, id: 'demo',
    entries: [{ name: 'demo-3.0.0/index.html', content: 'x' }],  // 缺 manifest
  });
  t('坏包安装失败', r3.ok === false, r3.errors.join(';'));
  t('失败后旧版本仍在（回滚生效）', existsSync(join(root, 'demo', MANIFEST_FILE)));
  t('失败后旧版本仍是 2.0.0', readFileSync(join(root, 'demo', MANIFEST_FILE), 'utf8').includes('2.0.0'));
  t('失败后 index.html 仍在', existsSync(join(root, 'demo', 'index.html')));

  /* --- 暂存/备份目录不能残留（残留会被扫描器当插件）--- */
  const leftovers = [];
  try {
    for (const d of readdirSync(root)) {
      if (d.startsWith(STAGING_PREFIX) || d.startsWith(BACKUP_PREFIX)) leftovers.push(d);
    }
  } catch { /* 读不到就算了 */ }
  t('暂存/备份目录无残留', leftovers.length === 0, leftovers.join(','));

  /* --- manifest.id 与安装 id 不一致必须拒 --- */
  const r4 = installPlugin({
    root, id: 'demo',
    entries: [{
      name: `other-1.0.0/${MANIFEST_FILE}`,
      content: JSON.stringify({ id: 'other', name: 'x', version: '1.0.0', entry: 'index.html' }),
    }, { name: 'other-1.0.0/index.html', content: 'x' }],
  });
  t('manifest.id 与安装 id 不一致 → 拒', r4.ok === false, r4.errors.join(';'));

  /* --- id 不合法 --- */
  t('id 含斜杠 → 拒', installPlugin({ root, id: '../evil', entries: [] }).ok === false);
  t('id 为空 → 拒', installPlugin({ root, id: '', entries: [] }).ok === false);

  /* --- 与内置插件 id 冲突 --- */
  const r5 = installPlugin({ root, id: 'settings', entries: goodEntries('settings', '1.0.0'), reservedIds: ['settings'] });
  t('与内置 id 冲突 → 拒（防顶掉设置页）', r5.ok === false, r5.errors.join(';'));
}

/* ============================================================
   8. 卸载：删代码、留数据
   ============================================================ */
console.log('\n--- 8. 卸载 ---');
{
  const root = fresh('uni');
  const userRoot = fresh('udata');
  installPlugin({ root, id: 'demo', entries: goodEntries('demo', '1.0.0') });
  mkdirSync(join(userRoot, 'demo'), { recursive: true });
  writeFileSync(join(userRoot, 'demo', 'cfg.json'), '{"theme":"dark"}');

  const plan = uninstallPlan({ root, id: 'demo', userDataRoot: userRoot });
  t('计划报告 ok', plan.ok === true);
  t('计划列出代码目录', plan.willRemove.length === 1);
  t('计划列出会保留的用户数据', plan.willKeep.length === 1);
  t('计划统计出文件数', plan.fileCount >= 2, String(plan.fileCount));
  t('计划是只读的（执行前目录还在）', existsSync(join(root, 'demo')));

  const u = uninstallPlugin({ root, id: 'demo', userDataRoot: userRoot });
  t('卸载成功', u.ok === true, u.errors.join(';'));
  t('代码目录被删', !existsSync(join(root, 'demo')));
  t('用户数据被保留（默认）', existsSync(join(userRoot, 'demo', 'cfg.json')));
  t('kept 里记了用户数据', u.kept.length === 1);

  /* 显式要求才删数据 */
  installPlugin({ root, id: 'demo', entries: goodEntries('demo', '1.0.0') });
  const u2 = uninstallPlugin({ root, id: 'demo', userDataRoot: userRoot, removeUserData: true });
  t('显式 removeUserData 才删数据', !existsSync(join(userRoot, 'demo')), u2.errors.join(';'));

  t('未安装的插件卸载 → 不通过', uninstallPlugin({ root, id: 'nope' }).ok === false);
  t('id 越界 → 拒', uninstallPlugin({ root, id: '../..' }).ok === false);
}

/* ============================================================
   9. 元断言：判据失效时会被抓到
   ============================================================ */
console.log('\n--- 9. 元断言（守卫不能空转）---');
{
  /* 这些样本必须**真的被判为越界**，否则说明 normalizeRelPath 整条失效了
   * —— 那时「没写出界」只是因为压根没走到，不是守卫起作用。 */
  const mustReject = ['../../../evil.html', '/abs.html', 'C:\\evil.html', 'a/../../x.html'];
  const rejected = mustReject.filter((n) => normalizeRelPath(n).unsafe !== null);
  t('4 个越界样本全被判为越界（守卫没空转）', rejected.length === mustReject.length,
    `${rejected.length}/${mustReject.length}`);

  const mustPass = ['index.html', 'assets/app.js', './a/b.html'];
  const passed = mustPass.filter((n) => normalizeRelPath(n).rel !== null);
  t('正常样本全被放行（守卫没变成「什么都拒」）', passed.length === mustPass.length,
    `${passed.length}/${mustPass.length}`);

  /* safeJoin 的两个方向都要成立 */
  t('safeJoin 能拒绝（不恒放行）', safeJoin('/r', '../x') === null);
  t('safeJoin 能放行（不恒拒绝）', safeJoin('/r', 'a/b') === resolve('/r', 'a/b'));
}

for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }); } catch { /* 临时目录 */ } }

console.log(`\n通过 ${pass} 项，失败 ${fail} 项，跳过 ${skip} 项，告知 ${note} 条`);
process.exit(fail ? 1 : 0);
