import { makeUpdateNode, UPDATE_SOURCE_META, type UpdateNodeData } from '../../types';
import UpdateNode from '../../components/UpdateNode';
import { UpdateInspector } from '../../components/inspectors/UpdateInspector';
import { runUpdate } from '../../engine/runners/update';
import { registerNode } from '../registry';

/**
 * B站更新检测。
 *
 * 与 wechat 共用一个 data 类型（UpdateNodeData），靠 data.source 区分 ——
 * 两个源的字段差异只在「UID / Cookie」与「订阅地址」这两组上，
 * 其余（UA、超时、输出格式、基线）完全共用。
 * 注册成两个类型是历史决定（画布上要有各自的图标与配色），
 * 注册表按 node.type 分，正好容得下这种"同数据、多类型"。
 */
registerNode({
  type: 'bili',
  dataKind: 'update',
  meta: {
    label: UPDATE_SOURCE_META.bilibili.label,
    color: UPDATE_SOURCE_META.bilibili.color,
    category: 'external',
    idPrefix: 'bl',
  },
  create: (id, partial) =>
    makeUpdateNode(id, 'bilibili', (partial ?? {}) as Partial<UpdateNodeData>).data,
  Canvas: UpdateNode,
  Inspector: UpdateInspector,
  run: runUpdate,
});
