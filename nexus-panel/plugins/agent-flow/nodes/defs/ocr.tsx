import { makeOcrNode, IMAGE_SOURCE_META, defaultOcrPrompt, type ImageSource } from '../../types';
import { canReadImage } from '../../lib/tauri';
import OcrNode from '../../components/OcrNode';
import { LlmConfigPanel } from '../../components/inspectors/shared';
import {
  Field, VarBar, upstreamTokens, upstreamFileTokens, type FieldDef,
} from '../../components/inspectors/fields';
import { runOcr } from '../../engine/runners/ocr';
import { registerNode } from '../registry';

const fields: FieldDef[] = [
  {
    type: 'custom',
    render: (p) => (
      <LlmConfigPanel
        nodeId={p.node.id}
        cfg={p.d.llm as never}
        onChange={(id, patch) => p.patch(patch)}
        needVision
        secretPolicy={p.secretPolicy}
        onChangeSecretPolicy={p.onChangeSecretPolicy}
      />
    ),
  },
  { type: 'credential', key: 'credentialId', credentialKind: 'ocr' },

  {
    type: 'select',
    key: 'imageSource',
    label: '图片来源',
    options: () =>
      (Object.keys(IMAGE_SOURCE_META) as ImageSource[]).map((k) => ({
        value: k,
        label: IMAGE_SOURCE_META[k].label,
      })),
    hint: (d) => IMAGE_SOURCE_META[(d.imageSource as ImageSource) ?? 'url']?.hint,
  },

  {
    type: 'custom',
    key: 'url',
    when: (d) => (d.imageSource ?? 'url') === 'url',
    render: (p) => (
      <Field label="图片地址">
        <VarBar
          title="可引用："
          tokens={upstreamTokens(p.upstream)}
          onInsert={(t) => p.onChange(String(p.d.url ?? '') + t)}
        />
        <input
          className="p-input mono"
          value={String(p.d.url ?? '')}
          placeholder="https://.../image.png"
          onChange={(e) => p.onChange(e.target.value)}
        />
      </Field>
    ),
  },

  {
    type: 'custom',
    key: 'path',
    when: (d) => d.imageSource === 'file',
    render: (p) => (
      <Field
        label="本地路径"
        hint={!canReadImage() ? '浏览器模式不能读本地图片，请用桌面端运行' : undefined}
      >
        <VarBar
          title="可引用："
          tokens={upstreamFileTokens(p.upstream).filter((t) => t.text.endsWith('.file}}'))}
          onInsert={(t) => p.onChange(String(p.d.path ?? '') + t)}
        />
        <input
          className="p-input mono"
          value={String(p.d.path ?? '')}
          placeholder="/path/to/screenshot.png"
          onChange={(e) => p.onChange(e.target.value)}
        />
      </Field>
    ),
  },

  {
    type: 'textarea',
    key: 'prompt',
    label: '识别要求',
    rows: 3,
    placeholder: defaultOcrPrompt(),
    hint: '留空用上面的默认提示（按原顺序输出，不解释）',
  },

  {
    type: 'select',
    key: 'detail',
    label: '图片细节',
    options: [
      { value: 'auto', label: '自动' },
      { value: 'low', label: '低（省 token）' },
      { value: 'high', label: '高（识别更准）' },
    ],
  },

  {
    type: 'note',
    content: '输出可直接被下游引用，识别出的文字也能交给翻译节点继续处理。',
  },
];

registerNode({
  type: 'ocr',
  dataKind: 'ocr',
  meta: { label: '图片识别 OCR', color: '#f472b6', category: 'ai', idPrefix: 'ocr' },
  create: (id, partial) => makeOcrNode(id, (partial ?? {}) as never).data,
  Canvas: OcrNode,
  fields: () => fields,
  run: runOcr,
});
