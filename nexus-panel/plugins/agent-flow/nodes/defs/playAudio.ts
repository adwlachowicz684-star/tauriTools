import { makePlayAudioNode } from '../../types';
import { PlayAudioNode } from '../../components/ToolNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runPlayAudio } from '../../engine/runners/playAudio';
import { registerNode } from '../registry';

const fields: FieldDef[] = [
  {
    type: 'text',
    key: 'path',
    label: '音频文件',
    placeholder: '/path/to/sound.mp3',
    hint: '支持模板，如 {{上游.output}}；建议 mp3 / wav / ogg',
  },
  {
    type: 'number',
    key: 'volume',
    label: '音量',
    min: 0,
    max: 1,
    step: 0.1,
  },
  {
    type: 'switch',
    key: 'waitForEnd',
    label: '',
    placeholder: '播完再往下走（关掉则立即继续，声音继续放）',
  },
  {
    type: 'note',
    content: '需要读取本地文件，浏览器模式下不可用（会提示缺少音频读取能力）。',
  },
];

registerNode({
  type: 'play-audio',
  dataKind: 'play-audio',
  meta: {
    label: '播放音频',
    color: '#fbbf24',
    category: 'tools',
    idPrefix: 'pa',
    sub: '播放本地音频文件',
  },
  create: (id, partial) => makePlayAudioNode(id, (partial ?? {}) as never).data,
  Canvas: PlayAudioNode,
  fields: () => fields,
  run: runPlayAudio,
});
