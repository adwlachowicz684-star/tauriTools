import { makeGithubUpdateNode } from '../../types';
import { GithubUpdateNode } from '../../components/GithubNode';
import { GithubUpdateInspector } from '../../components/inspectors/GithubUpdateInspector';
import { runGithubUpdate } from '../../engine/runners/githubUpdate';
import { registerNode } from '../registry';

registerNode({
  type: 'github-update',
  dataKind: 'github-update',
  meta: {
    label: '更新检测',
    color: '#a78bfa',
    category: 'external',
    idPrefix: 'gu',
  },
  create: (id, partial) => makeGithubUpdateNode(id, (partial ?? {}) as never).data,
  Canvas: GithubUpdateNode,
  Inspector: GithubUpdateInspector,
  run: runGithubUpdate,
});
