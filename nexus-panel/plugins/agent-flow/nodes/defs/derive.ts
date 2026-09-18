import { makeDeriveNode } from '../../types';
import { TableNode } from '../../components/TableNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runDerive } from '../../engine/runners/table';
import { registerNode } from '../registry';

/**
 * 推导列 —— 数值推导的核心。
 *
 * 对表格每一行求同一个公式，结果写成新的一列。
 * 公式里用列名直接引用该行的值（不用 {{}}）：
 *
 *   攻击力 * (1 + 暴击率) - 防御力 * 0.5
 */
const fields: FieldDef[] = [
  { type: 'text', key: 'newCol', label: '新列名', placeholder: '如：伤害' },
  {
    type: 'textarea',
    key: 'expr',
    label: '公式',
    rows: 4,
    placeholder: '攻击力 * (1 + 暴击率) - 防御力 * 0.5',
    hint: '直接写列名，不用加括号',
  },
  {
    type: 'switch',
    key: 'replace',
    label: '允许覆盖同名列',
    hint: '不勾时遇到同名列会报错，避免把原始数据冲掉',
  },
  {
    type: 'note',
    content: '可用函数：round / floor / ceil / abs / sqrt / min / max / pow / clamp(v,下限,上限) / rand。四则 + - * / % 与 ^（乘方）、括号都支持。列名写错会明确报错，不会静默算成 0。',
  },
];

registerNode({
  type: 'derive',
  dataKind: 'derive',
  meta: { label: '推导列', color: '#30d158', category: 'table', idPrefix: 'dv', sub: '对每一行套公式，算出新的一列' },
  create: (id, partial) => makeDeriveNode(id, partial ?? {}).data,
  Canvas: TableNode,
  fields: () => fields,
  run: runDerive,
});
