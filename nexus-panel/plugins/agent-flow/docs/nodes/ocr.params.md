# ocr — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](ocr.md) ｜ [← 回到索引](../README.md)

## 面板上的提示

> 输出可直接被下游引用，识别出的文字也能交给翻译节点继续处理。

共 7 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `imageSource` | select | 图片来源 | — | — |
| `url` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | `d → (d.imageSource ?? 'url') === 'url'` |
| `credentialId` | credential | — | — | — |
| `path` | custom | 由手写面板渲染（通常带上游变量插入按钮） | — | `d → (d.imageSource ?? 'url') === 'url'` |
| `prompt` | textarea | 识别要求；留空用上面的默认提示（按原顺序输出，不解释） | — | `d → d.imageSource === 'file'` |
| `detail` | select | 图片细节 | `auto` / `low` / `high` | `d → d.imageSource === 'file'` |
| `llm` | 隐藏（不在面板字段里） | 大模型配置 { url, model, apiKey, timeoutSec }。由 llm-config 卡片组提供，建节点时 def.create() 会填默认值 | — | — |

## 怎么用它

1. 从侧栏「AI 能力」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/ocr.tsx` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

产出是文本，可以：
- 直接给下游用（`{{ocr节点id.output}}`）
- 接「condition」节点做判断

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'ocr' }` 会缺默认字段 ——
本控件尤其要注意 `llm` / `imageSource`，它不在面板字段里。
