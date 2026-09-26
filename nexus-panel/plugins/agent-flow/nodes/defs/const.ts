import { makeConstNode } from '../../types';
import { ConstNode } from '../../components/ToolNode';
import { ConstInspector } from '../../components/inspectors/ConstInspector';
import { runConst } from '../../engine/runners/const';
import { registerNode } from '../registry';

/*
 * 三种常量（文本 / 数字 / 布尔）合并成**一个**节点，种类在卡片上直接切。
 *
 * ================= 为什么现在能合并了 =================
 *
 * 以前列成三条侧栏预设，理由是"下拉框要三步才能改种类"：
 * 拖进来 → 点开面板 → 改一项，且前两步看到的都是"文本常量"。
 *
 * 现在卡片上的参数格能就地编辑（见 ArgCell），种类那一格本身就是下拉，
 * 切种类是**一下** —— 三步的理由不成立，三条侧栏入口也就没必要了。
 *
 * 产出的值种类仍按卡上的 valueType 走（argTypes / paramLinks 都读它），
 * 所以合并**不损失**参数类型校验：数字卡接到「大于」上照样合法。
 *
 * ================= 一个节点放多张卡 =================
 *
 * 一个流程里往往要几个固定值（阈值、价格、开关），摆三个常量节点的话
 * 它们各自独立、连线互相看不见。现在一个节点可以放多张卡，
 * 每张卡**各带一个输出端口** —— 把「阈值」接到「大于」上、「价格」
 * 接到写入节点上，都从同一个节点里拖出来。
 *
 * ================= 数据只有一份 =================
 *
 * 卡只存在 items 里，节点上没有顶层的 value / valueType。
 * 两份数据的代价是每次写卡都要镜像一遍，漏一处就是
 * "卡片显示变了、跑出来还是旧的"，且不报错。
 */

registerNode({
  type: 'const',
  dataKind: 'const',
  meta: {
    label: '常量',
    color: '#94a3b8',
    category: 'tools',
    idPrefix: 'cv',
    sub: '放若干个固定值，每张卡一个输出端口',
  },
  create: (id, partial) => makeConstNode(id, (partial ?? {}) as never).data,
  Canvas: ConstNode,
  /*
   * 多张卡 → 自定义面板。
   *
   * fields 是**平面**的（一个 key 一个控件），写不出"卡片数组"：
   * 用 fields 就只能给一个常量配一组控件，加不了第二张。
   * 所以走 Inspector，并在 nodeSpec 里标 manualParams 手写参数说明 ——
   * 有 fields 却不标 manualParams 是错的（测试盯着），反过来也一样。
   */
  Inspector: ConstInspector,
  run: runConst,
});
