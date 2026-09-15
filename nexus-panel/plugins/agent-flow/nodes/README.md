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

## 执行器在哪

执行逻辑放 `engine/runners/` 下，一个节点一个文件，**不要写进 `engine/runner.ts`**。

原因是 runner 是纯逻辑层，单元测试在 Node 下直接跑它，不加载 React；
执行器如果和界面组件混在一起，测试就跑不起来了。

执行器拿到的参数是一个 `RunContext`（`engine/runContext.ts`），里面包好了
`outputs` / `emit` / `setStatus` / `nodeFields` 等原本在闭包里的东西。

> 写完执行器记得挂两处：`defs/xxx.ts` 的 `run` 字段，以及
> `engine/runnerRegistry.ts` 的表。漏挂第二处该节点会静默"直通"——
> 现有测试会失败，所以是能被发现的，但仍建议写完后立刻跑一次 `run-tests.sh`。

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
