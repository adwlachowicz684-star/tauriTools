/**
 * copy-runtime.mjs —— 把独立构建的 runtime-plugins/ 拷进 dist/。
 *
 * 为什么需要：runtime 插件（mindmap/dupview/settings/...）由
 * scripts/build-plugins.mjs 独立构建到仓库根的 runtime-plugins/<id>/，
 * 而生产态外壳页面跑在 tauri.localhost（frontendDist = dist/）源下。
 * 曾经用 convertFileSrc 把插件页转成 asset.localhost 的 iframe src，
 * 连踩三个坑（2026-10-24 全数实机复现）：
 *   ① convertFileSrc 把路径分隔符编成 %2F，浏览器解析相对 URL 时不当
 *      分隔符 → 页面内 ./assets/*.js 全解析到协议根 → asset scope 403；
 *   ② asset 协议的 ACAO 写死外壳 origin，而 ES module script 强制 CORS
 *      模式 → module 下载 200 但拒绝执行（无 console 报错，极难排查）；
 *   ③ iframe 跨源后 contentDocument 恒为 null，空页面检测退化成超时等待。
 * 现在让 dist/ 直接内含 runtime-plugins/，iframe 走同源相对路径 ——
 * CORS / 编码 / 跨源三类问题一次性消失，回到最朴素的 Web 同源行为。
 *
 * 运行时机：必须在 vite build（清空 dist/）之后 —— package.json 的
 * build 脚本已按此顺序串联。
 */
/* 只用逐文件的 readFileSync / writeFileSync / mkdirSync —— 绝不碰 fs 的
   整目录拷贝 API，也不碰任何删除类 API。本机 node 挂了进程级 safe-delete
   shim（NODE_OPTIONS 注入），整目录拷贝与删除类 API 会让它直接终止进程
   （exit 127，且没有任何输出，极难定位）。这里本来也不需要删：dst 在
   dist/ 里，vite build 每次都会重建 dist/，我们跑在它之后，覆盖写入即可。 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const src = resolve(root, 'runtime-plugins');
const dst = resolve(root, 'dist', 'runtime-plugins');

if (!existsSync(src)) {
  console.error('[copy-runtime] runtime-plugins/ 不存在，先跑 scripts/build-plugins.mjs');
  process.exit(1);
}
let files = 0;
/** 手递递归拷贝（为什么不用现成的整目录拷贝，见文件头注释）。 */
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    const f = join(from, name);
    const t = join(to, name);
    if (statSync(f).isDirectory()) copyDir(f, t);
    else { writeFileSync(t, readFileSync(f)); files += 1; }
  }
}
copyDir(src, dst);
console.log(`[copy-runtime] ${src} -> ${dst}（${files} 个文件）`);
