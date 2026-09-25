import { makeFrameNode } from '../../types';
import { FrameNode } from '../../components/FrameNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { registerNode } from '../registry';

/**
 * 组合框。
 *
 * 它不是从侧栏拖出来的 —— 组合框靠画布上选中若干节点后「组合」生成。
 * 这里注册它是为了：
 *   · 画布 nodeTypes 里有 'frame'，否则画布上会渲染成"未注册"占位
 *   · 属性面板有对应定义可查（改名字）
 *
 * presets 给空数组 = 侧栏不列这一项。
 * 列出来的话，拖一个"空框"进来框不住任何东西，
 * 而它看着和真节点一样可拖，用户会以为是自己不会用。
 *
 * 没有 run：组合框不参与执行（执行前会被滤掉，见 App 的 runNodes）。
 */
const fields: FieldDef[] = [
  {
    type: 'note',
    content: '组合框只用于画图与整体挪动，不参与执行。选中框 = 选中里面所有节点；选中里面的某一个节点 = 只选中它。',
  },
  { key: 'label', label: '名称', type: 'text', placeholder: '组合' },
];

registerNode({
  type: 'frame',
  dataKind: 'frame',
  meta: {
    label: '组合框',
    color: '#64748b',
    category: 'tools',
    idPrefix: 'fr',
    sub: '把若干节点框成一组',
    presets: () => [],
  },
  create: (id, partial) => makeFrameNode(id, (partial ?? {}) as never).data,
  Canvas: FrameNode,
  fields: () => fields,
});
