import { makeRetryNode } from '../../types';
import { RetryNode } from '../../components/ControlNode';
import type { FieldDef } from '../../components/inspectors/fields';
import { runRetry } from '../../engine/runners/retry';
import { registerNode } from '../registry';
import { card } from '../paramCards';

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
  /*
   * 这两张与「闸门」节点共用（见 nodes/paramCards.ts）。
   * 选项完全一致，只有标签不同 —— 闸门叫「条件」，重试叫「合格条件」，
   * 那是刻意的：一个判放不放行，一个判跑得对不对。
   */
  card('cmp.check', { label: '合格条件' }),
  card('cmp.value'),
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
});
