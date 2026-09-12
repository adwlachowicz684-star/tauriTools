# Nexus Panel

深色新拟态（Dark Neumorphism）风格的 **Tauri 2.x 插件面板外壳**。
左侧边栏承载插件列表，右侧是插件舞台 —— 你后续所有业务功能都以插件形式挂进来，外壳本身保持"空白"。

```
nexus-panel/
├── index.html                 # 外壳页面（无边框窗口 + 自绘标题栏）
├── css/neumorphism.css        # 新拟态设计系统 + 插件通用组件库
├── js/
│   ├── shell.js               # 侧边栏 / 路由 / 插件宿主 / iframe 桥接服务端
│   ├── plugin-sdk.js          # 插件 SDK（两种挂载模式共用同一套 ctx）
│   └── tauri-core.js          # Tauri API 兼容层（全局注入 / npm 包 自动切换）
├── plugins/
│   ├── registry.js            # 插件注册表
│   ├── home/                  # 内置：概览
│   ├── settings/              # 内置：设置（主题色 / 插件管理）
│   ├── demo-module/           # 示例：同页挂载
│   └── demo-iframe/           # 示例：沙箱挂载
├── src-tauri/                 # Rust 后端
└── vite.config.js / package.json   # 可选：仅在你想用 Vite 时才需要
```

## 一、两种技术栈（共用同一套插件引擎）

外壳有**两套实现**，但插件宿主逻辑只有一份（`js/host.js`），两种栈下插件行为完全一致：

| | 无构建（原生） | Vite + React + TS |
|---|---|---|
| 入口 | `index.html` → `js/shell.js` | `index.react.html` → `src/main.tsx` |
| 插件引擎 | `js/host.js`（共用） | `js/host.js`（共用） |
| 概览 / 设置 | `plugins/*/index.js` 同页挂载 | `plugins/*/index.html` + `App.tsx` 沙箱挂载 |
| 启动 | `cargo tauri dev` | `npm install && npm run tauri:dev` |

**注册表会按技术栈自动分流**：`index.html` 里设了 `window.__NEXUS_NO_BUILD__ = true`，
于是无构建模式下 React/TSX 插件（`requiresBuild: true` 或按栈切换的条目）自动隐藏，
只保留原生插件；Vite 模式下则反过来用 React 版。两种栈看到的插件功能一致。

### 启动命令

```bash
# 方式 A：无构建（零依赖，改完 Cmd/Ctrl+R）
cd src-tauri && cargo tauri dev

# 方式 B：Vite + React（热更新，推荐主力开发）
npm install
npm run tauri:dev        # 开发
npm run tauri:build      # 打包
```

## 二、开发一个插件

两种写法任选，ctx API 完全一致（见第五节）。

### 1. 同页挂载（module）—— 默认推荐

`plugins/my-plugin/index.js`：

```js
import { definePlugin, h } from '../../js/plugin-sdk.js';

export default definePlugin({
  name: '我的插件',
  async mount(ctx) {
    ctx.root.appendChild(
      h('div.p-card', {},
        h('h2', {}, '标题'),
        h('button.p-btn.primary', {
          onclick: async () => {
            const r = await ctx.invoke('rust_ping', { payload: 'hi' });
            ctx.toast(r, 'ok');
          },
        }, '调用 Rust'),
      ),
    );
    return () => console.log('卸载');   // 可选：返回清理函数
  },
});
```

### 2. 沙箱挂载（iframe）—— 强隔离

`plugins/my-plugin/index.html`：

```html
<div id="plugin-mount"></div>
<script type="module">
  import { bootIframePlugin, h } from '../../js/plugin-sdk.js';
  bootIframePlugin(async (ctx) => {
    ctx.root.appendChild(h('div.p-card', {}, '我在沙箱里，但 ctx 用法完全一样'));
  });
</script>
```

### 3. 用 React + TS 写插件（Vite 模式）

`plugins/my-plugin/index.html` + `main.tsx` + `App.tsx`：

```html
<div id="root"></div>
<script type="module" src="./main.tsx"></script>
```

```tsx
// main.tsx
import { bootIframeReactPlugin } from '../../src/nexus-react';
import '../../css/neumorphism.css';
import App from './App';

bootIframeReactPlugin(() => <App />);
```

```tsx
// App.tsx —— 组件里用 useNexus() 拿 ctx
import { useNexus } from '../../src/nexus-react';

export default function App() {
  const ctx = useNexus();
  return (
    <div className="p-card">
      <h2>我的插件</h2>
      <button className="p-btn primary" onClick={() => ctx.toast('hi')}>点我</button>
    </div>
  );
}
```

写完后在 `vite.config.ts` 的 `inputs` 里登记该 HTML 入口，再在注册表加一条
`{ type: 'iframe', entry: './plugins/my-plugin/index.html' }`。

> 同页（module）模式下也想用 React？用 `defineReactPlugin` 或 `renderReact(ctx, <App/>)`，
> 见 `src/nexus-react.tsx`。

### 4. 注册

在 `plugins/registry.js` 里加一条（或运行时点侧栏 **＋** 安装，存 localStorage）：

```js
{ id: 'my-plugin', name: '我的插件', icon: '◆',
  type: 'module',            // 'module' | 'iframe'
  entry: './plugins/my-plugin/index.js',
  shadow: false,             // module 模式下可开 Shadow DOM 做样式隔离
}
```

## 三、主题系统（一键切换整体风格）

6 套预设 + 自定义主题，**只换 CSS 变量，DOM 与 CSS 文件一行不改**。

| 主题 | 基调 | 风格 |
|---|---|---|
| 深色新拟态（默认） | 深 | 新拟态 |
| 浅色新拟态 | 浅 | 新拟态 |
| 午夜蓝 | 深 | 新拟态 |
| 纯黑扁平 | 深 | 扁平 |
| 霓虹暗夜 | 深 | 扁平（高饱和） |
| 玻璃拟态 | 深 | 玻璃 |

三种风格靠变量切换，不用写三套 CSS：

- **新拟态**：`--surface` 与 `--bg` 同色，靠 `--sh-dark` / `--sh-light` 双向阴影塑形
- **扁平**：把 `--sh-*` 调到与底色几乎同色（阴影自然隐形），改由 `--border` 描边
- **玻璃**：`--surface` 用半透明 + `--blur` 开毛玻璃 + `--bg-image` 渐变底

### 用法

设置 → 主题，点卡片即可切换，带真实配色预览。另可：

- **强调色微调**：9 种强调色叠加在当前主题之上，独立持久化
- **保存为自定义主题**：调好后另存，可随时删
- **切换有过渡动画**，且不重载插件 —— iframe 插件会收到新变量即时换肤，内部状态不丢

### 新增一套主题

在 `js/themes.js` 的 `PRESET_THEMES` 里加一条即可，核心只需 8 个变量
（`--bg / --surface / --surface-sunk / --sh-dark / --sh-light / --text / --accent / --border`），
其余（`--hairline` / `--mask` / `--scroll-thumb` / `--accent-glow`）由 `theme-manager.js` 按 `base` 自动派生。

若该主题可能被设为默认，记得在 `index.html` 的 `PRELOAD` 里同步 bg/text 两项（首屏防闪用）。

## 四、插件主题统一（第三方插件自动匹配面板基调）

第三方插件常常是浅色扁平风，直接塞进深色新拟态面板会很违和。外壳内置了三级适配，
由 `js/theme-normalizer.js` 实现：

| 级别 | 手段 | 作用 | 副作用 |
|---|---|---|---|
| L1 | 主题变量注入 | iframe 写入 `:root`，module 直接继承 | 无，永远执行 |
| L2 | `invert(1) hue-rotate(180deg)` | 不动 DOM、不改布局，一步翻成面板基调（深色面板暗化浅色插件，反之亦然），保留色彩关系与可读性 | 图片会被连带反色 |
| L3 | `mix-blend-mode: color` 覆盖层 | 把反色后的杂色拉回面板基色，解决"是深色但不是同一种深色" | 无（overlay 不拦截点击） |

L2 的连带问题已处理：对 `img/video/canvas/svg` 做**二次反转**还原，图表和图片颜色保持原样。

### 怎么用

1. **默认自动**：采样插件背景/文字亮度判定基调，**与面板不一致时才反转**，同基调互不干扰。
2. **注册表显式声明**（推荐给第三方插件，省掉检测）：
   ```js
   { id: 'foo', ..., theme: 'light' }   // 'light' 需适配 | 'dark' 不适配 | 'auto' 检测
   ```
3. **运行时策略**：设置 → 插件主题适配，可设全局策略（自动/总是/从不），
   也可为单个插件单独指定，插件级优先于全局。

`npm run test:adapt` 验证适配核心（14 项：亮度采样、施加/回滚、策略优先级）；
`npm run test:theme` 验证主题系统（38 项：变量落地、派生、持久化、自定义、基调联动）。

## 五、ctx API（两种模式完全一致）

| 成员 | 说明 |
|---|---|
| `ctx.root` / `ctx.container` | 挂载点 / 宿主元素 |
| `ctx.invoke(cmd, args)` | 调用 Rust 命令，返回 Promise |
| `ctx.on(ev, fn)` / `ctx.emit(ev, payload)` | 插件间事件总线（返回取消函数） |
| `ctx.store.get/set/del/all` | 插件级持久化 KV，自动按 id 隔离 |
| `ctx.addStyle(css)` | 注入样式，module 模式自动加作用域前缀 |
| `ctx.setTitle(text)` / `ctx.setBadge(n)` | 改标题栏 / 侧栏角标 |
| `ctx.toast(msg, 'ok'\|'err')` | 轻提示 |
| `ctx.openPlugin(id)` / `ctx.reload()` | 跳转插件 / 重载自己 |
| `ctx.onDestroy(fn)` | 注册卸载回调（定时器、监听器） |

外壳内置能力：加载超时 10s 自动报错、插件崩溃只影响自己、⌘/Ctrl+R 热重载、⌘/Ctrl+B 收起侧边栏、当前插件记忆。

## 六、换肤

改主题请走「设置 → 主题」（见第三节），不用手改 CSS。

若你想改的是**默认主题本身的配色**，编辑 `js/themes.js` 里对应主题的 `vars`；
`css/neumorphism.css` 顶部的 `:root` 只是兜底默认值，运行时会被主题变量覆盖。

## 七、Rust 侧

`src-tauri/src/main.rs` 已提供 `rust_ping`、`app_version`、`window_action`（自定义标题栏用）。
新增命令后无需改前端，插件里直接 `ctx.invoke('你的命令')`。

## 八、打包

```bash
cd src-tauri && cargo tauri build     # 无构建模式
npm run tauri:build                   # Vite + React 模式
```
`icons/` 下是占位图标，正式发布前请替换：`npm run tauri icon 你的图标.png`。

## 九、开发辅助

四个测试脚本都只用 jsdom，无需启动窗口：

```bash
npm i -D jsdom
npm run test         # 外壳主线：注册表 → 挂载 → 交互 → 持久化
npm run test:adapt   # 主题适配：亮度采样 → 施加 → 策略优先级 → 回滚
npm run test:theme   # 主题系统：变量落地 → 派生 → 持久化 → 自定义 → 基调联动
npm run test:react   # React 外壳：注册表 → iframe 挂载 → 主题应用
```
注意：jsdom 不加载 iframe 子文档，iframe 内部脚本无法在测试中跑通，
测试只覆盖到「iframe 被正确插入、握手与主题推送」，插件内部行为需真机验证。
这两个文件仅开发用，可随时删除。
