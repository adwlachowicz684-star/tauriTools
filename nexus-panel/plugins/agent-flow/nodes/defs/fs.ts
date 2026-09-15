import { makeFsNode, FS_OP_META, type FsOp } from '../../types';
import FsNode from '../../components/FsNode';
import { type FieldDef } from '../../components/inspectors/fields';
import { runFs } from '../../engine/runners/fs';
import { registerNode } from '../registry';

const OPS = Object.keys(FS_OP_META) as FsOp[];

/**
 * 文件操作：典型的"字段之间有关联"的例子 ——
 * 目标路径只在 copy/move 时出现、内容只在 write/append 时出现、
 * 递归与后缀只在 list 时出现。用 when 表达，比在 JSX 里写三元更清楚。
 */
const fields: FieldDef[] = [
  {
    type: 'select',
    key: 'op',
    label: '操作',
    options: () =>
      OPS.map((k) => ({
        value: k,
        label: FS_OP_META[k].label + (FS_OP_META[k].destructive ? '（改磁盘）' : ''),
      })),
    hint: (d) => FS_OP_META[d.op as FsOp]?.hint,
  },
  {
    type: 'text',
    key: 'path',
    label: '路径',
    placeholder: '/abs/or/relative/path',
    hint: '支持模板变量，如 {{upstream.output}} / {{loop.item}}',
  },
  {
    type: 'text',
    key: 'target',
    label: '目标路径',
    placeholder: '/path/to/dest',
    when: (d) => Boolean(FS_OP_META[d.op as FsOp]?.needsTarget),
  },
  {
    type: 'textarea',
    key: 'content',
    label: '内容',
    rows: 6,
    placeholder: '写入的内容，支持 {{模板变量}}',
    when: (d) => Boolean(FS_OP_META[d.op as FsOp]?.needsContent),
  },
  {
    type: 'number',
    key: 'maxBytes',
    label: '最大读取字节',
    min: 0,
    hint: '超出会截断，0 表示不限制',
    when: (d) => d.op === 'read',
  },
  {
    type: 'switch',
    key: 'recursive',
    label: '',
    placeholder: '递归子目录',
    when: (d) => d.op === 'list',
  },
  {
    type: 'text',
    key: 'exts',
    label: '只保留这些后缀（逗号分隔，留空=全部）',
    placeholder: 'ts,tsx,md',
    toUI: (v) => (Array.isArray(v) ? v.join(',') : ''),
    fromUI: (v) =>
      String(v).split(',').map((s) => s.trim()).filter(Boolean),
    when: (d) => d.op === 'list',
  },
  {
    type: 'switch',
    key: 'dryRun',
    label: '',
    placeholder: '演练模式（不会真正改动磁盘）',
  },
  {
    type: 'note',
    when: (d) => Boolean(FS_OP_META[d.op as FsOp]?.destructive),
    content: '这个操作会改动磁盘上的文件，请确认路径无误。',
  },
];

registerNode({
  type: 'fs',
  dataKind: 'fs',
  meta: { label: '文件操作', color: '#38bdf8', category: 'data', idPrefix: 'f' },
  create: (id, partial) => makeFsNode(id, (partial ?? {}) as never).data,
  Canvas: FsNode,
  fields: () => fields,
  run: runFs,
});
