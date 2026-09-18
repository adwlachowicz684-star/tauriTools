import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_KEYS, RUNTIME_PREFIX, isRuntimeKey, stripRuntime, stripRuntimeNodes,
} from '../engine/runtimeKeys';

/**
 * 这份清单必须是**全项目唯一一份**。
 *
 * 以前 duplicate.ts 与 modules.ts 各写了一遍 ——
 * 新增运行时字段时漏改一处就会出现"复制清掉了、存模块没清掉"，
 * 而这种不一致**不报错**，只表现为"拖出来的实例看起来已经跑完了"。
 */

test('清单不为空', () => {
  assert.ok(RUNTIME_KEYS.length > 0);
});

test('三个核心运行时字段都在', () => {
  assert.ok((RUNTIME_KEYS as readonly string[]).includes('status'));
  assert.ok((RUNTIME_KEYS as readonly string[]).includes('output'));
  assert.ok((RUNTIME_KEYS as readonly string[]).includes('error'));
});

test('last* 前缀一律算运行时', () => {
  assert.equal(isRuntimeKey('lastSha'), true);
  assert.equal(isRuntimeKey('lastFiredAt'), true);
  assert.equal(isRuntimeKey('lastChars'), true);
});

/** 配置字段不能被误伤 —— 误伤会让节点参数凭空消失 */
test('配置字段不算运行时', () => {
  assert.equal(isRuntimeKey('config'), false);
  assert.equal(isRuntimeKey('llm'), false);
  assert.equal(isRuntimeKey('label'), false);
  assert.equal(isRuntimeKey('kind'), false);
});

test('stripRuntime 清掉运行时、保留配置', () => {
  const out = stripRuntime({
    kind: 'task', label: 'x', status: 'success', output: '旧输出',
    error: '', lastSha: 'abc', config: { a: 1 },
  });
  assert.equal(out.status, undefined);
  assert.equal(out.output, undefined);
  assert.equal(out.lastSha, undefined);
  assert.equal(out.kind, 'task');
  assert.deepEqual(out.config, { a: 1 });
});

test('stripRuntime 不补默认值（默认值只有节点定义一处）', () => {
  const out = stripRuntime({ kind: 'task' });
  assert.equal(out.status, undefined, '不该凭空补 status');
});

test('stripRuntimeNodes 与 stripRuntime 同一套口径', () => {
  const nodes = [
    { id: 'a', data: { kind: 'task', status: 'success', lastSha: 'x', label: 'L' } },
  ];
  const out = stripRuntimeNodes(nodes);
  const d = out[0].data as Record<string, unknown>;
  assert.equal(d.status, undefined);
  assert.equal(d.lastSha, undefined);
  assert.equal(d.label, 'L', '配置字段必须保留');
});

test('stripRuntimeNodes 保留节点自身字段', () => {
  const out = stripRuntimeNodes([{ id: 'a', position: { x: 1 }, data: {} }]);
  assert.equal(out[0].id, 'a');
  assert.deepEqual((out[0] as { position: unknown }).position, { x: 1 });
});

test('空输入不炸', () => {
  assert.deepEqual(stripRuntime(null), {});
  assert.deepEqual(stripRuntime(undefined), {});
  assert.deepEqual(stripRuntimeNodes([]), []);
});

test('last 前缀常量稳定', () => {
  assert.equal(RUNTIME_PREFIX, 'last');
});
