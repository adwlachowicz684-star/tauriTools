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
│   ├── settings/              # 内置：设置（主题 / 插件 / 外链 / 关于 四个分页）
│   ├── demo-module/           # 示例：同页挂载
│   └── demo-iframe/           # 示例：沙箱挂载
├── config/nexus.config.mjs    # 配置单一来源：CSP / 端口 / 入口，两套栈共用
├── scripts/sync-config.mjs    # 把共享配置同步到各入口（npm run config:sync）
├── src-tauri/                 # Rust 后端
└── vite.config.ts / package.json   # 可选：仅在你想用 Vite 时才需要
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

> **新写一个 iframe 插件页面时，记得给首帧铺底色 + 设 color-scheme。** iframe 里
> 是独立文档，UA 默认画布是白的，且不受父级 `color-scheme` 影响 —— 从文档开始
> 渲染到外壳把主题变量推进来之间有一两百毫秒，深色面板下就是一闪而过的刺眼白底。
> 在 `<head>` 里读一下外壳缓存的底色与基调即可（`localStorage` 在隔离态会抛，要 try/catch）：
> ```html
> <script>
>   try {
>     var _bg = localStorage.getItem('nexus:preload-bg');
>     var _base = localStorage.getItem('nexus:preload-base');
>     var _r = document.documentElement;
>     if (_bg) { _r.style.setProperty('--bg', _bg); _r.style.background = _bg; }
>     if (_base) _r.style.colorScheme = _base;   // 表单控件与滚动条也跟着走
>   } catch (_e) {}
> </script>
> ```
> 漏了也不会白：宿主的 `.plugin-frame` 初始 `opacity:0`，等主题变量推完、
> 适配滤镜挂上才由 `revealFrame()` 淡入（另有 900ms 兜底，不会永久隐身）。
> `npm run test:flash` 会校验这条链路。

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

**23 套预设（深色 16 + 浅色 7）+ 自定义主题，只换 CSS 变量，DOM 与 CSS 文件一行不改。**

### 深色（16 套）

| 主题 | 风格 | 特点 |
|---|---|---|
| 深色新拟态 | 新拟态 | 灰蓝底 · 元素与背景同色，靠双向阴影塑形 |
| 午夜蓝 | 新拟态 | 深蓝调 · 沉稳耐看，适合长时间盯屏 |
| 石墨灰 | 新拟态 | 中性深灰 · 不抢戏，长时间盯屏最舒服 |
| 青瓷 | 新拟态 | 墨绿底 · 青瓷釉色，沉静有质感 |
| 暮橙 | 新拟态 | 深褐底 · 琥珀点缀，暖意十足 |
| 紫暮 | 新拟态 | 深紫底 · 品红点缀，优雅神秘 |
| 碳晶蓝 | 新拟态 | 冷蓝调 · 编辑器风格，代码与数据友好 |
| 玫瑰黑金 | 新拟态 | 近黑底 · 香槟金配玫瑰，低调奢华 |
| 深海 | 新拟态 | 深蓝绿 · 天青点缀，通透清凉 |
| 纯黑扁平 | 扁平 | OLED 纯黑 · 无阴影，靠描边分层 |
| 霓虹暗夜 | 扁平 | 品红配电光青 · 高饱和，科技感强 |
| 终端绿 | 扁平 | CRT 荧光绿 · 复古极客味 |
| 赛博朋克 | 扁平 | 霓虹黄配电光青 · 最高对比度 |
| 玻璃拟态 | 玻璃 | 半透明毛玻璃 · 背景带极光渐变 |
| 极光玻璃 | 玻璃 | 强色彩渐变配毛玻璃 · 视觉冲击最强 |
| Agent Flow 深色 | 扁平 | Linear / Vercel 风 · 扁平，靠明度差分层 |

### 浅色（7 套）

| 主题 | 风格 | 特点 |
|---|---|---|
| 浅色新拟态 | 新拟态 | 米白底 · 同样的立体感，明亮通透 |
| 宣纸 | 新拟态 | 暖白纸感 · 朱砂点缀，久看不累 |
| 薄荷晨光 | 新拟态 | 薄荷绿底 · 清爽明亮，不刺眼 |
| 樱花 | 新拟态 | 淡粉樱色 · 柔和温润 |
| 砂岩 | 新拟态 | 大地色系 · 暖灰里带一点陶土 |
| 极简白 | 扁平 | 纯白底 · 细描边，接近文档工具观感 |
| 浅色玻璃 | 玻璃 | 白底毛玻璃 · 淡蓝粉光晕 |

> 表格顺序即 `js/themes.js` 里 `PRESET_THEMES` 的顺序：先按风格分组（新拟态 → 扁平 → 玻璃），
> 组内深色在前。**默认主题是最后那套 Agent Flow 深色** —— 它的变量值与 agent-flow 插件的
> 原生层逐像素相同，没手动选过主题的人打开插件时，观感与插件独立运行时一致。
> 卡片右上角的风格角标（新拟态 / 扁平 / 玻璃）就来自 `style` 字段。

三种风格靠变量切换，不用写三套 CSS：

- **新拟态**：`--surface` 与 `--bg` 同色，靠 `--sh-dark` / `--sh-light` 双向阴影塑形
- **扁平**：把 `--sh-*` 调到与底色几乎同色（阴影自然隐形），改由 `--border` 描边
- **玻璃**：`--surface` 用半透明 + `--blur` 开毛玻璃 + `--bg-image` 渐变底

### 用法

**两个入口，同一套数据：**

1. **标题栏右上角 ◐**（在「窗口置顶 ⇱」左侧）—— 点开是缩略图弹出层，点一下就换。
   日常切换走这里最快；再点一次按钮、点遮罩或按 ESC 关闭。
   键盘也能走：`←` `→` 逐张移动、`↑` `↓` 按行跳（按网格实际列数算），`Enter` 选中，
   打开时焦点就落在当前主题那张卡上。
2. **设置 → 主题** —— 完整管理页。设置已按**主题 / 插件 / 外链 / 关于**分页，
   主题独占一页，除了切主题还能调强调色、色相明暗、存自定义主题。

缩略图用的就是该主题的真实配色（玻璃主题的渐变底与模糊也会如实呈现）。另可：

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
- 建议：次级文字 ≥ 4.5、最弱文字与点缀色（`--accent` / `--env-color`）≥ 3 ——
  色值只在 HSL 里调亮度、不动色相饱和度就能达标，现有 23 套都是这么调出来的
- 圆角（`--r-xl` / `--r-lg` / `--r-md` / `--r-sm`）**要么四个都写、要么都不写**。
  只写一半的话，切到没写那几个变量的主题时，上一套的内联值会残留（样式的锅不好查）

变量请按 `基底 → 塑形 → 文本 → 主色 → 状态色 → 风格 → 圆角` 的顺序写，
`--hairline` / `--mask` / `--scroll-thumb` / `--badge-fg` / `--accent-glow`
由 `theme-manager.js` 按 `base` 派生，主题里不要写。

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
`npm run test:theme` 验证主题系统（45 项：变量落地、派生、持久化、自定义、基调联动）。

### 立体感是怎么调出来的

新拟态的卡片与底板**完全同色**，边界只能靠阴影勾出来，所以阴影一弱元素就整
个糊在背景里。但 `box-shadow` 的模糊会把浓度摊进一条渐变带：实测 9px 模糊下
有效强度只剩原值的 **29%**。这带来两个结果：

1. **光调阴影色值不够**。把阴影提到 ΔL\* 11（感知明度差，深色主题）后，有效
   强度也只有 3.2，仍属"勉强可辨"——17 套非扁平主题里还有 14 套不达标。
2. **物理上限绕不过去**。纯黑底（如 rose-noir）提不亮暗影，纯白底压不亮亮影
   （底色 L\* 已 90+，亮影最多再提 6~8）。这些主题靠调色永远到不了位。

最终三管齐下，17 套全部跨过"可辨"线（合计 ΔL\* 13.7~14.8）：

- 阴影色值按感知明度校准到 ΔL\* ≈ 11（深色）/ 14（浅色暗影），只动亮度、
  不动色相与饱和度
- 外凸档位挂一层 `inset 0 0 0 1px` 描边（`--relief-edge`，由基调派生）。
  **关键在于它没有模糊、不参与摊薄**，实测直接贡献 ΔL\* 7~8，比阴影那点有效
  强度强一倍多——这才是真正让边界清晰的那一下
- 大卡片一档模糊 14px → 12px（有效系数 23% → 25%）

扁平风格不加描边：它靠 `--border` 描边，再叠一层 inset 会变成 2px 粗边。
想退回"纯阴影无描边"的观感，把 `--relief-edge` 设为 `transparent` 即可。

`npm run test:tokens` 会校验描边层存在、用的是 inset 而非外扩、按风格派生，
以及阴影强度已校准。

**切换插件为什么会闪一下白底**：iframe 内文档的 UA 默认画布是白的，
而「文档开始渲染 → 插件 CSS 生效 → 主题变量推入 → 适配滤镜挂上」这条链要走一两百毫秒。

**插件坏了为什么会是一片白**：同一个根因，只是更长 —— 入口文件缺失、未构建、
或插件脚本一上来就抛错时，iframe 内部**一个节点都画不出来**，此刻露出的是
iframe 元素自己的背景。它原来是 `transparent`，于是深色浅色一视同仁地白。

现在三层兜底：

1. `.plugin-frame` 底板给 `var(--bg)`（不再是 transparent）—— 内部画不出东西时
   露出主题底色。插件自带背景时会盖住它，不影响第三方插件
2. 插件页面首帧从 `localStorage` 读缓存底色铺上，并设 `color-scheme`
   （iframe 内的表单控件与滚动条不吃父级 color-scheme，不设就永远是浅色的）
3. 宿主 `.plugin-frame` 先隐身，适配完成后才由 `revealFrame()` 淡入，另有 900ms 兜底

另外，空白页面不再干等 10s 握手超时才报错：iframe `load` 之后会再看一眼，
body 一个子节点都没有就立刻把主题化错误框顶上去，用户不用对着一片"什么都没有"
猜是加载中还是坏了（隔离态读不到 contentDocument，那种情况仍走超时）。

**加载失败时怎么排查**：错误框里带一份折叠的「诊断日志」，含环境（时间 /
页面 / UA / 视口）、运行时（Tauri 还是浏览器、是否无构建模式）、插件（类型 /
入口 / 解析后入口 / 是否需构建）、插件配置（隔离 / 适配策略）、当前主题，
以及 iframe 现场（src / sandbox / 是否 load 过 / 内部节点数）和完整堆栈。

之所以要抓这么多：光有 `err.message` 没法判断「同一个插件在别人机器上正常」
到底是差在构建产物、隔离策略还是主题。iframe 现场尤其要在**移除 iframe 之前**
抓，否则"有没有 load 过"这类运行时状态就丢了。

日志框默认折叠（多数人只关心重试能不能好），可**一键复制**或**导出 .log**
（文件名含插件 id 与时间）。同一份内容也会打到 `console.error`。
`npm run test:errdiag` 会校验信息是否齐全、各种异常输入下不崩、
以及复制/导出的行为。

**加载期间显示什么**：一条是「正在加载…」覆盖层，盖在插件之上（不是替代品）：

- 加载中 → 主题化的加载框（超过 3s 补一句"首次加载可能较慢"，避免以为卡死）
- 成功 → 加载层淡出，底下的插件**已经渲染好了**，不会再闪一下
- 失败 → 立即摘掉加载层，换上主题化错误框

以前那句「正在加载…」是直接写进 `stage.innerHTML` 的，而挂载 iframe 时一句
`hostEl.innerHTML = ''` 就把它抹了 —— 插件却还要等适配滤镜挂上才淡入，中间
那段屏上只有 iframe 的底色。现在它是**覆盖层**，插件在下面照常加载。
收尾三条路径都覆盖到了：插件显形时（含 900ms 兜底那条）、同页插件（没有
iframe，需显式收）、失败报错时。

`npm run test:flash` 会校验遮罩、显形时机、iframe 底色不为 transparent、
空白检测、color-scheme，以及加载层的定位/底色/淡出/三条收尾路径。


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

真正能拦住外链的是 **CSP**，而 CSP 是静态的（唯一来源：`config/nexus.config.mjs`，
由 `npm run config:sync` 同步到两个入口的 meta 与两份 tauri 配置），运行时改不了。所以本模块做的是**看得见、管得了、记得住**：

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

### 样式规范（改 `css/neumorphism.css` 前必读）

完整的八条写在 CSS 文件头部，这里说最容易踩的四条：

**1. 文字四档，按层级取用**

| 变量 | 用途 | 对比度 |
|---|---|---|
| `--text` | 标题、正文、卡片名 | ≥ 4.5 |
| `--text-soft` | 次级正文（表单值、列表主行） | ≥ 4.5 |
| `--text-dim` | 小标题、分组名、标签 | ≥ 4.5 |
| `--text-mute` | 辅助说明、占位符、时间戳 | ≥ 3 |

≥ 12.5px 的说明文字至少用 `--text-dim`；`--text-mute` 只服务 ≤ 12px 的辅助信息。
弱化请**换档位**，不要叠 `opacity` —— mute 本就卡在 3 的线上，再乘 `.8` 就跌到 2.4。

**2. 颜色只从当前主题取**
面板上的任何文字都只能写 `var(--text)` 这类当前主题变量。唯一例外是主题卡片的
缩略图内部（`.theme-prev` / `.tp-*`），那一小块属于"被预览的主题"。
反例：主题名曾用预览主题的 `--text` 上色，而卡片底板是当前主题的 `--surface`，
深色面板下预览浅色主题就是深色字压深色底（实测 1.3:1，名字完全看不见）。

**3. 间距与交互态**
间距走 4 / 8 / 12 / 16 / 20 / 24；分组之间必须显式留白（`.theme-group + .theme-group`），
不能指望上一个分组的子元素 margin 撑开。
`hover` 只换色不加粗（并排按钮加粗会左右抖动）；`:active` 用 inset 内凹；
选中态用 `--accent` 描边或文字，且必须同时给 `focus-visible` 同款样式，
键盘走位时"当前项"只有一种长相。强调色文字字号 ≥ 12.5px 时字重 ≥ 600。

**3.5 `--border` 是风格开关，不是「分隔线颜色」**

`--border` 在新拟态下是 `transparent`（边界交给阴影），扁平 / 玻璃下才着色。
**画两个区域之间的分界请用 `--divider`——它保证任何风格都可见。**

混用会怎样（实测）：agent-flow 曾把分隔线接到 `--border` 上，于是新拟态下
26 处分隔线 + 10 处无底色控件全部消失，侧边栏与画布连成一片。扁平 / 玻璃
恰好没事，只因那两种风格给 `--border` 赋了值 —— 属于碰巧没踩到，不是设计对了。

分界两侧往往同色（新拟态下 `--surface` 与 `--bg` 就是同一个值），
一旦 `--border` 透明就没有任何东西托底，所以这条不是"建议"而是必须：

```css
border-right: 1px solid var(--divider);   /* ✅ 分界：任何风格都在 */
border: 1px solid var(--border);          /* ✅ 卡片描边：跟着风格走 */
```

`--divider` 由 `theme-manager` 按基调派生（深色微白 / 浅色微黑），
不进主题 `vars` —— 交给主题自己填就可能又被填成透明。
`npm run test:tokens` 会校验这条契约（把某处分隔线改回 `--border` 会红）。

**3.6 弹窗统一走 `js/dialog.js`**

全工具一套弹窗：外壳（原生 / React）、插件（React / 原生 JS）都调同一份实现。

```js
import { confirm, alert, prompt, open, show } from '../../js/dialog.js';

if (await confirm({ message: '确定删除？', danger: true })) { ... }
const name = await prompt({ title: '重命名', defaultValue: old, validate: ... });
```

全部返回 Promise（调用点大多是 async 流程，回调会多缩进一层）。
React 侧另有 `src/components/Dialog.tsx`，但**只是同一套 CSS 上的 JSX 包装**，
不另写样式 —— 两份实现并存会让观感随时间漂移。

| API | 用途 |
|---|---|
| `confirm({message, danger})` | 确认框，返回 boolean |
| `alert({message, type})` | 提示框（替代 `window.alert`） |
| `prompt({label, defaultValue, validate})` | 输入框（替代 `window.prompt`） |
| `open({title, body, actions})` | 自定义内容，Promise 版 |
| `show(...)` | 同上但返回**同步句柄** `{close, mask, dialog, settled}`，内容里的按钮要自己关弹窗时用 |

以前散着四种实现（shell 直接 `window.confirm`、project-group 自写 Modal、
mindmap 自写 `dialog()`、另有 23 处原生调用）。原生对话框的问题是**长相由
浏览器决定**（深色面板上是个突兀的白框）、不跟随主题、且 jsdom 里无法测试。
现已全部替换，`npm run test:dialog` 会扫描代码确认没有残留。

⚠️ **样式要一并引入**：弹窗样式在 `css/dialog.css`，插件是独立文档，
外壳的样式表传不进去，必须各引各的（已接在 neumorphism.css 与各插件的
样式里）。测试会跟着 `@import` 链校验"引了 JS 的地方也引了 CSS"。

**3.7 控件统一走 `css/controls.css`**

每个界面原先各写各的按钮 / 输入框 / 下拉，语义完全一样却有多份实现：

| 类名 | 引用数 | 原位置 |
|---|---|---|
| `.p-btn` | 167 | 外壳 |
| `.mm-btn` | 67 | 脑图 |
| `.p-input` / `.mm-input` / `.mm-select` / `.fpx-select` | — | 各处 |

多份实现的代价不是多写几行，而是**改一处漏一处**：调 hover 手感、修
disabled 态、跟随新的主题变量，都得在每个文件里各改一遍。

统一方式：**选择器组，而不是改类名**。

```css
.nx-btn, .p-btn, .mm-btn { --ctl-h: 38px; ... }
.nx-btn.sm, .mm-btn      { --ctl-h: 28px; }   /* 紧凑档只覆盖变量 */
```

现有 167 + 67 处引用一个都不用改，却共用同一份实现。类名是"这个界面里的
按钮"的语义，值得保留；要统一的是实现，不是名字。新增一档尺寸只改变量，
不用重写整条规则。

```html
<button class="nx-btn">标准</button>
<button class="nx-btn sm">紧凑</button>
<button class="nx-btn solid">实底</button>
<button class="nx-btn danger">危险</button>
<span class="nx-tag ok">标签</span>
```

**有意保留的差异**（不能为了统一而改变既有观感，测试里有断言守着）：

| 差异 | 位置 | 原因 |
|---|---|---|
| `.p-input` 撑满 + 更深内凹 | 外壳 | 外壳表单竖排撑满，脑图是行内紧凑 |
| `.p-row` 换行 + 间距 12px | 外壳 | 与统一层的 8px 不换行不同 |
| `.p-muted` 用 `--text-mute` | 外壳 | 比统一层的 `--text-dim` 更弱 |
| `.p-tag` 胶囊圆角 | 外壳 | 与 `.mm-chip` 方角**有意区分** |

**3.7.1 反馈类：空状态 / 加载 / Toast**

这三类此前比按钮还散 —— 空状态有 **6 套**实现：

| 类名 | 位置 |
|---|---|
| `.empty` / `.drawer-empty` | 外壳（全屏大空态 / 抽屉提示块） |
| `.empty-hint` | agent-flow 检查器 |
| `.cond-empty` | agent-flow 条件节点（行内小提示） |
| `.task-empty` | agent-flow 任务与历史面板 |
| `.mm-vthumb-empty` | 脑图视频缩略图占位 |
| `.fpx-empty` | 项目组 |

它们的差异多数是**无意的**（各写各的颜色与行高），少数是有意的
（全屏居中 vs 行内一行字）。统一策略同上：基础表现进选择器组
（弱化色 + 行高 + 居中），**尺寸与位置差异留在各自样式里**。

```html
<div class="nx-empty">没有内容</div>              <!-- 局部空态 -->
<div class="nx-empty lg">                          <!-- 全屏大空态 -->
  <div class="nx-empty-mark">◈</div><p>选一个插件</p>
</div>
<div class="nx-loading"><div class="nx-loading-inner">
  <div class="nx-spinner"></div><span>正在加载…</span>
</div></div>
<div class="nx-toast ok">已保存</div>
```

几点说明：

- **加载层要同时挂两类**：`.nx-loading`（基础）+ `.plugin-loading`
  （外壳差异）。只挂一个会丢掉一整层基础样式 —— 这个坑测试里守着。
- **Toast 的 `.ok` 必须是 `--ok` 而非环境色**：否则用户把环境色调成红色，
  就会得到「红色的成功提示」。这条曾被全量覆盖打回过一次。
- **Toast 容器 `pointer-events: none`**：右下角不该吃掉用户对背后界面的点击。
- **转圈在减少动效时放慢而非停止**：转圈是最典型的前庭触发源，
  直接停掉会让人以为卡死。

**3.8 控件清单（哪些是共享的、哪些是插件自建的）**

| 层 | 前缀 | 位置 | 说明 |
|---|---|---|---|
| 尺度令牌 | `--sh-*` `--r-*` `--dur-*` `--z-*` | `css/tokens.css` | 各文档都要 @import 才能拿到 |
| 通用弹窗 | `.nx-*` | `css/dialog.css` | 见上 |
| 外壳控件 | `.p-btn` `.p-card` `.p-input` `.p-row` `.p-tag` `.p-muted` `.p-mono` `.p-range` `.p-stat` `.p-grid` | `css/neumorphism.css` | 引了该文件的插件可用（settings、agent-flow） |
| 立体块 | `.nm-raised` `.nm-inset` `.nm-pressed` | 同上 | 新拟态的凸/凹/按下 |
| 标题栏 | `.tb-btn` `.tb-brand` `.tb-title` | 同上 | 主窗口标题栏 |
| 插件布局 | `.mm-*` `.fpx-*` | 各插件自己的 CSS | **暂未统一** —— 它们是各插件的布局组件，强并统一会牵动大量业务代码 |

新增控件时优先复用 `.p-*`，确实需要自建就加插件前缀（`.mm-` / `.fpx-` / `.af-`），
避免裸类名撞车。`npm run test:audit` 会检查变量与风格契约，
`npm run test:tokens` 会检查是否走了令牌。

**3.9 插件样式冲突会在设置页直接报出来**

插件是**独立文档**，外壳的 CSS 规则到不了那边，插件只能靠"引入 + 变量映射"
与面板保持一致。这条链上任何一环错位，都表现为"某个主题下突然看不清"，
而且很难联想到是变量接错了 —— 所以做成自动检查而不是靠人记。

设置页 → 插件 → 每个插件行有个「样式」徽标：

| 显示 | 含义 |
|---|---|
| `样式 ✓` | 未发现冲突 |
| `样式 N` | N 处 error/warn，点开逐条列出（含行号） |
| `样式 —` | 未检测：同页插件没有独立样式文档，或隔离态读不到 CSS |

规则定义在 `js/style-audit.js`，每条都写了**为什么错**和**实际后果**：

| 级别 | 规则 | 后果 |
|---|---|---|
| error | 单边分隔线用 `--border` | 新拟态下该变量透明，整条线消失 |
| error | `var(--x)` 未定义且无兜底 | 该声明直接失效，且不跟随换肤 |
| error | 立体阴影写死色值 | 换主题不跟着变 |
| warn | 未定义但有兜底 | 多半是拼写错误 / 改名后忘了同步 |
| warn | 用了令牌却没 `@import tokens.css` | 打包后尺度与滚动条全变 |
| warn | 重新定义了主题推送的变量 | 该插件不跟随换肤 |
| info | 硬编码颜色计数 | 结构色通常合法，仅供参考 |

`npm run test:audit` 会校验规则本身（踩坑的 CSS 必须报、正确的不能误报），
并顺带确认现有插件样式保持 0 error / 0 warn。

**3.10 尺度走 `css/tokens.css`**
阴影档位、圆角补档、过渡时长、字体、层级统一在这一个文件里，外壳与插件各自
`@import` 拿到。以前同一个几何值在四五个文件里各写一遍，改一处忘三处。

```
--sh-out-sm/md/lg/xl   外凸阴影（几何只分四档，颜色取自主题的 --sh-*）
--sh-in-xs/sm/md/lg    内凹阴影
--sh-cast-xs/sm/md/lg  投射阴影（浮层专用，颜色故意不跟主题）
--glow-sm/md           强调色辉光
--r-xs / --r-pill      圆角补档（主档 --r-* 由主题覆写，留在 neumorphism.css）
--dur-fast/base/slow   过渡时长
--font-sans / --font-mono
--z-base/raised/sticky/float/menu/mask/dialog/pop/toast
```

滚动条规则也放在这里 —— 插件是**独立文档**，外壳文档里的 `::-webkit-scrollbar`
到不了 iframe 内部，每个文档都得自己拿到一份。

`agent-flow` 是唯一例外：它刻意不引入任何共享样式，所以在自己的 `:root` 里
声明了一套等价的 `--af-*` 令牌自成一套。

**4. 状态色与装饰色分离**
`--ok / --running / --warn / --danger` 语义固定，不随 `--accent / --env-color` 变化。
成功提示只能用 `--ok`，否则用户把环境色调成红色就会得到"红色的成功提示"。

改完跑 `npm run test:theme-picker`：它的第 8 节会校验卡片用到的 class 都有样式定义、
分组标题有不限定容器的全局规则、主题名没有 inline 取色 —— 这几条都是出过事故的。

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
| 文件 / 文件夹操作（fs_op） | ✅ 桌面端可用（**需先授权目录**，见下） |

### fs_op 的作用范围：授权根目录

`fs_op` **只接受落在授权根目录内的路径**（`canonicalize` 后 `starts_with`），
默认范围仅应用数据目录。

**要操作别处的目录，先到「设置 → 文件」把它加进来。** 未授权的路径会被拒绝，
报错里会列出允许的范围。

这么收的原因是组合风险：插件安装只需一次确认，而 `ctx.invoke` 在 module 与
iframe 两种模式下都能用。若 `fs_op` 可读写任意路径、配合出网能力，就形成了
「读本地任意文件 → 经网络外传」的完整链条。约束 `fs_op` 是断链的主力 ——
只收网络权限没用，`https` 仍在，有个 https 站点照样能外传。

实现要点：

- `canonicalize` 后比较，因此 `../` 穿越与符号链接逃逸一并挡住（不是字符串前缀比较）
- `copy` / `move` 的**目标**路径同样校验 —— 只查来源不查目标，等于可以写穿到区外
- `glob` 命中项逐个回验：`pattern` 在区内，符号链接可能指向区外
- 演练（`dry_run`）同样校验：能列出任意目录本身就等于泄露目录结构
- 文件系统根、家目录根与系统目录（`/etc` `/usr` `/System` `/Windows` …）即便显式授权也拒绝

授权根目录是进程级状态，重启后回到默认（仅应用数据目录）。

### 网络请求：走 Rust 通道，不额外装包

OCR / 翻译 / 订阅源抓取优先经 Rust 的 tauri-plugin-http 发出（不受同源策略限制），
不可用时降级到浏览器 `fetch`。

Rust 侧三处已就绪：

- `Cargo.toml` 声明 `tauri-plugin-http = "2"`
- `main.rs` 里 `.plugin(tauri_plugin_http::init())`
- `capabilities` 放行 `https://**`；明文 `http://` **只放行本机常见推理服务端口**
  （Ollama 11434 / LM Studio 1234 / llama.cpp·LocalAI 8080 / vLLM 8000 /
  text-generation-webui 7860，`localhost` 与 `127.0.0.1` 各一条）

  注意 `tauri-plugin-http` 的 scope 里**端口是精确匹配的**
  （`http://localhost:8080` 不匹配 `:8081`），所以用了别的端口要在此补一条。
  `https://**` 保留是因为订阅源走 `rsshub.app` / `wechat2rss` 这类用户自填域名，
  编译期无法枚举。

**前端不依赖 `@tauri-apps/plugin-http` 这个 npm 包。**

`lib/tauri.ts` 里的 `tauriHttpRequest()` 直接调插件的 IPC 命令
（`plugin:http|fetch` → `fetch_send` → `fetch_read_body` → `fetch_cancel_body`），
只实现"发请求 → 拿文本"这一条路径。官方包本质上也是这几个调用的封装，
外加完整 Response 的流式语义 —— 而本插件用不到流式，
自己实现省掉一个依赖：拉下仓库不必为可选功能多装包，`package-lock` 也不用动。

只用文本，所以省掉了官方包里 `ReadableStream` / `AbortSignal` / cookie 那套，
代价是不支持流式响应与上传进度 —— 本插件用不到。

请求体必须传**已序列化的字符串**：Rust 侧按字节数组接收，
传对象会被 `String()` 成 `"[object Object]"`，请求体直接坏掉。
（Tauri v1 的 `body: { type:'Json', payload }` 写法同样不适用。）

另：CSP 的 `connect-src` 需放行目标域名，否则请求在 webview 层就被拦下。

逻辑用 mock 覆盖了（`npm run test:tauri-http`，23 项断言）：
分块读取与结束标记、204 等无 body 状态码、`maxBytes` 截断与资源释放、
请求体序列化、非 2xx 判定、通道不可用时降级。真机 IPC 行为仍需在 Tauri 内确认。

### 外观：跟随面板 / 原生样式

工具栏「外观」下拉切换。样式由 CSS 分层实现
（`styles.css` 的 `:root[data-af-mode="follow"]`），
JS 只负责记住选择并写 `data-af-mode`，不直接改颜色。

## 十三、开发辅助

校验脚本一共 **15 个**（`package.json` 里 `test` / `test:*`），都只用 jsdom，无需启动窗口：

```bash
npm install                 # jsdom 在 devDependencies 里，装完即可跑

# —— 外壳与主题（改动最常碰的两条主线）——
npm run test                # 外壳主线：注册表 → 挂载 → 交互 → 持久化（无构建入口）
npm run test:react          # React 外壳：注册表 → iframe 挂载 → 交互 / 持久化 / 角标
npm run test:theme          # 主题系统：变量落地 → 派生 → 持久化 → 自定义 → 基调联动
npm run test:adapt          # 主题适配：亮度采样 → 施加 → 策略优先级 → 回滚
npm run test:adapt-seq      # 主题连续切换的适配回归（插件深浅与主平台反转）
npm run test:theme-picker   # 标题栏主题选择器：缩略图 → 点击即换 → 同步高亮
npm run test:theme-bridge   # 主题桥接契约（iframe 内改主题必须作用到主面板）

# —— 插件机制 ——
npm run test:settings       # 插件设置面板（module / iframe 两条路径）
npm run test:shortcut       # 快捷键只在本插件被激活时生效
npm run test:handshake      # iframe 握手协议（握手失败＝只见标题不见内容）
npm run test:bridge         # 隔离态桥接：直连被切断，ctx 能力仍在
npm run test:external       # 外链策略 + 沙箱两个开关的配置读写

# —— 网络与渲染 ——
npm run test:tauri-http     # 自研 Tauri http 客户端（分块 / 截断 / 状态码）
npm run test:layout         # 布局高度链（同一个 bug 报过两次）
npm run test:xss            # XSS 转义回归
npm run test:mindmap        # 脑图插件回归（M1~M8 + 数据层）
```

注意：jsdom 不加载 iframe 子文档，iframe 内部脚本无法在测试中跑通，
测试只覆盖到「iframe 被正确插入、握手与主题推送」，插件内部行为需真机验证。
这些脚本仅开发用，可随时删除。

### CI

`.github/workflows/ci.yml` 在 push / PR 时跑：

```
npm ci → 配置漂移检查 → Vite 构建 → test / test:react / test:bridge
```

前三个是「双栈分叉」最容易出问题的地方：只改了无构建侧、或只改了 Vite 侧，
CI 会直接红。其余脚本本地按需跑（跑一次几秒）。

## 十四、构建与配置（两套入口怎么不打架）

两套入口的配置原本分散在 `package.json`、`vite.config.ts`、
`src-tauri/tauri.conf.json`、`src-tauri/tauri.vite.conf.json` 四处，
出过「同一项配置只在一侧生效」的事故（CSP 只有无构建侧有，React 模式等于裸奔）。

现在共享值统一定义在 **`config/nexus.config.mjs`**：

| 共享值 | 被谁用 |
| --- | --- |
| `ENTRIES` | 两个入口 HTML（vite 多页输入 / 同步脚本） |
| `DEV_SERVER` | `vite.config.ts` 的 `server.port`、`tauri.vite.conf.json` 的 `devUrl` |
| `BASE_CSP` / `viteDevCsp()` | 两个入口的 CSP meta + 两份 tauri 配置的 `csp` / `devCsp` |
| `buildInputs()` | vite 的 `rollupOptions.input`（自动扫 `plugins/<id>/index.html`） |
| `PLAIN_PLUGINS` | 原样拷进 `dist/` 的无构建示例插件 |

由它派生的部分**不要手改**，脚本会生成：

```bash
npm run config:sync    # 按共享源重写：两份 tauri 配置的 csp / devUrl、两个入口的 CSP meta
npm run config:check   # 只检查不写入（CI 在用，漂移即失败）
```

### 两份 Tauri 配置是「合并」不是「替换」

`npm run tauri:dev` / `tauri:build` 带 `--config src-tauri/tauri.vite.conf.json`，
Tauri 用 **JSON Merge Patch** 把它叠在主配置上 —— 覆盖层没写的字段，
主配置的值继续生效。所以 `csp` 这类安全项**必须在覆盖层里也显式写一遍**，
只改主配置、或只给 `index.html` 加 meta，都管不到 Vite 模式的产物。

| | 无构建模式 | Vite + React 模式 |
| --- | --- | --- |
| 入口 | `index.html` | `index.react.html` → 构建后 `dist/index.html` |
| 生产 CSP | `tauri.conf.json` 的 `csp`（基线） | 覆盖层的 `csp`（同为基线）＋ 页面 meta |
| 开发 CSP | 页面 meta | 覆盖层的 `devCsp` ＋ 页面 meta（走 devUrl 时 Tauri 不注入 header，全靠 meta） |
| 启动 | `cargo tauri dev` | `npm run tauri:dev` |

dev 态比基线多放行 dev server 与 HMR 的 WebSocket（`config` 里的 `viteDevCsp()`）。
这两项**只出现在 `devCsp` 与 React 入口的 meta 里，不进生产**：
生产构建时 Tauri 只注入基线，与页面 meta 取交集后 dev 放行项自动失效。
（HMR 必需，所以 meta 里躲不掉；靠的是交集，不是"生产不用这个文件"。）

### 改 CSP 的正确姿势

1. 改 `config/nexus.config.mjs` 里的 `BASE_CSP`（或 `viteDevCsp()`）；
2. `npm run config:sync`；
3. 提交 `tauri.conf.json`、`tauri.vite.conf.json`、`index.html`、`index.react.html` 四处改动。

外链白名单同理 —— 别只往 `index.html` 的 meta 里加域名，见第五节。
