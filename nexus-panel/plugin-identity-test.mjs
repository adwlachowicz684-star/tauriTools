/**
 * 插件身份登记守卫 —— 防「写了插件却永远不显示 / 登记了却打不开」
 * ============================================================
 * 起因：plugins/store/ 是一个**完整实现**的插件（index.html +
 * index.js 258 行，import 的三个模块都在、有专门的测试守护它的行为），
 * 但 registry.js 里**没有它** —— 于是用户永远看不到，而且不报错。
 *
 * 为什么这类失效最难发现：
 *
 *   插件的唯一来源是 `plugins/registry.js` 的 `plugins` 数组
 *   （js/host.js:254 是全仓唯一的加载点）。少登记一处，
 *   插件就是磁盘上的一堆文件 —— 不显示、不报错、不占地方，
 *   也不会有人想起它。它的测试还在跑、还全绿，
 *   于是"有人守着"这个信号本身是假的。
 *
 * 两个方向都要盯：
 *
 *   ① 目录有、registry 无 → 插件永不显示（本次发现的 store）
 *   ② registry 有、目录无 → 侧边栏有入口，点开 404
 *
 * ------------------------------------------------------------
 * 刻意**不**做的：不校验 entry 指向的文件是否存在。
 *
 * entry 随模式变（`noBuild ? './plugins/x/index.js' : './plugins/x/module.tsx'`），
 * 静态扫只能拿到两个字符串字面量，而"哪个生效"取决于运行时全局。
 * 硬判会逼出一张随模式切换的白名单，白名单越长守卫越瞎 ——
 * 这与之前否掉的「族判据」「全仓不许重复函数体」是同一个死法。
 * 真要守，该在加载失败的路径上做（运行时能拿到实际取的哪一个）。
 *
 * 运行：node plugin-identity-test.mjs
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsJs } from './test-scan-utils.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
let pass = 0; let fail = 0;
const t = (name, ok, info) => {
  if (ok) { pass++; console.log(`✅ ${name}${info ? ` → ${info}` : ''}`); }
  else { fail++; console.log(`❌ ${name}${info ? ` → ${info}` : ''}`); }
};

/**
 * 从 registry 源码抽 id。
 *
 * 必须剥注释后再匹配：registry.js 的头部说明里原样写着别的插件名，
 * 不剥会把说明里的名字也当成一条登记（这是本轮真实踩到的）。
 */
function idsOf(src) {
  return [...stripCommentsJs(src).matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]);
}

/** plugins/ 下的插件目录（文件不算：README-services.md、registry.js 等）。 */
function dirsOf() {
  return readdirSync(join(HERE, 'plugins'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

const regSrc = readFileSync(join(HERE, 'plugins', 'registry.js'), 'utf8');
const dirs = dirsOf();
const ids = idsOf(regSrc);

/* ------------------------------------------------------------------
 * 第 0 节：扫描本身必须有效（**最要紧的一节**）
 *
 * idsOf / dirsOf 任一失效 → 两边都拿到空集 → 双向差异都是 0 →
 * 下面所有断言**全绿**。这是最危险的失明：判据坏了反而零报告。
 * 所以先钉规模，再谈比对。
 * ---------------------------------------------------------------- */
t('（前置）扫到了插件目录（不是空集）', dirs.length >= 20, `${dirs.length} 个`);
t('（前置）扫到了 registry id（不是空集）', ids.length >= 20, `${ids.length} 个`);
t('（前置）两个规模在同一量级（扫描口径没分叉）',
  Math.abs(dirs.length - ids.length) <= 3, `${dirs.length} vs ${ids.length}`);

/* 探针：真实源码里摘掉一个 id，扫描必须报「registry 有、目录无」的反面
   —— 即它必须真的从结果里消失。抽不出来的话后面全是恒真。 */
{
  const probe = regSrc.replace("id: 'home',", "id: 'home-renamed',");
  const after = idsOf(probe);
  t('（探针）改掉一个 id → 扫描结果跟着变（抽 id 不是恒等）',
    after.includes('home-renamed') && !after.includes('home'));
}

/* ------------------------------------------------------------------
 * 第 1 节：目录有、registry 无 —— 插件永不显示
 * ---------------------------------------------------------------- */
const orphanDirs = dirs.filter((d) => !ids.includes(d));
t('每个插件目录都在 registry 里登记了（否则永不显示且不报错）',
  orphanDirs.length === 0, orphanDirs.length ? `未登记：${orphanDirs.join(', ')}` : `${dirs.length} 个全登记`);

/* ------------------------------------------------------------------
 * 第 2 节：registry 有、目录无 —— 侧边栏有入口，点开 404
 * ---------------------------------------------------------------- */
const orphanIds = ids.filter((i) => !dirs.includes(i));
t('每个 registry id 都有对应目录（否则点开就 404）',
  orphanIds.length === 0, orphanIds.length ? `无目录：${orphanIds.join(', ')}` : `${ids.length} 个全有目录`);

/* ------------------------------------------------------------------
 * 第 3 节：id 不许重名
 *
 * 重名时后者覆盖前者（宿主按 id 建索引），先登记的插件静默消失。
 * 这也是"两份都对、合起来坏"的那一类。
 * ---------------------------------------------------------------- */
{
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  t('registry 里 id 不重名（重名则后者静默覆盖前者）',
    dup.length === 0, dup.length ? `重名：${[...new Set(dup)].join(', ')}` : '无重名');
}

/* ------------------------------------------------------------------
 * 第 4 节：id 形态
 *
 * 目录名与 id 必须是同一个字符串 —— 这里靠"同名字典序相等"来钉。
 * （上一节已经双向比过了，这一节钉的是"比较用的是原样字符串"，
 *   防止哪天有人加了 trim/toLowerCase 之后两边悄悄对不上。）
 * ---------------------------------------------------------------- */
{
  const set = new Set(ids);
  t('目录名与 id 逐字节相同（不做大小写/空白归一化）',
    dirs.filter((d) => set.has(d)).length === Math.min(dirs.length, ids.length));
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exitCode = 1;
