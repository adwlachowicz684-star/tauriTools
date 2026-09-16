import { makeBeepNode, BEEP_PRESET_META, type BeepPreset } from '../../types';
import { BeepNode } from '../../components/ToolNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runBeep } from '../../engine/runners/beep';
import { registerNode } from '../registry';

const PRESETS = Object.keys(BEEP_PRESET_META) as BeepPreset[];

const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'preset',
    label: '音效',
    options: () => PRESETS.map((k) => ({
      value: k,
      label: BEEP_PRESET_META[k].label,
      hint: BEEP_PRESET_META[k].hint,
    })),
  },
  {
    type: 'number',
    key: 'volume',
    label: '音量',
    min: 0,
    max: 1,
    step: 0.1,
    hint: '0 ~ 1，默认 0.6',
  },
  {
    type: 'note',
    content: '声音由 Web Audio 实时合成，不需要任何音频文件。播不出来只会告警，不会让流程失败。',
  },
];

registerNode({
  type: 'beep',
  dataKind: 'beep',
  meta: {
    label: '提示音',
    color: '#fbbf24',
    category: 'tools',
    idPrefix: 'bp',
    sub: '跑完了响一声，适合长时间无人值守的流程',
  },
  create: (id, partial) => makeBeepNode(id, (partial ?? {}) as never).data,
  Canvas: BeepNode,
  fields: () => fields,
  run: runBeep,
});
