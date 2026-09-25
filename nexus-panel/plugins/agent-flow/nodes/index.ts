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
/*
 * 大模型 API 节点与两种任务窗格。
 *
 * 窗格必须先于引用它的节点注册吗 —— 不需要：
 * 窗格不决定节点的解析方式，节点只是存了一个 paneId，
 * 运行时按 id 去找，找不着就当没挂窗格。
 */
import './defs/llmChat';
import './defs/taskPane';
import './defs/apiPane';
import './defs/github_update';
import './defs/github_push';
/*
 * 合并后的「更新检测」必须先于 bili / wechat 注册：
 * 三者共用 dataKind 'update'，而 getDefByDataKind 取**先注册**的那一份。
 * 顺序反了的话，新节点会被解析成老的 bili 定义 —— 卡片与面板都走老的那套，
 * 界面上看着"合并没生效"，且不报任何错。
 */
import './defs/update';
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
/* 组合框（frame）：不从侧栏拖，靠画布上「组合」生成 */
import './defs/frame';

export {
  registerNode, getDef, hasDef, allDefs, allPresets, presetsByCategory, buildNodeTypes,
} from './registry';
export type { NodeDef, NodePreset, NodeMeta, NodeCategory, NodeInspectorProps } from './types';
export { NODE_CATEGORY_META } from './types';
export {
  getVariableGroup, allVariableGroups, checkVarForNode, patchForVar,
} from '../engine/variables';
