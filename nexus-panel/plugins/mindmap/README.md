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

- 数据层（序列化 / Markdown 互转 / 指纹去重 / 容错）：Node 单测 20 项通过；
- XMind 层（zip 往返 / 三档解析 / 附件打包解包 / 坏输入）：Node 单测 31 项通过；
- 插件挂载与交互、数据流、导入主题样式、补齐项、XMind 集成：jsdom 五组测试全通过；
- **未做真实浏览器渲染验证**（沙盒无法安装 Chromium），kityminder 的 SVG 渲染需在 Tauri 里实测确认。
