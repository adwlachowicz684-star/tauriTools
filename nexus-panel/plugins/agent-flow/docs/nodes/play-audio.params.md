# play-audio — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/playAudio.ts` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：工具
- **node.type**：`play-audio`
- **源文件**：`nodes/defs/playAudio.ts`
- **产出**：any（透传上游）　**接受**：any
- **需要的外部能力**：`playAudioReader`

## 它做什么

透传上游（只是播放音频）

## 能力签名

- `playAudioReader`: `(path) => Promise<string>（data URL）`

## 面板上的提示

> 需要读取本地文件，浏览器模式下不可用（会提示缺少音频读取能力）。

共 3 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `path` | text | 音频文件；支持模板，如 {{上游.output}}；建议 mp3 / wav / ogg；占位：/path/to/sound.mp3 | — | — |
| `volume` | number | 音量 | — | — |
| `waitForEnd` | switch | 占位：播完再往下走（关掉则立即继续，声音继续放） | — | — |

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'play-audio' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
