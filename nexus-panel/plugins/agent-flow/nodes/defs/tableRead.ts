import { makeTableReadNode } from '../../types';
import { TableNode } from '../../components/TableNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runTableRead } from '../../engine/runners/table';
import { registerNode } from '../registry';

/**
 * 读表格 —— 数值推导的入口。
 *
 * 用 CSV / TSV 而不是 xlsx：CSV 是 Excel 能直接打开、也能直接另存为的
 * 格式，对"在 Excel 里编辑、在插件里推导"这个用法完全够用。
 */
const fields: FieldDef[] = [
  {
    type: 'text',
    key: 'path',
    label: '文件路径',
    placeholder: '如：/Users/me/数值表.csv',
    hint: 'CSV / TSV。Excel 里「另存为 → CSV」即可得到',
  },
  {
    type: 'select',
    key: 'delim',
    label: '分隔符',
    options: [
      { value: '', label: '自动判断', hint: '按第一行里出现最多的那个算' },
      { value: ',', label: '逗号（CSV）' },
      { value: '\t', label: '制表符（TSV）' },
      { value: ';', label: '分号' },
      { value: '|', label: '竖线' },
    ],
  },
  {
    type: 'note',
    content: '第一行必须是表头（列名）。列名会直接用作公式里的变量名，建议不要带空格。',
  },
];

registerNode({
  type: 'tableRead',
  dataKind: 'tableRead',
  meta: { label: '读表格', color: '#30d158', category: 'table', idPrefix: 'tb', sub: '读一个 CSV / TSV 表格' },
  create: (id, partial) => makeTableReadNode(id, partial ?? {}).data,
  Canvas: TableNode,
  fields: () => fields,
  run: runTableRead,
});
