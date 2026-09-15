# 思维导图插件（mindmap）

把 `junction_link` 里的 C# WPF 思维导图模块移植成 Nexus Panel 插件。

## 结构

```
plugins/mindmap/
├── index.html            插件页面（工具栏 / 侧栏 / 画布页签）
├── index.js              主入口：状态、持久化、撤销栈、导入导出
├── editor-bridge.js      与内层编辑器的命令桥接
├── store.js              IndexedDB 持久化（工作簿 / 主题 / 快照 / 附件）
├── workbook.js           多画布模型 + JSON / Markdown 序列化
├── themes.js             10 个内置主题 + 6 个布局模板元数据
├── io.js                 文件导入导出、附件 Blob 存储
├── xmind.js              XMind(.xmind) 导入导出（含自写 zip 容器，零依赖）
├── panels.js             右侧属性侧栏四页（主题 / 标签 / 样式 / 文件）与浮层
├── layout-thumbs.js      六个布局模板缩略图（内联 data URL，取自 WPF 原版资源）
├── filelist.js           左侧文件库（多文档列表 / 文件夹 / 拖拽归类）
├── styles.css            样式（全部走外壳主题变量）
└── editor/               kityminder 内核（取自 junction_link 的 dist/，4 个文件）
    ├── index.html
    ├── kity.min.js
    ├── kityminder.core.min.js
    └── kityminder.core.css
```

## 为什么是嵌套 iframe

插件层与编辑器层**同源**，但仍是各自独立的文档：

- 编辑器的 `#minder-container` 是 `position:absolute; inset:0`，天生要铺满整个视口。若合并成单页，会盖住工具栏，必须改写布局 CSS；
- 嵌套后编辑器 1900 多行代码里 **95% 是脚本，一字未改**就能跑，以后上游更新直接覆盖 4 个文件；
- 命令调用是 `iframe.contentWindow.__minder.xxx()` 同步直调，不用再拼 JS 字符串交给 `ExecuteScriptAsync`。

编辑器页面取自 `junction_link/数据/plugins/kityminder/dist/`（运行时实际加载的那份），
仅把 5 处 `window.chrome.webview.postMessage(...)` 抽象成 `hostPost()`，
WPF 宿主行为完全不变。

## 相比原 C# 实现的改动

| 项 | 原实现 | 现在 |
|---|---|---|
| 命令调用 | 拼 JS 字符串 + `ExecuteScriptAsync` | 同源同步直调 |
| U+2028/2029 破坏语法 | 需转义规避 | 不存在该问题 |
| Promise 返回值 | 不等 Promise，需轮询 `pollExportPng` | 直接 `await` |
| 附件 | 存本地文件路径，文件移动即失效 | 存 Blob 进 IndexedDB（XMind 导出时打进包内，换机可还原） |
| 持久化 | `数据/` 目录 JSON 文件 | IndexedDB（实时缓存）+ 显式导出文件 |

## 数据与安全

- **实时缓存**：编辑停止 800ms 后写入 IndexedDB；按配置间隔自动留一份快照（滚动保留 10 份），内容没变不写盘；插件卸载前再兜底存一次。闪退后重开即为最新内容。
- **显式存档**：`.xmind`（与 XMind 官方互通）、`.json`（保留全部私有字段）、`.txt`、`.md`、`.svg`、`.png`。
- 落盘优先用 File System Access API（能弹真正的保存对话框），不支持时回退 `<a download>`。

## 界面分布（对齐 C# MindMapPanel）

按 `MindMapPanel.xaml` 的四行两列重排过。此前四块面板全堆在画布**左侧**，
右侧栏从来不存在。

```
┌──────────────────────────────────────────────┐
│ 顶部工具栏（导入导出 / 插入 / 编辑 / 选择 …） │  Row 0
├──────┬───────────────────────────┬───────────┤
│ 文件 │                           │  属性侧栏 │  Row 1
│ 库📚 │          画布              │  276px    │
│ 默认 │                           │ 主题/标签 │
│ 收起 │                           │ 样式/文件 │
├──────┴───────────────────────────┴───────────┤
│ 画布页签条（页签横向滚动 + 最右 ＋）          │  Row 2
├──────────────────────────────────────────────┤
│ 状态条                                        │  Row 3
└──────────────────────────────────────────────┘
```

| 位置 | 内容 | 与 C# 的差异 |
|---|---|---|
| 左 · 文件库 | 多文档列表 / 文件夹 / 拖拽归类 | **C# 没有**（Web 版多文档功能），故默认收起，点 `📚` 展开 |
| 中 · 画布 | kityminder 编辑器 | 一致 |
| 右 · 属性侧栏 | 主题 / 标签 / 样式 / 文件 四页 | 宽度取 C# 的 `Width="276"`；无差异 |
| 顶栏最右 | 四个属性页签 | 一致（C# 的 `Grid.Column=14`） |
| 底 · 页签条 | 画布页签 + 最右 `＋` | 一致（C# 也是 `ScrollViewer` + 右侧 `＋`） |
| 底 · 状态条 | 操作反馈 | 一致（C# 在 `Grid.Row=3`） |

**页签放在顶栏最右，不占侧栏高度**：侧栏只有 276px 宽，纵向空间本就紧张，
顶部再压一条页签条等于凭空少一屏内容。页签与侧栏通过 `onPage` 回调保持同步 ——
侧栏会自行切页（例如点节点附件时跳到「文件」页），此时顶栏高亮也要跟着变，
所以不能只在点击时更新。

**状态条从页签条里拆了出来**：原先两者挤在同一行，页签一多就把状态文字顶得
忽长忽短；拆开后成独立两行，与 C# 一致。

## 文件库（左侧面板）

点左侧图标条的 `📚` 展开/隐藏。**默认收起** —— C# 原版没有左栏，收起时画布
左右只剩属性侧栏一侧占位，更接近原版观感。展开状态记在设置里，下次进来保持。

**一个文件 = 一份工作簿**（含多张画布），与右侧属性侧栏是两回事：

| 面板 | 作用对象 |
|---|---|
| 左侧文件库 | 整个文档 —— 切换编辑哪个脑图、建文件夹归类 |
| 右侧属性侧栏 | 当前选中的**节点** —— 样式 / 标签 / 主题 / 附件 |

交互：

- **打开**：点列表项直接切换（先收当前编辑并落盘，保存失败会拒绝切换，避免丢内容）
- **新建**：`＋` 建脑图、`📁` 建文件夹
- **归类**：把文件拖到文件夹上即归入，拖回根目录区域即移出
- **折叠**：点文件夹标题行
- **删除**：删文件夹只删壳，里面的脑图移到根目录（不连带删除）；删脑图需确认

数据布局（`store.js`）：

```
fileindex   [{ id, name, folderId }]   列表索引，不含画布内容
folders     [{ id, name, collapsed }]
doc:<id>    单个脑图的内容（一份工作簿）
```

列表只存轻量索引，不存画布内容 —— 否则每次打开都得把所有脑图读进内存。

**旧数据迁移**：早期版本整个插件只有一份工作簿（存在 `workbook` 键下）。
首次进入会把它迁成第一个文件「我的脑图」，老用户不丢内容。

## XMind 互导

`xmind.js` 对齐 `junction_link/src/Services/XMindConverter.cs`：

- 包结构：`content.json`（XMind 官方标准）+ `kityminder.json`（本工具无损快照）+ `metadata.json` + `manifest.json` + `resources/`
- 读取三档优先级：无损快照 → Zen/2020+ `content.json` → XMind 8 `content.xml`
- 附件按字节打进包内，导入时解回 IndexedDB，跨机器可还原

底层是自己实现的（C# 的 `ZipArchive` / `XDocument` 在 JS 侧没有等价物）：
zip 容器自写 CRC32 + 原生 `CompressionStream('deflate-raw')`，XML 走 `DOMParser`，**零第三方依赖**。

## 画布跟随外壳亮/暗主题

原版画布底色写死 `#1E1E1E` 以贴合 WPF 深色外壳。插件版改为跟随 nexus 外壳主题：

- 编辑器页面的画布相关配色抽成 `--km-*` CSS 变量（容器底色、内描边、搜索面板、加载遮罩），
  默认值为原版深色，**WPF 宿主不调用新门面时行为完全不变**；
- 插件层从外壳主题变量派生画布配色（`deriveCanvasTheme`），`postMessage` 传给内层编辑器页
  —— 内层是独立文档，外壳注入的 CSS 变量进不去；
- 内核 `setTheme()` 会执行 `renderTarget.style.background = getStyle('background')`，
  内联样式优先级高于 CSS 规则，所以门面在每次 `setTheme` / `importJson` 之后会重新套一次；
- 编辑器重载、页面初始化早于消息到达两种情况都已覆盖（门面就绪后补套 pending 值）。

**分工**：外壳主题决定画布明暗，kityminder 主题决定节点配色。节点都绘制了不透明底色，
因此画布变色不影响节点内文字的可读性。

## 2026-09-14 修复记录（M1~M8）

按 `mindmap插件_待修清单.md` 的严格审查结论逐项修复。修复集中在一个提交里，
原因是 **M7 与 M1 联动**：M1 修好后自动保存才真正落盘，此时 M7（切换画布不落盘）
会从「被 M1 掩盖」变成新的数据丢失点，分开修会留下一个中间态。

| 编号 | 优先级 | 修复 | 位置 |
|---|---|---|---|
| M1 | 🔴 P0 | 自动保存改写 `doc:<currentFileId>`，并加切换文件竞态守卫 | `index.js` `doSaveInner` |
| M2 | 🟡 P1 | 解压加单条 64MB / 整包 256MB / 条目数 1 万三重上限，边读边累计 | `xmind.js` `inflateRaw` / `zipRead` |
| M3 | 🟡 P1 | 解析递归深度上限 200、节点总数上限 20 万 | `xmind.js` 三处递归 |
| M4 | 🟢 P2 | 主题消息只认 `window.parent` 发来的 | `index.js` `watchShellTheme` |
| M5 | 🟢 P2 | 下载前对附件名过一遍 `safeFileName`（顺带修掉纯点号名） | `index.js` / `io.js` |
| M6 | 🟢 P2 | `undo` / `redo` 对称加 `if (lastSnap)` 守卫 | `index.js` |
| M7 | 🟢 P2 | `switchSheet` 补 `await persist()` | `index.js` |
| M8 | 🟢 P2 | 读写失败记进 `lastStoreError`，初始化末尾推到状态栏 | `store.js` / `index.js` |

### 两个值得记的判断

**M1 的竞态是修复的一部分，不是可选优化。**
改成写 `doc:<id>` 之前，自动保存写的是没人读的 `'workbook'` 键，
反而意外躲过了「迟到的保存盖到新文件上」。改对键之后这个风险才真实存在，
所以 `doSaveInner` 在 `await` 前后各比对一次 `currentFileId`，不匹配就丢弃这次保存。

**但光有那句守卫还不够 —— 它依赖「捕获 id」与「写入」之间没有 `await`。**

```js
const savedFileId = currentFileId;                    // ① 捕获
//   ← 这里一旦插入 await，保护就静默失效
const saved = await store.doc(savedFileId).save(workbook);   // ② 写入
if (savedFileId !== currentFileId) return;            // ③ 守卫
```

`workbook` 是闭包变量，在 ② **调用那一瞬间**求值。① ② 之间没有让出点时，
它还是捕获那一刻的对象，安全；一旦中间让出，`switchToFile` 可能已经跑完 ——
于是 `savedFileId` 还是旧 id，`workbook` 却已换成新文件的内容，
结果是**用新文件内容覆盖旧文件**。而 ③ 只能拦住状态栏和备份，拦不住已发生的写入。

已实测（测试里的对照组）：两组代码守卫完全相同，只差中间有没有 `await`，
有 `await` 的那组 `doc:f1` 直接被写成 f2 的内容。

因此 `mindmap-test.mjs` 除了验证守卫存在，还锁住「① ② 之间恰好一个 `await`，
且它就是 save 调用本身」。插入一个看似无害的 `await Promise.resolve()` 会让测试变红 ——
这条断言做过变异验证，不是摆设。

**M7 只改 `switchSheet`，没改 `switchToFile`。**
清单建议两处都加，但 `switchToFile` 的三个调用点里：

- `openFile` 已经先 `capture()` + `await persist()`，重复落盘是白写一次；
- `deleteFile` 调它时**当前文件刚被删掉**，此时 `persist()` 会把内容写回已删除的
  `doc:<id>`，留下一份没人引用的垃圾数据 —— 这正是 `deleteFile` 注释里点明的坑。

所以只在 `switchSheet` 补落盘。

### 测试

新增 `mindmap-test.mjs`（`npm run test:mindmap`），69 项断言。
自带 IndexedDB 内存桩（jsdom 不带 IndexedDB），桩上留了 `failPut` / `failTx` 开关
专门用来验证 M8 的「失败要看得见」—— 否则错误处理就是没测过的空壳。

- 数据层：直接跑真实代码；
- `index.js` 里依赖 kityminder / 真实渲染的部分（M4 / M6 / M7），
  用**源码契约断言**锁住：改回去即失败。不是因为偷懒 ——
  沙盒里没有 Chromium，硬挂载只会得到一堆假绿。

## 异步与存储的错误处理约定

这块踩过坑，写成约定以免后续改回去：

1. **`store.set` 失败是「返回 false」而不是抛异常**。所以检查写入结果必须判返回值，
   只写 `try/catch` 等于静默丢弃。已统一：`persist()` / `doSaveInner()` / `saveThemes()` /
   `backupNow()` / `setBackupMinutes()` / `setAnimate()` 全部判返回值并提示。
2. **onclick 拿不到 Promise**。所有面板/工具栏入口经 `guard()` 或 `api` 层包装，
   异步失败落状态栏，不留 unhandled rejection。`doSave()` 跑在定时器里，单独包一层。
3. **画布 `content` 运行时是对象**（`exportJson()` 返回对象，仅序列化落盘后才是字符串）。
   任何比较都必须按内容：`sameSnap()` 比较、`fingerprintSheets()` 序列化后再拼。
   直接 `===` 或用字符串拼接会让「内容变了没」的判断永远失效
   （对象转字符串是 `[object Object]`，备份去重会退化成只认画布增删/排序）。
4. **Blob URL 要释放**。`getAsset()` 每次调用都新建一个 URL；交给浮层的由浮层关闭时
   `revoke`，走下载路径的就地释放，否则反复点附件会一直堆积。

## 侧栏 / 工具栏的分工（对齐 C# MindMapPanel）

C# 版把**文字格式**放在右侧栏 `SidePageStyle` 的第一段，顶栏只有
上移/下移、编辑/删除、链接/图片/备注/文件/外框/视频、选择、搜索。

早期插件版把文字格式（字体下拉 / 字号下拉 / 取色块 / 粗斜删 / 水平 + 垂直对齐）
全塞进顶部工具栏，导致：

- 顶栏 40 多个控件挤在一起，两个 `select` + 色块最占宽度；
- 这些控件**无状态**，无法回显当前节点的格式（而编辑器 `collectNodeStyle`
  上报了 `fontFamily / fontSize / color / bold / italic / strikethrough /
  textAlign / verticalAlign`，侧栏可以按选中节点高亮）。

现已改回 C# 的分工：

| 位置 | 内容 |
|---|---|
| 右侧栏·样式 | 文字（字体/字号/字体色/粗斜删/水平/垂直）· 节点填充 · 节点边框 · 连线 · 圆角 · 外观（整理布局）· 样式刷 · 清除样式 |
| 右侧栏·标签 | 优先级 · 进度 · 图标 · 超链接 · 备注 |
| 右侧栏·主题 | 配色主题（含自定义增删改）· 布局模板 · 视图 |
| 右侧栏·文件 | 文件附件 · 视频附件 · 备份与恢复 · 布局动画 · 导入导出 |
| 顶部工具栏 | 导入导出 · 下级/同级/上级/删除/上移/下移/编辑 · 撤销重做 · 外框 · 六种选择 · 搜索定位 · 重载 |

对照 C# 时补回的遗漏项：**外框**（`boundary`，数据层早已支持导出/导入，
只是 UI 一直没入口）、**上移 / 下移**（`arrangeup` / `arrangedown`）、
**整理布局**（`resetlayout`）。

## 对照 C# 的完整性核查

按 `MindMapPanel.xaml` 的控件清单与 `MindMapPanel.xaml.cs` 的全部 `On*` 处理函数逐条比对。

**已补齐的遗漏项**

| 项 | C# | 插件 |
|---|---|---|
| 复制画布 | `OnSheetDuplicateClick`（页签右键菜单） | 顶栏「复制」+ 页签 `⧉`（无右键菜单，改双入口） |
| 主题导入 JSON | `OnImportThemeClick` | 主题页「导入」（重新生成 id，不覆盖现有） |
| 主题导出 JSON | `OnExportThemeClick` | 主题页「导出」（导出当前画布在用的自定义主题） |
| 外框 | `boundary` | 顶栏「外框」 |
| 上移 / 下移 | `arrangeup` / `arrangedown` | 顶栏「上移」/「下移」 |
| 整理布局 | `resetlayout`（样式页「外观」段） | 样式页「外观」段 |

**顺带修掉的一个错命令**

主题页「视图」段原有「整理布局」用 `exec('arrange')`。查内核后确认
`arrange` 是**拖拽排序模块的内部命令**（需要 index 参数），单独执行无效；
真正的整理布局是 `resetlayout`（`LayoutModule` 注册，快捷键 Ctrl+Shift+L）。
已移除主题页那个，统一用样式页「外观」段的 `resetlayout`。

## 快捷键

快捷键由**编辑器页面**（`editor/index.html`）与 kityminder **内核**注册，
插件层无法改写，只能在文件页「快捷键…」里如实列出（18 条）。

页面显式注册：Tab / Enter / Delete / F2 / Ctrl+B / Ctrl+I / Ctrl+D /
Ctrl+E / Ctrl+L / Ctrl+R / Ctrl+Shift+C / Ctrl+Shift+V

内核 `commandShortcutKeys` 注册：Alt+↑↓（上移下移）/ Shift+Tab（插入上级）/
Ctrl+Shift+L（整理布局）/ Ctrl+=-（缩放）/ Ctrl+A（全选）/ Ctrl+C/X/V

### 行内编辑：不只是回车才提交

早期版本「输入完必须按回车，点旁边就白输」。根因在 kityminder 的两处设计：

```js
// text 命令的执行体：只写「当前选中的节点」
execute: (minder, v) => { const n = minder.getSelectedNode(); n && (n.setText(v), …) }
// 且 queryState 要求选中数恰好为 1，否则命令被直接拒绝（不报错、不写）

// select 模块的 mousedown：点画布会立刻改/清选中
b ? this.select(b, true)                          // 点到节点 → 改选中
  : (this.removeAllSelectedNodes(), …)            // 点空白   → 清空选中
```

于是「编辑中 → 点旁边」有两种坏结果：点空白 → 选中被清空，命令被 `queryState`
拒绝，输入**静默丢失**；点别的节点 → 选中改了，文字被写到**错误的节点**上。

**修复**：两道保险，且互相独立。

| 位置 | 作用 |
|---|---|
| `document` 捕获阶段的 `mousedown` | 抢在内核改动选中**之前**提交。只靠 blur 不够 —— SVG 不可聚焦，焦点何时转移取决于内核是否抢焦点，时序不可依赖 |
| `closeTextEditor` 内 | 提交前若 `getSelectedNode() !== editLayer.node` 就先 `select` 回来，让提交与「当前选中是谁」彻底解耦 |

顺带把 `editLayer = null` 提到 `execCommand` 之前：`execCommand` 会触发渲染与
事件，万一重入会二次提交。

### 前提：焦点必须在画布上

kityminder 的所有键盘输入都来自一个隐藏的 `<input class="km-receiver">`，
它由内核自己在 renderTarget 里创建。**焦点不在这个 input 上时，上面 18 条
快捷键一条都不会生效** —— 这是最容易踩的坑，比快捷键本身更值得记住。

典型表现：点过工具栏的按钮之后，Tab 不再建下级节点，而是在按钮之间跳
（浏览器拿它做焦点导航了）。点一下画布能立刻恢复，因为内核在
`beforemousedown` 里 `focus()` 并 `preventDefault()`。

为了让「点完按钮接着按 Tab」也能用，做了两件事：

| 位置 | 处理 |
|---|---|
| `editor/index.html` | 把「聚焦画布」「插入子节点」暴露成 `window.__minderFocusCanvas` / `window.__minderInsertChild`（与 Tab 共用同一份实现） |
| `editor-bridge.js` | 新增 `focusCanvas()` / `insertChild()`，先给 iframe 的 window 焦点，再调内层门面 |
| `index.js` | `bindTabForward()`：在 window **捕获阶段**拦下 Tab，焦点不在文本控件里就 `preventDefault` 并转送；工具栏按钮 `onclick` 执行后调 `focusCanvas()` 归还焦点 |

为什么用捕获阶段：要在浏览器执行「Tab → 移动焦点」之前拦下来，冒泡阶段已经晚了。
为什么不跨文档冲突：keydown 不跨 iframe 冒泡，焦点在编辑器里时插件层收不到，不会重复触发。

按钮后归还焦点的意义不止 Tab —— Enter / 方向键 / Delete / Ctrl+B 同样依赖 receiver，
点过按钮后会一起失效。放在 `onclick` 末尾而非 `setTimeout`：handler 里若调了
`window.prompt` 这类同步模态，焦点会在用户关掉对话框之后才移动，顺序正好。

### 内核没实现的三个，由本插件补齐

编辑器页面原本的注释写着「core 内置方向键导航、/ 折叠、Alt+1-5 展开层级」，
**这句是错的**。查 `kityminder.core.min.js` 可确认：

- `ArrowUp/Down/Left/Right` **零命中**；
- 键码表里预留了 `isSelectedNodeKey: {37,38,39,40}` 常量，但**全文件无使用处**；
- `/`(191) 同样只登记了键码，没有行为；
- 不存在 `expandToLevel` 命令（`expandSelectedToLevel` 是本页面的门面方法）。

即「常量预留了，行为没写」。现已在 `editor/index.html` 补齐：

| 键 | 行为 |
|---|---|
| `↑` / `↓` | 在兄弟节点间移动，到头不动 |
| `←` | 移到父节点（**只移动，不折叠**） |
| `→` | 进入第一个子节点（当前折叠着会先展开，避免选中隐藏节点） |
| `Ctrl + ←` | 折叠选中分支（不改变选中） |
| `Ctrl + →` | 展开选中分支（不改变选中） |
| `/` | 折叠 / 展开选中节点，来回切换（叶子无效） |
| `Alt+1~5` | 从选中节点展开到第 N 级（更深层收起） |

**方向键只管移动，折叠/展开单独一组** —— 这是对齐 XMind 的做法。
早先版本用的是「两级语义」（`←` 先折叠再上移、`→` 先展开再进入），
实际用起来会「想移动却把分支收起来了」，故改掉。

`Ctrl+←/→` 在 macOS 上按 `Cmd+←/→` 同样生效：内核键码解析里
`ctrl` 与 `cmd` 等价（`case"ctrl":case"cmd":`，事件侧判定 `a.ctrlKey || a.metaKey`）。
这正好避开 macOS 把 `Ctrl+←/→` 占用为「切换桌面」的系统快捷键。

折叠与展开都会触发 `contentchange`，因此会被自动保存接住。

同时修掉一个按键泄漏：外框标签输入框原先只 `preventDefault` 不 `stopPropagation`，
编辑外框标签时按 Enter 会顺带插入一个同级节点、按方向键会跑偏选中。

## 设置项（对齐 C# SettingsPanel 的脑图页）

| 设置 | C# | 插件 | 位置 |
|---|---|---|---|
| 布局过渡动画 | `MindMapLayoutAnimation` | `settings.animate` | 文件页「布局动画」 |
| 自动备份间隔 | `MindMapBackupMinutes` | `settings.backupMinutes` | 文件页「自动间隔」 |
| 最多保留份数 | `MindMapBackupMax`（默认 3） | `settings.backupMax`（默认 3） | 文件页「最多保留」 |
| 备份目录 | 可选目录 + 迁移 | ❌ 固定 IndexedDB | — |

「最多保留份数」原先是 `store.BACKUP_KEEP = 10` 硬编码常量，C# 是可配置的
（`MindMapBackupMax`，默认 3）。现已改为设置项：调小后**立即**滚动清理超出部分，
而不是等下次备份才收敛。非法值（0 / 负数 / NaN）退回默认 10 ——
否则会算出「保留 0 份」，每次备份都被立刻删掉。

## 画布上的附件图标

节点附加文件/视频后，图标画在节点**右侧**（`getContentBox().right` 起，
有文件时视频再右移 20 并排）。两个坑：

**不能把 `null` 传给 `fill()`。** core 的 `getStyle('color')` 在不少主题下返回
`null`（只在主题项里查得到才返回值），而 kity 的 fill 是：

```js
fill: function (a) {
    a && node.setAttribute('fill', a.toString());
    null === a && node.removeAttribute('fill');   // ← 删属性
}
```

SVG 缺 `fill` 属性时**默认渲染成黑色** —— 于是图标在深色画布上就是一块纯黑
矩形，看不出是文件还是视频。取不到主题色必须回落到明确颜色（`#AEB6C4`）。

**文件图标的 `fill` 要保持 `none`。** 实心填充会盖住折角那条内部线，
剩下一个没有辨识度的方块；改成描边图标后一眼能认出是「文件」。

图标另带 SVG `<title>`（附件名），悬停即可知道挂的是哪个文件 —— 光看图标认不出来。

## 主题配色条

每个主题原来只有一个圆点（根节点色），看不出画布底色和各级节点长什么样。
现在改成**四段配色条**：画布底 / 根节点 / 主节点 / 子节点。

四色全部取自 `kityminder.core.min.js` 的真实主题定义：

| 主题族 | 取值 |
|---|---|
| `fresh-*` | 内核用 HSL 生成：root = `H(h,37%,60%)`、main = `H(h,33%,95%)`，色相 `{red:0, soil:25, green:122, blue:204, purple:246, pink:334}` |
| `classic` / `snow` / `fish` | root `#E9DF98`、main `#A4C5C0`，直接读自源码 |
| `wire` | 无节点背景（`stroke:none`，只画 `#999` 的线），四色都记 `#999999` |

算出来的 fresh 系列 root 与原先手填的值**完全一致**（`#BF7373` / `#BF9373` /
`#73BF76` / `#73A1BF` / `#7B73BF` / `#BF7394`），两边互为校验 —— 测试里就用
HSL 公式反算一遍锁住。

**为什么必须显示四色而不是只显示 root**：`snow`、`classic`、`fish` 三者的 root
**同为 `#E9DF98`**，只看圆点完全分不出来；它们的差别在 sub（snow/fish 是白色、
classic 是透明）。

两个细节：

- 子节点 `transparent` 时按**画布底色**显示并加**斜纹**标记。留空白的话会被
  当成「这一项没有颜色」。
- 配色条有外圈描边 —— `snow` / `classic` 的画布底 `#3A4144` 与深色面板太接近，
  没有边就糊在一起。

自定义主题走 `palette` 字段（`background` / `rootBackground` / `mainBackground` /
`subBackground`），字段名与内置主题不同，由 `customSwatch()` 归一。

## 布局模板：缩略图 + 名称

对齐 WPF 原版右侧栏「布局」段（`UniformGrid Columns="2"` + `Image Width="100"
Height="58"`）：两列网格，每格一张缩略图 + 下方名称。此前只有一列纯文字按钮。

缩略图取自原版 `Assets/Layouts/layout-<value>.png`（100×40，浅灰线稿 + 透明底），
共六张，**内联为 data URL** 放在 `layout-thumbs.js`：

- 六张合计约 4.4 KB，base64 后仍在 6 KB 量级，对插件页面可忽略；
- 内联后不存在「相对路径解析不到 → 裂图」的可能。裂图在深色面板上的表现
  就是一块看不见的空白，与之前踩过的「黑框图标」同类，而 jsdom 不加载图片，
  测试根本抓不到。

缩略图底板固定用深色（`#1B1B1F`）—— 线稿是浅灰 + 透明底，压在浅色面板上
反而看不清。

## file 与 video 是两个独立字段，互不影响

节点数据里 `file` 与 `video` 各占一个字段，各自有独立的命令（`_commands.file` /
`_commands.video`）。**移除一个不能带走另一个** —— 这条边界由测试用
`editor/index.html` 的**真实命令源码**锁死（复刻一份的话，命令改了测试还是绿的）。

侧栏现在还会**主动校验**：移除某项后若另一项的引用也没了，直接在状态栏报出来。
静默丢掉的话用户只看到「侧栏空了」，无从判断是显示问题还是真丢了数据。

## 视频预览的三种状态必须分开说

「有引用但读不到本体」和「完全没有附件」是两回事，混在一起就会让人以为
附件凭空消失了 —— 节点上明明挂着（画布图标还在画着），侧栏却说「未附加」。

| 状态 | 显示 |
|---|---|
| 无 `video` 引用 | 未附加视频 |
| 有引用但无资产 id | **旧版本地路径，沙箱内读不到本体**（C# 版遗留 / xmind 未打包本体） |
| 有 id 但读不到 | 读取中… → 视频数据已丢失 |

同理，加载中不能是一块纯黑 —— 那也会被当成「没了」。

## 附件卡片与视频预览（文件页）

早先的形态是「两行文字 + 三个按钮」，文件长什么样完全看不出来，视频也只剩一个
「播放」按钮（点了才弹浮层）。现在改成：

**文件附件** —— 一张卡片：图标（图片则直接显示缩略图）+ 名称 + 大小，点卡片即打开
（图片就地预览，其余只能下载：沙箱拿不到真实路径）。图标按扩展名给，
`🖼 🎬 📕 🗜 📘 📗 📙 🎵 📃 🧩 📄`。

**视频附件** —— 16:9 预览区，默认显示**首帧**，点一下**就地播放**（不再弹浮层）。
下方摘要行给出 名称 · 时长 · 大小。

两个实现细节：

- **`src` 后面要带 `#t=0.1`**。只用 `preload="metadata"` 的话，不少浏览器不 seek
  就不绘制首帧，预览区是一片黑。`preload` 仍是 metadata：只拉头部，不会把整个
  视频读进内存。
- **▶ 提示层必须 `pointer-events: none`**。点击由容器统一处理（就地挂上 `controls`
  并 `play()`）；提示层若拦住点击，就成了「点了没反应」或双重触发。

**Blob URL 必须回收**。`io.getAsset(id, true)` 每次调用都**新建一个** URL（刻意为之：
调用方各自持有、各自释放，避免共享 URL 被谁提前 revoke）。代价是 refresh —— 切页、
附加/移除附件后重建 DOM —— 每次都会漏一批，而视频预览 + 图片缩略图一次就要两个。
侧栏没有 unmount 钩子，统一在 `render` 重建 DOM 前回收，池子挂在**侧栏实例**上
（模块级单例会被多个实例互相 revoke 掉还在用的 URL）。

## 附件元信息（文件页）

卡片与摘要行已经承担了名称 / 大小 / 时长，下面的小表格只列它们放不下的：

**文件信息**：类型 / 修改时间。
修改时间取 `File.lastModified`（本机文件的真实修改时间）；
从 XMind 包里还原出来的附件没有这个信息，退化为入库时间。

**视频元信息**：分辨率 / 帧率 / 比特率 / 视频编码 / 音频编码 / 容器。
（时长不在表里 —— 由 `fillVideoMeta` 解析完后回填给摘要行。）

这里有个坑值得记一笔：**浏览器 API 只给得出一半**。

| 字段 | 来源 |
|---|---|
| 时长 | `video.duration`（解码器实测，比容器里声明的 `mvhd` 可靠） |
| 分辨率 | 自己解容器 `stsd`（`videoWidth` 是显示尺寸，遇旋转元数据会给出旋转后的值） |
| 帧率 | 自己解容器：`stts` 总采样数 ÷ 轨道时长 |
| 视频/音频编码 | 自己解容器：`stsd` 四字符码（Web API **完全没有**对应能力） |
| 比特率 | 文件字节数 × 8 ÷ 时长（容器里声明的常不准） |

所以 `mediainfo.js` 自己实现了 MP4/MOV 的 box 树解析与 WebM 的 EBML 解析，
再与 video 元素拿到的时长互补。

几个实现上的取舍：

- **只读文件头尾各 2MB**。`moov` 常在文件尾部（非流式优化的 mp4），
  从尾部切片时起点可能落在 `mdat` 数据中间，常规 box 遍历会把它当
  `size==0`（延伸到文件尾）然后直接停下 —— 因此加了 `findMoov` 特征字节回退。
- **结果写回资产库**（`saveAssetMeta`），下次打开直接读，不重复解析。
- **容器解析优先于 video 元素**。早期版本让 video 元素无条件覆盖分辨率，
  结果非视频文件也会被填上一个凭空的分辨率。现在：容器有值用容器，
  解不出来才兜底，兜底也没有就显示 `—`，不编造。
- `Blob.arrayBuffer()` 在部分环境缺失，读文件头留了 `FileReader` 回退 ——
  否则容器解析会静默失败、元信息整片空白。

## 与 C# 版的差异说明

- **撤销/重做**：优先用编辑器自维护的历史栈 `window.editor.history`（上游 dist 页已补齐，100 步、基线模型），拿不到时回退插件层 50 步快照栈。
- **垂直对齐**：只移植 `valign`（上/中/下）。C# 另有 `Vo*` 九个滑块（3 层级 × 3 对齐的像素微调），那是临时调试脚手架，且「固化」时会用正则改写 `index.html` 源码 —— Web 沙箱无权改本地文件，故不移植。
- **搜索结果面板**：不需要插件实现。编辑器页面自带（匹配数 >3 自动弹出、可点击跳转、内容变化后自动重建），插件层只在工具栏显示「当前/总数」计数。
- **备份**：间隔可配（关闭 / 1 / 2 / 5 / 10 / 30 分钟），到点逐张比对指纹，内容没变不写盘，与 C# 版 `MaybeBackupAsync` 行为一致。
- **画布页签**：拖拽排序已实现（HTML5 drag，落点左半插前 / 右半插后，带竖条指示）。
- **导出格式**：XMind / JSON / TXT / Markdown / SVG / PNG 齐全。`.txt` 与 `.json` 同内容仅扩展名不同（对齐 C# 版）。

## 已知限制

1. **附件跨机依赖 XMind 或原文件**：`.json` 只带引用（文件名 + id），换机器后附件打不开；要连同附件迁移请导出 `.xmind`。
2. **沙箱内无法「打开」本地文件**：Web 拿不到真实路径，附件的「下载」等价于另存为。
3. **自定义图片图标**以 dataURL 内联进脑图，会显著增大文件，建议控制在 2MB 内。
4. 节点自定义图标集未移植（原项目用的是裁剪雪碧图）。

## 验证情况

- 数据层（序列化 / Markdown 互转 / 指纹去重 / 容错）：Node 单测通过；
- 配色派生（`parseColor` / `shiftColor` / `deriveCanvasTheme`）：Node 单测通过；
- XMind 层（zip 往返 / 三档解析 / 附件打包解包 / 坏输入）：Node 单测通过；
- **附件打包字节级验证**：构造带魔数的 PDF/MP4 样本，导出后拆 zip 逐字节比对，
  再清空库（模拟换机器）导入，确认字节、文件名、扩展名全部还原；
- 插件挂载 / 数据流 / 导入主题样式 / 补齐项 / XMind / 附件 / 画布主题 / 健壮性：
  jsdom 八组测试全通过；
- **M1~M8 修复**：`mindmap-test.mjs` 69 项断言全通过（含真实构造的 zip bomb
  与 2000 层嵌套样本）；
- **未做真实浏览器渲染验证**（沙盒无法安装 Chromium），kityminder 的 SVG 渲染需在 Tauri 里实测确认。

> 2000 层而非 10000 层：jsdom 的 `DOMParser` 在约 2000~5000 层时自己就 parsererror 了，
> 测不到 xmind.js。2000 层已远超 `MAX_DEPTH`(200)，足以验证截断逻辑。
