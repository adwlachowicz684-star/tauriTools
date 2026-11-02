/*
 * MCP 服务的地址与启动命令
 *
 * ============ 这个洞长什么样 ============
 *
 * redactCanvasConfig 只脱了服务的 env：
 *
 *   env:    { TOKEN: 'sk-e' }                        → { TOKEN: '' }        ✅
 *   url:    'https://mcp.corp/sse?api_key=sk-live'   → 原样                 ❌
 *   command:'npx -y @mcp/server --api-key=sk-x'      → 原样                 ❌
 *
 * 同一个密钥，放在 env 里会被挖掉，写在地址参数或命令行里就明文进存档、
 * 进导出的画布文件。而"最顺手配自建服务的地方"恰恰就是地址栏 ——
 * 自建 MCP 服务把凭据拼进 URL（?api_key= / user:pw@）是很常见的做法，
 * 命令行传 --api-key 同样常见。
 *
 * 而 redactCanvasConfig 自己的注释写着「各脱各的必然漏一处」——
 * 说的正是这一类，只是当时只列了 env.vars / params / 服务的 env 三处。
 *
 * ============ 为什么不去另写一份判据 ============
 *
 * 地址走 scrubUrlSecrets（与节点侧 data 里的 url 同一份），
 * 命令走 scrubCommandSecrets，flag 名判定复用 looksLikeSecretName ——
 * 与请求头、参数名、env 变量名都是同一把尺子。
 *
 * ============ 边界 ============
 *
 * · 纯模板引用不动：`--token {{login.token}}` 是一句引用，
 *   挖掉会留下空值而界面并不提示，属于静默破坏（与请求头那一侧同一条边界）。
 * · 混合值照挖：`--token sk-{{x}}` 里那个 sk- 是明文。
 * · 服务本来没填 url / command 时，不凭空多出 undefined 键。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { AF_SRC, readSrc } from './srcScan';
import { scrubCommandSecrets, scrubUrlSecrets } from '../engine/sanitize';
import { redactCanvasConfig } from '../engine/canvasStore';

const REL_SAN = path.join('engine', 'sanitize.ts');
const REL_STORE = path.join('engine', 'canvasStore.ts');

function cfgWith(server: Record<string, unknown>) {
  return { mcpServers: [server], env: { vars: {} }, params: '' } as never;
}
function out(server: Record<string, unknown>) {
  return redactCanvasConfig(cfgWith(server)).mcpServers[0];
}

/* ================================================================== */
/* 一、服务地址                                                         */
/* ================================================================== */

test('行为: 服务地址里的 api_key 要挖', () => {
  const r = out({ id: 's', name: '本地', url: 'https://mcp.corp/sse?api_key=sk-live-999' });
  assert.equal(r.url, 'https://mcp.corp/sse?api_key=');
});

test('行为: 服务地址里的 userinfo 要挖', () => {
  const r = out({ id: 's', name: '本地', url: 'https://user:pw@mcp.corp/sse' });
  assert.equal(r.url, 'https://user:@mcp.corp/sse');
});

test('行为: env 里的密钥仍然要挖（老的那一处不能丢）', () => {
  const r = out({ id: 's', name: '本地', url: 'https://mcp.corp/sse', env: { TOKEN: 'sk-e' } });
  assert.deepEqual(r.env, { TOKEN: '' });
});

test('反例: 服务地址里的普通参数不动（防过度修复）', () => {
  const u = 'https://mcp.corp/sse?transport=sse&keyword=abc';
  const r = out({ id: 's', name: '本地', url: u });
  assert.equal(r.url, u);
});

test('反例: 路径里的 token 不动', () => {
  const u = 'https://mcp.corp/v1/token/refresh';
  const r = out({ id: 's', name: '本地', url: u });
  assert.equal(r.url, u);
});

/* ================================================================== */
/* 二、启动命令                                                         */
/* ================================================================== */

test('行为: --api-key=sk-x 要挖', () => {
  assert.equal(
    scrubCommandSecrets('npx -y @mcp/server --api-key=sk-x'),
    'npx -y @mcp/server --api-key=',
  );
});

test('行为: --token sk-x（空格形式）要挖', () => {
  assert.equal(
    scrubCommandSecrets('npx -y @mcp/server --token sk-x'),
    'npx -y @mcp/server --token ',
  );
});

test('行为: 命令里的密钥经 redactCanvasConfig 要挖', () => {
  const r = out({ id: 's', name: '本地', command: 'npx -y @mcp/server --token sk-cli-123' });
  assert.equal(r.command, 'npx -y @mcp/server --token ');
});

test('反例: --token 后面是另一个 flag 时不动（防越界吃掉下一个参数）', () => {
  const c = 'npx -y @mcp/server --token --verbose';
  assert.equal(scrubCommandSecrets(c), c);
});

test('反例: 纯模板引用不动 —— 那是引用不是密钥', () => {
  /*
   * 与请求头那一侧同一条边界：挖掉会留下 `--token ` 空值，
   * 而界面并不提示，用户以为这就是预期 —— 静默破坏。
   */
  const c = 'npx -y @mcp/server --token {{login.token}}';
  assert.equal(scrubCommandSecrets(c), c);
});

test('反例: 混合值照挖（sk- 是实打实的明文）', () => {
  assert.equal(
    scrubCommandSecrets('npx -y @mcp/server --token sk-{{x}}'),
    'npx -y @mcp/server --token ',
  );
});

test('反例: 普通 flag 不动', () => {
  const c = 'npx -y @mcp/server-filesystem /tmp --port 8080';
  assert.equal(scrubCommandSecrets(c), c);
});

/* ================================================================== */
/* 三、形状                                                             */
/* ================================================================== */

test('反例: 没填 url / command 时不凭空多出键', () => {
  const r = out({ id: 's', name: '本地' });
  assert.equal('url' in r, false, '不该凭空出现 url');
  assert.equal('command' in r, false, '不该凭空出现 command');
});

test('反例: 地址干净时不改动其它字段', () => {
  const r = out({ id: 's', name: '本地', url: 'https://mcp.corp/sse', note: '备注' });
  assert.equal(r.url, 'https://mcp.corp/sse');
  assert.equal(r.note, '备注');
  assert.equal(r.name, '本地');
});

/* ================================================================== */
/* 四、源码守卫                                                         */
/* ================================================================== */

test('守卫: 画布配置脱敏覆盖了服务地址与命令（不许只脱 env）', () => {
  const s = readSrc(REL_STORE);
  assert.ok(s.includes('scrubUrlSecrets('), 'canvasStore 没用 scrubUrlSecrets');
  assert.ok(s.includes('scrubCommandSecrets('), 'canvasStore 没用 scrubCommandSecrets');
});

test('守卫: 命令判据复用 looksLikeSecretName，不另写一份 hint', () => {
  const s = readSrc(REL_SAN);
  assert.ok(
    s.includes('looksLikeSecretName(flag)'),
    '命令的 flag 判定没复用 looksLikeSecretName —— 各写一份必然漂移',
  );
});

test('守卫自身: 源码真的读到了', () => {
  assert.ok(AF_SRC.length > 0, 'AF_SRC 是空的 —— 守卫会假通过');
  assert.ok(readSrc(REL_SAN).length > 5000, 'sanitize.ts 太短 —— 指错地方了');
  assert.ok(readSrc(REL_STORE).length > 5000, 'canvasStore.ts 太短 —— 指错地方了');
});
