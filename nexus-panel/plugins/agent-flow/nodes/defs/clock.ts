import { makeClockNode } from '../../types';
import { ClockNode } from '../../components/ToolNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runClock } from '../../engine/runners/clock';
import { registerNode } from '../registry';

const fields: FieldDef[] = [
  {
    type: 'text',
    key: 'format',
    label: '格式',
    placeholder: 'YYYY-MM-DD HH:mm:ss',
  },
  {
    type: 'note',
    content: '占位符：YYYY 年 · MM 月 · DD 日 · HH 时 · mm 分 · ss 秒 · SSS 毫秒。其它字符原样保留。',
  },
];

registerNode({
  type: 'clock',
  dataKind: 'clock',
  meta: {
    label: '当前时间',
    color: '#94a3b8',
    category: 'tools',
    idPrefix: 'ck',
    sub: '输出当前时间，常用于生成带时间戳的文件名',
  },
  create: (id, partial) => makeClockNode(id, (partial ?? {}) as never).data,
  Canvas: ClockNode,
  fields: () => fields,
  run: runClock,
});
