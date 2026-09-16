# 节点注册表

新增一种节点，只需要**写一个文件**，然后在 `index.ts` 里 import 它。
侧栏、画布、属性面板、执行引擎四处都会自动生效，不需要再改。

## 最快的上手方式：照抄一个现有的

`defs/translate.ts` 是最简单完整的例子（翻译节点，无变体、无子面板）：

```ts
import { makeTranslateNode } from '../../types';
import TranslateNode from '../../components/TranslateNode';
import { TranslateInspector } from '../../components/inspectors/TranslateInspector';
import { runTranslate } from '../../engine/runners/translate';
import { registerNode } from '../registry';

registerNode({
  type: 'translate',          // xyflow 的 node.type，全仓库唯一
  dataKind: 'translate',      // data.kind，执行引擎用它分发
  meta: {
    label: '翻译',
    color: '#38bdf8',         // 侧栏圆点 + 卡片左边框
    category: 'ai',           // 侧栏分组
    idPrefix: 'ty',           // 新建时的 id 前缀：ty1、ty2…
  },
  create: (id, partial) => makeTranslateNode(id, (partial ?? {}) as never).data,
  Canvas: TranslateNode,
  Inspector: TranslateInspector,
  run: runTranslate,
});
```

## 属性面板：优先写 fields，不要写 JSX

多数节点**不需要 Inspector 组件**，只要在节点定义里给一份 `fields` 声明，
基础面板会自动渲染（含标题行）。翻译节点从 163 行 JSX 变成约 100 行声明，
且其中大半是 prompt/hint 文案。

```ts
fields: () => [
  { type: 'select', key: 'detail', label: '图片细节',
    options: [{ value: 'auto', label: '自动' }, { value: 'low', label: '低（省 token）' }] },
  { type: 'text', key: 'url', label: '图片地址', placeholder: 'https://...' },
  { type: 'switch', key: 'yolo', label: '', placeholder: '自动批准工具调用（-y）' },
  { type: 'credential', key: 'credentialId', credentialKind: 'ocr' },
]
```

可用的 `type`：`text` `textarea` `number` `select` `switch` `chips`
`credential` `note` `custom`。

常用修饰：

| 修饰 | 作用 |
|---|---|
| `when: (d) => bool` | 条件显隐（目标路径只在 copy/move 时出现这类） |
| `toUI` / `fromUI` | 显示值与存储值互转（`'auto'` 显示成空） |
| `hint` | 字段下方小字；可给函数，随其它字段变化 |
| `options` | 可给函数，做动态选项 |
| `inline: true` | 标签在左、控件在右（默认标签在上） |

描述不住的用 `type: 'custom'` 给一段自己的 `render`（提示词那栏要插上游
变量按钮、仓库 owner/repo 要挤在一行，都是这么做的）；复杂到整体都描述不住
的（条件规则编辑器、循环配置、触发器的五种子类型），直接给 `Inspector`
整体接管 —— 见 `defs/condition.ts` 等。这是**逃生口**，不是首选。

需要 `useState` 的挂件（如更新检测的「测试」按钮）抽成独立组件，
用 `panelFooter` 挂在字段清单之后 —— 字段描述是纯数据，装不下 hook。

## 五个字段分别管什么

| 字段 | 作用 | 不给会怎样 |
|---|---|---|
| `meta` | 侧栏条目、配色、分组、id 前缀 | 必填 |
| `create` | 拖到画布时的默认数据 | 必填 |
| `Canvas` | 画布上的卡片 | 必填（不给则节点不显示） |
| `Inspector` | 右侧属性面板 | 必填（不给则面板空白） |
| `run` | 执行逻辑 | 不给则该节点"直通"：不报错、不产出，下游拿到空串 |

## 一个类型、多个侧栏条目（变体）

同一个 data 结构、只有某个字段不同的，用 `presets` 展开成多个条目，
不要为此新建类型 —— 类型一多，`flowTypes.ts` 的联合类型和各处分发都会跟着膨胀。

仓库里两个现成的例子：

- **任务节点**：`task` 一个类型，侧栏展开成 TraceCode / WorkBuddy 两项（`defs/task.ts`）
- **B站 / 公众号**：倒是两个 type（`bili` / `wechat`），但共用同一份 data 与执行器，
  靠 `data.source` 区分 —— 它们的 `dataKind` 都是 `update`

## 执行器在哪（务必用 withNodeRun）



执行逻辑放 `engine/runners/` 下，一个节点一个文件，**不要写进 `engine/runner.ts`**。

原因是 runner 是纯逻辑层，单元测试在 Node 下直接跑它，不加载 React；
执行器如果和界面组件混在一起，测试就跑不起来了。

执行器拿到的参数是一个 `RunContext`（`engine/runContext.ts`），里面包好了
`outputs` / `emit` / `setStatus` / `nodeFields` 等原本在闭包里的东西。

> 写完执行器记得挂两处：`defs/xxx.ts` 的 `run` 字段，以及
> `engine/runnerRegistry.ts` 的表。漏挂第二处该节点会静默"直通"——
> 现有测试会失败，所以是能被发现的，但仍建议写完后立刻跑一次 `run-tests.sh`。

### 底层能力：优先用，别自己写

写执行器时，下面这些**不要自己实现**，用底层给的：

| 能力 | 用法 | 别再写 |
|---|---|---|
| 模板渲染 | `ctx.tpl(d.path)` | `renderTemplate(x, { outputs, input: opts.input, loop: currentLoop(), fields: nodeFields })` |
| 执行器前置校验 | 在 `engine/nodeRequires.ts` 声明需求 | `if (!opts.fsExecutor) throw ...` |

**为什么**：这两样原先在 7~12 个执行器里各写一遍。一旦底层要优化
（给模板加缓存、把缺失变量从 console.warn 改成发事件、统一执行器缺失的
提示措辞），写死在各节点里的版本不会跟着变。

下沉后的实际收益：
- `ctx.tpl` 底层统一 warn 未解析变量 —— 原先只有任务节点有这个提示，
  其他节点引用了不存在的变量完全没反馈，现在所有节点自动有了。
- 执行器缺失的报错措辞统一为「未提供{能力}执行器（当前可能运行在浏览器模式）」，
  失败时给下游的输出也由声明决定（更新检测类给 `'false'`，好让条件判断
  走"无更新"分支而不是掉进兜底）。

在 `engine/nodeRequires.ts` 加需求的写法：

```ts
REQUIRES = {
  myNode: [
    { key: 'fsExecutor', label: '文件操作' },                              // 总是需要
    { key: 'imageReader', label: '图片读取', when: (d) => d.src === 'file' }, // 按需
  ],
};
```

`when` 用于"只在某种配置下才需要"的能力，例：OCR 选网络地址时不需要读图能力。

### 不要手写"开始 / 成功 / 失败"三连

一律用 `engine/runnerKit.ts` 的 `withNodeRun` 包起来：

```ts
export async function runXxx(ctx: RunContext): Promise<void> {
  const d = node.data as XxxNodeData;
  await withNodeRun(ctx, async () => {
    if (!opts.fooExecutor) throw new NodeFailError('未提供 xx 执行器');
    ...
    return { output: text, fields: { ... } };
  });
}
```

前置校验直接 `throw new NodeFailError(msg)`，不用再写
`setStatus('failed') / emit / markFailed / return` 四连。

**为什么强制**：这四连少写一行就会出现"假失败" —— 节点变红、但下游照跑、
整轮还报成功。仓库里 GitHub 两个执行器就漏过 `markFailed`，
且因为 runGraph 层没有对应测试，一直没被发现（见 `tests/nodeFailure.test.ts`）。
`withNodeRun` 让失败只有一条路径，不可能再漏。

`NodeFailError` 第二个参数是失败时给下游的 output。更新检测类节点要传
`'false'`，好让下游条件判断走"无更新"分支而不是掉进兜底。

返回值支持 `output` / `fields` / `files` / `warn`：
- `fields` 会写进 `nodeFields` 并自动发 `node-fields` 事件通知 UI
- `warn` 挂在 `node-done` 的 error 上，但**不算失败**（解析有告警时用）


## 新增一种节点的完整清单

1. `types.ts`：加 `XxxNodeData`、并进 `NodeData` 联合、加 `isXxx()`、加 `makeXxxNode()`
2. `flowTypes.ts`：加 `XxxFlowNode`、并进 `FlowNode` 联合
3. `components/XxxNode.tsx`：画布卡片
4. `components/inspectors/XxxInspector.tsx`：属性面板
5. `engine/runners/xxx.ts`：执行器
6. `nodes/defs/xxx.ts`：调 `registerNode(...)`
7. `nodes/index.ts`：加一行 `import './defs/xxx';`

第 3~6 步都是新文件，不改动任何既有文件 —— 这正是这次重构的目的。
（第 1、2 步仍需改 `types.ts` / `flowTypes.ts`，是因为 TypeScript 的
判别联合必须在编译期写死，运行时注册表替代不了。）

## 删一种节点

删掉它的 `defs/xxx.ts` 与 `index.ts` 里那行 import 即可。

历史画布里残留的该类型节点会退化成"未注册"占位卡片：能选中、能删除、
能看出缺了什么，不会白屏，也不会让整条工作流跑不起来。
