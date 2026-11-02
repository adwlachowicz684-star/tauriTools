/*
 * 画布参数卡里的地址凭据
 *
 * ============ 这个洞长什么样 ============
 *
 * 同一个「值里躺着凭据的地址」，三个出口此前只有两处挡了：
 *
 *   节点 data 的 baseUrl  → https://a.b/v1?api_key=      ✅（blankSecretNamed）
 *   MCP 服务的 url        → https://a.b/v1?api_key=      ✅（redactServerUrl）
 *   画布参数卡的 baseUrl  → https://a.b/v1?api_key=sk-live  ❌ 原样
 *
 * 参数卡是「跟着画布存档走」的（模块复用时每张画布各填各的值），
 * 于是它会明文进 localStorage、进导出的画布文件 ——
 * 而这个模块自己的注释写着「填在卡里的密钥会跟着导出的画布一起出去」。
 *
 * 名字判据在这里尤其不够用：参数名**允许中文**，
 * 叫「接口地址」的卡片名字里一个 url 字样都没有。
 *
 * ============ 为什么看值不看名字 ============
 *
 * scrubUrlSecrets 只认**以 scheme 开头的整串**，
 * 所以散文里夹一句地址（「详见 https://x.com?token=abc」）不会被改动 ——
 * 参数值是用户手填的配置，不是 AI 生成的自由文本，
 * 与节点侧「不去扫 output」那条边界的风险不同。
 *
 * ============ 为什么要报出来 ============
 *
 * 存盘会把它挖掉。不说的话：用户填了、界面上还显示着，
 * 刷新回来发现被截断了却不知道为什么 —— 与节点侧「挖了要说」同一条。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { AF_SRC, readSrc } from './srcScan';
import { scrubUrlSecrets } from '../engine/sanitize';
import { paramIssues } from '../engine/canvasParams';
import { paramStoredValue, redactParams, redactCanvasConfig } from '../engine/canvasStore';
import type { CanvasParam } from '../engine/canvasParams';

const REL_STORE = path.join('engine', 'canvasStore.ts');
const REL_PARAMS = path.join('engine', 'canvasParams.ts');

function card(name: string, value: string, valueType?: CanvasParam['valueType']): CanvasParam {
  return { id: 'p', name, value, ...(valueType ? { valueType } : {}) } as CanvasParam;
}

/* ================================================================== */
/* 一、正例：值里躺着凭据                                               */
/* ================================================================== */

test('行为: 名字像地址的卡片要挖掉查询参数里的密钥', () => {
  assert.equal(
    paramStoredValue(card('baseUrl', 'https://a.b/v1?api_key=sk-live-999')),
    'https://a.b/v1?api_key=',
  );
});

test('行为: userinfo 要挖', () => {
  assert.equal(
    paramStoredValue(card('baseUrl', 'https://u:p@a.b/v1')),
    'https://u:@a.b/v1',
  );
});

test('行为: 中文名的卡片也要挖 —— 名字判据在这里不够用', () => {
  assert.equal(
    paramStoredValue(card('接口地址', 'https://a.b/v1?token=ghp_z')),
    'https://a.b/v1?token=',
  );
});

test('行为: 出口 —— 整份画布配置脱敏时参数卡跟着挖', () => {
  const out = redactCanvasConfig({
    mcpServers: [],
    env: { vars: {} },
    params: [card('接口地址', 'https://a.b/v1?token=ghp_z')],
  } as never);
  assert.equal(out.params[0].value, 'https://a.b/v1?token=');
});

test('行为: redactParams 逐张挖', () => {
  const r = redactParams([
    card('a', 'https://a.b?api_key=sk-1'),
    card('b', 'https://c.d/e'),
  ]);
  assert.equal(r[0].value, 'https://a.b?api_key=');
  assert.equal(r[1].value, 'https://c.d/e');
});

/* ================================================================== */
/* 二、反例：防过度修复                                                 */
/* ================================================================== */

test('反例: 不带凭据的地址原样留下', () => {
  const v = 'https://a.b/v1?transport=sse&keyword=abc';
  assert.equal(paramStoredValue(card('baseUrl', v)), v);
});

test('反例: 路径里的 token 不动', () => {
  const v = 'https://a.b/v1/token/refresh';
  assert.equal(paramStoredValue(card('baseUrl', v)), v);
});

test('反例: 散文里夹一句地址不动 —— 不以 scheme 开头就整串不认', () => {
  const v = '详见 https://a.b?token=abc 的说明';
  assert.equal(paramStoredValue(card('说明', v)), v);
});

test('反例: 数字卡不动（名字带 token 也不能清空）', () => {
  assert.equal(paramStoredValue(card('maxTokens', '4096', 'num')), '4096');
});

test('反例: 普通值原样留下', () => {
  assert.equal(paramStoredValue(card('输出目录', 'D:\\项目甲\\out')), 'D:\\项目甲\\out');
});

test('反例: 老数据没标 valueType 时名字像密钥仍要清空（原有行为不能丢）', () => {
  assert.equal(paramStoredValue(card('apiKey', 'sk-abc')), '');
});

/* ================================================================== */
/* 三、报告：存盘会挖掉，得说                                           */
/* ================================================================== */

test('行为: 值里含凭据时 paramIssues 要报出来', () => {
  const issues = paramIssues([card('接口地址', 'https://a.b/v1?token=ghp_z')]);
  assert.ok(
    issues.some((i) => i.message.includes('凭据')),
    '没报出来 —— 用户会看到值被截断却不知道为什么',
  );
});

test('反例: 干净地址不报（别把提示喊成噪音）', () => {
  const issues = paramIssues([card('baseUrl', 'https://a.b/v1')]);
  assert.equal(issues.length, 0);
});

test('反例: 散文不报', () => {
  const issues = paramIssues([card('说明', '详见 https://a.b?token=abc 的说明')]);
  assert.equal(issues.length, 0);
});

/* ================================================================== */
/* 四、源码守卫                                                         */
/* ================================================================== */

test('守卫: redactParams 走 scrubUrlSecrets，不另写一份地址判据', () => {
  const s = readSrc(REL_STORE);
  assert.ok(s.includes('scrubUrlSecrets('), 'canvasStore 没用 scrubUrlSecrets');
});

test('守卫: paramIssues 与存盘用同一份判据（说了就得做）', () => {
  const s = readSrc(REL_PARAMS);
  assert.ok(s.includes('scrubUrlSecrets('), 'canvasParams 没用 scrubUrlSecrets —— 口径会漂');
});

test('守卫自身: 源码真的读到了，且判据只认整串地址', () => {
  assert.ok(AF_SRC.length > 0, 'AF_SRC 是空的 —— 守卫会假通过');
  assert.ok(readSrc(REL_STORE).length > 5000, 'canvasStore.ts 太短 —— 指错地方了');
  assert.ok(readSrc(REL_PARAMS).length > 5000, 'canvasParams.ts 太短 —— 指错地方了');
  // 散文不该被动 —— 这条钉住"看值不看名字"不会滑向"看到就挖"
  const v = '见 https://a.b?token=abc';
  assert.equal(scrubUrlSecrets(v), v, 'scrubUrlSecrets 不该动非地址开头的串');
});
