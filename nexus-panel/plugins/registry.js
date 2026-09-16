/**
 * 插件注册表
 * ------------------------------------------------------------
 * type  'module' 同页挂载  |  'iframe' 沙箱挂载（默认推荐）
 * entry 入口文件，相对项目根目录
 * theme 'dark' 与面板同基调(不适配) | 'light' 相反(需适配) | 'auto'/省略 运行时检测
 * requiresBuild  true = 用 React/TSX 编写，需要 Vite；无构建模式下自动隐藏
 * kind   'app'（默认，显示在侧边栏） | 'service'（不进侧边栏，供其它插件调用）
 *
 * kind:'service' —— 服务插件
 * ------------------------------------------------------------
 * 这类插件**不出现在侧边栏**，用户不直接打开它；它被挂载到一个隐藏的
 * 常宿容器里，由其它插件通过 ctx.services.call(id, method, args) 调用。
 *
 * 典型用途：色盘、Markdown 编辑器、图标选择器 —— 这些是"被别人用"的
 * 能力，而不是"用户去逛"的页面。做成服务插件可以：
 *   · 一份实现，所有插件共用，不用每个插件各拷一份色盘
 *   · 升级服务不用改调用方（只要 method 签名不变）
 *   · 未来可从插件商店独立安装/卸载
 *
 * 服务插件的入口要用 bootServicePlugin（而非 bootIframePlugin）声明方法。
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
    /* 自己跟随面板主题，不需要反转滤镜（L2/L3）。
       agent-flow 默认就是 follow 模式：--af-* 直接读面板推来的 --bg /
       --surface / --text，它**自己就会**跟着主题变浅，色彩原样保留。
       不给这个标记的后果：切到浅色 → 界面已变浅（白）→ 适配系统照旧
       采样判成"插件深色"→ 施加 invert → 已变浅的部分被二次翻转（黑）。
       且 reAdapt 先 teardown 再异步采样，中间约 790ms 无滤镜，
       于是看到"变白一秒后又变黑"，像切换了好几次。
       native 模式（固定深色）仍需要滤镜 —— 所以不能写死"永不适配"，
       要靠插件自报基调动态判定。详见 README 3.7.10。 */
    followsTheme: true,
    description: '工作流编排画布（跟随面板主题）',
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
    id: 'project-group',
    name: '项目组分配',
    icon: '🗂',
    type: 'iframe',
    entry: './plugins/project-group/index.html',
    // React + TSX，需要 Vite；无构建模式下自动隐藏
    requiresBuild: true,
    theme: 'dark',
    description: '项目 / 项目组双栏管理：agent 链接分配、内容浏览、连锁指令、内置图标与备份',
  },
  {
    id: 'mindmap',
    name: '思维导图',
    icon: '❖',
    type: 'iframe',
    entry: './plugins/mindmap/index.html',
    version: '1.0.0',
    theme: 'dark',
    description: 'kityminder 内核：多画布 / 主题 / 布局 / 附件 / XMind 互导，内容实时缓存',
  },
  /* ---- 服务插件：不显示在侧边栏，供其它插件调用 ---- */
  {
    id: 'demo-service',
    name: '示例·取色服务',
    icon: '🎨',
    kind: 'service',
    type: 'iframe',
    entry: './plugins/demo-service/index.html',
    version: '1.0.0',
    theme: 'dark',
    description: '示例服务插件：不进侧边栏，由其它插件通过 ctx.services.call 调用',
  },
  {
    id: 'store',
    name: '插件',
    icon: '⊞',
    type: noBuild ? 'module' : 'iframe',
    entry: noBuild ? './plugins/store/index.js' : './plugins/store/index.html',
    theme: 'dark',
    requiresBuild: !noBuild,
    builtin: true,
    description: '插件商店：已安装插件与服务插件的管理，未来接联网安装卸载',
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
