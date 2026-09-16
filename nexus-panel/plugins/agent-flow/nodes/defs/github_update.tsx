import { makeGithubUpdateNode } from '../../types';
import { GithubUpdateNode } from '../../components/GithubNode';
import { OrderPicker } from '../../components/inspectors/shared';
import { Field, type FieldDef } from '../../components/inspectors/fields';

const repoSummary = (v: Record<string, unknown>): string => {
  const owner = String(v.owner ?? '').trim();
  const repo = String(v.repo ?? '').trim();
  if (!owner && !repo) return '（空）';
  const base = repo ? `${owner}/${repo}` : owner;
  const branch = String(v.branch ?? '').trim();
  return branch ? `${base} · ${branch}` : base;
};

import { runGithubUpdate } from '../../engine/runners/githubUpdate';
import { registerNode } from '../registry';

const fields: FieldDef[] = [
  {
    // owner / repo 在同一行更像一个整体，用 custom 保住这个观感
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
  { type: 'text', key: 'branch', label: '分支', placeholder: '留空用默认分支', inline: true },
  /*
   * 仓库卡片：owner / repo / branch 三个字段打包成一张卡片。
   * 组名 'github-repo' 是共享的 —— 推送节点也用这个组，
   * 所以同一个仓库存一次，两个节点都能选到它。
   */
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
    key: 'base',
    label: '基准',
    placeholder: '本地 HEAD，留空则只取远端状态',
    inline: true,
    hint: '填了会与本地 HEAD 比对，只关心"本地是否落后"时很有用',
  },
  { type: 'credential', key: 'credentialId', credentialKind: 'github-update' },
  {
    type: 'custom',
    render: (p) => <OrderPicker order={p.d.order as never} fallback={['api', 'atom', 'cli']} onChange={p.patch} />,
  },
  {
    type: 'note',
    content: '输出 true / false，条件节点判断「等于 true」即可分流。',
  },
];

registerNode({
  type: 'github-update',
  dataKind: 'github-update',
  meta: {
    label: '更新检测',
    color: '#a78bfa',
    category: 'external',
    idPrefix: 'gu',
    sub: '在「凭据」里填一次令牌，两个节点共用',
  },
  create: (id, partial) => makeGithubUpdateNode(id, (partial ?? {}) as never).data,
  Canvas: GithubUpdateNode,
  fields: () => fields,
  run: runGithubUpdate,
});
