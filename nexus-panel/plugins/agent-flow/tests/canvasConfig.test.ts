import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyCanvasConfig, validateCanvasConfig, resolveMcpServer,
  mcpChoiceRequired, type McpServer,
} from '../engine/canvasConfig';
import { redactEnv, redactSecrets, canvasConfigOf, updateCanvasConfig } from '../engine/canvasStore';
import { looksLikeSecretName } from '../engine/sanitize';

const s = (id: string, name: string, extra = {}): McpServer => ({
  id, name, command: `cmd-${id}`, ...extra,
});

/* ================= 混合方案的核心三条 ================= */

test('没配服务 + 节点没选 → 不报错，走节点自己的通道', () => {
  const r = resolveMcpServer([]);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.server, null);
});

test('配了唯一一个 → 自动用它（省事，接近全局注入）', () => {
  const r = resolveMcpServer([s('a', 'github')]);
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.server?.name, 'github', '唯一时不用显式选');
});

test('配了多个 + 没选 → 明确报错并列出候选', () => {
  const r = resolveMcpServer([s('a', 'github'), s('b', 'fs')]);
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.includes('2'), '报错里要说明有几个');
  assert.ok(!r.ok && r.candidates.length === 2);
});

test('配了多个 + 选了 → 用选中的那个', () => {
  const r = resolveMcpServer([s('a', 'github'), s('b', 'fs')], 'fs');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.server?.name, 'fs');
});

test('选了不存在的 → 报错，不静默退回第一个', () => {
  const r = resolveMcpServer([s('a', 'github'), s('b', 'fs')], 'notion');
  assert.equal(r.ok, false);
  assert.ok(!r.ok && r.reason.includes('notion'));
});

test('没配服务却选了 → 报错（否则用户以为配了）', () => {
  const r = resolveMcpServer([], 'github');
  assert.equal(r.ok, false);
});

test('mcpChoiceRequired：多个才必选', () => {
  assert.equal(mcpChoiceRequired([]), false);
  assert.equal(mcpChoiceRequired([s('a', 'x')]), false, '唯一时不必选');
  assert.equal(mcpChoiceRequired([s('a', 'x'), s('b', 'y')]), true);
});

/* ================= 校验 ================= */

test('重名必须拦住 —— 节点按名字引用，重名会指错且不报错', () => {
  const cfg = emptyCanvasConfig();
  cfg.mcpServers = [s('a', 'github'), s('b', 'github')];
  const issues = validateCanvasConfig(cfg);
  assert.ok(issues.some((i) => i.message.includes('重名')));
});

test('既没命令也没地址 → 报"起不来"', () => {
  const cfg = emptyCanvasConfig();
  cfg.mcpServers = [{ id: 'a', name: 'x' }];
  const issues = validateCanvasConfig(cfg);
  assert.ok(issues.some((i) => i.message.includes('起不来')));
});

test('命令和地址都填 → 提示会按命令优先', () => {
  const cfg = emptyCanvasConfig();
  cfg.mcpServers = [{ id: 'a', name: 'x', command: 'c', url: 'http://y' }];
  const issues = validateCanvasConfig(cfg);
  assert.ok(issues.some((i) => i.message.includes('命令优先')));
});

test('一次收集全部问题，不是遇到第一个就停', () => {
  const cfg = emptyCanvasConfig();
  cfg.mcpServers = [{ id: 'a', name: '' }, { id: 'b', name: '' }];
  const issues = validateCanvasConfig(cfg);
  assert.ok(issues.length >= 2, `只报了 ${issues.length} 条 —— 用户要一次看全`);
});

test('环境变量名非法要报错', () => {
  const cfg = emptyCanvasConfig();
  cfg.env.vars = { '1bad': 'x' };
  assert.ok(validateCanvasConfig(cfg).some((i) => i.field === '1bad'));
});

test('合法配置无问题', () => {
  const cfg = emptyCanvasConfig();
  cfg.mcpServers = [s('a', 'fs')];
  cfg.env.vars = { TOKEN: 'x' };
  assert.equal(validateCanvasConfig(cfg).length, 0);
});

/* ================= 密钥不能明文落进画布 ================= */

test('MCP 环境变量里像密钥的名字要被脱敏', () => {
  const out = redactEnv({ TOKEN: 'abc', GH_SECRET: 'x', plainUrl: 'http://a' });
  assert.equal(out.TOKEN, '', 'TOKEN 没被剥掉 —— 会明文进导出的画布');
  assert.equal(out.GH_SECRET, '');
  assert.equal(out.plainUrl, 'http://a', '不是密钥的不该动');
});

test('脱敏整个存档时也要覆盖画布配置', () => {
  const state = {
    canvases: [{
      id: 'c1', name: 'n', nodes: [], edges: [], createdAt: 1, updatedAt: 1,
      config: { mcpServers: [], env: { vars: { API_KEY: 'secret', URL: 'http://a' } } },
    }],
    activeId: 'c1',
  };
  const out = redactSecrets(state as never);
  const vars = out.canvases[0].config?.env?.vars ?? {};
  assert.equal(vars.API_KEY, '');
  assert.equal(vars.URL, 'http://a');
});

test('未存过配置时 canvasConfigOf 与 emptyCanvasConfig 同构', () => {
  const got = canvasConfigOf({ id: 'x', name: 'y', nodes: [], edges: [], createdAt: 1, updatedAt: 1 });
  assert.deepEqual(got, emptyCanvasConfig(),
    '两份空配置不同构 —— 调用方按其中一份判断会出差');
});

test('updateCanvasConfig 幂等：没变就返回原数组', () => {
  const list = [{ id: 'c1', name: 'n', nodes: [], edges: [], createdAt: 1, updatedAt: 1 }];
  const cfg = { mcpServers: [], env: { vars: {} } };
  // 第一次写入会变
  const after1 = updateCanvasConfig(list, 'c1', cfg);
  assert.notEqual(after1, list, '首次写入应该产生新数组');
  // 再写同样的内容不该变 —— 否则会触发保存循环
  const after2 = updateCanvasConfig(after1, 'c1', cfg);
  assert.equal(after2, after1, '写入相同内容却产生了新数组 —— 会触发无限保存');
});

test('updateCanvasConfig 只改目标画布', () => {
  const list = [
    { id: 'c1', name: 'a', nodes: [], edges: [], createdAt: 1, updatedAt: 1 },
    { id: 'c2', name: 'b', nodes: [], edges: [], createdAt: 1, updatedAt: 1 },
  ];
  const out = updateCanvasConfig(list, 'c1', { mcpServers: [{ id: 'm', name: 'x', command: 'c' }], env: { vars: {} } });
  assert.ok(out[0].config, 'c1 没被改');
  assert.equal(out[1].config, undefined, 'c2 不该被牵连');
});

/**
 * canvasStore 里内联了一份 looksLikeSecretName（因为静态 import 会让
 * 生成的 .mjs 加载不了）。两份必须同义 —— 否则"导出时脱敏"与
 * "别处判断是否为密钥"会给出不同的答案。
 */
test('两处 looksLikeSecretName 判断一致（内联副本没漂移）', () => {
  const store = redactEnv;
  const samples: [string, boolean][] = [
    ['TOKEN', true], ['GH_SECRET', true], ['my_password', true],
    ['API_KEY', true], ['plainUrl', false], ['URL', false], ['name', false],
  ];
  for (const [k, want] of samples) {
    // 通过 redactEnv 的行为间接验证 canvasStore 里那份
    const got = store({ [k]: 'x' })[k] === '';
    assert.equal(got, want, `${k}: canvasStore 判为 ${got}，期望 ${want}`);
    assert.equal(looksLikeSecretName(k), want, `${k}: sanitize 那份判错了`);
  }
});
