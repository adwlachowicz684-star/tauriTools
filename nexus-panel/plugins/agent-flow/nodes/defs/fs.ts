import { makeFsNode } from '../../types';
import FsNode from '../../components/FsNode';
import { FsInspector } from '../../components/inspectors/FsInspector';
import { runFs } from '../../engine/runners/fs';
import { registerNode } from '../registry';

registerNode({
  type: 'fs',
  dataKind: 'fs',
  meta: {
    label: '文件操作',
    color: '#38bdf8',
    category: 'data',
    idPrefix: 'f',
  },
  create: (id, partial) => makeFsNode(id, (partial ?? {}) as never).data,
  Canvas: FsNode,
  Inspector: FsInspector,
  run: runFs,
});
