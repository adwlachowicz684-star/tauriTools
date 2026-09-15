/**
 * 节点注册表入口。
 *
 * 新增一种节点：
 *   1. 在 defs/ 下写一个文件，调 registerNode(...) 声明它的
 *      元信息、默认数据、画布组件、属性面板与执行器
 *   2. 在下面这个列表里 import 它
 *
 * 其余地方（侧栏、画布、属性面板、执行引擎）都从注册表读，不用改。
 * 删一种节点：删掉它的 def 文件与这里的 import 即可，
 * 历史画布里残留的该类型节点会退化成"未注册"占位，不会白屏。
 */
import './defs/task';
import './defs/trigger';
import './defs/condition';
import './defs/parallel';
import './defs/loop';
import './defs/fs';
import './defs/ocr';
import './defs/translate';
import './defs/github_update';
import './defs/github_push';
import './defs/bili';
import './defs/wechat';

export {
  registerNode, getDef, hasDef, allDefs, allPresets, presetsByCategory, buildNodeTypes,
} from './registry';
export type { NodeDef, NodePreset, NodeMeta, NodeCategory, NodeInspectorProps } from './types';
export { NODE_CATEGORY_META } from './types';
