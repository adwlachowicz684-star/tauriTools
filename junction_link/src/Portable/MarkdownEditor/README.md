# Portable Markdown Editor（半独立 Markdown 编辑器/预览）

内置分栏 Markdown 编辑器：左编辑（实时高亮由 Markdig 解析）、右富样式预览（标题/表格/代码块/列表/引用/链接/图片），自带工具栏（标题层级、加粗/斜体/删除线、行内代码、引用、有序/无序列表、表格、围栏代码块、链接、图片、撤销/重做、打开/保存/另存为），支持拖放 .md、Ctrl+O/S/B/Z/Y、分栏/编辑/预览三种模式切换。

## 文件清单
- `MarkdownRenderer.cs` — Markdig AST → WPF `FlowDocument` 渲染器（纯函数式，无 UI 依赖）
- `MarkdownEditOps.cs` — 工具栏插入/包络/表格生成的纯文本操作（可单测）
- `MarkdownEditorWindow.xaml` / `.xaml.cs` — 编辑器窗（外观全部走 `DynamicResource` 主题键）
- `README.md` — 本契约

## 依赖
- NuGet：`Markdig`（解析）。其余仅 .NET 8 WPF + `System.Windows.Forms` 无关。
- 仅需 WPF 工程引用 `PresentationFramework`（默认 `<UseWPF>true</UseWPF>` 即可）。

## 主题资源键「契约」
窗口与渲染器靠**宿主 `App.xaml` 里的同名资源键**取色（缺失时回退内置暗色板，照样能跑）。端口到其它工程时，保证以下键存在即可获得与本项目一致的皮肤：
`BgBrush` `BarBrush` `CardBrush` `MainBrush` `MutedBrush` `AccentBrush` `BorderBrush` `ChipRowHoverBrush` `NeuAccentTint` `NeuInset` `GuideBgBrush`

## 接入方式（任意宿主）
```csharp
FenPeiXiangMuZu.Portable.MarkdownEditor.MarkdownEditorWindow.ShowWindow(owner, filePath, initialText);
```
- `ShowWindow` 幂等打开并 `Show()`；传入已存在文件则直接加载，否则可用 `initialText` 预填。
- 无界面依赖，宿主只需把本目录编译进工程（csproj 默认把 `src/**` 的 `.cs/.xaml` 自动编入，无需额外注册）。

## 待办 / 说明
- 编辑器源码区为纯文本（未做语法高亮）；预览由 Markdig 实时渲染（防抖 280ms）。
- 图片：本地/网络图片自动加载；相对路径相对当前文件目录解析。
- 若宿主无 `Microsoft.Win32` 打开/保存对话框，可将 `OnOpen/OnSaveAs` 换成宿主自己的 `IDialogService`。