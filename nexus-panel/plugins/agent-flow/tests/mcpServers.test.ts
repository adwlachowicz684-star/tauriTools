import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadServers, saveServers, validateServers, migrateFromCanvases,
  resolveServer, choiceRequired, transportOf, isRunnable, secretEnvNames,
  newServer, toServerRefs, MCP_SERVERS_KEY, type GlobalMcpServer,
} from '../engine/mcpServers';

function memKV() {
  const map = new Map<string, string>();
  return {
    map,
    get: (k: string) => map.get(k) ?? null,
    set: (k: string, v: string) => void map.set(k, v),
    remove: (k: string) => void map.delete(k),
  };
}

function s(name: string, extra: Partial<GlobalMcpServer> = {}): GlobalMcpServer {
  return { id: `id-${name}`, name, ...extra };
}

/* ---------------- 存取 ---------------- */

test('存了能读回来', () => {
  const kv = memKV();
  saveServers([s('xmind', { command: 'npx xmind' })], kv);
  const list = loadServers(kv);
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'xmind');
});

test('空库读出来是空数组，不是 undefined', () => {
  const kv = memKV();
  assert.deepEqual(loadServers(kv), []);
});

/* ---------------- 校验 ---------------- */

test('重名必须拦住（节点按名字引用，重名会指错）', () => {
  const issues = validateServers([s('a', { command: 'x' }), s('a', { url: 'http://x' })]);
  assert.ok(issues.some((i) => i.message.includes('重名')));
});

test('名字前后空格视为同名', () => {
  const issues = validateServers([s('a', { command: 'x' }), s(' a ', { url: 'http://x' })]);
  assert.ok(issues.some((i) => i.message.includes('重名')));
});

test('命令和地址都空 → 起不来', () => {
  const issues = validateServers([s('a')]);
  assert.ok(issues.some((i) => i.message.includes('起不来')));
});

test('两个都填要提示按命令优先', () => {
  const issues = validateServers([s('a', { command: 'x', url: 'http://y' })]);
  assert.ok(issues.some((i) => i.message.includes('命令优先')));
});

test('填得对就没问题', () => {
  assert.deepEqual(validateServers([s('a', { command: 'x' }), s('b', { url: 'http://y' })]), []);
});

/* ---------------- 传输方式（本地 / 云端） ---------------- */

test('只有命令 = 本地，只有地址 = 云端', () => {
  assert.equal(transportOf(s('a', { command: 'npx x' })), 'local');
  assert.equal(transportOf(s('b', { url: 'http://x' })), 'remote');
});

test('两个都填算本地（命令优先）', () => {
  assert.equal(transportOf(s('a', { command: 'npx x', url: 'http://y' })), 'local');
});

test('两个都空也算本地 —— 列表里总得有地方放它', () => {
  assert.equal(transportOf(s('a')), 'local');
});

test('isRunnable：两个都空不算', () => {
  assert.equal(isRunnable(s('a')), false);
  assert.equal(isRunnable(s('a', { command: 'x' })), true);
  assert.equal(isRunnable(s('a', { url: 'http://x' })), true);
});

/* ---------------- 解析 ---------------- */

test('只配一个时可以不选', () => {
  const r = resolveServer([s('a', { command: 'x' })], '');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.server?.name, 'a');
});

test('配了多个必须显式选', () => {
  const r = resolveServer([s('a', { command: 'x' }), s('b', { command: 'y' })], '');
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.includes('必须指定'));
});

test('选了不存在的名字要报错并列出候选', () => {
  const r = resolveServer([s('a', { command: 'x' })], 'zzz');
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.names.includes('a'));
});

test('停用的服务不参与解析', () => {
  const r = resolveServer([s('a', { command: 'x', disabled: true }), s('b', { command: 'y' })], '');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.server?.name, 'b');
});

test('停用的服务被选中时算没有', () => {
  const r = resolveServer([s('a', { command: 'x', disabled: true })], 'a');
  assert.equal(r.ok, false);
});

test('没配任何服务：没选不算错（节点走自己的通道）', () => {
  const r = resolveServer([], '');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.server, null);
});

test('没配服务却选了名字 → 报错', () => {
  const r = resolveServer([], 'a');
  assert.equal(r.ok, false);
});

test('choiceRequired：两个启用才算', () => {
  assert.equal(choiceRequired([s('a', { command: 'x' })]), false);
  assert.equal(choiceRequired([s('a', { command: 'x' }), s('b', { command: 'y' })]), true);
  assert.equal(
    choiceRequired([s('a', { command: 'x' }), s('b', { command: 'y', disabled: true })]),
    false,
  );
});

/* ---------------- 密钥环境变量 ---------------- */

test('像密钥的环境变量名要认出来', () => {
  const names = secretEnvNames(s('a', {
    command: 'x',
    env: { API_TOKEN: 't', GITHUB_SECRET: 's', PORT: '3000' },
  }));
  assert.ok(names.includes('API_TOKEN'));
  assert.ok(names.includes('GITHUB_SECRET'));
  assert.equal(names.includes('PORT'), false);
});

/* ---------------- 迁移 ---------------- */

test('老画布上配的服务会并进来', () => {
  const kv = memKV();
  const r = migrateFromCanvases([
    { config: { mcpServers: [{ id: 'x1', name: 'xmind', command: 'npx xmind' }] } },
  ], kv);
  assert.equal(r.added, 1);
  assert.equal(loadServers(kv)[0].name, 'xmind');
});

test('同名不重复并（多张画布配同一个服务）', () => {
  const kv = memKV();
  const r = migrateFromCanvases([
    { config: { mcpServers: [{ name: 'xmind', command: 'a' }] } },
    { config: { mcpServers: [{ name: 'xmind', command: 'b' }] } },
  ], kv);
  assert.equal(r.added, 1);
  assert.equal(loadServers(kv).length, 1);
});

test('迁移不覆盖已有同名服务（用户在全局库改过的不被冲掉）', () => {
  const kv = memKV();
  saveServers([s('xmind', { command: '新配的' })], kv);
  migrateFromCanvases([{ config: { mcpServers: [{ name: 'xmind', command: '老的' }] } }], kv);
  assert.equal(loadServers(kv)[0].command, '新配的');
});

test('迁移是幂等的 —— 再调一次不加东西', () => {
  const kv = memKV();
  const canvases = [{ config: { mcpServers: [{ name: 'xmind', command: 'a' }] } }];
  assert.equal(migrateFromCanvases(canvases, kv).added, 1);
  assert.equal(migrateFromCanvases(canvases, kv).added, 0);
  assert.equal(loadServers(kv).length, 1);
});

test('没名字的服务不迁入', () => {
  const kv = memKV();
  const r = migrateFromCanvases([{ config: { mcpServers: [{ command: 'a' }] } }], kv);
  assert.equal(r.added, 0);
});

test('迁移后服务带上了 id（老的可能没有）', () => {
  const kv = memKV();
  migrateFromCanvases([{ config: { mcpServers: [{ name: 'xmind', command: 'a' }] } }], kv);
  assert.ok(loadServers(kv)[0].id);
});

test('newServer 给的名字可用于引用', () => {
  const n = newServer('abc');
  assert.equal(n.name, 'abc');
  assert.ok(n.id);
});

test('存储键带 agent-flow 前缀', () => {
  assert.ok(MCP_SERVERS_KEY.indexOf('agent-flow') === 0);
});


/* ---------------- 对接刷新管线 ---------------- */

test('toServerRefs：停用的不转', () => {
  const refs = toServerRefs([
    s('a', { command: 'x' }),
    s('b', { command: 'y', disabled: true }),
  ]);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, 'a');
});

test('toServerRefs：没名字的不转（节点按名字引用）', () => {
  assert.deepEqual(toServerRefs([{ id: 'x', command: 'y' }]), []);
});

test('toServerRefs：重名只留一个', () => {
  const refs = toServerRefs([s('a', { command: 'x' }), s('a', { command: 'y' })]);
  assert.equal(refs.length, 1);
});

test('toServerRefs 带上命令与地址', () => {
  const refs = toServerRefs([s('a', { command: 'cmd' }), s('b', { url: 'http://x' })]);
  assert.equal(refs[0].command, 'cmd');
  assert.equal(refs[1].url, 'http://x');
});
