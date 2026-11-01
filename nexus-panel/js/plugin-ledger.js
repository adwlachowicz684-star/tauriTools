/**
 * 安装台账（阶段 3 · 更新）
 * ============================================================
 * 记录「已装的插件是从哪来的、当时装的是哪一版」，并据此判断有没有新版。
 *
 * 与前后模块的分工
 * ------------------------------------------------------------
 *   plugin-installer.js  —— 落盘（解压 / 校验 / 原子替换 / 删除）
 *   plugin-store-client.js —— 取 release、挑产物、比较版本
 *   **本文件**            —— 记住「装了什么」，并回答「有没有新版」
 *
 *   本文件**不执行更新**（只报告），这是决策 D6：
 *   不自动更新 —— 自动更新的供应链风险不可接受。
 *
 * ⚠️ 三条实测依据（决定了下面的写法，改之前先看）
 * ------------------------------------------------------------
 * 1. **release.target_commitish 不一定是 commit sha。**
 *    实测 5 个公开仓库：tauri / bun / vite 是 40 位 sha，
 *    而 **vscode 与 svelte 是字符串 "main"**。
 *    → 直接把它当指纹存，在这些仓库上存进去的是 "main"，
 *      于是指纹永不变化、更新检测**静默漏报**。
 *    所以本文件用 isSha() 判定，不是 sha 就**不采信**。
 *
 * 2. **真正的 sha 要另取**：`/repos/{o}/{r}/commits/{ref}`。
 *    实测该接口对存在的 tag 返回 40 位 sha；
 *    对**不存在的 ref 返回 422 而不是 404**（fetchRefSha 因此要把 422 当失败）。
 *
 * 3. **产物指纹比版本指纹更可靠。**
 *    同一个 tag 的产物被重新上传（GitHub 允许替换 asset）时：
 *    版本号不变、页面上看不出变化，但**内容已经不是同一个包了**。
 *    只记版本会漏掉这类变更；所以台账同时记产物指纹
 *    （asset.id + size + updated_at）。
 *
 * ⚠️ 台账损坏时不静默丢弃
 * ------------------------------------------------------------
 * 台账丢了 = 不知道从哪装的 = 更新功能整体失效。
 * 更糟的是「静默当空台账」会让界面显示「未安装」，
 * 用户再装一次就会覆盖掉已有的用户数据。
 * 所以解析失败时：**先把坏文件备份留证，再返回空台账并置 corrupted 标记**。
 */

import { readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { API_BASE, parseRepoInput, compareVersion, pickAsset, fetchRelease } from './plugin-store-client.js';

/** 台账文件名（点开头：扫描器只认子目录，不会把它当插件） */
export const LEDGER_FILE = '.nexus-installed.json';
/** 台账结构版本 —— 将来改结构时用它判断能不能读 */
export const LEDGER_VERSION = 1;

/* ------------------------------------------------------------------ *
 * 1. 指纹
 * ------------------------------------------------------------------ */

/**
 * 是否 40 位 commit sha。
 *
 * 为什么不能「看起来像就行」：
 *   release.target_commitish 实测可能是 "main"（见文件头依据 1）。
 *   拿 "main" 当 sha 存进去，比对时永远相等 → 更新检测静默失效。
 */
export function isSha(s) {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

/**
 * 产物指纹 —— 真正装到磁盘上的那个文件的指纹。
 *
 * 用 asset.id + size + updated_at 三元组：
 *   · id        —— 产物被替换后 GitHub 会换 id
 *   · size      —— 内容变了大小大概率变
 *   · updated_at—— 重新上传会更新它
 * 三者结合才能覆盖「同 tag 重传产物」这个场景（依据 3）。
 * 缺任一字段则整个指纹为 null —— **不猜**，缺了就说不知道。
 */
export function assetFingerprint(asset) {
  if (!asset || typeof asset !== 'object') return null;
  const id = asset.id;
  const size = asset.size;
  const upd = asset.updated_at || asset.updatedAt;
  if (id == null || size == null || !upd) return null;
  return `asset:${id}:${size}:${upd}`;
}

/** 比较两个指纹是否相同（任一为 null = 无法判断，返回 null 而非 false） */
export function sameFingerprint(a, b) {
  if (!a || !b) return null;
  return a === b;
}

/* ------------------------------------------------------------------ *
 * 2. 台账读写
 * ------------------------------------------------------------------ */

/** 空台账 */
export function emptyLedger() {
  return { version: LEDGER_VERSION, plugins: {} };
}

/**
 * 校验并归一化单条记录。
 *
 * @returns {{ok:boolean, entry:object|null, errors:string[]}}
 *
 * 只保留**宿主自己写得出来的字段**：
 * 凡是插件自报的东西（name / permissions / description）一律不进台账。
 * 台账是「我从哪装的」，不是「它说它是什么」。
 */
export function normalizeEntry(e) {
  const errors = [];
  if (!e || typeof e !== 'object') return { ok: false, entry: null, errors: ['记录不是对象'] };
  const id = e.id;
  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    return { ok: false, entry: null, errors: ['id 不合法'] };
  }

  /* source 只有两态 —— 刻意不做第三态。
   *
   * 曾经分过 market / custom / local 三态，结果 'local' 没有明确用途：
   * 内置插件压根不进台账（它们不经过安装流程），
   * 于是 'local' 成了永远走不到的死分支 —— 死分支的下场是被后人当成
   * 「这里还有第三种来源」去处理，凭空长出不该有的逻辑。
   *
   * 真正需要的区分只有一条：**有没有仓库来源**。
   *   有 → 能查更新、能重新下载（market）
   *   无 → 只能手工重装，卸载时按 custom 处理（custom）
   */
  const src = e.repo ? 'market' : 'custom';
  const entry = {
    id,
    source: src,
    version: typeof e.version === 'string' && e.version ? e.version : null,
    repo: null,
    ref: typeof e.ref === 'string' && e.ref ? e.ref : null,
    sha: isSha(e.sha) ? e.sha : null,
    fingerprint: typeof e.fingerprint === 'string' && e.fingerprint ? e.fingerprint : null,
    installedAt: typeof e.installedAt === 'string' ? e.installedAt : null,
    updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : null,
  };

  if (e.repo && typeof e.repo === 'object') {
    const p = parseRepoInput(`${e.repo.owner || ''}/${e.repo.repo || ''}`);
    if (!p) errors.push('repo 字段不合法（只记录，不阻断）');
    else entry.repo = { owner: p.owner, repo: p.repo };
  }

  /* sha 给了但不是 sha → 明确记下来，别让它悄悄变成 null 而无人知晓 */
  if (e.sha && !isSha(e.sha)) errors.push(`sha 不是 40 位 commit sha（已忽略）: ${String(e.sha).slice(0, 24)}`);
  return { ok: true, entry, errors };
}

/**
 * 读台账。
 *
 * @returns {{ledger:object, corrupted:boolean, backup:string|null, errors:string[]}}
 *
 * 三种情况必须区分开：
 *   · 文件不存在 —— 正常态（还没装过），**不是错误**
 *   · 解析失败   —— 备份原文件后返回空台账（不静默丢弃，见文件头）
 *   · 读得出     —— 校验结构，逐条归一化，坏条目跳过但记下来
 */
export function readLedger(file) {
  const errors = [];
  if (!file || typeof file !== 'string') return { ledger: emptyLedger(), corrupted: false, backup: null, errors: ['未指定台账路径'] };
  if (!existsSync(file)) return { ledger: emptyLedger(), corrupted: false, backup: null, errors: [] };

  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    const backup = `${file}.corrupt-${randomBytes(4).toString('hex')}`;
    try { renameSync(file, backup); } catch { /* 备份失败也要继续，不能卡住启动 */ }
    errors.push(`台账解析失败（原文件已备份）: ${String((e && e.message) || e)}`);
    return { ledger: emptyLedger(), corrupted: true, backup, errors };
  }

  const out = emptyLedger();
  if (!raw || typeof raw !== 'object' || !raw.plugins || typeof raw.plugins !== 'object') {
    const backup = `${file}.corrupt-${randomBytes(4).toString('hex')}`;
    try { renameSync(file, backup); } catch { /* 同上 */ }
    errors.push('台账结构不对（缺少 plugins 对象，原文件已备份）');
    return { ledger: out, corrupted: true, backup, errors };
  }

  for (const [k, v] of Object.entries(raw.plugins)) {
    const n = normalizeEntry(Object.assign({ id: k }, v));
    if (!n.ok) { errors.push(`台账条目 ${k} 无效，已跳过: ${n.errors.join('; ')}`); continue; }
    /* key 与 entry.id 不一致时以 key 为准（key 是目录名，installer 校验过） */
    out.plugins[k] = n.entry;
    if (n.errors.length) errors.push(`台账条目 ${k}: ${n.errors.join('; ')}`);
  }
  return { ledger: out, corrupted: false, backup: null, errors };
}

/**
 * 写台账（原子：先落临时文件再 rename）。
 *
 * 为什么必须原子：台账写一半进程被杀（沙盒里真实发生过），
 * 下次读到的是截断的 JSON —— 那正是上面 readLedger 要兜的情况。
 * 用 rename 保证「要么整份在，要么整份不在」。
 */
export function writeLedger(file, ledger) {
  if (!file || typeof file !== 'string') return { ok: false, error: '未指定台账路径' };
  const data = ledger && typeof ledger === 'object' ? ledger : emptyLedger();
  const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`;
  try {
    writeFileSync(tmp, JSON.stringify(Object.assign({ version: LEDGER_VERSION }, data), null, 2));
    renameSync(tmp, file);
    return { ok: true, error: null };
  } catch (e) {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败不影响报错 */ }
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ------------------------------------------------------------------ *
 * 3. 变更记录（纯函数，返回新台账）
 * ------------------------------------------------------------------ */

/** 取某条记录（没有返回 null） */
export function getEntry(ledger, id) {
  const l = ledger && ledger.plugins ? ledger : emptyLedger();
  const e = l.plugins[id];
  return e || null;
}

/**
 * 记录一次安装 / 更新。
 *
 * @param {object} ledger
 * @param {object} info {id, version, repo:{owner,repo}, ref, sha, asset, at}
 * @returns {{ledger:object, entry:object|null, errors:string[], warnings:string[]}}
 */
export function recordInstall(ledger, info) {
  const base = ledger && ledger.plugins ? ledger : emptyLedger();
  const warnings = [];
  const now = (info && info.at) || new Date().toISOString();

  const raw = {
    id: info && info.id,
    source: (info && info.repo) ? 'market' : 'custom',
    version: (info && info.version) || null,
    repo: (info && info.repo) || null,
    ref: (info && info.ref) || null,
    sha: (info && info.sha) || null,
    fingerprint: assetFingerprint(info && info.asset),
    installedAt: null,
    updatedAt: now,
  };

  const n = normalizeEntry(raw);
  if (!n.ok) return { ledger: base, entry: null, errors: n.errors, warnings };

  const prev = base.plugins[n.entry.id];
  /* 首次安装保留 installedAt；更新时不改它，只刷 updatedAt */
  n.entry.installedAt = prev && prev.installedAt ? prev.installedAt : now;
  if (prev) {
    const oldFp = prev.fingerprint, newFp = n.entry.fingerprint;
    if (oldFp && newFp && oldFp !== newFp) {
      /* 版本没变但产物变了 —— 同 tag 重传，必须说出来（依据 3） */
      if (prev.version === n.entry.version) {
        warnings.push(`版本 ${prev.version} 未变，但产物内容已变化（可能重新上传过）`);
      }
    }
    if (!oldFp || !newFp) warnings.push('缺少产物指纹，无法判断内容是否变化');
  }

  const out = { version: LEDGER_VERSION, plugins: Object.assign({}, base.plugins, { [n.entry.id]: n.entry }) };
  return { ledger: out, entry: n.entry, errors: [], warnings };
}

/** 移除一条记录（卸载后调用；用户数据不在台账里，不受影响） */
export function recordUninstall(ledger, id) {
  const base = ledger && ledger.plugins ? ledger : emptyLedger();
  if (!base.plugins[id]) return { ledger: base, removed: false };
  const plugins = Object.assign({}, base.plugins);
  delete plugins[id];
  return { ledger: { version: LEDGER_VERSION, plugins }, removed: true };
}

/* ------------------------------------------------------------------ *
 * 4. 取真实 commit sha
 * ------------------------------------------------------------------ */

/**
 * 取某个 ref 的真实 commit sha。
 *
 * @returns {Promise<{ok:boolean, sha:string|null, error:string|null}>}
 *
 * 为什么不用 release.target_commitish：
 *   实测它可能是 "main"（vscode / svelte），不是 sha（见文件头依据 1）。
 *
 * 为什么 422 也算失败：
 *   实测 `/commits/{不存在的 ref}` 返回 **422**，不是 404。
 *   只判 404 会把 422 的响应体当成正常数据往下走。
 */
export async function fetchRefSha(repo, ref, opts = {}) {
  const f = opts.fetch || globalThis.fetch;
  if (typeof f !== 'function') return { ok: false, sha: null, error: '环境没有 fetch' };
  if (!repo || !repo.owner || !repo.repo) return { ok: false, sha: null, error: '仓库地址不完整' };
  if (!ref) return { ok: false, sha: null, error: '未指定 ref' };
  const url = `${API_BASE}/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}`;
  try {
    const res = await f(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res) return { ok: false, sha: null, error: '无响应' };
    if (res.status === 404 || res.status === 422) return { ok: false, sha: null, error: `ref 不存在: ${ref}` };
    if (res.status >= 400) return { ok: false, sha: null, error: `GitHub 返回 ${res.status}` };
    const j = await res.json();
    const sha = j && j.sha;
    if (!isSha(sha)) return { ok: false, sha: null, error: '返回的不是 40 位 sha' };
    return { ok: true, sha, error: null };
  } catch (err) {
    return { ok: false, sha: null, error: String((err && err.message) || err) };
  }
}

/* ------------------------------------------------------------------ *
 * 5. 更新检测（只报告，不执行 —— D6）
 * ------------------------------------------------------------------ */

/**
 * 对台账里每个「市场来源」的插件查一次有没有新版。
 *
 * @param {object} ledger
 * @param {object} [opts] { fetch, includeCustom }
 * @returns {Promise<{results:object[], errors:string[]}>}
 *
 * 设计要点
 * ------------------------------------------------------------
 * · **只报告，不下载、不安装** —— D6。
 * · **网络失败是常态**（断网 / GitHub 挂 / 仓库私有），
 *   单个插件失败**不影响其它插件**，失败原因逐条带回来。
 * · **没有 repo 的插件直接跳过**：本地装的插件无从查远端，
 *   硬去查等于拿目录名去猜仓库，那是把写法当意图。
 * · 版本判不了 → hasUpdate=false（plugin-store-client 已有此约定）。
 */
export async function checkUpdates(ledger, opts = {}) {
  const results = [];
  const errors = [];
  const base = ledger && ledger.plugins ? ledger.plugins : {};

  for (const [id, e] of Object.entries(base)) {
    if (!e.repo) {
      results.push({ id, checked: false, hasUpdate: false, reason: '非市场来源（没有仓库信息），无法检查更新' });
      continue;
    }
    const r = await fetchRelease(e.repo, { fetch: opts.fetch, ref: e.ref || null });
    if (!r.ok) {
      results.push({ id, checked: false, hasUpdate: false, reason: `查询失败: ${r.error}` });
      errors.push(`${id}: ${r.error}`);
      continue;
    }
    const u = resolveUpdateFor(e, r.release, id);
    results.push(Object.assign({ id, checked: true }, u));
  }
  return { results, errors };
}

/** 内部：把一条台账记录与远端 release 比对（纯函数，便于单测） */
export function resolveUpdateFor(entry, release, id) {
  if (!release) return { hasUpdate: false, from: null, to: null, asset: null, reason: '没有 release 信息' };
  const to = String(release.tag_name || release.name || '').replace(/^v/i, '');
  const asset = pickAsset(release.assets, id, to);
  if (!asset) return { hasUpdate: false, from: (entry && entry.version) || null, to, asset: null, reason: 'release 里没有可用产物' };

  const from = (entry && entry.version) || null;
  /* 产物指纹优先：同版本但产物换了，也要算「有变化」——
   * 这不是「版本号更新」，而是「装的东西不一样了」，必须让用户知道。 */
  const newFp = assetFingerprint(asset);
  if (from && to && from === to && entry.fingerprint && newFp) {
    if (entry.fingerprint !== newFp) {
      return { hasUpdate: false, from, to, asset, reason: '版本未变但产物已变化（重新上传过），建议核对来源', fingerprintChanged: true };
    }
  }
  if (!from) return { hasUpdate: true, from: null, to, asset, reason: '未安装' };
  const c = compareVersion(from, to);
  if (c === null) return { hasUpdate: false, from, to, asset, reason: '版本号无法比较，不宣称有更新', fingerprintChanged: false };
  return { hasUpdate: c < 0, from, to, asset, reason: c < 0 ? '版本更新' : '已是最新', fingerprintChanged: false };
}
