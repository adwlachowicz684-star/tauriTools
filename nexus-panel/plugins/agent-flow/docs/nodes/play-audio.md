# play-audio — 播放本地音频文件

> 自动生成，不要手改。源文件：`nodes/defs/playAudio.ts`

- **分类**：工具
- **node.type**：`play-audio`
- **产出**：any（透传上游）
- **接受**：any
- **需要的外部能力**：`playAudioReader`

## 它做什么

透传上游（只是播放音频）

## 能力签名

- `playAudioReader`: `(path) => Promise<string>（data URL）`

## 参数概览

共 3 项。完整表格与用法见 → [play-audio.params.md](play-audio.params.md)

- `path`（音频文件）
- `volume`（音量）
- `waitForEnd`

---

[← 回到索引](../README.md)
