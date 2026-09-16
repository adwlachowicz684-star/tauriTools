import { makeGithubPushNode } from '../../types';
import { GithubPushNode } from '../../components/GithubNode';
import { OrderPicker } from '../../components/inspectors/shared';
import { type FieldDef } from '../../components/inspectors/fields';
import { runGithubPush } from '../../engine/runners/githubPush';
import { registerNode } from '../registry';

const repoSummary = (v: Record<string, unknown>): string => {
  const owner = String(v.owner ?? '').trim();
  const repo = String(v.repo ?? '').trim();
  if (!owner && !repo) return '（空）';
  const base = repo ? `${owner}/${repo}` : owner;
  const branch = String(v.branch ?? '').trim();
  return branch ? `${base} · ${branch}` : base;
};


const fields: FieldDef[] = [
  {
    type: 'custom',
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
  // 与更新检测节点共用 'github-repo' 组，同一个仓库存一次两边都能用
  {
    type: 'paramCard',
    label: '地址卡片',
    cardGroup: 'github-repo',
    cardKeys: ['owner', 'repo', 'branch'],
    cardSummary: repoSummary,
    cardName: '仓库',
    hint: '存成卡片后可一键套到其它节点；改上面的字段会自动脱钩成自定义',
  },
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
    label: '推送',
    color: '#34d399',
    category: 'external',
    idPrefix: 'gp',
  },
  create: (id, partial) => makeGithubPushNode(id, (partial ?? {}) as never).data,
  Canvas: GithubPushNode,
  fields: () => fields,
  run: runGithubPush,
});
