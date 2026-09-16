import { makeLogNode } from '../../types';
import { LogNode } from '../../components/ToolNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runLog } from '../../engine/runners/log';
import { registerNode } from '../registry';

const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'level',
    label: '级别',
    options: [
      { value: 'info', label: '普通', hint: 'ℹ 常规记录' },
      { value: 'warn', label: '警告', hint: '⚠ 需要留意' },
      { value: 'error', label: '错误', hint: '✗ 醒目标记' },
    ],
    hint: '只是日志标记，三种级别都不会让流程失败',
  },
  {
    type: 'textarea',
    key: 'text',
    label: '要记的内容',
    rows: 4,
    placeholder: '支持 {{上游.output}}；留空则记上游传过来的内容',
  },
  {
    type: 'note',
    content: '输出原样透传给下游 —— 这个节点不改变数据流，纯粹是给人看的。',
  },
];

registerNode({
  type: 'log',
  dataKind: 'log',
  meta: {
    label: '日志标记',
    color: '#94a3b8',
    category: 'tools',
    idPrefix: 'lg',
    sub: '往运行日志里写一条，不影响数据流',
  },
  create: (id, partial) => makeLogNode(id, (partial ?? {}) as never).data,
  Canvas: LogNode,
  fields: () => fields,
  run: runLog,
});
