import { makeThrottleNode } from '../../types';
import { ThrottleNode } from '../../components/ControlNode';
import type { FieldDef } from '../../components/inspectors/fields';
import { runThrottle } from '../../engine/runners/throttle';
import { registerNode } from '../registry';

/** 限流 —— 控制放行的节奏。输出原样透传上游 */
const fields: FieldDef[] = [
  {
    type: 'number',
    key: 'minIntervalMs',
    label: '最小间隔',
    min: 0,
    step: 100,
    hint: '两次放行之间至少隔多久（毫秒）。留 0 表示不限',
  },
  {
    type: 'number',
    key: 'maxPerRun',
    label: '本次最多放行',
    min: 0,
    step: 1,
    hint: '超出则失败并阻断下游。留空或 0 表示不限次',
  },
  {
    type: 'note',
    content: '间隔是跨运行累计的 —— 第二次运行也会被限制。刷新页面会重置。',
  },
];

registerNode({
  type: 'throttle',
  dataKind: 'throttle',
  meta: {
    label: '限流',
    color: '#22d3ee',
    category: 'control',
    idPrefix: 'th',
    sub: '控制放行的节奏',
  },
  create: (id, partial) => makeThrottleNode(id, (partial ?? {}) as never).data,
  Canvas: ThrottleNode,
  fields: () => fields,
  run: runThrottle,
});
