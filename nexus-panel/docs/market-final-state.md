# 市场链路最终收口说明

> 本轮不再新增守卫、探针或台账条目，也不改任何产品行为。只做**远端事实核对**并给出终止条件。
> 所有数字来自 2026-11-07 对 `adwlachowicz684-star/tauriTools@main` 的 API 直读，不是本地工作区推断。
> 本地工作区顶层已有 **1155 个非隐藏项**（多为历轮备份、探针、日志、分片结果），继续追加留档不减少欠账。

## 一、远端真实状态（本轮实取）

| 项 | 值 |
|---|---|
| 仓库 | 公开、`default_branch=main`、`pushed_at=2026-11-07T07:41:52Z` |
| HEAD | `33e5bf586391e09a4ba18f20b3a81d07f59478fb`（第 61 轮：真实浏览器四象限实证） |
| 台账 | `phase=54`、`status=wired`、`runtimeVerified=false` |
| blockers | `credentials` / `ui-actions` / `csp-asset` / `registry-entry` 均 `resolved-in-code`；**仅 `runtime-load` = `pending-real-device`** |
| 12 个插件仓 | 12/12 私有、各 1 个正式 release（沿用第 61 轮核验；本轮未写入，故未重验） |

也就是说：**"编排层未被生产代码调用"这句早就过期了**。装配层、面板动作、私有仓凭据、CSP、进注册表全部落地；产品里唯一还缺的是「装完的插件能被打开」。

## 二、★ 本轮新证据：第 61 轮留下的边界已由构建链闭合

第 61 轮留了一句限定：release asset 302 到 `release-assets.githubusercontent.com` 被出口策略 403，**无法独立核验 tarball 内 HTML 是内联还是外链 bundle**，因此四象限结论不自动适用于 `installed-plugins/`。

这个前置其实不需要联网下载——**tarball 内容由构建链唯一决定**：

- `scripts/build-plugins.mjs:15` 文件头：「**已安装的正式版更新插件 = 把 `runtime-plugins/<id>` 拷进安装目录**，重启」
- `templates/plugin-repo/release.yml:128`：CI 校验「只允许 `index.html` 引用同目录树内的 `./assets/`；出现 `../` 即判整包不完整」
- `release.yml:136–141`：打成 `tar.gz`，注释明写「**installer 会把它们直接落到 `installed-plugins/<id>/` 下**」
- `tauri.conf.json`：`bundle.resources` = `{"../runtime-plugins/": "runtime-plugins/"}`

**结论**：tarball 解出来的就是 `runtime-plugins/<id>/` 那份构建产物。第 61 轮真实 Chromium 四象限（**11/12 HTML 自包含内联 bundle、仅 `project-group` 外链**）因此直接适用于 installed 产物，不必再等下载 asset。「先取 tarball 形态才能落分支」这一前置销掉。

## 三、🔴 两处措辞已落后于事实（文档债，不是产品 BUG）

| 位置 | 现在写的 | 实际 |
|---|---|---|
| `js/host.js:2204–2207` | 「asset 协议下 ES module 的 CORS 行为**又未验**」 | **同一文件 2161–2169 行**写着「2026-10-24 之前走 asset 协议，连踩三个坑（**全部实机复现**）」，并据此改成同源相对路径；第 61 轮真实 Chromium 也复现了外链 bundle 的 CORS 拒绝 |
| `scripts/market-binding-debt.json` 的 `runtime-load.why` / `unblock` | 仍以「5 项 checks 回来后按 nextAction 选加载方式」为前提 | 加载方式的**配置前提已齐、候选已收敛**（见下节），checks 要验的不是"CORS 能不能跑" |

**本轮没有擅自改这两处**：改 `host.js` 注释会连锁触发守卫里的真实文件文本取证；改台账 `status` 没有真机证据支撑，按项目一贯原则不自查自封。两处留到真机那轮一起更正。

## 四、落地点的精确坐标（给真机那轮）

- 唯一分流点：`js/host.js:2217–2221`，`if (manifest && manifest.installed === true) throw ...`
- 正常路径：`runtimeFrameUrl()`（2177–2185）返回同源相对 `runtime-plugins/<id>/index.html`
- **配置前提已齐**：`tauri.conf.json` 的 `assetProtocol.scope = ["$APPDATA/**", "$RESOURCE/**"]`；CSP `frame-src 'self' asset: http://asset.localhost`，`connect-src` 含 `api.github.com` / `github.com` / `*.githubusercontent.com`
- **代码前提未齐**：`host.js` 全文**没有 import `convertFileSrc`**（只在注释里出现）；2123/2139 行有动态 `import('@tauri-apps/api/path')` 的现成先例可照抄
- 11/12 内联 bundle 不发 `./assets/*.js` 相对请求，坑①（`%2F` 把相对 URL 解析到协议根）与坑②（module 强制 CORS）都不适用；**`project-group` 是唯一外链例外**，跨源实测 CORS 拒绝，需单独内联化或投影

## 五、为什么仍需要真机一次（真实边界，不是自我设限）

第 61 轮的四象限是**三个本地端口模拟跨源 + 固定 ACAO**，不是 Tauri `asset:` 协议本身。仍验不了的只有一件事：`convertFileSrc()` 对 `$APPDATA` 路径实际生成的 URL（含分隔符编码）能否被 asset 协议服务器正确解析并服务。静态代码与模拟浏览器都给不出这个答案。

所以 **`2217` 那个 `throw` 仍是当前最安全的设计**——第 54 轮特意做的 fail-closed，给明确错误框而不是静默白屏。在没有真机证据前不替换它、不把 `runtimeVerified` 置真、不转 `bound`。这与"能加载 ≠ 已被调用"是同一条纪律。

## 六、已完成 / 仍挂着

| 已完成 | 仍挂着 |
|---|---|
| 12 个 `nexusPanel_plugin_*` 私有仓、9 个 v1 公开仓删除、主仓插件源码退场、本地↔远端全量同步 | `runtime-load`：installed 加载分支（`host.js:2217`） |
| 12 仓共享镜像收敛、状态 commit 校准、跨端契约 CI 迁仓 | `pdfium.dll` 缺失（生产包不再随附，PDF 逐页预览退化） |
| 编排层去 `node:` 化、装配层接线、商店面板三动作、PAT 内存态 | Rust 从未编译验证（沙盒无 cargo / rustc） |
| 已安装插件进注册表（侧边栏可见）、CSP 302 域名实测修正 | 真机 devtools checks；`wired → bound` |
| 真机探针值域/信号/nextAction/三态盲区修复 | 主工作区代码仍整体落后（HEAD 停在 `0f8b9f8`）；全量体检在本环境跑不完（第 60 轮实测） |

## 七、本机一页纸操作清单（唯一剩下的动作）

1. 本机先跑一次 `cargo check`（Rust 至今零编译验证），再 `npm run tauri:dev` 起窗口。
2. 在 Tauri 窗口 devtools 粘贴 `scripts/probe-real-device-runtime.mjs` 里的 `DEVTOOLS_SNIPPET`，把打印的 `checks` JSON 贴回来。
3. 用 `evaluate(checks)` 得到 `nextAction`；按它改 `js/host.js:2217` 那一处分支（落点已在第四节列全）。
4. **重建产物**——`dist/assets/host-*` 不入库，那两个 `tauri.localhost/assets/host-*` 是你本机构建产物；改完源码不重建，devtools 仍加载旧 bundle。
5. 真机走一遍：输 PAT → 安装 → 插件出现在侧边栏 → 打开 → 卸载 → 重装读回设置。
6. 全通过后才把台账 `runtimeVerified=true`、`status=bound`；若改了 `host.js`，再用 sha 乐观锁把共享镜像收敛到 12 仓。

## 八、关于反复附带的 7 个链接

资源解析服务一直失败，但内容此前已用 API 直读实证过，**本轮不重复解析、未据此改方向**：

- `push-api-tools/push_api.py`：私有仓，1611134 B / sha `20e4540b…`；第 56 轮已用干净副本 + 显式 `--repo` + `GITHUB_TOKEN` 真跑通 `--scope`。工作区根目录那份 985410 B 是 9/30 旧版，不是同一份。
- `ErgeMD`（公开 MD 应用）、`fenpei-xiangmuzu-qianyi`（公开 C# WPF 前身）、`tauriTools`（公开主仓）、`github.com`：元数据核实完毕。
- 两个 `http://tauri.localhost/assets/host-*`：本机 asset 协议地址，沙盒无 Tauri 运行时本就取不到；`dist/` 不入库。

## 九、收口判断

沙盒侧能静态确定的都确定了：构建链、配置、落点、守卫、镜像状态。**剩下的是运行时行为，只能由本机 Tauri 给出证据。** 继续 "continue" 只会再生成一份留档、再发现一处"上一轮措辞不够准"，欠账不减反增——这正是第 60 轮已经识别、第 61 轮仍未跳出的自指循环。

**终止条件明确**：第七节跑完 → 改一处分支 → 重建 → 台账转 `bound`。在那之前保持 `wired` 与 fail-closed，是诚实而不是拖延。
