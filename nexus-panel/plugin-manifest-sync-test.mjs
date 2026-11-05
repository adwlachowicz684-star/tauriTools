/**
 * manifest ↔ registry 一致性守卫
 * ============================================================
 * 守什么
 * ------------------------------------------------------------
 * 12 个可安装（iframe）插件各带一份 nexus.plugin.json。
 * id / name / icon / kind / description / entry 与 plugins/registry.js
 * **同源**，由 scripts/gen-plugin-manifest.mjs 从 registry 派生。
 *
 * 插件拆成独立仓库后（阶段 7），两份分居两个仓库。此时若只改了
 * registry 的 name/icon/kind 而 manifest 没跟着改 ——
 * 界面表现为「同一个插件两边名字/图标不同」，而**没有任何检查会发现**：
 * 两边各自都合法，只是不一致。
 *
 * 所以本守卫钉的是**交叉一致**，不是各自合法。
 *
 * ⚠️ 为什么必须自己比对，不能只跑一遍生成器 --check
 * ------------------------------------------------------------
 * 只用生成器比对 = 拿生成器的输出验生成器自己 —— 生成器逻辑写错时
 * 两边一起错，测试照样绿（本项目反复栽的「自己验自己」）。
 * 所以本文件**独立**从 registry 读出期望值再比，与生成器互不依赖。
 *
 * 元断言的必要性
 * ------------------------------------------------------------
 * 一致性判据一旦写坏（恒真），本节会整节假绿且永不报。
 * 因此第 5、6 节用构造样本反证：故意制造不一致，判据必须喊。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, MANIFEST_FILE } from './js/plugin-manifest.js';
import { scanInstalledPlugins } from './js/installed-plugin-scan.js';
import { IDS, isRetired, sourceResidue, makeFixture } from './scripts/retired-guard-baseline.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS = join(HERE, 'plugins');

let pass = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else fails.push(name + (extra ? ` — ${extra}` : ''));
}

const registry = await import('./plugins/registry.js');
const iframe = registry.plugins.filter((p) => p.type === 'iframe');
const modules = registry.plugins.filter((p) => p.type !== 'iframe');

/* ------------------------------------------------------------------ *
 * 1. 前提：派生目标集合本身没跑偏
 * ------------------------------------------------------------------ */
t('前提：iframe 插件数为 12（集合变了本节就失去意义）', iframe.length === 12, `实为 ${iframe.length}`);

/* ------------------------------------------------------------------ *
 * 2. 退场态：manifest 的权威已迁到 12 个独立仓
 * ------------------------------------------------------------------
 * 旧形态下这里逐份读 plugins/<id>/nexus.plugin.json、与 registry 交叉比对。
 * 源码迁出后那 12 份文件整体消失，旧判据变成 26 条永久红 —— 留着等于
 * 「防线还在、但永远不会响」。各仓里的 manifest 由联网探针
 * scripts/verify-plugin-repos.mjs 逐文件核对（不进 CI，网络故障单独判）。
 *
 * 主仓侧真正要钉的是「registry 与唯一映射表没有各走各的」：
 * id 集合漂了，探针查的仓、产物目录、registry entry 会同时错位，
 * 而没有任何一处报错。
 */
t('退场态：主仓 12 个插件源码目录均已迁出', isRetired(HERE),
  sourceResidue(HERE).join(', '));
const sortedIframe = iframe.map((p) => p.id).sort();
t('映射表 12 个 id 与 registry iframe 集合一致',
  JSON.stringify(IDS) === JSON.stringify(sortedIframe),
  `映射表=${IDS.join(',')} registry=${sortedIframe.join(',')}`);
for (const p of iframe) {
  t(`${p.id}: 运行时产物入口存在`,
    existsSync(join(HERE, 'runtime-plugins', p.id, 'index.html')),
    '产物缺失 → 装了也打不开，且不报错');
}

/* ------------------------------------------------------------------ *
 * 3. 扫描器仍需可用（判据不能因为退场就空跑）
 * ------------------------------------------------------------------ */
const scan = scanInstalledPlugins(PLUGINS, { reservedIds: [] });
t('主仓空插件目录扫出 0 份 manifest', scan.manifests.length === 0, `实为 ${scan.manifests.length}`);
t('主仓空插件目录无目录级错误', scan.errors.length === 0, scan.errors.join('; '));
{
  const fx = makeFixture();
  try {
    const s2 = scanInstalledPlugins(join(fx.root, 'plugins'), { reservedIds: [] });
    t('元断言H：扫描器在 fixture 上仍能发现 manifest（判据没失效）',
      s2.manifests.length >= 1 && s2.manifests.some((m) => m.id === fx.a),
      `实得 ${s2.manifests.length} 份`);
  } finally { fx.cleanup(); }
}

/* 防双份权威：主仓现存插件目录里不许再冒出 manifest。
   旧断言「skipped 都是缺 manifest」在空集合上 every 恒真 —— 那是假绿，
   不是防线。 */
const leftovers = readdirSync(PLUGINS, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(PLUGINS, e.name, MANIFEST_FILE)))
  .map((e) => e.name);
t('主仓现存插件目录里没有残留 manifest（防双份权威）',
  leftovers.length === 0, leftovers.join(', '));
t('主仓现存目录数不为 0（读取本身没失效）',
  readdirSync(PLUGINS, { withFileTypes: true }).filter((e) => e.isDirectory()).length > 0,
  '一个目录都没读到 → 上面那条会假绿');

/* ------------------------------------------------------------------ *
 * 5. 元断言：一致性判据不能恒真
 * ------------------------------------------------------------------ */
{
  /* ⛔ 临时产物目录不许写死在项目里：
     测试若被 502 打断，残留的 .tmp-* 会被 scope 判成 LOCAL_ONLY 噪声，
     还可能被 installed-plugin-scan 当成候选插件目录扫进去。
     用系统临时目录 + mkdtemp，进程被杀也不污染工作树。 */
  const tmp = mkdtempSync(join(tmpdir(), 'manifest-sync-'));
  try {

  /* A：目录名叫 agent-flow，manifest 却自称 ghost —— 顶替场景，必须拒 */
  mkdirSync(join(tmp, 'agent-flow'), { recursive: true });
  writeFileSync(join(tmp, 'agent-flow', MANIFEST_FILE), JSON.stringify({
    id: 'ghost', name: '幽灵', version: '1.0.0', entry: '../evil.html', kind: 'app',
  }, null, 2));
  const r1 = validateManifest(
    JSON.parse(readFileSync(join(tmp, 'agent-flow', MANIFEST_FILE), 'utf8')),
    { dirName: 'agent-flow' },
  );
  t('元断言A：目录名与 id 不一致必须被拒', !r1.ok, '判据恒真 → 防顶替失效');

  /* B：id 合法但 name 与 registry 不同 —— 校验放过，交叉比对必须抓到 */
  const r2 = validateManifest(
    { id: 'agent-flow', name: '被改坏的名字', version: '1.0.0', entry: 'index.html', kind: 'app' },
    { dirName: 'agent-flow' },
  );
  const regName = registry.plugins.find((p) => p.id === 'agent-flow').name;
  t('元断言B：name 交叉比对能认出改坏的名字',
    !(r2.ok && r2.manifest.name === regName),
    `判据恒真（registry=${regName}）`);

  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * 6. 元断言：校验必须真在跑（缺字段要拒）
 * ------------------------------------------------------------------ */
{
  const r = validateManifest({ name: 'x', version: '1.0.0', entry: 'index.html' }, { dirName: 'x' });
  t('元断言C：缺 id 必须被拒', !r.ok, '校验恒真 → 第 2 节假绿');
  const r2 = validateManifest({ id: 'x', name: 'x', version: '1.0.0', entry: '../escape.html' }, { dirName: 'x' });
  t('元断言D：entry 路径穿越必须被拒', !r2.ok, '校验恒真');
}

/* ------------------------------------------------------------------ *
 * 7. 生成器：存在但解析失败的 manifest 不得被重写
 * ------------------------------------------------------------------
 *
 * 守什么
 * ------------------------------------------------------------------
 * 手工字段（ref / author / license / minHost / permissions）
 * **只存在于 manifest 文件里** —— registry 里没有，重算不出来。
 * 旧写法在 JSON 解析失败时 keep 为空、直接按模板重写，
 * 于是拆仓库时填好的发布元信息被一次生成抹掉，而脚本只打印
 * 「✅ 已生成/刷新 12 份」、退出码 0 —— 静默且不可逆。
 * （repo 已改由映射表派生，不再属于手工字段，见第 7 节 A。）
 *
 * 为什么用子进程跑真脚本
 * ------------------------------------------------------------------
 * 要验的是"到底有没有写盘"，不是"函数返回什么"。
 * 所以造一棵 fixture 树（真脚本 + 桩 registry），实跑、比字节。
 * ------------------------------------------------------------------ */
{
  const tmp = join(tmpdir(), 'genmanifest-' + process.pid);
  rmSync(tmp, { recursive: true, force: true });
  try {
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    mkdirSync(join(tmp, 'plugins', 'fx'), { recursive: true });
    copyFileSync(join(HERE, 'scripts', 'gen-plugin-manifest.mjs'),
      join(tmp, 'scripts', 'gen-plugin-manifest.mjs'));
    /* 生成器静态 import ./plugin-repo-map.mjs。fixture 的插件 id 是 'fx'，
     * 不在真映射表里（真表对未登记 id 是 fail-closed 抛错），所以放一个桩
     * 映射源：既让生成器跑得起来，又顺带验证「repo 来自映射源，
     * 不是从 manifest 里保留下来的」。 */
    writeFileSync(join(tmp, 'scripts', 'plugin-repo-map.mjs'),
      "export function repoFieldFor() { return 'stub-owner/fixtureRepo'; }\n");
    /* 桩 registry：形状与真 registry 一致（entry 相对项目根） */
    writeFileSync(join(tmp, 'plugins', 'registry.js'),
      "export const plugins = [{ id: 'fx', name: 'FX', type: 'iframe', entry: './plugins/fx/index.html', icon: '◆', kind: 'app', description: 'fixture' }];\n");
    writeFileSync(join(tmp, 'plugins', 'fx', 'index.html'), '<html></html>\n');
    const mf = join(tmp, 'plugins', 'fx', MANIFEST_FILE);
    const script = join(tmp, 'scripts', 'gen-plugin-manifest.mjs');

    /* A：正常文件 —— 手工字段保留；repo 由映射源纠正（它已不是手工字段）。
     * 故意写一个旧 repo，若生成器还把 repo 当手工字段保留，这里就会留着旧值。 */
    writeFileSync(mf, JSON.stringify({
      id: 'fx', name: 'FX', version: '0.1.0', entry: 'index.html',
      kind: 'app', icon: '◆', description: 'fixture',
      repo: 'git@x/fx.git', author: 'me', license: 'MIT',
    }, null, 2) + '\n');
    execFileSync(process.execPath, [script], { stdio: 'pipe' });
    const afterA = JSON.parse(readFileSync(mf, 'utf8'));
    t('生成器：repo 由映射源派生，旧值被纠正',
      afterA.repo === 'stub-owner/fixtureRepo', JSON.stringify(afterA));
    t('生成器：正常 manifest 的其它手工字段被保留',
      afterA.author === 'me' && afterA.license === 'MIT', JSON.stringify(afterA));
    t('元断言F：repo 判据不是恒真（旧值与桩值确实不同）',
      'git@x/fx.git' !== 'stub-owner/fixtureRepo' && afterA.repo !== 'git@x/fx.git',
      '判据空跑 → 上一条会假绿');

    /* B：坏文件 —— 不得写盘，且必须报出来 */
    const BROKEN = '{ "id": "fx", "repo": 坏掉了\n';
    writeFileSync(mf, BROKEN);
    let code = 0;
    let out = '';
    try {
      out = execFileSync(process.execPath, [script], { stdio: 'pipe', encoding: 'utf8' });
    } catch (e) {
      code = e.status === undefined ? -1 : e.status;
      out = String((e.stdout || '') + (e.stderr || ''));
    }
    t('生成器：坏 manifest 退出码非 0', code !== 0, `实为 ${code}`);
    t('生成器：坏 manifest 被报出来', out.includes('解析失败'), out.slice(0, 120));
    t('生成器：坏 manifest 未被重写（字节原样）',
      readFileSync(mf, 'utf8') === BROKEN, '被覆盖了 → 手工字段已丢失');

    /* 元断言E：证明"按模板重写"真的会丢字段 —— 否则 B 的三条无从谈起 */
    const asTemplate = JSON.stringify({
      id: afterA.id, name: afterA.name, version: '0.1.0', entry: afterA.entry,
      kind: afterA.kind, icon: afterA.icon, description: afterA.description,
    }, null, 2) + '\n';
    t('元断言E：旧写法（解析失败即按模板重写）确实会丢手工字段',
      !asTemplate.includes('"author"') && afterA.author === 'me',
      '元断言空跑 → 第 7 节假绿');

    /* C：缺文件 —— 仍要正常新建（别因为加了拒绝逻辑就建不出来了） */
    rmSync(mf);
    execFileSync(process.execPath, [script], { stdio: 'pipe' });
    const made = existsSync(mf) ? JSON.parse(readFileSync(mf, 'utf8')) : {};
    t('生成器：缺 manifest 时正常新建',
      made.id === 'fx', '新建失败 → 拒绝逻辑写宽了');
    t('生成器：新建的 manifest 也带派生 repo',
      made.repo === 'stub-owner/fixtureRepo', JSON.stringify(made));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */
console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
for (const f of fails) console.error('  ❌ ' + f);
process.exit(fails.length ? 1 : 0);
