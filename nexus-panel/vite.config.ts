import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import * as fsSync from 'node:fs';

const r = (p: string) => resolve(__dirname, p);

// 多页应用：外壳 + 每个 iframe 插件各有一个 HTML 入口。
// 构建后 dist/index.html（外壳）、dist/plugins/<id>/index.html（插件页面），
// 与 Tauri 的 frontendDist 完美对应。
const inputs = {
  index: r('index.react.html'),
  'plugins/home/index': r('plugins/home/index.html'),
  'plugins/settings/index': r('plugins/settings/index.html'),
  'plugins/demo-react/index': r('plugins/demo-react/index.html'),
};

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
  const targets = ['demo-iframe', 'demo-module', 'demo-light'];
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
