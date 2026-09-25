import { makeTaskPaneNode, CLI_META, type CliKind } from '../../types';
import { PaneNode } from '../../components/PaneNode';
import { CliModelPanel } from '../../components/inspectors/shared';
import { type FieldDef } from '../../components/inspectors/fields';
import { registerNode } from '../registry';

/**
 * CLI 任务窗格。
 *
 * ================= 它做什么 ====================
 *
 * 一批 CLI 节点常常共享同一批配置：同一个项目目录、同一个模型、
 * 同一条连接、同样的自动批准开关。逐节点填一遍，换目录时要改十几处，
 * 漏一处就表现为"这个节点还在旧目录里跑"，而且不报错。
 *
 * 挂在窗格里的节点，**自己没填的项**从窗格继承。
 *
 * ================= 与组合框的区别 ====================
 *
 * 组合框（frame）只管画图：框住、整体挪动，不带配置。
 * 窗格带配置。两者可以叠着用 —— 先框成一组方便挪，再挂窗格统一管理配置。
 *
 * ================= 为什么不参与执行 ====================
 *
 * 它只是配置的载体，真正跑的还是里面的节点。
 * 没有 run：执行前会被滤掉，任务记录里不会多出一条空节点。
 */
const fields: FieldDef[] = [
  {
    type: 'note',
    content: '把 CLI 节点的共享配置收在这里：节点上没填的项（工作目录 / 模型 / 连接 / 自动批准）会取这里的。节点上填了的仍然以节点为准。',
  },
  { key: 'label', label: '名称', type: 'text', placeholder: 'CLI 任务窗格' },
  {
    type: 'select',
    key: 'cli',
    label: '默认 CLI',
    hint: '只作新建时的默认值；已经建好的节点在节点上自己选',
    options: () =>
      (Object.keys(CLI_META) as CliKind[]).map((k) => ({
        value: k,
        label: CLI_META[k].label,
      })),
  },
  {
    type: 'text',
    key: 'workdir',
    label: '共享工作目录',
    placeholder: '留空则各节点用自己的',
    hint: '挂进来的节点如果自己没填目录，就在这里这个目录下跑',
  },
  {
    type: 'custom',
    spec: { keys: ['model', 'credentialId'], kind: 'select' },
    key: 'model',
    render: (p) => (
      <CliModelPanel
        model={String(p.d.model ?? '')}
        credentialId={p.d.credentialId as string}
        credentials={p.credentials}
        onChange={p.patch}
        onOpenCredentials={p.onOpenCredentials}
      />
    ),
  },
  {
    type: 'switch',
    key: 'yolo',
    label: '',
    placeholder: '自动批准工具调用（-y）',
    hint: '权限放宽项：窗格开了，里面节点就算没开也按开处理',
  },
  {
    type: 'switch',
    key: 'shareContext',
    label: '',
    placeholder: '把前面步骤的结果接进下一个节点',
    hint: '同一窗格内串联的节点，上游输出会附在下一条指令前面。关掉则每个节点只看自己的提示词',
  },
];

registerNode({
  type: 'taskPane',
  dataKind: 'taskPane',
  meta: {
    label: 'CLI 任务窗格',
    color: '#f97316',
    category: 'task',
    idPrefix: 'tp',
    sub: '一组 CLI 节点共享目录与模型',
    presets: () => [
      {
        key: 'taskPane',
        label: 'CLI 任务窗格',
        color: '#f97316',
        init: () => makeTaskPaneNode('').data,
      },
    ],
  },
  create: (id, partial) => makeTaskPaneNode(id, (partial ?? {}) as never).data,
  Canvas: PaneNode,
  fields: () => fields,
});
