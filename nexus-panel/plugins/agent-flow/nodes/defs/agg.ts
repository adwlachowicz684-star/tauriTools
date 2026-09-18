import { makeAggNode } from '../../types';
import { TableNode } from '../../components/TableNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runAgg } from '../../engine/runners/table';
import { registerNode } from '../registry';

/** 汇总 —— 对某一列求一个总数，用于看整体指标 */
const fields: FieldDef[] = [
  { type: 'text', key: 'col', label: '列名', placeholder: '如：伤害' },
  {
    type: 'select',
    key: 'op',
    label: '方式',
    options: [
      { value: 'sum', label: '求和' },
      { value: 'avg', label: '平均' },
      { value: 'min', label: '最小' },
      { value: 'max', label: '最大' },
      { value: 'count', label: '计数（行数）' },
    ],
  },
  {
    type: 'note',
    content: '列名写错会报错而不是给 0 —— 汇总值算错往往要到最后才发现。',
  },
];

registerNode({
  type: 'agg',
  dataKind: 'agg',
  meta: { label: '汇总', color: '#30d158', category: 'table', idPrefix: 'ag', sub: '对一列求和 / 平均 / 最大' },
  create: (id, partial) => makeAggNode(id, partial ?? {}).data,
  Canvas: TableNode,
  fields: () => fields,
  run: runAgg,
});
