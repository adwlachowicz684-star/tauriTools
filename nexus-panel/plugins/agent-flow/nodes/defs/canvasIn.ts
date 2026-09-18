import { makeCanvasInNode } from '../../types';
import { CanvasRefNode } from '../../components/CanvasRefNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runCanvasIn } from '../../engine/runners/canvasPort';
import { registerNode } from '../registry';

/**
 * 画布输入 —— 显式标注"这里是这张画布的入口"。
 *
 * 不放也能用（会自动把没有上游的节点当入口）。
 * 放它的理由是画布内部有多个独立起点、只想暴露其中一部分时，
 * 自动推导会把不该暴露的也当成入口。
 */
const fields: FieldDef[] = [
  {
    type: 'text',
    key: 'portName',
    label: '端口名',
    placeholder: '如：原始数值',
    hint: '多个入口时用它区分；不填就用节点标题',
  },
  {
    type: 'note',
    content: '它不做计算，只把外部传进来的数据原样交给内部下游。放了这个节点后，这张画布的入口就以它为准。',
  },
];

registerNode({
  type: 'canvasIn',
  dataKind: 'canvasIn',
  meta: {
    label: '画布输入', color: '#a78bfa', category: 'flow',
    idPrefix: 'ci', sub: '标注这张画布的入口',
  },
  create: (id, partial) => makeCanvasInNode(id, partial ?? {}).data,
  Canvas: CanvasRefNode,
  fields: () => fields,
  run: runCanvasIn,
});
