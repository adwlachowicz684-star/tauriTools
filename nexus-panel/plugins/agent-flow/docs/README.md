# 可拖用的东西 — 统一索引

> 自动生成，**不要手改**。改代码后跑：
> `bash scripts/build-tests.sh && node scripts/gen-node-docs.mjs`

这是**第一层**。收录五类能拖出来用的东西：

| 类别 | 装的是什么 | 入口 |
|---|---|---|
| **节点** | 一个积木（25 种） | 下面按分类的表 |
| **参数卡片** | 一组参数（如某个仓库地址） | [卡片](#参数卡片)（4 组） |
| **模块** | 多个节点编成的组合 | [module](reuse/module.md) |
| **自定义预设** | 一个配好的节点 | [custom-preset](reuse/custom-preset.md) |
| **节点默认值** | 决定新建节点长什么样 | [defaults](reuse/defaults.md) |

后三样是**用户运行时创建**的，没有内置清单，
所以这里只给「怎么用」的说明，不列具体条目（列了立刻过期）。

## 连线判据（先看这个）

- `产出` 是它交给下游的东西，`接受` 是它能吃下的东西
- 判据是**语义上能不能用**，不是物理上能不能连 —— 不合时只会告警，不阻止
- `mark` 型（状态标记）插在链中间会**截断**数据，是最容易踩的坑
- 需要外部能力的控件，在浏览器模式下会直接失败（`能力` 列有标注）

## 触发器（起点）

| kind | 产出 | 接受 | 能力 | 说明 | 源文件 |
|---|---|---|---|---|---|
| [trigger](nodes/trigger.params.md) | text（文本） | none | — | 流程的初始输入（手动文本 / 触发带来的内容） | `nodes/defs/trigger.ts` |

## 任务

| kind | 产出 | 接受 | 能力 | 说明 | 源文件 |
|---|---|---|---|---|---|
| [task](nodes/task.params.md) | text（文本） | any | — | CLI 的执行输出 | `nodes/defs/task.tsx` |

## 流程控制

| kind | 产出 | 接受 | 能力 | 说明 | 源文件 |
|---|---|---|---|---|---|
| [condition](nodes/condition.params.md) | mark（状态标记） | any | — | 分支标记文本（如「[条件] 走「是」」）—— 作用是分流，不转换数据 | `nodes/defs/condition.ts` |
| [loop](nodes/loop.params.md) | any（透传上游） | any | — | 透传（循环体每轮一次，done 出口汇总一次） | `nodes/defs/loop.ts` |
| [parallel](nodes/parallel.params.md) | any（透传上游） | any | — | 透传 | `nodes/defs/parallel.ts` |

## 控制器

| kind | 产出 | 接受 | 能力 | 说明 | 源文件 |
|---|---|---|---|---|---|
| [gate](nodes/gate.params.md) | any（透传上游） | any | — | 满足条件才放行下游 | `nodes/defs/gate.tsx` |
| [join](nodes/join.params.md) | text（文本） | any | — | 等所有输入都到齐了才放行下游 | `nodes/defs/join.tsx` |
| [retry](nodes/retry.params.md) | any（透传上游） | any | — | 上游内容不合格就重跑它 | `nodes/defs/retry.tsx` |
| [throttle](nodes/throttle.params.md) | any（透传上游） | any | — | 控制放行的节奏 | `nodes/defs/throttle.tsx` |
| [timeout](nodes/timeout.params.md) | any（透传上游） | any | — | 整条流程超预算就断在这里 | `nodes/defs/timeout.tsx` |

## 文件与数据

| kind | 产出 | 接受 | 能力 | 说明 | 源文件 |
|---|---|---|---|---|---|
| [extract](nodes/extract.params.md) | text（文本） | text / json | — | JSON 路径 / 正则 / 按行 | `nodes/defs/extract.tsx` |
| [fs](nodes/fs.params.md) | files（文件列表） | any | fsExecutor | 文件引用列表（下游按文件处理） | `nodes/defs/fs.ts` |

## AI 能力

| kind | 产出 | 接受 | 能力 | 说明 | 源文件 |
|---|---|---|---|---|---|
| [ocr](nodes/ocr.params.md) | text（文本） | text / files / any | imageReader, llmCaller | 图片识别出的文字 | `nodes/defs/ocr.tsx` |
| [translate](nodes/translate.params.md) | text（文本） | text | llmCaller | 需填自己的大模型 API Key | `nodes/defs/translate.tsx` |

## 外部服务

| kind | 产出 | 接受 | 能力 | 说明 | 源文件 |
|---|---|---|---|---|---|
| [generic-http](nodes/generic-http.params.md) | json（JSON） | any | httpRequester | 填地址与参数即可调任意接口 | `nodes/defs/genericHttp.tsx` |
| [github-push](nodes/github-push.params.md) | text（文本） | any | githubPush | 推送结果说明 | `nodes/defs/github_push.tsx` |
| [github-update](nodes/github-update.params.md) | json（JSON） | none | githubFetch | 在「凭据」里填一次令牌，两个节点共用 | `nodes/defs/github_update.tsx` |
| [update](nodes/update.params.md) | bool（是/否） | none | fetcher | 是否有更新（true / false）—— 给条件节点判断 | `nodes/defs/bili.ts` |

## 工具

| kind | 产出 | 接受 | 能力 | 说明 | 源文件 |
|---|---|---|---|---|---|
| [beep](nodes/beep.params.md) | any（透传上游） | any | — | 跑完了响一声，适合长时间无人值守的流程 | `nodes/defs/beep.ts` |
| [clock](nodes/clock.params.md) | text（文本） | none | — | 输出当前时间，常用于生成带时间戳的文件名 | `nodes/defs/clock.ts` |
| [const](nodes/const.params.md) | text（文本） | none | — | 输出一个固定值给下游 | `nodes/defs/const.ts` |
| [log](nodes/log.params.md) | any（透传上游） | any | — | 往运行日志里写一条，不影响数据流 | `nodes/defs/log.ts` |
| [module](nodes/module.params.md) | any（透传上游） | any | — | 多个节点打包复用 | `nodes/defs/module.ts` |
| [play-audio](nodes/play-audio.params.md) | any（透传上游） | any | playAudioReader | 播放本地音频文件 | `nodes/defs/playAudio.ts` |
| [wait](nodes/wait.params.md) | any（透传上游） | any | — | 暂停一段时间再往下跑 | `nodes/defs/wait.ts` |

## 参数卡片

一组参数存成卡片，拖到节点上就套用。改了节点会**脱钩**成「自定义」。

| 卡片组 | 管哪些字段 | 能用在 |
|---|---|---|
| [地址卡片](cards/github-repo.md) | `owner`, `repo`, `branch` | `github-push`, `github-update` |
| [接口卡片](cards/http-endpoint.md) | `url`, `method` | `generic-http` |
| [模型卡片](cards/llm-config.md) | `llm` | `ocr`, `translate` |
| [目录卡片](cards/workdir.md) | `workdir` | `github-push` |

拖到节点上会校验三件事：组已注册、节点声明支持这个组、值通过 validate。

## 复用件

| 名字 | 装的是什么 | 与另一个的区别 |
|---|---|---|
| [module](reuse/module.md) | **多个**节点 + 连线 | 与预设的区别：模块能存连线、有自己的 `module` 类型 |
| [custom-preset](reuse/custom-preset.md) | **一个**节点 + 一套参数 | 与模块的区别：预设复用基础类型的 type，不能存连线 |
| [defaults](reuse/defaults.md) | 新建节点的默认参数 | 不是能拖的积木，但它决定新建节点长什么样 |

模块与预设都遵循「**库是库、实例是实例**」：改库 → 所有实例跟着变；
改实例 → 该实例脱钩。

## 模板变量

| 写法 | 含义 |
|---|---|
| `{{节点id.output}}` | 取指定节点的输出。能取到**任意**已执行节点，不限于直接上游 |
| `{{input}}` | 工作流全局输入 **⚠ **不是**上游输出。嵌合时才表示直接上方那一块的输出；未嵌合的节点用它会拿到全局输入（常为空）** |
| `{{chain.output}}` | 嵌合串上、本节点之前所有输出的拼接 **⚠ 仅在嵌合（Scratch 式上下吸附）时有意义** |
| `{{loop.item}}` | 循环体内：本轮的元素 |
| `{{loop.index}}` | 循环体内：本轮下标 |
| `{{loop.count}}` | 循环体内：总轮数 |
| `{{节点id.字段名}}` | 取节点产出附加字段（如更新检测节点的 title / link） **⚠ 字段名由各节点的 nodeFields 决定，不是所有节点都有** |

## 边的写法

| 字段 | 含义 |
|---|---|
| `{ id, source, target }` | 普通边。id 建议写成 `源->目标` |
| `branch（**顶层**，不是 data.branch）` | 条件节点的出边所属分支。填规则 id，或 __default__ 表示兜底分支 |
| `loopRole（**顶层**）` | 循环节点的出边角色：'body' 循环体（每轮执行一次）/ 'done' 结束后执行一次 |

分支边示例：`{ id: 'c1->l1', source: 'c1', target: 'l1', branch: 'r1' }`

## 能力签名

调用这些能力时要按下面的签名来（写错不报错，只表现为奇怪的失败）：

| 能力 | 签名 |
|---|---|
| `fsExecutor` | `(node, { path, target, content }) => Promise<string>` |
| `llmCaller` | `({ url, headers, body, timeoutSec }) => Promise<{ status, text }>` |
| `httpRequester` | `(url, { method, headers, body, timeoutSec, maxBytes }) => Promise<{ status, ok, text, headers }>` |
| `fetcher` | `(node, url, { headers, timeoutSec }) => Promise<string>` |
| `githubFetch` | `抓取仓库信息 => Promise<信息对象>` |
| `githubPush` | `推送文件 => Promise<string>` |
| `imageReader` | `(path) => Promise<string>（data URL）` |
| `playAudioReader` | `(path) => Promise<string>（data URL）` |
