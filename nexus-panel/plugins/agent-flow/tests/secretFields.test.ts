import test from 'node:test';
import assert from 'node:assert/strict';
import { SECRET_PATHS } from '../engine/sanitize';
import { redactNodes } from '../engine/canvasStore';

/**
 * 脱敏必须覆盖完整的一份密钥清单 —— 这是密钥**唯一**的防线。
 *
 * 以前 engine/canvasStore.ts 自己抄了一份 SECRET_FIELDS：
 *   ['llm.apiKey', 'token']        ← 少了 'config.token'
 * 而 engine/sanitize.ts 的 SECRET_PATHS 是：
 *   ['token', 'llm.apiKey', 'config.token']
 *
 * 于是 webhook 触发器的校验 token（存在 data.config.token）：
 *   · 被 stripSecrets 认出来（面板提示"不会存进默认"）
 *   · 却**不会被挖空**
 * → 明文留在画布存档与导出文件里。
 *
 * 现在内联密钥**不再落盘**（原保险箱已移除），所以脱敏是唯一的防线：
 * 漏掉一个字段，那个密钥就直接以明文进存档、进导出文件。
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

test('三种密钥都会被挖空（脱敏是唯一防线）', () => {
  /*
   * 内联密钥不再落盘，所以"被挖空"就是它不出存档的全部保障：
   * 少挖一个字段，那个密钥就以明文进了画布存档与导出文件。
   */
  const nodes = [
    N('g1', { kind: 'githubUpdate', token: 'TOK_A' }),
    N('o1', { kind: 'ocr', llm: { apiKey: 'TOK_B' } }),
    N('t1', { kind: 'trigger', config: { token: 'TOK_C' } }),
  ];
  const json = JSON.stringify(redactNodes(nodes));
  assert.equal(json.includes('TOK_A'), false, 'token 要被挖空');
  assert.equal(json.includes('TOK_B'), false, 'llm.apiKey 要被挖空');
  assert.equal(json.includes('TOK_C'), false, 'config.token 要被挖空（以前漏的就是这条）');
});

test('没有密钥时脱敏不改动内容', () => {
  const nodes = [N('n1', { kind: 'log', msg: 'hi' })];
  assert.deepEqual(redactNodes(nodes), nodes);
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
