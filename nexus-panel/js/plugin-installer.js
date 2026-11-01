/**
 * 插件安装器 —— 落盘 / 校验 / 原子替换 / 卸载
 * ============================================================
 * 职责边界（先看清楚，别往里塞东西）
 * ------------------------------------------------------------
 * 本模块**只管落盘**，不管下载、不管解压算法：
 *   · 下载      → js/plugin-store-client.js
 *   · 解包成条目 → 调用方（.tar.gz 走系统 tar，zip 走 unzip）
 *   · 落盘      → 本模块
 *
 * 为什么这么切：解压算法是 solved problem（系统 tar/unzip），
 * 而**落盘是安全关键**——归档里的条目名是**不可信输入**，
 * 一个 `../../` 就能让宿主把文件写到插件目录外面（tar slip）。
 * 把安全关键的部分做成不依赖任何外部命令的纯函数，才测得住。
 *
 * ⚠️ 本模块的三条安全底线
 * ------------------------------------------------------------
 * 1. **条目名一律当敌意输入**：先 normalize 再 safeJoin，
 *    任何跳出目标目录的条目**跳过并记原因**，不静默丢弃也不放行。
 * 2. **落盘是原子的**：先写暂存目录，校验全过才替换；
 *    中途任何一步失败，旧版本必须**原样还在**（回滚）。
 *    否则「装到一半失败」会让用户既没新版也没旧版。
 * 3. **卸载只删代码，用户数据默认保留**。
 *    市场插件 id 固定，重装就是同一个 id ——
 *    「留着以后用」恰恰是设计目标，不是残留。
 *    （对比：js/host.js 的 removePlugin 也曾无条件清数据，
 *      它的前提是「重装会是新的 custom-时间戳 id」，
 *      这个前提对市场插件不成立 —— 现在两边都问同一个策略，
 *      结论只认 js/plugin-data-policy.js 那一处。）
 */

import {
  mkdirSync, writeFileSync, rmSync, renameSync,
  existsSync, statSync, readFileSync, readdirSync,
} from 'node:fs';
import { join, resolve, sep, dirname, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { MANIFEST_FILE, validateManifest, INSTALLED_PLUGINS_DIR } from './plugin-manifest.js';
/* 卸载时"用户数据去留"只认这一份判据 —— 与 js/host.js 的 removePlugin 共用
   同一结论。此前这里是自己那份 `if (p.removeUserData)`：
   · 只认 removeUserData、**不认 purgeData**（策略里两个词都认），
     用后者的调用方会被静默当成"没要求删" —— 用户勾了「连数据一起删」、
     界面报成功，数据还在，而这是不可逆预期被打破；
   · 不看来源，custom 装的插件走这条路会留下永远没人再取的数据。
   两份判据各改各的是最难查的一类问题，所以收成一份。 */
import { shouldPurgeDataOnUninstall, normalizeSource } from './plugin-data-policy.js';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 暂存目录前缀（原子安装的中转站；以点开头，扫描器会跳过） */
export const STAGING_PREFIX = '.tmp-';
/** 旧版本备份前缀（替换失败时回滚用） */
export const BACKUP_PREFIX = '.old-';

/* ------------------------------------------------------------------ *
 * 1. 归档识别
 * ------------------------------------------------------------------ */

/**
 * 嗅探归档类型（只看魔数，不看扩展名 —— 扩展名是对方给的，不可信）
 * @param {Buffer|Uint8Array} buf
 * @returns {'gzip'|'zip'|null}
 */
export function sniffArchive(buf) {
  if (!buf || buf.length < 2) return null;
  if (buf[0] === 0x1f && buf[1] === 0x8b) return 'gzip';
  if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  return null;
}

/* ------------------------------------------------------------------ *
 * 2. 条目名归一化与越界判定（安全关键）
 * ------------------------------------------------------------------ */

/**
 * 归一化归档条目名，并判定是否安全。
 *
 * @param {string} name 归档里的原始条目名（**不可信**）
 * @returns {{rel: string|null, unsafe: string|null}}
 *
 * 为什么一条条都判：
 *   · `../`    → tar slip，写到插件目录外
 *   · 绝对路径 → 同上，且 safeJoin 会「贴心地」拼成 root+abs 反而更隐蔽
 *   · 盘符     → Windows 上 `C:\x` 在 POSIX 里是个普通文件名，
 *                到 Windows 就变成绝对路径，必须显式拒
 *   · 反斜杠   → 某些打包工具在 Windows 上产出 `a\b.html`，
 *                POSIX 下会建成一个名字里带反斜杠的文件
 *   · NUL      → 截断底层 API，历史上出过真实漏洞
 */
export function normalizeRelPath(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { rel: null, unsafe: '条目名不是非空字符串' };
  }
  if (name.includes('\0')) {
    return { rel: null, unsafe: `条目名含 NUL: ${JSON.stringify(name)}` };
  }
  let s = name.replace(/\\/g, '/');
  /* 盘符：C:/ 或 C:\ */
  if (/^[A-Za-z]:/.test(s)) {
    return { rel: null, unsafe: `条目名是绝对路径（盘符）: ${name}` };
  }
  if (s.startsWith('/')) {
    return { rel: null, unsafe: `条目名是绝对路径: ${name}` };
  }
  /* 去掉前导 ./ 与重复的 / */
  s = s.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  /* 目录条目：以 / 结尾 */
  const isDir = s.endsWith('/');
  if (isDir) s = s.replace(/\/+$/, '');
  if (s === '' || s === '.') {
    return { rel: null, unsafe: isDir ? '根条目（无内容）' : `条目名为空或 . : ${name}` };
  }
  const segs = s.split('/');
  if (segs.includes('..')) {
    return { rel: null, unsafe: `条目名含 ..（路径穿越）: ${name}` };
  }
  if (segs.includes('.')) {
    return { rel: null, unsafe: `条目名含 . 段: ${name}` };
  }
  return { rel: s, unsafe: null, isDir };
}

/**
 * 把相对路径安全拼到根目录下。
 * @returns {string|null} 越界返回 null
 *
 * 用 `rootAbs + sep` 而不是 `rootAbs` 做前缀判断：
 * 否则 `/data/plugins-foo` 会被 `/data/plugins` 判成「在里面」。
 */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel === '') return null;
  const rootAbs = resolve(root);
  const p = resolve(rootAbs, rel);
  if (p !== rootAbs && !p.startsWith(rootAbs + sep)) return null;
  return p;
}

/**
 * 求所有条目的公共顶层目录名。
 *
 * 为什么需要：GitHub 源码包 / 多数打包工具会套一层 `<name>-<ver>/`。
 * 不脱掉这层，装完就是 `installed-plugins/<id>/<id>-1.0.0/index.html`，
 * entry 找不到 —— 表现为「装上了但打不开」，很难查。
 *
 * @param {string[]} rels 已归一化的相对路径
 * @returns {string|null} 仅当**所有**条目都在同一顶层目录下时才返回
 *
 * `foo` 这种单段（顶层是文件）不作为公共目录：
 * 否则「只有一个 index.html 的包」会被脱成空路径。
 */
export function commonRootDir(rels) {
  if (!Array.isArray(rels) || rels.length === 0) return null;
  let first = null;
  for (const r of rels) {
    if (typeof r !== 'string') return null;
    const i = r.indexOf('/');
    if (i <= 0) return null;           // 顶层是文件，或空
    const head = r.slice(0, i);
    if (first === null) first = head;
    else if (first !== head) return null;
  }
  return first;
}

/* ------------------------------------------------------------------ *
 * 3. 条目落盘
 * ------------------------------------------------------------------ */

/**
 * 把条目写进目标目录（**唯一**的落盘入口）。
 *
 * @param {Array<{name:string, content?:string|Buffer, dir?:boolean}>} entries
 * @param {string} destDir 目标目录（会被创建）
 * @param {object} [opts]
 * @param {boolean} [opts.stripCommonRoot=true] 脱掉公共顶层目录
 * @returns {{files:string[], skipped:Array<{name:string,reason:string}>, dir:string}}
 *
 * 越界条目是**跳过并记原因**，不是抛错中断：
 * 一个坏条目不该让整个安装失败（那是拒绝服务），
 * 但也不能静默丢（那是掩盖），必须让用户看得见。
 */
export function extractEntries(entries, destDir, opts = {}) {
  const strip = opts.stripCommonRoot !== false;
  const files = [];
  const skipped = [];

  if (!Array.isArray(entries)) {
    return { files, skipped: [{ name: '(全部)', reason: 'entries 不是数组' }], dir: destDir };
  }
  if (typeof destDir !== 'string' || destDir === '') {
    return { files, skipped: [{ name: '(全部)', reason: 'destDir 为空' }], dir: String(destDir) };
  }

  /* --- 先全部归一化，再决定要不要脱壳 --- */
  const norm = [];
  for (const e of entries) {
    const raw = e && e.name;
    const n = normalizeRelPath(raw);
    if (n.unsafe) {
      skipped.push({ name: String(raw), reason: n.unsafe });
      continue;
    }
    norm.push({ rel: n.rel, isDir: !!(n.isDir || (e && e.dir)), content: e && e.content });
  }

  let root = null;
  if (strip) {
    root = commonRootDir(norm.map((x) => x.rel));
  }

  mkdirSync(destDir, { recursive: true });

  for (const it of norm) {
    let rel = it.rel;
    if (root) {
      if (!rel.startsWith(root + '/')) { skipped.push({ name: rel, reason: `不在公共目录下（${root}）` }); continue; }
      rel = rel.slice(root.length + 1);
      if (rel === '') continue;
    }
    const abs = safeJoin(destDir, rel);
    if (!abs) { skipped.push({ name: rel, reason: '归一化后仍越界（safeJoin 拒绝）' }); continue; }
    try {
      if (it.isDir) { mkdirSync(abs, { recursive: true }); continue; }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, it.content === undefined ? '' : it.content);
      files.push(rel);
    } catch (err) {
      skipped.push({ name: rel, reason: `写入失败: ${err && err.message}` });
    }
  }

  return { files, skipped, dir: destDir };
}

/* ------------------------------------------------------------------ *
 * 4. 落盘后校验
 * ------------------------------------------------------------------ */

/**
 * 校验一个已落盘的插件目录能不能用。
 *
 * @param {string} dir
 * @param {object} [opts]
 * @param {string} [opts.expectedId] 期望的 id。**装在暂存目录时必须给**：
 *        暂存目录叫 `.tmp-<id>-<rand>`，拿它的 basename 去做
 *        「目录名 == id」校验会**必然失败**（第一次实跑就撞上了）。
 *        这种场景下用 expectedId 代替目录名。
 * @param {string[]} [opts.reservedIds] 透传 validateManifest
 * @returns {{ok:boolean, errors:string[], warnings:string[], manifest:object|null}}
 *
 * 三重检查，缺一不可：
 *   1. manifest 存在且是合法 JSON（损坏的包最常见）
 *   2. manifest 字段合法 + 目录名/id == 期望 id（防顶替）
 *   3. **entry 真的存在**（manifest 写得再漂亮，文件没有就是打不开）
 */
export function verifyPluginDir(dir, opts = {}) {
  const errors = [];
  const warnings = [];
  if (typeof dir !== 'string' || !existsSync(dir)) {
    return { ok: false, errors: ['插件目录不存在'], warnings, manifest: null };
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`manifest 读不出或不是合法 JSON: ${err && err.message}`], warnings, manifest: null };
  }
  const dirName = opts.expectedId || opts.dirName || basename(dir);
  const v = validateManifest(raw, { ...opts, dirName });
  if (!v.ok) return { ok: false, errors: v.errors.slice(), warnings: v.warnings.slice(), manifest: null };

  const m = v.manifest;
  const entryAbs = safeJoin(dir, m.entry);
  if (!entryAbs) {
    errors.push(`entry 越界: ${m.entry}`);
  } else if (!existsSync(entryAbs)) {
    errors.push(`entry 文件不存在: ${m.entry}`);
  } else if (!statSync(entryAbs).isFile()) {
    errors.push(`entry 不是文件: ${m.entry}`);
  }
  if (v.warnings.length) warnings.push(...v.warnings);
  return { ok: errors.length === 0, errors, warnings, manifest: m };
}

/* ------------------------------------------------------------------ *
 * 5. 原子安装
 * ------------------------------------------------------------------ */

function rnd() { return randomBytes(4).toString('hex'); }

/**
 * 原子安装：先落暂存 → 校验 → 再替换，失败可回滚。
 *
 * @param {object} p
 * @param {string} p.root       已安装插件根目录
 * @param {string} p.id         插件 id（决定目录名）
 * @param {Array}  p.entries    {name, content, dir?}[]
 * @param {string[]} [p.reservedIds] 与内置插件冲突的 id
 * @returns {{ok:boolean, id:string, dir?:string, version?:string,
 *            replaced:boolean, errors:string[], warnings:string[]}}
 */
export function installPlugin(p) {
  const root = p && p.root ? p.root : INSTALLED_PLUGINS_DIR;
  const id = p && p.id;
  const errors = [];
  const warnings = [];

  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    return { ok: false, id: String(id), replaced: false, errors: ['id 不合法'], warnings };
  }
  /* 目标目录必须就在 root 下面（id 已限字符集，这里再兜一道） */
  const target = safeJoin(root, id);
  if (!target || basename(target) !== id) {
    return { ok: false, id, replaced: false, errors: ['id 解析出的目录越界'], warnings };
  }

  mkdirSync(root, { recursive: true });
  const staging = join(root, `${STAGING_PREFIX}${id}-${rnd()}`);
  let backup = null;
  let movedOut = false;
  let done = false;
  let err = null;
  let result = null;

  try {
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });

    const ex = extractEntries(p.entries, staging);
    for (const s of ex.skipped) {
      /* 越界条目只告警不阻断：它没有真的写出去 */
      warnings.push(`跳过条目 ${s.name}: ${s.reason}`);
    }

    const v = verifyPluginDir(staging, { reservedIds: p.reservedIds, expectedId: id });
    if (!v.ok) throw new Error(`校验失败: ${v.errors.join('; ')}`);
    if (v.manifest.id !== id) {
      throw new Error(`manifest.id(${v.manifest.id}) 与安装 id(${id}) 不一致`);
    }
    warnings.push(...v.warnings);

    if (existsSync(target)) {
      backup = join(root, `${BACKUP_PREFIX}${id}-${rnd()}`);
      renameSync(target, backup);
      movedOut = true;
    }
    renameSync(staging, target);
    done = true;
    result = { version: v.manifest.version, dir: target, files: ex.files };
  } catch (e) {
    err = e;
    errors.push(String(e && e.message));
  } finally {
    /* --- 回滚 / 收尾 ---
     * 失败：旧版本必须原样还在；暂存目录清掉（留着会污染扫描）
     * 成功：旧版本备份删掉；暂存已被 rename 走，不存在了 */
    if (!done) {
      if (movedOut && backup && existsSync(backup) && !existsSync(target)) {
        try { renameSync(backup, target); } catch { /* 回滚失败只能记，不能再抛 */ }
      }
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* 同上 */ }
    } else {
      try { rmSync(staging, { recursive: true, force: true }); } catch { /* 已 rename 走 */ }
      if (backup) { try { rmSync(backup, { recursive: true, force: true }); } catch { /* 同上 */ } }
    }
  }

  if (!done) return { ok: false, id, replaced: false, errors, warnings };
  return {
    ok: true, id, dir: result.dir, version: result.version,
    replaced: movedOut, errors: [], warnings,
  };
}

/* ------------------------------------------------------------------ *
 * 6. 卸载
 * ------------------------------------------------------------------ */

/**
 * 卸载计划（**只读**，一份都不删）。
 *
 * 为什么要先出报告：沿用 js/plugin-fs.js 的既有原则 ——
 * 「只读报告，不自动删」。用户在删之前有权知道会删掉什么、
 * 以及**哪些会被留下**（用户数据默认留）。
 */
export function uninstallPlan(p) {
  const root = p && p.root ? p.root : INSTALLED_PLUGINS_DIR;
  const id = p && p.id;
  const codeDir = safeJoin(root, id);
  if (!codeDir || basename(codeDir) !== id) {
    return { ok: false, id: String(id), reason: 'id 不合法或越界' };
  }
  const exists = existsSync(codeDir);
  let fileCount = 0, bytes = 0;
  if (exists) {
    const walk = (d) => {
      let ents = [];
      try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const abs = join(d, e.name);
        if (e.isDirectory()) walk(abs);
        else {
          fileCount++;
          try { bytes += statSync(abs).size; } catch { /* 读不到就算 0 */ }
        }
      }
    };
    walk(codeDir);
  }
  const userDataDir = p && p.userDataRoot ? join(p.userDataRoot, id) : null;
  return {
    ok: true, id, codeDir, exists, fileCount, bytes,
    userDataDir,
    userDataExists: userDataDir ? existsSync(userDataDir) : false,
    willRemove: exists ? [codeDir] : [],
    willKeep: userDataDir ? [userDataDir] : [],
  };
}

/**
 * 执行卸载：删代码目录；用户数据**默认保留**。
 *
 * @param {object} p
 * @param {string} p.root
 * @param {string} p.id
 * @param {string} [p.userDataRoot]
 * @param {boolean} [p.removeUserData=false] 显式要求才删
 */
export function uninstallPlugin(p) {
  const root = p && p.root ? p.root : INSTALLED_PLUGINS_DIR;
  const id = p && p.id;
  const codeDir = safeJoin(root, id);
  if (!codeDir || basename(codeDir) !== id) {
    return { ok: false, id: String(id), removed: [], kept: [], errors: ['id 不合法或越界'] };
  }
  if (codeDir === resolve(root)) {
    return { ok: false, id, removed: [], kept: [], errors: ['拒绝删除插件根目录本身'] };
  }
  if (!existsSync(codeDir)) {
    return { ok: false, id, removed: [], kept: [], errors: ['插件未安装'] };
  }
  const removed = [], kept = [], errors = [];
  try {
    rmSync(codeDir, { recursive: true, force: true });
    removed.push(codeDir);
  } catch (err) {
    errors.push(`删除代码目录失败: ${err && err.message}`);
    return { ok: false, id, removed, kept, errors };
  }

  const userDataDir = p && p.userDataRoot ? join(p.userDataRoot, id) : null;
  if (userDataDir) {
    if (shouldPurgeDataOnUninstall({
      id,
      source: normalizeSource(p && p.source),
      removeUserData: p && p.removeUserData,
      purgeData: p && p.purgeData,
    })) {
      try { rmSync(userDataDir, { recursive: true, force: true }); removed.push(userDataDir); }
      catch (err) { errors.push(`删除用户数据失败: ${err && err.message}`); kept.push(userDataDir); }
    } else {
      kept.push(userDataDir);
    }
  }
  return { ok: errors.length === 0, id, removed, kept, errors };
}
