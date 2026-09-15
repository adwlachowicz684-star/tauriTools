import { makeConditionNode } from '../../types';
import ConditionNode from '../../components/ConditionNode';
import { ConditionInspector } from '../../components/inspectors/ConditionInspector';
import { runCondition } from '../../engine/runners/condition';
import { registerNode } from '../registry';

registerNode({
  type: 'condition',
  dataKind: 'condition',
  meta: {
    label: '条件分支',
    color: '#a855f7',
    category: 'flow',
    idPrefix: 'c',
  },
  create: (id, partial) => makeConditionNode(id, (partial ?? {}) as never).data,
  Canvas: ConditionNode,
  Inspector: ConditionInspector,
  run: runCondition,
});
