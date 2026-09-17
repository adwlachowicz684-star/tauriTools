import { makeMathNode } from '../../types';
import { OpNode } from '../../components/OpNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runMath } from '../../engine/runners/ops';
import { registerNode } from '../registry';

/**
 * 数学运算。
 *
 * Scratch 的运算符积木 —— 本插件此前完全没有对应物，
 * 要算个数只能靠模板拼字符串，而模板**不会真的计算**。
 */

const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'op',
    label: '运算',
    options: [
      { value: 'add', label: '加' },
      { value: 'sub', label: '减' },
      { value: 'mul', label: '乘' },
      { value: 'div', label: '除' },
      { value: 'mod', label: '取余' },
      { value: 'min', label: '取较小' },
      { value: 'max', label: '取较大' },
      { value: 'round', label: '四舍五入' },
      { value: 'floor', label: '向下取整' },
      { value: 'ceil', label: '向上取整' },
      { value: 'abs', label: '绝对值' },
    ],
  },
  { type: 'text', key: 'a', label: '第一个数', placeholder: '支持 {{上游.output}}' },
  {
    type: 'text', key: 'b', label: '第二个数', placeholder: '支持 {{上游.output}}',
    // 单目运算（取整、绝对值）不需要第二个数
    when: (d) => !['round', 'floor', 'ceil', 'abs'].includes(String(d.op)),
  },
  {
    type: 'note',
    content: '上游给的是文本，会自动转成数字；转不了的按 0 处理。除数为 0 会报错。',
  },
];

registerNode({
  type: 'math',
  dataKind: 'math',
  meta: { label: '数学运算', color: '#5ac8fa', category: 'ops', idPrefix: 'ma', sub: '加减乘除、取整、取最值' },
  create: (id, partial) => makeMathNode(id, partial ?? {}).data,
  Canvas: OpNode,
  fields: () => fields,
  run: runMath,
});
