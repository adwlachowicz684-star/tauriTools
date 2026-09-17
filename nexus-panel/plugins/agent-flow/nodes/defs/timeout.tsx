import { makeTimeoutNode } from '../../types';
import { TimeoutNode } from '../../components/ControlNode';
import type { FieldDef } from '../../components/inspectors/fields';
import { runTimeout } from '../../engine/runners/timeout';
import { registerNode } from '../registry';

/** 超时熔断 —— 整条流程超预算就断在这里。输出原样透传上游 */
const fields: FieldDef[] = [
  {
    type: 'number',
    key: 'budgetMs',
    label: '预算',
    min: 1,
    step: 1000,
    hint: '毫秒。从**整条流程开始**算起，不是本节点自己的耗时',
  },
  {
    type: 'select',
    key: 'onExceed',
    label: '超预算时',
    options: [
      { value: 'fail', label: '中断', hint: '失败并阻断下游' },
      { value: 'pass', label: '放行', hint: '记一条警告，流程继续' },
    ],
  },
];

registerNode({
  type: 'timeout',
  dataKind: 'timeout',
  meta: {
    label: '超时熔断',
    color: '#22d3ee',
    category: 'control',
    idPrefix: 'to',
    sub: '整条流程超预算就断在这里',
  },
  create: (id, partial) => makeTimeoutNode(id, (partial ?? {}) as never).data,
  Canvas: TimeoutNode,
  fields: () => fields,
  run: runTimeout,
});
