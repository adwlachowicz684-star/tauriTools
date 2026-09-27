import { makeTranslateNode } from '../../types';
import TranslateNode from '../../components/TranslateNode';
import { LlmConfigPanel } from '../../components/inspectors/shared';
import {
  Field, VarBar, upstreamTokens, type FieldDef,
} from '../../components/inspectors/fields';
import { runTranslate } from '../../engine/runners/translate';
import { registerNode } from '../registry';
import { card } from '../paramCards';

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
        cfg={p.d.llm as never}
        onChange={p.patch}
        needVision={false}
      />
    ),
  },
  { type: 'credential', key: 'credentialId', credentialKind: 'translate' },

  /* 与「大模型」节点共用同一批翻译卡片（见 nodes/paramCards.ts） */
  card('llm.targetLang'),
  card('llm.targetLangCustom'),
  card('llm.sourceLang'),

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

  card('llm.glossary'),

  {
    type: 'note',
    content: (
      <>
        模型被要求只输出译文，不含解释或代码块标记，结果可直接喂给下游。
      </>
    ),
  },
];

/**
 * legacy：已并入「大模型」节点（用途选「翻译」）。
 *
 * 标 legacy 而不是删掉，是因为老画布上还有这种节点 ——
 * 删掉会让它们变未知节点。侧栏不再列出，老画布照常能打开运行。
 */
registerNode({
  type: 'translate',
  dataKind: 'translate',
  meta: {
    varGroups: ['llm-config'],
    legacy: true,
    label: '翻译（旧）',
    color: '#38bdf8',
    category: 'ai',
    idPrefix: 'ty',
    sub: '已并入「大模型」节点 —— 新画布请用大模型节点，用途选「翻译」',
  },
  create: (id, partial) => makeTranslateNode(id, (partial ?? {}) as never).data,
  Canvas: TranslateNode,
  fields: () => fields,
  run: runTranslate,
});
