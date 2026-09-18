import { makeCanvasOutNode } from '../../types';
import { CanvasRefNode } from '../../components/CanvasRefNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runCanvasOut } from '../../engine/runners/canvasPort';
import { registerNode } from '../registry';

/** 画布输出 —— 显式标注"这里是这张画布的出口" */
const fields: FieldDef[] = [
  {
    type: 'text',
    key: 'portName',
    label: '端口名',
    placeholder: '如：推导结果',
    hint: '多个出口时用它区分',
  },
  {
    type: 'textarea',
    key: 'fallback',
    label: '兜底值',
    rows: 2,
    placeholder: '内部没东西时输出这个（可留空）',
    hint: '不填就输出空 —— 不会让画布失败',
  },
  {
    type: 'note',
    content: '它不做计算，只把内部结果原样送出画布。放了这个节点后，这张画布的出口就以它为准。',
  },
];

registerNode({
  type: 'canvasOut',
  dataKind: 'canvasOut',
  meta: {
    label: '画布输出', color: '#a78bfa', category: 'flow',
    idPrefix: 'co', sub: '标注这张画布的出口',
  },
  create: (id, partial) => makeCanvasOutNode(id, partial ?? {}).data,
  Canvas: CanvasRefNode,
  fields: () => fields,
  run: runCanvasOut,
});
