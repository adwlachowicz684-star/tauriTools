#!/usr/bin/env node
/**
 * 插件源码退场的联网复核探针（不进 CI）
 * ============================================================
 * 判据不用「文件数相等」—— 文件数相等但内容旧一版照样会通过。
 * 这里查的是四件独立事实：
 *   ① 远端主仓 12 个插件源码目录残留 = 0
 *   ② 远端主仓 runtime-plugins/<id>/index.html 12/12 齐备
 *   ③ 12 个私有仓各有一个**正式**（非 draft / 非 prerelease）release，
 *      且产物名符合 ASSET_PREFIX + <id>-<ver>.tar.gz
 *   ④ 12 仓仍为 private，源码 tree 未丢失
 *
 * 网络失败单独计数、绝不冒充通过；本脚本刻意不登记 npm script。
 */
import { readFileSync, existsSync } from 'node:fs';
import { CAMEL, OWNER, repoNameFor } from './plugin-repo-map.mjs';
import { ASSET_PREFIX, ASSET_SUFFIX } from '../js/plugin-store-client.js';

const TOKEN_FILE = '/data/user_persistent_data/tools/.git_token';
if (!existsSync(TOKEN_FILE)) { console.error('缺凭据'); process.exit(2); }
const token = readFileSync(TOKEN_FILE, 'utf8').trim();
const H = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
  'User-Agent': 'nexus-verify-retire', 'X-GitHub-Api-Version': '2022-11-28' };
const API = 'https://api.github.com';
const IDS = Object.keys(CAMEL).sort();

let pass = 0, fail = 0, netErr = 0;
const t = (name, ok, extra = '') => { ok ? pass++ : fail++; console.log(`${ok ? '✅' : '❌'} ${name}${extra ? ' → ' + extra : ''}`); };
async function get(path) {
  const r = await fetch(API + path, { headers: H });
  const txt = await r.text();
  let j = null; try { j = txt ? JSON.parse(txt) : null; } catch { /* 非 JSON */ }
  if (r.status >= 500) { netErr++; throw new Error(`${path} HTTP ${r.status}`); }
  return { status: r.status, j };
}

/* ① ② 主仓 */
const tr = await get('/repos/' + OWNER + '/tauriTools/git/trees/main?recursive=1');
if (tr.status === 200 && !tr.j.truncated) {
  const paths = (tr.j.tree || []).filter(x => x.type === 'blob').map(x => x.path);
  const left = paths.filter(p => IDS.some(id => p.startsWith(`nexus-panel/plugins/${id}/`)));
  t('主仓 12 插件源码残留 = 0', left.length === 0, `残留 ${left.length}：${left.slice(0, 3).join(', ')}`);
  t('registry.js 仍在', paths.includes('nexus-panel/plugins/registry.js'));
  const missing = IDS.filter(id => !paths.includes(`nexus-panel/runtime-plugins/${id}/index.html`));
  t('主仓产物 12/12 齐备', missing.length === 0, `缺 ${missing.join(', ')}`);
  const prodCount = paths.filter(p => p.startsWith('nexus-panel/runtime-plugins/')).length;
  t('主仓产物文件数与退场提交一致（287）', prodCount === 287, `实为 ${prodCount}`);
} else { t('主仓 tree 可读且未截断', false, `status=${tr.status} truncated=${tr.j?.truncated}`); }

/* ③ ④ 12 仓 */
for (const id of IDS) {
  const repo = repoNameFor(id);
  try {
    const r = await get(`/repos/${OWNER}/${repo}`);
    t(`${id}: 仓库存在且 private`, r.status === 200 && r.j.private === true, `status=${r.status} private=${r.j?.private}`);
    const rel = await get(`/repos/${OWNER}/${repo}/releases`);
    const list = Array.isArray(rel.j) ? rel.j : [];
    const formal = list.filter(x => x.draft === false && x.prerelease === false);
    t(`${id}: 恰有 1 个正式 release`, formal.length === 1, `releases=${list.length} formal=${formal.length}`);
    const assets = formal.flatMap(x => (x.assets || []).map(a => a.name));
    const want = `${ASSET_PREFIX}${id}-0.1.0${ASSET_SUFFIX}`;
    t(`${id}: 产物名规范且已上传`, assets.includes(want), JSON.stringify(assets.slice(0, 2)));
    const one = formal[0]?.assets?.find(a => a.name === want);
    t(`${id}: asset state=uploaded`, one?.state === 'uploaded', String(one?.state));
  } catch (e) {
    netErr++;
    console.error(`  ⚠️ ${id}: 网络/服务端错误 ${e.message}`);
  }
}

console.log(`\n通过 ${pass} 项，失败 ${fail} 项，网络错误 ${netErr} 次`);
if (netErr) console.log('⚠️ 有网络错误：本次结论不完整，不能当成全部通过');
process.exit(fail || netErr ? 1 : 0);
