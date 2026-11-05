# pdfium.dll 存放位置（退场后）

## 现状

12 个 iframe 插件源码迁出主仓时，`plugins/dupview/pdfium.dll` 一并消失；
`src-tauri/tauri.conf.json` 的 `bundle.resources` 里那条
`"../plugins/dupview/pdfium.dll": "pdfium.dll"` 却没跟着删。

后果不是「PDF 预览降级」，而是 **`tauri_build::build()`（见 `src-tauri/build.rs`）
在校验资源路径时直接失败**：`cargo check`、`npm run tauri:build`、
`npm run tauri:build:plain` 全部 100% 挂在此处。而当时 5 个退场态守卫和欠账台账
都不覆盖 cargo 链，体检单全绿 —— 属于「全绿但构建全挂」。

因此该 resource 条目已移除。**这不是把 PDF 功能修好了，只是解除了构建阻断**：
干净 clone 上仓库里没有 `pdfium.dll`，生产包不再随包分发它，运行时会走
`DUPVIEW_PDFIUM` → exe 同目录 → `src-tauri/resources/` → 系统库路径的兜底链
（见 `src/dupview/pdf.rs::find_library`）。在没有系统 pdfium 的机器上，
试卷查重的逐页预览会表现为「扫描没反应」。这笔欠账记在
`scripts/cargo-retirement-debt.json`，**不许静默当无事发生**。

## 恢复随包分发

1. 把本机仍存在的 `src-tauri/target/{debug,release}/pdfium.dll`
   拷到本目录：`src-tauri/resources/pdfium.dll`。
2. 在 `src-tauri/tauri.conf.json` 的 `bundle.resources` 里加回：

   ```json
   "resources/pdfium.dll": "pdfium.dll"
   ```

   注意路径是相对 `src-tauri/` 写的，**不要写回 `../plugins/...`**。
3. 把 `scripts/cargo-retirement-debt.json` 的台账销空，并同步更新
   `cargo-retirement-guard-test.mjs` 第 ④ 节的期望状态（守卫会在
   dll 出现时主动报红，逼你销账，不会自动放行）。
4. 跑 `npm run test:cargo-retirement` 与一次真实 `cargo check`。

> 二进制不进 git 也不能凭空生成：沙盒里没有这份 dll，所以本轮只能修构建链、
> 钉住欠账，恢复动作需要你在本机做。`cargo-retirement-guard-test.mjs`
> 会一直盯着「resources 里有没有指向已退场目录的路径」和「资源路径是否真实存在」。
