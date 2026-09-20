import { makeExtractNode, EXTRACT_MODE_META, type ExtractMode } from '../../types';
import { ExtractCard } from '../../components/GenericNode';
import type { FieldDef } from '../../components/inspectors/fields';
import { runExtract } from '../../engine/runners/extract';
import { registerNode } from '../registry';

/** 各模式下 spec 输入框里该显示什么例子 */
const SPEC_SAMPLE: Record<ExtractMode, string> = {
  json: 'data.items[0].title',
  regex: '标题[:：]\\s*(.+)',
  line: 'first',
  text: '',
};

/**
 * 数据提取节点。
 *
 * spec 这个字段在四种模式下含义不同（路径 / 正则 / 行规则 / 不用），
 * 标签、占位、说明都由 EXTRACT_MODE_META + SPEC_SAMPLE 按当前模式给出 ——
 * 加一种模式只要改这两张表，不用动面板。
 */
const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'mode',
    label: '提取方式',
    options: () =>
      (Object.keys(EXTRACT_MODE_META) as ExtractMode[]).map((k) => ({
        value: k,
        label: EXTRACT_MODE_META[k].label,
      })),
  },
  {
    type: 'text',
    key: 'spec',
    // 原样输出不需要参数，填了也没用 —— 直接不显示，少一个困惑源
    when: (d) => d.mode !== 'text',
    label: (d) => EXTRACT_MODE_META[d.mode as ExtractMode]?.spec ?? '参数',
    placeholder: (d) => SPEC_SAMPLE[d.mode as ExtractMode] ?? '',
    hint: (d) => EXTRACT_MODE_META[d.mode as ExtractMode]?.hint ?? '',
  },
  {
    type: 'number',
    key: 'group',
    label: '第几个捕获组',
    min: 0,
    max: 9,
    inline: true,
    hint: '0 取整段匹配，1 取第一个括号',
    when: (d) => d.mode === 'regex',
  },
  { type: 'switch', key: 'trim', label: '', placeholder: '去掉首尾空白' },
  {
    type: 'switch',
    key: 'failOnMiss',
    label: '',
    placeholder: '取不到就失败',
    hint: '关掉则输出空串、流程继续（原因仍记在日志里）',
  },
  {
    type: 'note',
    content: '把上游的一大段文本（典型是 HTTP 响应）裁成一条值，供条件节点判断或下游引用。',
  },
];

registerNode({
  type: 'extract',
  dataKind: 'extract',
  meta: {
    label: '数据提取',
    color: '#38bdf8',
    category: 'data',
    idPrefix: 'ex',
    sub: '从上游内容里抠出想要的那个值',
  },
  create: (id, partial) => makeExtractNode(id, (partial ?? {}) as never).data,
  Canvas: ExtractCard,
  fields: () => fields,
  run: runExtract,
});
