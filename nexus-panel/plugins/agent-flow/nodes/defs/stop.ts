import { makeStopNode } from '../../types';
import { OpNode } from '../../components/OpNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runStop } from '../../engine/runners/ops';
import { registerNode } from '../registry';

/**
 * 停止 —— Scratch 的"停止全部脚本"。
 *
 * 此前只能靠超时熔断被动中断，没有主动终止的手段。
 */
const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'mode',
    label: '停到哪',
    options: [
      { value: 'all', label: '整个流程', hint: '所有分支都停下' },
      { value: 'branch', label: '这条分支', hint: '只掐当前这条，别的分支照跑' },
    ],
  },
  {
    type: 'note',
    content: '停止不算失败 —— 日志里不会标红。上游数据原样透传给下游。',
  },
];

registerNode({
  type: 'stop',
  dataKind: 'stop',
  meta: { label: '停止', color: '#ff453a', category: 'control', idPrefix: 'st', sub: '到此为止，不再往下跑' },
  create: (id, partial) => makeStopNode(id, partial ?? {}).data,
  Canvas: OpNode,
  fields: () => fields,
  run: runStop,
});
