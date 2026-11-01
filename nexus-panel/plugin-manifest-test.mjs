/**
 * 可安装插件 manifest 测试
 * ============================================================
 * 为什么要这个测试
 * ------------------------------------------------------------
 * 插件市场这条链上，manifest 是**唯一由插件自己写、宿主拿来就用**
 * 的东西。它的校验一旦空转（判据失效但函数照常返回 ok），后果是：
 *
 *   · 路径穿越的 entry 被接受 → 宿主把插件目录外的文件当入口加载
 *   · 自报 builtin 被采信 → 第三方插件拿到内置豁免（提权）
 *   · id 与内置冲突被接受 → 装一个 id=settings 的插件能顶掉设置页
 *
 * 这三条都不报错、不崩，只有装完才看得见 —— 正是本项目反复防的
 * 「看着在跑、其实没守」。所以本测试的重点不是「正常 manifest 能过」，
 * 而是**每一条判据都确实会拒绝该拒绝的东西**（元断言，见第 3 节）。
 */

import {
  validateManifest, mergeInstalled, MANIFEST_FILE, INSTALLED_PLUGINS_DIR,
  REQUIRED_FIELDS, KINDS,
} from './js/plugin-manifest.js';

let pass = 0, fail = 0, skip = 0, note = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const info = (name, extra = '') => { note++; console.log(`ℹ️ ${name}${extra ? ' → ' + extra : ''}`); };

/** 构造一个最小合法 manifest（各用例在此基础上破坏） */
const okManifest = () => ({
  id: 'my-plugin',
  name: '我的插件',
  version: '1.2.3',
  entry: 'index.html',
});

/* ============================================================
   1. 常量与基本契约
   ============================================================ */
console.log('\n--- 1. 常量 ---');
t('manifest 文件名固定为 nexus.plugin.json', MANIFEST_FILE === 'nexus.plugin.json');
t('已安装目录独立于 runtime-plugins（否则会被构建覆盖）',
  INSTALLED_PLUGINS_DIR !== 'runtime-plugins', INSTALLED_PLUGINS_DIR);
t('必填字段为 id/name/version/entry',
  JSON.stringify(REQUIRED_FIELDS) === JSON.stringify(['id', 'name', 'version', 'entry']));
t('kind 只有 app / service 两种', JSON.stringify(KINDS) === JSON.stringify(['app', 'service']));

/* ============================================================
   2. 正常路径
   ============================================================ */
console.log('\n--- 2. 正常 manifest ---');
{
  const r = validateManifest(okManifest(), { dirName: 'my-plugin' });
  t('最小合法 manifest 通过', r.ok, r.errors.join('; '));
  t('产出 id 正确', r.manifest && r.manifest.id === 'my-plugin');
  t('kind 缺省为 app', r.manifest && r.manifest.kind === 'app');
  t('icon 有兜底（不因缺 icon 拒绝安装）', r.manifest && typeof r.manifest.icon === 'string' && r.manifest.icon.length > 0);
  t('repo / ref 缺省为 null（供更新用）',
    r.manifest && r.manifest.repo === null && r.manifest.ref === null);

  const full = validateManifest({
    ...okManifest(),
    kind: 'service',
    icon: '★',
    description: 'd',
    minHost: '0.2.0',
    repo: 'owner/repo',
    ref: 'v1.2.3',
    homepage: 'https://e.com',
    author: 'a',
    license: 'MIT',
    permissions: ['fs.read', 'net'],
  }, { dirName: 'my-plugin' });
  t('完整 manifest 通过', full.ok, full.errors.join('; '));
  t('kind=service 被接受', full.manifest && full.manifest.kind === 'service');
  t('permissions 原样带出（仅展示用）',
    full.manifest && JSON.stringify(full.manifest.permissions) === JSON.stringify(['fs.read', 'net']));
}

/* ============================================================
   3. 元断言：每条判据都确实会拒绝（防判据空转）
   ------------------------------------------------------------
   这一节是本文件的核心价值。把「必须被拒绝」的样本集中起来，
   逐个跑一遍，断言**全部**被拒绝。
   任何一条判据被清空（或改成恒放行），这里立刻红 ——
   而第 2 节的「正常路径会通过」照样全绿，看不出问题。
   ============================================================ */
console.log('\n--- 3. 元断言：非法样本必须被拒绝 ---');
const MUST_REJECT = [
  ['缺 id', { name: 'n', version: '1.0.0', entry: 'index.html' }],
  ['缺 name', { id: 'a', version: '1.0.0', entry: 'index.html' }],
  ['缺 version', { id: 'a', name: 'n', entry: 'index.html' }],
  ['缺 entry', { id: 'a', name: 'n', version: '1.0.0' }],
  ['id 含大写', { ...okManifest(), id: 'MyPlugin' }],
  ['id 含下划线', { ...okManifest(), id: 'my_plugin' }],
  ['id 含斜杠（路径穿越）', { ...okManifest(), id: 'a/b' }],
  ['id 以横线开头', { ...okManifest(), id: '-abc' }],
  ['id 为空串', { ...okManifest(), id: '' }],
  ['version 非 semver', { ...okManifest(), version: '1.0' }],
  ['version 为 latest', { ...okManifest(), version: 'latest' }],
  ['entry 绝对路径', { ...okManifest(), entry: '/etc/passwd' }],
  ['entry Windows 盘符', { ...okManifest(), entry: 'C:\\x\\index.html' }],
  /*
   * 下面两条都测路径穿越，但**故意用不同扩展名**，原因是一次破坏验证的教训：
   * 起初只有 `../../../etc/passwd` 一条 —— 它不以 .html/.js 结尾，
   * 于是「扩展名判据」也会拒绝它。结果把路径穿越判据整条禁用后，
   * 本测试**仍报 34/0 全绿**：两条判据互相掩盖，谁失效都看不出来。
   *
   * 所以每条判据都需要一个**只被它自己拒绝**的独占样本：
   *   · ../../../evil.html —— 扩展名合法，只有路径穿越判据拦得住
   *   · ../../../etc/passwd —— 顺带覆盖「两条同时命中」的情形
   */
  ['entry 含 .. 且扩展名合法（只有路径穿越判据能拦）', { ...okManifest(), entry: '../../../evil.html' }],
  ['entry 含 ..（路径穿越）', { ...okManifest(), entry: '../../../etc/passwd' }],
  ['entry 为 .tsx（可安装插件一律 iframe）', { ...okManifest(), entry: 'main.tsx' }],
  ['entry 为 .json', { ...okManifest(), entry: 'nexus.plugin.json' }],
  ['kind 非法值', { ...okManifest(), kind: 'module' }],
  ['非对象（数组）', [1, 2, 3]],
  ['非对象（字符串）', 'not-a-manifest'],
  ['null', null],
];
{
  let rejected = 0;
  const notRejected = [];
  for (const [name, obj] of MUST_REJECT) {
    const r = validateManifest(obj);
    if (r.ok) notRejected.push(name);
    else rejected++;
  }
  t(`${MUST_REJECT.length} 个非法样本全部被拒绝`,
    notRejected.length === 0,
    notRejected.length ? `漏网: ${notRejected.join(' / ')}` : `实际拒绝 ${rejected}`);
  info('元断言覆盖的非法样本数', String(MUST_REJECT.length));
}

/* ---- 反向元断言：不能过度拒绝（判据太宽会把合法的全拒）---- */
console.log('\n--- 3b. 反向元断言：合法样本不得被误拒 ---');
const MUST_ACCEPT = [
  ['最小合法', okManifest()],
  ['v 前缀版本', { ...okManifest(), version: 'v2.0.0' }],
  ['预发布版本', { ...okManifest(), version: '1.0.0-beta.1' }],
  ['entry 为 .js', { ...okManifest(), entry: 'main.js' }],
  ['entry 为 .mjs', { ...okManifest(), entry: 'main.mjs' }],
  ['id 含多段横线', { ...okManifest(), id: 'a-b-c-1' }],
  ['id 单字符', { ...okManifest(), id: 'a' }],
];
{
  const wrongly = [];
  for (const [name, obj] of MUST_ACCEPT) {
    const r = validateManifest(obj);
    if (!r.ok) wrongly.push(`${name}(${r.errors.join(',')})`);
  }
  t(`${MUST_ACCEPT.length} 个合法样本全部通过`,
    wrongly.length === 0,
    wrongly.length ? `误拒: ${wrongly.join(' / ')}` : '');
}

/* ============================================================
   4. 安全：信任相关字段一律不采信
   ------------------------------------------------------------
   js/invoke-policy.js:406 的教训：manifest 是插件自己写的，
   恶意插件写 builtin: true 就能拿豁免。所以这里钉两件事：
     ① 自报字段被忽略（只给 warning，不进产出）
     ② 产出对象里**不存在**任何信任相关字段
   ============================================================ */
console.log('\n--- 4. 自报信任字段不采信 ---');
{
  const r = validateManifest({ ...okManifest(), builtin: true, trusted: true, privileged: true });
  t('自报 builtin/trusted/privileged 不导致拒绝（只忽略）', r.ok);
  t('给出忽略提示', r.warnings.length >= 3, r.warnings.join('; '));
  const keys = r.manifest ? Object.keys(r.manifest) : [];
  const leaked = keys.filter((k) => /^(builtin|trusted|privileged|isBuiltin)$/.test(k));
  t('产出不含任何信任相关字段', leaked.length === 0, leaked.join(','));

  /* 元断言：这条检查本身不能空转 ——
     故意造一个「带 builtin 的产出」，确认 keys 过滤认得出。 */
  const probe = { builtin: true, trusted: true, id: 'x' };
  const probeLeak = Object.keys(probe).filter((k) => /^(builtin|trusted|privileged|isBuiltin)$/.test(k));
  t('元断言：信任字段检测确实认得出（非空转）', probeLeak.length === 2, probeLeak.join(','));
}

/* ============================================================
   5. 目录名 / 保留 id 冲突
   ============================================================ */
console.log('\n--- 5. 冲突与一致性 ---');
{
  const r = validateManifest(okManifest(), { dirName: 'other-name' });
  t('目录名与 id 不一致 → 拒绝', !r.ok, r.errors.join('; '));

  const r2 = validateManifest({ ...okManifest(), id: 'settings' }, { reservedIds: ['settings', 'home'] });
  t('id 与内置插件冲突 → 拒绝', !r2.ok, r2.errors.join('; '));

  const r3 = validateManifest(okManifest(), { reservedIds: ['home'] });
  t('id 不与内置冲突 → 通过', r3.ok, r3.errors.join('; '));
}

/* ============================================================
   6. 合并进静态注册表
   ============================================================ */
console.log('\n--- 6. 合并 ---');
{
  const statics = [
    { id: 'home', name: '概览', type: 'module' },
    { id: 'settings', name: '设置', type: 'module' },
  ];
  const m1 = validateManifest(okManifest()).manifest;
  const m2 = validateManifest({ ...okManifest(), id: 'second', name: '第二个', entry: 'a.js', kind: 'service' }).manifest;

  const { plugins, skipped } = mergeInstalled(statics, [m1, m2]);
  t('合并后总数 = 静态 2 + 安装 2', plugins.length === 4, String(plugins.length));
  t('静态插件原样保留', plugins[0].id === 'home' && plugins[1].id === 'settings');
  const inst = plugins.find((p) => p.id === 'my-plugin');
  t('安装插件带 installed:true', inst && inst.installed === true);
  t('安装插件一律 iframe（可安装插件不可能是 module）', inst && inst.type === 'iframe');
  t('安装插件带 version（供更新比对）', inst && inst.version === '1.2.3');
  t('service 形态的 kind 被保留',
    plugins.find((p) => p.id === 'second') && plugins.find((p) => p.id === 'second').kind === 'service');

  /* 冲突：静态优先，不允许顶掉内置 */
  const clash = validateManifest({ ...okManifest(), id: 'settings' }).manifest;
  const r2 = mergeInstalled(statics, [clash]);
  t('与内置 id 冲突时静态优先（总数不变）', r2.plugins.length === 2, String(r2.plugins.length));
  t('冲突项进 skipped 而不是静默丢弃',
    r2.skipped.length === 1 && r2.skipped[0].id === 'settings',
    JSON.stringify(r2.skipped));
  t('内置的 settings 仍是原来那条', r2.plugins.find((p) => p.id === 'settings').name === '设置');

  /* 无效 manifest 不能污染注册表 */
  const r3 = mergeInstalled(statics, [null, {}, { id: '' }]);
  t('无效 manifest 全部进 skipped', r3.plugins.length === 2 && r3.skipped.length === 3,
    `plugins=${r3.plugins.length} skipped=${r3.skipped.length}`);

  /* 不修改入参（调用方可能复用同一个数组） */
  const before = statics.length;
  mergeInstalled(statics, [m1]);
  t('不修改传入的静态数组', statics.length === before);
}

/* ============================================================
   7. 未知字段：前向兼容
   ============================================================ */
console.log('\n--- 7. 未知字段 ---');
{
  const r = validateManifest({ ...okManifest(), futureField: 1 });
  t('未知字段不阻断安装（前向兼容）', r.ok);
  t('未知字段给出提示', r.warnings.some((w) => w.includes('futureField')), r.warnings.join(';'));
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项，跳过 ${skip} 项，告知 ${note} 条`);
process.exit(fail ? 1 : 0);
