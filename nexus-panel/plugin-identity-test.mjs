#!/usr/bin/env node
/**
 * 插件身份登记守卫 —— 防「写了插件却永远不显示 / 登记了却打不开」
 * ============================================================
 * 起因：plugins/store/ 是一个**完整实现**的插件（index.html +
 * index.js 258 行，import 的三个模块都在、有专门的测试守护它的行为），
 * 但 registry.js 里**没有它** —— 于是用户永远看不到，而且不报错。
 *
 * 为什么这类失效最难发现：插件的唯一来源是 `plugins/registry.js` 的
 * `plugins` 数组。少登记一处，插件就是磁盘上的一堆文件；登记了却没有
 * 供给文件，侧边栏有入口、点开是坏页面 —— 两者都不报错，测试还全绿，
 * 于是"有人守着"这个信号本身是假的。
 *
 * ------------------------------------------------------------
 * 退场态（第 38 轮）：12 个 iframe 插件的源码已迁到独立私有仓，主仓
 * 只剩 runtime-plugins/<id>/ 构建产物。原先「每个 registry id 都要有
 * plugins/<id>/ 目录」的判据于是**恒红 12 条** —— 不是插件丢了，是供给
 * 源换了。守卫按 registry 的 `runtime` 标记分流：
 *
 *   · runtime:true  → 必须有 runtime-plugins/<id>/index.html（非空）
 *   · 其余（module）→ 必须有 plugins/<id>/ 目录
 *
 * 两边合起来必须**恰好**等于 registry 的全集（第 0 节的规模断言），
 * 少一个插件、多一个孤儿目录都会红。
 *
 * ⚠️ 分流的依据是 registry 的 `runtime` 标记，**不是**磁盘上 plugins/ 下
 * 有哪些目录。源码迁出后那 12 个目录只剩空壳（0 文件），git 不追踪空目录，
 * 干净 clone 里根本没有、有残留的工作区里却会多出 12 个 —— 拿 dirs.length
 * 当 module 集合，同一条断言会随本地残留漂移（第 38 轮重写时踩过）。
 *
 * 刻意**不**做的：不校验三元 entry 指向的文件是否存在。
 * entry 随模式变（`noBuild ? './plugins/x/index.js' : './plugins/x/module.tsx'`），
 * 静态扫只能拿到两个字符串字面量，而"哪个生效"取决于运行时全局。
 * 但 runtime 插件的 entry 是**单值**，静态可判，第 5 节会真查它指向的
 * 产物文件 —— 退场前这里指向 ./plugins/<id>/index.html（已删），dev 态
 * 由 Vite 的 SPA fallback 返回主外壳 200，iframe 里套整个主面板，不报
 * 404。这一条正是把那类静默断链钉住。
 *
 * 运行：node plugin-identity-test.mjs
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
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
 * 从 registry 源码抽 id。必须剥注释：头部说明里原样写着别的插件名，
 * 不剥会把说明里的名字也当成一条登记（这是真实踩到的）。
 */
function idsOf(src) {
  return [...stripCommentsJs(src).matchAll(/\bid:\s*'([^']+)'/g)].map((m) => m[1]);
}

/**
 * 从 registry 抽 { id, runtime, entry }。
 * 三元 entry（`noBuild ? ... : ...`）刻意抽不到 → entry = null，
 * 因为「哪个生效」要运行时才知道；单值 entry 才参与第 5 节判据。
 */
function entriesOf(src) {
  const out = [];
  for (const b of stripCommentsJs(src).split(/\n  \{\n/)) {
    const id = /\bid:\s*'([^']+)'/.exec(b)?.[1];
    if (!id) continue;
    out.push({
      id,
      runtime: /\bruntime:\s*true\b/.test(b),
      entry: /\bentry:\s*'([^']+)'/.exec(b)?.[1] ?? null,
    });
  }
  return out;
}

/** plugins/ 下的 module 插件目录（文件不算：README-services.md 等）。 */
function dirsOf() {
  return readdirSync(join(HERE, 'plugins'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/** runtime 插件的供给文件存在且非空。 */
function productOk(id) {
  const p = join(HERE, 'runtime-plugins', id, 'index.html');
  return existsSync(p) && statSync(p).size > 0;
}

const regSrc = readFileSync(join(HERE, 'plugins', 'registry.js'), 'utf8');
const dirs = dirsOf();
const ids = idsOf(regSrc);
const entries = entriesOf(regSrc);
const runtimeIds = entries.filter((e) => e.runtime).map((e) => e.id).sort();
const moduleIds = entries.filter((e) => !e.runtime).map((e) => e.id).sort();

/* ------------------------------------------------------------------
 * 第 0 节：扫描本身必须有效（**最要紧的一节**）
 *
 * idsOf / dirsOf / entriesOf 任一失效 → 两边都拿到空集 → 双向差异都是 0 →
 * 下面所有断言**全绿**。这是最危险的失明：判据坏了反而零报告。
 * ---------------------------------------------------------------- */
t('（前置）扫到了 module 插件目录（不是空集）', dirs.length >= 13, `${dirs.length} 个`);
t('（前置）扫到了 registry id（不是空集）', ids.length >= 20, `${ids.length} 个`);
t('（前置）每条 registry 登记都抽到了结构化条目', entries.length === ids.length,
  `${entries.length} vs ${ids.length}`);
/* ⛔ 不能拿 dirs.length 当 module 集合：退场后 plugins/ 下残留的 12 个空
 * 目录让它在「干净 clone = 13」与「有残留 = 25」之间漂移。分流的唯一依据
 * 是 registry 的 runtime 标记，与磁盘状态无关。 */
t('（前置）两类供给合起来恰为 registry 全集（口径没分叉）',
  ids.length === moduleIds.length + runtimeIds.length,
  `registry ${ids.length} = module ${moduleIds.length} + runtime ${runtimeIds.length}`);

/* ------------------------------------------------------------------
 * 第 1 节：目录有、registry 无 —— 插件永不显示
 * ---------------------------------------------------------------- */
const orphanDirs = dirs.filter((d) => !ids.includes(d));
t('每个 module 插件目录都在 registry 里登记了（否则永不显示且不报错）',
  orphanDirs.length === 0,
  orphanDirs.length ? `未登记：${orphanDirs.join(', ')}` : `${dirs.length} 个全登记`);

/* ------------------------------------------------------------------
 * 第 2 节：registry 有、供给无 —— 侧边栏有入口，点开是坏页面
 * ---------------------------------------------------------------- */
const badRuntime = runtimeIds.filter((id) => !productOk(id));
const badModule = moduleIds.filter((id) => !dirs.includes(id));
t('每个 runtime:true 插件都有非空产物 runtime-plugins/<id>/index.html',
  badRuntime.length === 0,
  badRuntime.length ? `缺产物：${badRuntime.join(', ')}` : `${runtimeIds.length} 个全有产物`);
t('每个 module 插件都有 plugins/<id>/ 目录',
  badModule.length === 0,
  badModule.length ? `无目录：${badModule.join(', ')}` : `${moduleIds.length} 个全有目录`);

/* ------------------------------------------------------------------
 * 第 3 节：id 不许重名（重名时后者静默覆盖前者）
 * ---------------------------------------------------------------- */
{
  const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
  t('registry 里 id 不重名（重名则后者静默覆盖前者）',
    dup.length === 0, dup.length ? `重名：${[...new Set(dup)].join(', ')}` : '无重名');
}

/* ------------------------------------------------------------------
 * 第 4 节：module 目录名与 id 逐字节相同（不做归一化）
 * ---------------------------------------------------------------- */
{
  /* runtime 插件的 plugins/<id>/ 是退场后残留的空壳（0 文件），不属于
   * module 供给，不能拿 moduleIds 去要求它逐字节匹配 —— 第 38 轮重写时
   * 正是这么写错的，恒红 1 条。 */
  const stray = dirs.filter((d) => !ids.includes(d));
  t('module 目录名与 id 逐字节相同（不做大小写/空白归一化）',
    moduleIds.every((id) => dirs.includes(id)) && stray.length === 0,
    `module ${moduleIds.length} 个 / 磁盘目录 ${dirs.length} 个（runtime 空壳不计）`);
  /* 退场彻底性：源码侧目录若还在，里面不许再有文件。git 不追踪空目录，
   * 干净 clone 下目录不存在也算通过；一旦有人把旧 index.html 放回去，
   * dev 态的 SPA fallback 套娃会复现，这条立刻报红。 */
  const hasFiles = (d) => {
    if (!existsSync(d)) return false;
    return readdirSync(d, { withFileTypes: true }).some((e) =>
      e.isFile() || hasFiles(join(d, e.name)));
  };
  const leftover = runtimeIds.filter((id) => hasFiles(join(HERE, 'plugins', id)));
  t('runtime 插件源码已退场（plugins/<id>/ 下不留文件）',
    leftover.length === 0,
    leftover.length ? `残留：${leftover.join(', ')}` : `${runtimeIds.length} 个全退场`);
}

/* ------------------------------------------------------------------
 * 第 5 节：runtime 插件的 entry 必须指向真实产物（单值，静态可判）
 * ---------------------------------------------------------------- */
const runtimeEntries = entries.filter((e) => e.runtime && e.entry !== null);
t('12 个 runtime 插件都有单值 entry', runtimeEntries.length === runtimeIds.length,
  `${runtimeEntries.length} / ${runtimeIds.length}`);
t('每个 runtime entry 都指向 ./runtime-plugins/<id>/index.html',
  runtimeEntries.every((e) => e.entry === `./runtime-plugins/${e.id}/index.html`),
  runtimeEntries.filter((e) => e.entry !== `./runtime-plugins/${e.id}/index.html`)
    .map((e) => `${e.id}=${e.entry}`).join(' | '));
t('registry 里不再有指向已退场源码的 index.html entry',
  !/entry:\s*'\.\/plugins\/[^']*\/index\.html'/.test(stripCommentsJs(regSrc)));
t('每个 runtime entry 指向的产物文件真实存在',
  runtimeEntries.every((e) => productOk(e.id)));

/* ------------------------------------------------------------------
 * 第 6 节：判据自身有效性（元断言）
 * ---------------------------------------------------------------- */
{
  const probe = regSrc.replace("id: 'home',", "id: 'home-renamed',");
  const after = idsOf(probe);
  t('（元断言）改掉一个 id → 扫描结果跟着变（抽 id 不是恒等）',
    after.includes('home-renamed') && !after.includes('home'));
  t('（元断言）空文本不得返回任何登记', idsOf('').length === 0 && entriesOf('').length === 0);
  const stripped = regSrc.replace(/\bruntime:\s*true\b/g, 'runtime: false');
  t('（元断言）抹掉 runtime:true 后 runtime 集合为空（分流不是恒真）',
    entriesOf(stripped).filter((e) => e.runtime).length === 0);
  const oldEntry = regSrc.replace(
    "entry: './runtime-plugins/agent-flow/index.html'",
    "entry: './plugins/agent-flow/index.html'");
  const back = entriesOf(oldEntry).find((e) => e.id === 'agent-flow');
  t('（元断言）注入旧死路径 entry → 第 5 节判据会红',
    back && back.entry !== `./runtime-plugins/${back.id}/index.html`);
  t('（元断言）三元 entry 抽不到（不硬判运行时才知的值）',
    entriesOf(regSrc).find((e) => e.id === 'home')?.entry === null);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
if (fail) process.exitCode = 1;
