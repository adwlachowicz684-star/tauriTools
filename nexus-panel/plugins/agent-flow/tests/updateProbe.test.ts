import test from 'node:test';
import assert from 'node:assert/strict';
import { readSrc } from './srcScan';
import { targetFeedUrl, probeFeedTarget } from '../engine/updates';
import { UPDATE_SOURCE_META, type UpdateSource, type UpdateTarget } from '../types';

/**
 * 试跑与正式运行必须走同一份抓取/判定逻辑。
 *
 * ================= 为什么单开一个文件 =================
 *
 * 以前「测试」按钮自己拼 URL、自己 parse、自己 detectUpdate，
 * 正式运行另有完全相同的一份。两份漂开的表现是
 * "试跑说有更新，正式跑却没更新" —— **两边都不报错**，
 * 用户只会觉得这个节点时灵时不灵。
 *
 * 所以这里既测抽出来的那份逻辑本身，也钉住「不许再有第二份」。
 */

const T = (kind: UpdateSource, over: Partial<UpdateTarget> = {}): UpdateTarget =>
  ({ id: 't1', kind, enabled: true, ...over }) as UpdateTarget;

/** 一份最小可用的 RSS */
function rss(id: string, title: string, date = 'Mon, 01 Sep 2025 00:00:00 GMT'): string {
  return `<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>${title}</title><link>https://x/${id}</link><guid>${id}</guid><pubDate>${date}</pubDate></item>
  </channel></rss>`;
}

/* ------------------------------------------------------------------ */
/* 该去哪个地址抓                                                      */
/* ------------------------------------------------------------------ */

test('B站 RSS 模式抓订阅源', () => {
  const r = targetFeedUrl(T('bilibili', { feedUrl: 'https://x/f.xml' }));
  assert.equal(r.url, 'https://x/f.xml');
  assert.equal(r.error, undefined);
});

test('B站 接口模式按 UID 拼地址 —— 没填 UID 要说清楚', () => {
  const ok = targetFeedUrl(T('bilibili', { biliMode: 'api', biliUid: '12345' }));
  assert.match(ok.url, /mid=12345/);

  const bad = targetFeedUrl(T('bilibili', { biliMode: 'api', biliUid: '' }));
  assert.equal(bad.url, '');
  assert.match(bad.error ?? '', /UID/);
});

test('没填订阅源的源要说"没有官方接口"，而不是笼统的失败', () => {
  for (const k of ['wechat', 'xiaohongshu'] as UpdateSource[]) {
    const r = targetFeedUrl(T(k, { feedUrl: '' }));
    assert.equal(r.url, '', `${k} 不该给出地址`);
    /*
     * 小红书没有官方接口 —— 这句话必须说出来，
     * 否则用户填主页地址会一直解析失败且不知为何。
     */
    assert.match(r.error ?? '', /订阅源/);
    assert.match(r.error ?? '', new RegExp(UPDATE_SOURCE_META[k].label));
  }
});

/* ------------------------------------------------------------------ */
/* 抓 + 判定                                                           */
/* ------------------------------------------------------------------ */

test('第一次检查只记基线，不算更新（否则刚配好就触发下游）', async () => {
  const t = T('xiaohongshu', { feedUrl: 'https://x/f.xml' });
  const r = await probeFeedTarget(t, {}, { get: async () => rss('a1', '第一篇') });
  assert.equal(r.baseline, true);
  assert.equal(r.updated, false);
  assert.match(r.reason, /基线/);
});

test('基线没变 → 无更新；变了 → 有更新', async () => {
  const same = await probeFeedTarget(
    T('xiaohongshu', { feedUrl: 'https://x/f.xml', lastSeenId: 'a1' }),
    {},
    { get: async () => rss('a1', '第一篇') },
  );
  assert.equal(same.updated, false);

  const diff = await probeFeedTarget(
    T('xiaohongshu', { feedUrl: 'https://x/f.xml', lastSeenId: 'a1' }),
    {},
    { get: async () => rss('a2', '第二篇', 'Tue, 02 Sep 2025 00:00:00 GMT') },
  );
  assert.equal(diff.updated, true);
  assert.equal(diff.latest?.title, '第二篇');
});

test('解析不出来要报错，不能静默当成"无更新"', async () => {
  /*
   * 公众号 / 小红书的订阅源失效时常常返回**空的**列表或登录页 ——
   * 静默当成"无更新"的话，用户会以为真的没更新，而不是订阅源挂了。
   */
  await assert.rejects(
    probeFeedTarget(T('xiaohongshu', { feedUrl: 'https://x/f.xml' }), {}, {
      get: async () => '<html>登录页</html>',
    }),
    /item|解析|格式|失败/,
  );
});

test('模板会被渲染，且回调拿到的是渲染后的地址', async () => {
  let seen = '';
  const r = await probeFeedTarget(
    T('xiaohongshu', { feedUrl: 'https://x/{{which}}.xml' }),
    { onUrl: (u) => { seen = u; } },
    { get: async () => rss('a1', 'x'), tpl: (s) => s.replace('{{which}}', 'feed') },
  );
  assert.equal(seen, 'https://x/feed.xml');
  assert.equal(r.url, 'https://x/feed.xml');
});

/* ------------------------------------------------------------------ */
/* 不许再有第二份                                                      */
/* ------------------------------------------------------------------ */

test('试跑面板与正式运行都走 probeFeedTarget（不许各写一份）', () => {
  /*
   * 判据是"不再出现拼 URL / parse / detect 的那套动作"。
   * 只查 probeFeedTarget 在不在是不够的：
   * 留着旧代码 + 新加一行调用，照样能过 —— 而那正是会漂的情况。
   */
  const panels = readSrc(
    'components/inspectors/UpdateTestPanel.tsx',
    'components/inspectors/UpdateTargetTest.tsx',
  );
  assert.notEqual(panels.trim(), '', '守卫自身的判据失效了：没读到试跑面板源码');
  for (const dead of ['parseFeed(', 'parseBiliApi(', 'detectUpdate(', 'biliApiUrl(']) {
    assert.ok(!panels.includes(dead), `试跑面板里不该再出现 ${dead} —— 会与正式运行漂开`);
  }
  assert.ok(panels.includes('probeFeedTarget'), '试跑面板应当走 probeFeedTarget');

  const runner = readSrc('engine/runners/update.ts');
  for (const dead of ['parseFeed(', 'parseBiliApi(', 'detectUpdate(', 'biliApiUrl(']) {
    assert.ok(!runner.includes(dead), `执行器里不该再出现 ${dead} —— 抓取与判定已收进 probeFeedTarget`);
  }
  assert.ok(runner.includes('probeFeedTarget'), '执行器应当走 probeFeedTarget');
});

test('合并后的每张卡都能试跑；GitHub 明说不给按钮（不做点了没反应的假按钮）', () => {
  const insp = readSrc('components/inspectors/UpdateInspector.tsx');
  /*
   * 查的是 **JSX 里的使用**，不能只查文件里有没有这个名字 ——
   * import 那行也含这个名字，于是"按钮被删了、import 还在"会假通过。
   * （故障注入验证过：只删 JSX 那处时，含糊的写法确实不报错。）
   */
  assert.match(insp, /<UpdateTargetTest[\s/>]/, '每张卡应当挂上试跑组件');

  /*
   * GitHub 目标走的是另一种通道（需要注入的拉取能力），试跑面板拿不到。
   * 硬做一个"点下去其实没查"的按钮比不做更糟 ——
   * 所以这里钉住：它给的是一句说明，不是按钮。
   */
  assert.match(insp, /GitHub 目标在正式运行时才检查/);
  assert.ok(
    /t\.kind === 'github'[\s\S]{0,200}UpdateTargetTest/.test(insp) === false ||
      /t\.kind === 'github' \?/.test(insp),
    'GitHub 卡不应当给出试跑按钮',
  );
});
