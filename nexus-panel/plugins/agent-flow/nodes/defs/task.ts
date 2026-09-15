import { CLI_META, makeNode, type CliKind } from '../../types';
import TaskNode from '../../components/TaskNode';
import { TaskInspector } from '../../components/inspectors/TaskInspector';
import { runTask } from '../../engine/runners/task';
import { registerNode } from '../registry';

registerNode({
  type: 'task',
  dataKind: 'task',
  meta: {
    label: '任务',
    color: '#f97316',
    category: 'task',
    idPrefix: 't',
    presets: () => (Object.keys(CLI_META) as CliKind[]).map((k) => ({
      key: `task:${k}`, label: CLI_META[k].label, color: CLI_META[k].color,
      init: () => makeNode('', { cli: k, label: `${CLI_META[k].label}任务` }).data,
    })),
  },
  create: (id, partial) => makeNode(id, (partial ?? {}) as never).data,
  Canvas: TaskNode,
  Inspector: TaskInspector,
  run: runTask,
});
