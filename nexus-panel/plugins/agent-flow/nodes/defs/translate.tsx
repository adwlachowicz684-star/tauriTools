import { makeTranslateNode } from '../../types';
import { TARGET_LANGS } from '../../engine/llm';
import TranslateNode from '../../components/TranslateNode';
import { LlmConfigPanel } from '../../components/inspectors/shared';
import {
  Field, VarBar, upstreamTokens, type FieldDef,
} from '../../components/inspectors/fields';
import { runTranslate } from '../../engine/runners/translate';
import { registerNode } from '../registry';

/**
 * 迁移到字段声明后的样子：除了「待翻译内容」要带上游变量插入按钮
 * （用 custom 逃生口），其余全是数据描述，没有一行布局 JSX。
 */
const fields: FieldDef[] = [
  {
    type: 'custom',
    spec: { keys: ['sourceLang', 'targetLang', 'credentialId'], kind: 'text' },
    render: (p) => (
      <LlmConfigPanel
        nodeId={p.node.id}
        cfg={p.d.llm as never}
        onChange={(id, patch) => p.patch(patch)}
        needVision={false}
        secretPolicy={p.secretPolicy}
        onChangeSecretPolicy={p.onChangeSecretPolicy}
      />
    ),
  },
  { type: 'credential', key: 'credentialId', credentialKind: 'translate' },

  {
    type: 'chips',
    key: 'targetLang',
    label: '目标语言',
    options: () => TARGET_LANGS.map((l) => ({ value: l.code, label: l.label })),
  },
  {
    // 选了预设语言时这行没必要出现，直接隐藏
    type: 'text',
    key: 'targetLang',
    label: '目标语言（自定义）',
    placeholder: '如「简练的文言文」',
    when: (d) => !TARGET_LANGS.some((l) => l.code === d.targetLang),
  },

  {
    type: 'text',
    key: 'sourceLang',
    label: '源语言',
    placeholder: '留空自动识别',
    toUI: (v) => (v === 'auto' ? '' : v),
    fromUI: (v) => (String(v).trim() || 'auto'),
    hint: '留空让模型自动判断；填了能减少误判（如「日语」）',
  },

  {
    type: 'custom',
    spec: { keys: ['text', 'glossary'], kind: 'textarea' },
    key: 'text',
    render: (p) => (
      <Field label="待翻译内容">
        <VarBar
          title="可引用："
          tokens={upstreamTokens(p.upstream, ['{{input}}'])}
          onInsert={(t) => p.onChange(String(p.d.text ?? '') + t)}
        />
        <textarea
          className="p-input"
          rows={8}
          value={String(p.d.text ?? '')}
          placeholder="要翻译的文本，或引用上游输出"
          onChange={(e) => p.onChange(e.target.value)}
        />
      </Field>
    ),
  },

  {
    type: 'textarea',
    key: 'glossary',
    label: '术语表（可选）',
    rows: 3,
    placeholder: 'GPU=图形处理器\nTransformer=变换器',
    hint: '每行一条「原文=译文」，保证专有名词译法一致',
  },

  {
    type: 'note',
    content: (
      <>
        模型被要求只输出译文，不含解释或代码块标记，结果可直接喂给下游。
      </>
    ),
  },
];

registerNode({
  type: 'translate',
  dataKind: 'translate',
  meta: {
    cardGroups: ['llm-config'],
    label: '翻译',
    color: '#38bdf8',
    category: 'ai',
    idPrefix: 'ty',
    sub: '需填自己的大模型 API Key',
  },
  create: (id, partial) => makeTranslateNode(id, (partial ?? {}) as never).data,
  Canvas: TranslateNode,
  fields: () => fields,
  run: runTranslate,
});
