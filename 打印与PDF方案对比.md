# 打印与 PDF：方案对比（为什么现有做法不是最优）

## 结论先行

> **【已实施 · 2026-09】** 本方案已采纳并实现：默认走 svg2pdf，打印对话框作托底，
> 设置里新增「PDF 通道」让用户改默认。实现见
> `nexus-panel/plugins/mindmap/README.md` 的 P3 章节。
> 下方对比保留作为决策记录。


**现有所有方案都走错了路**。它们把 SVG 当"网页内容"处理——塞进 HTML、交给 webview 渲染打印。
但 kityminder 导出的**就是 SVG 矢量图**，SVG → PDF 是**矢量到矢量的直接转换**，根本不需要浏览器参与。

推荐改用 **`svg2pdf`**（Typst 官方出品，纯 Rust），一步拿到真正的静默 PDF 导出。

---

## 一、为什么现在的路绕远了

### 已验证的事实：kityminder 导出的 SVG 极干净

我逐项统计了 `kityminder.core.min.js` 与 `kityminder.core.css`：

| SVG 特性 | 出现次数 | svg2pdf 是否支持 |
|---|---|---|
| `linearGradient` / `radialGradient` | **0 / 0** | （不支持 spreadMethod） |
| `pattern` | **0** | 支持（我们不用） |
| `clipPath` | **0** | 支持（我们不用） |
| `foreignObject` | **0** | 不支持（我们不用） |
| SVG `filter` | **0**（唯一一次 `.filter(` 是 JS 数组方法） | 不支持（我们不用） |
| `opacity` | 0 | 支持 |
| `path` / `text` / `image` | **是** | **全部支持** |

字体族固定为 `Arial, "Microsoft Yahei","Heiti SC"`（见 svg encode 里写死的 style）。

**结论：用到的特性全部在 svg2pdf 的能力范围内，用不到的高风险特性一个都没碰。**
这意味着转换失败的风险很低，不是"试试看"。

---

## 二、四个方案对比

| | **A. svg2pdf**（推荐） | B. 现状（`mm_print` + `window.print()`） | C. tauri-plugin-printer-v2 | D. printpdf |
|---|---|---|---|---|
| 原理 | SVG → PDF **不栅格化** | 塞进 HTML → webview 打印 | WebView2 COM 静默打印 | 内部**就用 svg2pdf** |
| 静默导出 | ✅ 真静默，无需点对话框 | ❌ 必须用户在对话框确认 | ✅ | ✅ |
| 跨平台 | ✅ 纯 Rust，与 webview 无关 | ⚠️ wry 只实现了 macOS | ❌ **仅 Windows** | ✅ |
| 矢量无损 | ✅ "no quality is lost" | ⚠️ 经浏览器排版 | ✅ | ✅ |
| 需要 `windows-sys` | ❌ **不需要** | ❌ | ⚠️ 需 windows 相关 API | ❌ |
| 新增依赖体积 | ~8–13 MB / 223K SLoC | 0 | 3.5 MB / 52K SLoC | 比 A 更大（功能更多） |
| 多页（多画布合成） | ✅ PDF 原生多页 | ❌ | ❌ | ✅ |
| 成熟度 | 130 万次下载，v0.13.0（2025-03），MIT/Apache-2.0 | — | 3 个 breaking 版本，仅 122 下载/月 | 活跃 |

### 逐个说明

**A. svg2pdf** —— Typst 团队维护（作者 Laurenz 也是 Typst 核心）。
文档原话：*"The conversion will translate the SVG content to PDF without rasterizing them,
so no quality is lost."*
支持 `compress` / `raster_scale` / `embed_text` / `pdfa` 四个运行时选项；
`embed_text: true`（默认，v0.11.0 起）保留**可选中可复制**的文本，
`false` 则把文字转成路径（更保险但不可选）。

**B. 现状** —— 问题不在代码，在于 **wry 只在 macOS 实现了 `WebviewWindow::print()`**。
Windows/Linux 上是 no-op，只能回退 `window.print()`，
于是"走 Rust"在这两个平台上**没有带来任何实际收益**。

**C. tauri-plugin-printer-v2** —— 仅 Windows，且已知问题里明确写着
"PDF 打印用固定延时等待渲染（1.5s），超大 PDF 可能需要调整"。
依赖 WebView2 Runtime >= 1.0.1518.46。

**D. printpdf** —— 文档明确写了 *"Embedding SVGs (uses svg2pdf crate internally)"*。
它功能更多（多页、书签、图层、字体子集化），但我们只需要 SVG→PDF 一步，
直接用 svg2pdf 更轻。**注意它历史上踩过坑**：早期版本丢弃了 svg2pdf 输出里的
`/Resources` 子树，导致 Acrobat 打不开（issue #113 / #211），现已修。
若将来需要多页拼版/书签，再考虑从 A 换到 D。

---

## 三、svg2pdf 的关键优势：**多画布合成多页 PDF**

A32 已经能导出多画布 Markdown，A33 能导出整本 XMind。
但 **PDF 至今只能一张一张导**——SVG 不支持多页，而**PDF 原生支持**。

用 svg2pdf 的 `to_chunk()` 可以把每张画布转成 Form XObject，
再拼进一个多页 PDF。这是 WPF 原版也做不到的能力。

---

## 四、风险（诚实说明）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **依赖体积** | ~8–13 MB、223K SLoC（usvg / resvg / fontdb / pdf-writer） | 可关掉 `filters` feature 省一部分 |
| **中文字体** | 字体族是 `Arial, "Microsoft Yahei","Heiti SC"`。usvg 扫系统字体：Windows 有雅黑 ✅、macOS 有 Heiti SC ✅、**Linux 可能缺失** → 中文走形或变方块 | Linux 场景可内置一款开源中文字体（`load_font_data`） |
| **无法编译验证** | 沙盒无 cargo/rustc | 需本地 `cargo build` 确认 |
| **节点图片** | 走 base64 dataURL 内嵌，svg2pdf 支持；但**图片会被当作 DeviceRGB 处理，不做色彩管理** | 影响很小 |

---

## 五、建议的落地形态

保留现有打印对话框路线（交互式打印仍有价值），**新增**一条静默导出：

```
导出 ▾
  ├─ …（现有各项）
  ├─ PDF（矢量，静默）        ← 新增，走 svg2pdf
  │    └─ 可选：全部画布 → 一个多页 PDF
  └─ 打印 / 存为 PDF…        ← 保留（系统对话框）
```

Rust 侧新增一个 `mm_svg_to_pdf` 命令：入参 SVG 文本数组 + 选项，
返回 PDF 字节（或 base64），前端用现有 `io.saveBlob` 落盘。

---

## 六、参考来源

- svg2pdf（Typst 官方）：https://github.com/typst/svg2pdf · https://docs.rs/svg2pdf
- Microsoft Learn · WebView2 打印：https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/print
- wry `print()` 仅 macOS：https://docs.rs/tauri/2.4.1/tauri/webview/struct.WebviewWindow.html
- tauri print API 讨论：https://github.com/tauri-apps/tauri/issues/4917
- printpdf 内部使用 svg2pdf：https://docs.rs/printpdf/0.12.4/src/printpdf/svg.rs.html
- 从 WebView2 Print-to-PDF 迁到 Typst 的经验（Inkwell 案例）：说明浏览器打印管线的三个固有问题——
  仅 Windows、分页位置由浏览器决定、COM 接口脆弱
