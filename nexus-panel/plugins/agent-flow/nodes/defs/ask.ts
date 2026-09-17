import { makeAskNode } from '../../types';
import { OpNode } from '../../components/OpNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runAsk } from '../../engine/runners/ops';
import { registerNode } from '../registry';

/**
 * 人工输入 —— 跑到这儿停下来等人填。
 *
 * 自动化里"需要人确认""需要人补一个参数"很常见，
 * 而且比事后翻日志再重跑有用得多。
 */
const fields: FieldDef[] = [
  {
    type: 'textarea',
    key: 'prompt',
    label: '提示语',
    rows: 3,
    placeholder: '如：请确认这个标题是否合适',
    hint: '支持模板，可以把上游内容显示给人看',
  },
  { type: 'text', key: 'value', label: '预填内容', placeholder: '可留空' },
  {
    type: 'switch',
    key: 'required',
    label: '必填',
    hint: '勾上时，没填内容会算失败',
  },
  {
    type: 'note',
    content: '运行到这里会弹框等待。取消或环境不支持会明确失败，不会静默跳过。',
  },
];

registerNode({
  type: 'ask',
  dataKind: 'ask',
  meta: { label: '人工输入', color: '#ff9f0a', category: 'control', idPrefix: 'ak', sub: '停下来等人填内容' },
  create: (id, partial) => makeAskNode(id, partial ?? {}).data,
  Canvas: OpNode,
  fields: () => fields,
  run: runAsk,
});
