import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeUpdateNode, targetsOf, UPDATE_SOURCE_META,
  type UpdateNodeData, type UpdateSource,
} from '../types';
import { validateNode } from '../engine/nodeValidate';
import { requiresOf } from '../engine/nodeRequires';

/*
 * 更新检测合并成"一个节点盯多个目标"之后的守卫。
 *
 * 这个改动的特征是**老数据不能迁**：老存档没有 targets 字段，
 * 靠 targetsOf() 读时合成。于是"合成得对不对"是整个改动的命门 ——
 * 合成错一张卡，界面上就是种类名取不到、卡片渲染直接抛错。
 */

const node = (d: unknown) => ({ id: 'n1', data: d }) as never;

test('新节点落 targets，老节点读时合成一张卡', () => {
  const fresh = makeUpdateNode('up1', 'xiaohongshu').data as UpdateNodeData;
  assert.equal(fresh.targets!.length, 1);
  assert.equal(fresh.targets![0].kind, 'xiaohongshu');

  // 老存档：没有 targets，只有平铺的 source / feedUrl
  const legacy = {
    kind: 'update', source: 'wechat', feedUrl: 'https://a/feed.xml',
    lastSeenId: 'x1', lastSeenTitle: '标题',
  } as unknown as UpdateNodeData;
  const cards = targetsOf(legacy);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].kind, 'wechat');
  assert.equal(cards[0].feedUrl, 'https://a/feed.xml');
  // 基线要跟着合成出来 —— 否则每个目标都从"首次"开始，永远报不出更新
  assert.equal(cards[0].lastSeenId, 'x1');
  assert.equal(cards[0].lastSeenTitle, '标题');
});

test('四种目标都有元信息（小红书是这次新增的）', () => {
  for (const k of ['bilibili', 'wechat', 'xiaohongshu', 'github'] as UpdateSource[]) {
    const m = UPDATE_SOURCE_META[k];
    assert.ok(m?.label, `${k} 缺名称`);
    assert.ok(m?.hint, `${k} 缺说明`);
    assert.ok(m?.icon, `${k} 缺图标`);
  }
  // 小红书没有官方接口 —— 这句话必须写在界面上，否则用户填主页地址会一直失败
  assert.match(UPDATE_SOURCE_META.xiaohongshu.hint, /订阅源|接口/);
});

test('校验按"每一张卡"来，并带上是哪一张', () => {
  const base = makeUpdateNode('up1', 'bilibili').data as UpdateNodeData;
  const withTwo = {
    ...base,
    targets: [
      { id: 'a', kind: 'bilibili', enabled: true, biliMode: 'api', biliUid: '123' },
      { id: 'b', kind: 'xiaohongshu', enabled: true, feedUrl: '' },
    ],
  } as unknown as UpdateNodeData;
  const r = validateNode(node(withTwo));
  assert.equal(r.level, 'error');
  // 只报有问题的那张，且要点名 —— 三张卡一起报错等于没说
  assert.match(r.messages.join(' '), /小红书/);

  const ok = {
    ...base,
    targets: [
      { id: 'a', kind: 'bilibili', enabled: true, biliMode: 'api', biliUid: '123' },
      { id: 'b', kind: 'xiaohongshu', enabled: true, feedUrl: 'https://x/f.xml' },
    ],
  } as unknown as UpdateNodeData;
  assert.equal(validateNode(node(ok)).level, 'ok');
});

test('全都停用时报"缺项"，不能当成"通过"', () => {
  const d = {
    kind: 'update',
    targets: [{ id: 'a', kind: 'wechat', enabled: false, feedUrl: 'https://x/f.xml' }],
  } as unknown as UpdateNodeData;
  assert.equal(validateNode(node(d)).level, 'error');
});

/*
 * 能力需求按目标种类走：
 * 只盯仓库的节点不该被"没有网络抓取能力"拦下（它用不上），
 * 只盯订阅源的节点也不该被要求 GitHub 拉取。
 */
test('能力需求跟着目标种类走', () => {
  const feedOnly = {
    kind: 'update',
    targets: [{ id: 'a', kind: 'wechat', enabled: true, feedUrl: 'u' }],
  };
  assert.deepEqual(
    requiresOf(feedOnly).map((r) => r.key),
    ['fetcher'],
  );

  const ghOnly = {
    kind: 'update',
    targets: [{ id: 'a', kind: 'github', enabled: true, owner: 'o', repo: 'r' }],
  };
  assert.deepEqual(requiresOf(ghOnly).map((r) => r.key), ['githubFetch']);

  const both = {
    kind: 'update',
    targets: [
      { id: 'a', kind: 'wechat', enabled: true, feedUrl: 'u' },
      { id: 'b', kind: 'github', enabled: true, owner: 'o', repo: 'r' },
    ],
  };
  assert.deepEqual(requiresOf(both).map((r) => r.key).sort(), ['fetcher', 'githubFetch']);
});

/*
 * 老节点（没有 targets）合成出的卡是 wechat/bilibili，
 * 历史上它需要的就是 fetcher —— 不能因为改了判定方式就把老画布卡住。
 */
test('老节点合成出的卡仍只要求网络抓取', () => {
  const legacy = { kind: 'update', source: 'wechat', feedUrl: 'u' };
  assert.deepEqual(requiresOf(legacy).map((r) => r.key), ['fetcher']);
});
