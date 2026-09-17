import { makeVarNode } from '../../types';
import { OpNode } from '../../components/OpNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runVar } from '../../engine/runners/ops';
import { registerNode } from '../registry';

/**
 * 变量 —— 跨节点共享的中间值。
 *
 * 此前跨节点取值只能靠 {{节点id.output}} 回指，而流程一改 id 就变，
 * 引用会失效（失效不报错，只渲染成空串）。
 * 变量用名字索引，稳定得多。
 */
const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'mode',
    label: '操作',
    options: [
      { value: 'set', label: '写入', hint: '把值存进这个变量' },
      { value: 'get', label: '读取', hint: '把变量的值取出来给下游' },
    ],
  },
  { type: 'text', key: 'name', label: '变量名', placeholder: '如：总数、上次时间' },
  {
    type: 'textarea',
    key: 'value',
    label: '值',
    rows: 3,
    placeholder: '留空则用上游输出',
    hint: '支持模板',
    when: (d) => d.mode !== 'get',
  },
  {
    type: 'note',
    content: '读取时用 {{var.变量名}} 也能取到。变量没赋值过就读不出来，会明确报错而不是给空值。',
  },
];

registerNode({
  type: 'var',
  dataKind: 'var',
  meta: { label: '变量', color: '#ff9f0a', category: 'ops', idPrefix: 'vr', sub: '存一个值，之后按名字取' },
  create: (id, partial) => makeVarNode(id, partial ?? {}).data,
  Canvas: OpNode,
  fields: () => fields,
  run: runVar,
});
