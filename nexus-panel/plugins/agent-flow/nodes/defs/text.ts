import { makeTextNode } from '../../types';
import { OpNode } from '../../components/OpNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runText } from '../../engine/runners/ops';
import { registerNode } from '../registry';

/** 文本运算。第三个参数只在替换 / 取子串 / 取第几段时用到 */
const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'op',
    label: '运算',
    options: [
      { value: 'concat', label: '拼接' },
      { value: 'length', label: '取长度' },
      { value: 'upper', label: '转大写' },
      { value: 'lower', label: '转小写' },
      { value: 'trim', label: '去掉首尾空格' },
      { value: 'replace', label: '替换' },
      { value: 'substr', label: '取子串' },
      { value: 'split', label: '取第几段' },
      { value: 'join', label: '连接列表' },
      { value: 'repeat', label: '重复' },
    ],
  },
  { type: 'textarea', key: 'a', label: '文本', rows: 3, placeholder: '支持 {{上游.output}}' },
  {
    type: 'text', key: 'b', label: '第二个值',
    placeholder: '拼接的内容 / 要替换掉的文本 / 起始位置',
    when: (d) => !['length', 'upper', 'lower', 'trim'].includes(String(d.op)),
  },
  {
    type: 'text', key: 'c', label: '第三个值',
    placeholder: '替换成 / 结束位置 / 第几段',
    when: (d) => ['replace', 'substr', 'split'].includes(String(d.op)),
  },
  {
    type: 'note',
    content: '取子串与取第几段的位置从 1 开始数（第 1 个字符），与直觉一致。',
  },
];

registerNode({
  type: 'text',
  dataKind: 'text',
  meta: { label: '文本运算', color: '#5ac8fa', category: 'ops', idPrefix: 'tx', sub: '拼接、替换、截取、大小写' },
  create: (id, partial) => makeTextNode(id, partial ?? {}).data,
  Canvas: OpNode,
  fields: () => fields,
  run: runText,
});
