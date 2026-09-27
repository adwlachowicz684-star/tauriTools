import {
  makeBeepNode, BEEP_PRESET_META, SOUND_SOURCE_META,
  type BeepPreset, type SoundSource,
} from '../../types';
import { BeepNode } from '../../components/ToolNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runBeep } from '../../engine/runners/beep';
import { registerNode } from '../registry';
import { card, whenSoundFile } from '../paramCards';

/**
 * 播放声音 —— 一个节点覆盖两种声源。
 *
 * 「提示音」（系统音效）与「播放音频」（本地文件）原本是两个节点，
 * 但它们做的是同一件事（响一声），且**都带 volume** ——
 * 分成两个后音量校验就要写两遍。合并成一个，用「声音来源」切换。
 *
 * 老的 play-audio 节点标了 legacy（侧栏不再列出，老画布照常能打开运行），
 * 不删是为了不让老画布上的节点变未知节点。
 */

const PRESETS = Object.keys(BEEP_PRESET_META) as BeepPreset[];
const SOURCES = Object.keys(SOUND_SOURCE_META) as SoundSource[];

const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'source',
    label: '声音来源',
    options: SOURCES.map((k) => ({ value: k, label: SOUND_SOURCE_META[k].label })),
    hint: (d) => SOUND_SOURCE_META[(d.source as SoundSource) ?? 'preset']?.hint,
  },

  {
    type: 'select',
    key: 'preset',
    label: '音效',
    when: (d) => (d.source ?? 'preset') === 'preset',
    options: () => PRESETS.map((k) => ({
      value: k,
      label: BEEP_PRESET_META[k].label,
      hint: BEEP_PRESET_META[k].hint,
    })),
  },

  /*
   * 下面三张都取自参数卡片层 —— 旧的 play-audio 节点用的是同一批，
   * 各写一份的话改一处漏一处（表现是"两个节点的音量范围不一样"，且不报错）。
   */
  card('sound.path', { when: whenSoundFile }),
  card('sound.volume'),
  card('sound.waitForEnd', { when: whenSoundFile }),

  {
    type: 'note',
    content:
      '系统音效由 Web Audio 实时合成，播不出来只会告警，不会让流程失败。'
      + '本地文件那条路需要读取本地文件，浏览器模式下不可用。',
  },
];

registerNode({
  type: 'beep',
  dataKind: 'beep',
  meta: {
    label: '播放声音',
    color: '#fbbf24',
    category: 'tools',
    idPrefix: 'bp',
    sub: '响一声：系统音效或本地音频文件',
  },
  create: (id, partial) => makeBeepNode(id, (partial ?? {}) as never).data,
  Canvas: BeepNode,
  fields: () => fields,
  run: runBeep,
});
