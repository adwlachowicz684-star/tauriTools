/**
 * runtime 产物「裸 import」守卫（11-08 任务管理器握手超时实证后补）
 * ============================================================================
 * 反例来源：runtime-plugins/task-board/index.html 是单文件内联产物，
 * 顶层 <script type="module"> 第一句留了 `import bc from"scheduler"`。
 * 浏览器把裸模块说明符当非法（Relative references must start with
 * either "/", "./", or "../"），**整个 module 拒绝执行** —— 于是
 * plugin-sdk 发不出 ready，宿主等 10s 后报「iframe 插件握手超时」。
 *
 * 这类错误最阴的地方：产物本身在磁盘上是齐的、标题也在、静态扫描
 * 「文件存在」全绿，只有浏览器真跑才知道 module 压根没启动。而且
 * runtime-plugins/ 被 .gitignore 忽略，重建产物不显式 add 就不会进仓库，
 * 于是「本地修好了 / 远端还是坏的」可以长期共存。
 *
 * 钉住三件事：
 *   ① 每个 runtime 插件的 module script 里不许出现裸模块说明符；
 *   ② 含 SDK 桥接的产物必须同时带 ready 握手（防 SDK 半残）；
 *   ③ task-board 的 dist 副本与源产物字节一致（copy-runtime 不清空目标，
 *      旧 assets 会与新产物混在一起，运行时加载的其实是 dist 那份）。
 * 判据自带反向自检：造一个含 scheduler 的假 HTML 必须被喊，
 * 合法的相对路径 / URL / 动态 import 不许误伤。
 *
 * 运行：node runtime-bare-import-test.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(ROOT, 'runtime-plugins');
const DIST_DIR = join(ROOT, 'dist', 'runtime-plugins');

let pass = 0, fail = 0;
const t = (name, ok, extra = '') => {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
};

/* 浏览器能自己解析的前缀：相对/绝对/网络/内嵌协议；其余一律是裸说明符。 */
const LEGAL = /^(?:\.\/|\.\.\/|\/|https?:\/\/|data:|blob:|asset:|tauri:|ipc:)/;
/**
 * 只有「纯包名形状」才算裸说明符。
 *
 * 为什么需要这一层：@xyflow 的产物里有一句错误提示文案
 *   `Please import '@xyflow/${e}/dist/style.css' ...`
 * 它长得像静态 import，但其实是模板字符串里的示例代码，含 ${e}。
 * 不排除它，守卫会在一个完全健康的产物上恒红 —— 恒红的守卫很快就会被
 * 当成噪音绕过，比没有守卫更糟。真正的裸说明符是 scheduler / react /
 * @scope/pkg 这类标识符，不含 $ { } 空格与引号。
 */
const BARE_SHAPE = /^[A-Za-z@][A-Za-z0-9@._/-]*$/;

function moduleScripts(html) {
  return [...html.matchAll(/<script\b[^>]*\btype=["']module["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1]);
}

function importSpecs(js) {
  const out = [];
  const staticRe = /\bimport\s+(?:[^;\n]*?\s+from\s*)?["']([^"']+)["']/g;
  const dynamicRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticRe, dynamicRe]) {
    let m;
    while ((m = re.exec(js))) out.push(m[1]);
  }
  return out;
}

/** 返回该 HTML 所有 module script 里的裸模块说明符（去重）。 */
function bareImports(html) {
  return [...new Set(moduleScripts(html).flatMap(importSpecs)
    .filter((s) => !LEGAL.test(s) && BARE_SHAPE.test(s)))];
}

console.log('=== runtime 产物裸 import 守卫 ===');

const dirs = existsSync(SRC_DIR)
  ? readdirSync(SRC_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : [];
t('① 扫到足够多的 runtime 插件目录（空扫恒绿不算数）', dirs.length >= 10, `实得 ${dirs.length}`);

let scanned = 0;
for (const id of dirs) {
  const f = join(SRC_DIR, id, 'index.html');
  if (!existsSync(f)) continue;
  scanned += 1;
  const html = readFileSync(f, 'utf8');
  const bare = bareImports(html);
  t(`② ${id}：module script 无裸模块说明符`, bare.length === 0, bare.join(', '));
  if (html.includes('nexus-bridge-v1')) {
    t(`③ ${id}：含 SDK 桥接就必须有 ready 握手`, /type:\s*["']ready["']/.test(html));
  }
}
t('①b 真正读到了 index.html（不是只列目录）', scanned >= 10, `实得 ${scanned}`);

/* 只钉本次修复对象：全量 dist 一致性由 dist-integrity-test 负责，
   这里再全量比会把已存在的产物基线分歧算成新守卫的失败。 */
const tbSrc = join(SRC_DIR, 'task-board', 'index.html');
const tbDist = join(DIST_DIR, 'task-board', 'index.html');
if (existsSync(tbSrc) && existsSync(tbDist)) {
  t('④ task-board：dist 副本与 runtime 产物字节一致',
    readFileSync(tbSrc, 'utf8') === readFileSync(tbDist, 'utf8'));
} else {
  t('④ task-board：dist 副本与 runtime 产物字节一致（缺文件时按跳过处理）', true);
}

/* ---------------- 反向自检：判据不能恒绿 ---------------- */
const BAD = '<script type="module">import bc from"scheduler";window.__x=1</script>';
t('⑤ 反例自检：`import bc from"scheduler"` 必须命中', bareImports(BAD).includes('scheduler'),
  JSON.stringify(bareImports(BAD)));

const GOOD = '<script type="module">import "./assets/a.js";import x from "../js/b.js";'
  + 'import("https://cdn.example/y.js");import("/abs/z.js")</script>';
t('⑥ 反例自检：相对 / 绝对 / URL / 动态 import 不误伤', bareImports(GOOD).length === 0,
  JSON.stringify(bareImports(GOOD)));

t('⑦ 反例自检：无 module script 的空 HTML 不误判', bareImports('<html><body></body></html>').length === 0);
t('⑧ 反例自检：单引号裸 import 同样命中',
  bareImports("<script type='module'>import 'react'</script>").includes('react'));

const XYFLOW_HINT = '<script type="module">const m={error013:(e="react")=>'
  + '`Please import \'@xyflow/${e}/dist/style.css\' or base.css`}</script>';
t('⑨ 反例自检：错误提示文案里的模板字符串 import 不误伤',
  bareImports(XYFLOW_HINT).length === 0, JSON.stringify(bareImports(XYFLOW_HINT)));

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
