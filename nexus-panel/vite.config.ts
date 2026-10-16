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

// 主构建只打**外壳**（index.react.html → dist/index.html）。
// iframe 插件已全部迁到独立构建：scripts/build-plugins.mjs 产出
// runtime-plugins/<id>/，生产态由 js/host.js 经 asset 协议运行时加载 ——
// 改插件不再重编主程序（npm run plugins:build 单独跑）。
// module 插件不在此列：走 js/plugin-entries.js 的 import.meta.glob。
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
 * 拷一个文件 / 一棵目录树。
 *
 * 不用 `fs.cpSync`：它在 Windows 上覆盖已存在文件时会走 unlink，
 * 而本机那条路径抛的是 errno=0 的假错（消息为「The operation completed
 * successfully」，syscall=unlink）—— 同一路径用 unlinkSync / copyFileSync
 * 都正常，只有 cpSync 内部的 unlink 会挂。结果就是 `npm run build`
 * 每次报 `[nexus-copy-plain-plugins]` 失败。copyFileSync 没有这个问题，
 * 且覆盖写是幂等的，这里自己递归一层即可。
 */
function copyInto(src: string, dest: string): void {
  const st = fsSync.statSync(src);
  if (st.isDirectory()) {
    fsSync.mkdirSync(dest, { recursive: true });
    for (const name of fsSync.readdirSync(src)) {
      copyInto(resolve(src, name), resolve(dest, name));
    }
    return;
  }
  fsSync.mkdirSync(resolve(dest, '..'), { recursive: true });
  fsSync.copyFileSync(src, dest);
}

/**
 * 主构建收尾：拷贝运行时动态加载的附属文件。
 *
 * 只剩两样东西（iframe 插件与原子目录拷贝已迁到 scripts/build-plugins.mjs，
 * 见那里 NATIVE_SUBDIRS 的说明 —— 它们现在进 runtime-plugins/）：
 *   1. registry.js —— 运行时动态加载（便于不改代码热插拔插件）；
 *   2. PLAIN_PLUGINS —— 无 index.html 的 module 示例插件（demo-module），
 *      源码直出，与 iframe 插件独立构建互不干涉。
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
        copyInto(PATHS.registry, resolve(out, 'registry.js'));
      }
      for (const name of PLAIN_PLUGINS) {
        /*
         * 构建期断言：有 index.html 的插件**不能**出现在原样拷贝名单里。
         *
         * 原因见 config/nexus.config.mjs 里 PLAIN_PLUGINS 的注释 ——
         * 源码版 index.html 会盖掉打包版，插件脚本 404，最终表现为
         * 「iframe 插件握手超时（10s）」这种**完全看不出是构建配置问题**
         * 的运行时报错。静默放过等于把排查成本转嫁给下一次。
         *
         * 运行时加载时代里这条断言依然是护栏：有 index.html 的插件属于
         * build-plugins.mjs 的辖区，误放进来只会拷出一份没人加载的死目录。
         */
        if (fsSync.existsSync(resolve(PATHS.plugins, name, 'index.html'))) {
          throw new Error(
            `[nexus-copy-plain-plugins] 插件 "${name}" 有 index.html，`
            + '已由 scripts/build-plugins.mjs 独立构建（runtime-plugins/）；'
            + '放进 PLAIN_PLUGINS 会让源码版盖掉打包版，'
            + '表现为「iframe 插件握手超时（10s）」。请从 PLAIN_PLUGINS 移除。');
        }
        const src = resolve(PATHS.plugins, name);
        if (fsSync.existsSync(src)) {
          copyInto(src, resolve(out, name));
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
