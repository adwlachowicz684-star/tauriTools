import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as fsSync from 'node:fs';

// package.json 是 "type": "module"，配置按 ESM 加载，没有 __dirname。
// 直接写 __dirname 全靠 Vite 注入的 shim 兜着 —— 换个 Vite 版本就可能
// 加载失败（报 "config must export or return an object"）。
// 自己从 import.meta.url 推导，不依赖任何外部行为。
const __dirname = dirname(fileURLToPath(import.meta.url));

const r = (p: string) => resolve(__dirname, p);

// 多页应用：外壳 + 每个 iframe 插件各有一个 HTML 入口。
// 构建后 dist/index.html（外壳）、dist/plugins/<id>/index.html（插件页面），
// 与 Tauri 的 frontendDist 完美对应。
//
// 自动扫描 plugins/<id>/index.html —— 新增插件不用再来改这里。
const inputs: Record<string, string> = {
  index: r('index.react.html'),
};
try {
  for (const d of fsSync.readdirSync(r('plugins'), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const html = resolve(r('plugins'), d.name, 'index.html');
    if (fsSync.existsSync(html)) inputs[`plugins/${d.name}/index`] = html;
  }
} catch { /* plugins 目录缺失时忽略 */ }

/**
 * Vite 的多页输出会沿用源文件名，这里把 index.react.html 改成 index.html，
 * 以匹配 Tauri 默认的 frontendDist 入口。
 */
function renameShellEntry(): Plugin {
  return {
    name: 'nexus-rename-shell-entry',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const src = 'index.react.html';
      const asset = bundle[src];
      if (!asset) return;
      asset.fileName = 'index.html';
      delete bundle[src];
      bundle['index.html'] = asset;
    },
  };
}

/**
 * 原生（无构建）示例插件不参与打包，直接原样拷进 dist，
 * 这样 Vite 生产构建里它们依然可用。
 */
function copyPlainPlugins(): Plugin {
  // mindmap 必须在这里：它含 editor/ 下的 kityminder 原文件（4 个，靠 <script src>
  // 引用、不能交给 Vite 处理），只有整个目录拷贝才能进 dist。
  // 缺失时表现为「插件能开、画布一片空白」—— index.html 会被 Vite 正常产出，
  // 但 editor/index.html 404，kityminder 未定义。
  // 注意它同时也在 inputs 里（自动扫到了 index.html），closeBundle 的原样拷贝
  // 会覆盖 Vite 产出的那份 —— 这正是想要的结果：mindmap 用的是原生 ES module，
  // 源码版可直接跑，与 demo-* 一致。
  const targets = ['demo-iframe', 'demo-module', 'demo-light', 'mindmap'];
  return {
    name: 'nexus-copy-plain-plugins',
    apply: 'build',
    closeBundle() {
      const out = resolve(__dirname, 'dist/plugins');
      fsSync.mkdirSync(out, { recursive: true });
      // 注册表是运行时动态加载的（便于不改代码热插拔插件），需一并拷贝
      const reg = resolve(__dirname, 'plugins/registry.js');
      if (fsSync.existsSync(reg)) fsSync.cpSync(reg, resolve(out, 'registry.js'));
      for (const name of targets) {
        const src = resolve(__dirname, 'plugins', name);
        if (fsSync.existsSync(src)) {
          fsSync.cpSync(src, resolve(out, name), { recursive: true });
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), renameShellEntry(), copyPlainPlugins()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: false,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2021',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    rollupOptions: { input: inputs },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
});
