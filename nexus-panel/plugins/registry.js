/**
 * 插件注册表
 * ------------------------------------------------------------
 * type  'module' 同页挂载  |  'iframe' 沙箱挂载（默认推荐）
 * entry 入口文件，相对项目根目录
 * theme 'dark' 与面板同基调(不适配) | 'light' 相反(需适配) | 'auto'/省略 运行时检测
 * requiresBuild  true = 用 React/TSX 编写，需要 Vite；无构建模式下自动隐藏
 *
 * 概览 / 设置 各写了两份实现：
 *   · 无构建（原生）→ *.js  同页挂载，零依赖直接跑
 *   · Vite（React）  → *.html + main.tsx 沙箱挂载，走 React 组件
 * 两条技术栈下看到的插件功能一致，只是实现不同。
 */

const noBuild = globalThis.__NEXUS_NO_BUILD__ === true;

export const plugins = [
  {
    id: 'home',
    name: '概览',
    icon: '◈',
    type: noBuild ? 'module' : 'iframe',
    entry: noBuild ? './plugins/home/index.js' : './plugins/home/index.html',
    theme: 'dark',
    requiresBuild: !noBuild,
    builtin: true,
    description: '运行环境与插件清单',
  },
  {
    id: 'agent-flow',
    name: 'Agent Flow',
    icon: '⧉',
    type: 'iframe',
    entry: './plugins/agent-flow/index.html',
    // React + TSX，需要 Vite；无构建模式下自动隐藏
    requiresBuild: true,
    description: '工作流编排画布（自带深色 UI）',
  },
  {
    id: 'demo-react',
    name: '示例·React 沙箱',
    icon: '◆',
    type: 'iframe',
    entry: './plugins/demo-react/index.html',
    version: '1.0.0',
    theme: 'dark',
    requiresBuild: true,
    description: 'React + TSX 编写，跑在沙箱里，ctx 用法与同页插件完全一致',
  },
  {
    id: 'demo-light',
    name: '示例·浅色插件',
    icon: '☀',
    type: 'iframe',
    entry: './plugins/demo-light/index.html',
    version: '1.0.0',
    theme: 'light',
    description: '模拟第三方浅色扁平 UI，演示自动主题适配',
  },
  {
    id: 'demo-module',
    name: '示例·同页',
    icon: '◉',
    type: 'module',
    entry: './plugins/demo-module/index.js',
    theme: 'dark',
    version: '1.0.0',
    description: '同页挂载，可直接调用 Rust',
  },
  {
    id: 'demo-iframe',
    name: '示例·原生沙箱',
    icon: '◇',
    type: 'iframe',
    entry: './plugins/demo-iframe/index.html',
    theme: 'dark',
    version: '1.0.0',
    description: '不依赖构建工具的 iframe 插件',
  },
  {
    id: 'settings',
    name: '设置',
    icon: '⚙',
    type: noBuild ? 'module' : 'iframe',
    entry: noBuild ? './plugins/settings/index.js' : './plugins/settings/index.html',
    theme: 'dark',
    requiresBuild: !noBuild,
    builtin: true,
    description: '主题、强调色、插件主题适配、插件管理',
  },
];
