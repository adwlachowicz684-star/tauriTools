import { makeCompareNode } from '../../types';
import { OpNode } from '../../components/OpNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runCompare } from '../../engine/runners/ops';
import { registerNode } from '../registry';

/**
 * 比较运算。输出 true / false 文本 ——
 * 不给空串，因为空串在条件节点里会被当成"没内容"从而走错分支。
 */
const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'op',
    label: '比较',
    options: [
      { value: 'eq', label: '等于' },
      { value: 'neq', label: '不等于' },
      { value: 'gt', label: '大于' },
      { value: 'gte', label: '大于等于' },
      { value: 'lt', label: '小于' },
      { value: 'lte', label: '小于等于' },
      { value: 'contains', label: '包含' },
      { value: 'startsWith', label: '开头是' },
      { value: 'endsWith', label: '结尾是' },
    ],
  },
  { type: 'text', key: 'a', label: '左边', placeholder: '支持 {{上游.output}}' },
  { type: 'text', key: 'b', label: '右边', placeholder: '要比较的值' },
  {
    type: 'note',
    content: '两边都能转成数字时按数字比（否则 "10" 会小于 "9"），否则按文本比。输出 true / false。',
  },
];

registerNode({
  type: 'compare',
  dataKind: 'compare',
  meta: { label: '比较', color: '#5ac8fa', category: 'ops', idPrefix: 'cm', sub: '比大小、判断是否包含' },
  create: (id, partial) => makeCompareNode(id, partial ?? {}).data,
  Canvas: OpNode,
  fields: () => fields,
  run: runCompare,
});
