/**
 * 卸载时用户数据去留策略测试
 * ============================================================
 * 为什么要单独测它
 * ------------------------------------------------------------
 * 这条策略守的是 D3「卸载删代码、保留用户数据、重装可恢复」。
 * 它失效的形状是**完全静默**的：
 *
 *   · 判成"该清" → 用户配置/状态被删，不可恢复，界面上什么都不会报
 *   · 判成"不该清" → 残留数据占空间（可逆，但违背 custom 插件的既有语义）
 *
 * 两个方向都不报错。更麻烦的是：宿主里有**两条**卸载路径，
 * js/host.js 的 removePlugin 与 js/plugin-installer.js 的 uninstallPlugin。
 * 早先前者**无条件清**、后者默认保留 —— 市场插件只要走前者，D3 就被绕过，
 * 且没有任何一处会喊。所以除了测纯函数，还必须有一条**接线断言**：
 * 两条路径**都**真的调用了这个策略（第 4 节 host.js、第 7 节 installer）。
 *
 * 第 7 节为什么必须存在：策略文件自己写着「让两条路径共用同一个结论」，
 * 而此前只有 host.js 接了线，installer 仍用自己那份 `if (p.removeUserData)`
 * —— 于是同一件事两份判据，改一边另一边不跟着变，且不报错。
 * 这类"注释承诺了代码没做的事"必须靠断言钉住，不能靠看注释。
 *
 * ------------------------------------------------------------
 * 元断言的写法：每条判据配一个"只被它决定"的独占样本
 * ------------------------------------------------------------
 * 坏样本若同时踩多条判据，禁掉其中一条后另一条还在挡 → 测试照样绿，
 * 于是"守卫有效"是假的。本项目已经在同一类事情上栽过多次，
 * 所以下面第 3 节的每个样本都刻意只由**一条**判据决定结果。
 */

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { stripCommentsJs } from './test-scan-utils.mjs';
import {
  shouldPurgeDataOnUninstall, normalizeSource, SOURCE_CUSTOM, SOURCE_MARKET,
} from './js/plugin-data-policy.js';

const HERE = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0, skip = 0, note = 0;
const t = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`);
};
const info = (name, extra = '') => { note++; console.log(`ℹ️ ${name}${extra ? ' → ' + extra : ''}`); };

/* ============================================================
   1. 基本组合
   ============================================================ */
console.log('\n--- 1. 基本组合 ---');
{
  t('custom 来源 → 清', shouldPurgeDataOnUninstall({ id: 'custom-1', source: 'custom' }) === true);
  t('market 来源 → 保留', shouldPurgeDataOnUninstall({ id: 'mindmap', source: 'market' }) === false);
  t('来源未知 → 保留（判不准时不多删）', shouldPurgeDataOnUninstall({ id: 'x' }) === false);
  t('显式 removeUserData → 清（来源为 market 也清）',
    shouldPurgeDataOnUninstall({ id: 'mindmap', source: 'market', removeUserData: true }) === true);
  t('同义别名 purgeData → 清',
    shouldPurgeDataOnUninstall({ id: 'mindmap', source: 'market', purgeData: true }) === true);
  t('显式 removeUserData=false 且 market → 保留',
    shouldPurgeDataOnUninstall({ id: 'mindmap', source: 'market', removeUserData: false }) === false);
}

/* ============================================================
   2. 入参边界
   ============================================================ */
console.log('\n--- 2. 入参边界 ---');
{
  t('不传参不崩（返回保留）', shouldPurgeDataOnUninstall() === false);
  t('空对象 → 保留', shouldPurgeDataOnUninstall({}) === false);
  t('null → 保留', shouldPurgeDataOnUninstall(null) === false);
  /* 字符串 'true' 不能当成布尔 true —— 严格 === true 判断 */
  t("removeUserData='true'（字符串）不误判为真",
    shouldPurgeDataOnUninstall({ source: 'market', removeUserData: 'true' }) === false);
  /* 来源大小写/空格容错由 normalizeSource 负责，这里只确认大写不被当成未知 */
  t('source 大写 CUSTOM 由 normalizeSource 归一',
    normalizeSource('CUSTOM') === SOURCE_CUSTOM);
}

/* ============================================================
   3. 元断言：三条判据各自独立成立（独占样本）
   ============================================================
   每个样本只被一条判据决定。任一条判据失效，对应样本立刻红。   */
console.log('\n--- 3. 元断言：独占样本 ---');
{
  /* 判据 A：显式要求删（优先级最高）。
     失效情形：把 removeUserData 判据删掉 → 该样本会落到 market 的"保留"分支。 */
  t('判据A独占：market + removeUserData=true 必须为 true',
    shouldPurgeDataOnUninstall({ source: SOURCE_MARKET, removeUserData: true }) === true,
    '若此项红：说明"显式删"判据失效，会被 market 分支吃掉');

  /* 判据 B：custom → 清。
     失效情形：把 source===custom 判据删掉 → 该样本会落到末尾的"保留"。 */
  t('判据B独占：custom 无显式要求 必须为 true',
    shouldPurgeDataOnUninstall({ source: SOURCE_CUSTOM }) === true,
    '若此项红：说明"custom 清"判据失效，会落到默认保留');

  /* 判据 C：market → 保留。
     失效情形：把 source===market 判据删掉且末尾改成"清" → 该样本变 true。 */
  t('判据C独占：market 无显式要求 必须为 false',
    shouldPurgeDataOnUninstall({ source: SOURCE_MARKET }) === false,
    '若此项红：说明"market 保留"判据失效');

  /* 判据 D：未知来源 → 保留（默认方向）。
     失效情形：把末尾默认改成 return true → 该样本变 true。
     这条最要紧：默认方向反了，所有没写 source 的通道都会多删数据。 */
  t('判据D独占：无任何判据命中时的默认方向 必须为 false（保留）',
    shouldPurgeDataOnUninstall({ id: 'whatever' }) === false,
    '若此项红：默认方向被改成了"清"，未知来源会被不可逆地删数据');
}

/* ============================================================
   4. 接线断言：host.js 真的用了这个策略
   ============================================================
   纯函数全绿而 host.js 继续无条件 clear，整节就是摆设。
   这是"写了新模块但没人用"的孤儿风险，必须钉住。            */
console.log('\n--- 4. 接线断言：host.js ---');
{
  const hostSrc = readFileSync(join(HERE, 'js/host.js'), 'utf8');

  t('host.js import 了 shouldPurgeDataOnUninstall',
    /import\s*\{[^}]*shouldPurgeDataOnUninstall[^}]*\}\s*from\s*'\.\/plugin-data-policy\.js'/.test(hostSrc),
    '若此项红：host.js 没接这个策略，D3 在 removePlugin 这条路上被绕过');

  /* 出现次数：import 里一次 + removePlugin 里一次，至少 2 */
  const hits = (hostSrc.match(/shouldPurgeDataOnUninstall/g) || []).length;
  t('shouldPurgeDataOnUninstall 在 host.js 中至少出现 2 次（导入+使用）',
    hits >= 2, `hits=${hits}`);

  /*
   * 关键：purgePluginStorage 的**调用**必须在策略判断之后 ——
   * 用位置比较钉住"调用被条件包住"。
   *
   * ⚠️ 位置比较必须**只在 removePlugin 函数体内**做：
   * 直接对全文 indexOf('purgePluginStorage(id)') 命中的是 1942 行的
   * **函数定义**（`function purgePluginStorage(id) {`），它天然在
   * removePlugin 之前，于是"调用在策略之后"判成假 —— 这是测试自己
   * 写错的假红，不是代码缺陷。切片后定义不在范围内，比较才成立。
   */
  const iFn = hostSrc.indexOf('async removePlugin(');
  t('找到 removePlugin 函数体', iFn > 0, `iFn=${iFn}`);
  /*
   * 切片后**必须先剥注释再计数**：我在函数注释里写了
   * "早先这里是无条件 purgePluginStorage(id)" 这类说明，
   * 不剥注释会把注释里的字样也数进去（实测 calls=3，而真实调用只有 1 处）——
   * 于是"恰好 1 处"这条断言凭空报红，是测试自己的假红。
   */
  const fnBody = iFn > 0 ? stripCommentsJs(hostSrc.slice(iFn, iFn + 4000)) : '';
  const iPolicy = fnBody.indexOf('shouldPurgeDataOnUninstall({');
  const iPurge = fnBody.indexOf('purgePluginStorage(id)');
  t('removePlugin 内存在策略调用点', iPolicy > 0, `iPolicy=${iPolicy}`);
  t('removePlugin 内存在 purgePluginStorage 调用点', iPurge > 0, `iPurge=${iPurge}`);
  t('清数据的调用确实发生在策略判断之后（被条件包住）',
    iPolicy > 0 && iPurge > iPolicy,
    `iPolicy=${iPolicy} iPurge=${iPurge}`);

  /* 反向：removePlugin 内只能有**一处**清数据调用。
     若有人把无条件清理加回来（或在别处又清一次），计数就会 ≥2。
     注意不能判"是否存在 try{...}catch" —— 被 if 包住的写法里
     try/catch 仍在，那样判会误报。 */
  /*
   * 计数只算**调用**，不算 1967 行的函数定义 —— 定义也落在 4000 字节切片里
   * （`function purgePluginStorage(id) {`），不排除就是 2 处、凭空报红。
   * 这是"扫到的范围比以为的大"：切片按字节数取，会把后面的函数一起圈进来。
   */
  const purgeCalls = (fnBody.match(/(?<!function )purgePluginStorage\(id\)/g) || []).length;
  t('removePlugin 内清数据调用恰好 1 处（无重复的裸清理）',
    purgeCalls === 1, `calls=${purgeCalls}`);

  /* custom 判据必须是"在 custom 列表里"，不能退化成猜 id 前缀 */
  t('host.js 用 custom 列表判定来源（不是猜 id 前缀）',
    /const\s+wasCustom\s*=\s*customs\.some/.test(hostSrc));
  t('host.js 不再按 id 前缀 custom- 猜来源',
    !/String\(id\|\|''\)\.startsWith\('custom-'\)/.test(hostSrc));
}

/* ============================================================
   5. normalizeSource
   ============================================================ */
console.log('\n--- 5. normalizeSource ---');
{
  t('custom → custom', normalizeSource('custom') === SOURCE_CUSTOM);
  t('market → market', normalizeSource('market') === SOURCE_MARKET);
  t('MARKET 大写 → market', normalizeSource('MARKET') === SOURCE_MARKET);
  t('带空格 → 归一', normalizeSource('  market  ') === SOURCE_MARKET);
  t('未知值 → null（不透传）', normalizeSource('markt') === null);
  t('空 → null', normalizeSource('') === null);
  t('null → null', normalizeSource(null) === null);
  t('undefined → null', normalizeSource(undefined) === null);
}

/* ============================================================
   6. 反向：不得误伤（正常样本不该被判成要清）
   ============================================================ */
console.log('\n--- 6. 反向：不得误伤 ---');
{
  const keep = [
    { id: 'mindmap', source: 'market' },
    { id: 'agent-flow', source: 'market' },
    { id: 'task-board', source: 'market' },
    { id: 'some-plugin' },
    { id: 'mcp-tool', source: 'market', removeUserData: false },
  ];
  const wrong = keep.filter((s) => shouldPurgeDataOnUninstall(s) !== false);
  t('市场/未知来源一律保留，无一被误判成要清', wrong.length === 0,
    wrong.length ? `误判=${JSON.stringify(wrong)}` : '');
  info('保留样本数', String(keep.length));
}

/* ============================================================
   7. 两条卸载路径共用同一份判据（installer 侧）
   ============================================================
   判据一律先剥注释：本文件与被测源码里都写着 `shouldPurgeDataOnUninstall`
   这个名字（说明性文字也算匹配），不剥的话"接线断言"会被注释喂饱 ——
   真把调用删掉它也照样绿。本项目已经在同一类事情上栽过多次。 */
console.log('\n--- 7. installer 侧接线 ---');
{
  const instPath = join(HERE, 'js', 'plugin-installer.js');
  const instRaw = readFileSync(instPath, 'utf8');
  const instSrc = stripCommentsJs(instRaw);

  t('installer 真的 import 了这份策略（不是自己再写一份）',
    /from '\.\/plugin-data-policy\.js'/.test(instSrc));
  t('installer 卸载处调用 shouldPurgeDataOnUninstall（而不是裸 removeUserData）',
    /shouldPurgeDataOnUninstall\s*\(\s*\{/.test(instSrc));
  t('installer 不再用裸 `if (p.removeUserData)` 自己判',
    !/if\s*\(\s*p\.removeUserData\s*\)/.test(instSrc));
  t('installer 认 purgeData 别名（两个词都传给策略）',
    /purgeData\s*:\s*p\s*&&\s*p\.purgeData/.test(instSrc));
  t('installer 用 normalizeSource 归一来源（不拿 id 前缀猜）',
    /normalizeSource\s*\(\s*p\s*&&\s*p\.source\s*\)/.test(instSrc));

  /* 元断言：判据本身能分辨"接了线"和"没接线"。
     少了他这一条，把下面任何一条改成恒真都不会被发现。 */
  const fake = "if (p.removeUserData) { rmSync(userDataDir); }";
  t('判据认得出没接线的写法（合成样本：裸 removeUserData 不触发接线断言）',
    !/shouldPurgeDataOnUninstall\s*\(\s*\{/.test(stripCommentsJs(fake)));

  /* 行为层：真跑 uninstallPlugin，确认策略生效（不是只改了源码文本）。
     三个样本各自只由一条判据决定，避免"禁掉一条另一条还在挡"的假绿。 */
  const tmpRoot = join(HERE, '_pdpol_tmp');
  rmSync(tmpRoot, { recursive: true, force: true });
  const codeRoot = join(tmpRoot, 'installed');
  const userRoot = join(tmpRoot, 'userdata');

  const { uninstallPlugin } = await import('./js/plugin-installer.js');
  const run = (params) => {
    /* 每次重建"已安装"的样子：代码目录 + 用户数据目录都在 */
    mkdirSync(join(codeRoot, 'plug-x'), { recursive: true });
    writeFileSync(join(codeRoot, 'plug-x', 'index.js'), 'export default {};');
    writeFileSync(join(codeRoot, 'plug-x', 'nexus.plugin.json'),
      JSON.stringify({ id: 'plug-x', name: 'x', version: '1.0.0' }));
    mkdirSync(join(userRoot, 'plug-x'), { recursive: true });
    writeFileSync(join(userRoot, 'plug-x', 'keep.txt'), 'v');

    const r = uninstallPlugin({
      root: codeRoot,
      id: 'plug-x',
      userDataRoot: userRoot,
      ...params,
    });
    return { r, left: existsSync(join(userRoot, 'plug-x')) };
  };

  /* 前置自检：卸载本身是成功的，否则"数据还在"可能只是因为整体失败
     —— 那样样本 3（要求保留）会假绿、样本 1/2 会假红，三个都不可信。 */
  {
    const { r } = run({ source: 'market' });
    t('前置：uninstallPlugin 本身成功（否则后面三项都不可信）', r.ok === true,
      JSON.stringify(r.errors || []));
  }

  /* 样本 1：只由 purgeData 别名决定 —— 不认别名就会保留 */
  {
    const { left } = run({ purgeData: true });
    t('行为：purgeData=true → 用户数据真被删（别名被认）', left === false);
  }
  /* 样本 2：只由 source=custom 决定 —— 不看来源就会保留 */
  {
    const { left } = run({ source: 'custom' });
    t('行为：custom 来源 → 用户数据真被删（与 host.js 同结论）', left === false);
  }
  /* 样本 3：市场来源 + 无显式要求 → 保留（D3） */
  {
    const { left } = run({ source: 'market' });
    t('行为：市场来源且未要求 → 用户数据保留（D3 不被绕过）', left === true);
  }
  rmSync(tmpRoot, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项，跳过 ${skip} 项，告知 ${note} 条`);
process.exit(fail ? 1 : 0);
