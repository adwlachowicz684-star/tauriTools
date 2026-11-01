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

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, MANIFEST_FILE } from './js/plugin-manifest.js';
import { scanInstalledPlugins } from './js/installed-plugin-scan.js';

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
 * 2. 每个 iframe 插件都有 manifest，且能通过校验
 * ------------------------------------------------------------------ */
const parsed = new Map();
for (const p of iframe) {
  const dir = join(PLUGINS, p.id);
  const file = join(dir, MANIFEST_FILE);
  if (!existsSync(file)) {
    t(`${p.id}: 有 manifest`, false, '文件不存在');
    continue;
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    t(`${p.id}: manifest 可解析`, false, String(e.message || e));
    continue;
  }
  /* dirName 传目录名 —— 目录名必须等于 id，防顶替 */
  const r = validateManifest(raw, { dirName: p.id });
  t(`${p.id}: manifest 通过校验`, r.ok, r.errors.join('; '));
  if (r.ok) parsed.set(p.id, { raw, m: r.manifest });
}
t('12 份 manifest 全部解析成功', parsed.size === 12, `实为 ${parsed.size}`);

/* ------------------------------------------------------------------ *
 * 3. 与 registry 交叉一致（本守卫的核心）
 * ------------------------------------------------------------------ */
for (const p of iframe) {
  const got = parsed.get(p.id);
  if (!got) continue;
  const { m } = got;
  t(`${p.id}: id 与 registry 一致`, m.id === p.id, `${m.id} != ${p.id}`);
  t(`${p.id}: name 与 registry 一致`, m.name === p.name, `manifest=${m.name} registry=${p.name}`);
  t(`${p.id}: icon 与 registry 一致`, m.icon === (p.icon || '◻'), `manifest=${m.icon} registry=${p.icon}`);
  t(`${p.id}: kind 与 registry 一致`, m.kind === (p.kind || 'app'), `manifest=${m.kind} registry=${p.kind || 'app'}`);
  /* registry 的 entry 是相对项目根，manifest 的必须相对插件目录 */
  const wantEntry = p.entry.replace(/^\.\//, '').split('/').slice(2).join('/');
  t(`${p.id}: entry 与 registry 同源`, m.entry === wantEntry, `manifest=${m.entry} 期望=${wantEntry}`);
  t(`${p.id}: entry 文件真实存在`, existsSync(join(PLUGINS, p.id, m.entry)), m.entry);
}

/* ------------------------------------------------------------------ *
 * 4. 扫描器能在真实目录上把它们全找出来（端到端接线）
 * ------------------------------------------------------------------ */
const scan = scanInstalledPlugins(PLUGINS, { reservedIds: [] });
const foundIds = new Set(scan.manifests.map((m) => m.id));
for (const p of iframe) {
  t(`扫描能发现 ${p.id}`, foundIds.has(p.id), '未在 manifests 中');
}
t('扫描发现的 manifest 数恰为 12', scan.manifests.length === 12, `实为 ${scan.manifests.length}`);
t('扫描无目录级错误', scan.errors.length === 0, scan.errors.join('; '));

/* module 插件一律不发 manifest：发了就是"能装"的空头支票（D4） */
const skippedIds = new Set(scan.skipped.map((s) => s.id));
for (const p of modules) {
  t(`module 插件 ${p.id} 不应有 manifest`, skippedIds.has(p.id), '但它被扫描器当成有效插件了');
}
t('被跳过的都是"缺 manifest"（不是解析失败/entry 缺失等真问题）',
  scan.skipped.every((s) => s.reason.includes('缺少')),
  scan.skipped.filter((s) => !s.reason.includes('缺少')).map((s) => `${s.id}:${s.reason}`).join(' | '));

/* ------------------------------------------------------------------ *
 * 5. 元断言：一致性判据不能恒真
 * ------------------------------------------------------------------ */
{
  const tmp = join(HERE, '.tmp-manifest-sync');
  rmSync(tmp, { recursive: true, force: true });

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

  rmSync(tmp, { recursive: true, force: true });
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
 * 手工字段（repo / ref / author / license / minHost / permissions）
 * **只存在于 manifest 文件里** —— registry 里没有，重算不出来。
 * 旧写法在 JSON 解析失败时 keep 为空、直接按模板重写，
 * 于是拆仓库时填好的 repo 被一次生成抹掉，而脚本只打印
 * 「✅ 已生成/刷新 12 份」、退出码 0 —— 静默且不可逆。
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
    /* 桩 registry：形状与真 registry 一致（entry 相对项目根） */
    writeFileSync(join(tmp, 'plugins', 'registry.js'),
      "export const plugins = [{ id: 'fx', name: 'FX', type: 'iframe', entry: './plugins/fx/index.html', icon: '◆', kind: 'app', description: 'fixture' }];\n");
    writeFileSync(join(tmp, 'plugins', 'fx', 'index.html'), '<html></html>\n');
    const mf = join(tmp, 'plugins', 'fx', MANIFEST_FILE);
    const script = join(tmp, 'scripts', 'gen-plugin-manifest.mjs');

    /* A：正常文件 —— 手工字段必须还在（基线：保留机制本身是好的） */
    writeFileSync(mf, JSON.stringify({
      id: 'fx', name: 'FX', version: '0.1.0', entry: 'index.html',
      kind: 'app', icon: '◆', description: 'fixture',
      repo: 'git@x/fx.git', author: 'me', license: 'MIT',
    }, null, 2) + '\n');
    execFileSync(process.execPath, [script], { stdio: 'pipe' });
    const afterA = JSON.parse(readFileSync(mf, 'utf8'));
    t('生成器：正常 manifest 的手工字段被保留',
      afterA.repo === 'git@x/fx.git' && afterA.author === 'me' && afterA.license === 'MIT',
      JSON.stringify(afterA));

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
      !asTemplate.includes('git@x') && String(afterA.repo).includes('git@x'),
      '元断言空跑 → 第 7 节假绿');

    /* C：缺文件 —— 仍要正常新建（别因为加了拒绝逻辑就建不出来了） */
    rmSync(mf);
    execFileSync(process.execPath, [script], { stdio: 'pipe' });
    t('生成器：缺 manifest 时正常新建',
      existsSync(mf) && JSON.parse(readFileSync(mf, 'utf8')).id === 'fx',
      '新建失败 → 拒绝逻辑写宽了');
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
