import { makeTriggerNode, TRIGGER_META } from '../../types';
import TriggerNode from '../../components/TriggerNode';
import { TriggerInspector } from '../../components/inspectors/TriggerInspector';
import { runTrigger } from '../../engine/runners/trigger';
import { registerNode } from '../registry';

registerNode({
  type: 'trigger',
  dataKind: 'trigger',
  meta: {
    label: '触发器',
    color: '#eab308',
    category: 'trigger',
    idPrefix: 'tr',
    sub: Object.values(TRIGGER_META).map((m) => m.label).join(' / '),
  },
  create: (id, partial) => makeTriggerNode(id, (partial ?? {}) as never).data,
  Canvas: TriggerNode,
  Inspector: TriggerInspector,
  run: runTrigger,
});
