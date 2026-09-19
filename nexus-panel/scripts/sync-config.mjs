/**
 * 配置同步 / 漂移检查
 * ----------------------------------------------------------------------------
 * 用法：
 *   node scripts/sync-config.mjs          # 按共享源重写各处的派生配置
 *   node scripts/sync-config.mjs --check  # 只检查，不写（CI 用，漂移就退出码 1）
 *
 * 为什么要这个脚本：
 *   两套入口（无构建 / Vite+React）的配置原本分散在四个文件里，
 *   改一处忘一处是必然的（CSP 只在一侧生效就是这么来的）。
 *   现在共享值统一定义在 config/nexus.config.mjs，
 *   这里负责把「派生值」写进各文件，并能在 CI 里挡住手改造成的漂移。
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  PROJECT_ROOT,
  ENTRIES,
  DEV_SERVER,
  TAURI_CONFIGS,
  cspPolicies,
  DISABLE_ASSET_CSP_MODIFICATION,
} from '../config/nexus.config.mjs';

const CHECK_ONLY = process.argv.includes('--check');
const CSP = cspPolicies();
const DEV_URL = `http://${DEV_SERVER.host}:${DEV_SERVER.port}/${ENTRIES.react}`;

const rel = (p) => path.relative(PROJECT_ROOT, p).split(path.sep).join('/');
const read = (p) => fs.readFileSync(p, 'utf8');
const readJson = (p) => JSON.parse(read(p));
const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');

let changed = 0;
let failed = 0;

function report(status, target, detail) {
  if (status === 'ok') console.log(`✅ ${target} · ${detail}`);
  else if (status === 'fixed') { changed++; console.log(`🔧 ${target} · ${detail}`); }
  else { failed++; console.log(`❌ ${target} · ${detail}`); }
}

/* ---------------------------------------------------------------------------
 * 1. Tauri 两份配置的 csp / devCsp
 *    注意：tauri 的 --config 是 JSON Merge Patch 合并而不是替换，
 *    所以主配置的 csp 会一直生效到 Vite 产物上 —— 覆盖层必须显式再写一遍。
 *
 *    csp     → 注入到「构建产物」的 HTML，生产态唯一生效的策略，只能是基线。
 *    devCsp  → 注入到「开发态」的 HTML（未设置时 Tauri 回退用 csp）。
 *              dev 放行项（localhost:1420 / ws）只出现在这里，不进生产。
 * -------------------------------------------------------------------------*/
function syncTauriCsp() {
  const cases = [
    { file: TAURI_CONFIGS.main, csp: CSP.base, devCsp: null, label: '无构建模式' },
    { file: TAURI_CONFIGS.vite, csp: CSP.base, devCsp: CSP.dev, label: 'Vite 模式' },
  ];

  for (const { file, csp, devCsp, label } of cases) {
    const abs = path.join(PROJECT_ROOT, 'src-tauri', file);
    const target = rel(abs);
    const json = readJson(abs);
    json.app ??= {};
    json.app.security ??= {};

    /* dangerousDisableAssetCspModification 一并维护：它是 CSP 能不能按我们
       写的生效的前提（Tauri 注入 nonce/hash 会让 'unsafe-inline' 失效，
       插件 HTML 的内联脚本全被拦）。原因见 config/nexus.config.mjs。 */
    for (const [key, want] of [
      ['csp', csp],
      ['devCsp', devCsp],
      ['dangerousDisableAssetCspModification', DISABLE_ASSET_CSP_MODIFICATION],
    ]) {
      const cur = json.app.security[key] ?? null;
      if (cur === want) {
        report('ok', target, `${key} 与共享源一致（${label}）`);
        continue;
      }
      if (CHECK_ONLY) {
        report(
          'bad',
          target,
          `${key} 与共享源不一致（${label}）\n   期望: ${want ?? '(不设置)'}\n   实际: ${cur ?? 'null（等于没 CSP）'}`,
        );
        continue;
      }
      if (want === null) delete json.app.security[key];
      else json.app.security[key] = want;
      writeJson(abs, json);
      report('fixed', target, `已写入 ${key}（${label}）`);
    }
  }
}

/* ---------------------------------------------------------------------------
 * 2. Vite 覆盖层的 devUrl（与 vite.config.ts 的 server.port 同源）
 * -------------------------------------------------------------------------*/
function syncDevUrl() {
  const abs = path.join(PROJECT_ROOT, 'src-tauri', TAURI_CONFIGS.vite);
  const target = rel(abs);
  const json = readJson(abs);
  json.build ??= {};
  const cur = json.build.devUrl;

  if (cur === DEV_URL) {
    report('ok', target, `devUrl 与共享源一致（${DEV_URL}）`);
    return;
  }
  if (CHECK_ONLY) {
    report('bad', target, `devUrl 与共享源不一致\n   期望: ${DEV_URL}\n   实际: ${cur ?? '(缺失)'}`);
    return;
  }
  json.build.devUrl = DEV_URL;
  writeJson(abs, json);
  report('fixed', target, `已写入 devUrl（${DEV_URL}）`);
}

/* ---------------------------------------------------------------------------
 * 3. 两个入口 HTML 的 CSP meta
 *    无构建模式的 index.html 由浏览器直接打开，meta 是唯一保护；
 *    Vite 模式的 index.react.html 在 dev 下由 vite 提供、Tauri 不注入 header，
 *    meta 同样是唯一保护 —— 所以两处都要有，且都要与共享源一致。
 * -------------------------------------------------------------------------*/
const META_RE = /([ \t]*)<meta\s+http-equiv="Content-Security-Policy"[^>]*?\/?>/is;

function cspMeta(indent, csp) {
  return `${indent}<meta http-equiv="Content-Security-Policy"\n${indent}      content="${csp}" />`;
}

function syncHtmlMeta() {
  const cases = [
    { file: ENTRIES.vanilla, csp: CSP.base },
    { file: ENTRIES.react, csp: CSP.dev },
  ];

  for (const { file, csp } of cases) {
    const abs = path.join(PROJECT_ROOT, file);
    const target = rel(abs);
    const src = read(abs);
    const hit = src.match(META_RE);
    const want = cspMeta(hit ? hit[1] : '  ', csp);

    if (hit) {
      if (hit[0] === want) { report('ok', target, 'CSP meta 与共享源一致'); continue; }
      if (CHECK_ONLY) {
        report('bad', target, `CSP meta 与共享源不一致\n   期望: ${csp}\n   实际: ${hit[0].replace(/\s+/g, ' ')}`);
        continue;
      }
      fs.writeFileSync(abs, src.replace(META_RE, want));
      report('fixed', target, '已按共享源重写 CSP meta');
      continue;
    }

    // 缺失：插到 viewport 之后（退化顺序：viewport → title → charset）
    const anchor =
      src.match(/[ \t]*<meta\s+name="viewport"[^>]*>/i) ??
      src.match(/[ \t]*<title>/i) ??
      src.match(/[ \t]*<meta\s+charset="[^"]*"[^>]*>/i);

    if (CHECK_ONLY) {
      report('bad', target, '缺少 CSP meta（React 模式下插件可加载任意外链脚本）');
      continue;
    }
    const indent = anchor ? anchor[0].match(/^[ \t]*/)[0] : '  ';
    const block =
      `${indent}<!-- CSP 由 config/nexus.config.mjs 生成，改策略请改那里再跑 npm run config:sync -->\n` +
      cspMeta(indent, csp);
    const next = anchor
      ? src.replace(anchor[0], `${anchor[0]}\n${block}`)
      : src.replace(/([ \t]*)<head>/i, `$&`);
    fs.writeFileSync(abs, next);
    report('fixed', target, '已插入 CSP meta');
  }
}

/* ---------------------------------------------------------------------------
 * 4. vite.config.ts 是否真的用了共享源（防止又有人在配置里硬编码一份）
 * -------------------------------------------------------------------------*/
function checkViteUsesShared() {
  const abs = path.join(PROJECT_ROOT, 'vite.config.ts');
  const src = read(abs);
  const usesShared = /config\/nexus\.config\.mjs/.test(src);
  const hardcodesPort = new RegExp(`port:\\s*(?!DEV_SERVER)${DEV_SERVER.port}`).test(src);

  if (!usesShared) report('bad', rel(abs), '没有引用 config/nexus.config.mjs（配置又分叉了）');
  else if (hardcodesPort) report('bad', rel(abs), `硬编码了端口 ${DEV_SERVER.port}，应改用 DEV_SERVER.port`);
  else report('ok', rel(abs), '已从共享源读取配置');
}

/* ---------------------------------------------------------------------------
 * 5. package.json 的 tauri 脚本是否带着 Vite 覆盖层
 * -------------------------------------------------------------------------*/
function checkTauriScripts() {
  const abs = path.join(PROJECT_ROOT, 'package.json');
  const pkg = readJson(abs);
  const bad = [];
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    if (!/^tauri:(dev|build)$/.test(name)) continue;
    if (!cmd.includes(`--config src-tauri/${TAURI_CONFIGS.vite}`)) bad.push(name);
  }
  if (bad.length) report('bad', rel(abs), `${bad.join(' / ')} 没有带 --config src-tauri/${TAURI_CONFIGS.vite}`);
  else report('ok', rel(abs), 'tauri 脚本均指向 Vite 覆盖层');
}

/* --------------------------------------------------------------------------*/
console.log(`— 配置${CHECK_ONLY ? '检查' : '同步'}（源：config/nexus.config.mjs）—`);
syncTauriCsp();
syncDevUrl();
syncHtmlMeta();
checkViteUsesShared();
checkTauriScripts();

if (CHECK_ONLY) {
  if (failed) {
    console.log(`\n✗ ${failed} 处与共享源不一致，跑 npm run config:sync 修复`);
    process.exit(1);
  }
  console.log('\n✓ 全部一致');
} else {
  console.log(changed ? `\n✓ 已更新 ${changed} 处` : '\n✓ 无需改动');
}
