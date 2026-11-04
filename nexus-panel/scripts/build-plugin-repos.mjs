#!/usr/bin/env node
/**
 * 12 个 iframe 插件 → 12 个「可独立构建 / 独立发版」仓库的文件清单。
 *
 * 关键设计：骨架目录结构**镜像主仓**，插件源码原样放在 plugins/<id>/ 下，
 * 共享依赖按原路径摆在 js/ css/ src/。于是插件里所有 ../../js/xxx、
 * ../../../css/xxx 相对引用一行都不用改 —— 独立仓库里它们照样解析得到。
 *
 * 这是过渡形态：共享文件在 13 个仓库里各一份，靠
 * scripts/verify-plugin-repos.mjs 逐仓逐文件比对 git blob sha，漂移即红
 * （联网探针，不进 CI；网络故障单独判，不冒充通过）。
 * 等 @nexus/plugin-sdk 包落地后收敛成一条 import。
 * 不现在抽包，是因为 plugin-sdk.js 自身还 import tauri-core / runtime-deps /
 * invoke-policy / owned / plugin-fs，闭包不小；抽包是大重构，不该和拆仓绑一起。
 *
 * 本文件既是 CLI 也是模块：create-plugin-repos.mjs 直接 import 它拿清单推 GitHub，
 * 不必先在本地落 12 份物理副本（慢盘上 2000 次小文件写入会拖到超时）。
 *
 * CLI：
 *   node scripts/build-plugin-repos.mjs [--out /abs/dir] [--check] [--only id1,id2]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');           // nexus-panel/
export const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const read = p => fs.readFileSync(p);

/** 12 个可安装插件 = 有 nexus.plugin.json 的（home/settings/store 是 module 外壳） */
export const IDS = fs.readdirSync(path.join(ROOT, 'plugins'))
  .filter(d => fs.existsSync(path.join(ROOT, 'plugins', d, 'nexus.plugin.json')))
  .sort();

/**
 * 仓库名：nexusPanel_plugin_<驼峰 id>，全部私有。
 *
 * ⚠️ 只改「仓库名」，不要改「产物名」：
 *   js/plugin-store-client.js 的 ASSET_PREFIX 固定为 'nexus-plugin-'，
 *   release.yml 拼的是 `nexus-plugin-${ID}-${VER}.tar.gz`（ID 取自 manifest.id，
 *   与仓库名无关）。把产物前缀跟着仓库一起改，宿主 pickAsset 会认不出
 *   release asset，表现为「装了却永远找不到产物」且不报具体原因。
 *   新增插件时必须同步补这张表，否则 fail-closed 拒绝建仓。
 */
const CAMEL = {
  'agent-flow': 'agentFlow',
  'color-picker': 'colorPicker',
  'demo-iframe': 'demoIframe',
  'demo-light': 'demoLight',
  'demo-react': 'demoReact',
  'demo-service': 'demoService',
  'dupview': 'dupview',
  'icon-picker': 'iconPicker',
  'md-editor': 'mdEditor',
  'mindmap': 'mindmap',
  'project-group': 'projectGroup',
  'task-board': 'taskBoard',
};
export function repoNameFor(id) {
  const c = CAMEL[id];
  if (!c) throw new Error(`未登记的插件 id: ${id}（新增插件须同步补 CAMEL 映射）`);
  return `nexusPanel_plugin_${c}`;
}

/** 共享依赖 = 整目录镜像 js/ css/ src/（70 文件 / 1.18 MB）。不做 import 闭包 BFS：
 *  精确收集容易漏（src/nexus-react 是文件不是目录，早期版本漏过）；
 *  整份镜像既不会漏，也让「逐字节一致」守卫口径最简单。
 */
export function collectShared() {
  const out = [];
  for (const base of ['js', 'css', 'src']) {
    const root = path.join(ROOT, base);
    if (!fs.existsSync(root)) continue;
    const walk = d => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'assets', '__pycache__'].includes(e.name)) continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) out.push(path.relative(ROOT, p).replace(/\\/g, '/'));
      }
    };
    walk(root);
  }
  return out.sort();
}
export const SHARED = collectShared();

/** 单个插件仓库的完整文件清单 { relPath: Buffer } */
export function skeletonFiles(id) {
  const files = {};
  const srcdir = path.join(ROOT, 'plugins', id);
  const cp = (d, prefix) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.tmp-'].some(x => e.name.startsWith(x))) continue;
      const p = path.join(d, e.name);
      const rel = prefix + e.name;
      if (e.isDirectory()) cp(p, rel + '/');
      else if (e.isFile()) files[rel] = read(p);
    }
  };
  cp(srcdir, `plugins/${id}/`);
  for (const rel of SHARED) {
    const p = path.join(ROOT, rel);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) files[rel] = read(p);
  }

  const manifest = JSON.parse(read(path.join(srcdir, 'nexus.plugin.json')).toString('utf8'));
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')).toString('utf8'));
  const repoName = repoNameFor(id);
  const version = manifest.version || '0.1.0';

  files['nexus.plugin.json'] = Buffer.from(JSON.stringify({
    ...manifest,
    repo: `adwlachowicz684-star/${repoName}`,
    ref: `v${version}`,
  }, null, 2) + '\n');

  files['package.json'] = Buffer.from(JSON.stringify({
    name: repoName, version, private: true, type: 'module',
    description: manifest.description || `${manifest.name || id} · nexus-panel 独立插件仓库`,
    scripts: { 'build:plugin': 'vite build' },
    dependencies: pkg.dependencies || {},
    devDependencies: pkg.devDependencies || {},
  }, null, 2) + '\n');

  const lock = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lock)) files['package-lock.json'] = read(lock);

  files['vite.config.mjs'] = Buffer.from(`// 单插件构建：入口固定在 plugins/${id}/index.html，产物落到 dist/
// 目录结构镜像主仓，故源码里 ../../js/xxx 等相对引用原样有效。
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root: path.join(root, 'plugins/${id}'),
  base: './',
  plugins: [react()],
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: { input: path.join(root, 'plugins/${id}', 'index.html') },
  },
});
`);

  files['.gitignore'] = Buffer.from('node_modules/\ndist/\n*.log\n.part/\n*.part\n*.part.json\n.DS_Store\n');
  files['README.md'] = Buffer.from(`# ${manifest.name || id}

nexus-panel 独立插件仓库（id: \`${id}\`）。

- 构建：\`npm ci && npm run build:plugin\` → \`dist/\`
- 发版：推 \`v${version}\` tag，\`.github/workflows/release.yml\` 自动产出
  \`nexus-plugin-${id}-<ver>.tar.gz\` 并回读 \`digest\` / \`state\`
- 安装：主面板「插件市场」输入 \`adwlachowicz684-star/${repoName}\` 即可，
  用户侧**不需要 node / npm**

> \`js/ css/ src/\` 是主仓共享依赖的镜像副本，一致性由**主仓**的
> \`scripts/verify-plugin-repos.mjs\` 逐仓逐文件核验（本仓库内没有该脚本）。
> 不要在这里单独改它们 —— 改主仓，再重跑生成器与建仓脚本。
`);

  const tpl = path.join(ROOT, 'templates', 'plugin-repo', 'release.yml');
  if (fs.existsSync(tpl)) files['.github/workflows/release.yml'] = read(tpl);
  return files;
}

/** 本地落盘（增量：内容相同则跳过，避免慢盘重复写） */
export function writeSkeleton(id, outDir) {
  const dir = path.join(outDir, repoNameFor(id));
  const files = skeletonFiles(id);
  let written = 0, skipped = 0;
  for (const [rel, buf] of Object.entries(files)) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p) && sha(read(p)) === sha(buf)) { skipped++; continue; }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, buf);
    written++;
  }
  return { total: Object.keys(files).length, written, skipped, dir };
}

// ---------- CLI ----------
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const arg = (k, def) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : def; };
  const OUT = path.resolve(arg('--out', path.resolve(ROOT, '..', 'plugin-repos')));
  const CHECK = process.argv.includes('--check');
  const ONLY = arg('--only', null);
  const ids = ONLY ? ONLY.split(',').filter(x => IDS.includes(x)) : IDS;

  let bad = 0, total = 0, written = 0, skipped = 0;
  for (const id of ids) {
    const r = writeSkeleton(id, OUT);
    total += r.total; written += r.written; skipped += r.skipped;
    if (CHECK) {
      // --check 语义：全部文件已存在且逐字节一致，否则报错
      if (r.written > 0) { console.log(`  DIFF ${repoNameFor(id)}: ${r.written} 个文件需更新`); bad += r.written; }
    } else {
      console.log(`  ${id}: ${r.total} 文件（写 ${r.written} / 跳过 ${r.skipped}）`);
    }
  }
  console.log(`${CHECK ? '校验' : '生成'}完成：${ids.length} 仓 / ${total} 文件 / 共享 ${SHARED.length} 项` +
    (CHECK ? (bad ? ` ❌ ${bad} 处不一致` : ' ✅ 全部一致') : ` → ${OUT}`));
  process.exit(CHECK && bad ? 1 : 0);
}
