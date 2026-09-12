import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFeed, parseBiliApi, detectUpdate, pickLatest, sortByNewest,
  extractBiliUid, biliApiUrl, BILI_REFERER,
} from '../engine/updates';
import { renderTemplate } from '../engine/template';

/* ================================================================== */
/* RSS 2.0                                                            */
/* ================================================================== */

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>某公众号</title>
  <item>
    <title><![CDATA[第三篇 &amp; 最新]]></title>
    <link>https://mp.weixin.qq.com/s/ccc</link>
    <guid>ccc-guid</guid>
    <pubDate>Mon, 10 Feb 2025 10:00:00 GMT</pubDate>
  </item>
  <item>
    <title>第二篇</title>
    <link>https://mp.weixin.qq.com/s/bbb</link>
    <guid>bbb-guid</guid>
    <pubDate>Sun, 09 Feb 2025 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

test('RSS: 解析条目', () => {
  const r = parseFeed(RSS);
  assert.equal(r.error, null);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].id, 'ccc-guid');
});

test('RSS: 解码 CDATA 与实体', () => {
  const r = parseFeed(RSS);
  // CDATA 里的 &amp; 应还原成 &，而不是留下 &amp;
  assert.equal(r.items[0].title, '第三篇 & 最新');
});

test('RSS: 空响应报错而非静默返回空', () => {
  const r = parseFeed('');
  assert.ok(r.error);
  assert.equal(r.items.length, 0);
});

test('RSS: 非 XML（错误页）被识别', () => {
  const r = parseFeed('<html><body>404 Not Found</body></html>');
  assert.ok(r.error, 'HTML 错误页必须报错，否则会被当成"没有更新"');
});

test('RSS: 没有 item 时报错', () => {
  const r = parseFeed('<rss version="2.0"><channel><title>x</title></channel></rss>');
  assert.ok(r.error);
});

/* ================================================================== */
/* Atom                                                               */
/* ================================================================== */

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>某公众号</title>
  <entry>
    <title>新文章</title>
    <link rel="alternate" type="text/html" href="https://mp.weixin.qq.com/s/aaa"/>
    <id>tag:mp,2025:aaa</id>
    <updated>2025-02-11T08:00:00Z</updated>
  </entry>
  <entry>
    <title>旧文章</title>
    <link rel="alternate" href="https://mp.weixin.qq.com/s/zzz"/>
    <id>tag:mp,2025:zzz</id>
    <updated>2025-02-01T08:00:00Z</updated>
  </entry>
</feed>`;

test('Atom: 解析 entry', () => {
  const r = parseFeed(ATOM);
  assert.equal(r.error, null);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].id, 'tag:mp,2025:aaa');
});

test('Atom: 从 link 的 href 取地址', () => {
  const r = parseFeed(ATOM);
  assert.equal(r.items[0].url, 'https://mp.weixin.qq.com/s/aaa');
});

test('Atom: 优先 rel=alternate 的链接', () => {
  const xml = `<feed><entry>
    <title>t</title>
    <link rel="self" href="https://self.example"/>
    <link rel="alternate" href="https://alt.example"/>
    <id>x</id>
  </entry></feed>`;
  const r = parseFeed(xml);
  assert.equal(r.items[0].url, 'https://alt.example');
});

test('RSS 与 Atom 都能被 parseFeed 处理', () => {
  assert.equal(parseFeed(RSS).error, null);
  assert.equal(parseFeed(ATOM).error, null);
});

/* ================================================================== */
/* B站                                                                */
/* ================================================================== */

test('B站: 从主页链接提取 UID', () => {
  assert.equal(extractBiliUid('https://space.bilibili.com/672328094'), '672328094');
});

test('B站: 主页链接带参数也能提取', () => {
  assert.equal(
    extractBiliUid('https://space.bilibili.com/672328094?spm_id_from=333.999'),
    '672328094',
  );
});

test('B站: 纯数字当 UID', () => {
  assert.equal(extractBiliUid('  123456  '), '123456');
});

test('B站: 认不出时返回 null', () => {
  assert.equal(extractBiliUid('https://www.bilibili.com/video/BV1xx'), null);
  assert.equal(extractBiliUid(''), null);
});

test('B站: 接口地址带 pn/ps/order', () => {
  const u = biliApiUrl('123');
  assert.ok(u.includes('mid=123'));
  assert.ok(u.includes('order=pubdate'));
});

test('B站: 用 wbi 版接口（老接口已下线）', () => {
  assert.ok(biliApiUrl('1').includes('/x/space/wbi/arc/search'));
});

test('B站: Referer 常量可供给请求头用', () => {
  assert.equal(BILI_REFERER, 'https://www.bilibili.com/');
});

test('B站: 403 给出可操作提示', () => {
  const r = parseBiliApi(JSON.stringify({ code: -403 }));
  assert.ok(r.error.includes('403'));
  assert.ok(r.riskMessage);
});

test('B站: 用 wbi 版接口（老接口已下线）', () => {
  // /x/space/arc/search 与 /x/space/arc/list 已下线，不带签名会被直接拒绝
  assert.ok(biliApiUrl('1').includes('/x/space/wbi/arc/search'));
});

test('B站: 有 Referer 常量可供给请求头用', () => {
  assert.equal(BILI_REFERER, 'https://www.bilibili.com/');
});

test('B站: 403 给出可操作提示', () => {
  const r = parseBiliApi(JSON.stringify({ code: -403 }));
  assert.ok(r.error.includes('403'));
  assert.ok(r.riskMessage);
});

const BILI_OK = JSON.stringify({
  code: 0,
  data: {
    list: {
      vlist: [
        { bvid: 'BV1new', title: '新视频', created: 1739000000 },
        { bvid: 'BV1old', title: '旧视频', created: 1738000000 },
      ],
    },
  },
});

test('B站: 解析投稿列表', () => {
  const r = parseBiliApi(BILI_OK);
  assert.equal(r.error, null);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].id, 'BV1new');
  assert.equal(r.items[0].url, 'https://www.bilibili.com/video/BV1new');
});

test('B站: created 转成时间字符串', () => {
  const r = parseBiliApi(BILI_OK);
  assert.ok(r.items[0].date.length > 0);
  assert.equal(Number.isNaN(Date.parse(r.items[0].date)), false);
});

test('B站: -352 风控给出可操作提示', () => {
  const r = parseBiliApi(JSON.stringify({ code: -352, message: '请求错误' }));
  assert.ok(r.error);
  assert.ok(r.error.includes('SESSDATA') || r.error.includes('风控'), '应提示填 Cookie 或换 RSS');
  assert.ok(r.riskMessage, '风控时应带 riskMessage 供界面高亮');
});

test('B站: -404 提示 UID 有误', () => {
  const r = parseBiliApi(JSON.stringify({ code: -404 }));
  assert.ok(r.error.includes('UID'));
});

test('B站: 非 JSON 响应被识别', () => {
  const r = parseBiliApi('<html>风控拦截页</html>');
  assert.ok(r.error);
});

test('B站: 空投稿列表报错', () => {
  const r = parseBiliApi(JSON.stringify({ code: 0, data: { list: { vlist: [] } } }));
  assert.ok(r.error);
});

/* ================================================================== */
/* 更新判定                                                            */
/* ================================================================== */

const ITEMS = [
  { id: 'new', title: '新的', url: 'u1', date: '2025-02-11T00:00:00Z' },
  { id: 'old', title: '旧的', url: 'u2', date: '2025-02-01T00:00:00Z' },
];

test('判定: 无基线时默认不算更新，只记基线', () => {
  const r = detectUpdate({ items: ITEMS, lastSeenId: '' });
  assert.equal(r.updated, false);
  assert.equal(r.baseline, true);
  assert.ok(r.reason.includes('基线'));
});

test('判定: 无基线但开了 firstRunAsUpdate 则算更新', () => {
  const r = detectUpdate({ items: ITEMS, lastSeenId: '', firstRunAsUpdate: true });
  assert.equal(r.updated, true);
  assert.equal(r.baseline, true);
});

test('判定: 最新 id 与基线相同 → 无更新', () => {
  const r = detectUpdate({ items: ITEMS, lastSeenId: 'new' });
  assert.equal(r.updated, false);
  assert.equal(r.baseline, false);
});

test('判定: 最新 id 变了 → 有更新，并给出新条目', () => {
  const r = detectUpdate({ items: ITEMS, lastSeenId: 'old' });
  assert.equal(r.updated, true);
  assert.equal(r.latest?.id, 'new');
  assert.ok(r.reason.includes('发现更新'));
});

test('判定: 基线已不在列表中也能识别为更新', () => {
  const r = detectUpdate({ items: ITEMS, lastSeenId: 'deleted-video' });
  assert.equal(r.updated, true);
  assert.ok(r.reason.includes('已不在列表'));
});

test('判定: 空列表不算更新', () => {
  const r = detectUpdate({ items: [], lastSeenId: 'x' });
  assert.equal(r.updated, false);
  assert.ok(r.reason.includes('没有'));
});

/* ================================================================== */
/* 排序                                                                */
/* ================================================================== */

test('pickLatest: 按时间取最新', () => {
  const unordered = [ITEMS[1], ITEMS[0]];
  assert.equal(pickLatest(unordered)?.id, 'new');
});

test('pickLatest: 时间缺失时保持原顺序', () => {
  const noDate = [
    { id: 'a', title: '', url: '', date: '' },
    { id: 'b', title: '', url: '', date: '' },
  ];
  assert.equal(pickLatest(noDate)?.id, 'a');
});

test('sortByNewest: 最新排到第一', () => {
  const sorted = sortByNewest([ITEMS[1], ITEMS[0]]);
  assert.equal(sorted[0].id, 'new');
  assert.equal(sorted.length, 2);
});

/* ================================================================== */
/* 模板：节点附加字段                                                   */
/* ================================================================== */

test('模板: 能取到节点的附加字段', () => {
  const r = renderTemplate('标题={{n1.title}} 链接={{n1.url}}', {
    outputs: { n1: 'true' },
    fields: { n1: { title: '某视频', url: 'https://x' } },
  });
  assert.equal(r.text, '标题=某视频 链接=https://x');
});

test('模板: 附加字段缺失时保留原样', () => {
  const r = renderTemplate('v={{n1.title}}', {
    outputs: { n1: 'true' },
    fields: { n1: {} },
  });
  assert.equal(r.text, 'v={{n1.title}}');
  assert.ok(r.missing.includes('n1.title'));
});

test('模板: 主输出仍是 output', () => {
  const r = renderTemplate('{{n1}}', { outputs: { n1: 'false' } });
  assert.equal(r.text, 'false');
});
