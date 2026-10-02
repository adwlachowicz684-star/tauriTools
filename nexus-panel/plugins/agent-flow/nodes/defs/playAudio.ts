import { makePlayAudioNode } from '../../types';
import { PlayAudioNode } from '../../components/ToolNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runPlayAudio } from '../../engine/runners/playAudio';
import { registerNode } from '../registry';
import { card } from '../paramCards';

const fields: FieldDef[] = [
  /* 与「播放声音」节点共用同一批卡片（见 nodes/paramCards.ts） */
  card('sound.path'),
  card('sound.volume'),
  card('sound.waitForEnd'),
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
});
