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
├── panels.js             侧栏四页（文件 / 样式 / 标签 / 主题）与浮层
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
| `←` | 有子节点且展开 → 先折叠；否则上移到父节点 |
| `→` | 折叠着 → 先展开；否则进入第一个子节点 |
| `/` | 折叠 / 展开选中节点（叶子无效） |
| `Alt+1~5` | 从选中节点展开到第 N 级（更深层收起） |

`←` / `→` 用的是两级语义（先折叠/展开，再移动），与 XMind 一致；
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

## 附件元信息（文件页）

文件页签展示两类信息，都放在两个 section 顶部的小表格里。

**文件信息**：名称 / 大小 / 类型 / 修改时间。
修改时间取 `File.lastModified`（本机文件的真实修改时间）；
从 XMind 包里还原出来的附件没有这个信息，退化为入库时间。

**视频元信息**：时长 / 分辨率 / 帧率 / 比特率 / 视频编码 / 音频编码 / 容器。

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
- **未做真实浏览器渲染验证**（沙盒无法安装 Chromium），kityminder 的 SVG 渲染需在 Tauri 里实测确认。
