import { makeWaitNode } from '../../types';
import { WaitNode } from '../../components/ToolNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runWait } from '../../engine/runners/wait';
import { registerNode } from '../registry';

const fields: FieldDef[] = [
  {
    type: 'number',
    key: 'ms',
    label: '等待时长（毫秒）',
    min: 0,
    step: 100,
    hint: '1000 = 1 秒。支持模板，如 {{上游.output}}',
  },
  {
    type: 'note',
    content: '单次最多 10 分钟，超了会按上限执行并提示。',
  },
];

registerNode({
  type: 'wait',
  dataKind: 'wait',
  meta: {
    label: '等待',
    color: '#94a3b8',
    category: 'tools',
    idPrefix: 'w',
    sub: '暂停一段时间再往下跑',
  },
  create: (id, partial) => makeWaitNode(id, (partial ?? {}) as never).data,
  Canvas: WaitNode,
  fields: () => fields,
  run: runWait,
});
