import { makeCanvasRefNode } from '../../types';
import { CanvasRefNode } from '../../components/CanvasRefNode';
import { type FieldDef, type FieldRenderProps } from '../../components/inspectors/fields';
import { canvasRefOptions } from '../../engine/canvasRefName';
import { registerNode } from '../registry';

/**
 * 调用另一张画布。
 *
 * 执行时这张画布会被目标画布的内部节点替换 ——
 * 于是失败传播、跳过、并发这些既有规则自动生效，
 * 不需要为"跨画布"重写一套调度。
 *
 * 它是同步的：下游节点会等这张画布跑完再跑（拓扑排序天然保证）。
 */

/**
 * 字段是**函数**：下拉框的选项来自全部画布，而画布列表是运行时状态，
 * 写死成常量数组的话新建画布后这里不会更新。
 */
export const canvasRefFields = (_d: Record<string, unknown>, p?: FieldRenderProps): FieldDef[] => {
  const opts = canvasRefOptions(p?.canvases, p?.activeCanvasId);

  return [
    /*
     * 下拉框必须真的存在 ——
     *
     * 以前这里只有一个 note 写着"在下拉框里选要调用哪张画布"，
     * 而下拉框**根本没有实现**。于是这个节点拖出来就配不了：
     * canvasId 永远是空串，卡片上显示"还没选"，执行时也必然失败。
     * 而那句 note 让人以为只是自己没找到。
     */
    {
      type: 'select',
      key: 'canvasId',
      label: '调用哪张画布',
      hint: opts.length
        ? '这里不列出当前这张画布 —— 调自己会成环，整张图都跑不起来'
        : '没有其他画布可选：先在左侧画布库新建一张',
      options: opts,
    },
    {
      type: 'note',
      content: '被调用的画布可以用「画布输入 / 画布输出」节点自己定接口；不放这些节点时，接口会自动识别（没有上游的当入口、没有下游的当出口）。',
    },
    {
      type: 'text',
      key: 'displayName',
      label: '显示名（可留空）',
      hint: '留空则显示目标画布的名字并跟着改名；填了就以这里为准',
      placeholder: '例如：战斗数值主表',
    },
  ];
};

registerNode({
  type: 'canvasRef',
  dataKind: 'canvasRef',
  meta: {
    label: '调用画布', color: '#a78bfa', category: 'flow',
    idPrefix: 'cr', sub: '把另一张画布当一个节点用',
  },
  create: (id, partial) => makeCanvasRefNode(id, partial ?? {}).data,
  Canvas: CanvasRefNode,
  fields: canvasRefFields,
});
