import { makeCanvasRefNode } from '../../types';
import { CanvasRefNode } from '../../components/CanvasRefNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { registerNode } from '../registry';

/**
 * 调用另一张画布。
 *
 * 执行时这张画布会被目标画布的内部节点替换 ——
 * 于是失败传播、跳过、并发这些既有规则自动生效，
 * 不需要为"跨画布"重写一套调度。
 *
 * 它是同步的：下游节点会等这张画布跑完再跑（拓扑排序天然保证）。
 */
const fields: FieldDef[] = [
  {
    type: 'note',
    content: '在下拉框里选要调用哪张画布。被调用的画布可以用「画布输入 / 画布输出」节点自己定接口；不放这些节点时，接口会自动识别（没有上游的当入口、没有下游的当出口）。',
  },
];

registerNode({
  type: 'canvasRef',
  dataKind: 'canvasRef',
  meta: {
    label: '调用画布', color: '#a78bfa', category: 'flow',
    idPrefix: 'cr', sub: '把另一张画布当一个节点用',
  },
  create: (id, partial) => makeCanvasRefNode(id, partial ?? {}).data,
  Canvas: CanvasRefNode,
  fields: () => fields,
});
