import { makeConstNode, type ConstValueType } from '../../types';
import { ConstNode } from '../../components/ToolNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runConst } from '../../engine/runners/const';
import { registerNode } from '../registry';

/*
 * 三种常量是**三个预设**，不是一个节点上的下拉框。
 *
 * 下拉框的代价：拖进来的永远是"文本常量"，想用布尔得先拖进来、
 * 再点开面板、再改一项 —— 三步，而且前两步看到的东西都是错的
 * （侧栏写着"常量"，卡片上写着"常量"，面板里才第一次出现"种类"）。
 * 三步之后还要回头改标签。
 *
 * 预设展开后侧栏直接列出三条，拖进来就是对的那个。
 * 与「任务」的两种 CLI 同一套机制（meta.presets）。
 */

/** 三种常量的侧栏颜色。数字偏蓝、布尔偏紫，与它们产出的值种类呼应 */
export const CONST_TYPE_COLOR: Record<ConstValueType, string> = {
  text: '#94a3b8',
  num: '#60a5fa',
  bool: '#c084fc',
};

const fields: FieldDef[] = [
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
    content: '产出的种类由常量类型决定：数字常量接到「大于」上合法，接到「包含」上会报错参。',
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
    sub: '输出一个固定值给下游',
    presets: () =>
      (['text', 'num', 'bool'] as ConstValueType[]).map((vt) => ({
        key: `const:${vt}`,
        label: vt === 'text' ? '文本常量' : vt === 'num' ? '数字常量' : '布尔常量',
        color: CONST_TYPE_COLOR[vt],
        init: () => makeConstNode('', { valueType: vt }).data,
      })),
  },
  create: (id, partial) => makeConstNode(id, (partial ?? {}) as never).data,
  Canvas: ConstNode,
  fields: () => fields,
  run: runConst,
});
