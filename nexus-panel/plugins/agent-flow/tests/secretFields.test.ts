import test from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_PATHS } from '../engine/sanitize';
import { redactNodes, collectSecrets } from '../engine/canvasStore';

/**
 * 保险箱与脱敏必须共用同一份密钥清单。
 *
 * 以前 engine/canvasStore.ts 自己抄了一份 SECRET_FIELDS：
 *   ['llm.apiKey', 'token']        ← 少了 'config.token'
 * 而 engine/sanitize.ts 的 SECRET_PATHS 是：
 *   ['token', 'llm.apiKey', 'config.token']
 *
 * 于是 webhook 触发器的校验 token（存在 data.config.token）：
 *   · 被 stripSecrets 认出来（面板提示"不会存进默认"）
 *   · 却**不会被挖进保险箱**
 * → 明文留在画布存档与导出文件里。
 *
 * webhook token 泄露意味着别人能伪造请求触发你的工作流，
 * 而工作流能起 CLI、读写授权目录。
 */

const N = (id: string, data: Record<string, unknown>) => ({ id, data: { ...data } });

test('config.token 会被脱敏（webhook 校验密钥）', () => {
  const out = redactNodes([
    N('t1', { kind: 'trigger', config: { token: 'SECRET123', port: 8787 } }),
  ]) as never[];
  const first = (out as unknown as { data: Record<string, unknown> }[])[0];
  const cfg = out[0].data.config as Record<string, unknown>;
  assert.equal(cfg.token, '', 'webhook token 必须被挖空');
  assert.equal(cfg.port, 8787, '非密钥字段不能被动');
});

test('token（GitHub 节点）仍会被脱敏', () => {
  const out = redactNodes([N('g1', { kind: 'githubUpdate', token: 'ghp_x' })]) as never[];
  assert.equal((out as unknown as { data: Record<string, unknown> }[])[0].data.token, '');
});

test('llm.apiKey 仍会被脱敏', () => {
  const out = redactNodes([N('o1', { kind: 'ocr', llm: { apiKey: 'sk-x', model: 'm' } })]) as never[];
  const llm = (out as unknown as { data: Record<string, unknown> }[])[0].data.llm as Record<string, unknown>;
  assert.equal(llm.apiKey, '');
  assert.equal(llm.model, 'm', '同层的非密钥字段要保留');
});

test('三种密钥都会被收进保险箱（不只脱敏）', () => {
  /*
   * 脱敏与"收进保险箱"是两件事：
   * 只脱敏不收集 → 密钥直接没了（用户得重填）；
   * 只收集不脱敏 → 明文留在存档里（就是这次的漏洞）。
   */
  const state = {
    canvases: [
      { id: 'c1', name: 'x', nodes: [
        N('g1', { kind: 'githubUpdate', token: 'TOK_A' }),
        N('o1', { kind: 'ocr', llm: { apiKey: 'TOK_B' } }),
        N('t1', { kind: 'trigger', config: { token: 'TOK_C' } }),
      ] as never, edges: [] },
    ],
  } as never;
  const got = collectSecrets(state);
  const vals = Object.values(got);
  assert.ok(vals.includes('TOK_A'), 'token 要进保险箱');
  assert.ok(vals.includes('TOK_B'), 'llm.apiKey 要进保险箱');
  assert.ok(vals.includes('TOK_C'), 'config.token 要进保险箱（以前漏的就是这条）');
});

test('没有密钥时不产生保险箱条目', () => {
  const state = {
    canvases: [{ id: 'c1', name: 'x', nodes: [N('n1', { kind: 'log', msg: 'hi' })] as never, edges: [] }],
  } as never;
  assert.deepEqual(collectSecrets(state), {});
});

test('非节点形态的数据不会被误改（避免误伤用户文本）', () => {
  /*
   * redactNode 只认 { id, data:{kind} }。
   * 用户让 AI 生成一段含 llm 字样的文本，不该被改写。
   */
  const out = redactNodes([{ id: 'x', data: { kind: 'task', output: 'the llm said token' } }]) as never[];
  assert.equal((out as unknown as { data: Record<string, unknown> }[])[0].data.output, 'the llm said token');
});

/* ---------------- 清单本身 ---------------- */

test('SECRET_PATHS 覆盖三类已知密钥', () => {
  for (const p of ['token', 'llm.apiKey', 'config.token']) {
    assert.ok(
      (SECRET_PATHS as readonly string[]).includes(p),
      `SECRET_PATHS 应包含 ${p}`,
    );
  }
});
