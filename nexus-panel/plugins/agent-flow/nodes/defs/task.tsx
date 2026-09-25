import { CLI_META, makeNode, type CliKind, type TaskNodeData } from '../../types';
import TaskNode from '../../components/TaskNode';
import { FileParamsPanel, CliModelPanel } from '../../components/inspectors/shared';
import {
  Field, VarBar, upstreamTokens, upstreamFileTokens, paneField,
  type FieldDef, type FieldRenderProps,
} from '../../components/inspectors/fields';
import { runTask } from '../../engine/runners/task';
import { registerNode } from '../registry';

/**
 * 任务节点：字段不多，但提示词那一栏要带一整套上游变量插入按钮，
 * 所以走 custom 逃生口 —— 其余仍是纯声明。
 */
/*
 * 写成**函数**而不是常量数组：窗格下拉框的选项来自画布上的窗格节点，
 * 那是运行时状态（App 的状态），常量数组拿不到 ——
 * 写死成空数组的话，拖了窗格进来这里也永远选不到。
 */
const fields = (_d: Record<string, unknown>, ctx?: FieldRenderProps): FieldDef[] => [
  {
    type: 'select',
    key: 'cli',
    label: '使用 CLI',
    options: () =>
      (Object.keys(CLI_META) as CliKind[]).map((k) => ({
        value: k,
        label: CLI_META[k].label,
      })),
  },
  {
    type: 'custom',
    spec: { keys: ['prompt', 'model', 'workdir'], kind: 'textarea' },
    key: 'prompt',
    render: (p) => (
      <Field label="提示词内容">
        <VarBar
          title="可引用："
          tokens={upstreamTokens(p.upstream, ['{{input}}'])}
          onInsert={(t) => p.onChange(String(p.d.prompt ?? '') + t)}
        />
        {p.upstream.length > 0 ? (
          <VarBar
            title="上游文件（改了哪些）："
            tokens={upstreamFileTokens(p.upstream)}
            onInsert={(t) => p.onChange(String(p.d.prompt ?? '') + t)}
          />
        ) : null}
        <textarea
          className="p-input"
          rows={8}
          value={String(p.d.prompt ?? '')}
          placeholder="要交给 CLI 的指令，支持 {{上游.output}}"
          onChange={(e) => p.onChange(e.target.value)}
        />
      </Field>
    ),
  },
  {
    /*
     * 模型走「连接 + 模型」两个框，与 OCR / 翻译 / HTTP 一致。
     *
     * 以前这里是手填 text：模型名长且易拼错，
     * 打错一个字符要等 CLI 跑起来才出错，而 CLI 多半只回一句非零退出，
     * 根本看不出是模型名的问题。
     */
    type: 'custom',
    spec: { keys: ['model', 'credentialId'], kind: 'select' },
    key: 'model',
    render: (p) => (
      <CliModelPanel
        model={String(p.d.model ?? '')}
        credentialId={p.d.credentialId as string}
        credentials={p.credentials}
        onChange={p.patch}
        onOpenCredentials={p.onOpenCredentials}
      />
    ),
  },
  {
    type: 'text',
    key: 'workdir',
    label: '工作目录',
    placeholder: '留空用当前目录',
  },
  {
    type: 'switch',
    key: 'yolo',
    label: '',
    placeholder: '自动批准工具调用（-y）',
    hint: '省去每次确认，但 CLI 会直接改文件',
  },
  /*
   * 挂了窗格之后，本节点上**没填的**项（工作目录 / 模型 / 连接）从窗格继承。
   * 填了的仍然以这里为准 —— 否则改一次窗格就把精心配好的节点盖掉了。
   */
  paneField('taskPane', ctx?.nodes),

  {
    type: 'custom',
    spec: { keys: ['yolo'], kind: 'switch' },
    /*
     * 不用 as never —— 它把类型检查整个绕过，签名对不上也照样编译过。
     * 两侧都改成单参数后，这里的类型是真对上了。
     *
     * 注释只能放在箭头函数**之前**：放在 `=> (` 与 JSX 之间时，
     * 那段注释会被当成 JSX 表达式容器（花括号加注释的形式），
     * 而容器里只有注释、没有表达式，于是整段变成语法错误。
     */
    render: (p) => (
      <FileParamsPanel node={p.node} onChange={p.patch} />
    ),
  },
];

registerNode({
  type: 'task',
  dataKind: 'task',
  /* presets 必须写在 meta 里：注册表读的是 def.meta.presets（见 registry.tsx 的
     allPresets）。写到 NodeDef 顶层不会被读，两种 CLI 预设也就展不开 ——
     侧栏只剩一条「任务」，用户再也选不到另一种 CLI。 */
  meta: {
    label: '任务', color: '#f97316', category: 'task', idPrefix: 't',
    sub: '让命令行工具干一件事，拿它的输出',
    presets: () =>
      (Object.keys(CLI_META) as CliKind[]).map((k) => ({
        key: `task:${k}`,
        label: CLI_META[k].label,
        color: CLI_META[k].color,
        init: () => makeNode('', { cli: k, label: `${CLI_META[k].label}任务` }).data,
      })),
  },
  create: (id, partial) => makeNode(id, (partial ?? {}) as Partial<TaskNodeData>).data,
  Canvas: TaskNode,
  fields,
  run: runTask,
});
