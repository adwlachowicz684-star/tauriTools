# 插件制作 README

> 从零做一个 Nexus Panel 插件的操作说明。本文**存放在主面板仓库**
> `adwlachowicz684-star/tauriTools`，是插件制作的规范入口；插件源码本身
> 已迁到各自的独立仓库（例：`nexusPanel_plugin_taskBoard`）。
>
> 阅读顺序：先读本文 §0 的硬性约定，再按 §2 搭最小插件，遇到样式问题看 §3，
> 提交前过一遍 §7 自检清单。更细的机制说明仍以主仓 `README.md` 为准。

---

## 0. 硬性约定（先读这一节）

### 0.1 所有样式跟随主题，不用自己定义

> **所有插件的所有样式必须跟随面板主题，不允许插件自己定义主题、色板、
> 深浅判断或明暗互换逻辑。任务管理器（`task-board`）同样适用，不得以
> 「高密度工作台」「深色专业看板」等设计理由例外。**

这条要求的完整含义：

| | 要求 | 为什么 |
|---|---|---|
| 1 | 颜色一律直接取宿主推送的主题变量（`var(--bg)`、`var(--text)`、`var(--accent)`、`var(--divider)` …） | 主题切换只换变量，插件不跟着变就是"功能没坏、观感脱节"，且不报错 |
| 2 | **不自带主题**：不写 `:root` 色板、不定义私有颜色变量（如 `--nx-fg` / `--my-fg`）、不写两套深/浅配色 | 私有变量等于第二套配色来源，宿主永远不会推它 |
| 3 | **不自己翻明暗**：不要把 `var(--bg)` 当文字色、`var(--text*)` 当底板，不要用 `invert()` / `filter` / 自定义 `color-mix` 造"反相侧栏" | 变量虽然是主题的，深浅关系是插件自己定的，换主题后对比度会崩 |
| 4 | **不写死色值**：`#hex` / `rgb()` 不出现在颜色声明里；`var(--x, #hex)` 的兜底同样算 | 兜底在变量没到时生效，且私有变量永远取不到 → 实际显示为写死的灰蓝 |
| 5 | 不给插件做 UI 层的"深色模式 / 浅色模式"分支 | 深浅由宿主变量自动跟随，插件判断就是重复定义 |
| 6 | iframe 首帧底色与 `color-scheme` 只用于**主题到达前防白闪**，不得当配色来源 | 它是启动兜底，不是第二套主题 |

**允许的极少数例外**（沿用 `docs/样式检测标准.md` §1 与 README 3.7.8）：

- 叠在未知内容上的遮罩 / 游标，允许写死颜色，**必须就近注释说明原因**；
- `tokens.css` / `neumorphism.css` 里的 `:root` 是**定义令牌的地方**，不算硬编码；
- `var(--x, 兜底)` 的兜底在"未引入 tokens.css"时按标准豁免，但**不能用来给私有颜色变量兜底**；
- agent-flow 的 `--af-t-*` 品牌色双档是历史例外，新插件**不要新增**同类例外。

**违反后的实际表现**：切换主题后插件某一块颜色不动、深/浅主题下文字消失、
同一面板里出现两种基调；控制台无报错，只能靠 `style-standard-test.mjs --dir`
与人工换肤发现。

### 0.2 这条要求落在哪

主仓三处，措辞一致，改一处要同步另外两处：

1. 本文件 §0.1；
2. `README.md` 二、四、八章；
3. `docs/样式检测标准.md` §14。

---

## 1. 仓库归属：什么东西放哪个仓库

| | 主面板仓库（本仓，`tauriTools`） | 插件独立仓库 |
|---|---|---|
| 外壳、主题系统、SDK、注册表 | ✓ `css/` `js/` `plugins/registry.js` | ✗ |
| 插件源码 | ✗（`nexus-panel/plugins/task-board/` 已退役，目录 404） | ✓ `plugins/<id>/` |
| 构建产物 | ✓ `runtime-plugins/<id>/` | ✗ |
| 跨端契约校验、守卫、CI 模板 | ✓ `cross-end-check.mjs`、`*-test.mjs`、`templates/plugin-repo/` | 只放**本仓持有 TS 契约**的那份 workflow |
| 文档 | ✓ 本文件、`README.md`、`docs/样式检测标准.md` | 插件自己的 README |

> 插件文件**不要**推回主仓 `nexus-panel/plugins/<id>/`：那个目录已整体退役，
> 误推会重新创建死路径。本地工作区用一份归属映射清单做硬映射
> （插件路径 → 独立仓，外壳 / 守卫 / 模板 / 文档 → 主仓），
> 未命中清单的路径一律拒绝推送；该清单在工作区，不随仓库发布。

---

## 2. 最小可用插件

### 2.1 目录结构

```
plugins/my-plugin/
├── nexus.plugin.json     # 必需，插件自描述
├── index.html            # iframe / Vite 形态的入口
├── main.tsx              # Vite + React 形态
├── App.tsx
└── styles.css            # 自己的布局样式（颜色只取主题变量）
```

### 2.2 `nexus.plugin.json`

任务管理器当前的实际文件（`plugins/task-board/nexus.plugin.json`）：

```json
{
  "id": "task-board",
  "name": "任务管理器",
  "version": "0.1.0",
  "entry": "index.html",
  "kind": "app",
  "icon": "▦",
  "description": "多窗口协作任务看板（AI / 人工 / agent-flow 共用一份 tasks.json）",
  "repo": "adwlachowicz684-star/nexusPanel_plugin_taskBoard"
}
```

字段规则（来自 `js/plugin-manifest.js`，不是约定俗成）：

| 字段 | 规则 |
|---|---|
| `id` | **必填**。`^[a-z0-9]+(?:-[a-z0-9]+)*$`，≤ 64 字符，**目录名必须等于 id** |
| `name` / `version` / `entry` | **必填**；version 是宽松 semver，可带 `v` 前缀 |
| `kind` | `app`（默认，进侧边栏）/ `service`（不进侧边栏，供别的插件调） |
| `icon` / `description` / `repo` | 可选，展示用 |
| `builtin` / `trusted` / `permissions` | **明确忽略**：manifest 是插件自己写的，不能拿来当权限依据；权限按来源（内置 / 远程安装）判定，见 `js/invoke-policy.js` |

### 2.3 三种写法，选一种

| 形态 | 入口 | 挂载 | 样式 |
|---|---|---|---|
| 同页 module | `index.js`，`definePlugin({ mount(ctx) … })` | 主文档内，`ctx.root` 直接挂 | 什么都不引，直接吃 `neumorphism.css` |
| 沙箱 iframe | `index.html` + `bootIframePlugin(...)` | 独立文档 | **必须自己 `@import`**，见下 |
| Vite + React | `index.html` + `main.tsx` + `App.tsx`，注册表标 `requiresBuild: true` | iframe | 同上，且产物进 `runtime-plugins/<id>/` |

iframe 插件的 CSS 第一行：

```css
@import url('../../css/tokens.css');
/* 需要通用控件再引 controls.css；用到弹窗再引 dialog.css */
```

或在入口一次性 `import '../../css/neumorphism.css'` 拿全套。**漏引的表现**
是"功能没坏但不跟随主题"——变量全部静默降级。

### 2.4 iframe 首帧（防白闪，不是配色）

iframe 是独立文档，UA 默认白底，且不受父级 `color-scheme` 影响。主题变量
推送到达前有一两百毫秒空窗。在 `<head>` 里读外壳缓存铺底色：

```html
<script>
  try {
    var _q = new URLSearchParams(location.search);
    var _bg = _q.get('nexus-bg') || localStorage.getItem('nexus:preload-bg');
    var _base = _q.get('nexus-base') || localStorage.getItem('nexus:preload-base');
    var _r = document.documentElement;
    if (_bg)   { _r.style.setProperty('--bg', _bg); _r.style.background = _bg; }
    if (_base) _r.style.colorScheme = _base;   // 表单控件与滚动条也跟着走
  } catch (_e) { /* 隔离态读不到 localStorage */ }
</script>
```

这段代码只负责启动那一瞬；之后主题切换走 `init` / `theme` 消息，与它无关。

### 2.5 注册

`plugins/registry.js` 加一条（或运行时点侧栏 **＋** 安装，存 `installed-plugins/`）：

```js
{ id: 'my-plugin', name: '我的插件', icon: '◆',
  type: 'iframe',                    // 'module' | 'iframe'
  entry: './runtime-plugins/my-plugin/index.html',
  runtime: true, requiresBuild: true,
  description: '……（跟随面板主题）' }
```

> 注册表顶部写明了当前约定：**插件配色一律走外壳推过来的主题变量，没有
> 第二套机制；外壳不做反转、不做覆盖，变量给到哪就渲染到哪**。
> 因此注册表里**没有** `followsTheme` 之类的基调声明字段。

---

## 3. 主题：唯一机制

### 3.1 变量从哪来

| 层 | 文件 | 内容 |
|---|---|---|
| 尺度令牌 | `css/tokens.css` | 阴影档、圆角、时长、字号、字体、层级；**只定义变量，不写选择器** |
| 主题变量 | `css/neumorphism.css` + `js/themes.js` | `--bg` `--surface` `--surface-sunk` `--surface-raised` `--text` `--text-soft` `--text-dim` `--text-mute` `--accent` `--accent-glow` `--divider` `--border` `--sh-dark` `--sh-light` `--edge` `--hairline` `--r-*` 等 |
| 宿主推送 | `js/host.js` / `js/plugin-sdk.js` | `init` / `theme` 消息带变量与 `themeId`；iframe 写 `:root`，module 直接继承 |

深浅、风格、强调色全部由宿主决定：**23 套预设（深色 16 + 浅色 7）+ 自定义主题，
只换 CSS 变量，DOM 与 CSS 文件一行不改**（README 第三章）。

### 3.2 插件要做的三件事

1. 引入共享样式（§2.3），保证变量存在；
2. 所有颜色写 `var(--…)`，不写死、不私有、不互换（§0.1）；
3. 需要按主题重画的内容（如 canvas / mermaid 缓存），监听 SDK 派发的
   `nexus-theme-applied`，并读 `document.documentElement.dataset.nexusBase`
   （`data-nexus-base`）——SDK 会把 `themeId` 写进 `data-theme`。

### 3.3 已废弃的机制，别照着老文档做

以下机制在 2026-10 被整套删除，理由见 `js/host.js` init 处、`js/themes.js`
顶部、`js/plugin-config.js` 顶部注释，以及 `follow-theme-test.mjs` 文件头：

- 注册表声明 `followsTheme`、宿主下发 `reportBase`、SDK 回发 `base-report` 自报基调；
- 外壳据此给插件罩 `invert(1) hue-rotate(180deg)` 反转滤镜 / `adaptTheme` 开关。

**当前只剩一条链**：宿主把变量推到哪，插件就渲染到哪，`不做反转、不做覆盖`。
`plugin-config.js` 里的 `themeDark` / `themeLight` 是**宿主侧**允许给插件挑两套
预设主题的配置，不是插件自己定义样式的入口；新插件不得依赖它做 UI 分支。

> ⚠️ 主仓 `README.md` 第四章、`3.7.10`，以及 `docs/样式检测标准.md` §12
> 记录的是**旧机制**（L2 反转滤镜、自报基调、基调重报）。这些章节保留作历史，
> **新插件以本文件 §3 与 `follow-theme-test.mjs` 的当前断言为准**。

### 3.4 任务管理器现状核查（按 §0.1）

从独立仓 `plugins/task-board/styles.css`（2886 行）实测：

| | 现状 | 按 §0.1 判定 |
|---|---|---|
| 主体 | 引入 `tokens.css`，112 处 `--sp-2`、63 处 `--divider`、61 处 `--accent`、50 处 `--text-mute`、44 处 `--text`、26 处 `--bg` … | ✓ 合规 |
| 私有变量 | 4 处 `var(--nx-fg / --nx-fg-dim / --nx-bd-strong, #9ca3af / #e5e7eb)`；这三个变量在主仓与插件仓**都没有定义** | ✗ 实际生效的是写死兜底色，属"自己定义" |
| 明暗互换 | 2 处 `color: var(--bg)`、2 处 `background: var(--text-mute)` | ✗ 把主题变量翻过来用，属"自己定义深浅"，需逐个复核 |

这些是**按本条要求的待整改项**。本文只落规范，不改插件 CSS；整改要动插件仓
`plugins/task-board/styles.css`，属另一次变更。

### 3.5 自检命令（主仓 `nexus-panel/` 下）

```bash
node style-standard-test.mjs --dir plugins/<id>      # 新界面严格判定：令牌化 / 对比度 / 类名卫生
node follow-theme-test.mjs                           # 当前主题跟随约定（注册表 / host / SDK）
node plugin-theme-test.mjs                           # 插件自选主题（宿主侧配置）回归
node theme-tokens-test.mjs                           # 主题令牌完整性
```

换肤人工验收：深色 16 套里挑一套、浅色 7 套里挑一套，各点一遍，看插件里
有没有哪一块颜色不动、文字消失、或冒出与面板相反的基调。

---

## 4. ctx API 速查

两种挂载方式完全一致，完整签名看 `js/plugin-sdk.d.ts`，主仓 `README.md` 第七章。

| 能力 | 用法 |
|---|---|
| 根节点 / 卸载 | `ctx.root`、`ctx.onDestroy(fn)`、`ctx.addStyle(css)` 返回移除函数 |
| Rust 调用 | `ctx.invoke('cmd', args)` |
| 持久化 | `ctx.store.get/set/del/all`（沙箱走桥接，都是 Promise） |
| 事件 | `ctx.emit` / `ctx.on` / `ctx.listenTauri` |
| 服务插件 | `ctx.services.call(id, method, args)`、`ctx.services.available(id)` |
| 外壳 | `ctx.shell`、`ctx.setTitle` / `setBadge` / `toast` / `reload` / `openPlugin` |
| 快捷键 / 侧栏项 | `ctx.registerShortcut` / `addSidebarItem`（只在自己激活时生效） |
| 生命周期 | `ctx.owned`：定时器、监听、DOM、样式统一登记，`dispose()` 一次清完 |

服务插件（`kind: 'service'`）用 `bootServicePlugin` 声明方法，调用方**取消返回
`null`、不抛异常**；详见 `plugins/README-services.md`。

---

## 5. 构建与发版

- Vite 插件由 `scripts/build-plugins.mjs` 独立构建到 `runtime-plugins/<id>/`，
  生产态经 asset 协议加载，改前端不重编主程序；注册表标 `runtime: true`。
- 独立仓的 CI 模板在 `templates/plugin-repo/`：
  - `release.yml`：发版工作流，**构建发生在 CI，不在用户机器上**；产物是
    `tar.gz`，用户点安装 = 下载 → 校验 → 解压即用。文末有「插件仓库最低文件清单」，
    按它补齐后再复制。
  - `contract.yml`：跨端契约校验，**不是所有插件仓都装**——只有同时持有
    `plugins/<id>/api.ts` 与 `types.ts` 的仓才用；缺 `api.ts` 装上去会得到一条
    必然红的"契约源缺失"。校验器 `cross-end-check.mjs` 读不到源即 fail-closed。
- 主仓是公开仓，插件仓 CI 可匿名 shallow clone 取 Rust 声明与校验器，
  **不要把私有仓凭据带进 workflow**。

---

## 6. 常见坑（都踩过）

| 坑 | 表现 | 正确做法 |
|---|---|---|
| 私有颜色变量没人定义 | "功能没坏但不跟随主题"，实际显示写死兜底色 | 直接用 `--text` / `--divider` 等宿主变量 |
| 漏 `@import tokens.css` | 变量静默降级，不报错 | iframe 插件自己引，见 §2.3 |
| `color: var(--bg)` 当文字色 | 换主题后该块对比度崩 | 文字用文字档，底板用表面档，不互换 |
| 首帧没铺底色 | 深色面板下白闪一两百毫秒 | §2.4 的 `<head>` 脚本 |
| `--border` 当分隔线 | 新拟态下它是 `transparent`，线整个消失 | 用 `--divider` |
| `var(--x, 兜底)` 给私有变量兜底 | 兜底永远生效 = 写死颜色 | 私有变量本身就不该存在 |
| 照 README 第四章加反转滤镜 | 机制已删除，越加越错 | 见 §3.3 |
| 把插件文件推回主仓 `plugins/<id>/` | 重新创建已退役的死路径 | 按 `sync-manifest.json` 归属 |

---

## 7. 提交前自检清单

- [ ] `nexus.plugin.json` 四必填齐全，目录名 = id，id 符合正则；
- [ ] 没有 `builtin` / `trusted` / `permissions` 当权限依据；
- [ ] iframe 插件引了共享样式，`<head>` 有首帧底色与 `color-scheme`；
- [ ] **所有颜色走主题变量，无私有色板、无写死兜底、无明暗互换**（§0.1）；
- [ ] 没有 UI 层的深/浅分支，没有反转滤镜、自报基调；
- [ ] 深浅各挑一套主题人工换肤验收过；
- [ ] `node style-standard-test.mjs --dir plugins/<id>` 通过；
- [ ] Vite 插件确认 `runtime-plugins/<id>/` 产物与主仓注册表 entry 对得上；
- [ ] 改动按本地归属映射清单推到**正确仓库**：插件源码 → 独立仓，
      外壳 / 守卫 / 模板 / 文档 → 主仓。

---

## 8. 相关文档索引（均在主仓）

| 文档 | 看什么 |
|---|---|
| `README.md` 二 / 三 / 四 / 七 / 八 / 十三章 | 开发插件、主题系统、ctx API、换肤样式规范、开发辅助脚本 |
| `docs/样式检测标准.md` | 令牌化、对比度、可访问性、类名卫生的可执行条款（§14 是本要求的规范版） |
| `plugins/README-services.md` | 服务插件调用与降级 |
| `js/plugin-sdk.d.ts` | ctx 完整签名 |
| `js/plugin-manifest.js` | manifest 校验规则 |
| `follow-theme-test.mjs` / `plugin-theme-test.mjs` | 当前主题跟随约定的可执行断言 |
| `templates/plugin-repo/*.yml` | 独立仓 CI 模板 |
