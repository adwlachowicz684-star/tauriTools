import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UPDATE_SOURCE_META, UPDATE_SOURCE_KEYS, FEED_SOURCES, UPDATE_SIDEBAR_SOURCES,
  needsFeedUrl, makeUpdateNode, targetsOf,
  type UpdateSource, type UpdateNodeData,
} from '../types';
import { validateNode } from '../engine/nodeValidate';
import { targetFeedUrl } from '../engine/updates';
import { readSrc } from './srcScan';

/**
 * 更新检测「支持哪些平台」的守卫。
 *
 * ================= 为什么单开一个文件 =================
 *
 * 加平台的动作看着只是往 UPDATE_SOURCE_META 里添一项，
 * 但它牵动四处：订阅源输入框、校验规则、抓取报错、面板分组。
 * 漏掉任何一处都是**静默**的：
 *
 *   漏了输入框   → 那张卡上没地方填地址，界面看着挺完整
 *   漏了校验     → 地址空着也绿灯，跑起来才发现
 *   漏了分组     → 平台在面板里选不到，等于没加
 *
 * 这三类都不会报错，所以必须钉住。
 */

const INSPECTOR = 'components/inspectors/UpdateInspector.tsx';

/* ================================================================== */
/* 元信息齐全                                                          */
/* ================================================================== */

test('每种平台都有名称、图标、提示与颜色', () => {
  for (const k of UPDATE_SOURCE_KEYS) {
    const m = UPDATE_SOURCE_META[k];
    assert.ok(m.label?.trim(), `${k} 缺名称`);
    assert.ok(m.icon?.trim(), `${k} 缺图标`);
    assert.ok(m.hint?.trim(), `${k} 缺提示`);
    assert.ok(/^#|^(var|rgb|hsl)/.test(m.color ?? ''), `${k} 的颜色不是有效值`);
  }
});

test('种类清单非空且不含重复', () => {
  assert.ok(UPDATE_SOURCE_KEYS.length >= 10, '平台种类太少，可能元信息没写全');
  assert.equal(
    new Set(UPDATE_SOURCE_KEYS).size, UPDATE_SOURCE_KEYS.length,
    'UPDATE_SOURCE_META 里有重复键',
  );
});

/* ================================================================== */
/* 订阅源判定                                                          */
/* ================================================================== */

test('FEED_SOURCES 覆盖除两个特例外的全部种类', () => {
  /*
   * FEED_SOURCES 是推导出来的（全部减去 bilibili/github），
   * 这条钉住推导本身没写错 —— 否则加平台会成片失效。
   */
  for (const k of UPDATE_SOURCE_KEYS) {
    if (k === 'bilibili' || k === 'github') continue;
    assert.ok(FEED_SOURCES.includes(k), `${k} 需要订阅源却不在 FEED_SOURCES 里`);
  }
});

test('FEED_SOURCES 不含两个特例', () => {
  /*
   * bilibili 自带两种模式、github 走另一条通道，都不该出现在这里。
   * 若将来加第三个特例，这条会红 —— 那是提醒，不是故障：
   * 改这里的同时必须改 types.ts 里那份推导的注释。
   */
  assert.ok(!FEED_SOURCES.includes('bilibili'), 'B站 由自己那一段画输入框');
  assert.ok(!FEED_SOURCES.includes('github'), 'GitHub 不抓 HTTP');
});

test('needsFeedUrl：B站 看模式，GitHub 永不，其余都要', () => {
  assert.equal(needsFeedUrl('bilibili', 'rss'), true);
  assert.equal(needsFeedUrl('bilibili', 'api'), false);
  assert.equal(needsFeedUrl('github'), false);
  for (const k of FEED_SOURCES) assert.equal(needsFeedUrl(k), true, `${k} 应该要订阅源`);
});

test('需要订阅源的种类都给了地址示例（route）', () => {
  /*
   * 不给示例，用户面对空输入框无从下手：
   * RSSHub 的路由（如 /weibo/user/<uid>）不看文档根本拼不出来。
   */
  for (const k of [...FEED_SOURCES, 'bilibili' as UpdateSource]) {
    const route = UPDATE_SOURCE_META[k].route;
    assert.ok(route && route.startsWith('http'), `${k} 缺订阅源地址示例`);
  }
  // GitHub 走另一条通道，不该给订阅源示例（给了反而误导）
  assert.equal(UPDATE_SOURCE_META.github.route, undefined);
});

/* ================================================================== */
/* 侧栏与面板                                                          */
/* ================================================================== */

test('侧栏精选都是合法种类，且含兜底那一项', () => {
  for (const k of UPDATE_SIDEBAR_SOURCES) {
    assert.ok(UPDATE_SOURCE_META[k], `侧栏列出的 ${k} 不是已知种类`);
  }
  /*
   * 「自定义订阅源」必须露面：无论内置多少平台，总有覆盖不到的。
   * 把它藏起来等于把兜底口子堵上。
   */
  assert.ok(UPDATE_SIDEBAR_SOURCES.includes('custom'), '侧栏要有自定义订阅源这个兜底入口');
});

test('面板分组覆盖全部种类，且每种恰好出现一次', () => {
  const src = readSrc(INSPECTOR);
  const block = /UPDATE_SOURCE_GROUPS[\s\S]*?^\];/m.exec(src);
  assert.ok(block, '找不到 UPDATE_SOURCE_GROUPS');

  /*
   * 必须带 0-9：'v2ex' 这类含数字的种类名会被纯 [a-z] 漏掉。
   * （这一条就是写错正则时炸出来的 —— 报错的是守卫，不是代码。）
   */
  const kinds = [...block[0].matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);
  for (const k of UPDATE_SOURCE_KEYS) {
    assert.equal(
      kinds.filter((x) => x === k).length, 1,
      `${k} 在面板分组里应该恰好出现一次（当前 ${kinds.filter((x) => x === k).length} 次）`,
    );
  }
});

test('订阅源输入框按 FEED_SOURCES 判定，不列举种类名', () => {
  const src = readSrc(INSPECTOR);
  /*
   * 早先写的是 `kind === 'wechat' || kind === 'xiaohongshu'`，
   * 于是每加一个平台都要记得回来加一个 || ——
   * 漏一个的表现是那张卡上没有输入框，而界面完全正常。
   */
  assert.ok(
    /FEED_SOURCES\.includes\(/.test(src),
    '订阅源输入框必须按 FEED_SOURCES 判定，加平台才能自动生效',
  );
  assert.ok(
    !/kind\s*===\s*'wechat'\s*\|\|/.test(src),
    '不该再出现列举种类名的写法',
  );
});

test('试跑组件必须真的渲染，而不只是 import', () => {
  /*
   * 这条是盲测炸出来的：UpdateTargetTest 被 import 了却从未渲染，
   * 于是"每张卡都能试跑"是句空话 —— 组件写好了、按钮没接，
   * 界面上安静地少一块，谁也不会报错。
   */
  const src = readSrc(INSPECTOR);
  assert.ok(/<UpdateTargetTest/.test(src), 'UpdateTargetTest 必须渲染出来');
});

/* ================================================================== */
/* 行为：新平台自动跟上校验与报错                                        */
/* ================================================================== */

test('订阅源空着时，每个订阅源类目标都判红', () => {
  for (const kind of FEED_SOURCES) {
    const base = makeUpdateNode('n1', kind).data as UpdateNodeData;
    const d = {
      ...base,
      targets: [{ id: 't', kind, enabled: true, biliMode: 'rss', feedUrl: '' }],
    };
    const r = validateNode({ id: 'n1', data: d } as never);
    assert.equal(r.level, 'error', `${kind} 订阅源空着必须判红，否则会绿灯跑空`);
  }
});

test('订阅源空着时，报错里带上该平台的地址示例', () => {
  for (const kind of FEED_SOURCES) {
    const r = targetFeedUrl({ id: 't', kind, feedUrl: '' });
    assert.equal(r.url, '', `${kind} 没填地址时不该去抓`);
    assert.ok(r.error, `${kind} 要给出说法`);
    const route = UPDATE_SOURCE_META[kind].route!;
    assert.ok(
      r.error!.includes(route),
      `${kind} 的报错要带上地址示例，否则用户不知道该填什么（实际：${r.error}）`,
    );
  }
});

test('每种平台都能建出节点，且卡片种类名取得到', () => {
  for (const kind of UPDATE_SOURCE_KEYS) {
    const d = makeUpdateNode('n1', kind).data as UpdateNodeData;
    const list = targetsOf(d);
    assert.equal(list.length, 1, `${kind} 建出来应该有一张卡`);
    assert.equal(list[0].kind, kind);
    assert.ok(UPDATE_SOURCE_META[list[0].kind].label, `${kind} 卡片渲染时取不到种类名`);
  }
});
