import { makeApiPaneNode } from '../../types';
import { PaneNode } from '../../components/PaneNode';
import { LlmConfigPanel } from '../../components/inspectors/shared';
import { type FieldDef } from '../../components/inspectors/fields';
import { registerNode } from '../registry';

/**
 * API 任务窗格。
 *
 * ================= 比 CLI 窗格多一样东西 ====================
 *
 * 除了连接与模型，它还承载 **system 提示词**。
 * 于是窗格变成一个"角色 / 场景模板"：
 * 里面每个节点只填 user 提示词，共用一个角色设定与同一条连接。
 *
 * 想换角色（比如从"严谨的校对"换成"毒舌的评论员"），
 * 改窗格这一处即可，不必逐个节点改 system。
 */
const fields: FieldDef[] = [
  {
    type: 'note',
    content: '把大模型节点的共享配置收在这里：连接、模型、角色提示词、温度。节点上没填的项会取这里的。',
  },
  { key: 'label', label: '名称', type: 'text', placeholder: 'API 任务窗格' },
  {
    type: 'custom',
    spec: { keys: ['model', 'credentialId'], kind: 'select' },
    key: 'model',
    render: (p) => (
      <LlmConfigPanel
        cfg={p.d.llm as never}
        needVision={false}
        onChange={p.patch}
        credentials={p.credentials}
        credentialId={p.d.credentialId as string}
        onOpenCredentials={p.onOpenCredentials}
      />
    ),
  },
  {
    type: 'textarea',
    key: 'system',
    label: '角色提示词（system）',
    rows: 4,
    placeholder: '例如：你是一名资深技术编辑，回答简洁、不客套',
    hint: '挂进来的节点如果自己没填 system，就用这一份',
  },
  {
    type: 'number',
    key: 'temperature',
    label: '温度',
    min: 0,
    max: 2,
    step: 0.1,
    placeholder: '留空用 0.3',
  },
  {
    type: 'switch',
    key: 'jsonMode',
    label: '',
    placeholder: '要求结构化 JSON 输出',
    hint: '不是所有模型都支持；不支持的会返回错误而不是悄悄返回普通文本',
  },
];

registerNode({
  type: 'apiPane',
  dataKind: 'apiPane',
  meta: {
    label: 'API 任务窗格',
    color: '#a78bfa',
    category: 'ai',
    idPrefix: 'ap',
    sub: '一组大模型节点共享连接与角色设定',
    presets: () => [
      {
        key: 'apiPane',
        label: 'API 任务窗格',
        color: '#a78bfa',
        init: () => makeApiPaneNode('').data,
      },
    ],
  },
  create: (id, partial) => makeApiPaneNode(id, (partial ?? {}) as never).data,
  Canvas: PaneNode,
  fields: () => fields,
});
