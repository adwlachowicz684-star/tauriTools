/**
 * 已安装插件的 iframe src（第 63 轮）
 * ============================================================================
 *
 * 这一支为什么能落地，而不是继续等真机
 * ------------------------------------------------------------
 * 第 61 轮用真实 Chromium 跑过四象限，第 62 轮又从构建链实证
 * release tarball == runtime-plugins/<id>/ 的那份产物（build-plugins.mjs
 * 「已安装正式版 = 把 runtime-plugins/<id> 拷进安装目录」+ release.yml
 * 同目录树打包）。所以「asset 协议下 ES module 只有真机能判」这句
 * 旧定性已经被拆成两半：
 *
 *   · CORS 与跨源握手：有确定答案。内联 bundle 不发跨源 module 请求，
 *     握手走 e.source !== iframe.contentWindow，contentDocument=null
 *     不阻断加载（第 61 轮第三象限真实复现）。
 *   · convertFileSrc 对 $APPDATA 路径生成的编码 URL 能否被 asset 协议
 *     服务：**仍只有真机能判**。所以台账 status 保持 wired、
 *     runtimeVerified 保持 false，本模块不自查自封。
 *
 * 坑①为什么在这里不适用（这是整个方案的支点）
 * ------------------------------------------------------------
 * host.js 的 runtimeFrameUrl 注释记着 2026-10-24 实机复现的三个坑，
 * 其中 ① 是 convertFileSrc 把分隔符编成 %2F，页面里的 ./assets/*.js
 * 会被解析到协议根、被 asset scope 拒成 403。
 *
 * 但那条只对**有外部相对资源**的 HTML 成立。构建期契约由
 * scripts/single-file.mjs 的 checkSingleFile() 守着（plugin-singlefile
 * 测试文件头第 6 行就写着「单文件内联是插件装到 $APPDATA 后用 asset
 * 协议加载这条路的唯一…」）。对 12 份产物实测：
 *
 *   11 份 ok=true（remaining=0 / warnings=0）—— 零外部相对资源
 *   project-group ok=false（script + stylesheet 共 2 项）
 *
 * 所以这里**复用同一份判据**，不另写正则、不硬编码 id：
 * 单文件形态 → 直接给 asset URL；非单文件形态 → 明确错误框，
 * 绝不拼一个看似能跑、实际 403 后白屏且不报错的地址。
 *
 * ⚠️ 判据只有一份
 * ------------------------------------------------------------
 * 不在运行期另造「外部引用」正则，也不按 id 列白名单。形态变了
 * （构建产物改成外链）时 checkSingleFile 会自然报红，这里跟着拦住。
 *
 * 降级契约（三条，任何一条失守都是静默白屏）
 * ------------------------------------------------------------
 *   ① 不在 Tauri / 取不到 appDataDir / 没有 convertFileSrc
 *        → throw，nextAction: no-tauri-runtime
 *   ② index.html 读不出来 → throw，nextAction: backend-proxy-or-copy-to-dist
 *        （绝不把「读失败」当成「空 HTML 所以是单文件」—— 空串会被
 *          checkSingleFile 判 ok=true，这正是最危险的假绿形状）
 *   ③ 非单文件形态 → throw，nextAction: backend-proxy-or-inline-bundle
 *
 * 全部 throw 都走 mount() 的 showError() 错误框，与改之前那个无条件
 * throw 的安全级别完全一致：明确告诉用户下一步，而不是静默失败。
 */

import { checkSingleFile } from '../scripts/single-file.mjs';

/** 已安装插件目录名。与 plugin-manifest.js 的 INSTALLED_PLUGINS_DIR 同源，
 *  这里不 import 那个模块是为了让本文件在 Node 守卫里零副作用可加载；
 *  常量本身由 installedDir 可覆盖，守卫用独立反推验证它与主仓一致。 */
export const INSTALLED_DIR = 'installed-plugins';

/**
 * 形态判定（纯函数）。复用构建期唯一的 checkSingleFile 判据。
 *
 * @param {string} html index.html 全文
 * @returns {{ok: boolean, remaining: string[], warnings: string[]}}
 */
export function classifyInstalledHtml(html) {
  const r = checkSingleFile(String(html || ''));
  return {
    ok: r.ok,
    remaining: r.remaining.map((x) => String(x.url)),
    warnings: r.warnings.map((x) => String(x.url)),
  };
}

/**
 * 给 asset URL 补首帧底色参数（与 runtimeFrameUrl 同一套 query 语义）。
 * 纯函数，便于守卫真跑拼接结果。
 */
export function installedFrameUrl({ fileUrl, vars, base }) {
  if (typeof fileUrl !== 'string' || !fileUrl) {
    throw new Error('installedFrameUrl: fileUrl 为空');
  }
  const q = new URLSearchParams();
  const bg = vars && vars['--bg'];
  if (bg) q.set('nexus-bg', bg);
  if (base) q.set('nexus-base', base);
  const qs = q.toString();
  return qs ? `${fileUrl}${fileUrl.includes('?') ? '&' : '?'}${qs}` : fileUrl;
}

/** 统一构造结构化错误：走 showError 时用户能看到 nextAction。 */
function fail(id, message, nextAction) {
  const e = new Error(
    `已安装插件「${id}」无法加载：${message}。nextAction: ${nextAction}`);
  e.nextAction = nextAction;
  return e;
}

/**
 * 解析已安装插件的 iframe src（三态 fail-closed）。
 *
 * 依赖全部走 deps 注入，Node 守卫可以在没有 Tauri 的环境里真跑全部
 * 分支；host.js 负责把真实 Tauri 能力装进来。
 *
 * @param {object} manifest  带 installed:true / id / entry 的插件描述
 * @param {object} deps
 * @param {string} [deps.appDataDir]   应用数据目录（绝对路径）
 * @param {(path:string)=>string} [deps.convertFileSrc]  Tauri asset URL 转换
 * @param {(path:string)=>Promise<string>} [deps.readText]  读 index.html
 * @param {string} [deps.installedDir] 目录名，默认 INSTALLED_DIR
 * @param {Record<string,string>} [deps.vars] 主题变量
 * @param {string} [deps.base]          主题基调
 * @returns {Promise<string>} iframe src
 */
export async function resolveInstalledFrameSrc(manifest, deps = {}) {
  const d = deps || {};
  const id = (manifest && manifest.id) || '未知插件';
  const entry = (manifest && manifest.entry) || 'index.html';

  /* ① 环境缺失：不猜、不退回 resolveEntry、不返回空字符串 */
  if (!d.appDataDir || typeof d.convertFileSrc !== 'function'
      || typeof d.readText !== 'function') {
    throw fail(id, '取不到应用数据目录或 Tauri asset 转换能力',
      'no-tauri-runtime');
  }

  const dir = d.installedDir || INSTALLED_DIR;
  const sep = String(d.appDataDir).endsWith('/') ? '' : '/';
  const htmlPath = `${d.appDataDir}${sep}${dir}/${id}/${entry}`;

  /* ② 读失败必须显式报，绝不把空串喂给 checkSingleFile
   *    （空串 ok=true → 会放行一个根本没读到的页面，白屏且不报错） */
  let html;
  try {
    html = await d.readText(htmlPath);
  } catch (e) {
    throw fail(id, `读不到入口文件 ${entry}（${String((e && e.message) || e)}）`,
      'backend-proxy-or-copy-to-dist');
  }
  if (typeof html !== 'string' || !html.trim()) {
    throw fail(id, `入口文件 ${entry} 为空或不可读`,
      'backend-proxy-or-copy-to-dist');
  }

  /* ③ 形态分流：唯一判据是构建期那份 checkSingleFile */
  const shape = classifyInstalledHtml(html);
  if (!shape.ok) {
    const sample = [...shape.remaining, ...shape.warnings].slice(0, 2).join('、');
    throw fail(id,
      `产物含外部相对资源（${sample || '见构建报告'}），asset URL 下会解析到协议根被拒`,
      'backend-proxy-or-inline-bundle');
  }

  let fileUrl;
  try {
    fileUrl = d.convertFileSrc(htmlPath);
  } catch (e) {
    throw fail(id, `asset URL 转换失败（${String((e && e.message) || e)}）`,
      'no-tauri-runtime');
  }
  if (typeof fileUrl !== 'string' || !fileUrl) {
    throw fail(id, 'asset URL 转换返回了空值', 'no-tauri-runtime');
  }

  return installedFrameUrl({ fileUrl, vars: d.vars, base: d.base });
}
