# 已安装插件加载入口：把「只有真机能判」拆成确定性问题

> 第 61 轮。真实 Chromium 实证，**不新增守卫、不改产品行为、不进 CI**。
> 复现脚本：`scripts/probe-origin-real-browser.mjs`（需 playwright + chromium）。
> 证据：`scripts/origin-evidence.json`。

## 一、被更正的那句话

`js/host.js` 的 `resolveFrameSrc()` 注释、`scripts/market-binding-debt.json`
的 `runtime-load` blocker，都写着：

> asset 协议下 ES module 的 CORS 行为、iframe 是否同源可读，**只有真机能判**。

这句话把两个不同问题捆成了一个未知量。实测后它们都有确定答案，
而且答案一直写在生产代码自己的注释里（`runtimeFrameUrl` 注释①②③，
标注「2026-10-24 之前全部实机复现」）。

## 二、产物形态（先决事实，静态统计 12/12）

| 形态 | 数量 | 说明 |
|---|---|---|
| HTML 自包含内联 bundle | **11** | `index.html` 里 `<script type="module">` 内联，外部 script = 0 |
| 外链 bundle | **1** | `project-group`，带 `<script type="module" crossorigin src="./assets/...">` + 一个 css link |

内联 bundle 不发跨源 module 请求，**注释②的 CORS 坑对这 11 份根本不适用**。

## 三、四象限实证（真实 Chromium，真实产物）

| 场景 | contentDocument | bridge `ready` | 结论 |
|---|---|---|---|
| 同源相对路径（runtime 现状） | 可读 | ✅ | 现网方案 |
| 同源投影（installed 方案 A） | 可读 | ✅ | **装进 `installed-plugins/` 后挂到同源即可加载** |
| 跨源 iframe + 内联 bundle（11/12 形态） | null | ✅ | module 照常执行，ready 经 `postMessage` + `e.source` 到外壳 |
| 跨源 iframe + 外链 bundle（project-group 形态） | null | ❌ | JS **下载 200 但 CORS 拒绝执行**，console 明确报错 |

第三行最值钱：`host.js` 里读 `contentDocument` 只用于诊断快照与空页面检测，
且 1226 行注释明确「读不到就跳过 —— 隔离态抛异常」；握手走
`e.source !== iframe.contentWindow` 校验，跨源下仍可比对。**跨源不阻断加载**，
注释③「空页面检测只能干等超时」是检测逻辑的退化，不是打不开。

第四行精确复现注释②：ACAO 写死另一个 origin 时，Chromium 报
`Access to script ... has been blocked by CORS policy`，JS 已下载但不执行。

## 四、结论：真机 5 项 checks 的范围缩小

- ❌ 不再是「ES module 在 asset 协议下能不能跑」——**11/12 已确定能跑**。
- ❌ 不再是「iframe 跨源读不到 DOM 会不会挂」——**桥接不依赖 DOM 可读**。
- ✅ 剩下的只有**工程实现**：把 `${appDataDir}/installed-plugins/<id>/`
  挂成同源可访问（同源投影），或对内联 bundle 直接用 `convertFileSrc` 指向
  `index.html`；唯一例外 project-group 的外链 `assets/` 需要一并把资源投影到同源，
  或在构建期内联化。
- ✅ Tauri 侧仍需本机确认的只剩：`asset:` scope 对 `$APPDATA` 的实际放行
  （`tauri.conf.json` 已含 `$APPDATA/**`）、`appDataDir()` 返回值、以及
  `convertFileSrc` 对路径分隔符的编码（注释①的 `%2F` 坑）。

## 五、必须保留的边界（不要把结论外推）

1. 本实证对象是 **`runtime-plugins/` 的 12 份内置产物**，不是 release tarball
   解包出来的 `installed-plugins/` 产物。本环境下载 release asset 时
   302 到 `release-assets.githubusercontent.com` 被出口策略 403
   （`No policy rule matched`），**无法独立核验 tarball 内 HTML 形态**。
   若 tarball 产物是外链形态，上面第三行结论不自动成立。
2. 探针用本地 HTTP + 三个端口**模拟**跨源与固定 ACAO，**不是** Tauri
   `asset:` 协议本身；复现的是 CORS 与 postMessage 机制，协议注册仍需真机。
3. 本轮**没有**改 `resolveFrameSrc()` 的 `installed === true` throw 分支。
   在 tarball 形态核验通过、且同源投影的后端实现落地之前，保持 fail-closed，
   不拼一个看似能跑、实际白屏的地址。

## 六、下一步（按顺序）

1. 取证 tarball 产物形态：真机或可直连签名 URL 的环境下载一个 release asset，
   解包看 `index.html` 的 script 标签；与内置产物形态比对。
2. 更正 `market-binding-debt.json` 的 `runtime-load.why`（删掉「只有真机能判」）
   与 `host.js:2204` 注释，改写成上面四象限结论。
3. 落 `resolveFrameSrc` 的 installed 分支：内联 bundle 直连 + 外链 bundle
   同源投影，两者都保留「投影目录不可达时给可读错误」的兜底。
4. 改动 `js/host.js` 会触发 12 个私有仓共享镜像刷新（host.js 在 73 文件集合内），
   按 `refresh-plugin-repos.mjs` 的 sha 乐观锁流程收敛后再转 `bound`。


## 七、证据字段契约（第 213 轮补齐，不改产品行为）

第 61 轮落下这三份文件时明说「不新增守卫、不进 CI」。实测两处脱节，
都不报错、体检单全绿：

1. **探针与证据不是同一套字段名**。探针原来写出 `docReadable` / `ready` /
   `moduleDownloaded`，本文件引用的证据却是 `contentDocumentReadable` /
   `readyReceived` / `externalModuleDownloaded`。重跑复现脚本会**覆盖**
   `origin-evidence.json`，产出一份任何按现有字段复核结论的工具都读不动的
   JSON —— 四个场景全 `undefined`，PASS 被静默抹成 INCONCLUSIVE。
   换句话说，这份证据不可能由当前探针产出，而没有任何判据发现得了。
2. **「哪个插件是外链 bundle」是写死的**。探针三处硬编码 `project-group`，
   证据里的 `externalBundleId` 也是手写常量。产物形态一变（比如另一个插件
   改成外链，或 12 份全内联），第四象限换不了样本，verdict 却仍可能 PASS。

已修正为：探针 evidence 字段与证据文件**逐键一致**；`externalBundleId` 由
`runtime-plugins/` 真实 HTML 的 script 标签统计得出；没有外链产物时显式抛错
而不是静默跑出 PASS；结论判据抽成 `verdictOf(evidence)` 一份真身，探针自己
与守卫共用。探针会额外写 `productShape.shape` 逐插件明细，证据是精简快照、
不含该字段 —— 守卫按「证据的每个键探针都必须产出」的**单向包含**判据核，
不把明细当成必须落盘的字段。

守卫 `origin-evidence-contract-test.mjs`（34 项）零依赖、不跑 playwright、
不进产品链路：切 `verdictOf` 真身喂落盘证据与 5 个反例实跑，交叉核对文档
表格数字与证据数值，并配注释喂饱／防恒真／空文本元断言。

本轮**没有**改 `js/host.js`、`resolveFrameSrc()` 或任何产品代码，第六节那
四步工程欠账（更正 `market-binding-debt.json` 的 `runtime-load.why`、
`tarball` 产物形态取证、落 installed 分支、随之刷新 12 仓共享镜像）仍原样
留着，不代为推进。
