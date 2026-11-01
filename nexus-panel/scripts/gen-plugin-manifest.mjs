/**
 * 生成 / 刷新各插件的 nexus.plugin.json
 * ============================================================
 * 用法： node scripts/gen-plugin-manifest.mjs [--check]
 *        --check  只比对不写盘（不一致时退出码 1），供守卫与 CI 用
 *
 * 为什么要有这个脚本
 * ------------------------------------------------------------
 * 插件要拆成独立仓库（阶段 7），每个仓库自带一份 manifest。
 * 若手写 12 份，registry.js 与 manifest 迟早漂移：
 *   改了 registry 里的 name/icon/kind，manifest 还是旧的
 *   → 拆出去的仓库与主仓库表现不一致，且**没有任何检查会发现**。
 * 所以 id / name / icon / kind / description / entry 一律**从 registry 派生**，
 * 不由人手写。
 *
 * 哪些字段手工维护（脚本不会覆盖）
 * ------------------------------------------------------------
 *   version / repo / ref / homepage / author / license / minHost / permissions
 * 这些与 registry 无关（registry 里根本没有），属于"仓库自己的事"。
 * 脚本保留文件里已有的值 —— 否则拆仓库时填好的 repo 会被一次生成抹掉。
 *
 * ⚠️ 只给 type: 'iframe' 的插件生成
 * ------------------------------------------------------------
 * 可安装插件一律 iframe（决策 D4）：module 形态靠 import.meta.glob
 * 在**编译期**收进产物，装进来也不会被发现。给 module 插件发 manifest
 * 等于发一张"能装"的空头支票。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PLUGINS = join(ROOT, 'plugins');

/** 手工维护、脚本保留的字段 */
const HAND_KEYS = ['version', 'repo', 'ref', 'homepage', 'author', 'license', 'minHost', 'permissions'];

/** 由 registry 派生的字段（顺序固定，便于 diff） */
const DERIVED_KEYS = ['id', 'name', 'version', 'entry', 'kind', 'icon', 'description'];

const registry = await import('../plugins/registry.js');

function derive(p) {
  return {
    id: p.id,
    name: p.name,
    /* 默认起始版本：拆仓库后由各仓库自己 bump（脚本保留已有值） */
    version: '0.1.0',
    /* registry 的 entry 是 './plugins/<id>/index.html' 这种相对项目根的路径，
     * manifest 的 entry 必须是**相对插件目录** —— 装进来后目录位置会变。 */
    entry: relative(join(PLUGINS, p.id), join(ROOT, p.entry)).split('\\').join('/'),
    kind: p.kind || 'app',
    icon: p.icon || '◻',
    description: p.description || '',
  };
}

/** 按固定顺序拼文本：派生字段在前，手工字段在后（便于 diff） */
function buildText(keep, want) {
  const next = {};
  for (const k of DERIVED_KEYS) next[k] = k === 'version' && keep.version ? keep.version : want[k];
  for (const k of HAND_KEYS) if (keep[k] !== undefined) next[k] = keep[k];
  return JSON.stringify(next, null, 2) + '\n';
}

/**
 * 单个 manifest 的写盘决策（纯函数，不碰文件系统，便于测试）
 *
 * ⛔ 存在但解析失败 → 一律不写盘
 * ------------------------------------------------------------
 * 手工字段（repo / ref / author / license / minHost / permissions）
 * **只存在于 manifest 文件里** —— registry 里根本没有，重算不出来。
 * 解析失败时 keep 为空，按模板重写就等于把拆仓库时填好的 repo
 * 一次性抹掉，而脚本只打印「✅ 已生成 12 份」，一句提示都没有。
 * 这正是文件头那句「脚本保留已有的值」承诺不了的情况。
 *
 * 所以：坏文件不写、报出来、退出码非 0，让人先修好 JSON。
 *
 * @param {string|null} existingText  现有文件内容；null 表示文件不存在
 * @param {object} want              由 registry 派生的字段
 * @returns {{write:boolean, fatal:string|null, text:string|null}}
 */
function planWrite(existingText, want) {
  if (existingText === null) {
    return { write: true, fatal: null, text: buildText({}, want) };
  }
  let cur;
  try {
    cur = JSON.parse(existingText);
  } catch {
    return {
      write: false,
      fatal: '现有 manifest 解析失败，已跳过（手工字段不可重建，拒绝覆盖）',
      text: null,
    };
  }
  const keep = {};
  for (const k of HAND_KEYS) if (cur[k] !== undefined) keep[k] = cur[k];
  return { write: true, fatal: null, text: buildText(keep, want) };
}

const targets = registry.plugins.filter((p) => p.type === 'iframe');
const check = process.argv.includes('--check');

const diffs = [];
const fatals = [];
const notes = [];
for (const p of targets) {
  const dir = join(PLUGINS, p.id);
  const file = join(dir, 'nexus.plugin.json');
  const want = derive(p);

  const existingText = existsSync(file) ? readFileSync(file, 'utf8') : null;

  if (check) {
    if (existingText === null) {
      diffs.push(`${p.id}: 缺少 manifest`);
      continue;
    }
    const plan = planWrite(existingText, want);
    if (plan.fatal) {
      diffs.push(`${p.id}: ${plan.fatal}`);
      continue;
    }
    if (existingText !== plan.text) diffs.push(`${p.id}: 与 registry 派生结果不一致`);
    continue;
  }

  const plan = planWrite(existingText, want);
  if (plan.fatal) {
    fatals.push(`${p.id}: ${plan.fatal}`);
    continue;
  }
  if (existingText === null || existingText !== plan.text) {
    writeFileSync(file, plan.text);
    notes.push(`${p.id}: ${existingText === null ? '新建' : '刷新'}`);
  }
}

if (check && diffs.length) {
  console.error(`❌ 共 ${diffs.length} 处不一致：`);
  for (const d of diffs) console.error('  · ' + d);
  process.exit(1);
}
if (!check) {
  /* ⛔ 坏文件必须报出来：静默重写会把手工字段一次性抹掉，
   *    而那些字段只存在于 manifest 里，重算不出来。 */
  if (fatals.length) {
    console.error(`❌ 共 ${fatals.length} 份 manifest 未写出（手工字段不可重建，拒绝覆盖）：`);
    for (const f of fatals) console.error('  · ' + f);
    console.error('  修好 JSON 后重跑本脚本。');
    process.exit(1);
  }
  console.log(`✅ 已生成/刷新 ${targets.length} 份 manifest（${join('plugins', '<id>', 'nexus.plugin.json')}）`);
  for (const n of notes) console.log('  · ' + n);
}
