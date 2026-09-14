import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import * as fsSync from 'node:fs';

// 共享配置：端口、入口、CSP 等都定义在 config/nexus.config.mjs，
// 无构建模式（index.html）与 Vite 模式（index.react.html）共用同一份，
// 避免「改了一处忘了另一处」（历史上 CSP 就只在无构建侧生效过）。
// 改完记得跑 npm run config:sync（CI 会跑 config:check 挡漂移）。
import {
  DEV_SERVER,
  ENTRIES,
  PATHS,
  PLAIN_PLUGINS,
  buildInputs,
} from './config/nexus.config.mjs';

// 多页应用：外壳 + 每个 iframe 插件各有一个 HTML 入口。
// 构建后 dist/index.html（外壳）、dist/plugins/<id>/index.html（插件页面），
// 与 Tauri 的 frontendDist 完美对应。
//
// 自动扫描 plugins/<id>/index.html —— 新增插件不用再来改这里。
const inputs = buildInputs(PATHS.root);

/**
 * Vite 的多页输出会沿用源文件名，这里把 index.react.html 改成 index.html，
 * 以匹配 Tauri 默认的 frontendDist 入口。
 */
function renameShellEntry(): Plugin {
  return {
    name: 'nexus-rename-shell-entry',
    enforce: 'post',
    generateBundle(_opts, bundle) {
      const src = ENTRIES.react;
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
  return {
    name: 'nexus-copy-plain-plugins',
    apply: 'build',
    closeBundle() {
      const out = resolve(PATHS.dist, 'plugins');
      fsSync.mkdirSync(out, { recursive: true });
      // 注册表是运行时动态加载的（便于不改代码热插拔插件），需一并拷贝
      if (fsSync.existsSync(PATHS.registry)) {
        fsSync.cpSync(PATHS.registry, resolve(out, 'registry.js'));
      }
      for (const name of PLAIN_PLUGINS) {
        const src = resolve(PATHS.plugins, name);
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
    port: DEV_SERVER.port,
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
