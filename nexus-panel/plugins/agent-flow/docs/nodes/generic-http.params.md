# generic-http — 参数与使用方式

> 自动生成，不要手改。

[← 上一层：控件说明](generic-http.md) ｜ [← 回到索引](../README.md)

## 面板上的提示

> 输出响应正文。状态码存在 {{本节点.status}}，配合「数据提取」节点可取出 JSON 字段。

共 7 项：

| 参数 | 类型 | 说明 | 取值 | 显示条件 |
|---|---|---|---|---|
| `headersText` | textarea | 请求头；留空即可；填了 Authorization 就不会再自动加凭据令牌；占位：每行一条，如：\nX-Token: abc123 | — | — |
| `body` | textarea | 请求体；请求体里可以引用上游输出；占位：{"key": "value"}，支持 {{上游.output}} | — | `d → d.method === 'POST' || d.method === 'PUT' || d.method === 'PATCH'` |
| `bodyIsJson` | switch | 占位：按 JSON 发送（自动补 Content-Type） | — | `d → d.method === 'POST' || d.method === 'PUT' || d.method === 'PATCH'` |
| `credentialId` | credential | — | — | — |
| `timeoutSec` | number | 超时（秒） | — | — |
| `maxBytesKb` | number | 响应上限（KB）；防止异常大的响应把面板拖垮 | — | — |
| `failOnHttpError` | switch | 关掉则把错误响应也当正常输出，交给下游判断；占位：4xx / 5xx 算失败 | — | — |

## 怎么用它

1. 从侧栏「外部服务」分组拖到画布
2. 在属性面板填参数（面板由 `nodes/defs/genericHttp.tsx` 的 fields 自动渲染）
3. 用连线接到上下游；引用上游输出写 `{{上游id.output}}`

产出是JSON，可以：
- 直接给下游用（`{{generic-http节点id.output}}`）
- 接「extract」节点按 JSON 路径取值
- 接「condition」节点做判断

## 建节点的正确方式

用 `def.create()`（即 `makeXxxNode`）建节点，它会填好默认值。
手工拼 `{ kind: 'generic-http' }` 会缺默认字段 ——
本控件没有隐藏字段，但用 create() 仍是推荐做法。
