import { makeLoopNode } from '../../types';
import LoopNode from '../../components/LoopNode';
import { LoopInspector } from '../../components/inspectors/LoopInspector';
import { runLoop } from '../../engine/runners/loop';
import { registerNode } from '../registry';

registerNode({
  type: 'loop',
  dataKind: 'loop',
  meta: {
    label: '循环',
    color: '#f472b6',
    category: 'flow',
    idPrefix: 'lp',
  },
  create: (id, partial) => makeLoopNode(id, (partial ?? {}) as never).data,
  Canvas: LoopNode,
  Inspector: LoopInspector,
  run: runLoop,
});
