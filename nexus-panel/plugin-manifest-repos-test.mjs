#!/usr/bin/env node
/**
 * 插件仓同步通道守卫（离线）
 * ============================================================
 * 守什么
 * ------------------------------------------------------------
 * 12 份 manifest 已随插件源码迁出主仓，交叉一致的取证对象搬到 12 个
 * 独立私有仓。本守卫钉住这条通道的四段，任一段悄悄断掉都会让
 * 「主仓改了 registry → 插件仓清单悄悄漂」表现为无人报错：
 *   ① 断点续跑状态必须落在真实 .git 目录（写错一层时 --fix-state
 *      会先打印 12 条校准行、再 ENOENT 崩掉，输出像成功而一个字节没落盘）
 *   ② 核验/刷新两个运维脚本必须共用同一份状态路径，不许各拼一份
 *   ③ 联网探针必须真的逐字段比独立仓清单，不能只验 repo 一个字段
 *   ④ 派生期望值必须是独立算法，且判据在构造漂移样本上会响
 *
 * 联网探针刻意不登记 npm script（GitHub 不可达会与真实漂移混成同一种红），
 * 所以离线侧由本文件守住它的接线与判据，CI 可跑。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const registry = await import('./plugins/registry.js');
const { repoStatePath } = await import('./scripts/build-plugin-repos.mjs');
const { wantFields, fieldDiffs, repoNameForId } = await import('./scripts/plugin-manifest-fields.mjs');

let pass = 0;
const fails = [];
function t(name, cond, extra) {
  if (cond) pass++;
  else fails.push(name + (extra ? ` — ${extra}` : ''));
}

/* 源码判据只滤掉纯注释行，不新增内联剥注释实现（台账已登记过同类实现）。
   注释里也不原样写被禁的旧写法，免得「注释把断言喂饱」。 */
const codeLines = (f) => readFileSync(join(HERE, f), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

/* ------------------------------------------------------------------ *
 * 1. 断点续跑状态落在真实 git 目录
 * ------------------------------------------------------------------ */
const statePath = repoStatePath();
t('状态路径的父目录真实存在且是 .git 目录',
  existsSync(dirname(statePath)) && statSync(dirname(statePath)).isDirectory()
  && dirname(statePath).endsWith('.git'), statePath);
t('状态路径没有落到 nexus-panel 下一层那个不存在的目录',
  !statePath.includes(join('nexus-panel', '.git')), statePath);

/* ------------------------------------------------------------------ *
 * 2. 两个运维脚本共用同一份路径
 * ------------------------------------------------------------------ */
for (const f of ['scripts/verify-plugin-repos.mjs', 'scripts/refresh-plugin-repos.mjs']) {
  const s = codeLines(f);
  t(`${f}: 用共享的状态路径函数`, /\brepoStatePath\(\)/.test(s));
  t(`${f}: 不再自己拼仓库内状态路径`, !/join\(ROOT,\s*'\.git'/.test(s));
}
const verifySrc = codeLines('scripts/verify-plugin-repos.mjs');
t('核验探针真的逐字段比对独立仓清单',
  /fieldDiffs\(/.test(verifySrc) && /wantFields\(/.test(verifySrc));

/* ------------------------------------------------------------------ *
 * 3. 独立算法与元断言
 * ------------------------------------------------------------------ */
const iframe = registry.plugins.filter((p) => p.type === 'iframe');
t('前提：iframe 插件数为 12', iframe.length === 12, `实为 ${iframe.length}`);
for (const p of iframe) {
  const want = wantFields(p, HERE);
  t(`${p.id}: 派生 entry 不越界、repo 指向独立仓`,
    !!want.entry && !want.entry.startsWith('..')
    && want.repo.endsWith(repoNameForId(p.id)), JSON.stringify(want));
}
{
  const want = wantFields(iframe[0], HERE);
  t('元断言A：一致样本判据返回空（不恒红）', fieldDiffs(want, want).length === 0);
  const d = fieldDiffs({ ...want, name: '被改坏的名字' }, want);
  t('元断言B：名字漂了必须报出（判据不恒真）',
    d.length === 1 && d[0].startsWith('name='), JSON.stringify(d));
  const empty = fieldDiffs({}, want);
  t('元断言C：整份清单缺失必须报满字段数（不空跑假绿）',
    empty.length === Object.keys(want).length, `实报 ${empty.length} / 期望 ${Object.keys(want).length}`);
}

/* ------------------------------------------------------------------ *
 * 4. 登记随对象迁移
 * ------------------------------------------------------------------ */
const pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8'));
t('主仓不再登记已迁出对象的本地清单守卫', !pkg.scripts['test:plugin-manifest-gen']);
t('新离线守卫已登记且指向本文件',
  pkg.scripts['test:plugin-manifest-repos'] === 'node plugin-manifest-repos-test.mjs');

console.log(`通过 ${pass} 项，失败 ${fails.length} 项`);
for (const f of fails) console.error('  ❌ ' + f);
process.exit(fails.length ? 1 : 0);
