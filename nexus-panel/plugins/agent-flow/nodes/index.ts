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
/**
 * 卡片组必须先于节点注册：BaseInspector 渲染面板时会按
 * def.meta.varGroups 去查组定义（取 label / keys / summary），
 * 组没注册就查不到，选择器渲染不出来。
 */
import { registerBuiltinVariableGroups } from './variableGroups';
registerBuiltinVariableGroups();

import './defs/task';
import './defs/genericHttp';
import './defs/extract';
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
/* 工具节点：等待 / 日志 / 提示音 / 播放音频 / 当前时间 / 常量 */
import './defs/wait';
import './defs/log';
import './defs/beep';
import './defs/playAudio';
import './defs/clock';
import './defs/const';
import './defs/module';
import './defs/wechat';
/* ---- 控制器 ---- */
import './defs/math';
import './defs/text';
import './defs/compare';
import './defs/random';
import './defs/var';
import './defs/stop';
import './defs/ask';
import './defs/canvasRef';
import './defs/canvasIn';
import './defs/canvasOut';
import './defs/tableRead';
import './defs/derive';
import './defs/filter';
import './defs/agg';
import './defs/join';
import './defs/gate';
import './defs/throttle';
import './defs/timeout';
import './defs/retry';

export {
  registerNode, getDef, hasDef, allDefs, allPresets, presetsByCategory, buildNodeTypes,
} from './registry';
export type { NodeDef, NodePreset, NodeMeta, NodeCategory, NodeInspectorProps } from './types';
export { NODE_CATEGORY_META } from './types';
export {
  getVariableGroup, allVariableGroups, checkVarForNode, patchForVar,
} from '../engine/variables';
