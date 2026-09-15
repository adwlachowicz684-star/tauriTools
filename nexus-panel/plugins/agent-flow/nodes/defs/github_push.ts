import { makeGithubPushNode } from '../../types';
import { GithubPushNode } from '../../components/GithubNode';
import { GithubPushInspector } from '../../components/inspectors/GithubPushInspector';
import { runGithubPush } from '../../engine/runners/githubPush';
import { registerNode } from '../registry';

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
  Inspector: GithubPushInspector,
  run: runGithubPush,
});
