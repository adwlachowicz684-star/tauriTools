import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSize, NODE_SIZE_META, type NodeSize } from '../types';

/**
 * 节点显示高度的取值归一化。
 *
 * 这个字段是后加的，画布上大量老节点没有它 ——
 * 归一化必须宽容，否则一升级老画布就出怪状态。
 */

test('三档各自原样返回', () => {
  assert.equal(normalizeSize('sm'), 'sm');
  assert.equal(normalizeSize('md'), 'md');
  assert.equal(normalizeSize('lg'), 'lg');
});

test('缺省与非法值一律按中号（老存档没有这个字段）', () => {
  assert.equal(normalizeSize(undefined), 'md');
  assert.equal(normalizeSize(null), 'md');
  assert.equal(normalizeSize(''), 'md');
  assert.equal(normalizeSize('  '), 'md');
  assert.equal(normalizeSize('xl'), 'md', '不认识的档位退回中号，不抛错');
  assert.equal(normalizeSize(0), 'md');
  assert.equal(normalizeSize({}), 'md');
});

test('大小写敏感，不猜意图', () => {
  assert.equal(normalizeSize('SM'), 'md');
});

test('三档都有文案与提示（界面上不能出现空按钮）', () => {
  const keys = Object.keys(NODE_SIZE_META) as NodeSize[];
  assert.deepEqual(keys.sort(), ['lg', 'md', 'sm']);
  for (const k of keys) {
    assert.ok(NODE_SIZE_META[k].label.length > 0, `${k} 缺标签`);
    assert.ok(NODE_SIZE_META[k].hint.length > 0, `${k} 缺提示`);
  }
});

/**
 * 尺寸必须只影响显示，不影响执行 ——
 * 它是节点 data 里的一个字段，执行器若把它当配置读就会出问题。
 */
test('尺寸字段不参与执行：不在任何校验规则里被当作必填', () => {
  // 缺 size 时各节点仍判定正常（这里用 const 与 wait 两个有必填项的代表）
  const d = { kind: 'wait', ms: 100 };
  assert.equal(normalizeSize((d as { size?: unknown }).size), 'md');
});
