import { makeRetryNode } from '../../types';
import { RetryNode } from '../../components/ControlNode';
import type { FieldDef } from '../../components/inspectors/fields';
import { runRetry } from '../../engine/runners/retry';
import { registerNode } from '../registry';

/**
 * 重试 —— 上游成功了但内容不合格时，重跑它直到合格。
 *
 * 注意它做不到"上游失败也重试"：那种情况引擎在调度层就把本节点跳过了。
 */
const fields: FieldDef[] = [
  {
    type: 'text',
    key: 'target',
    label: '重试哪个节点',
    placeholder: '节点 id，如 h1',
    hint: '填要重跑的节点 id（卡片底部那行就是）',
  },
  {
    type: 'number',
    key: 'times',
    label: '最多重试几次',
    min: 0,
    max: 20,
    step: 1,
  },
  {
    type: 'number',
    key: 'intervalMs',
    label: '每次间隔',
    min: 0,
    step: 500,
    hint: '毫秒',
  },
  {
    type: 'select',
    key: 'check',
    label: '合格条件',
    options: [
      { value: 'nonempty', label: '非空', hint: '有内容就行' },
      { value: 'contains', label: '包含', hint: '含有指定文本' },
      { value: 'notContains', label: '不包含', hint: '不含指定文本（如响应里没有 error）' },
      { value: 'regex', label: '正则', hint: '用正则表达式匹配' },
    ],
  },
  {
    type: 'text',
    key: 'value',
    label: '比对值',
    placeholder: '要包含的文本 / 正则表达式',
    when: (d) => d.check !== 'nonempty',
  },
  {
    type: 'note',
    content: '上游**执行失败**时本节点不会运行（失败会沿边传播）。这里处理的是"跑成功了但内容不对"。',
  },
];

registerNode({
  type: 'retry',
  dataKind: 'retry',
  meta: {
    label: '重试',
    color: '#22d3ee',
    category: 'control',
    idPrefix: 'rt',
    sub: '上游内容不合格就重跑它',
  },
  create: (id, partial) => makeRetryNode(id, (partial ?? {}) as never).data,
  Canvas: RetryNode,
  fields: () => fields,
  run: runRetry,
});
