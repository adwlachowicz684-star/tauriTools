import {
  makeUpdateNode, UPDATE_SOURCE_META, UPDATE_SIDEBAR_SOURCES,
  type UpdateSource, type UpdateNodeData,
} from '../../types';
import UpdateNode from '../../components/UpdateNode';
import { UpdateInspector } from '../../components/inspectors/UpdateInspector';
import { runUpdate } from '../../engine/runners/update';
import { registerNode } from '../registry';

/**
 * 合并后的「更新检测」节点。
 *
 * ================= 为什么合成一个 =================
 *
 * 以前 B站 / 公众号 / GitHub 仓库是三种节点，各有各的卡片与面板，
 * 但它们干的是同一件事：定期看一眼，变了就输出 true。
 *
 * 分开的代价在"盯多个"时才暴露出来：想同时盯两个 UP 主加一个仓库，
 * 得摆三个节点，而它们的输出是同一个名字 —— 下游条件节点只能判一个，
 * 另外两个的状态互相看不见。
 *
 * ================= 老的三种怎么办 =================
 *
 * bili / wechat / github-update 仍然注册着（否则老画布打开就变未知节点），
 * 但标了 legacy —— 侧栏不再列出，新的都在这一张卡上配。
 * 数据不用迁移：targetsOf() 读时把老字段合成一张卡。
 */
registerNode({
  type: 'update',
  dataKind: 'update',
  meta: {
    label: '更新检测',
    color: '#38bdf8',
    category: 'external',
    idPrefix: 'up',
    /*
     * 不列全 17 种：清单会过时，而这里字数有限。
     * 写「等」加「任意 RSS 源」，把兜底那条说清楚 ——
     * 用户关心的是「我要盯的能不能盯」，不是平台总数。
     */
    sub: '盯住若干目标，有新的就输出 true（B站 / 微博 / 小红书 / 知乎 / 仓库等，也可填任意 RSS 源）',

    /*
     * 侧栏里按源展开成几条：
     * 挑节点时"我要盯小红书"比"我要一个更新检测节点"更贴近想法，
     * 而拖进来之后它们都是同一个 type，想加第二个源直接在面板里加卡。
     *
     * presets 必须写在 meta 里 —— 注册表读的是 def.meta.presets
     * （见 registry.tsx 的 allPresets）。写在 def 顶层的话类型检查会报
     * 多余属性，更麻烦的是侧栏会静默回退到"只列一条"，于是小红书那条
     * 根本不出现：不报错，只是少几个入口。
     */
    presets: () => (UPDATE_SIDEBAR_SOURCES as UpdateSource[]).map((k) => ({
      key: `update:${k}`,
      label: UPDATE_SOURCE_META[k].label,
      color: UPDATE_SOURCE_META[k].color,
      hint: UPDATE_SOURCE_META[k].hint,
      init: () => makeUpdateNode('', k).data,
    })),
  },
  create: (id, partial) => {
    const p = (partial ?? {}) as Partial<UpdateNodeData> & { source?: UpdateSource };
    /*
     * 侧栏可以给出"默认盯哪种"的入口（见 presets），
     * 没给就按 B站 —— 它是唯一不需要自备桥接服务的一种。
     */
    return makeUpdateNode(id, p.source ?? 'bilibili', p).data;
  },
  Canvas: UpdateNode,
  Inspector: UpdateInspector,
  run: runUpdate,
});
