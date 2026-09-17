import { makeJoinNode } from '../../types';
import { JoinNode } from '../../components/ControlNode';
import type { FieldDef } from '../../components/inspectors/fields';
import { runJoin } from '../../engine/runners/join';
import { registerNode } from '../registry';

/**
 * 汇合节点 —— 控制器家族的第一个成员。
 *
 * 存在的理由：多入边节点默认是 OR 语义（一条入边活着就跑），
 * 而"几条并行分支全部完成再继续"要的是 AND。详见执行器里的说明。
 */
const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'mode',
    label: '严格程度',
    options: [
      {
        value: 'all',
        label: '宽松',
        hint: '活着的输入都到齐就放行；被分支剪掉的不算缺失',
      },
      {
        value: 'strict',
        label: '严格',
        hint: '任何一条输入没到齐都算失败，并让下游跳过',
      },
    ],
    hint: '多数情况用宽松 —— 条件分支下用严格会永远收集不齐',
  },
  {
    type: 'text',
    key: 'joinBy',
    label: '合并分隔符',
    placeholder: '\\n',
    hint: '多个输入拼在一起时的分隔；填 \\n 表示换行',
    when: (d) => d.mode !== 'strict',
  },
  {
    type: 'note',
    content: '输出 = 所有到齐输入按顺序拼接。想单独用某一条，下游写 {{那个节点.output}} 即可。',
  },
];

registerNode({
  type: 'join',
  dataKind: 'join',
  meta: {
    label: '汇合',
    color: '#f59e0b',
    category: 'control',
    idPrefix: 'jn',
    sub: '等所有输入都到齐了才放行下游',
  },
  create: (id, partial) => makeJoinNode(id, (partial ?? {}) as never).data,
  Canvas: JoinNode,
  fields: () => fields,
  run: runJoin,
});
