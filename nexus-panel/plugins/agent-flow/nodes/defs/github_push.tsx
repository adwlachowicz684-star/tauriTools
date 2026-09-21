import { makeGithubPushNode } from '../../types';
import { GithubPushNode } from '../../components/GithubNode';
import { OrderPicker } from '../../components/inspectors/shared';
import { type FieldDef } from '../../components/inspectors/fields';
import { runGithubPush } from '../../engine/runners/githubPush';
import { registerNode } from '../registry';

const fields: FieldDef[] = [
  {
    type: 'custom',
    spec: { keys: ['owner', 'repo'], kind: 'text' },
    render: (p) => (
      <label className="p-row">
        <span className="p-muted" style={{ width: 64, flex: 'none' }}>仓库</span>
        <input
          className="p-input"
          value={String(p.d.owner ?? '')}
          placeholder="owner"
          onChange={(e) => p.patch({ owner: e.target.value })}
        />
        <span className="p-muted">/</span>
        <input
          className="p-input"
          value={String(p.d.repo ?? '')}
          placeholder="repo"
          onChange={(e) => p.patch({ repo: e.target.value })}
        />
      </label>
    ),
  },
  { type: 'text', key: 'branch', label: '分支', placeholder: 'main', inline: true },
  {
    type: 'text',
    key: 'message',
    label: '提交信息',
    placeholder: '支持 {{上游.output}}',
    inline: true,
  },
  {
    type: 'textarea',
    key: 'filesText',
    label: '文件（每行一条 路径=内容）',
    rows: 5,
    placeholder: 'README.md=# 标题\nnotes/{{date}}.txt={{上游.output}}',
  },
  { type: 'credential', key: 'credentialId', credentialKind: 'github-push' },
  {
    type: 'custom',
    spec: { keys: ['order'], kind: 'switch' },
    render: (p) => <OrderPicker order={p.d.order as never} fallback={['api', 'cli']} onChange={p.patch} />,
  },
  {
    type: 'text',
    key: 'workdir',
    label: '本地路径',
    placeholder: '仅 git 方案需要',
    inline: true,
  },
];

registerNode({
  type: 'github-push',
  dataKind: 'github-push',
  meta: {
    varGroups: ['github-repo', 'workdir'],
    label: '推送',
    color: '#34d399',
    category: 'external',
    idPrefix: 'gp',
    sub: '把改动提交并推到远端分支',
  },
  create: (id, partial) => makeGithubPushNode(id, (partial ?? {}) as never).data,
  Canvas: GithubPushNode,
  fields: () => fields,
  run: runGithubPush,
});
