/**
 * Nexus Panel · 配置单一来源（Single Source of Truth）
 * ----------------------------------------------------------------------------
 * 背景：仓库有两套入口（无构建 index.html / Vite+React index.react.html），
 * 配置分散在 package.json、vite.config.ts、src-tauri/tauri.conf.json、
 * src-tauri/tauri.vite.conf.json 四处，已经实证过「同一项配置只在一侧生效」
 * （CSP 只有无构建侧有，__NEXUS__ 字段两侧不等）。
 *
 * 约定：
 *   - 能被两处以上用到的值，一律定义在这里；
 *   - 各处只写「只属于自己的差异」，共享部分由 scripts/sync-config.mjs 生成/校验；
 *   - CI 跑 `npm run config:check`，任何一侧手改到漂移就红。
 *
 * 本文件是纯 ESM，同时被 vite.config.ts（构建期）与 scripts/（Node 脚本）导入，
 * 不依赖任何第三方包。
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本文件所在目录（config/） */
export const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));
/** 项目根目录（nexus-panel/） */
export const PROJECT_ROOT = resolve(CONFIG_DIR, '..');

/** 两个外壳入口：无构建 / Vite+React */
export const ENTRIES = {
  vanilla: 'index.html',
  react: 'index.react.html',
};

/** Vite 开发服务器（vite.config.ts 与 tauri.vite.conf.json 的 devUrl 共用） */
export const DEV_SERVER = {
  host: 'localhost',
  port: 1420,
};

/** Tauri 配置文件（相对 src-tauri/）：主配置 + Vite 模式 --config 覆盖层 */
export const TAURI_CONFIGS = {
  main: 'tauri.conf.json',
  vite: 'tauri.vite.conf.json',
};

/* ============================================================================
 * CSP
 * ==========================================================================*/

/**
 * 基线策略：两种入口都必须满足的最小约束。
 *
 * - script-src 必须带 'unsafe-inline'：首屏防闪脚本、插件 HTML 里的内联
 *   <script type="module"> 都靠它，去掉会被静默拦掉。
 * - script-src 必须带 'unsafe-eval'：思维导图插件的 kityminder 内核
 *   （plugins/mindmap/editor/kity.min.js）内部用 eval/Function 做特性探测，
 *   禁掉会让它整条链断掉 —— 实测症状见文末。
 * - img-src / media-src 带 asset: 与 http://asset.localhost：Tauri 资源协议。
 * - connect-src 带 ipc: 与 http://ipc.localhost：Tauri 2 的 IPC。
 *
 * 关于这两个 'unsafe-*'：本应用是**本地桌面容器**，加载的全是同源的本地
 * 插件（没有远程内容），安全边界是「插件 vs 外壳」的沙箱（见 plugin-config
 * 的 isolated 开关），不是 CSP 的来源白名单。CSP 在这里的作用是拦住
 * 意外外链，而不是防 XSS —— 所以这两个开关对本项目是必要成本，不是疏漏。
 *
 * 实测症状（2026-09-19，Tauri 生产构建下打开「思维导图」）：
 *   外壳报「iframe 插件握手超时（10s）」，但诊断报告里「已握手: 是」——
 *   真正断在插件嵌的编辑器里：
 *     EvalError: 'unsafe-eval' ...   @ editor/kity.min.js:10
 *     TypeError: ... reading 'Utils' @ editor/kityminder.core.min.js:10
 *     ReferenceError: kityminder ... @ editor/index.html:174
 *   缺了 unsafe-eval → kity 未定义 → 编辑器初始化抛错 → 插件 mount 永不返回。
 *   普通浏览器里看不到：那边没有 Tauri 注入的响应头 CSP，编辑器帧不受约束。
 */
export const BASE_CSP = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
  'style-src': ["'self'", "'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'asset:', 'http://asset.localhost', 'blob:'],
  'font-src': ["'self'", 'data:'],
  'connect-src': ["'self'", 'ipc:', 'http://ipc.localhost'],
  'media-src': ["'self'", 'asset:', 'http://asset.localhost', 'blob:'],
  'frame-src': ["'self'"],
};

/**
 * Tauri 的「资产 CSP 修饰」必须关掉（写进两份 tauri 配置的 app.security）。
 *
 * 默认情况下 Tauri 会替我们修饰每个 HTML 资产的 CSP：给 index.html 里每个
 * 内联 <script>/<style> 算 sha256 塞进 script-src，并给 <style> 和外链脚本
 * 注入 nonce。按 CSP 规范，**只要 sources 里出现 nonce 或 hash，
 * 'unsafe-inline' 就被整体忽略** —— 而本项目的 CSP 是刻意依赖
 * 'unsafe-inline' 的（见 BASE_CSP 的说明）。后果实测如下：
 *
 *   · 插件的 HTML（plugins/<id>/index.html，内联 <script type="module">
 *     是 iframe 插件的标准写法）没有那个 nonce，脚本被静默拦掉；
 *   · 任何 `el.style.x = ...` 内联样式属性也会被拦。
 *
 * 具体炸点（思维导图，2026-09-19）：插件本身握手正常，但它嵌的 kityminder
 * 编辑器（plugins/mindmap/editor/index.html，160KB 内联脚本）被拦 →
 * `kityminder is not defined` → 挂载卡住 → 外壳报「iframe 插件握手超时」。
 * 普通浏览器里复现不出来：那边只有 index.html 的 meta CSP，没有 nonce/hash。
 *
 * 注意 tauri.conf.json / tauri.vite.conf.json **不允许写注释**（构建脚本直接
 * 报 `key must be a string`），所以原因记在这里，值由 sync-config.mjs 落到
 * 两份配置里，`npm run config:check` 会挡住漂移。
 */
export const DISABLE_ASSET_CSP_MODIFICATION = true;

/**
 * Vite 模式额外放行：dev server 自身与 HMR 的 WebSocket。
 * 生产构建下这些条目无用（Tauri 注入的 header 是基线，取交集后自动失效），
 * 但开发时 index.react.html 的 meta 是唯一生效的 CSP，缺了 HMR 会连不上。
 */
export function viteDevCsp(port = DEV_SERVER.port, host = DEV_SERVER.host) {
  return {
    'connect-src': [
      `http://${host}:${port}`,
      `ws://${host}:${port}`,
      'http://127.0.0.1:' + port,
      'ws://127.0.0.1:' + port,
    ],
  };
}

/** 合并多组指令（同名指令的值取并集，保持首次出现顺序） */
export function mergeCsp(...directiveSets) {
  const out = {};
  for (const set of directiveSets) {
    for (const [k, values] of Object.entries(set)) {
      out[k] = out[k] ? [...out[k]] : [];
      for (const v of values) if (!out[k].includes(v)) out[k].push(v);
    }
  }
  return out;
}

/** 把指令对象渲染成 CSP 字符串（与 index.html 里手写的风格一致，结尾不带分号） */
export function renderCsp(directives) {
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ');
}

/**
 * 各入口的最终策略字符串。
 *
 * - `base`：基线，生产环境只用这一份 —— 绝不能把 dev server 端口放行出去。
 * - `dev`：基线 + Vite dev/HMR 放行，只在开发态出现（两种载体）：
 *     1) `tauri.vite.conf.json` 的 `app.security.devCsp`（Tauri 在 dev 注入）；
 *     2) `index.react.html` 的 meta —— dev 下前端由 Vite 提供，Tauri 不注入 header
 *        （走的是 devUrl），页面里的 meta 是唯一生效的 CSP，HMR 缺了它连不上。
 *   生产构建时这份 meta 会被拷进 dist/index.html，与 Tauri 注入的基线取交集，
 *   dev 放行项自动失效 —— 所以两边都写是安全的。
 */
export function cspPolicies() {
  return {
    base: renderCsp(mergeCsp(BASE_CSP)),
    dev: renderCsp(mergeCsp(BASE_CSP, viteDevCsp())),
  };
}

/* ============================================================================
 * 插件入口扫描（vite.config.ts 与 sync-config 共用，新增插件不用改两处）
 * ==========================================================================*/

/**
 * 扫 plugins/<id>/index.html，返回 Vite rollupOptions.input 需要的映射。
 * 返回值已包含外壳入口（index -> index.react.html）。
 */
export function buildInputs(root = PROJECT_ROOT) {
  const inputs = { index: resolve(root, ENTRIES.react) };
  const dir = resolve(root, 'plugins');
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return inputs; // plugins 目录缺失时忽略
  }
  for (const d of entries) {
    if (!d.isDirectory()) continue;
    const html = resolve(dir, d.name, 'index.html');
    if (existsSync(html)) inputs[`plugins/${d.name}/index`] = html;
  }
  return inputs;
}

const r = (p) => resolve(PROJECT_ROOT, p);

/** 需要原样拷进 dist 的「无构建」示例插件（不参与打包） */
export const PLAIN_PLUGINS = ['demo-iframe', 'demo-module', 'demo-light'];

export const PATHS = {
  root: PROJECT_ROOT,
  indexHtml: r(ENTRIES.vanilla),
  indexReactHtml: r(ENTRIES.react),
  dist: r('dist'),
  plugins: r('plugins'),
  registry: r('plugins/registry.js'),
  srcTauri: r('src-tauri'),
};
