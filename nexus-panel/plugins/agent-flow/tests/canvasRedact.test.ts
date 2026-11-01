/*
 * 画布配置脱敏：参数卡按**值的种类**判，env 判据收成一份
 *
 * 为什么单独一个文件：
 * 这两处都属于「判据多写了一份」那一族 —— 本次修的两处都**今天看不出问题**
 * （两份实现逐字相同 / 数字参数卡名字带 token 的场景还没人填），
 * 只有真去跑一遍才看得出差别，而扫源码的守卫抓不住
 * （`out[k] = v` 与 `out[k] = 判据 ? '' : v` 都"看起来在脱敏"）。
 *
 * 所以这里每条都跑行为，不查字符串有没有出现。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { readSrc } from './srcScan';
import { redactEnv, redactParams, redactCanvasConfig } from '../engine/canvasStore';
import { blankSecretNamed } from '../engine/sanitize';

/** 取一个具名函数的函数体（花括号配平） */
function fnBody(name: string): string {
  /*
   * 用 readSrc —— 它会剥掉注释。
   * 注释里提到判据的名字会让"不许出现判据"这类守卫假通过，
   * 这个坑在别处已经踩过好几次。
   */
  const s = readSrc(path.join('engine', 'canvasStore.ts'));
  assert.ok(s.length > 0, '读不到 canvasStore.ts —— AF_SRC 指对了吗');
  const at = s.indexOf('function ' + name);
  assert.notEqual(at, -1, `源码里找不到 function ${name}`);
  const open = s.indexOf('{', at);
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '{') d += 1;
    else if (s[i] === '}') {
      d -= 1;
      if (d === 0) return s.slice(open, i + 1);
    }
  }
  return '';
}

/* ================================================================== */
/* 参数卡：数字 / 布尔装不下密钥                                        */
/* ================================================================== */

test('参数卡: 声明为数字的不挖 —— 名字带 token 也不挖', () => {
  const r = redactParams([
    { id: 'p1', name: 'maxTokens', valueType: 'num', value: '4096' },
    { id: 'p2', name: 'token_limit', valueType: 'num', value: '100' },
  ] as never);
  assert.equal(r[0].value, '4096', '数字卡装不下密钥 —— 挖掉它只是每次保存都清空用户填的值');
  assert.equal(r[1].value, '100');
});

test('参数卡: 声明为布尔的不挖', () => {
  const r = redactParams([{ id: 'p', name: 'useToken', valueType: 'bool', value: 'true' }] as never);
  assert.equal(r[0].value, 'true');
});

test('参数卡: 文本卡照样挖', () => {
  const r = redactParams([
    { id: 'p1', name: 'apiKey', valueType: 'text', value: 'sk-live' },
    { id: 'p2', name: 'token', valueType: 'text', value: 'ghp_x' },
  ] as never);
  assert.equal(r[0].value, '', '文本卡里的密钥必须挖空');
  assert.equal(r[1].value, '');
});

test('参数卡: 老数据没标 valueType → 按 text，照样挖', () => {
  const r = redactParams([{ id: 'p', name: 'token', value: 'ghp_x' }] as never);
  assert.equal(r[0].value, '', '没标种类的一律按能装文本算 —— 这是唯一安全的默认');
});

test('参数卡: 与节点侧同口径 —— 数字都不挖、字符串都挖', () => {
  /*
   * 同一个名字在两处的行为必须一致：
   * 节点侧（sanitize.blankSecretNamed）只挖字符串叶子，数字原样留下。
   * 参数卡有自己的 valueType，就用它 —— 但结论必须一样。
   */
  const nodeNum = blankSecretNamed({ maxTokens: 4096 });
  assert.equal(nodeNum.maxTokens, 4096, '节点侧：数字不挖');
  const paramNum = redactParams([{ id: 'p', name: 'maxTokens', valueType: 'num', value: '4096' }] as never);
  assert.equal(paramNum[0].value, '4096', '参数卡侧：数字也不挖');

  const nodeStr = blankSecretNamed({ maxTokens: '4096' });
  assert.equal(nodeStr.maxTokens, '', '节点侧：字符串叶子要挖');
  const paramStr = redactParams([{ id: 'p', name: 'maxTokens', valueType: 'text', value: '4096' }] as never);
  assert.equal(paramStr[0].value, '', '参数卡侧：文本也要挖');
});

test('参数卡: 名字不像密钥的本来就不动（防过度修复）', () => {
  const r = redactParams([
    { id: 'p1', name: '输出目录', valueType: 'text', value: '/tmp' },
    { id: 'p2', name: 'retry_count', valueType: 'num', value: '3' },
  ] as never);
  assert.equal(r[0].value, '/tmp');
  assert.equal(r[1].value, '3');
});

/* ================================================================== */
/* env 判据只有一份                                                     */
/* ================================================================== */

test('env: 画布 env 与 MCP 服务 env 对同一个名字必须同结果', () => {
  /*
   * 两处各写一份循环、逐字相同 —— 今天看不出差别。
   * 这条测试盯的是"将来给一处加判据时另一处不会静默落后"。
   */
  const names = ['GITHUB_TOKEN', 'NOTION_API_KEY', 'MAX_TOKENS', 'my_password', 'plainUrl', 'COOKIE'];
  for (const k of names) {
    const viaVars = redactCanvasConfig({ env: { vars: { [k]: 'v' } } }).env.vars[k];
    const viaServer = redactCanvasConfig({
      mcpServers: [{ id: 's', name: 'fs', command: 'c', env: { [k]: 'v' } }],
    }).mcpServers[0].env?.[k];
    assert.equal(viaVars, viaServer, `${k}: 两处 env 的判据不一致`);
  }
  assert.equal(redactCanvasConfig({ env: { vars: { GITHUB_TOKEN: 'v' } } }).env.vars.GITHUB_TOKEN, '');
});

test('env: 名字不像密钥的变量要保留', () => {
  const r = redactEnv({ PLAIN_PATH: '/tmp', timeout: '30' });
  assert.equal(r.PLAIN_PATH, '/tmp');
  assert.equal(r.timeout, '30');
});

/* ================================================================== */
/* 源码守卫：不许再出现第二份判据                                        */
/* ================================================================== */

test('源码守卫: redactServerEnv 不许自己判名字', () => {
  /*
   * 这里查的是"**不许**出现判据"，而不是"**要**出现某个名字" ——
   * 后者会被 `const out = 判据(...)` 这种转发骗过去（赋值那行也算出现）。
   */
  const body = fnBody('redactServerEnv');
  assert.ok(!body.includes('looksLikeSecretName'), 'redactServerEnv 又自己写了一份判据 —— 会与 redactEnv 分叉');
  assert.ok(body.includes('blankEnvVars'), 'redactServerEnv 要走共用那份');
});

test('源码守卫: 判据本身在 blankEnvVars 里，且真的用了名字判据', () => {
  const body = fnBody('blankEnvVars');
  assert.ok(body.includes('looksLikeSecretName'), 'blankEnvVars 要按名字判');
});

test('源码守卫: redactEnv 也是转发，不许自己循环', () => {
  const body = fnBody('redactEnv');
  assert.ok(!body.includes('Object.entries'), 'redactEnv 又自己循环了一遍');
});
