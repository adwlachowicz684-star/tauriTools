import { makeUpdateNode, UPDATE_SOURCE_META, type UpdateNodeData } from '../../types';
import UpdateNode from '../../components/UpdateNode';
import { UpdateInspector } from '../../components/inspectors/UpdateInspector';
import { runUpdate } from '../../engine/runners/update';
import { registerNode } from '../registry';

/** 公众号更新检测。与 bili 共用 data 类型，见 bili.ts 的说明 */
registerNode({
  type: 'wechat',
  dataKind: 'update',
  meta: {
    label: UPDATE_SOURCE_META.wechat.label,
    color: UPDATE_SOURCE_META.wechat.color,
    category: 'external',
    idPrefix: 'wx',
  },
  create: (id, partial) =>
    makeUpdateNode(id, 'wechat', (partial ?? {}) as Partial<UpdateNodeData>).data,
  Canvas: UpdateNode,
  Inspector: UpdateInspector,
  run: runUpdate,
});
