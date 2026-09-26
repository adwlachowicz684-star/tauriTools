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
    /*
     * legacy：已并入「播放声音」节点（声音来源选「本地文件」）。
     *
     * 标 legacy 而不是删掉，是因为老画布上还有这种节点 ——
     * 删掉会让它们变未知节点。侧栏不再列出，老画布照常能打开运行。
     */
    legacy: true,
    label: '播放音频（旧）',
    color: '#fbbf24',
    category: 'tools',
    idPrefix: 'pa',
    sub: '已并入「播放声音」节点 —— 新画布请用播放声音，来源选「本地文件」',
  },
  create: (id, partial) => makePlayAudioNode(id, (partial ?? {}) as never).data,
  Canvas: PlayAudioNode,
  fields: () => fields,
  run: runPlayAudio,
});
