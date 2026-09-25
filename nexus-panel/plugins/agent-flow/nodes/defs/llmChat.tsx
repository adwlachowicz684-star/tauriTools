import { makeLlmChatNode } from '../../types';
import LlmChatNode from '../../components/LlmChatNode';
import { LlmConfigPanel } from '../../components/inspectors/shared';
import {
  Field, VarBar, upstreamTokens, paneField, type FieldDef, type FieldRenderProps,
} from '../../components/inspectors/fields';
import { runLlmChat } from '../../engine/runners/llmChat';
import { registerNode } from '../registry';

/**
 * 大模型 API 节点 —— 直接调一次大模型。
 *
 * 与 OCR / 翻译节点的差别只在"消息怎么拼"：
 * 那两个把消息写死了（必须带图 / 必须带目标语言），
 * 这个节点把 system 与 user 两段都交给用户，是最通用的那一档。
 *
 * 请求构造、响应解析、错误提示则与它们完全一致 ——
 * 复用 engine/llm 那一套，不另写第二份。
 */

/**
 * 字段写成**函数**：窗格下拉框的选项来自画布上的窗格节点，
 * 那是运行时状态，写死成常量数组的话新建窗格后这里不会更新。
 */
const fields = (_d: Record<string, unknown>, p?: FieldRenderProps): FieldDef[] => [
  {
    type: 'custom',
    spec: { keys: ['model', 'credentialId', 'llm'], kind: 'select' },
    key: 'model',
    render: (pp) => (
      <LlmConfigPanel
        cfg={pp.d.llm as never}
        needVision={false}
        onChange={pp.patch}
        credentials={pp.credentials}
        credentialId={pp.d.credentialId as string}
        onOpenCredentials={pp.onOpenCredentials}
      />
    ),
  },

  paneField('apiPane', p?.nodes),

  {
    type: 'textarea',
    key: 'system',
    label: '角色提示词（system）',
    rows: 3,
    placeholder: '留空用所属任务窗格那一份',
    hint: '填了就以这里为准；没填且挂了窗格，则用窗格的角色设定',
  },

  {
    type: 'custom',
    spec: { keys: ['prompt'], kind: 'textarea' },
    key: 'prompt',
    render: (pp) => (
      <Field label="要问的内容">
        <VarBar
          title="可引用："
          tokens={upstreamTokens(pp.upstream, ['{{input}}'])}
          onInsert={(t) => pp.onChange(String(pp.d.prompt ?? '') + t)}
        />
        <textarea
          className="p-input"
          rows={6}
          value={String(pp.d.prompt ?? '')}
          placeholder="交给模型的内容，支持 {{上游.output}}"
          onChange={(e) => pp.onChange(e.target.value)}
        />
      </Field>
    ),
  },

  {
    type: 'number',
    key: 'temperature',
    label: '温度',
    min: 0,
    max: 2,
    step: 0.1,
    placeholder: '留空用窗格的，再没有则 0.3',
    hint: '越低越稳定，越高越发散',
  },

  {
    type: 'number',
    key: 'maxTokens',
    label: '最大输出 token',
    min: 0,
    step: 1,
    placeholder: '留空不限制',
  },

  {
    type: 'switch',
    key: 'jsonMode',
    label: '',
    placeholder: '要求结构化 JSON 输出',
  },
];

registerNode({
  type: 'llmChat',
  dataKind: 'llmChat',
  meta: {
    label: '大模型',
    color: '#38bdf8',
    category: 'ai',
    idPrefix: 'lc',
    sub: '直接调一次大模型，自己写提示词',
  },
  create: (id, partial) => makeLlmChatNode(id, (partial ?? {}) as never).data,
  Canvas: LlmChatNode,
  fields,
  run: runLlmChat,
});
