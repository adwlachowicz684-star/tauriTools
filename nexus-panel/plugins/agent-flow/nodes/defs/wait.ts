import { makeWaitNode } from '../../types';
import { WaitNode } from '../../components/ToolNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runWait } from '../../engine/runners/wait';
import { registerNode } from '../registry';

const fields: FieldDef[] = [
  {
    /*
     * 这里是 text 而不是 number。
     *
     * 执行器支持 ms 走模板（{{上游.output}} 里可能算出一个时长），
     * 而 <input type="number"> 会把 `{{` 这种非数字输入直接吞掉 ——
     * 说明里写着"支持模板"，框里却根本敲不进模板。
     * 数字校验交给 vWait，它认模板引用并跳过纯数字判定。
     */
    type: 'text',
    key: 'ms',
    label: '等待时长（毫秒）',
    placeholder: '如 2000，或 {{上游.output}}',
    tpl: true,
    hint: '1000 = 1 秒。支持模板，如 {{上游.output}}',
  },
  {
    type: 'note',
    content: '单次最多 10 分钟，超了会按上限执行并提示。',
  },
];

registerNode({
  type: 'wait',
  dataKind: 'wait',
  meta: {
    label: '等待',
    color: '#94a3b8',
    category: 'tools',
    idPrefix: 'w',
    sub: '暂停一段时间再往下跑',
  },
  create: (id, partial) => makeWaitNode(id, (partial ?? {}) as never).data,
  Canvas: WaitNode,
  fields: () => fields,
});
