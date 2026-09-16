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
 * 原生（无构建）示例插件不参与打包，直接原样拷进 dist，
 * 这样 Vite 生产构建里它们依然可用。
 */
function copyPlainPlugins(): Plugin {
  // 走 Vite 打包的插件也可能夹带「不能交给 Vite 处理」的原生子目录。
  // mindmap 的 editor/ 就是：kityminder 的 4 个原文件靠 <script src> 引用，
  // 由编辑器 iframe 以 ./editor/index.html 直接加载（见 editor-bridge.js）。
  // 少了它表现为「插件能开、画布一片空白」—— index.html 正常产出，
  // 但 editor/index.html 404，kityminder 未定义（实测构建已确认）。
  //
  // 只补拷 editor/ 一层，不能把 mindmap 加进 PLAIN_PLUGINS：
  // 它 index.js 里是 `import ... from '../../js/plugin-sdk.js'`，
  // 必须靠 Vite 打包才解析得到；整目录原样拷贝会盖掉打包产物，
  // 插件连开都开不了（比画布空白更糟）。两种产物的职责不能混。
  const NATIVE_SUBDIRS = [{ plugin: 'mindmap', dir: 'editor' }];
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
        const src = resolve(PATHS.plugins, name);
        if (fsSync.existsSync(src)) {
          copyInto(src, resolve(out, name));
        }
      }
      // closeBundle 在打包产物落盘之后，这里补拷不会被覆盖
      for (const { plugin, dir } of NATIVE_SUBDIRS) {
        const src = resolve(PATHS.plugins, plugin, dir);
        if (fsSync.existsSync(src)) {
          copyInto(src, resolve(out, plugin, dir));
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
