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

### 2. 沙箱挂载（iframe）—— 样式隔离 + 崩溃隔离

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


### 4. 插件自己的设置面板

插件可以额外提供一个设置 UI，声明后外壳标题栏（重载按钮左侧）会出现 **⚙ 设置**，
点击从右侧滑出抽屉。快捷键 ⌘/Ctrl + , ，ESC 或点遮罩关闭。

**同页插件** —— 多导出一个 `settings`：

```js
export default definePlugin({
  async mount(ctx) { /* 主视图 */ },
  async settings(ctx) {
    // ctx 与主视图完全一致：同一份 store、同一条事件总线
    await ctx.store.set('key', value);
    ctx.emit('my-plugin:config', { ... });   // 通知主视图即时生效
  },
});
```

**沙箱插件** —— `bootIframePlugin` 传第二个参数：

```js
bootIframePlugin(mainFn, settingsFn);
```

**React 沙箱插件**：

```tsx
bootIframeReactPlugin(() => <App />, () => <PluginSettings />);
```

要点：
- 设置面板跑在**独立的沙箱 iframe** 里（`view='settings'`），与主视图样式隔离，但共享 store 与事件总线
- 未声明设置面板的插件，按钮**自动隐藏**
- 抽屉 DOM 由外壳创建销毁，引擎只负责把内容挂进去，两种技术栈共用同一套逻辑


### 5. 快捷键（只在自己激活时生效）

插件用 `ctx.shortcut()` 注册快捷键，引擎保证**两种挂载模式下行为一致**：

```js
ctx.shortcut('mod+k', () => doSomething());        // mod = macOS ⌘ / 其它平台 Ctrl
ctx.shortcut('mod+shift+k', handler);
ctx.shortcut('alt+n', handler);
ctx.shortcut(['mod+s', 'ctrl+s'], handler);        // 多个组合
const off = ctx.shortcut('esc', handler);          // 返回注销函数
off();
```

支持 `mod` / `ctrl` / `shift` / `alt` / `meta` 修饰键与 `esc` / `f5` / `?` 等功能键。
修饰键精确匹配：`mod+k` 不会被 `⌘⌥K` 或 `⌘⇧K` 误触发。

**隔离机制（两种模式实现不同，行为一致）：**

| | 同页（module） | 沙箱（iframe） |
|---|---|---|
| 实现 | 绑定在主文档 + 引擎按 `activeId` 判定 | 绑定在自己的 window，浏览器按焦点隔离 |
| 切到别的插件 | 自动失效 | 收不到事件 |
| 卸载 | 自动注销，无残留 | 随 iframe 销毁 |
| 设置抽屉打开时 | 主视图暂停，面板自己的生效 | 焦点在面板沙箱内 |

不要绕过这个 API 直接写 `window.addEventListener('keydown')`：
同页插件那样做会挂到主窗口，**永远全局生效且切换后残留**，多插件快捷键会互相打架。

**外壳保留键**：`⌘/Ctrl + B` 侧边栏、`⌘/Ctrl + R` 重载插件、`⌘/Ctrl + ,` 插件设置。
焦点进入 iframe 后父窗口收不到按键，SDK 会把这些保留键转发回外壳执行，所以它们始终可用。

### 6. 注册

在 `plugins/registry.js` 里加一条（或运行时点侧栏 **＋** 安装，存 localStorage）：

```js
{ id: 'my-plugin', name: '我的插件', icon: '◆',
  type: 'module',            // 'module' | 'iframe'
  entry: './plugins/my-plugin/index.js',
  shadow: false,             // module 模式下可开 Shadow DOM 做样式隔离
}
```

## 三、主题系统（一键切换整体风格）

**22 套预设 + 自定义主题，只换 CSS 变量，DOM 与 CSS 文件一行不改。**

### 深色（15 套）

| 主题 | 风格 | 特点 |
|---|---|---|
| 深色新拟态（默认） | 新拟态 | 元素与背景同色，双向阴影塑形 |
| 午夜蓝 | 新拟态 | 深蓝调，沉稳 |
| 石墨灰 | 新拟态 | 中性深灰，不抢戏，久看不累 |
| 青瓷 | 新拟态 | 深墨绿 + 青瓷釉色 |
| 暮橙 | 新拟态 | 深褐底 + 琥珀，暖意 |
| 紫暮 | 新拟态 | 深紫罗兰 + 品红点缀 |
| 碳晶蓝 | 新拟态 | 编辑器风格冷蓝 |
| 玫瑰黑金 | 新拟态 | 黑底 + 香槟金 + 玫瑰 |
| 深海 | 新拟态 | 深蓝绿 + 天青，通透 |
| 纯黑扁平 | 扁平 | OLED 纯黑，靠描边分层次 |
| 霓虹暗夜 | 扁平 | 品红 + 青，科技感 |
| 终端绿 | 扁平 | 复古 CRT 荧光绿 |
| 赛博朋克 | 扁平 | 霓虹黄 + 电光青，最高对比 |
| 玻璃拟态 | 玻璃 | 半透明 + 极光渐变 |
| 极光玻璃 | 玻璃 | 强色彩渐变，视觉冲击最强 |

### 浅色（7 套）

| 主题 | 风格 | 特点 |
|---|---|---|
| 浅色新拟态 | 新拟态 | 米白底，明亮通透 |
| 宣纸 | 新拟态 | 暖白纸感 + 朱砂点 |
| 砂岩 | 新拟态 | 大地色系，带一点陶土 |
| 薄荷晨光 | 新拟态 | 清爽薄荷绿 |
| 樱花 | 新拟态 | 淡粉樱色，柔和 |
| 极简白 | 扁平 | 纯白 + 细描边 |
| 浅色玻璃 | 玻璃 | 白底毛玻璃 + 淡蓝粉光晕 |

三种风格靠变量切换，不用写三套 CSS：

- **新拟态**：`--surface` 与 `--bg` 同色，靠 `--sh-dark` / `--sh-light` 双向阴影塑形
- **扁平**：把 `--sh-*` 调到与底色几乎同色（阴影自然隐形），改由 `--border` 描边
- **玻璃**：`--surface` 用半透明 + `--blur` 开毛玻璃 + `--bg-image` 渐变底

### 用法

设置 → 主题，按**深色 / 浅色分组**展示，点卡片即可切换，卡片预览用的就是该主题的真实配色
（玻璃主题的渐变底与模糊也会如实呈现）。另可：

- **强调色微调**：多种强调色叠加在当前主题之上，独立持久化
- **保存为自定义主题**：调好后另存，可随时删
- **切换有过渡动画**，且不重载插件 —— iframe 插件会收到新变量即时换肤，内部状态不丢
- ⌘/Ctrl + , 之外的外观调整都在设置页内完成

### 新增一套主题

在 `js/themes.js` 的 `PRESET_THEMES` 里加一条即可，核心只需 8 个变量
（`--bg / --surface / --surface-sunk / --sh-dark / --sh-light / --text / --accent / --border`），
其余（`--hairline` / `--mask` / `--scroll-thumb` / `--accent-glow`）由 `theme-manager.js` 按 `base` 自动派生。

配色要满足的约束（**`npm run test:theme` 会自动校验**，不满足会报错）：

- `--surface-sunk` 必须比 `--bg` **暗**（凹陷感），除非底色已是纯黑
- `--sh-dark` 比底色暗、`--sh-light` 比底色亮（双向阴影方向不能反）
- `--text` 对比底色 ≥ 4.5、`--text-dim` ≥ 3（可读性底线）

> 首屏防闪不再需要同步 `index.html`：主题应用时会把底色/前景色缓存进 localStorage，
> 防闪脚本直接读取，所以新增主题**只改 `themes.js` 一处**。

## 四、插件主题适配（第三方插件自动匹配面板基调）

第三方插件常常是浅色扁平风，直接塞进深色新拟态面板会很违和。外壳内置了三级适配，
由 `js/theme-normalizer.js` 实现：

| 级别 | 手段 | 作用 | 副作用 |
|---|---|---|---|
| L1 | 主题变量注入 | iframe 写入 `:root`，module 直接继承 | 无，永远执行 |
| L2 | `invert(1) hue-rotate(180deg)` | 不动 DOM、不改布局，一步翻成面板基调（深色面板暗化浅色插件，反之亦然），保留色彩关系与可读性 | 图片会被连带反色 |
| L3 | `mix-blend-mode: color` 覆盖层 | 把反色后的杂色拉回面板基色，解决"是深色但不是同一种深色" | 无（overlay 不拦截点击） |

L2 的连带问题已处理：对 `img/video/canvas/svg` 做**二次反转**还原，图表和图片颜色保持原样。

### 采样时机（重要，曾出过 bug）

判定插件基调靠采样它的实际颜色，所以**采样时机**决定对错。曾经踩过两个坑，
都表现为「连续切换主题和插件后，插件深浅和主平台反了」：

1. **CSS 过渡中间值** —— 切换主题会挂 `.theme-transition`（320ms，CSS 过渡 260ms），
   而采样若在此期间进行，`getComputedStyle` 返回的是**动画中间色**（中性灰）。
   深色→浅色切到一半读数被判成「深色插件」，于是施加反转；等过渡跑完插件已是浅色，
   再被反转 → 正好和主平台相反。
   → 修复：`waitThemeSettled()` 先等过渡结束，再连续采样取稳定值。

2. **跨文档异步** —— iframe 的主题变量靠 postMessage 推送，若推完立刻采样，
   读到的还是旧主题的颜色。
   → 修复：SDK 应用完变量回 `theme-applied`，外壳收到后才采样（400ms 超时兜底）。

另外 `installAdapter` 对同一 target **幂等**（施加前先清一遍），
`reAdapt` 用 generation 令牌串行化 —— 快速连点主题不会叠加滤镜或残留覆盖层。

`npm run test:adapt-seq` 专门守住这几条（含 bug 复现用例）。

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


## 五、外链管理（Office 式分级管控）

插件访问外部网络的分级管控，三档全局策略 + 逐域名决策，**全局 < 单条**。

| 档位 | 行为 |
|---|---|
| **智能提醒**（默认） | 已信任放行 / 已禁止拦截 / 新域名先问你 |
| **全部信任** | 不拦截任何外链，仅登记备查，风险自负 |
| **全部禁止** | 一律拦截，需要联网的插件会失效 |

### 哪些算"外链"

只有**会被当作插件代码加载的入口**才危险，其余都是普通网络资源：

| 场景 | 是否外链 | 由谁管 |
|---|---|---|
| `entry: 'https://cdn.com/p.html'` | ✅ 危险 | 本模块（安装时警告） |
| `entry: './plugins/x/index.html'` | ❌ | — |
| 插件里 `<video src="https://x.com/a.mp4">` | ❌ | CSP `media-src` |
| 插件里 `<iframe src="https://bili.com">` | ❌ | CSP `frame-src` |
| 插件里 `fetch('https://api.com')` | ❌ | CSP `connect-src` |
| 插件里 `<img src="https://x.com/a.png">` | ❌ | CSP `img-src` |

**例：脑图插件里点视频链接播放 —— 不算外链入口**，那是插件内部内容。

### 检查时机

- **安装插件时**自动扫描入口文件（含入口引用的本地 JS 一层）
- **更新插件后**可点「重新检查」全量重扫
- **运行时**被 CSP 拦下的请求会通过 `securitypolicyviolation` 登记进来

### 能力边界（重要）

真正能拦住外链的是 **CSP**，而 CSP 是静态的（写在 `index.html` 的 meta 里），
运行时改不了。所以本模块做的是**看得见、管得了、记得住**：

- 扫描并列出所有外域
- 记录你的放行/禁止决策
- 观测并提示被拦下的请求
- 生成**建议 CSP 片段**，你把它粘进 `index.html` 的 meta（或 `tauri.conf.json` 的 `csp`）后，
  信任的域名才真正放行

不做的事：不在 JS 层假装能拦截（那拦不住 `<img>`、`<video>` 等标签发起的请求）。

当前 CSP 已开 `media-src`/`frame-src`/`img-src` 的 `self` 与 `blob:`，
**脑图插件想内嵌播放在线视频，还需把目标域名加进 `media-src`/`frame-src`**。
另外很多视频站用 `X-Frame-Options`/`frame-ancestors` 禁止被嵌入（B 站基本不行，YouTube 的 `/embed/` 可以）——
这是对方服务器的策略，本地改不了。更稳的做法是用系统浏览器打开（需加 `tauri-plugin-opener`）。

## 六、沙箱：隔离的是「直连通道」，不是「能力」

每个插件自己的 **⚙ 设置**抽屉底部，外壳提供「沙箱与主题」区块，两个开关互相独立。

### 核心概念：隔离 ≠ 断能力

开启「严格沙箱」后，iframe 的 `sandbox` 会去掉 `allow-same-origin`，
插件变成 **opaque origin**：

| | 直连通道 | 桥接通道 |
|---|---|---|
| `parent.document` | ✗ 切断 | — |
| `parent.localStorage` | ✗ 切断 | — |
| 插件内 `window.__TAURI_INTERNALS__` | ✗ 不可达 | — |
| `ctx.invoke` 调 Rust | — | ✓ 由**主平台侧**执行 |
| `ctx.store` 持久化 | — | ✓ 数据存在主平台 |
| `ctx.on` / `ctx.emit` 跨插件事件 | — | ✓ 主平台总线中转 |
| `ctx.setTitle` / `setBadge` / `toast` | — | ✓ |
| 主题变量同步、运行时换肤 | — | ✓ |
| `ctx.shell.*`（配置 / 外链管理） | — | ✓ |

**关键在于桥接服务端跑在主平台侧**（`host.js` 的 `handleBridgeRequest`）：
插件把请求 postMessage 过来，主平台用自己的 Tauri 实例执行再把结果送回去。
所以插件自己有没有 `__TAURI_INTERNALS__`、`localStorage` 可不可用，**都不影响 `ctx.*`**。

> `npm run test:bridge` 会模拟隔离环境（localStorage 抛 SecurityError、
> `parent` 不可访问、`__TAURI_INTERNALS__` 不存在），逐项验证上表每一项能力。

### 开关一：严格沙箱（默认关）

| | 关闭（默认） | 开启 |
|---|---|---|
| `sandbox` | 带 `allow-same-origin` | 去掉它 |
| 访问主平台 | 可直连 `parent` / `localStorage` / Tauri IPC | 只能走桥接 |
| 访问其他插件 | 同源，**理论上可互访 DOM** | 彻底阻断 |
| `ctx.*` 能力 | 完整 | 完整（桥接） |

**为什么「直连主平台」和「互访其他沙箱」是同一个开关？**
因为同源是传递的：A 与主平台同源、B 与主平台同源，则 A 与 B 必然同源。
浏览器没有「只和主平台同源、彼此不同源」这种模型，所以两者绑在一起，只能取舍。

- 想**能力完整 + 写代码顺手** → 保持关闭（默认）
- 想**彻底阻断插件互访** → 开启，代价是主平台也只能走桥接（但能力不减）

**插件间通信本来就不该直连。** `ctx.emit` / `ctx.on` 走的正是主平台事件总线中转，
主平台可以做权限控制与审计 —— 这是比直连更好的架构，与开关状态无关。

### 开关二：主题适配（默认开）

| | 开启（默认） | 关闭 |
|---|---|---|
| 行为 | 基调与面板不一致时自动反转统一 | 完全不动插件外观 |

**隔离后怎么采样？** 外壳靠 `iframe.contentDocument` 采样插件颜色，
隔离后读不到 → 采样静默失败 → 被当成"基调一致" → 不反转 →
**深色面板上留一块刺眼的白，且不报任何错**。

解决：SDK 在隔离模式下**由插件自己采样并上报基调**（`base-report`），外壳据此照常适配。

### ctx.shell：隔离态下也能用的外壳能力

插件想读写自己的沙箱配置、或管理外链，用 `ctx.shell`（在主平台侧执行）：

```js
const cfg = await ctx.shell.pluginConfig.get('my-plugin');
await ctx.shell.pluginConfig.set('my-plugin', { isolated: true });

const hosts = await ctx.shell.external.list();
await ctx.shell.external.setStatus('api.example.com', 'trusted');
```

不要直接 `import` 那些模块 —— 同页插件可以（它就在主页面里），
但沙箱插件一旦被隔离，模块内的 `localStorage` 访问会失败、读写还会落到副本上。

## 七、ctx API（两种模式完全一致）

| 成员 | 说明 |
|---|---|
| `ctx.root` / `ctx.container` | 挂载点 / 宿主元素 |
| `ctx.invoke(cmd, args)` | 调用 Rust 命令，返回 Promise |
| `ctx.on(ev, fn)` / `ctx.emit(ev, payload)` | 插件间事件总线（返回取消函数） |
| `ctx.store.get/set/del/all` | 插件级持久化 KV，自动按 id 隔离（隔离态下由主平台代存） |
| `ctx.shell.pluginConfig.get/set` | 读写本插件的沙箱配置（主平台侧执行） |
| `ctx.shell.external.*` | 外链策略：list / setStatus / remove / suggestCsp 等 |
| `ctx.shell.isIsolated()` | 查询自己是否处于隔离态 |
| `ctx.registerShortcut(accel, event, label?)` | 注册**应用级**快捷键：窗口前台即生效，命中后外壳在总线上发 `event` |
| `ctx.unregisterShortcut(accel)` | 注销上面注册的应用级快捷键 |
| `ctx.addSidebarItem({ id, label, icon, event })` | 往外壳侧边栏注入条目，点击后总线上发 `event` |
| `ctx.removeSidebarItem(itemId)` | 移除注入的侧边栏条目 |

> **两套快捷键的分工**：`ctx.shortcut()` 只在**插件自己激活**时生效（引擎按 activeId 判定），
> 适合插件内的局部操作；`ctx.registerShortcut()` 由外壳统一持有，**窗口在前台就触发**，
> 适合"全局唤起"类需求。后者注册的事件由插件用 `ctx.on(event, handler)` 接收，
> 插件卸载时自动清理，不会残留。
| `ctx.addStyle(css)` | 注入样式，module 模式自动加作用域前缀 |
| `ctx.setTitle(text)` / `ctx.setBadge(n)` | 改标题栏 / 侧栏角标 |
| `ctx.toast(msg, 'ok'\|'err')` | 轻提示 |
| `ctx.openPlugin(id)` / `ctx.reload()` | 跳转插件 / 重载自己 |
| `ctx.onDestroy(fn)` | 注册卸载回调（定时器、监听器） |

外壳内置能力：加载超时 10s 自动报错、插件崩溃只影响自己、⌘/Ctrl+R 热重载、⌘/Ctrl+B 收起侧边栏、当前插件记忆。

## 八、换肤

改主题请走「设置 → 主题」（见第三节），不用手改 CSS。

新增主题请加到 `js/themes.js` 的 `PRESET_THEMES`（加完跑 `npm run test:theme` 校验配色）。

若你想改的是**默认主题本身的配色**，编辑 `js/themes.js` 里对应主题的 `vars`；
`css/neumorphism.css` 顶部的 `:root` 只是兜底默认值，运行时会被主题变量覆盖。

## 九、Rust 侧

`src-tauri/src/main.rs` 已提供 `rust_ping`、`app_version`、`window_action`（自定义标题栏用）。
新增命令后无需改前端，插件里直接 `ctx.invoke('你的命令')`。

## 十一、打包

```bash
cd src-tauri && cargo tauri build     # 无构建模式
npm run tauri:build                   # Vite + React 模式
```
`icons/` 下是占位图标，正式发布前请替换：`npm run tauri icon 你的图标.png`。

## 十二、Agent Flow 插件

`plugins/agent-flow/` 是一个工作流编排画布（React + React Flow），以 iframe 沙箱方式挂进面板。

### Rust 后端能力

`run_node` / `kill_node` / `watch_start` / `webhook_start` / `fs_op` /
`af_read_image_data_url` 等命令已在 `src-tauri/src/main.rs` 注册，
由 `af_flow.rs` 实现，界面上的功能都有对应后端。

| 能力 | 状态 |
|---|---|
| 界面（画布 / 节点 / 检查器 / 日志） | ✅ 完整可用 |
| 本地持久化（localStorage） | ✅ 可用 |
| 导入 / 导出 JSON | ✅ 可用 |
| 运行工作流（CLI 子进程流式输出） | ✅ 需系统装好对应 CLI |
| 文件监听、Webhook 触发器 | ✅ 桌面端可用 |
| 文件 / 文件夹操作（fs_op） | ✅ 桌面端可用 |

### 网络请求：Tauri 通道已打通

OCR / 翻译 / 订阅源抓取优先走 Tauri http 插件（经 Rust 发出，不受同源策略限制），
不可用时降级到浏览器 `fetch`。

Rust 侧三处已就绪：

- `Cargo.toml` 声明 `tauri-plugin-http = "2"`
- `main.rs` 里 `.plugin(tauri_plugin_http::init())`
- `capabilities` 放行 `http://**` / `https://**`

前端包 `@tauri-apps/plugin-http` 也已列入 dependencies。

**动态 import 必须用字面量**：

```js
const mod = await import('@tauri-apps/plugin-http');   // ✅ 字面量
// const spec = '...'; await import(/* @vite-ignore */ spec);  // ❌ 不会被打包
```

曾经为了"包没装也不让构建失败"而用变量 + `@vite-ignore`，
但那会让 Rollup 完全不打包这段代码 —— 运行时在 webview 里解析裸模块名必然失败，
函数恒返回 null，**功能从来没生效过，一直在静默降级**。
改回字面量后会被打成独立 chunk，运行时才真的加载得到。

请求体注意：v2 的 plugin-http 内部走标准 `new Request()` + `arrayBuffer()`，
只认 BodyInit。Tauri v1 的 `body: { type: 'Json', payload }` 写法会被转成
`"[object Object]"`，必须传 `JSON.stringify(...)` 后的字符串。

另外 CSP 的 `connect-src` 需放行目标域名，否则请求在 webview 层就被拦下。

### 外观：跟随面板 / 原生样式

工具栏「外观」下拉切换。样式由 CSS 分层实现
（`styles.css` 的 `:root[data-af-mode="follow"]`），
JS 只负责记住选择并写 `data-af-mode`，不直接改颜色。

## 十三、开发辅助

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
