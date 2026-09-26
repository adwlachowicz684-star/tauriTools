import {
  makeLlmChatNode, IMAGE_SOURCE_META, LLM_USE_META, defaultOcrPrompt,
  type ImageSource, type LlmUse,
} from '../../types';
import { TARGET_LANGS } from '../../engine/llm';
import { canReadImage } from '../../lib/tauri';
import LlmChatNode from '../../components/LlmChatNode';
import { LlmConfigPanel } from '../../components/inspectors/shared';
import {
  Field, VarBar, upstreamTokens, upstreamFileTokens, paneField,
  type FieldDef, type FieldRenderProps,
} from '../../components/inspectors/fields';
import { runLlmChat } from '../../engine/runners/llmChat';
import { registerNode } from '../registry';

/**
 * 大模型节点 —— 一个节点覆盖三种用途。
 *
 * 图片识别与翻译原本是**两个独立节点**，但它们与「自由对话」的差别
 * 只在消息的拼法（system 写死 vs 两段都自己写），而请求构造、响应解析、
 * 错误提示三处逐字相同 —— 分成三个节点后改一处要改三遍，漏一处就是
 * "这个节点还是旧行为，且不报错"。
 *
 * 所以合并成一个节点，用「用途」切换。老的 ocr / translate 节点标了
 * legacy（侧栏不再列出，老画布照常能打开运行），不删是为了不让
 * 老画布上的节点变未知节点。
 */

const USES = Object.keys(LLM_USE_META) as LlmUse[];

/**
 * 字段写成**函数**：窗格下拉框的选项来自画布上的窗格节点，
 * 那是运行时状态，写死成常量数组的话新建窗格后这里不会更新。
 */
const fields = (_d: Record<string, unknown>, p?: FieldRenderProps): FieldDef[] => {
  const use: LlmUse = (_d.use as LlmUse) ?? 'chat';
  const isOcr = use === 'ocr';
  const isTrans = use === 'translate';
  const isChat = use === 'chat';

  return [
    {
      type: 'select',
      key: 'use',
      label: '用途',
      options: USES.map((k) => ({ value: k, label: LLM_USE_META[k].label })),
      hint: (d) => LLM_USE_META[((d.use as LlmUse) ?? 'chat')]?.hint,
    },

    {
      type: 'custom',
      spec: { keys: ['model', 'credentialId', 'llm'], kind: 'select' },
      key: 'model',
      render: (pp) => (
        <LlmConfigPanel
          cfg={pp.d.llm as never}
          /*
           * 只有图片识别才要求视觉模型。
           * 不传的话自由对话也会把非视觉模型标成"不支持图片"，
           * 那是**误报** —— 用户会照着提示去换一个本来能用的模型。
           */
          needVision={(pp.d.use as LlmUse) === 'ocr'}
          onChange={pp.patch}
          credentials={pp.credentials}
          credentialId={pp.d.credentialId as string}
          onOpenCredentials={pp.onOpenCredentials}
        />
      ),
    },

    paneField('apiPane', p?.nodes),

    /* ---- 图片识别：来源 + 地址/路径 ---- */
    {
      type: 'select',
      key: 'imageSource',
      label: '图片来源',
      when: () => isOcr,
      options: () =>
        (Object.keys(IMAGE_SOURCE_META) as ImageSource[]).map((k) => ({
          value: k,
          label: IMAGE_SOURCE_META[k].label,
        })),
      hint: (d) => IMAGE_SOURCE_META[(d.imageSource as ImageSource) ?? 'url']?.hint,
    },

    {
      type: 'custom',
      spec: { keys: ['url'], kind: 'text' },
      key: 'url',
      when: (d) => isOcr && (d.imageSource ?? 'url') === 'url',
      render: (pp) => (
        <Field label="图片地址">
          <VarBar
            title="可引用："
            tokens={upstreamTokens(pp.upstream)}
            onInsert={(t) => pp.onChange(String(pp.d.url ?? '') + t)}
          />
          <input
            className="p-input mono"
            value={String(pp.d.url ?? '')}
            placeholder="https://.../image.png"
            onChange={(e) => pp.onChange(e.target.value)}
          />
        </Field>
      ),
    },

    {
      type: 'custom',
      spec: { keys: ['path'], kind: 'text' },
      key: 'path',
      when: (d) => isOcr && d.imageSource === 'file',
      render: (pp) => (
        <Field
          label="本地路径"
          hint={!canReadImage() ? '浏览器模式不能读本地图片，请用桌面端运行' : undefined}
        >
          <VarBar
            title="可引用："
            tokens={upstreamFileTokens(pp.upstream).filter((t) => t.text.endsWith('.file}}'))}
            onInsert={(t) => pp.onChange(String(pp.d.path ?? '') + t)}
          />
          <input
            className="p-input mono"
            value={String(pp.d.path ?? '')}
            placeholder="/path/to/screenshot.png"
            onChange={(e) => pp.onChange(e.target.value)}
          />
        </Field>
      ),
    },

    {
      type: 'select',
      key: 'detail',
      label: '图片细节',
      when: () => isOcr,
      options: [
        { value: 'auto', label: '自动' },
        { value: 'low', label: '低（省 token）' },
        { value: 'high', label: '高（识别更准）' },
      ],
    },

    /* ---- 翻译：目标/源语言 + 术语表 ---- */
    {
      type: 'chips',
      key: 'targetLang',
      label: '目标语言',
      when: () => isTrans,
      options: () => TARGET_LANGS.map((l) => ({ value: l.code, label: l.label })),
    },
    {
      // 选了预设语言时这行没必要出现，直接隐藏
      type: 'text',
      key: 'targetLang',
      label: '目标语言（自定义）',
      when: (d) => isTrans && !TARGET_LANGS.some((l) => l.code === d.targetLang),
      placeholder: '如「简练的文言文」',
    },
    {
      type: 'text',
      key: 'sourceLang',
      label: '源语言',
      when: () => isTrans,
      placeholder: '留空自动识别',
      toUI: (v) => (v === 'auto' ? '' : v),
      fromUI: (v) => (String(v).trim() || 'auto'),
      hint: '留空让模型自动判断；填了能减少误判（如「日语」）',
    },
    {
      type: 'textarea',
      key: 'glossary',
      label: '术语表（可选）',
      when: () => isTrans,
      rows: 3,
      placeholder: 'GPU=图形处理器\nTransformer=变换器',
      hint: '每行一条「原文=译文」，保证专有名词译法一致',
    },

    /* ---- 自由对话：角色提示词 ---- */
    {
      type: 'textarea',
      key: 'system',
      label: '角色提示词（system）',
      when: () => isChat,
      rows: 3,
      placeholder: '留空用所属任务窗格那一份',
      hint: '填了就以这里为准；没填且挂了窗格，则用窗格的角色设定',
    },

    /* ---- 三种用途共用的主输入 ---- */
    {
      type: 'custom',
      spec: { keys: ['prompt'], kind: 'textarea' },
      key: 'prompt',
      render: (pp) => (
        <Field label={labelOfPrompt((pp.d.use as LlmUse) ?? 'chat')}>
          <VarBar
            title="可引用："
            tokens={upstreamTokens(pp.upstream, ['{{input}}'])}
            onInsert={(t) => pp.onChange(String(pp.d.prompt ?? '') + t)}
          />
          <textarea
            className="p-input"
            rows={6}
            value={String(pp.d.prompt ?? '')}
            placeholder={placeholderOfPrompt((pp.d.use as LlmUse) ?? 'chat')}
            onChange={(e) => pp.onChange(e.target.value)}
          />
        </Field>
      ),
    },

    /*
     * 温度只在自由对话下有意义：图片识别与翻译在 runner 里写死
     * （0 / 0.2），显示这一栏会让人以为调了有用 —— 那是**假控件**。
     */
    {
      type: 'number',
      key: 'temperature',
      label: '温度',
      when: () => isChat,
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

    {
      type: 'note',
      content: noteOf(use),
    },
  ];
};

/**
 * 主输入框的标签随用途变。
 *
 * 三种用途填的是同一个字段（prompt），但说"要问的内容"时用户在翻译
 * 模式下会不知道该填什么 —— 而这一栏在翻译模式下就是「待翻译内容」。
 */
function labelOfPrompt(use: LlmUse): string {
  if (use === 'translate') return '待翻译内容';
  if (use === 'ocr') return '识别要求';
  return '要问的内容';
}

function placeholderOfPrompt(use: LlmUse): string {
  if (use === 'translate') return '要翻译的文本，或引用上游输出';
  if (use === 'ocr') return defaultOcrPrompt();
  return '交给模型的内容，支持 {{上游.output}}';
}

function noteOf(use: LlmUse): string {
  if (use === 'ocr') {
    return '识别出的文字可直接被下游引用；切到「翻译」还能接着翻成别的语言。';
  }
  if (use === 'translate') {
    return '模型被要求只输出译文，不含解释或代码块标记，结果可直接喂给下游。';
  }
  return '输出可直接被下游引用，也能接一个翻译用途的节点继续处理。';
}

registerNode({
  type: 'llmChat',
  dataKind: 'llmChat',
  meta: {
    label: '大模型',
    color: '#38bdf8',
    category: 'ai',
    idPrefix: 'lc',
    sub: '调一次大模型：自由对话 / 图片识别 / 翻译',
  },
  create: (id, partial) => makeLlmChatNode(id, (partial ?? {}) as never).data,
  Canvas: LlmChatNode,
  fields,
  run: runLlmChat,
});
