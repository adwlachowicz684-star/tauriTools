#!/usr/bin/env node
/**
 * 发布一个更新版本：生成 latest.json 并上传到对应通道的 Release。
 * ============================================================
 *
 * 用法：
 *   GITHUB_TOKEN=xxx node scripts/publish-update.mjs --channel=stable
 *   GITHUB_TOKEN=xxx node scripts/publish-update.mjs --channel=beta --notes="内测：新增 X"
 *   node scripts/publish-update.mjs --channel=beta --dry-run          # 只生成不上传
 *   node scripts/publish-update.mjs --from-dir=/path/to/bundle        # 跳过构建，用已有产物
 *
 * 【为什么 tag / 仓库地址要从 updater.rs 解析，而不是在这里写一份】
 * 脚本是"发布端"，updater.rs 是"消费端"。两边各写一份常量，改了一边忘了另一边，
 * 结果是：脚本往 A 地址传，客户端去 B 地址找 —— 两边代码都没错，
 * 表现却是"我明明发布了，客户端却说没有更新"，且不报任何错。
 * 这类"两个都对、只是对不上"的问题最难查，所以这里强制单一事实来源：
 * 仓库地址与 tag 全部从 updater.rs 正则解析，解析不到就报错退出。
 *
 * 【为什么只认这几种包格式】
 * Tauri updater 只能安装特定格式（Windows 的 .nsis.zip / .msi，macOS 的
 * .app.tar.gz，Linux 的 .AppImage）。把 .dmg 或 .exe 传进 latest.json，
 * 客户端能查到更新、下载也成功，但**装不上** —— 错误只会说"解压失败"，
 * 完全指向不到"你传错了文件"。所以这里白名单收口，宁可报错。
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const ROOT = resolve(HERE, '..');
const UPDATER_RS = join(ROOT, 'src-tauri/src/updater.rs');
const TAURI_CONF = join(ROOT, 'src-tauri/tauri.conf.json');
const CARGO_TOML = join(ROOT, 'src-tauri/Cargo.toml');

/* ── 客户端真正能安装的包格式。OS 由扩展名唯一确定，不需要猜目录名。 */
const UPDATER_EXTS = [
  { ext: '.nsis.zip', os: 'windows' },
  { ext: '.msi', os: 'windows' },
  { ext: '.app.tar.gz', os: 'darwin' },
  { ext: '.AppImage', os: 'linux' },
];

export const CHANNEL_STABLE = 'stable';
export const CHANNEL_BETA = 'beta';

/**
 * 通道名收敛。**必须与 updater.rs 的 normalize_channel 同构**：
 * 不认识的值一律按正式版处理。方向不能反 —— 测试通道是更激进的那个，
 * 认错方向会把普通用户推到内测版上。
 */
export function normalizeChannel(ch) {
  const s = String(ch ?? '').trim().toLowerCase();
  return s === CHANNEL_BETA ? CHANNEL_BETA : CHANNEL_STABLE;
}

/**
 * 从 updater.rs 源码解析发布目标。
 * 解析失败抛错而不是用默认值 —— 默认值会让脚本静默传到错的地方。
 */
export function parsePublishTarget(src) {
  const gh = /const\s+GH_RELEASE:\s*&str\s*=\s*"([^"]+)"/.exec(src);
  const gitee = /const\s+GITEE_RELEASE:\s*&str\s*=\s*"([^"]+)"/.exec(src);
  const stable = /pub\s+const\s+TAG_STABLE:\s*&str\s*=\s*"([^"]+)"/.exec(src);
  const beta = /pub\s+const\s+TAG_BETA:\s*&str\s*=\s*"([^"]+)"/.exec(src);

  const miss = [];
  if (!gh) miss.push('GH_RELEASE');
  if (!gitee) miss.push('GITEE_RELEASE');
  if (!stable) miss.push('TAG_STABLE');
  if (!beta) miss.push('TAG_BETA');
  if (miss.length) {
    throw new Error(`updater.rs 里解析不到 ${miss.join(' / ')}，拒绝发布（默认值会传到错的地方）`);
  }

  // https://github.com/owner/repo/releases/download → { owner, repo }
  const m = /github\.com\/([^/]+)\/([^/]+)\/releases\/download/.exec(gh[1]);
  if (!m) throw new Error(`GH_RELEASE 不是预期的 releases/download 形式：${gh[1]}`);

  return {
    owner: m[1],
    repo: m[2],
    ghRelease: gh[1],
    giteeRelease: gitee[1],
    tagStable: stable[1],
    tagBeta: beta[1],
  };
}

export function tagFor(channel, target) {
  return normalizeChannel(channel) === CHANNEL_BETA ? target.tagBeta : target.tagStable;
}

/**
 * 从产物文件名推断 arch。
 * 推断不出来就抛错，不猜 —— 猜错的平台 key 会让**那一台机器**永远查不到更新，
 * 而其他机器正常，看起来像"客户端有 bug"。
 */
export function archOf(name) {
  if (/aarch64|arm64/i.test(name)) return 'aarch64';
  if (/x86_64|x64|amd64/i.test(name)) return 'x86_64';
  if (/i686|x86\b/i.test(name)) return 'i686';
  throw new Error(`无法从文件名判断架构（需含 x64/x86_64/aarch64/arm64）：${name}`);
}

/**
 * 扫描产物目录，配对「安装包 + 它的 .sig」。
 *
 * entries: [{ dir, name }]，name 是文件名、dir 是相对 bundle 的子目录（仅用于报错定位）。
 *
 * 三条硬校验，每条对应的都是"发布成功但客户端装不上"这类静默故障：
 *   1. 有 .sig 却没有对应安装包 → 报 error（签名所指的包根本不存在）
 *   2. 安装包不在 UPDATER_EXTS 白名单 → 跳过并记 skip（.dmg / .exe 装不上）
 *   3. 有白名单内的安装包却没有 .sig → 报 error（客户端验签必失败）
 */
export function collectArtifacts(entries) {
  const names = new Set(entries.map((e) => e.name));
  const found = [];
  const errors = [];
  const skipped = [];

  for (const e of entries) {
    if (!e.name.endsWith('.sig')) continue;
    const pkgName = e.name.slice(0, -'.sig'.length);

    if (!names.has(pkgName)) {
      errors.push(`有签名却没有对应的安装包：${pkgName}（签名文件 ${e.name} 指向的包不存在）`);
      continue;
    }
    const hit = UPDATER_EXTS.find((x) => pkgName.endsWith(x.ext));
    if (!hit) {
      skipped.push(`${pkgName} 不是 updater 可安装的格式（只认 ${UPDATER_EXTS.map((x) => x.ext).join(' / ')}）`);
      continue;
    }
    let arch;
    try {
      arch = archOf(pkgName);
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    found.push({ name: pkgName, sigName: e.name, os: hit.os, arch, dir: e.dir });
  }

  /* 反向查：白名单内、却没有签名文件的安装包。
     漏了 .sig 的表现是"每次都能查到更新，但安装必失败"，
     而错误信息只说签名无效，指向不到"你忘了传 .sig"。 */
  for (const e of entries) {
    if (e.name.endsWith('.sig')) continue;
    const hit = UPDATER_EXTS.find((x) => e.name.endsWith(x.ext));
    if (!hit) continue;
    if (!names.has(`${e.name}.sig`)) {
      errors.push(`安装包缺少签名文件：${e.name}.sig 不存在（客户端验签必失败）`);
    }
  }

  return { found, errors, skipped };
}

/** 构造 latest.json 文本。pubDate 缺省取当前时刻（RFC 3339）。 */
export function buildLatestJson({ version, notes = '', pubDate, platforms }) {
  return `${JSON.stringify(
    {
      version,
      notes,
      pub_date: pubDate ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      platforms,
    },
    null,
    2,
  )}\n`;
}

/** 读 Cargo.toml 的 version —— 客户端 package_info().version 读的就是它。 */
function readCargoVersion() {
  if (!existsSync(CARGO_TOML)) throw new Error(`找不到 ${CARGO_TOML}`);
  const m = /^version\s*=\s*"([^"]+)"/m.exec(readFileSync(CARGO_TOML, 'utf8'));
  if (!m) throw new Error('Cargo.toml 里解析不到 version');
  return m[1];
}

/** tauri.conf.json 的 version 必须与 Cargo.toml 一致，否则客户端显示的版本会与实际不符。 */
function readConfVersion() {
  if (!existsSync(TAURI_CONF)) return null;
  return JSON.parse(readFileSync(TAURI_CONF, 'utf8')).version ?? null;
}

/** 递归列出目录下的文件，返回 [{ dir, name, abs }] */
async function walk(dir, rel = '') {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await walk(join(dir, ent.name), r)));
    else out.push({ dir: rel, name: ent.name, abs: join(dir, ent.name) });
  }
  return out;
}

function parseArgs(argv) {
  const a = { channel: CHANNEL_STABLE, notes: '', dryRun: false, fromDir: '', notesFile: '' };
  for (const s of argv.slice(2)) {
    if (s === '--dry-run') a.dryRun = true;
    else if (s.startsWith('--channel=')) a.channel = s.slice('--channel='.length);
    else if (s.startsWith('--notes=')) a.notes = s.slice('--notes='.length);
    else if (s.startsWith('--notes-file=')) a.notesFile = s.slice('--notes-file='.length);
    else if (s.startsWith('--from-dir=')) a.fromDir = s.slice('--from-dir='.length);
    else if (s === '--help' || s === '-h') a.help = true;
    else throw new Error(`未知参数：${s}`);
  }
  return a;
}

function usage() {
  return `发布一个更新版本（生成 latest.json + 上传到 Release）

  node scripts/publish-update.mjs --channel=stable|beta [选项]

选项：
  --channel=stable|beta   发布到哪个通道（默认 stable；未知值按 stable 处理）
  --notes="..."           更新说明；也可用 --notes-file=CHANGELOG.md
  --dry-run               只生成 latest.json，不上传
  --from-dir=<dir>        用已有产物目录，跳过构建（产物根目录，含 nsis/ dmg/ 等子目录）

环境变量：
  GITHUB_TOKEN            必填（--dry-run 时可省略）

示例：
  GITHUB_TOKEN=ghp_xxx node scripts/publish-update.mjs --channel=stable --notes="修复 X"`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const channel = normalizeChannel(args.channel);
  const target = parsePublishTarget(readFileSync(UPDATER_RS, 'utf8'));
  const tag = tagFor(channel, target);

  const version = readCargoVersion();
  const confVersion = readConfVersion();
  if (confVersion && confVersion !== version) {
    throw new Error(
      `版本号不一致：Cargo.toml=${version} 而 tauri.conf.json=${confVersion}。` +
        `客户端比较的是 Cargo.toml 的版本，两处漂移会让"当前版本"显示错。`,
    );
  }

  const bundleDir = args.fromDir || join(ROOT, 'src-tauri/target/release/bundle');
  if (!args.fromDir) {
    console.log('提示：未指定 --from-dir，默认读取构建产物目录。请先自行完成 tauri build。');
    console.log(`      ${bundleDir}`);
  }
  const entries = await walk(bundleDir);
  if (!entries.length) throw new Error(`产物目录为空或不存在：${bundleDir}`);

  const { found, errors, skipped } = collectArtifacts(entries);
  for (const s of skipped) console.log(`跳过  ${s}`);
  if (errors.length) {
    for (const e of errors) console.error(`错误  ${e}`);
    throw new Error(`${errors.length} 个产物问题，拒绝生成 latest.json`);
  }
  if (!found.length) {
    /* 空的 platforms 是最坏的结果：客户端查到"有更新"，下载时 404。
       宁可在这里停下，也不要传一份空清单上去。 */
    throw new Error('没找到任何可发布的 updater 产物，拒绝生成空的 latest.json');
  }

  const notes = args.notesFile ? readFileSync(resolve(args.notesFile), 'utf8').trim() : args.notes;
  const platforms = {};
  for (const f of found) {
    platforms[`${f.os}-${f.arch}`] = {
      signature: readFileSync(join(bundleDir, f.dir, f.sigName), 'utf8').trim(),
      url: `${target.ghRelease}/${tag}/${encodeURIComponent(f.name)}`,
    };
  }

  const json = buildLatestJson({ version, notes, platforms });
  console.log(`通道   ${channel}  →  tag ${tag}`);
  console.log(`版本   ${version}`);
  console.log(`平台   ${Object.keys(platforms).join(', ')}`);
  console.log(json);

  if (args.dryRun) {
    console.log('--dry-run：未上传。');
    return;
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('缺少环境变量 GITHUB_TOKEN');

  const files = [
    { name: 'latest.json', content: Buffer.from(json, 'utf8') },
    ...found.map((f) => ({
      name: f.name,
      content: readFileSync(join(bundleDir, f.dir, f.name)),
    })),
  ];

  const release = await ensureRelease({ token, target, tag, version, notes });
  for (const f of files) {
    process.stdout.write(`上传   ${f.name} (${f.content.length} B) … `);
    await uploadAsset({ token, target, releaseId: release.id, name: f.name, content: f.content });
    console.log('完成');
  }

  console.log(`\n已发布到 https://github.com/${target.owner}/${target.repo}/releases/tag/${tag}`);
  console.log(
    `\nGitee 镜像需同步到：${target.giteeRelease}/${tag}/  ` +
      `（Gitee 的 Release 附件接口无法在本环境验证，不做自动上传，避免传错不报错）`,
  );
}

async function ghApi(token, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'nexus-panel-publish',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${init.method || 'GET'} ${path} → ${res.status} ${body.slice(0, 300)}`);
  }
  return res.status === 204 ? null : res.json();
}

async function ensureRelease({ token, target, tag, version, notes }) {
  const base = `/repos/${target.owner}/${target.repo}`;
  try {
    const r = await ghApi(token, `${base}/releases/tags/${tag}`);
    console.log(`Release ${tag} 已存在（id ${r.id}），复用`);
    return r;
  } catch {
    console.log(`Release ${tag} 不存在，创建`);
    return ghApi(token, `${base}/releases`, {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag,
        name: `${version}`,
        body: notes || '',
        prerelease: tag.includes('beta'),
      }),
    });
  }
}

async function uploadAsset({ token, target, releaseId, name, content }) {
  const base = `/repos/${target.owner}/${target.repo}`;
  // 同名附件先删 —— GitHub 上传重名附件返回 422，不删除的话更新会失败且只说"已存在"
  const rel = await ghApi(token, `${base}/releases/${releaseId}`);
  const dup = (rel.assets || []).find((a) => a.name === name);
  if (dup) await ghApi(token, `${base}/releases/assets/${dup.id}`, { method: 'DELETE' });

  const res = await fetch(
    `https://uploads.github.com${base}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/octet-stream',
        'User-Agent': 'nexus-panel-publish',
      },
      body: content,
    },
  );
  if (!res.ok) throw new Error(`上传 ${name} 失败：${res.status} ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`\n发布失败：${e.message}`);
    process.exit(1);
  });
}
