import { makeParallelNode } from '../../types';
import ParallelNode from '../../components/ParallelNode';
import { ParallelInspector } from '../../components/inspectors/ParallelInspector';
import { runParallel } from '../../engine/runners/parallel';
import { registerNode } from '../registry';

registerNode({
  type: 'parallel',
  dataKind: 'parallel',
  meta: {
    label: '并发控制',
    color: '#06b6d4',
    category: 'flow',
    idPrefix: 'p',
  },
  create: (id, partial) => makeParallelNode(id, (partial ?? {}) as never).data,
  Canvas: ParallelNode,
  Inspector: ParallelInspector,
  run: runParallel,
});
