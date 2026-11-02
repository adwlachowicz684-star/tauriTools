/*
 * 地址里躺着的凭据
 *
 * ============ 这个洞长什么样 ============
 *
 * 请求头那一侧有 redactHeadersText 盯着，地址这一侧此前**什么都没有**：
 *
 *   headersText: 'Authorization: Bearer sk-x'   → 'Authorization:'   ✅ 挖掉
 *   url: 'https://api.x.com/v1?api_key=sk-live' → 原样               ❌ 明文落盘
 *   feedUrl: 'https://h.com/f?token=ghp_z'      → 原样               ❌
 *   url: 'https://user:pw@api.x.com/v1'         → 原样               ❌
 *
 * 同一个密钥，写在 Authorization 头里会被挖掉，拼进地址里就明文进存档、
 * 进导出的画布文件。而"最顺手填凭据的地方"恰恰是把 API 服务商给的那串
 * 完整 URL 直接粘进来 —— 里面多半带 key / token 参数。
 *
 * ============ 为什么只动查询参数名与 userinfo ============
 *
 * 不动路径：`https://api.x.com/v1/token/refresh` 里的 token 是路径不是凭据，
 * 按"字符串里含 token"去挖会把正常接口地址改坏。
 *
 * ============ 为什么加在 blankSecretNamed 而不是各出口 ============
 *
 * 一处改动会同时落到三个地方：
 *   · hadInlineSecret（它最后一步就是"挖一遍看有没有变化"）→ 界面提示自动出现
 *   · nodeDefaults 的 redacted 清单 → 存成默认时如实说"值里的密钥已挖掉"
 *   · 画布 / 模块 / 变量 / 预设的脱敏 → 真正挖掉
 *
 * 各出口自己写一份判定的后果已经见过（webhook token 明文落盘那次）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { AF_SRC, readSrc } from './srcScan';
import {
  scrubUrlSecrets,
  looksLikeUrlKey,
  hadInlineSecret,
  stripSecrets,
  redactNodeSecrets,
} from '../engine/sanitize';
import { redactSecrets } from '../engine/canvasStore';

const REL = path.join('engine', 'sanitize.ts');

/* ================================================================== */
/* 一、地址里的凭据要挖掉                                               */
/* ================================================================== */

test('行为: 查询参数里的 api_key 要挖', () => {
  assert.equal(
    scrubUrlSecrets('https://api.x.com/v1/data?api_key=sk-live-abc123'),
    'https://api.x.com/v1/data?api_key=',
  );
});

test('行为: 多个参数只挖像密钥的那个', () => {
  assert.equal(
    scrubUrlSecrets('https://h.com/feed?token=ghp_zzz&page=2&limit=10'),
    'https://h.com/feed?token=&page=2&limit=10',
  );
});

test('行为: userinfo 里的口令要挖', () => {
  assert.equal(
    scrubUrlSecrets('https://user:pw@api.x.com/v1'),
    'https://user:@api.x.com/v1',
  );
});

test('行为: 大小写与下划线都认（apiKey / access_token / APIKEY）', () => {
  assert.equal(scrubUrlSecrets('https://a.com/?apiKey=x'), 'https://a.com/?apiKey=');
  assert.equal(scrubUrlSecrets('https://a.com/?access_token=x'), 'https://a.com/?access_token=');
  assert.equal(scrubUrlSecrets('https://a.com/?APIKEY=x'), 'https://a.com/?APIKEY=');
});

/* ================================================================== */
/* 二、反例：别把不是凭据的也挖了                                        */
/* ================================================================== */

test('反例: 路径里的 token 不动（防过度修复）', () => {
  /*
   * 只盯"要挖"的话，按 `s.includes('token')` 一刀切也能通过前面的用例 ——
   * 但那会把 /v1/token/refresh 这种正常接口地址改坏。
   */
  const u = 'https://api.x.com/v1/token/refresh';
  assert.equal(scrubUrlSecrets(u), u);
});

test('反例: 普通查询参数不动', () => {
  const u = 'https://a.com/s?page=1&keyword=abc&keyColor=red';
  assert.equal(scrubUrlSecrets(u), u, 'key 不在 hint 里 —— 与参数名判据同口径，不加裸 key');
});

test('反例: 不是地址的字符串原样返回', () => {
  assert.equal(scrubUrlSecrets('随便一段文本 token=abc'), '随便一段文本 token=abc');
  assert.equal(scrubUrlSecrets(''), '');
});

test('反例: 带片段（#）时不能把它弄丢', () => {
  assert.equal(
    scrubUrlSecrets('https://a.com/p?token=x#frag'),
    'https://a.com/p?token=#frag',
  );
});

test('反例: 端口与 @ 混在一起时不误判 userinfo', () => {
  /* https://x.com:8080/?email=a@b.com —— 冒号后面是端口，不是口令 */
  const u = 'https://x.com:8080/?email=a@b.com';
  assert.equal(scrubUrlSecrets(u), u);
});

/* ================================================================== */
/* 三、地址字段的识别                                                   */
/* ================================================================== */

test('行为: url / feedUrl / base_url / imageUrl 都算地址字段', () => {
  for (const k of ['url', 'feedUrl', 'base_url', 'imageUrl', 'biliApiUrl', 'html_url']) {
    assert.ok(looksLikeUrlKey(k), `${k} 该算地址字段`);
  }
});

test('反例: curl 不是地址字段（它是命令名）', () => {
  assert.equal(looksLikeUrlKey('curl'), false);
  assert.equal(looksLikeUrlKey('cUrl'), false);
});

test('反例: output / label 不是地址字段 —— 不去扫生成的文本', () => {
  /*
   * 这条边界与 redactNodeSecrets「不去递归扫 output」是同一条：
   * 用户让 AI 写一段含 ?token= 的说明，不该被改。
   *
   * ⚠️ 第一版这里用的是「见 https://x.com/?token=abc 的说明」——
   * 而 scrubUrlSecrets 要求字符串以 scheme 开头，这句根本匹配不上，
   * 于是"把 looksLikeUrlKey 限制去掉"也能全绿 —— 守卫是假的。
   * 故障注入 C 就是这么漏过去的（红 0）。所以改成**整值就是一个地址**。
   */
  assert.equal(looksLikeUrlKey('output'), false);
  assert.equal(looksLikeUrlKey('label'), false);
  const n = { id: 'n', data: { kind: 'llm', output: 'https://x.com/?token=abc' } };
  const r = redactNodeSecrets(n) as { data: Record<string, unknown> };
  assert.equal(r.data.output, 'https://x.com/?token=abc', 'output 里的地址不该被改');
  const m = { id: 'n', data: { kind: 'llm', label: 'https://x.com/?api_key=sk-1' } };
  const r2 = redactNodeSecrets(m) as { data: Record<string, unknown> };
  assert.equal(r2.data.label, 'https://x.com/?api_key=sk-1', 'label 里的地址不该被改');
});

/* ================================================================== */
/* 四、落到一个出口上：画布 / 提示 / 默认值                              */
/* ================================================================== */

function canvasWith(data: Record<string, unknown>) {
  return {
    canvases: [{ id: 'c1', name: 'n', nodes: [{ id: 'n1', data }], edges: [], createdAt: 1, updatedAt: 1 }],
    activeId: 'c1',
  } as never;
}

test('出口: 画布存档里的地址密钥要挖', () => {
  const r = redactSecrets(canvasWith({ kind: 'http', url: 'https://a.com/?api_key=sk-1' })) as {
    canvases: { nodes: { data: Record<string, unknown> }[] }[];
  };
  assert.equal(r.canvases[0].nodes[0].data.url, 'https://a.com/?api_key=');
});

test('出口: hadInlineSecret 要跟着变真 —— 否则界面一句提示都没有', () => {
  /*
   * 挖了却不提示，用户会以为自己填的东西是安全的。
   * 这一条盯的是"挖"与"说"不能分家。
   */
  assert.ok(hadInlineSecret({ kind: 'http', url: 'https://a.com/?api_key=sk-1' }));
  assert.ok(hadInlineSecret({ kind: 'update', feedUrl: 'https://h.com/f?token=ghp_z' }));
});

test('出口: stripSecrets 与 redactSecrets 结果一致（同一把尺子）', () => {
  const d = { kind: 'http', url: 'https://a.com/?api_key=sk-1' };
  const a = stripSecrets({ ...d }) as Record<string, unknown>;
  const b = (redactSecrets(canvasWith(d)) as { canvases: { nodes: { data: Record<string, unknown> }[] }[] })
    .canvases[0].nodes[0].data;
  assert.equal(a.url, b.url);
});

/* ================================================================== */
/* 五、源码守卫                                                         */
/* ================================================================== */

test('守卫: 地址脱敏只有一份（不许出口各写一份）', () => {
  const s = readSrc(REL);
  /* 剥注释后仍能找到 scrubUrlSecrets 的调用 —— 说明它真被接上了 */
  assert.ok(
    s.includes('scrubUrlSecrets(v)'),
    'blankSecretNamed 里没调 scrubUrlSecrets —— 判据写了没人用',
  );
});

test('守卫自身: AF_SRC 指向真仓库', () => {
  assert.ok(AF_SRC.length > 0, 'AF_SRC 是空的');
  assert.ok(readSrc(REL).length > 5000, '读到的 sanitize.ts 太短 —— 指错地方了');
});
