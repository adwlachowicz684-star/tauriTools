/*
 * ==================================================================
 * 参数卡片层
 *
 * ================= 为什么要有这一层 =================
 *
 * 以前"参数长什么样"是写在各节点自己的 fields 里的。
 * 于是同一个参数在几个节点上各写一遍 —— 扫描全仓库发现 16 组逐字重复，
 * 集中在"合并后旧节点还留着一份"：
 *
 *   beep / play-audio      path、volume、waitForEnd  三张卡逐字重复
 *   llmChat / translate    targetLang、sourceLang、glossary 四张卡逐字重复
 *   llmChat / ocr          detail 逐字重复
 *   llmChat / apiPane      jsonMode 逐字重复
 *   task / taskPane        yolo 逐字重复
 *
 * 重复本身不难看，难在**改一张漏三张**：
 *   改了「音量」的取值范围，只有新节点跟着变，旧节点仍是旧范围 ——
 *   不报错，两个节点并排看才发现不一样。
 *   这正是"合并节点"反复踩到的坑的另一种形状。
 *
 * 现在参数自成一层：**卡片在这里定义一次，节点只声明用哪几张**。
 * 节点是一层，参数是一层 —— 节点挑卡片，卡片不认识节点。
 *
 * ================= 用法 =================
 *
 *   fields: () => [
 *     card('sound.path', { when: (d) => d.source === 'file' }),
 *     card('sound.volume'),
 *   ]
 *
 * 第二个参数是**覆盖**，只写这一张卡在这个节点上的不同之处
 * （通常是 when / hint）。不写就完全是库里那张。
 *
 * ================= 什么时候不该抽 =================
 *
 * 只有**两个以上节点真的共用**才抽进来。
 * 只在一个节点出现的参数留在原地 —— 抽进来会让"改这个参数要翻两个文件"，
 * 而收益为零。tests/paramCards.test.ts 盯着这条：
 * 库里每张卡必须被两个以上节点使用，否则就是过度抽象。
 *
 * ==================================================================
 */
import type { FieldDef } from '../components/inspectors/fields';
import { TARGET_LANGS } from '../engine/llm';
import { SOUND_SOURCE_META, type SoundSource } from '../types';

/** 一张参数卡片：本质上就是一份 FieldDef（必须有 key） */
export type ParamCard = FieldDef & { key: string };

/**
 * 卡片库。键是"卡片 id"，命名是 `组.参数名`。
 *
 * 值写的是**完整的一份** FieldDef —— 让节点 `card()` 取到的
 * 就是可直接渲染的字段，不需要调用方再拼。
 */
export const PARAM_CARDS: Record<string, ParamCard> = {
  /* ---------------- 声音：beep（播放声音）与 play-audio（旧）共用 ------ */

  'sound.path': {
    type: 'text',
    key: 'path',
    label: '音频文件',
    placeholder: '/path/to/sound.mp3',
    hint: '支持模板，如 {{上游.output}}；建议 mp3 / wav / ogg',
  },

  'sound.volume': {
    type: 'number',
    key: 'volume',
    label: '音量',
    min: 0,
    max: 1,
    step: 0.1,
    /*
     * 默认值写进说明而不是塞进数据 ——
     * 老存档里没有 volume 字段，执行器按注释里的约定用 0.6。
     * 若这里改成"没填就报错"，老画布一打开就全是红点（见 runners/beep）。
     */
    hint: '0 ~ 1，默认 0.6',
  },

  'sound.waitForEnd': {
    type: 'switch',
    key: 'waitForEnd',
    label: '',
    placeholder: '播完再往下走（关掉则立即继续，声音继续放）',
  },

  /* ---------------- 大模型·翻译：llmChat 与 translate（旧）共用 -------- */

  'llm.targetLang': {
    type: 'chips',
    key: 'targetLang',
    label: '目标语言',
    options: () => TARGET_LANGS.map((l) => ({ value: l.code, label: l.label })),
  },

  /*
   * 选了预设语言时上面那排按钮已经够用，这一行就不出现 ——
   * 所以 when 是这张卡的**固有行为**，不是某个节点的特例。
   * 抽进来之前它在两个节点里各写了一遍，还带着同一句注释。
   */
  'llm.targetLangCustom': {
    type: 'text',
    key: 'targetLang',
    label: '目标语言（自定义）',
    placeholder: '如「简练的文言文」',
    when: (d) => !TARGET_LANGS.some((l) => l.code === d.targetLang),
  },

  'llm.sourceLang': {
    type: 'text',
    key: 'sourceLang',
    label: '源语言',
    placeholder: '留空自动识别',
    toUI: (v) => (v === 'auto' ? '' : v),
    fromUI: (v) => (String(v).trim() || 'auto'),
    hint: '留空让模型自动判断；填了能减少误判（如「日语」）',
  },

  'llm.glossary': {
    type: 'textarea',
    key: 'glossary',
    label: '术语表（可选）',
    rows: 3,
    placeholder: 'GPU=图形处理器\nTransformer=变换器',
    hint: '每行一条「原文=译文」，保证专有名词译法一致',
  },

  /* ---------------- 大模型·图片：llmChat 与 ocr（旧）共用 -------------- */

  'llm.detail': {
    type: 'select',
    key: 'detail',
    label: '图片细节',
    options: [
      { value: 'auto', label: '自动' },
      { value: 'low', label: '低（省 token）' },
      { value: 'high', label: '高（识别更准）' },
    ],
  },

  /* ---------------- 大模型·输出：llmChat 与 apiPane 共用 --------------- */

  'llm.jsonMode': {
    type: 'switch',
    key: 'jsonMode',
    label: '',
    placeholder: '要求结构化 JSON 输出',
    /*
     * 这句 hint 原本只有 API 任务窗格写了，大模型节点没有 ——
     * 同名的卡在不同节点上说明不一样，用户会以为是两个不同的开关。
     */
    hint: '不是所有模型都支持；不支持的会返回错误而不是悄悄返回普通文本',
  },

  /* ---------------- 内容判据：gate（闸门）与 retry（重试）共用 ---------- */

  /*
   * 「检查方式」的选项在两个节点里逐字重复 —— 只有标签不同
   * （闸门叫「条件」，重试叫「合格条件」，那是刻意的：
   *   闸门判"放不放行"，重试判"跑得对不对"，措辞本就不该一样）。
   *
   * 所以这张卡只带 options，label 由节点覆盖。
   */
  'cmp.check': {
    type: 'select',
    key: 'check',
    label: '条件',
    options: [
      { value: 'nonempty', label: '非空', hint: '有内容就行' },
      { value: 'contains', label: '包含', hint: '含有指定文本' },
      { value: 'notContains', label: '不包含', hint: '不含指定文本（如响应里没有 error）' },
      { value: 'regex', label: '正则', hint: '用正则表达式匹配' },
    ],
  },

  'cmp.value': {
    type: 'text',
    key: 'value',
    label: '比对值',
    placeholder: '要包含的文本 / 正则表达式',
    /*
     * 选了「非空」就没有比对值可填，这行不出现 ——
     * 与上面那张卡是一对，所以 when 也放进库里，不留在节点上。
     */
    when: (d) => d.check !== 'nonempty',
  },

  /* ---------------- CLI：task 与 taskPane 共用 ------------------------- */

  'cli.yolo': {
    type: 'switch',
    key: 'yolo',
    label: '',
    placeholder: '自动批准工具调用（-y）',
  },
};

/**
 * 取一张卡片，可带覆盖。
 *
 * 覆盖是**浅合并**：`when` / `hint` / `label` 这类整体替换，
 * 不做深合并 —— 深合并会让"想清掉 when"变成一件做不到的事
 * （传 undefined 会被 Object.assign 当成"没传"）。
 */
export function card(id: string, over?: Partial<FieldDef>): FieldDef {
  const base = PARAM_CARDS[id];
  if (!base) {
    /*
     * 不返回空对象了事 —— 那会让面板上凭空多出一个空字段，
     * 而且看不出是哪张卡拼错了。
     */
    throw new Error(`没有这张参数卡片：${id}`);
  }
  return over ? { ...base, ...over } : { ...base };
}

/**
 * 「声音来源」那张卡要的 when：只在来源是本地文件时出现。
 *
 * 单独抽出来是因为三个节点都要判断同一个条件，
 * 而 `d.source ?? 'preset'` 这个兜底写错一处就是"卡片该出现时不出现"。
 */
export function whenSoundFile(d: Record<string, unknown>): boolean {
  return (d.source ?? 'preset') === 'file';
}

/** 声音来源的说明文字（随当前来源变化） */
export function soundSourceHint(d: Record<string, unknown>): string {
  return SOUND_SOURCE_META[(d.source as SoundSource) ?? 'preset']?.hint ?? '';
}
