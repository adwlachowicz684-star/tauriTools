# 控件索引

> 自动生成，**不要手改**。改代码后跑：
> `bash scripts/build-tests.sh && node scripts/gen-node-docs.mjs`

这是**第一层**：只有分类与控件清单，外加「产出 / 接受」
——这两项是决定两个控件能不能接的判据，所以放在索引里，
不用进到第三层才知道。

要看某个控件的说明 → 点进 `nodes/<kind>.md`
要拿它的参数 → 再进 `nodes/<kind>.params.md`

## 连线判据（先看这个）

- `产出` 是它交给下游的东西，`接受` 是它能吃下的东西
- 判据是**语义上能不能用**，不是物理上能不能连 —— 不合时只会告警，不阻止
- `mark` 型（状态标记）插在链中间会**截断**数据，是最容易踩的坑
- 需要外部能力的控件，在浏览器模式下会直接失败（`能力` 列有标注）

## 触发器（起点）

| 控件 | kind | 产出 | 接受 | 能力 | 说明 |
|---|---|---|---|---|---|
| [trigger](nodes/trigger.md) | `trigger` | text（文本） | none | — | 流程的初始输入（手动文本 / 触发带来的内容） |

## 任务

| 控件 | kind | 产出 | 接受 | 能力 | 说明 |
|---|---|---|---|---|---|
| [task](nodes/task.md) | `task` | text（文本） | any | — | CLI 的执行输出 |

## 流程控制

| 控件 | kind | 产出 | 接受 | 能力 | 说明 |
|---|---|---|---|---|---|
| [condition](nodes/condition.md) | `condition` | mark（状态标记） | any | — | 分支标记文本（如「[条件] 走「是」」）—— 作用是分流，不转换数据 |
| [loop](nodes/loop.md) | `loop` | any（透传上游） | any | — | 透传（循环体每轮一次，done 出口汇总一次） |
| [parallel](nodes/parallel.md) | `parallel` | any（透传上游） | any | — | 透传 |

## 控制器

| 控件 | kind | 产出 | 接受 | 能力 | 说明 |
|---|---|---|---|---|---|
| [gate](nodes/gate.md) | `gate` | any（透传上游） | any | — | 满足条件才放行下游 |
| [join](nodes/join.md) | `join` | text（文本） | any | — | 等所有输入都到齐了才放行下游 |
| [retry](nodes/retry.md) | `retry` | any（透传上游） | any | — | 上游内容不合格就重跑它 |
| [throttle](nodes/throttle.md) | `throttle` | any（透传上游） | any | — | 控制放行的节奏 |
| [timeout](nodes/timeout.md) | `timeout` | any（透传上游） | any | — | 整条流程超预算就断在这里 |

## 文件与数据

| 控件 | kind | 产出 | 接受 | 能力 | 说明 |
|---|---|---|---|---|---|
| [extract](nodes/extract.md) | `extract` | text（文本） | text / json | — | JSON 路径 / 正则 / 按行 |
| [fs](nodes/fs.md) | `fs` | files（文件列表） | any | fsExecutor | 文件引用列表（下游按文件处理） |

## AI 能力

| 控件 | kind | 产出 | 接受 | 能力 | 说明 |
|---|---|---|---|---|---|
| [ocr](nodes/ocr.md) | `ocr` | text（文本） | text / files / any | imageReader, llmCaller | 图片识别出的文字 |
| [translate](nodes/translate.md) | `translate` | text（文本） | text | llmCaller | 需填自己的大模型 API Key |

## 外部服务

| 控件 | kind | 产出 | 接受 | 能力 | 说明 |
|---|---|---|---|---|---|
| [generic-http](nodes/generic-http.md) | `generic-http` | json（JSON） | any | httpRequester | 填地址与参数即可调任意接口 |
| [github-push](nodes/github-push.md) | `github-push` | text（文本） | any | githubPush | 推送结果说明 |
| [github-update](nodes/github-update.md) | `github-update` | json（JSON） | none | githubFetch | 在「凭据」里填一次令牌，两个节点共用 |
| [update](nodes/update.md) | `update` | bool（是/否） | none | fetcher | 是否有更新（true / false）—— 给条件节点判断 |

## 工具

| 控件 | kind | 产出 | 接受 | 能力 | 说明 |
|---|---|---|---|---|---|
| [beep](nodes/beep.md) | `beep` | any（透传上游） | any | — | 跑完了响一声，适合长时间无人值守的流程 |
| [clock](nodes/clock.md) | `clock` | text（文本） | none | — | 输出当前时间，常用于生成带时间戳的文件名 |
| [const](nodes/const.md) | `const` | text（文本） | none | — | 输出一个固定值给下游 |
| [log](nodes/log.md) | `log` | any（透传上游） | any | — | 往运行日志里写一条，不影响数据流 |
| [module](nodes/module.md) | `module` | any（透传上游） | any | — | 多个节点打包复用 |
| [play-audio](nodes/play-audio.md) | `play-audio` | any（透传上游） | any | playAudioReader | 播放本地音频文件 |
| [wait](nodes/wait.md) | `wait` | any（透传上游） | any | — | 暂停一段时间再往下跑 |

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
