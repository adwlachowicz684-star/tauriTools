/**
 * 插件注册表
 * ------------------------------------------------------------
 * type  'module' 同页挂载  |  'iframe' 沙箱挂载（默认推荐）
 * entry 入口文件，相对项目根目录
 * theme 'dark' 与面板同基调(不适配) | 'light' 相反(需适配) | 'auto'/省略 运行时检测
 * followsTheme true = 该插件的观感**由外壳主题变量驱动**（CSS 里读 --bg/--surface/
 *               --text/--accent），基调该由它自己上报，外壳采样反而会误判。
 *               判据：只给"真的跟随"的插件标 —— 标错会导致该加的滤镜没加
 *               （深色面板上留一块刺眼的白）。
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
    /*
     * 概览：**两种模式下都是同页（module）**，这是首个完成嵌合的插件。
     *
     * Vite 模式下也能同页，靠 js/plugin-entries.js 的 import.meta.glob
     * 在构建期把 module.tsx 收进产物（此前 @vite-ignore 动态 import
     * 会导致产物里根本没有该文件 → 404，只能走 iframe）。
     *
     * 它是内置插件（builtin: true），与宿主同文档不会引入不可信代码，
     * 正好是分级模型里 L1（受信任、构建期扫过）的适用场景。
     */
    type: 'module',
    entry: noBuild ? './plugins/home/index.js' : './plugins/home/module.tsx',
    theme: 'dark',
    followsTheme: true,   // 同页插件，观感由外壳主题变量驱动，不参与反转
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
    /*
     * 本插件**跟随面板主题**：入口 HTML 读 nexus:preload-base / preload-bg
     * 铺底色，颜色由外壳推过来的变量决定，不是写死的深色。
     *
     * 只写 theme:'dark' 而不标这个，适配层会按「自身固定深色」处理：
     * 浅色面板（赤陶）下判定基调不等 → 施加反转滤镜
     * → 已经变浅的界面被二次翻回深色。
     */
    followsTheme: true,
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
    /*
     * 双模 entry —— 与 home / settings 同一写法，别写死成 index.js。
     *
     * 写死 './plugins/demo-module/index.js' 的后果：Vite 构建下入口必须被
     * js/plugin-entries.js 的 glob（plugins/<id>/module.(js|mjs|ts|tsx)）收录
     * 才会生成 chunk，index.js **不在** glob 里 → 产物没有该入口 →
     * 打开插件报「同页入口未被构建期 glob 收录」+ 运行时 404。
     * 无构建模式仍用 index.js（源码直出，动态 import 本就能跑）。
     *
     * 这里别把 glob 模式原文抄进注释：`*` 紧跟 `/` 会提前闭合块注释，
     * 整个 registry.js 直接语法错误（上游在 plugin-entries.js 里已踩过一次）。
     */
    entry: noBuild ? './plugins/demo-module/index.js' : './plugins/demo-module/module.js',
    theme: 'dark',
    followsTheme: true,   // 底色取 var(--surface-sunk)，由外壳主题驱动
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
    followsTheme: true,   // html,body 背景透明、文字取 var(--text)，外壳主题直接透出
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
    followsTheme: true,
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
    followsTheme: true,
    description: 'kityminder 内核：多画布 / 主题 / 布局 / 附件 / XMind 互导，内容实时缓存',
  },
  /* ---- 服务插件：不显示在侧边栏，供其它插件调用 ----
     interactive:true —— 调用时宿主会把它临时显示成居中浮层，
     因为色盘/图标选择这类服务**必须用户看得见才用得了**。
     不加这个标记的服务（如 demo-service）纯计算，不需要露面。 */
  {
    id: 'color-picker',
    name: '取色',
    icon: '🎨',
    kind: 'service',
    interactive: true,
    type: 'iframe',
    entry: './plugins/color-picker/index.html',
    version: '2.0.0',
    theme: 'dark',
    followsTheme: true,
    // React + TSX（与 project-group 内联色盘共用同一份组件），需要 Vite
    requiresBuild: true,
    description: '完整色盘：SV 面板 + 色相条 + RGB/HEX + 吸管待命；与内联色盘共用同一份组件实现',
  },
  {
    id: 'icon-picker',
    name: '图标选择',
    icon: '🖼',
    kind: 'service',
    interactive: true,
    type: 'iframe',
    entry: './plugins/icon-picker/index.html',
    version: '1.0.0',
    theme: 'dark',
    followsTheme: true,
    description: '内置 122 个预设图标的浏览与选择',
  },
  {
    id: 'md-editor',
    name: 'Markdown 编辑',
    icon: '📝',
    kind: 'service',
    interactive: true,
    type: 'iframe',
    entry: './plugins/md-editor/index.html',
    version: '1.0.0',
    theme: 'dark',
    followsTheme: true,
    description: '左编辑右预览的 md 编辑器，返回编辑后的文本',
  },
  {
    id: 'demo-service',
    name: '示例·取色服务',
    icon: '🎨',
    kind: 'service',
    type: 'iframe',
    entry: './plugins/demo-service/index.html',
    version: '1.0.0',
    theme: 'dark',
    followsTheme: true,   // 同样读 preload-base 铺底，跟随面板，不参与反转
    description: '示例服务插件：不进侧边栏，由其它插件通过 ctx.services.call 调用',
  },
  {
    id: 'settings',
    name: '设置',
    icon: '⚙',
    /*
     * 设置页：**两种模式下都是同页（module）**，是第二个完成嵌合的插件。
     *
     * 它本来就是双模（无构建下走 index.js 同页），所以同页这条路
     * 对它不是新东西 —— 风险比 home 更低。迁成常量 'module' 后，
     * Vite 模式也走同页，靠 js/plugin-entries.js 的 import.meta.glob
     * 把 module.tsx 收进产物。
     *
     * index.html / main.tsx（iframe 入口）**刻意保留**：
     * 删掉它们会让"想用沙箱隔离设置页"变成不可能。
     */
    type: 'module',
    entry: noBuild ? './plugins/settings/index.js' : './plugins/settings/module.tsx',
    theme: 'dark',
    followsTheme: true,   // 同页插件，观感由外壳主题变量驱动，不参与反转
    requiresBuild: !noBuild,
    builtin: true,
    description: '主题、强调色、插件主题适配、插件管理',
  },

  /* ---- 工具栏插件：显示在标题栏右上角，不进侧边栏 ----
     kind:'toolbar' 与另两类的区别见 js/toolbar-plugin.js 头部。

     只支持 type:'module'：这几个按钮必须直接调 Tauri（置顶要用
     窗口 API、托盘要用 host.win），iframe 里拿不到。配成 iframe
     会被加载器拒绝 —— 那是"配置了却永远没反应"。

     入口统一叫 module.js（纯 JS，无 React 依赖），
     所以两种模式下同一份文件都能跑，不用各写一套。 */
  {
    id: 'toolbar-theme',
    name: '切换主题',
    icon: '◐',
    kind: 'toolbar',
    type: 'module',
    entry: './plugins/toolbar-theme/module.js',
    builtin: true,
    description: '打开主题选择器（缩略图选择）',
  },
  {
    id: 'toolbar-pin',
    name: '窗口置顶',
    icon: '⇱',
    kind: 'toolbar',
    type: 'module',
    entry: './plugins/toolbar-pin/module.js',
    builtin: true,
    description: '窗口置顶开关',
  },
  {
    id: 'toolbar-tray',
    name: '隐藏到托盘',
    icon: '⇲',
    kind: 'toolbar',
    type: 'module',
    entry: './plugins/toolbar-tray/module.js',
    builtin: true,
    description: '把窗口藏到托盘（托盘图标可唤回）',
  },
  {
    id: 'toolbar-mcp',
    name: 'MCP 状态',
    icon: '⬡',
    kind: 'toolbar',
    type: 'module',
    entry: './plugins/toolbar-mcp/module.js',
    builtin: true,
    description: '显示 MCP 服务数量，可打开凭据中心管理',
  },
  {
    id: 'toolbar-inspector',
    name: '元素检查器',
    icon: '⌖',
    kind: 'toolbar',
    type: 'module',
    entry: './plugins/toolbar-inspector/module.js',
    builtin: true,
    description: '鼠标悬浮高亮控件并复制路径（Ctrl+Shift+D）',
  },
];
