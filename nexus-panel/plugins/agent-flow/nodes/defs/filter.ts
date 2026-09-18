import { makeFilterNode } from '../../types';
import { TableNode } from '../../components/TableNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runFilter } from '../../engine/runners/table';
import { registerNode } from '../registry';

/** 筛选行 —— 表达式结果非 0 的行保留 */
const fields: FieldDef[] = [
  {
    type: 'textarea',
    key: 'cond',
    label: '保留条件',
    rows: 3,
    placeholder: '等级 >= 50',
    hint: '也可以用算术：暴击伤害 - 1000（结果大于 0 的行保留）',
  },
  {
    type: 'note',
    content: '支持 > >= < <= 这种写法 —— 它们会被当成比较，成立为 1、不成立为 0。',
  },
];

registerNode({
  type: 'filter',
  dataKind: 'filter',
  meta: { label: '筛选行', color: '#30d158', category: 'table', idPrefix: 'fl', sub: '只保留满足条件的行' },
  create: (id, partial) => makeFilterNode(id, partial ?? {}).data,
  Canvas: TableNode,
  fields: () => fields,
  run: runFilter,
});
