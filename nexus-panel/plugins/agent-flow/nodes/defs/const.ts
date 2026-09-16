import { makeConstNode } from '../../types';
import { ConstNode } from '../../components/ToolNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runConst } from '../../engine/runners/const';
import { registerNode } from '../registry';

const fields: FieldDef[] = [
  {
    type: 'textarea',
    key: 'value',
    label: '值',
    rows: 5,
    placeholder: '原样输出给下游；支持 {{模板变量}}',
    hint: '名字叫常量，但支持模板，所以实际是"拼一段固定文本"',
  },
];

registerNode({
  type: 'const',
  dataKind: 'const',
  meta: {
    label: '常量',
    color: '#94a3b8',
    category: 'tools',
    idPrefix: 'cv',
    sub: '输出一个固定值给下游',
  },
  create: (id, partial) => makeConstNode(id, (partial ?? {}) as never).data,
  Canvas: ConstNode,
  fields: () => fields,
  run: runConst,
});
