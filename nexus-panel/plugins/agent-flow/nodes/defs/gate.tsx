import { makeGateNode } from '../../types';
import { GateNode } from '../../components/ControlNode';
import type { FieldDef } from '../../components/inspectors/fields';
import { runGate } from '../../engine/runners/gate';
import { registerNode } from '../registry';
import { card } from '../paramCards';

/**
 * 闸门 —— 满足条件才放行下游。
 *
 * 控制器家族成员：它不产生数据，只决定"放不放行"。
 * 输出原样透传上游。
 */
const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'mode',
    label: '判定方式',
    options: [
      { value: 'wait', label: '等待', hint: '轮询到满足为止，超时按下面配置处理' },
      { value: 'now', label: '立即', hint: '不满足就直接失败，下游跳过' },
    ],
  },
  /*
   * 这两张与「重试」节点共用（见 nodes/paramCards.ts）。
   * 选项完全一致，只有标签不同 —— 闸门叫「条件」，重试叫「合格条件」，
   * 那是刻意的：一个判放不放行，一个判跑得对不对。
   */
  card('cmp.check', { label: '条件' }),
  card('cmp.value'),
  {
    type: 'number',
    key: 'timeoutMs',
    label: '最长等待',
    min: 0,
    step: 500,
    hint: '毫秒',
    when: (d) => d.mode === 'wait',
  },
  {
    type: 'number',
    key: 'pollMs',
    label: '轮询间隔',
    min: 50,
    step: 100,
    hint: '毫秒',
    when: (d) => d.mode === 'wait',
  },
  {
    type: 'select',
    key: 'onTimeout',
    label: '超时后',
    options: [
      { value: 'fail', label: '失败', hint: '阻断下游' },
      { value: 'pass', label: '照样放行', hint: '记一条警告，流程继续' },
    ],
    when: (d) => d.mode === 'wait',
  },
  {
    type: 'note',
    content: '等待模式在循环体里最有用 —— 每轮进来都会重新判定一次上游输出。',
  },
];

registerNode({
  type: 'gate',
  dataKind: 'gate',
  meta: {
    label: '闸门',
    color: '#22d3ee',
    category: 'control',
    idPrefix: 'gt',
    sub: '满足条件才放行下游',
  },
  create: (id, partial) => makeGateNode(id, (partial ?? {}) as never).data,
  Canvas: GateNode,
  fields: () => fields,
  run: runGate,
});
