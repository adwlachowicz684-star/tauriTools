import { makeOcrNode, defaultOcrPrompt } from '../../types';
import OcrNode from '../../components/OcrNode';
import { LlmConfigPanel } from '../../components/inspectors/shared';
import type { FieldDef } from '../../components/inspectors/fields';
import { runOcr } from '../../engine/runners/ocr';
import { registerNode } from '../registry';
import { card, credCard } from '../paramCards';
import { renderImageUrl, renderImagePath } from '../imageCards';

const fields: FieldDef[] = [
  {
    type: 'custom',
    spec: { keys: ['imageSource', 'url'], kind: 'select', options: ['path', 'url'] },
    render: (p) => (
      <LlmConfigPanel
        cfg={p.d.llm as never}
        onChange={p.patch}
        needVision
        credentials={p.credentials}
        credentialId={p.d.credentialId as string}
        onOpenCredentials={p.onOpenCredentials}
      />
    ),
  },
  credCard('ocr'),

  /* 与「大模型」节点共用同一张卡（见 nodes/paramCards.ts） */
  card('llm.imageSource'),

  /*
   * 这两块的 render 与「大模型」节点共用（见 nodes/imageCards.tsx）。
   *
   * spec.keys 留在节点上：它是契约与参数文档取参数名的唯一来源，
   * 写在节点里能被逐块对账。以前这份抄 llmChat 时把它抄错了
   * （地址那块写成 ['path']、本地路径那块写成 ['prompt','detail']），
   * 于是文档里"图片地址"被写成 path，真正的 path 反而没出现，且不报错。
   * tests/paramCards.test.ts 盯着 key 必须属于 spec.keys。
   */
  {
    type: 'custom',
    spec: { keys: ['url'], kind: 'text' },
    key: 'url',
    when: (d) => (d.imageSource ?? 'url') === 'url',
    render: renderImageUrl,
  },

  {
    type: 'custom',
    spec: { keys: ['path'], kind: 'text' },
    key: 'path',
    when: (d) => d.imageSource === 'file',
    render: renderImagePath,
  },

  {
    type: 'textarea',
    key: 'prompt',
    label: '识别要求',
    rows: 3,
    placeholder: defaultOcrPrompt(),
    hint: '留空用上面的默认提示（按原顺序输出，不解释）',
  },

  /* 与「大模型」节点共用同一张卡（见 nodes/paramCards.ts） */
  card('llm.detail'),

  {
    type: 'note',
    content: '输出可直接被下游引用，识别出的文字也能交给翻译节点继续处理。',
  },
];

/**
 * legacy：已并入「大模型」节点（用途选「图片识别」）。
 *
 * 标 legacy 而不是删掉，是因为老画布上还有这种节点 ——
 * 删掉会让它们变未知节点，卡片上的字段与 runner 全部失效。
 * 侧栏不再列出（registry 跳过 legacy），但老画布照常能打开运行。
 */
registerNode({
  type: 'ocr',
  dataKind: 'ocr',
  meta: {
    varGroups: ['llm-config'],
    legacy: true,
    label: '图片识别 OCR（旧）', color: '#f472b6', category: 'ai', idPrefix: 'ocr',
    sub: '已并入「大模型」节点 —— 新画布请用大模型节点，用途选「图片识别」' },
  create: (id, partial) => makeOcrNode(id, (partial ?? {}) as never).data,
  Canvas: OcrNode,
  fields: () => fields,
  run: runOcr,
});
