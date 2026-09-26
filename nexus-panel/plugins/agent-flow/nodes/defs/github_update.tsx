import { makeGithubUpdateNode } from '../../types';
import { GithubUpdateNode } from '../../components/GithubNode';
import { OrderPicker } from '../../components/inspectors/shared';
import { Field, type FieldDef } from '../../components/inspectors/fields';

import { runGithubUpdate } from '../../engine/runners/githubUpdate';
import { registerNode } from '../registry';

const fields: FieldDef[] = [
  {
    // owner / repo 在同一行更像一个整体，用 custom 保住这个观感
    type: 'custom',
    spec: { keys: ['owner', 'repo', 'order'], kind: 'text' },
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
    spec: { keys: ['order'], kind: 'switch' },
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
    varGroups: ['github-repo'],
    /*
     * 名字必须避开「更新检测」—— 那是 17 平台那个现行节点的名字。
     * 两处同名时，运行日志 / 报错 / 面板里都只写「更新检测」，
     * 排查时无从分辨到底跑的是哪一个（而 legacy 这个已不再进侧栏）。
     */
    label: '仓库更新（旧）',
    color: '#a78bfa',
    legacy: true,
    category: 'external',
    idPrefix: 'gu',
    sub: '检测仓库有没有新提交 / 新 Release（令牌填一次共用）',
  },
  create: (id, partial) => makeGithubUpdateNode(id, (partial ?? {}) as never).data,
  Canvas: GithubUpdateNode,
  fields: () => fields,
  run: runGithubUpdate,
});
