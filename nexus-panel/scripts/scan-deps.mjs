#!/usr/bin/env node
/**
 * 依赖盘点 —— 生成 js/deps-manifest.js
 * ------------------------------------------------------------
 * 用法：node scripts/scan-deps.mjs [--check] [--quiet]
 *
 * 【为什么是"构建期生成清单"，而不是运行时去读 package.json】
 * 打包后的应用里**没有** package.json，也没有 node_modules：
 * 前端依赖早被 Vite 打进产物了。所以运行时再去读文件，
 * 在 dev 下看起来正常、打包后变成"列表永远为空且不报错"。
 * 清单在构建期生成、随源码一起进产物，两种模式下读到的都是同一份。
 *
 * 【它真正要抓的那类问题】
 * 本项目反复出现的一种失效：**源码里 import 了，但 package.json 里没有**。
 *   · mermaid 装了却没写进 package.json → 别人 clone 后图表渲染失败
 *   · @plantuml/core 被同步覆盖掉 → PlantUML 图一直转圈，控制台只有一句警告
 * 这类问题的特点是不报错、不红、界面退化但不崩 —— 只有"声明 vs 实际"
 * 摆在一起对照才看得出来。
 *
 * 【共享依赖目录必须识别出来（depsDir:'shared'）】
 * 有一类环境里 node_modules 是指向全局目录的**软链接**：
 * 里面的版本跟本仓库毫无关系（例如读到 react 19，而项目要的是 ^18）。
 * 照常读就会把全部依赖判成"版本不符/缺失"，而实际上只是**没法判定** ——
 * 一堆假红比没有这个页签更糟，会让人去改根本没问题的版本号。
 * 所以软链接一律不读，状态记 unknown，并在界面上说明原因。
 *
 * 【精确锁定（pinned）为什么单独标】
 * @plantuml/core 1.2026.6 起才是 MIT，低版本是 GPL-3.0-or-later。
 * 一旦被改成 ^1.2026.8，大版本不变但可能解析到低版本，
 * 整个项目被拖进 copyleft —— 而 npm install 不会有任何提示。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripCommentsJs } from '../test-scan-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

/** 需要额外说明的包：写清"错了会怎样"，而不是只写"注意"。 */
const NOTES = {
  '@plantuml/core': '≥1.2026.6 才是 MIT，低版本是 GPL-3.0-or-later —— 必须精确锁定，不能加 ^',
  mermaid: 'mermaid + PlantUML 都用它；被 npm install 裁掉过一次，丢了的表现是图渲染失败',
  'react-markdown': 'MD 渲染核心；不带它 md 与 md-render 两个入口一起失效',
  '@tauri-apps/api': '与 Cargo 侧的 tauri 必须同为 2.x，跨大版本会有静默的类型漂移',
};

/** 不参与"未声明"判定的伪包名 */
const FILEISH = /\.(css|html|json|svg|png|jpe?g|gif|txt|md|woff2?|ttf|wasm)$/i;
/*
 * 包名：**允许带子路径**。
 * 只认一级（`@scope/name`）的话，`@tauri-apps/api/core`、`@plantuml/core/plantuml.js`
 * 这类带子路径的写法会被判成"不是包名"而整个丢掉 ——
 * 表现是：依赖明明在用，却被列成"未被引用"，进而被当成可以删的
 * （`@tauri-apps/api` 就这么被误判过一次）。
 */
const VALID_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(\/[a-z0-9._~-]+)*$/i;

/** node 内置模块：不参与"未声明"判定（否则 fs / path 会被列成缺失依赖） */
const BUILTIN = new Set([
  'fs', 'path', 'url', 'os', 'crypto', 'child_process', 'util', 'events',
  'stream', 'assert', 'buffer', 'zlib', 'http', 'https', 'net', 'tty',
  'module', 'process', 'worker_threads', 'timers', 'string_decoder', 'querystring',
]);

/** 目录不参与扫描：产物、依赖、备份、沙箱临时目录 */
const SKIP_DIR = new Set([
  'node_modules', 'dist', '.git', 'target', 'coverage', '.vite', 'build',
]);
const skipDir = (n) => SKIP_DIR.has(n) || n.startsWith('_');

const EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx']);
/** 生成的文件本身不参与扫描，否则它自己会成为"使用者" */
const SELF = 'js/deps-manifest.js';

function walk(dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!skipDir(e.name)) walk(p, out); continue; }
    if (!EXTS.has(path.extname(e.name))) continue;
    const rel = path.relative(ROOT, p).split(path.sep).join('/');
    if (rel === SELF) continue;
    out.push(rel);
  }
  return out;
}

function rootFiles() {
  let ents = [];
  try { ents = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return []; }
  return ents.filter((e) => e.isFile() && EXTS.has(path.extname(e.name)))
    .map((e) => e.name).filter((n) => n !== SELF);
}

/** 取裸模块名：'@a/b/c' → '@a/b'，'react-dom/client' → 'react-dom' */
function pkgOf(spec) {
  let s = String(spec || '').trim();
  if (!s) return '';
  if (s.startsWith('node:')) return '';          // 内置模块，不参与判定
  if (s.startsWith('.') || s.startsWith('/')) return '';
  if (/^[a-z]+:\/\//i.test(s)) return '';        // URL
  if (/[\\${\s]/.test(s)) return '';             // 模板串 / 转义，不是包名
  /* 去查询串与 hash：`@plantuml/core/viz-global.js?url` 是 Vite 的
     "取资源地址"写法，?url 不是包名的一部分，不去就会被判成非法而漏掉整条。 */
  s = s.split('?')[0].split('#')[0];
  if (!VALID_NAME.test(s)) return '';
  const last = s.split('/').pop() ?? '';
  if (FILEISH.test(last)) return '';
  const seg = s.split('/');
  const name = s.startsWith('@') ? seg.slice(0, 2).join('/') : seg[0];
  return BUILTIN.has(name) ? '' : name;
}

/**
 * 抽 import 目标。
 * 只认三种写法：静态 import/export ... from 'x'、裸 import 'x'、require('x') /
 * import('x')。刻意不扫任何字符串字面量的包名 —— 那样会把注释、文案、
 * 清单里的名字全算成"使用者"，假阳性比漏报更难排查。
 */
/**
 * 扫描前先剥注释。
 * 不剥的话，注释里举例写的 `from 'x'` 会被当成真实 import，
 * 于是冒出一批根本不存在的"未声明依赖"（本项目自己的脚本注释就踩到了）。
 */
/* 剥注释改用共用实现（../test-scan-utils.mjs）。
   原来内联那份的行注释判据是 (^|[^:])，比共用实现的 (^|\s) 宽松 ——
   `a//b` 这种写法会被它当成注释开头，把后半行吞掉；
   扫 import 时吞掉的可能是有效代码，会漏掉真实声明。 */

function importsOf(raw) {
  const src = stripCommentsJs(raw);
  const out = new Set();
  /* 每个分支前面的 `(?<![/\w])` 是刻意加的：
     正则/字符串字面量里**举例**写的 `from 'x'` 会被当成真实 import。
     实例：plugin-admit-test.mjs 那句
       `!/from 'acorn'|from 'esbuild'/.test(admit_src)`
     让清单凭空多出一条"未声明依赖 acorn"，而全仓**没有任何一行**真的
     import 过 acorn —— 照着这条去 `npm i acorn`，等于给项目加一个
     永远没人用的依赖，而且下次谁清理依赖都会觉得"有人在用它"。
     真代码里 import / from / require 前面不会紧跟 `/`，所以这个反向
     断言只会砍掉假阳性，不会漏掉真 import。 */
  const re = /(?:(?<![/\w])from\s*|(?<![/\w])import\s*\(\s*|(?<![/\w])import\s+|(?<![/\w])require\s*\(\s*|(?<![/\w])export\s+\*\s+from\s*)['"]([^'"\n]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const name = pkgOf(m[1]);
    if (!name) continue;
    out.add(name);
  }
  return out;
}

/**
 * 抽**运行时取用点**：ctx.requireDep('mermaid', { ... })
 * ------------------------------------------------------------
 * 它和 importsOf 是两回事，不能混：
 *   · importsOf  → 构建期就打进产物的那份（静态 import）
 *   · 这里       → 运行时从工具内部 deps/ 目录动态取的那份
 *
 * 【为什么必须单独扫出一列】
 * 依赖页签上有「安装」按钮，装的是运行时那份。而目前只有 mermaid 真有
 * 插件用 requireDep 去取 —— 其余包（rehype-highlight / rehype-slug /
 * remark-gfm 这些渲染管线包）装进去**没有任何代码会去读它**：
 * 界面显示"已安装并验证可加载"，而渲染行为一点没变。
 * 这种"装成功但没效果"是最难自查的一类 —— 它不报错、不红。
 * 所以要把"有没有运行时消费方"扫出来摆在界面上，而不是让人猜。
 *
 * 【必须先剥注释】
 * js/plugin-sdk.js 的用法示例注释里正好写着 `ctx.requireDep('mermaid', ...)`。
 * 不剥注释，"外壳"就会被记成 mermaid 的运行时消费方，
 * 于是"扫不出真消费方"这类失效会被这条假阳性永久掩盖。
 *
 * 【为什么只认字符串字面量第一参】
 * 测试里 `rt.requireDep(ctx, 'mermaid', ...)` 的第一参是 ctx，不是包名；
 * 只匹配引号开头的第一参，天然不会把测试算成消费方。
 */
function runtimeDepsOf(raw) {
  const src = stripCommentsJs(raw);
  const out = new Set();
  const re = /\brequireDep\s*\(\s*['"`]([^'"`\n]+)['"`]/g;
  let m;
  while ((m = re.exec(src))) {
    const name = pkgOf(m[1]);
    if (!name) continue;
    out.add(name);
  }
  return out;
}

/** 归属：哪个插件在用。用于回答"这条依赖到底是谁要的"。 */
function ownerOf(rel) {
  if (rel.startsWith('plugins/')) {
    const id = rel.split('/')[1];
    return id === 'settings' ? '设置' : (id || '?');
  }
  if (rel.startsWith('js/') || rel.startsWith('src/')) return '外壳';
  return '测试/脚本';
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/**
 * node_modules 是不是"别人的"：软链接指向仓库外的全局目录时，
 * 里面装的版本与本仓库无关，读了就是一堆假红。
 */
function depsDir() {
  const p = path.join(ROOT, 'node_modules');
  try {
    const st = fs.lstatSync(p);
    if (!st.isSymbolicLink()) return 'local';
    return 'shared';
  } catch {
    return 'absent';
  }
}

const cmp = (a, b) => {
  const pa = String(a).split('-')[0].split('.').map((n) => Number(n) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x - y; }
  return 0;
};

/** 极简 satisfies：只认 ^ ~ >= 与精确值；认不准就当满足，绝不误报红 */
function satisfies(decl, inst) {
  if (!decl || !inst) return true;
  const d = String(decl).trim();
  if (d === '*' || d === '') return true;
  const base = d.replace(/^[\^~>=<\s]*/, '');
  if (!/^\d/.test(base) || !/^\d/.test(String(inst))) return true;
  if (d === base) return cmp(inst, base) === 0;
  if (d.startsWith('^')) return String(inst).split('.')[0] === base.split('.')[0] && cmp(inst, base) >= 0;
  if (d.startsWith('~')) {
    return String(inst).split('.').slice(0, 2).join('.') === base.split('.').slice(0, 2).join('.') && cmp(inst, base) >= 0;
  }
  if (d.startsWith('>=')) return cmp(inst, base) >= 0;
  return true;
}

/**
 * Cargo：取 [dependencies] 与 [target.'cfg(...)'.dependencies] 两段。
 * 两种写法都要认：
 *   name = "2"                                  ← 少了这条会漏掉一大半 crate
 *   name = { version = "2", features = [...] }
 * 平台段里的同名 crate 合并成一条并标平台，否则 keyring 会显示三遍。
 */
function cargoDeps() {
  const txt = (() => { try { return fs.readFileSync(path.join(ROOT, 'src-tauri/Cargo.toml'), 'utf8'); } catch { return ''; } })();
  const map = new Map();
  let section = null;
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      if (line === '[dependencies]') section = { plat: null };
      else {
        const m = line.match(/^\[target\.'cfg\(target_os = "([a-z]+)"\)'\.dependencies\]$/);
        section = m ? { plat: m[1] } : null;
      }
      continue;
    }
    if (!section || !line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const [, name, rest] = m;
    let declared = null;
    const vObj = rest.match(/version\s*=\s*"([^"]+)"/);
    if (vObj) declared = vObj[1];
    else {
      const vStr = rest.match(/^\s*"([^"]+)"\s*$/);
      if (vStr) declared = vStr[1];
    }
    if (!declared) continue; // path / git 依赖，本项目没有
    const prev = map.get(name);
    if (prev) {
      if (section.plat && !prev.platform.includes(section.plat)) prev.platform.push(section.plat);
      continue;
    }
    map.set(name, { name, declared, platform: section.plat ? [section.plat] : [] });
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function build() {
  const dirKind = depsDir();
  const shared = dirKind !== 'local';
  const pkg = readJson(path.join(ROOT, 'package.json')) ?? {};
  const declared = { ...(pkg.dependencies ?? {}) };
  const devDeclared = { ...(pkg.devDependencies ?? {}) };

  const files = [
    ...walk(path.join(ROOT, 'js')),
    ...walk(path.join(ROOT, 'plugins')),
    ...walk(path.join(ROOT, 'src')),
    ...walk(path.join(ROOT, 'scripts')),
    ...rootFiles(),
  ];

  /** name → Set(owner)：构建期静态 import 的使用方 */
  const used = new Map();
  /** name → Set(owner)：运行时 requireDep 的取用方（见 runtimeDepsOf） */
  const rtUsed = new Map();
  for (const rel of files) {
    const src = (() => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } })();
    if (!src) continue;
    const owner = ownerOf(rel);
    for (const name of importsOf(src)) {
      if (!used.has(name)) used.set(name, new Set());
      used.get(name).add(owner);
    }
    for (const name of runtimeDepsOf(src)) {
      if (!rtUsed.has(name)) rtUsed.set(name, new Set());
      rtUsed.get(name).add(owner);
    }
  }
  const rtOwnersOf = (name) => [...(rtUsed.get(name) ?? [])].sort();

  /** 软链接目录下不读版本 —— 读到的是全局那份，与本仓库无关 */
  const installedVer = (name) => {
    if (shared) return null;
    return readJson(path.join(ROOT, 'node_modules', name, 'package.json'))?.version ?? null;
  };

  const npm = [];
  const seen = new Set();
  const push = (name, decl, dev) => {
    if (seen.has(name)) return;
    seen.add(name);
    const inst = installedVer(name);
    const owners = [...(used.get(name) ?? [])].sort();
    let status;
    if (shared) status = owners.length || dev ? 'unknown' : 'unused';
    else if (!inst) status = 'missing';
    else if (!satisfies(decl, inst)) status = 'mismatch';
    else if (!owners.length && !dev) status = 'unused';
    else status = 'ok';
    npm.push({
      name,
      declared: decl ?? null,
      installed: inst,
      dev: !!dev,
      status,
      usedBy: owners,
      runtimeUsedBy: rtOwnersOf(name),
      pinned: !!decl && !/^[\^~>=<*\s]/.test(String(decl)),
      note: NOTES[name] ?? '',
      install: decl ? `npm i ${name}@${decl}${dev ? ' -D' : ''}` : `npm i ${name}`,
    });
  };

  for (const [n, v] of Object.entries(declared)) push(n, v, false);
  for (const [n, v] of Object.entries(devDeclared)) push(n, v, true);

  /* 用了却没声明：单独一类，不混进上面的列表。
     它是唯一一类**靠 npm install 修不好**的：当前 node_modules 里有
     （现在能跑），但 package.json 没写，换台机器 clone 之后才暴露。 */
  const undeclared = [];
  for (const [name, owners] of used) {
    if (seen.has(name)) continue;
    undeclared.push({
      name,
      declared: null,
      installed: shared ? null : installedVer(name),
      dev: false,
      status: 'undeclared',
      usedBy: [...owners].sort(),
      runtimeUsedBy: rtOwnersOf(name),
      pinned: false,
      note: '源码里 import 了，但 package.json 没写 —— 换台机器 clone 后才会暴露',
      install: `npm i ${name}`,
    });
  }
  undeclared.sort((a, b) => a.name.localeCompare(b.name));

  const crates = cargoDeps().map((c) => ({
    name: c.name,
    declared: c.declared,
    installed: null,
    dev: false,
    status: 'ok',
    usedBy: c.platform.length ? c.platform : ['Rust'],
    runtimeUsedBy: [],
    pinned: /^\d/.test(c.declared),
    note: c.platform.length ? '按平台分别指定 feature' : '',
    install: `cargo add ${c.name}@${c.declared}`,
  }));

  const all = [...npm, ...undeclared];
  const summary = {
    total: all.length + crates.length,
    npm: npm.length,
    crates: crates.length,
    missing: npm.filter((d) => d.status === 'missing').length,
    mismatch: npm.filter((d) => d.status === 'mismatch').length,
    unused: npm.filter((d) => d.status === 'unused').length,
    undeclared: undeclared.length,
    unknown: npm.filter((d) => d.status === 'unknown').length,
    ok: npm.filter((d) => d.status === 'ok').length,
  };

  return {
    generatedAt: new Date().toISOString(),
    depsDir: dirKind,
    /**
     * 共享目录下"实装版本"读不准，界面必须把这句说出来：
     * 否则用户看到满屏"未判定"只会认为是页签做坏了。
     */
    dirNote: shared
      ? '当前 node_modules 是共享副本（软链接），里面的版本与本仓库无关，故不判定实装版本'
      : '',
    summary,
    npm,
    undeclared,
    crates,
  };
}

const args = process.argv.slice(2);
const manifest = build();

/*
 * --out <file>：写到别处（默认写 js/deps-manifest.js）。
 * 给**测试**用的：它要重新跑一遍扫描、与已提交的清单比对，
 * 才能同时守住两件事 ——
 *   ① 扫描器坏了（不扫 requireDep 了）
 *   ② 清单忘了重跑（源码加了消费方，清单还是旧的）
 * 只比对已提交的清单，上面两件都测不到：清单是静态文件，
 * 改扫描器不会让它变。
 */
const outArg = args.indexOf('--out');
const OUT = outArg >= 0 ? args[outArg + 1] : path.join(ROOT, SELF);

if (args.includes('--check')) {
  const bad = [...manifest.npm, ...manifest.undeclared].filter(
    (d) => d.status === 'missing' || d.status === 'mismatch' || d.status === 'undeclared');
  if (!args.includes('--quiet')) {
    console.log(`依赖盘点：npm ${manifest.summary.npm} + crate ${manifest.summary.crates}（depsDir=${manifest.depsDir}）`);
    console.log(`  缺失 ${manifest.summary.missing} / 版本不符 ${manifest.summary.mismatch} / 未声明 ${manifest.summary.undeclared} / 未被引用 ${manifest.summary.unused} / 未判定 ${manifest.summary.unknown}`);
    for (const d of bad) console.log(`  [${d.status}] ${d.name} 声明=${d.declared ?? '-'} 实装=${d.installed ?? '-'} 用于=${d.usedBy.join(',')}`);
  }
  process.exit(bad.length ? 1 : 0);
}

const body = `/**
 * 依赖清单 —— **由 scripts/scan-deps.mjs 生成，不要手改。**
 * ------------------------------------------------------------
 * 手改的后果：下次跑 npm run deps:scan 就被覆盖，改的内容无声消失；
 * 而界面上显示的还是旧数字，看起来像"改了没生效"。
 *
 * 数据来源：package.json（声明）+ node_modules 下各包的 package.json（实装）
 *           + 源码 import 扫描（谁在用）+ requireDep 扫描（谁取运行时那份）
 *           + Cargo.toml（Rust 侧）
 *
 * （这里刻意不写 node_modules/<星号>/package.json：星号紧跟斜杠会提前闭合
 *   块注释，整个清单文件直接语法错误，且报错指向文件末尾而不是这行。）
 *
 * 之所以在构建期落盘：打包产物里没有 package.json，也没有 node_modules，
 * 运行时再去读只会得到一份空列表，而且不报错。
 */
export const DEPS_MANIFEST = ${JSON.stringify(manifest, null, 2)};

/** 状态 → 显示文案与语气。界面与测试共用，避免两边各写一套而漂移。 */
export const DEP_STATUS = {
  ok: { label: '已装', tone: 'ok' },
  missing: { label: '缺失', tone: 'err' },
  mismatch: { label: '版本不符', tone: 'warn' },
  unused: { label: '未被引用', tone: 'mute' },
  undeclared: { label: '未声明', tone: 'err' },
  unknown: { label: '未判定', tone: 'mute' },
};

export default DEPS_MANIFEST;
`;
fs.writeFileSync(OUT, body, 'utf8');
if (!args.includes('--quiet')) {
  console.log(`已生成 ${path.relative(ROOT, OUT) || SELF}`);
  console.log(`  npm ${manifest.summary.npm} · crate ${manifest.summary.crates} · 缺失 ${manifest.summary.missing} · 版本不符 ${manifest.summary.mismatch} · 未声明 ${manifest.summary.undeclared} · 未被引用 ${manifest.summary.unused} · 未判定 ${manifest.summary.unknown}`);
}
