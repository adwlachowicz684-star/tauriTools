import { CONST_TYPE_LABEL, makeConstNode, type ConstValueType } from '../../types';
import { ConstNode } from '../../components/ToolNode';
import { type FieldDef } from '../../components/inspectors/fields';
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
 * 产出的值种类仍按 valueType 走（argTypes / paramLinks 都读它），
 * 所以合并**不损失**参数类型校验：数字常量接到「大于」上照样合法。
 */

const fields: FieldDef[] = [
  /*
   * 种类放第一项：它决定下面那一格长什么样（多行 / 单行 / 下拉）。
   */
  {
    type: 'select',
    key: 'valueType',
    label: '种类',
    options: (['text', 'num', 'bool'] as ConstValueType[]).map((vt) => ({
      value: vt,
      label: CONST_TYPE_LABEL[vt],
    })),
    hint: '决定产出的值种类：数字能接比大小，布尔能接条件判定',
  },
  /*
   * 值这一项按种类换控件：
   *
   *   文本 → 多行输入（要能写长文本、能写模板）
   *   数字 → 单行输入（保留手填模板的能力，不用 number 控件 ——
   *          number 控件里写 {{xx.output}} 会被浏览器直接清空，
   *          而模板正是常量最常用的用法之一）
   *   布尔 → 下拉 true / false
   */
  {
    type: 'textarea',
    key: 'value',
    label: '值',
    rows: 5,
    placeholder: '原样输出给下游；支持 {{模板变量}}',
    hint: '名字叫常量，但支持模板，所以实际是"拼一段固定文本"',
    when: (d) => (d.valueType ?? 'text') === 'text',
  },
  {
    type: 'text',
    key: 'value',
    label: '值',
    placeholder: '如 42；也支持 {{模板变量}}',
    hint: '接到比大小、加减乘除上要填数字；填了文字下游会按 0 算',
    when: (d) => d.valueType === 'num',
  },
  {
    type: 'select',
    key: 'value',
    label: '值',
    options: [
      { value: 'true', label: '真（true）' },
      { value: 'false', label: '假（false）' },
    ],
    hint: '接到条件判定、闸门上用',
    when: (d) => d.valueType === 'bool',
  },
  {
    type: 'note',
    content: '产出的种类由上面的「种类」决定：选了数字接到「大于」上合法，接到「包含」上会报错参。卡片上点种类那格就能切。',
  },
];

registerNode({
  type: 'const',
  dataKind: 'const',
  meta: {
    label: '常量',
    color: '#94a3b8',
    category: 'tools',
    idPrefix: 'cv',
    sub: '输出一个固定值给下游（种类在卡片上切）',
  },
  create: (id, partial) => makeConstNode(id, (partial ?? {}) as never).data,
  Canvas: ConstNode,
  fields: () => fields,
  run: runConst,
});
