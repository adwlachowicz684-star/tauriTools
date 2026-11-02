/*
 * env.vars（旧称）里的带凭据地址也要挖
 *
 * ============ 实测（改之前）============
 *
 *   redactParams([{ name:'接口地址', value:'https://x.y/v1?token=sk-env-url' }])
 *     → 'https://x.y/v1?token='                      ✅ 挖了
 *   redactEnv({ 接口地址: 'https://x.y/v1?token=sk-env-url' })
 *     → 'https://x.y/v1?token=sk-env-url'            ❌ 原样
 *   redactCanvasConfig({ env:{ vars:{ 接口地址: 上面那个 } } })
 *     → 'https://x.y/v1?token=sk-env-url'            ❌ 原样落盘
 *
 * ============ 为什么这是"说了没做" ============
 *
 * validateCanvasConfig 走的是 migrateEnvVars 合并后的那份参数表，
 * 于是界面明明白白报出：
 *
 *   值里含凭据（地址参数或 user:pw@）—— 存盘与导出时会被挖掉
 *
 * 而存盘那条路（redactCanvasConfig → redactEnv）只按**名字**判，
 * 中文名里一个 token 字样都没有 → 一个字不挖。
 *
 * 承诺是"会被挖掉"，实际明文进 localStorage、进工具栏导出的画布文件。
 *
 * ============ 形态 ============
 *
 * env.vars 是旧称（界面早已不再往里写），但老存档里填过的值还在，
 * 且读取时 migrateEnvVars 会把它搬进 params —— 搬过去之后是要挖的。
 * 同一份值，在 params 里挖、留在 env.vars 里不挖。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { redactEnv, redactParams, paramStoredValue, redactCanvasConfig } from '../engine/canvasStore';
import { migrateEnvVars, paramIssues } from '../engine/canvasParams';
import { validateCanvasConfig } from '../engine/canvasConfig';
import { readSrc } from './srcScan';

const REL = path.join('engine', 'canvasStore.ts');

const CARD = {
  name: '接口地址',
  value: 'https://x.y/v1?token=sk-env-url',
};

/* ================================================================== */
/* 一、正例                                                            */
/* ================================================================== */

test('行为: env.vars 里带凭据的地址要挖（与参数卡同口径）', () => {
  const r = redactEnv({ 接口地址: CARD.value });
  assert.equal(r['接口地址'], 'https://x.y/v1?token=');
});

test('行为: 整个画布配置脱敏也要挖到 env.vars', () => {
  const cfg = { mcpServers: [], env: { vars: { 接口地址: CARD.value } }, params: [] } as never;
  const r = redactCanvasConfig(cfg) as { env: { vars: Record<string, string> } };
  assert.equal(r.env.vars['接口地址'], 'https://x.y/v1?token=');
});

test('行为: user:pw@ 形态也要挖（口令挖掉，用户名留着）', () => {
  const r = redactEnv({ 地址: 'https://u:p@a.b/v1' })['地址'];
  assert.ok(!r.includes(':p@'), `口令没挖掉：${r}`);
  assert.ok(r.startsWith('https://'), `地址被整份弄没了：${r}`);
});

test('行为: 名字像密钥的照旧清空', () => {
  assert.equal(redactEnv({ GITHUB_TOKEN: 'ghp_env_aaa' }).GITHUB_TOKEN, '');
});

test('行为: env.vars 与 params 对同一个值结果一致（不再分叉）', () => {
  const viaEnv = redactEnv({ 接口地址: CARD.value })['接口地址'];
  const viaParam = paramStoredValue({ id: 'p', name: CARD.name, value: CARD.value });
  assert.equal(viaEnv, viaParam);
});

test('行为: 迁移进 params 的老变量，存盘后同样不含凭据', () => {
  const migrated = migrateEnvVars([], { 接口地址: CARD.value });
  const stored = redactParams(migrated);
  assert.ok(!JSON.stringify(stored).includes('sk-env-url'), `仍然泄露：${JSON.stringify(stored)}`);
});

test('行为: 界面报了"会被挖掉"，那它就真的要被挖掉', () => {
  const cfg = { mcpServers: [], env: { vars: { 接口地址: CARD.value } }, params: [] } as never;
  const issues = validateCanvasConfig(cfg);
  const promised = issues.some((i) => i.message.includes('会被挖掉'));
  assert.ok(promised, '界面没报 —— 这条守卫失去了前提');
  assert.ok(paramIssues(migrateEnvVars([], { 接口地址: CARD.value })).length > 0);
  const out = redactCanvasConfig(cfg) as { env: { vars: Record<string, string> } };
  assert.ok(!JSON.stringify(out.env.vars).includes('sk-env-url'), '报了却没挖');
});

/* ================================================================== */
/* 二、反例：防过度修复                                                 */
/* ================================================================== */

test('反例: 普通值原样留下', () => {
  assert.equal(redactEnv({ 输出目录: 'D:\\项目甲\\out' })['输出目录'], 'D:\\项目甲\\out');
});

test('反例: 模板引用不动', () => {
  assert.equal(redactEnv({ 令牌: '{{login.token}}' })['令牌'], '{{login.token}}');
});

test('反例: 路径里的 token 不当凭据（不是查询参数）', () => {
  const v = 'https://api.x.com/v1/token/refresh';
  assert.equal(redactEnv({ 地址: v })['地址'], v);
});

test('反例: 散文里夹一句地址不动（不是以 scheme 开头的整串）', () => {
  const v = '详见 https://x.y?token=abc 的说明';
  assert.equal(redactEnv({ 说明: v })['说明'], v);
});

/* ================================================================== */
/* 三、源码守卫                                                         */
/* ================================================================== */

test('守卫: blankEnvVars 与参数卡共用一份 scrubUrlSecrets', () => {
  const s = readSrc(REL);
  assert.ok(s.includes('scrubUrlSecrets'), 'canvasStore 没用 scrubUrlSecrets');
  /* 两处出现：paramStoredValue 与 blankEnvVars 各一 —— 不另写一份 */
  assert.ok(s.split('scrubUrlSecrets').length >= 3, '只在一处出现 —— 说明另一处另写了');
});

test('守卫自身: 源码真的读到了', () => {
  assert.ok(readSrc(REL).length > 8000, 'canvasStore.ts 太短 —— 指错地方了');
});
