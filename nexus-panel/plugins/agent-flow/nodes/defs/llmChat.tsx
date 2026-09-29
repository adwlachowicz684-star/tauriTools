import {
  makeLlmChatNode, LLM_USE_META, defaultOcrPrompt,
  type LlmUse,
} from '../../types';
import { TARGET_LANGS } from '../../engine/llm';
import LlmChatNode from '../../components/LlmChatNode';
import { LlmConfigPanel } from '../../components/inspectors/shared';
import {
  Field, VarBar, upstreamTokens, paneField,
  type FieldDef, type FieldRenderProps,
} from '../../components/inspectors/fields';
import { runLlmChat } from '../../engine/runners/llmChat';
import { registerNode } from '../registry';
import { card } from '../paramCards';
import { renderImageUrl, renderImagePath } from '../imageCards';

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

    /*
     * 与旧 OCR 节点共用同一张卡（见 nodes/paramCards.ts）。
     * 差别只有"用途是图片识别时才出现"，那是这个节点的事，写在覆盖里。
     */
    card('llm.imageSource', { when: () => isOcr }),

    /*
     * 这两块的 render 与旧的 OCR 节点共用（见 nodes/imageCards.tsx）。
     * 与 ocr 只差一个 when —— 大模型节点上它们还要看用途是不是图片识别。
     */
    {
      type: 'custom',
      spec: { keys: ['url'], kind: 'text' },
      key: 'url',
      when: (d) => isOcr && (d.imageSource ?? 'url') === 'url',
      render: renderImageUrl,
    },

    {
      type: 'custom',
      spec: { keys: ['path'], kind: 'text' },
      key: 'path',
      when: (d) => isOcr && d.imageSource === 'file',
      render: renderImagePath,
    },

    /* 与旧的 OCR 节点共用同一张卡（见 nodes/paramCards.ts） */
    card('llm.detail', { when: () => isOcr }),

    /*
     * ---- 翻译：目标/源语言 + 术语表 ----
     *
     * 与旧的 translate 节点共用同一批卡片（见 nodes/paramCards.ts）。
     * 这里的覆盖只有 when —— 大模型节点上这几项只在用途=翻译时出现；
     * 卡片本身（含"选了预设语言就隐藏自定义那行"）在库里定义一次。
     */
    card('llm.targetLang', { when: () => isTrans }),
    card('llm.targetLangCustom', {
      when: (d) => isTrans && !TARGET_LANGS.some((l) => l.code === d.targetLang),
    }),
    card('llm.sourceLang', { when: () => isTrans }),
    card('llm.glossary', { when: () => isTrans }),

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
            tokens={upstreamTokens(pp)}
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

    /* 与 API 任务窗格共用同一张卡（见 nodes/paramCards.ts） */
    card('llm.jsonMode'),

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
    /*
     * 合并时漏了这一行 —— ocr / translate 都声明了 llm-config 变量组，
     * 合并后的大模型节点却没有。
     *
     * 后果是双份的，且都不报错：
     *   · 属性面板不渲染模型变量选择器（fields.tsx 按 meta.varGroups 渲染）
     *   · 把模型变量拖到这个节点上会被**明确拒绝**（App 里 checkVarForNode
     *     按同一份 meta.varGroups 判定，会弹「这个变量用不上」）
     *
     * 于是"几个节点共用一份模型配置"这个能力，在推荐节点上反而用不了，
     * 只有在被标 legacy 的老节点上还能用 —— 正是合并漏挂的典型症状。
     */
    varGroups: ['llm-config'],
  },
  create: (id, partial) => makeLlmChatNode(id, (partial ?? {}) as never).data,
  Canvas: LlmChatNode,
  fields,
  run: runLlmChat,
});
