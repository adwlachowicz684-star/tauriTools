import { makeRandomNode } from '../../types';
import { OpNode } from '../../components/OpNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runRandom } from '../../engine/runners/ops';
import { registerNode } from '../registry';

const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'op',
    label: '随机什么',
    options: [
      { value: 'int', label: '随机整数' },
      { value: 'float', label: '随机小数' },
      { value: 'pick', label: '随机选一个' },
      { value: 'shuffle', label: '打乱顺序' },
      { value: 'bool', label: '随机真 / 假' },
    ],
  },
  {
    type: 'text', key: 'a', label: '最小值 / 选项列表',
    placeholder: '整数时填最小值；选一个时填 "a,b,c"',
    when: (d) => String(d.op) !== 'bool',
  },
  {
    type: 'text', key: 'b', label: '最大值',
    when: (d) => ['int', 'float'].includes(String(d.op)),
  },
  {
    type: 'note',
    content: '每次运行都重新随机 —— 想固定结果就改用常量节点。',
  },
];

registerNode({
  type: 'random',
  dataKind: 'random',
  meta: { label: '随机', color: '#5ac8fa', category: 'ops', idPrefix: 'rd', sub: '随机数、随机选一个、打乱' },
  create: (id, partial) => makeRandomNode(id, partial ?? {}).data,
  Canvas: OpNode,
  fields: () => fields,
  run: runRandom,
});
