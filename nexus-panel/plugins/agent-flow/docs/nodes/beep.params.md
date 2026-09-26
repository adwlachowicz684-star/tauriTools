# beep — 参数与使用方式

> 自动生成，**不要手改**。这是 `nodes/defs/beep.ts` 的**派生视图**：
> 具体值以源文件为准，这里只做汇总。

[← 回到索引](../README.md)

- **分类**：工具
- **node.type**：`beep`
- **源文件**：`nodes/defs/beep.ts`
- **产出**：any（透传上游）　**接受**：any
- **需要的外部能力**：`playAudioReader`

## 它做什么

透传上游（只是响一声）

## 能力签名

- `playAudioReader`: `(path) => Promise<string>（data URL）`

> `playAudioReader` 是**按需**的：只有满足特定条件时才需要（见参数页）。

## 面板上的提示

> 系统音效由 Web Audio 实时合成，播不出来只会告警，不会让流程失败。

共 5 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `source` | select | 声音来源 | — | — |
| `preset` | select | 音效 | `动态（PRESETS.map）` | `d → (d.source ?? 'preset') === 'preset'` |
| `path` | text | 音频文件；支持模板，如 {{上游.output}}；建议 mp3 / wav / ogg；占位：/path/to/sound.mp3 | — | `d → d.source === 'file'` |
| `volume` | number | 音量；0 ~ 1，默认 0.6 | — | — |
| `waitForEnd` | switch | 占位：播完再往下走（关掉则立即继续，声音继续放） | — | `d → d.source === 'file'` |

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'beep' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
