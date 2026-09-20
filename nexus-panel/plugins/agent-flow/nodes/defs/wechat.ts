import { makeUpdateNode, UPDATE_SOURCE_META, type UpdateNodeData } from '../../types';
import UpdateNode from '../../components/UpdateNode';
import { runUpdate } from '../../engine/runners/update';
import { registerNode } from '../registry';
import { updateFields, updateFooter } from './updateFields';

/**
 * 与 wechat 共用一份 data（kind='update'）与字段清单，靠 data.source 区分。
 * 注册成两个 type 是为了在画布上有各自的图标与配色。
 */
registerNode({
  type: 'wechat',
  dataKind: 'update',
  meta: {
    label: UPDATE_SOURCE_META.wechat.label,
    color: UPDATE_SOURCE_META.wechat.color,
    category: 'external',
    idPrefix: 'wx',
    sub: UPDATE_SOURCE_META.wechat.hint,
  },
  create: (id, partial) =>
    makeUpdateNode(id, 'wechat', (partial ?? {}) as Partial<UpdateNodeData>).data,
  Canvas: UpdateNode,
  fields: () => updateFields,
  panelFooter: updateFooter,
  run: runUpdate,
});
