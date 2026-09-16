import { makeModuleNode } from '../../types';
import { ModuleNode } from '../../components/ModuleNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { registerNode } from '../registry';

/**
 * 模块节点。
 *
 * 它不是从侧栏"节点库"里拖的 —— 模块从模块库拖。
 * 这里注册它是为了：
 *   · 画布 nodeTypes 里有 'module'，否则画布上会渲染成"未注册"占位
 *   · 属性面板有对应定义可查（label / color / 分组）
 *
 * meta.hidden 让它不出现在节点库的分组列表里（具体的过滤在侧栏做）。
 */
const fields: FieldDef[] = [
  {
    type: 'note',
    content: '模块的内部结构在右侧「编辑内部」里改。改模块库会让所有实例跟着变；改这个实例会让它脱钩成独立副本。',
  },
];

registerNode({
  type: 'module',
  dataKind: 'module',
  meta: {
    label: '模块',
    color: '#f59e0b',
    category: 'tools',
    idPrefix: 'm',
    sub: '多个节点打包复用',
  },
  create: (id, partial) => makeModuleNode(id, (partial ?? {}) as never).data,
  Canvas: ModuleNode,
  fields: () => fields,
});
