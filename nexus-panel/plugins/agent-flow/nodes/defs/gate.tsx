import { makeGateNode } from '../../types';
import { GateNode } from '../../components/ControlNode';
import type { FieldDef } from '../../components/inspectors/fields';
import { runGate } from '../../engine/runners/gate';
import { registerNode } from '../registry';

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
  {
    type: 'select',
    key: 'check',
    label: '条件',
    options: [
      { value: 'nonempty', label: '非空', hint: '有内容就行' },
      { value: 'contains', label: '包含', hint: '含有指定文本' },
      { value: 'notContains', label: '不包含', hint: '不含指定文本（如响应里没有 error）' },
      { value: 'regex', label: '正则', hint: '用正则表达式匹配' },
    ],
  },
  {
    type: 'text',
    key: 'value',
    label: '比对值',
    placeholder: '要包含的文本 / 正则表达式',
    when: (d) => d.check !== 'nonempty',
  },
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
