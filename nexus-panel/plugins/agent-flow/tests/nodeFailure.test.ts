import test from 'node:test';
import assert from 'node:assert/strict';
import { runGraph } from '../engine/runner';
import { makeGithubUpdateNode, makeGithubPushNode, makeNode } from '../types';

/**
 * 节点失败的**传播**。
 *
 * 这组用例存在的理由：此前 GitHub 两个执行器失败时只调了
 * setStatus(id, 'failed')，没有 markFailed，也没有发 node-done。
 * 后果是节点显示红色，但：
 *   - 下游不跳过（跳过判定看的是 scope.failedSet，只有 markFailed 会写）
 *   - summary.failed 里没有它，整轮可能报"成功"
 * 属于"看起来失败了其实没失败"，很难从界面上发现。
 */

const baseOpts = {
  concurrency: 1,
  executor: async () => 'never',
  onEvent: () => {},
};

/** 造一条 A → 下游 的链，A 是 GitHub 更新节点 */
function chain(headData: Record<string, unknown>) {
  return {
    nodes: [
      { id: 'A', data: { ...makeGithubUpdateNode('A').data, ...headData } },
      makeNode('B', { prompt: 'x' }),
    ],
    edges: [{ id: 'e1', source: 'A', target: 'B' }],
  };
}

test('GitHub 节点缺执行器：下游必须跳过，整轮必须判失败', async () => {
  const s = await runGraph(chain({}), baseOpts);
  assert.equal(s.failed.includes('A'), true, 'A 应记入 failed');
  assert.equal(s.skipped.includes('B'), true, 'B 应被跳过');
  assert.equal(s.ok, false, '整轮不应报成功');
});

test('GitHub 节点缺 owner/repo：下游必须跳过', async () => {
  const s = await runGraph(chain({}), {
    ...baseOpts,
    githubFetch: async () => ({ ok: true, info: { updated: false, sha: '', branch: '', message: '', author: '', date: '' } }),
  });
  assert.equal(s.failed.includes('A'), true);
  assert.equal(s.skipped.includes('B'), true);
  assert.equal(s.ok, false);
});

test('GitHub 节点拉取失败：失败要传播到下游', async () => {
  const s = await runGraph(chain({ owner: 'o', repo: 'r' }), {
    ...baseOpts,
    githubFetch: async () => ({ ok: false, error: '网络错误' }),
  });
  assert.equal(s.failed.includes('A'), true);
  assert.equal(s.skipped.includes('B'), true);
  assert.equal(s.ok, false);
});

test('GitHub 推送节点失败同样要传播', async () => {
  const g = {
    nodes: [
      { id: 'A', data: { ...makeGithubPushNode('A').data, owner: 'o', repo: 'r' } },
      makeNode('B', { prompt: 'x' }),
    ],
    edges: [{ id: 'e1', source: 'A', target: 'B' }],
  };
  const s = await runGraph(g, { ...baseOpts, githubPush: async () => ({ ok: false, error: '推送失败' }) });
  assert.equal(s.failed.includes('A'), true);
  assert.equal(s.skipped.includes('B'), true);
  assert.equal(s.ok, false);
});

test('失败节点必须产生 node-done 终态事件（而不是只有 node-error）', async () => {
  const events: Array<{ type: string; id?: string }> = [];
  await runGraph(chain({}), {
    ...baseOpts,
    onEvent: (e) => events.push(e as { type: string; id?: string }),
  });
  const done = events.filter((e) => e.type === 'node-done' && e.id === 'A');
  assert.equal(done.length, 1, '应恰好一条 node-done');
  assert.equal((done[0] as { ok: boolean }).ok, false);
});
