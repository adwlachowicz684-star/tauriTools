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
    sub: '按规则分流，从上往下命中第一条就走',
  },
  create: (id, partial) => makeConditionNode(id, (partial ?? {}) as never).data,
  Canvas: ConditionNode,
  Inspector: ConditionInspector,
  run: runCondition,
});
